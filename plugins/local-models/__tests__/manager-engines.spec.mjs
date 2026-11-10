import assert from 'node:assert/strict'
import test from 'node:test'
import { activateManager } from '../manager.js'

const specs = [
  { id: 'llama-b11747', kind: 'engine', files: [], legacy: true },
  { id: 'llama-vulkan-linux-x64-b12211', engineId: 'llama.cpp', kind: 'engine', title: 'llama.cpp', version: 'b12211', backend: 'vulkan', platforms: ['linux-x64'], files: [] },
  { id: 'llama-cuda-linux-x64-b12211', engineId: 'llama.cpp', kind: 'engine', title: 'llama.cpp', version: 'b12211', backend: 'cuda', platforms: ['linux-x64'], files: [] },
  { id: 'weights', kind: 'model', files: [] },
]
const model = { id: 'example', runtime: 'chat', title: 'Example', capabilities: ['对话'], resources: ['llama-b11747', 'weights'], defaults: { acceleration: 'gpu', threads: 4, contextWindow: 4096, maxTokens: 100 }, fields: [
  { key: 'acceleration', type: 'select', choices: [{ value: 'gpu' }, { value: 'cpu' }] },
  ...['threads', 'contextWindow', 'maxTokens'].map(key => ({ key, type: 'number', min: 1, max: 32768, integer: true })),
] }
const resource = id => ({ id, authorized: true, revision: `${id}-revision` })

async function open({ saved, failSave = false, architecture, resources = [resource('llama-b11747'), resource('weights')], busy = false, hardware, observation, additionalModel = false } = {}) {
  const commands = new Map(), bindings = new Map()
  const stored = saved ?? { active: { chat: model.id }, models: { [model.id]: model.defaults } }
  let state = structuredClone(stored)
  let active = busy
  let rejectSave = failSave
  let hardwareSnapshot = hardware, observed = observation, environmentPause
  await activateManager({
    signal: new AbortController().signal,
    subscriptions: { add() {} }, views: { broadcast: async () => {} },
    storage: { get: async () => state, set: async value => { if (rejectSave) throw Error('disk full'); state = structuredClone(value) } },
    commands: { register: (id, fn) => commands.set(id, fn) },
    inference: {
      capabilities: { runtimeIsolation: true, nativeRuntime: true },
      environment: async () => { await environmentPause; return { platform: 'linux-x64', executionMode: 'isolated', ...(hardwareSnapshot ? { hardware: hardwareSnapshot } : {}) } },
      resources: { list: async () => resources, prepare: async input => { const value = resource(input.id); resources.push(value); return value } },
      status: async () => [{ runtime: 'chat', configured: bindings.has('chat'), instances: active || observed ? [{ state: 'ready', active: active ? 1 : 0, pending: 0, ...(observed ? { observation: observed } : {}) }] : [] }],
      bind: async binding => bindings.set(binding.runtime, structuredClone(binding)), unbind: async ({ runtime }) => bindings.delete(runtime),
    },
  }, { manifest: { id: 'fixture' }, catalog: { models: [{ ...structuredClone(model), ...(architecture ? { metadata: { architecture } } : {}) }, ...(additionalModel ? [{ ...structuredClone(model), id: 'secondary' }] : [])], services: [] }, specifications: structuredClone(specs) })
  return { bindings, resources, saved: () => state, pauseEnvironment: () => { let release; environmentPause = new Promise(resolve => { release = resolve }); return () => { environmentPause = undefined; release() } }, hardware: value => { hardwareSnapshot = value }, observe: value => { observed = value }, busy: value => { active = value }, failSave: value => { rejectSave = value }, execute: (name, input = {}) => commands.get(`fixture.${name}`)({ arguments: input }) }
}

