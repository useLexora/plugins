import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { openPromise } from 'yauzl'

export const safePath = value => typeof value === 'string' && value.length <= 1024 && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[<>:"\\|?*]/.test(part) && !/[. ]$/.test(part) && !/[\x00-\x1f\x7f]/.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
const fail = code => { throw Error(`EXTENSION_INFERENCE_${code}`) }

export async function extractZip(path, archive, wanted, call) {
  call.signal.throwIfAborted()
  const zip = await openPromise(path, { autoClose: false, strictFileNames: true, validateEntrySizes: true }).catch(error => {
    call.signal.throwIfAborted()
    throw new Error('EXTENSION_INFERENCE_ARCHIVE_INVALID', { cause: error })
  })
  let stream, expanded = 0, count = 0, written = 0
  const seen = new Set(), found = new Set(), targetsSeen = new Set()
  const cancel = () => { stream?.destroy(call.signal.reason); zip.close() }
  call.signal.addEventListener('abort', cancel, { once: true })
  try {
    call.signal.throwIfAborted()
    if (zip.entryCount > 16384) fail('ARCHIVE_INVALID')
    for await (const entry of zip.eachEntry()) {
      call.signal.throwIfAborted()
      const directory = entry.fileName.endsWith('/')
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName
      const type = (entry.externalFileAttributes >>> 16) & 0xf000
      if (++count > 16384 || !safePath(name) || seen.has(name.toLowerCase()) || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod) || (type && type !== (directory ? 0x4000 : 0x8000))) fail('ARCHIVE_INVALID')
      seen.add(name.toLowerCase())
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || (expanded += entry.uncompressedSize) > archive.unpackedBytes) fail('ARCHIVE_INVALID')
      if (directory) { if (entry.uncompressedSize) fail('ARCHIVE_INVALID'); continue }
      const relative = archive.modelDirectory && name.startsWith(`${archive.modelDirectory}/`) ? name.slice(archive.modelDirectory.length + 1) : null
      const targets = relative ? [{ path: relative }] : wanted.get(name)
      if (!targets) continue
      if ((written += targets.length) > 4096) fail('ARCHIVE_INVALID')
      for (const target of targets) {
        if (!safePath(target.path) || targetsSeen.has(target.path.toLowerCase())) fail('ARCHIVE_INVALID')
        targetsSeen.add(target.path.toLowerCase())
      }
      found.add(name)
      const first = targets[0]
      stream = await zip.openReadStreamPromise(entry)
      call.signal.throwIfAborted()
      await call.emitAsync({ type: 'file', path: first.path, size: entry.uncompressedSize, ...(first.executable ? { executable: true } : {}) })
      const hash = createHash('sha256')
      let bytes = 0, crc = 0
      for await (const chunk of stream) {
        call.signal.throwIfAborted()
        if ((bytes += chunk.length) > entry.uncompressedSize) fail('ARCHIVE_INVALID')
        hash.update(chunk)
        crc = crc32(chunk, crc)
        for (let offset = 0; offset < chunk.length; offset += 256 * 1024) {
          call.signal.throwIfAborted()
          await call.emitAsync({ type: 'chunk' }, chunk.subarray(offset, offset + 256 * 1024))
        }
      }
      const sha256 = hash.digest('hex')
      if (bytes !== entry.uncompressedSize || crc !== entry.crc32 || first.sha256 && sha256 !== first.sha256) fail('CHECKSUM_MISMATCH')
      await call.emitAsync({ type: 'end', sha256 })
      for (const alias of targets.slice(1)) {
        if (Boolean(alias.executable) !== Boolean(first.executable)) fail('ARCHIVE_INVALID')
        await call.emitAsync({ type: 'alias', path: alias.path, target: first.path })
      }
    }
    call.signal.throwIfAborted()
    if (archive.modelDirectory ? !found.size : [...wanted.keys()].some(name => !found.has(name))) fail('ARCHIVE_INCOMPLETE')
  } catch (error) {
    call.signal.throwIfAborted()
    throw /^EXTENSION_INFERENCE_/.test(error.message) ? error : new Error('EXTENSION_INFERENCE_ARCHIVE_INVALID', { cause: error })
  } finally {
    call.signal.removeEventListener('abort', cancel)
    stream?.destroy()
    zip.close()
  }
}
