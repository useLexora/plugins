import assert from 'node:assert/strict'
import test from 'node:test'
import { Reader } from '../localImportFormats.js'

const KiB = 1024, MiB = KiB ** 2
// GGUF opts into this larger block; the production Reader default stays 1 KiB.
function fixture(size = 300 * KiB, budget = { bytes: 0 }, readAhead = 64 * KiB) {
  const calls = [], controller = new AbortController()
  const context = { resources: { async readBytes(_, { offset, length }) {
    calls.push({ offset, length })
    assert.ok(length <= 128 * KiB)
    const data = Uint8Array.from({ length }, (_, i) => (offset + i) % 251)
    return { data, size, eof: offset + length === size }
  } } }
  return { r: new Reader(context, { id: 'fixture', bytes: size }, controller.signal, budget, readAhead), calls, controller, context, budget }
}
const expected = (offset, length) => Uint8Array.from({ length }, (_, i) => (offset + i) % 251)

test('straddling fields consume the cached tail, with no reread/omission and bounded RPCs', async () => {
  const { r, calls } = fixture()
  assert.deepEqual(await r.bytes(64 * KiB - 3), expected(0, 64 * KiB - 3))
  assert.deepEqual(await r.bytes(11), expected(64 * KiB - 3, 11))
  assert.deepEqual(calls, [{ offset: 0, length: 64 * KiB }, { offset: 64 * KiB, length: 64 * KiB }])
  assert.deepEqual(await r.bytes(170 * KiB), expected(64 * KiB + 8, 170 * KiB))
  for (let i = 1; i < calls.length; i++) assert.equal(calls[i].offset, calls[i - 1].offset + calls[i - 1].length)
})

test('GGUF-mode scalar reads use 64 KiB blocks (at least 60x fewer calls than 1 KiB)', async () => {
  const { r, calls } = fixture(2 * MiB)
  for (let i = 0; i < MiB / 8; i++) await r.bytes(8)
  assert.equal(calls.length, 16)
  assert.ok((MiB / KiB) / calls.length >= 60)
  assert.equal(r.used, MiB)
})

test('default Reader preserves 1 KiB prefetch and cache-tail reuse for sparse formats', async () => {
  const f = fixture(), r = new Reader(f.context, { id: 'fixture', bytes: 300 * KiB }, f.controller.signal, { bytes: 0 })
  await r.bytes(KiB - 3)
  assert.deepEqual(await r.bytes(11), expected(KiB - 3, 11))
  assert.deepEqual(f.calls, [{ offset: 0, length: KiB }, { offset: KiB, length: KiB }])
  r.skip(128 * KiB)
  assert.deepEqual(await r.bytes(1), expected(KiB + 8 + 128 * KiB, 1))
  assert.equal(f.calls.at(-1).length, KiB)
})

test('EOF, zero-length and skipped regions do not cause overread or unnecessary RPCs', async () => {
  const { r, calls } = fixture(64 * KiB + 3)
  await r.bytes(1)
  r.skip(64 * KiB - 2)
  assert.deepEqual(await r.bytes(4), expected(64 * KiB - 1, 4))
  assert.equal(calls.at(-1).length, 3)
  assert.equal((await r.bytes(0)).length, 0)
  assert.equal(calls.length, 2)
  await assert.rejects(r.bytes(1), /越界|截断/)
  assert.throws(() => r.skip(1), /越界|截断/)
  const gap = fixture(300 * KiB)
  await gap.r.bytes(1); gap.r.skip(200 * KiB)
  assert.deepEqual(await gap.r.bytes(4), expected(200 * KiB + 1, 4))
  assert.equal(gap.calls[1].offset, 200 * KiB + 1)
})

test('16 MiB per-file and 64 MiB aggregate read budgets reject before excess I/O', async () => {
  const budget = { bytes: 0 }
  const files = []
  for (let i = 0; i < 4; i++) {
    const f = fixture(17 * MiB, budget); files.push(f)
    await f.r.bytes(16 * MiB)
    assert.equal(f.r.used, 16 * MiB)
  }
  assert.equal(budget.bytes, 64 * MiB)
  const extra = fixture(MiB, budget)
  await assert.rejects(extra.r.bytes(1), /解析上限/)
  assert.equal(extra.calls.length, 0)
  const single = fixture(17 * MiB)
  await single.r.bytes(16 * MiB)
  await assert.rejects(single.r.bytes(1), /解析上限/)
  assert.equal(single.calls.reduce((sum, c) => sum + c.length, 0), 16 * MiB)
  assert.equal(files.flatMap(f => f.calls).reduce((sum, c) => sum + c.length, 0), 64 * MiB)
})

test('abort is honored before RPC, on cache hits and immediately after awaited RPC', async () => {
  const before = fixture(); before.controller.abort()
  await assert.rejects(before.r.bytes(1), { name: 'AbortError' }); assert.equal(before.calls.length, 0)
  const cached = fixture(); await cached.r.bytes(1); cached.controller.abort()
  await assert.rejects(cached.r.bytes(1), { name: 'AbortError' }); assert.equal(cached.calls.length, 1)
  const during = fixture(), read = during.context.resources.readBytes
  during.context.resources.readBytes = async (...args) => { const result = await read(...args); during.controller.abort(); return result }
  await assert.rejects(during.r.bytes(128 * KiB + 1), { name: 'AbortError' }); assert.equal(during.calls.length, 1)
})

for (const kind of ['short', 'size', 'type', 'throw']) test(`read integrity rejects ${kind} response`, async () => {
  const f = fixture(), read = f.context.resources.readBytes
  f.context.resources.readBytes = async (...args) => {
    if (kind === 'throw') throw Error('resource revoked')
    const result = await read(...args)
    if (kind === 'short') result.data = result.data.subarray(1)
    if (kind === 'size') result.size++
    if (kind === 'type') result.data = Array.from(result.data)
    return result
  }
  await assert.rejects(f.r.bytes(1), /变化|revoked/)
  assert.ok(f.calls.length <= 1)
})

test('fingerprint is repeatable, covers prefetched bytes and changes on mutation', async () => {
  const first = fixture(), second = fixture(), changed = fixture()
  const read = changed.context.resources.readBytes
  changed.context.resources.readBytes = async (...args) => { const result = await read(...args); result.data[9] ^= 1; return result }
  for (const f of [first, second, changed]) { await f.r.bytes(64 * KiB - 3); await f.r.bytes(11) }
  const proof = first.r.fingerprint()
  assert.equal(second.r.fingerprint(), proof)
  assert.notEqual(changed.r.fingerprint(), proof)
})
