import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { create } from 'tar'
import { extractArchive } from '../prepare.mjs'

const digest = data => createHash('sha256').update(data).digest('hex')
const compressed = JSON.parse(await readFile(new URL('./archives.json', import.meta.url), 'utf8'))
async function fixture(t, format) {
  const root = await mkdtemp(join(tmpdir(), 'local-models-prepare-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bundle/data'), { recursive: true })
  await writeFile(join(root, 'bundle/model.onnx'), 'fixture-model')
  await writeFile(join(root, 'bundle/data/tokens.txt'), 'tokens')
  const path = join(root, 'archive')
  if (compressed[format]) await writeFile(path, Buffer.from(compressed[format], 'base64'))
  else await create({ cwd: root, file: path, gzip: format === 'gzip' }, ['bundle'])
  return { root, path, archive: { id: 'bundle', unpackedBytes: 1024, modelDirectory: 'bundle' } }
}
function receiver(signal = new AbortController().signal) {
  const events = [], files = new Map()
  let active
  return {
    events, files, signal,
    async emitAsync(event, bytes) {
      signal.throwIfAborted()
      events.push(event)
      if (event.type === 'file') { active = event.path; files.set(active, Buffer.alloc(0)) }
      if (event.type === 'chunk') files.set(active, Buffer.concat([files.get(active), bytes]))
      if (event.type === 'end') assert.equal(digest(files.get(active)), event.sha256)
      if (event.type === 'alias') files.set(event.path, files.get(event.target))
      await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}
for (const format of ['tar', 'bzip2', 'xz']) {
  test(`streams ${format} archives to a slow consumer`, async t => {
    const { path, archive } = await fixture(t, format)
    const call = receiver()
    await extractArchive(path, archive, [], call)
    assert.deepEqual([...call.files].sort().map(([path, bytes]) => [path, bytes.toString()]), [['data/tokens.txt', 'tokens'], ['model.onnx', 'fixture-model']])
  })
}
test('maps selected tar files and aliases from one verified regular entry', async t => {
  const { path, archive } = await fixture(t, 'gzip')
  delete archive.modelDirectory
  const call = receiver()
  await extractArchive(path, archive, ['engine', 'engine-alias'].map(path => ({ archive: 'bundle', archivePath: 'bundle/model.onnx', path, sha256: digest('fixture-model'), executable: true })), call)
  assert.equal(call.files.get('engine').toString(), 'fixture-model')
  assert.equal(call.files.get('engine-alias').toString(), 'fixture-model')
})
for (const failure of ['link', 'limit', 'hash', 'missing', 'cancel']) {
  test(`rejects ${failure} preparation`, async t => {
    const { path, root, archive } = await fixture(t, 'gzip')
    let files = []
    if (failure === 'link') {
      await symlink('model.onnx', join(root, 'bundle/link'))
      await create({ cwd: root, file: path, gzip: true }, ['bundle'])
    }
    if (failure === 'limit') archive.unpackedBytes = 1
    if (failure === 'hash' || failure === 'missing') {
      delete archive.modelDirectory
      files = [{ archive: 'bundle', archivePath: failure === 'missing' ? 'missing' : 'bundle/model.onnx', path: 'model', sha256: '0'.repeat(64) }]
    }
    const call = receiver(failure === 'cancel' ? AbortSignal.abort() : undefined)
    await assert.rejects(extractArchive(path, archive, files, call), failure === 'hash' ? /CHECKSUM_MISMATCH/ : undefined)
  })
}
for (const format of ['bzip2', 'xz']) {
  test(`rejects truncated ${format} streams after valid output`, async t => {
    const { path, archive } = await fixture(t, format)
    const bytes = await readFile(path)
    await writeFile(path, bytes.subarray(0, bytes.length - 8))
    await assert.rejects(extractArchive(path, archive, [], receiver()))
  })
}
test('rejects duplicate entries with relative dot prefixes', async t => {
  const { root, path, archive } = await fixture(t, 'gzip')
  await create({ cwd: root, file: path, gzip: true }, ['bundle/model.onnx', './bundle/model.onnx'])
  await assert.rejects(extractArchive(path, archive, [], receiver()))
})
test('streams a large file in bounded chunks', async t => {
  const { root, path, archive } = await fixture(t, 'gzip')
  const bytes = randomBytes(8 * 1024 * 1024)
  await writeFile(join(root, 'bundle/model.onnx'), bytes)
  await create({ cwd: root, file: path, gzip: true }, ['bundle/model.onnx'])
  archive.unpackedBytes = bytes.length
  let size = 0
  const checksum = createHash('sha256')
  await extractArchive(path, archive, [], {
    signal: new AbortController().signal,
    async emitAsync(event, chunk) {
      if (event.type === 'chunk') {
        assert.ok(chunk.length <= 256 * 1024)
        size += chunk.length
        checksum.update(chunk)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    },
  })
  assert.equal(size, bytes.length)
  assert.equal(checksum.digest('hex'), digest(bytes))
})
