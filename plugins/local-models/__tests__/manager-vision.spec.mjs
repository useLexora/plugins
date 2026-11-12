import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { activateManager } from '../manager.js'

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await readFile(new URL('../resources.json', import.meta.url)))
const manifest = JSON.parse(await readFile(new URL('../extension.json', import.meta.url)))
const vision = catalog.models.find(model => model.runtime === 'vision')
const resource = id => ({ id, authorized: true, revision: 'existing-revision' })
const linuxConfiguration = values => ({ acceleration: 'gpu', ...values })

async function open({ stored = null, resources = vision.resources.map(resource), chatImageInput = true, chatToolMatching = true, chatReasoning = 'absent', chatModelMetadata = false } = {}) {
  let saved = structuredClone(stored)
  const original = structuredClone(stored)
  let saves = 0
  const commands = new Map(), bindings = new Map()
  await activateManager({
    signal: new AbortController().signal,
    storage: { get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); saves++ } },
    views: { broadcast: async () => {} },
    commands: { register: (id, handler) => { commands.set(id, handler); return () => {} } },
    subscriptions: { add() {} },
    inference: {
      capabilities: { runtimeIsolation: true, chatToolMatching, chatModelMetadata, ...(chatImageInput === 'absent' ? {} : { chatImageInput }), ...(chatReasoning === 'absent' ? {} : { chatReasoning }) },
      resources: { list: async () => resources },
      status: async () => [...bindings.keys()].map(runtime => ({ runtime, configured: true, instances: [] })),
      credentials: { has: async () => false },
      bind: async binding => bindings.set(binding.runtime, binding),
      unbind: async ({ runtime }) => bindings.delete(runtime),
    },
  }, { manifest, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  assert.equal(saves, 0)
  assert.deepEqual(stored, original)
  const execute = (name, input) => commands.get(`${manifest.id}.${name}`)({ arguments: input })
  return { execute, bindings, saved: () => saved }
}

test('vision registers chat image input and the original image reader on one runtime', async () => {
  const f = await open({ stored: { active: { vision: vision.id }, models: { [vision.id]: { threads: 7 } } } })
  const binding = f.bindings.get('vision')
  assert.deepEqual(binding.models, [{ id: vision.id, title: vision.title, capability: 'vision-chat', input: ['text', 'image'], contextWindow: 4096, maxTokens: 512, tools: 'auto', catalogModels: [] }])
  assert.deepEqual(binding.imageReaders, [{ id: vision.id, title: vision.title, capability: 'vision', support: { operations: ['understand', 'extract', 'document'] } }])
  assert.deepEqual(binding.resources, vision.resources.map((id, index) => ({ mount: index === 0 ? 'engine' : 'model', id, revision: 'existing-revision' })))
  assert.deepEqual(binding.configuration, { threads: 7, contextWindow: 4096, maxTokens: 512, acceleration: 'gpu', chatReasoning: false, modelId: vision.id, backend: 'vision', engineVersion: 'b11747', engineBackend: 'vulkan' })
  assert.equal(f.bindings.size, 1)
  assert.equal((await f.execute('status')).models[0].bindingWarning, '')
})

