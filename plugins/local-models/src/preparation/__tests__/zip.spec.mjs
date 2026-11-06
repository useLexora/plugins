import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { extractArchive, initialize } from '../prepare.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const data = Buffer.from('fixture-engine')
const file = (path = 'engine.dll', archivePath = 'bundle/engine.dll') => ({ path, archivePath, archive: 'engine', sha256: hash(data) })
async function fixture(t, entries = Object.fromEntries([['bundle/engine.dll', new Uint8Array(data)]]), mutate = bytes => bytes) {
  const root = await mkdtemp(join(tmpdir(), 'windows-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'archive.zip')
  await writeFile(path, mutate(Buffer.from(zipSync(entries))))
  return { path, archive: { id: 'engine', unpackedBytes: 16 * 1024 * 1024 } }
}
function receiver(controller = new AbortController(), onEvent = _event => {}) {
  const files = new Map(), events = []
  let current
  return {
    files, events, signal: controller.signal,
    async emitAsync(event, bytes) {
      controller.signal.throwIfAborted()
      events.push(event)
      if (event.type === 'file') { current = event.path; files.set(current, Buffer.alloc(0)) }
      if (event.type === 'chunk') { assert.ok(bytes.length <= 256 * 1024); files.set(current, Buffer.concat([files.get(current), bytes])) }
      if (event.type === 'end') assert.equal(hash(files.get(current)), event.sha256)
      if (event.type === 'alias') files.set(event.path, files.get(event.target))
      await onEvent(event)
    },
  }
}
const central = bytes => bytes.indexOf(Buffer.from('504b0102', 'hex'))

test('ZIP host role mapping preserves selected file hashes, executable flags and aliases', async t => {
  const { path, archive } = await fixture(t)
  const call = receiver()
  const runtime = initialize({ resources: { inputs: '/not-the-archive' }, resourceFiles: { inputs: { engine: path } } })
  const session = runtime.start('resources.prepare', {}, call)
  session.write(Buffer.from(JSON.stringify({ archives: [archive], files: [{ ...file('engine.exe'), executable: true }, { ...file('alias.exe'), executable: true }] })))
  await session.finish()
  assert.deepEqual([...call.files.keys()], ['engine.exe', 'alias.exe'])
  assert.deepEqual(call.files.get('engine.exe'), data)
  assert.equal(call.events[0].executable, true)
})

test('ZIP modelDirectory emits only safe regular relative files and bounded chunks', async t => {
  const large = randomBytes(2 * 1024 * 1024)
  const { path, archive } = await fixture(t, { 'bundle/model.onnx': large, 'bundle/data/tokens.txt': data, 'unused': data })
  const call = receiver(new AbortController(), () => new Promise(resolve => setTimeout(resolve, 1)))
  await extractArchive(path, { ...archive, modelDirectory: 'bundle' }, [], call)
  assert.deepEqual(call.files.get('model.onnx'), large)
  assert.deepEqual([...call.files.keys()], ['model.onnx', 'data/tokens.txt'])
})

for (const name of ['../outside', '/absolute', 'C:/drive', 'bundle/../escape', 'bundle/back\\slash', 'bundle/NUL', 'bundle/COM1.txt', 'bundle/trailing.', 'bundle/ads:stream']) test(`ZIP rejects unsafe path ${name}, even when not selected`, async t => {
  const { path, archive } = await fixture(t, { 'bundle/engine.dll': data, [name]: data })
  await assert.rejects(extractArchive(path, archive, [file()], receiver()), /ARCHIVE_INVALID/)
})

for (const kind of ['case-duplicate', 'link', 'encrypted', 'budget', 'count', 'crc', 'hash', 'missing', 'truncated', 'alias-collision']) test(`ZIP rejects ${kind} with a stable preparation error`, async t => {
  const entries = kind === 'case-duplicate' ? { 'bundle/engine.dll': data, 'bundle/ENGINE.dll': data } : kind === 'count' ? Object.fromEntries(Array.from({ length: 16385 }, (_, n) => [`f${n}`, new Uint8Array()])) : { 'bundle/engine.dll': data }
  const { path, archive } = await fixture(t, entries, bytes => {
    const offset = central(bytes)
    if (kind === 'link') bytes.writeUInt32LE((0xa1ff << 16) >>> 0, offset + 38)
    if (kind === 'encrypted') bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8)
    if (kind === 'crc') bytes.writeUInt32LE((bytes.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16)
    return kind === 'truncated' ? bytes.subarray(0, bytes.length - 8) : bytes
  })
  if (kind === 'budget') archive.unpackedBytes = 1
  const files = kind === 'missing' ? [file('missing', 'missing')] : kind === 'hash' ? [{ ...file(), sha256: '0'.repeat(64) }] : kind === 'alias-collision' ? [file(), file('ENGINE.dll')] : [file()]
  const code = ['crc', 'hash'].includes(kind) ? 'CHECKSUM_MISMATCH' : kind === 'missing' ? 'ARCHIVE_INCOMPLETE' : 'ARCHIVE_INVALID'
  await assert.rejects(extractArchive(path, archive, files, receiver()), { message: `EXTENSION_INFERENCE_${code}` })
})

for (const phase of ['before', 'chunk']) test(`ZIP cancellation ${phase} stops before file completion`, async t => {
  const { path, archive } = await fixture(t, { 'bundle/engine.dll': randomBytes(1024 * 1024) })
  const controller = new AbortController()
  const call = receiver(controller, event => { if (event.type === 'chunk') controller.abort(Error('fixture-cancelled')) })
  if (phase === 'before') controller.abort(Error('fixture-cancelled'))
  await assert.rejects(extractArchive(path, { ...archive, modelDirectory: 'bundle' }, [], call), /fixture-cancelled/)
  assert.ok(!call.events.some(event => event.type === 'end'))
})
