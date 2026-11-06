import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { activateManager } from '../manager.js'

const catalog = JSON.parse(await fs.readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await fs.readFile(new URL('../resources.json', import.meta.url)))

async function openManager(resources, stored = null, onSave = async () => { throw Error('Opening the library must not rewrite saved data') }, prepareResource = async (spec) => { resources.push({ id: spec.id, kind: spec.kind, authorized: true, revision: 'test' }) }, ports = {}) {
  const commands = new Map()
  const context = {
    ...ports,
    signal: new AbortController().signal,
    views: { broadcast: async () => {} },
    storage: { get: async () => stored, set: onSave },
    commands: { register: (id, handler) => { commands.set(id, handler); return () => {} } },
    subscriptions: { add() {} },
    inference: {
      capabilities: { runtimeIsolation: true },
      resources: { list: async () => resources, prepare: prepareResource, remove: async ({ id }) => { resources.splice(resources.findIndex(resource => resource.id === id), 1) } },
      stop: async () => {},
      status: async () => [],
      credentials: { has: async () => false },
      bind: async () => {},
    },
  }
  await activateManager(context, { manifest: { id: 'lexora.local-models' }, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  return { ...await commands.get('lexora.local-models.status')({}), execute: (name, input) => commands.get(`lexora.local-models.${name}`)({ arguments: input }), configure: input => commands.get('lexora.local-models.configure')({ arguments: input }) }
}

test('existing downloaded and restored resources preserve their model identity and settings', async () => {
  const stored = { active: { chat: 'qwen3-4b' }, models: { 'qwen3-4b': { ...catalog.models[0].defaults, threads: 6 } } }
  const state = await openManager([{ id: 'qwen3-4b-model', authorized: false }], stored)
  assert.deepEqual(state.models.map(model => model.id), ['qwen3-4b'])
  assert.equal(state.models[0].configuration.threads, 6)
  assert.equal(state.models[0].active, true)
  assert.equal(state.models[0].prepared, false)
  assert.equal(state.models[0].filesRegistered, true)
  assert.equal(state.models[0].filesReady, false)
  assert.ok(state.specifications.some(spec => spec.id === 'qwen3-4b-model'))
})

test('saving a resource-less custom model retains its record and settings for unrelated legacy models', async () => {
  const model = { ...catalog.models[0], id: 'custom-example', custom: true, metadata: { tags: ['gguf', 'en'] }, resources: ['llama-b11747', 'custom-example-model'] }
  const specification = { id: 'custom-example-model', kind: 'model', files: [] }
  const legacyConfiguration = { ...catalog.models[0].defaults, threads: 7 }
  const stored = { custom: [{ model, specification }], models: { 'qwen3-4b': legacyConfiguration, [model.id]: { ...model.defaults, threads: 5 } } }
  let saved
  const state = await openManager([], stored, async value => { saved = value })
  assert.deepEqual(state.models.map(item => item.id), [model.id])
  assert.deepEqual(state.models[0].metadata.tags, model.metadata.tags)
  assert.equal(state.models[0].configuration.threads, 5)
  assert.ok(state.specifications.some(item => item.id === specification.id))
  assert.equal((await state.configure({ modelId: model.id, configuration: { ...model.defaults, threads: 6 } })).ok, true)
  assert.deepEqual(saved.custom, stored.custom)
  assert.deepEqual(saved.models['qwen3-4b'], legacyConfiguration)
  assert.equal(saved.models[model.id].threads, 6)
})

test('an engine installs without registering a model or downloading model weights', async () => {
  const resources = []
  const manager = await openManager(resources)
  assert.deepEqual(await manager.execute('prepare', { resourceId: 'llama-b11747', mode: 'download' }), { ok: true })
  const state = await manager.execute('status')
  assert.deepEqual(state.models, [])
  assert.deepEqual(resources.map(({ id, kind }) => ({ id, kind })), [{ id: 'llama-b11747', kind: 'engine' }])
  assert.equal(state.job.resourceId, 'llama-b11747')
  assert.equal(state.job.state, 'completed')
  assert.deepEqual(state.downloadHistory, [])
  assert.ok(state.engines.find(engine => engine.id === 'llama-b11747').capabilities.length)
  assert.ok((await manager.execute('prepare', { resourceId: 'qwen3-4b-model', mode: 'download' })).error)
})

test('model-only acquisition leaves engines untouched and clearing model files retains an installed engine', async () => {
  const model = { ...catalog.models[0], id: 'custom-example', custom: true, resources: ['llama-b11747', 'custom-example-model'] }
  const resources = []
  const manager = await openManager(resources, { custom: [{ model, specification: { id: 'custom-example-model', kind: 'model', files: [{ path: 'model.gguf', sha256: 'a'.repeat(64), url: 'https://example.com/model.gguf' }] } }] })
  assert.equal((await manager.execute('prepare', { modelId: model.id, scope: 'model', mode: 'download' })).ok, true)
  let state = await manager.execute('status')
  assert.equal(state.models[0].filesReady, true)
  assert.equal(state.models[0].prepared, false)
  assert.deepEqual(resources.map(resource => resource.id), ['custom-example-model'])
  assert.equal((await manager.execute('prepare', { resourceId: 'llama-b11747', mode: 'download' })).ok, true)
  state = await manager.execute('status')
  assert.equal(state.models[0].prepared, true)
  await manager.execute('clear', { modelId: model.id })
  assert.deepEqual(resources.map(resource => resource.id), ['llama-b11747'])
})

test('only empty custom records can be removed; restored references and saved configurations remain protected', async () => {
  const model = { ...catalog.models[0], id: 'custom-example', custom: true, resources: ['llama-b11747', 'custom-example-model'] }
  const resources = [{ id: 'custom-example-model', authorized: false }]
  let saved
  const manager = await openManager(resources, { active: { chat: model.id, ocr: 'other-model' }, custom: [{ model, specification: { id: 'custom-example-model', kind: 'model', files: [] } }], models: { 'unrelated': { threads: 7 } } }, async value => { saved = value })
  assert.ok((await manager.execute('remove-record', { modelId: model.id })).error)
  assert.equal((await manager.execute('status')).models.length, 1)
  resources.splice(0)
  assert.equal((await manager.execute('remove-record', { modelId: model.id })).ok, true)
  assert.equal((await manager.execute('status')).models.length, 0)
  assert.deepEqual(saved.custom, [])
  assert.deepEqual(saved.active, { ocr: 'other-model' })
  assert.deepEqual(saved.models.unrelated, { threads: 7 })
})

test('independent engine preparation can be cancelled without creating models', async () => {
  const resources = []
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const manager = await openManager(resources, null, undefined, async (_spec, { signal }) => {
    entered()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const preparation = manager.execute('prepare', { resourceId: 'llama-b11747', mode: 'download' })
  await started
  await manager.execute('cancel-preparation')
  assert.ok((await preparation).error)
  const state = await manager.execute('status')
  assert.equal(state.job.state, 'cancelled')
  assert.deepEqual(state.models, [])
  assert.deepEqual(resources, [])
})

const cachePorts = {
  extension: { version: '1.0.0' },
  network: { get: async () => ({ status: 200, headers: {}, text: JSON.stringify([{ id: 'example/model', sha: 'a'.repeat(40), pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.safetensors' }] }]) }) },
}
const cacheModel = { ...catalog.models[0], id: 'custom-cache', custom: true, resources: ['llama-b11747', 'custom-cache-model'] }
const cacheSettings = () => ({ active: {}, custom: [{ model: cacheModel, specification: { id: 'custom-cache-model', kind: 'model', files: [] } }], models: { retained: { threads: 7 } } })

test('cache-only persistence preserves the original configuration without normalizing or migrating it', async () => {
  const original = { ...cacheSettings(), version: 2, retainedField: { value: 'keep' } }
  let saved
  const manager = await openManager([], original, async value => { saved = value }, undefined, cachePorts)
  await manager.execute('discover', {})
  const { discoveryCache, ...rest } = saved
  assert.deepEqual(rest, original)
  assert.ok(discoveryCache.entries.length > 0)
  assert.equal((await manager.execute('status')).models[0].id, cacheModel.id)
})

test('discovery cache and model configuration writes preserve each other in either order', async (t) => {
  for (const first of ['cache', 'configuration']) await t.test(first, async () => {
    let enter, release, saved
    const entered = new Promise(resolve => { enter = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    let calls = 0
    const manager = await openManager([], cacheSettings(), async value => {
      calls++
      if (calls === 1) { enter(); await blocked }
      saved = structuredClone(value)
    }, undefined, cachePorts)
    const configure = () => manager.configure({ modelId: cacheModel.id, configuration: { ...cacheModel.defaults, threads: 6 } })
    const discover = () => manager.execute('discover', {})
    const pendingFirst = first === 'cache' ? discover() : configure()
    await entered
    const pendingSecond = first === 'cache' ? configure() : discover()
    await new Promise(setImmediate)
    assert.equal(calls, 1, '缓存和配置不得同时覆盖同一存储快照')
    release()
    await Promise.all([pendingFirst, pendingSecond])
    assert.equal(saved.models[cacheModel.id].threads, 6)
    assert.deepEqual(saved.models.retained, { threads: 7 })
    assert.deepEqual(saved.custom, cacheSettings().custom)
    assert.ok(saved.discoveryCache.entries.length > 0)
  })
})

test('failed cache persistence does not fail discovery or poison the next configuration save', async () => {
  let attempts = 0, saved
  const manager = await openManager([], cacheSettings(), async value => {
    if (!attempts++) throw Error('storage unavailable')
    saved = value
  }, undefined, cachePorts)
  const result = await manager.execute('discover', {})
  assert.equal(result.items[0].availability.state, 'unsupported')
  assert.equal((await manager.configure({ modelId: cacheModel.id, configuration: { ...cacheModel.defaults, threads: 6 } })).ok, true)
  assert.equal(saved.models[cacheModel.id].threads, 6)
  assert.equal(saved.discoveryCache, undefined)
})

test('model settings take precedence over cache at the private storage size limit', async () => {
  let saved
  const stored = { ...cacheSettings(), discoveryCache: { obsolete: 'cache'.repeat(2000) } }
  const first = await openManager([], stored, async value => { saved = structuredClone(value) })
  await first.configure({ modelId: cacheModel.id, configuration: { ...cacheModel.defaults, threads: 6 } })
  saved.models.retained.note = ''
  saved.models.retained.note = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(saved)))
  assert.equal(Buffer.byteLength(JSON.stringify(saved)), 256 * 1024)
  const note = saved.models.retained.note
  const manager = await openManager([], saved, async value => {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024)
    saved = structuredClone(value)
  })
  assert.equal((await manager.configure({ modelId: cacheModel.id, configuration: { ...cacheModel.defaults, threads: 12 } })).ok, true)
  assert.equal(saved.discoveryCache, undefined)
  assert.equal(saved.models.retained.note, note)
  assert.equal(saved.models[cacheModel.id].threads, 12)
  saved.models.retained.note += 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(saved)))
  let writes = 0
  const full = await openManager([], saved, async value => { writes++; saved = value }, undefined, cachePorts)
  assert.equal((await full.execute('discover', {})).items[0].availability.state, 'unsupported')
  assert.equal(writes, 0, '缓存超过剩余空间时不能覆盖已保存配置')
  assert.equal((await full.configure({ modelId: cacheModel.id, configuration: { ...cacheModel.defaults, threads: 13 } })).ok, true)
  assert.equal(saved.models[cacheModel.id].threads, 13)
  assert.equal(saved.discoveryCache, undefined)
})