// 宿主能力只接受 boolean true；共享门禁无需与每种运行时做笛卡尔积。
for (const [runtime, chatReasoning] of [['chat', 'absent'], ['chat', true], ['vision', false], ['vision', 'true'], ['vision', true]]) test(`${runtime} reasoning binding requires explicit host support (${JSON.stringify(chatReasoning)}) without rewriting saved parameters or provenance`, async () => {
  const template = catalog.models.find(model => model.runtime === runtime)
  const model = { ...structuredClone(template), id: `saved-${runtime}`, fields: [...template.fields, { key: 'chatReasoning', type: 'select', choices: [{ value: false }, { value: true }] }], origin: { source: 'huggingface', repository: 'unsloth/Qwen3.5-9B-GGUF', revision: '1'.repeat(40) }, metadata: { tags: ['base_model:quantized:Qwen/Qwen3.5-9B'] } }
  const configuration = { ...model.defaults, contextWindow: 65536, maxTokens: 4096, chatReasoning: chatReasoning !== true }
  const stored = { custom: [{ model, specification: { id: 'unchanged', kind: 'model', files: [] } }], active: { [runtime]: model.id }, models: { [model.id]: configuration } }
  const f = await open({ stored, resources: model.resources.map(resource), chatReasoning })
  const binding = f.bindings.get(runtime)
  assert.deepEqual(binding.models, [{ id: model.id, title: model.title, capability: runtime === 'vision' ? 'vision-chat' : 'chat', ...(runtime === 'vision' ? { input: ['text', 'image'] } : {}), contextWindow: 65536, maxTokens: 4096, tools: 'auto', ...(chatReasoning === true ? { reasoning: 'auto' } : {}), catalogModels: [{ providerId: 'huggingface', modelId: 'Qwen/Qwen3.5-9B' }] }])
  assert.deepEqual(binding.configuration, { ...linuxConfiguration(configuration), chatReasoning: chatReasoning === true, modelId: model.id, ...(runtime === 'vision' ? { backend: 'vision' } : {}), engineVersion: 'b11747', engineBackend: 'vulkan' })
  assert.deepEqual((await f.execute('status')).models.find(item => item.id === model.id).configuration, linuxConfiguration(configuration))
  assert.deepEqual(binding.resources, model.resources.map((id, index) => ({ mount: index === 0 ? 'engine' : 'model', id, revision: 'existing-revision' })))
  assert.deepEqual(f.saved(), stored)
})

for (const chatModelMetadata of [false, true]) test(`local model declarations preserve identity, user configuration and old-host compatibility (${chatModelMetadata})`, async () => {
  const template = catalog.models.find(model => model.runtime === 'chat')
  const capabilities = { toolCall: true, reasoningOptions: ['off', 'medium'], contextWindow: 262144 }
  const model = { ...structuredClone(template), id: 'local-existing', origin: { source: 'local' }, metadata: { capabilities } }
  const configuration = { ...model.defaults, contextWindow: 65536, maxTokens: 2048 }
  const stored = { custom: [{ model, specification: { id: 'unchanged', kind: 'model', files: [] } }], active: { chat: model.id }, models: { [model.id]: configuration } }
  const f = await open({ stored, resources: model.resources.map(resource), chatReasoning: true, chatModelMetadata })
  const binding = f.bindings.get('chat')
  assert.equal(binding.configuration.modelId, model.id)
  assert.equal(binding.configuration.contextWindow, 65536)
  assert.deepEqual(binding.models[0], { id: model.id, title: model.title, capability: 'chat', contextWindow: 65536, maxTokens: 2048, tools: true, reasoning: true, catalogModels: [], ...(chatModelMetadata ? { metadata: capabilities } : {}) })
  assert.deepEqual(f.saved(), stored)
})

for (const runtime of ['chat', 'vision']) test(`${runtime} activation shares reasoning provenance even without automatic tool matching`, async () => {
  const template = catalog.models.find(model => model.runtime === runtime)
  const model = { ...structuredClone(template), id: `saved-${runtime}`, origin: { source: 'huggingface', repository: 'example/model', revision: '1'.repeat(40) } }
  const stored = { custom: [{ model, specification: { id: 'unchanged', kind: 'model', files: [] } }], active: {}, models: { [model.id]: model.defaults } }
  const f = await open({ stored, resources: model.resources.map(resource), chatReasoning: true, chatToolMatching: false })
  assert.equal(f.bindings.has(runtime), false)
  assert.equal((await f.execute('activate-model', { modelId: model.id })).ok, true)
  assert.deepEqual(f.bindings.get(runtime).models[0], { id: model.id, title: model.title, capability: runtime === 'vision' ? 'vision-chat' : 'chat', ...(runtime === 'vision' ? { input: ['text', 'image'] } : {}), contextWindow: model.defaults.contextWindow, maxTokens: model.defaults.maxTokens, tools: false, reasoning: 'auto', catalogModels: [{ providerId: 'huggingface', modelId: 'example/model' }] })
  assert.equal(f.bindings.get(runtime).configuration.chatReasoning, true)
  assert.match((await f.execute('status')).models.find(item => item.id === model.id).bindingWarning, /工具能力匹配.*升级/)
  assert.deepEqual(f.saved().custom, stored.custom)
  assert.deepEqual(f.saved().models[model.id], linuxConfiguration(stored.models[model.id]))
  assert.deepEqual(f.saved().active, { [runtime]: model.id })
})