test('engine upgrade and rollback preserve model identity, files and parameters across restart', async () => {
  const f = await open()
  assert.equal(f.bindings.get('chat').resources[0].id, 'llama-b11747')
  assert.equal(f.saved().engineSelections, undefined)
  f.resources.push(resource(specs[1].id))
  assert.equal((await f.execute('use-engine', { resourceId: specs[1].id })).ok, true)
  assert.equal(f.bindings.get('chat').configuration.engineVersion, 'b12211')
  assert.equal(f.saved().engineSelections['linux-x64']['llama.cpp:vulkan'], specs[1].id)
  assert.equal(f.saved().active.chat, model.id)
  assert.deepEqual(f.saved().models[model.id], model.defaults)
  assert.equal(f.bindings.get('chat').resources[1].id, 'weights')
  const reopened = await open({ saved: f.saved(), resources: f.resources })
  assert.equal(reopened.bindings.get('chat').resources[0].id, specs[1].id)
  assert.equal((await reopened.execute('use-engine', { resourceId: 'llama-b11747' })).ok, true)
  assert.equal(reopened.bindings.get('chat').configuration.engineVersion, 'b11747')
})

test('switches reject busy runtimes and restore bindings if persistence fails', async () => {
  const f = await open()
  f.resources.push(resource(specs[1].id))
  f.busy(true)
  assert.match((await f.execute('use-engine', { resourceId: specs[1].id })).error, /正在使用/)
  assert.equal(f.bindings.get('chat').configuration.engineVersion, 'b11747')
  f.busy(false)
  f.failSave(true)
  await assert.rejects(f.execute('use-engine', { resourceId: specs[1].id }), /disk full/)
  assert.equal(f.bindings.get('chat').configuration.engineVersion, 'b11747')
  assert.equal((await f.execute('status')).engines.find(engine => engine.selected && engine.backend === 'vulkan').id, 'llama-b11747')
})

test('known new architectures cannot activate on older engines and show the required version', async () => {
  const f = await open({ architecture: 'lfm3' })
  assert.equal(f.bindings.has('chat'), false)
  const state = await f.execute('status')
  assert.match(state.models[0].compatibilityWarning, /b11960.*b11747/)
  assert.equal(state.models[0].prepared, false)
  assert.match((await f.execute('activate-model', { modelId: model.id })).error, /b11960/)
  f.resources.push(resource(specs[1].id))
  assert.equal((await f.execute('use-engine', { resourceId: specs[1].id })).ok, true)
  assert.equal(f.bindings.get('chat').configuration.minimumEngineVersion, 'b11960')
  assert.match((await f.execute('use-engine', { resourceId: 'llama-b11747' })).error, /b11960/)
})

test('changing to an unprepared backend does not keep calling the old runtime', async () => {
  const f = await open()
  const result = await f.execute('configure', { modelId: model.id, configuration: { ...model.defaults, acceleration: 'cuda' } })
  assert.equal(result.ok, true)
  assert.equal(f.bindings.has('chat'), false)
  assert.equal((await f.execute('status')).models[0].activeResources[0], specs[2].id)
  f.resources.push(resource(specs[2].id))
  assert.equal((await f.execute('activate-model', { modelId: model.id })).ok, true)
  assert.equal(f.bindings.get('chat').configuration.engineBackend, 'cuda')
})

test('preparing an update preserves the old selection across restart until explicitly switched', async () => {
  const f = await open()
  assert.equal((await f.execute('prepare', { resourceId: specs[1].id, mode: 'download' })).ok, true)
  assert.equal(f.bindings.get('chat').configuration.engineVersion, 'b11747')
  const reopened = await open({ saved: f.saved(), resources: f.resources })
  assert.equal(reopened.bindings.get('chat').configuration.engineVersion, 'b11747')
})

test('a missing selection can recover to the originally referenced engine and rebind', async () => {
  const saved = { active: { chat: model.id }, models: { [model.id]: model.defaults }, engineSelections: { 'linux-x64': { 'llama.cpp:vulkan': 'removed-engine' } } }
  const f = await open({ saved })
  assert.equal(f.bindings.has('chat'), false)
  assert.equal((await f.execute('use-engine', { resourceId: 'llama-b11747' })).ok, true)
  assert.equal(f.bindings.get('chat').configuration.engineVersion, 'b11747')
})

