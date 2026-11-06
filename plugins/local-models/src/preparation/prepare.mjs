import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import { Parser } from 'tar'
import unbzip2 from 'unbzip2-stream'
import xz from 'xz-decompress'
import { resourceFile } from '../../native/resources.mjs'
import { extractZip, safePath } from './zip.mjs'

const fail = code => { throw new Error(`EXTENSION_INFERENCE_${code}`) }

export async function extractArchive(path, archive, files, call) {
  call.signal.throwIfAborted()
  const wanted = new Map(), outputPaths = new Set()
  for (const file of files.filter(file => file.archive === archive.id)) {
    if (!safePath(file.path) || !safePath(file.archivePath) || outputPaths.has(file.path.toLowerCase())) fail('ARCHIVE_INVALID')
    outputPaths.add(file.path.toLowerCase())
    const group = wanted.get(file.archivePath) ?? []
    if (group.some(item => item.sha256 !== file.sha256)) fail('ARCHIVE_INVALID')
    group.push(file)
    wanted.set(file.archivePath, group)
  }
  if (archive.modelDirectory && !safePath(archive.modelDirectory)) fail('ARCHIVE_INVALID')
  const handle = await open(path, 'r')
  const header = Buffer.alloc(6)
  try { await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
  if (header.subarray(0, 2).toString('ascii') === 'PK') return extractZip(path, archive, wanted, call)
  const input = createReadStream(path, { highWaterMark: 256 * 1024 })
  const bzip = header.subarray(0, 3).toString('ascii') === 'BZh' ? unbzip2() : undefined
  const decoder = header.equals(Buffer.from('fd377a585a00', 'hex'))
    ? Readable.fromWeb(new xz.XzReadableStream(Readable.toWeb(input)))
    : bzip ? input.pipe(bzip).pipe(new PassThrough()) : input
  const abort = new AbortController()
  const signal = AbortSignal.any([call.signal, abort.signal])
  let count = 0, expanded = 0, decoded = 0
  let writing = Promise.resolve()
  const seen = new Set()
  const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 })
  parser.on('error', error => abort.abort(error))
  decoder.on('error', error => abort.abort(error))
  const stop = () => { input.destroy(signal.reason); bzip?.destroy(); decoder.destroy(signal.reason); parser.abort(signal.reason) }
  signal.addEventListener('abort', stop, { once: true })
  input.on('error', error => abort.abort(error))
  bzip?.on('error', error => abort.abort(error))
  parser.on('entry', entry => {
    entry.on('error', error => abort.abort(error))
    const work = async () => {
      signal.throwIfAborted()
      if (++count > 16384 || !Number.isSafeInteger(entry.size) || entry.size < 0 || (expanded += entry.size) > archive.unpackedBytes) fail('ARCHIVE_INVALID')
      const path = entry.path.replace(/^(?:\.\/)+/, '')
      const relative = archive.modelDirectory && path.startsWith(`${archive.modelDirectory}/`) ? path.slice(archive.modelDirectory.length + 1) : null
      if (relative && entry.type === 'Directory') { entry.resume(); return }
      const targets = relative ? [{ path: relative }] : wanted.get(path)
      if (!targets) { entry.resume(); return }
      if (entry.type !== 'File' || !safePath(path) || targets.some(file => !safePath(file.path)) || seen.has(path.toLowerCase()) || seen.size >= 4096) fail('ARCHIVE_INVALID')
      seen.add(path.toLowerCase())
      const first = targets[0]
      await call.emitAsync({ type: 'file', path: first.path, size: entry.size, ...(first.executable ? { executable: true } : {}) })
      const hash = createHash('sha256')
      let bytes = 0
      for await (const chunk of entry) {
        signal.throwIfAborted()
        if ((bytes += chunk.length) > entry.size) fail('ARCHIVE_INVALID')
        hash.update(chunk)
        for (let offset = 0; offset < chunk.length; offset += 256 * 1024)
          await call.emitAsync({ type: 'chunk' }, chunk.subarray(offset, offset + 256 * 1024))
      }
      const sha256 = hash.digest('hex')
      if (bytes !== entry.size || (first.sha256 && sha256 !== first.sha256)) fail('CHECKSUM_MISMATCH')
      await call.emitAsync({ type: 'end', sha256 })
      for (const alias of targets.slice(1)) {
        if (Boolean(alias.executable) !== Boolean(first.executable)) fail('ARCHIVE_INVALID')
        await call.emitAsync({ type: 'alias', path: alias.path, target: first.path })
      }
    }
    writing = writing.then(work).catch(error => { abort.abort(error) })
  })
  const finished = once(parser, 'end', { signal })
  const feeding = (async () => {
    signal.throwIfAborted()
    for await (const chunk of decoder) {
      signal.throwIfAborted()
      if ((decoded += chunk.length) > archive.unpackedBytes + 16 * 1024 * 1024) fail('ARCHIVE_INVALID')
      if (!parser.write(chunk)) await once(parser, 'drain', { signal })
    }
    parser.end()
  })()
  try {
    await Promise.all([feeding, finished])
    await writing
    signal.throwIfAborted()
    if (archive.modelDirectory ? !seen.size : [...wanted.keys()].some(path => !seen.has(path.toLowerCase()))) fail('ARCHIVE_INCOMPLETE')
  }
  catch (error) {
    abort.abort(error)
    call.signal.throwIfAborted()
    const cause = abort.signal.reason
    throw cause instanceof Error && /^EXTENSION_INFERENCE_/.test(cause.message) ? cause : new Error('EXTENSION_INFERENCE_ARCHIVE_INVALID', { cause })
  }
  finally {
    input.destroy()
    bzip?.destroy()
    decoder.destroy()
    await Promise.allSettled([feeding, writing])
    signal.removeEventListener('abort', stop)
  }
}

export function initialize(input) {
  return {
    start(capability, _input, call) {
      if (capability !== 'resources.prepare') fail('PREPARATION_INVALID')
      const chunks = []
      let size = 0
      return {
        write(bytes) {
          if ((size += bytes.length) > 1024 * 1024) fail('RESOURCE_LIMIT')
          chunks.push(bytes)
        },
        async finish() {
          const options = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!Array.isArray(options.archives) || !options.archives.length || !Array.isArray(options.files)) fail('PREPARATION_INVALID')
          for (const archive of options.archives) {
            call.signal.throwIfAborted()
            if (!/^[a-z][a-z0-9.-]*$/.test(archive.id) || !Number.isSafeInteger(archive.unpackedBytes) || archive.unpackedBytes <= 0) fail('ARCHIVE_INVALID')
            await extractArchive(resourceFile(input, 'inputs', archive.id), archive, options.files, call)
          }
        },
      }
    },
  }
}