for (const chatImageInput of ['absent', false, 'true']) test(`older hosts (${JSON.stringify(chatImageInput)}) keep independent reading and explicitly require upgrading for chat`, async () => {
  const f = await open({ chatImageInput })
  const binding = f.bindings.get('vision')
  assert.equal(binding.models, undefined)
  assert.equal(binding.imageReaders[0].id, vision.id)
  const model = (await f.execute('status')).models[0]
  assert.equal(model.bound, true)
  assert.match(model.bindingWarning, /仅支持.*独立识图.*升级/)
  assert.deepEqual(model.capabilities, ['图片理解', '文字识别'])
  const activated = await f.execute('activate-model', { modelId: vision.id })
  assert.equal(activated.ok, true)
  assert.match(activated.warning, /升级/)
  assert.equal(f.saved().active.vision, vision.id)
})

test('legacy custom fields gain chat settings without replacing identity, defaults, files or saved values', async () => {
  const model = {
    ...vision, id: 'local-existing', title: 'Saved model', custom: true,
    resources: ['old-engine', 'old-model'], directoryResources: ['reference-engine', 'reference-model'],
    files: { model: 'saved.gguf', projector: 'saved-projector.gguf' },
    capabilities: ['图片理解', '文字识别'], fields: [{ ...vision.fields[0], max: 12 }], defaults: { threads: 5 },
    metadata: { tags: ['saved-tag'] },
  }
  const specification = { id: 'old-model', kind: 'model', files: [] }
  const active = { vision: model.id, chat: 'other-model' }
  const stored = { custom: [{ model, specification }], active, models: { [model.id]: { threads: 9, contextWindow: 16384, maxTokens: 1024 }, 'other-model': { threads: 3 } } }
  const f = await open({ stored, resources: model.directoryResources.map(resource) })
  const current = (await f.execute('status')).models[0]
  assert.deepEqual(current.configuration, { threads: 9, contextWindow: 16384, maxTokens: 1024, acceleration: 'gpu' })
  assert.deepEqual(current.defaults, { threads: 5, contextWindow: 4096, maxTokens: 512, acceleration: 'gpu' })
  assert.equal(current.fields[0].max, 12)
  assert.deepEqual(current.fields.map(field => field.key), ['threads', 'contextWindow', 'maxTokens', 'acceleration'])
  assert.deepEqual(current.fields.find(field => field.key === 'acceleration').choices.map(choice => choice.value), ['cpu', 'gpu', 'cuda'])
  assert.deepEqual(current.files, model.files)
  assert.deepEqual(current.resources, model.resources)
  assert.deepEqual(current.directoryResources, model.directoryResources)
  assert.equal(current.active, true)
  assert.deepEqual(f.bindings.get('vision').resources.map(item => item.id), model.directoryResources)
  assert.deepEqual(f.bindings.get('vision').configuration.files, model.files)
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...current.configuration, maxTokens: 768 } })).ok, true)
  const saved = f.saved()
  assert.deepEqual(saved.active, active)
  assert.deepEqual(saved.custom[0].specification, specification)
  assert.deepEqual(saved.custom[0].model, model)
  assert.deepEqual(saved.models[model.id], { threads: 9, contextWindow: 16384, maxTokens: 768, acceleration: 'gpu' })
  assert.deepEqual(saved.models['other-model'], { threads: 3 })
  const reopened = await open({ stored: saved, resources: model.directoryResources.map(resource) })
  assert.deepEqual((await reopened.execute('status')).models[0].configuration, { threads: 9, contextWindow: 16384, maxTokens: 768, acceleration: 'gpu' })
})

