import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import test from 'node:test'
import { activateManager } from '../manager.js'

const catalog = JSON.parse(await fs.readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await fs.readFile(new URL('../resources.json', import.meta.url)))

function languageFile() {
  const count = 24, head = 4 + count * 8
  const data = Buffer.alloc(head + 32)
  data.writeUInt32LE(count)
  for (let i = 0; i < count; i++) data.writeBigInt64LE(-1n, 4 + i * 8)
  for (const [i, offset] of [[17, 0], [21, 8], [22, 16], [23, 24]]) data.writeBigInt64LE(BigInt(head + offset), 4 + i * 8)
  return data
}

async function fixture({ failSave = false, cancelAfterPrepare = false, onSave = async (_execute) => {}, afterPrepare = async (_context) => {} } = {}) {
  const bytes = languageFile(), commands = new Map(), sets = [], prepared = [], removed = [], runtimes = [], bindings = []
  let saved = { models: { untouched: { threads: 7 } } }
  const execute = (name, input) => commands.get(`lexora.local-models.${name}`)({ arguments: input })
  const file = { id: 'file-id', name: 'eng.traineddata', size: bytes.length }
  const context = {
    signal: new AbortController().signal,
    storage: { get: async () => saved, set: async next => { await onSave(execute); if (failSave) throw Error('disk full'); saved = structuredClone(next) } },
    views: { broadcast: async () => {} },
    commands: { register: (name, fn) => { commands.set(name, fn); return () => {} } },
    subscriptions: { add() {} },
    network: { get: async () => { throw Error('Offline import must not query a network') }, download: async () => { throw Error('Offline import must not download') } },
    resources: {
      listFiles: async () => [file],
      readBytes: async (_file, { offset, length }) => ({ data: bytes.subarray(offset, offset + length), size: bytes.length, eof: offset + length >= bytes.length }),
      hash: async () => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }),
    },
    inference: {
      capabilities: { runtimeIsolation: true }, status: async () => runtimes, credentials: { has: async () => false }, bind: async binding => { bindings.push(binding) },
      resources: {
        list: async () => sets,
        prepare: async spec => { prepared.push(spec); const set = { id: spec.id, kind: 'model', revision: `revision-${prepared.length}`, authorized: true, bytes: bytes.length }; sets.push(set); await afterPrepare({ prepared, runtimes }); if (cancelAfterPrepare) await execute('cancel-preparation'); return set },
        remove: async ref => { removed.push(ref); sets.splice(sets.findIndex(set => set.id === ref.id && set.revision === ref.revision), 1) },
      },
    },
  }
  await activateManager(context, { manifest: { id: 'lexora.local-models' }, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  const inspection = await execute('inspect-local', { resourceIds: [file.id] })
  assert.equal(inspection.ok, true)
  const input = { token: inspection.token, recipe: 'ocr', selection: { language: file.id }, title: 'Local English' }
  return { execute, input, file, sets, prepared, removed, bindings, saved: () => saved }
}

test('offline import and byte-identical reimport retain identity, mount paths and unrelated configuration', async () => {
  const f = await fixture()
  assert.equal((await f.execute('status')).models.length, 0)
  const original = await f.execute('import-local', f.input)
  assert.equal(original.ok, true)
  const imported = (await f.execute('status')).models[0]
  assert.equal(imported.filesReady, true)
  assert.equal(imported.prepared, false)
  assert.deepEqual(imported.origin, { source: 'local' })
  assert.equal(imported.acquisition, 'import')
  assert.equal(imported.languages, 'eng')
  assert.equal(f.prepared[0].kind, 'model')
  assert.deepEqual(f.prepared[0].files[0].source, { resourceId: 'file-id', reference: true })
  assert.deepEqual(f.saved().models.untouched, { threads: 7 })
  assert.equal(f.saved().custom[0].specification.files[0].resourceId, undefined)
  assert.equal(f.saved().custom[0].specification.files[0].url, undefined)

  f.file.id = 'new-file-id'; f.file.name = 'renamed.traineddata'
  const inspection = await f.execute('inspect-local', { resourceIds: [f.file.id] })
  const repeated = await f.execute('import-local', { token: inspection.token, recipe: 'ocr', selection: { language: f.file.id }, title: 'New file name' })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.modelId, original.modelId)
  const state = await f.execute('status')
  assert.equal(state.models.length, 1)
  assert.equal(state.models[0].files.language, 'eng.traineddata')
  assert.equal(state.models[0].languages, 'eng')
  assert.equal(state.models[0].title, 'Local English')
  assert.equal(f.prepared[1].files[0].path, 'eng.traineddata')
  assert.equal(f.prepared[1].files[0].source.resourceId, 'new-file-id')
  assert.equal(f.saved().custom[0].specification.files[0].source, 'renamed.traineddata')
  assert.deepEqual(f.saved().models.untouched, { threads: 7 })
})

test('a task starting during repeated import retains its binding and exposes a recoverable activation warning', async () => {
  const f = await fixture({ afterPrepare: async ({ prepared, runtimes }) => {
    if (prepared.length === 2) runtimes.push({ runtime: 'ocr', configured: true, instances: [{ state: 'ready', active: 1, pending: 0 }] })
  } })
  const original = await f.execute('import-local', f.input)
  f.sets.push({ id: 'tesseract-wasm', kind: 'engine', revision: 'engine-revision', authorized: true })
  assert.equal((await f.execute('activate-model', { modelId: original.modelId })).ok, true)
  const count = f.bindings.length
  f.file.id = 'new-file-id'; f.file.name = 'renamed.traineddata'
  const inspection = await f.execute('inspect-local', { resourceIds: [f.file.id] })
  const result = await f.execute('import-local', { token: inspection.token, recipe: 'ocr', selection: { language: f.file.id } })
  assert.equal(result.ok, true)
  assert.match(result.warning, /任务结束后重新启用/)
  const state = await f.execute('status')
  assert.equal(state.models[0].filesReady, true)
  assert.equal(state.models[0].runtimeBusy, true)
  assert.equal(state.models[0].bindingWarning, result.warning)
  assert.equal(f.bindings.length, count)
  assert.equal(f.saved().active.ocr, original.modelId)
  assert.deepEqual(f.removed, [])
})

test('late cancellation explicitly rejects during atomic registration instead of claiming to cancel a committed model', async () => {
  const f = await fixture({ onSave: async execute => {
    assert.equal((await execute('status')).job.state, 'committing')
    const cancelled = await execute('cancel-preparation')
    assert.match(cancelled.error, /此阶段不能取消/)
  } })
  const result = await f.execute('import-local', f.input)
  assert.equal(result.ok, true)
  assert.equal((await f.execute('status')).models.length, 1)
  assert.equal(f.sets.length, 1)
  assert.deepEqual(f.removed, [])
})

for (const reason of ['save failure', 'cancellation']) test(`new local reference is rolled back on ${reason} without persisting a phantom model`, async () => {
  const f = await fixture({ failSave: reason === 'save failure', cancelAfterPrepare: reason === 'cancellation' })
  const result = await f.execute('import-local', f.input)
  assert.ok(result.error)
  const state = await f.execute('status')
  assert.deepEqual(state.models, [])
  assert.deepEqual(f.sets, [])
  assert.equal(f.removed.length, 1)
  assert.equal(f.saved().custom, undefined)
  assert.deepEqual(f.saved().models.untouched, { threads: 7 })
})
