import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { parseFile } from '../localImportFormats.js'
import { createLocalImport } from '../localImport.js'

// Explicit opt-in; never downloads, writes, hashes or loads the model weights.
// QWEN35_GGUF=/absolute/path/model.gguf node --test __tests__/local-import-real-gguf.spec.mjs
// Optional LOCAL_IMPORT_BASELINE=/path/to/original/localImportFormats.js compares
// the untouched baseline against this source parser, without artificial RPC delay.
test('real Qwen3.5 GGUF source parser and local inspection (read-only, no simulated latency)', { skip: !process.env.QWEN35_GGUF, timeout: 120000 }, async t => {
  const handle = await open(process.env.QWEN35_GGUF, 'r')
  t.after(() => handle.close())
  const before = await handle.stat(), file = { id: 'read-only-model', name: basename(process.env.QWEN35_GGUF), path: basename(process.env.QWEN35_GGUF), bytes: before.size }
  let calls = [], totalBytes = 0
  const context = { signal: new AbortController().signal, resources: {
    async listFiles() { return [{ id: file.id, name: file.name, size: (await handle.stat()).size }] },
    async readBytes({ id }, { offset, length }) {
      assert.equal(id, file.id); assert.ok(length <= 128 * 1024)
      calls.push({ offset, length }); totalBytes += length
      assert.ok(totalBytes <= 16 * 1024 ** 2, 'bounded metadata reads only')
      const data = Buffer.alloc(length), { bytesRead } = await handle.read(data, 0, length, offset)
      return { data: data.subarray(0, bytesRead), size: (await handle.stat()).size, eof: offset + bytesRead >= file.bytes }
    },
  } }
  async function measure(label, action) {
    calls = []; totalBytes = 0
    const start = performance.now()
    let result, error
    try { result = await action() } catch (e) { error = e.message }
    const metrics = { label, elapsedMs: +(performance.now() - start).toFixed(2), calls: calls.length, totalBytes, highestReadEnd: Math.max(0, ...calls.map(c => c.offset + c.length)), fileBytes: file.bytes, result, error }
    t.diagnostic(JSON.stringify(metrics))
    return metrics
  }
  let baseline
  if (process.env.LOCAL_IMPORT_BASELINE) {
    const original = await import(pathToFileURL(resolve(process.env.LOCAL_IMPORT_BASELINE)).href)
    baseline = await measure('original-source', () => original.parseFile(context, file, context.signal))
  }
  const current = await measure('patched-source', () => parseFile(context, file, context.signal))
  assert.equal(current.error, undefined)
  assert.equal(current.result.architecture, 'qwen35'); assert.equal(current.result.role, 'model'); assert.equal(current.result.vision, false)
  assert.ok(current.calls <= 256); assert.ok(current.totalBytes < file.bytes / 100)
  if (baseline) assert.ok(baseline.calls / current.calls >= 50, 'at least 50x fewer readBytes bridge calls')
  const repeat = await measure('repeat-source-fingerprint', () => parseFile(context, file, context.signal))
  assert.deepEqual(repeat.result, current.result)
  const inspection = await measure('local-import-inspect', () => createLocalImport(context).inspect({ resourceIds: [file.id] }))
  assert.equal(inspection.error, undefined)
  assert.deepEqual(inspection.result.candidates.map(c => c.recipe), ['chat'])
  assert.equal(inspection.result.candidates[0].missing.length, 0)
  const after = await handle.stat()
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
})