for (const runtime of ['chat', 'vision']) test(`legacy ${runtime} token fields refresh without resetting stored 64K context or custom thread limits`, async () => {
  const template = catalog.models.find(model => model.runtime === runtime)
  const model = { ...template, id: `saved-${runtime}`, custom: true, fields: template.fields.map(field => field.key === 'threads' ? { ...field, max: 12 } : ['contextWindow', 'maxTokens'].includes(field.key) ? { ...field, max: field.key === 'contextWindow' ? 32768 : 2048 } : field) }
  const configuration = { ...model.defaults, threads: 9, contextWindow: 65536, maxTokens: 4096 }
  const stored = { custom: [{ model, specification: { id: 'unchanged', kind: 'model', files: [] } }], active: { [runtime]: model.id }, models: { [model.id]: configuration } }
  const f = await open({ stored, resources: model.resources.map(resource) })
  const current = (await f.execute('status')).models.find(item => item.id === model.id)
  assert.deepEqual(current.configuration, linuxConfiguration(configuration))
  assert.equal(current.fields.find(field => field.key === 'contextWindow').max, 2000000)
  assert.equal(current.fields.find(field => field.key === 'threads').max, 12)
  assert.equal(f.bindings.get(runtime).configuration.contextWindow, 65536)
  assert.equal(f.bindings.get(runtime).models[0].contextWindow, 65536)
  for (const invalid of [{ contextWindow: 2000001 }, { contextWindow: 65536.5 }, { contextWindow: 4096, maxTokens: 8192 }]) {
    assert.ok((await f.execute('configure', { modelId: model.id, configuration: { ...current.configuration, ...invalid } })).error)
    assert.deepEqual(f.saved(), stored)
  }
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...current.configuration, maxTokens: 8192 } })).ok, true)
  const reopened = await open({ stored: f.saved(), resources: model.resources.map(resource) })
  assert.deepEqual((await reopened.execute('status')).models.find(item => item.id === model.id).configuration, { ...linuxConfiguration(configuration), maxTokens: 8192 })
  const inactive = await open({ stored: { ...stored, active: {} }, resources: model.resources.map(resource) })
  assert.ok((await inactive.execute('configure', { modelId: model.id, configuration: { ...linuxConfiguration(configuration), maxTokens: 65537 } })).error)
})

test('text chat and OCR keep their existing capabilities; metadata cannot create chat image support', async () => {
  const chat = catalog.models.find(model => model.runtime === 'chat')
  const ocr = catalog.models.find(model => model.runtime === 'ocr')
  const customOcr = { ...ocr, id: 'ocr-tagged-vision', metadata: { tags: ['vision', 'gguf'] } }
  const f = await open({
    resources: [...new Set([...chat.resources, ...ocr.resources])].map(resource),
    stored: { active: { chat: chat.id, ocr: customOcr.id }, custom: [{ model: customOcr, specification: { id: 'unused', kind: 'model', files: [] } }] },
  })
  assert.deepEqual(f.bindings.get('chat').models, [{ id: chat.id, title: chat.title, capability: 'chat', contextWindow: chat.defaults.contextWindow, maxTokens: chat.defaults.maxTokens, tools: 'auto', catalogModels: [] }])
  assert.equal(f.bindings.get('ocr').models, undefined)
  assert.equal(Object.hasOwn(f.bindings.get('ocr').configuration, 'chatReasoning'), false)
  assert.deepEqual(f.bindings.get('ocr').imageReaders[0].support.operations, ['extract'])
  assert.equal(f.bindings.has('vision'), false)
})