test('revoked selected engines remain selected and restore bindings after reauthorization', async () => {
  const saved = { active: { chat: model.id }, models: { [model.id]: model.defaults }, engineSelections: { 'linux-x64': { 'llama.cpp:vulkan': specs[1].id } } }
  const f = await open({ saved, resources: [resource('llama-b11747'), resource('weights'), { ...resource(specs[1].id), authorized: false }] })
  assert.equal(f.bindings.has('chat'), false)
  assert.equal((await f.execute('status')).models[0].prepared, false)
  assert.equal((await f.execute('prepare', { resourceId: specs[1].id, mode: 'download' })).ok, true)
  assert.equal(f.bindings.get('chat').resources[0].id, specs[1].id)
  f.bindings.delete('chat')
  assert.equal((await f.execute('use-engine', { resourceId: specs[1].id })).ok, true)
  assert.equal(f.bindings.get('chat').resources[0].id, specs[1].id)
  const current = (await f.execute('status')).models[0]
  assert.equal(current.prepared, true)
  assert.equal(current.bound, true)
})

const hardware = { sampledAt: 1, logicalCores: 32, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 20 * 1024 ** 3, gpus: [{ name: 'Fixture GPU', vendor: 'nvidia', totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3 }] }

test('hardware suggestions never overwrite saved choices or unknown configuration fields', async () => {
  const configuration = { acceleration: 'cpu', threads: 3, contextWindow: 8192, maxTokens: 73, retained: 'user-value' }
  const saved = { active: { chat: model.id }, models: { [model.id]: configuration } }
  const f = await open({ saved, hardware })
  const before = f.bindings.get('chat')
  const current = (await f.execute('status')).models[0]
  assert.equal(current.recommendation.configuration.acceleration, 'cuda')
  assert.equal(current.configuration.acceleration, 'cpu')
  assert.equal(current.configuration.contextWindow, 8192)
  assert.equal(current.configuration.threads, 3)
  assert.deepEqual(f.saved().models[model.id], configuration)
  f.hardware({ ...hardware, sampledAt: 2, logicalCores: 4, gpus: [] })
  const refreshed = await f.execute('status')
  assert.equal(refreshed.environment.hardware.sampledAt, 2)
  assert.deepEqual(refreshed.models[0].configuration, current.configuration)
  assert.deepEqual(f.bindings.get('chat'), before)
})

test('new model defaults can be changed and survive restart without following new recommendations', async () => {
  const f = await open({ saved: { active: { chat: model.id }, models: {} }, hardware })
  assert.equal((await f.execute('status')).models[0].configuration.acceleration, 'cuda')
  assert.equal(f.bindings.has('chat'), false)
  const selected = { acceleration: 'cpu', threads: 2, contextWindow: 32768, maxTokens: 30000 }
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: selected })).ok, true)
  const reopened = await open({ saved: f.saved(), hardware: { ...hardware, availableMemoryBytes: 1024, gpus: [] } })
  assert.deepEqual((await reopened.execute('status')).models[0].configuration, selected)
  assert.equal(reopened.bindings.get('chat').configuration.contextWindow, 32768)
})

test('only the active model receives live observations and stopped instances do not retain them', async () => {
  const observation = { observedAt: 100, backend: { requested: 'cuda', observed: ['cuda'] }, offload: { layers: 25, total: 25 }, context: { requested: 65536, actual: 65536 } }
  const f = await open({ hardware, observation, additionalModel: true })
  const current = await f.execute('status')
  assert.deepEqual(current.models.find(item => item.id === model.id).runtimeObservation, observation)
  assert.equal(current.models.find(item => item.id === 'secondary').runtimeObservation, undefined)
  f.observe(null)
  assert.equal((await f.execute('status')).models[0].runtimeObservation, undefined)
})

test('a model switch during hardware sampling discards the previous model observation', async () => {
  const f = await open({ additionalModel: true })
  f.observe({ observedAt: 100, backend: { requested: 'vulkan', observed: ['vulkan'] }, context: { actual: 65536 } })
  const release = f.pauseEnvironment()
  const pending = f.execute('status')
  assert.equal((await f.execute('activate-model', { modelId: 'secondary' })).ok, true)
  f.observe(null)
  release()
  const current = await pending
  const selected = current.models.find(item => item.id === 'secondary')
  assert.equal(selected.active, true)
  assert.equal(selected.runtimeObservation, undefined)
  assert.notEqual(selected.state, 'idle')
  assert.equal(current.models.find(item => item.id === model.id).runtimeObservation, undefined)
})

test('status preserves the JSON command result contract when engine metadata is optional', async () => {
  const f = await open()
  const current = await f.execute('status')
  assert.deepEqual(JSON.parse(JSON.stringify(current)), current)
})
