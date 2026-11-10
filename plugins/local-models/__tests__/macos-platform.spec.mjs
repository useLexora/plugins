import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { activateManager } from '../manager.js'
import { inferenceEnvironment, platformModel, resourceSupported } from '../platform.js'

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await readFile(new URL('../resources.json', import.meta.url)))
const manifest = JSON.parse(await readFile(new URL('../extension.json', import.meta.url)))
const registered = id => ({ id, authorized: true, revision: 'fixture' })
const mac = { platform: 'macos-arm64', executionMode: 'supervised' }

async function open({ environment = mac, stored, resources = [...specifications.filter(spec => spec.id !== 'z-image-turbo-model'), ...(stored?.custom ?? []).map(item => item.specification)].map(spec => registered(spec.id)), network, localResources } = {}) {
  const commands = new Map(), bindings = new Map(), prepared = []
  let saved = structuredClone(stored), saves = 0
  await activateManager({
    signal: new AbortController().signal,
    extension: { version: manifest.version },
    network,
    resources: localResources,
    subscriptions: { add() {} },
    storage: { get: async () => saved, set: async value => { saved = structuredClone(value); saves++ } },
    commands: { register: (id, handler) => commands.set(id, handler) },
    views: { broadcast: async () => {} },
    inference: {
      capabilities: { nativeRuntime: true, chatImageInput: true, chatToolMatching: true },
      environment: async () => environment,
      resources: { list: async () => resources, prepare: async spec => { prepared.push(spec); return registered(spec.id) } },
      bind: async value => bindings.set(value.runtime, value),
      status: async () => [...bindings.keys()].map(runtime => ({ runtime, configured: true, instances: [] })),
      credentials: { has: async () => false },
    },
  }, { manifest, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  return { bindings, prepared, resources, saved: () => saved, saves: () => saves, execute: (name, input) => commands.get(`${manifest.id}.${name}`)({ arguments: input }) }
}

test('macOS only accepts the host ARM64 supervised contract, without guessing a platform', async () => {
  assert.deepEqual(await inferenceEnvironment({ capabilities: { nativeRuntime: true }, environment: async () => mac }), mac)
  for (const value of [{ platform: 'macos-x64', executionMode: 'supervised' }, { platform: 'darwin-arm64', executionMode: 'supervised' }, { platform: 'macos-arm64', executionMode: 'isolated' }]) {
    assert.equal((await inferenceEnvironment({ capabilities: { nativeRuntime: true }, environment: async () => value })).executionMode, 'unsupported')
  }
})

test('macOS binds verified ARM64 engines, CPU chat/shared vision, WASM OCR and Metal image generation', async () => {
  const f = await open()
  assert.equal(f.saves(), 0)
  const state = await f.execute('status')
  assert.deepEqual(state.environment, mac)
  assert.deepEqual(state.engines.map(item => item.id).sort(), ['image-metal-macos-arm64', 'llama-b11747-macos-arm64', 'llama-metal-macos-arm64-b12211', 'sherpa-onnx-macos-arm64', 'tesseract-wasm'])
  for (const [runtime, engine] of [['chat', 'llama-metal-macos-arm64-b12211'], ['vision', 'llama-metal-macos-arm64-b12211'], ['asr', 'sherpa-onnx-macos-arm64'], ['tts', 'sherpa-onnx-macos-arm64'], ['image', 'image-metal-macos-arm64'], ['ocr', 'tesseract-wasm']]) {
    const binding = f.bindings.get(runtime)
    assert.equal(binding.resources[0].id, engine)
    assert.equal(binding.libraryPaths, undefined)
    if (['chat', 'vision'].includes(runtime)) assert.equal(binding.configuration.acceleration, 'cpu')
  }
  assert.equal(f.bindings.get('vision').models[0].id, 'qwen3-vl')
  assert.equal(f.bindings.get('vision').imageReaders[0].id, 'qwen3-vl')
  assert.equal(f.bindings.get('ocr').configuration.ocrEngine, 'wasm')
  assert.equal(f.bindings.get('image').configuration.backend, 'metal')
  for (const model of state.models.filter(model => ['chat', 'vision', 'image'].includes(model.runtime))) {
    assert.deepEqual(model.fields.find(field => field.key === 'acceleration').choices, [{ value: 'cpu', title: 'CPU' }, { value: 'gpu', title: 'Metal' }])
  }
  const image = state.models.find(model => model.runtime === 'image')
  assert.equal((await f.execute('configure', { modelId: image.id, configuration: { ...image.configuration, acceleration: 'cpu' } })).ok, true)
  assert.equal(f.bindings.get('image').configuration.backend, 'cpu')
  assert.ok((await f.execute('prepare', { resourceId: 'llama-b11747', mode: 'download' })).error)
  assert.ok((await f.execute('prepare', { resourceId: 'llama-b11747-macos-arm64', mode: 'download' })).error)
  assert.equal((await f.execute('prepare', { resourceId: 'llama-metal-macos-arm64-b12211', mode: 'download' })).ok, true)
  assert.match(f.prepared[0].preparation.inputs[0].source.url, /b12211-bin-macos-arm64\.tar\.gz$/)
  assert.equal((await f.execute('use-engine', { resourceId: 'llama-b11747-macos-arm64' })).ok, true)
  assert.equal(f.bindings.get('chat').resources[0].id, 'llama-b11747-macos-arm64')
})

test('macOS preserves custom identity, stored choices and existing API connections without migration', async () => {
  const model = { ...catalog.models[0], id: 'existing', custom: true }
  const stored = { custom: [{ model, specification: specifications.find(item => item.id === model.resources[1]) }], active: { chat: model.id }, models: { [model.id]: { ...model.defaults, threads: 7, contextWindow: 65536 } }, services: { 'speech-api': { enabled: true, configuration: catalog.services[0].defaults }, 'image-api': { enabled: true, configuration: catalog.services[1].defaults } } }
  const resources = specifications.filter(spec => spec.version !== 'b12211').map(spec => registered(spec.id))
  const f = await open({ stored, resources })
  assert.deepEqual(f.saved(), stored)
  assert.equal(f.saves(), 0)
  assert.equal(f.bindings.get('chat').resources[0].id, 'llama-b11747-macos-arm64')
  assert.equal(f.bindings.get('chat').configuration.acceleration, 'gpu')
  assert.equal(f.bindings.get('chat').configuration.contextWindow, 65536)
  assert.ok(f.bindings.has('speech-api') && f.bindings.has('image-api'))
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...stored.models[model.id], threads: 5 } })).ok, true)
  assert.deepEqual(f.saved().custom[0].model.resources, model.resources)
  assert.equal(f.saved().active.chat, 'existing')
  const upgradedInstallation = await open({ stored: f.saved() })
  assert.equal(upgradedInstallation.bindings.get('chat').resources[0].id, 'llama-b11747-macos-arm64')
  assert.equal(upgradedInstallation.bindings.get('chat').configuration.threads, 5)
})

test('macOS selections survive Linux saves and Linux resources never satisfy macOS bindings', async () => {
  const first = await open()
  for (const runtime of ['vision', 'image']) {
    const model = (await first.execute('status')).models.find(model => model.runtime === runtime)
    assert.equal((await first.execute('configure', { modelId: model.id, configuration: { ...model.configuration, acceleration: 'cpu' } })).ok, true)
  }
  const linux = await open({ environment: { platform: 'linux-x64', executionMode: 'isolated' }, stored: first.saved() })
  const state = await linux.execute('status')
  for (const runtime of ['vision', 'image']) {
    const model = state.models.find(model => model.runtime === runtime)
    assert.equal(model.fields.some(field => field.key === 'acceleration'), runtime === 'vision')
    if (runtime === 'vision') assert.deepEqual(model.fields.find(field => field.key === 'acceleration').choices.map(choice => choice.value), ['cpu', 'gpu', 'cuda'])
    assert.equal((await linux.execute('configure', { modelId: model.id, configuration: { ...model.configuration, [runtime === 'vision' ? 'threads' : 'steps']: 6 } })).ok, true)
    assert.equal(linux.saved().models[model.id].acceleration, 'cpu')
  }
  const returned = await open({ stored: linux.saved() })
  assert.equal(returned.bindings.get('vision').configuration.acceleration, 'cpu')
  assert.equal(returned.bindings.get('image').configuration.backend, 'cpu')
  const unavailable = await open({ resources: specifications.filter(spec => spec.kind === 'model' || spec.kind === 'engine' && spec.id !== 'tesseract-wasm' && resourceSupported(spec, 'linux-x64')).map(spec => registered(spec.id)) })
  assert.equal(unavailable.bindings.size, 0)
})

test('unknown native engines stay retained but unavailable on macOS', async () => {
  const model = { ...catalog.models[0], id: 'legacy', resources: ['legacy-engine', 'legacy-model'] }
  const stored = { custom: [{ model, specification: { id: 'legacy-model', kind: 'model', files: [] } }], active: { chat: model.id } }
  const f = await open({ stored, resources: model.resources.map(registered) })
  assert.equal(f.bindings.has('chat'), false)
  const state = await f.execute('status')
  assert.equal(state.models[0].state, 'unsupported')
  assert.match(state.models[0].bindingWarning, /macOS ARM64/)
  assert.ok((await f.execute('activate-model', { modelId: model.id })).error)
  assert.deepEqual(f.saved(), stored)
})

const linux = { platform: 'linux-x64', executionMode: 'isolated' }
const windows = { platform: 'windows-x64', executionMode: 'supervised' }

function assertAcceleration(model, binding, platform, value) {
  const selectable = ['chat', 'vision'].includes(model.runtime) || platform === 'macos-arm64'
  const field = model.fields.find(field => field.key === 'acceleration')
  assert.equal(Boolean(field), selectable)
  assert.equal(model.configuration.acceleration, selectable ? value : undefined)
  assert.equal(binding.configuration.acceleration, selectable ? value : undefined)
  if (selectable) {
    assert.equal(field.choices.find(choice => choice.value === 'gpu').title, platform === 'macos-arm64' ? 'Metal' : 'Vulkan')
    assert.equal(field.choices.some(choice => choice.value === 'cuda'), platform !== 'macos-arm64' && ['chat', 'vision'].includes(model.runtime))
  }
  else assert.equal(model.defaults.acceleration, undefined)
  if (model.runtime === 'image') assert.equal(binding.configuration.backend, platform === 'macos-arm64' ? (value === 'cpu' ? 'cpu' : 'metal') : platform === 'windows-x64' ? 'Vulkan0' : 'CUDA0')
}

for (const runtime of ['image', 'chat', 'vision']) for (const acceleration of ['cpu', 'gpu']) {
  test(`persisted Mac custom ${runtime}/${acceleration} roundtrips all platforms without changing source fields or hidden configuration`, async () => {
    const bornOnMac = platformModel(catalog.models.find(model => model.runtime === runtime), 'macos-arm64')
    const extra = { key: 'customNote', label: '自定义参数', type: 'text', metadata: { keep: true } }
    const model = {
      ...bornOnMac, id: `custom-${runtime}`, custom: true, metadata: { retained: true },
      resources: runtime === 'image' ? [bornOnMac.resources[0], 'custom-image-model'] : bornOnMac.resources,
      fields: [...bornOnMac.fields.map(field => field.key === 'acceleration' ? { ...field, metadata: { keep: 'acceleration' }, choices: field.choices.map(choice => ({ ...choice, metadata: { keep: choice.value } })) } : field), extra],
      defaults: { ...bornOnMac.defaults, customNote: 'initial' },
      ...(runtime === 'image' ? { imageArchitecture: 'checkpoint', imageValidation: { version: 1, kind: 'ldm-header', architecture: 'sd1', sha256: 'a'.repeat(64) }, files: { model: 'model.safetensors' } } : {}),
    }
    const originalCustom = [{ model, specification: runtime === 'image' ? { id: model.resources[1], kind: 'model', files: [{ path: 'model.safetensors', sha256: 'a'.repeat(64) }] } : specifications.find(spec => spec.id === model.resources[1]) }]
    let stored = { custom: structuredClone(originalCustom), active: { [runtime]: model.id }, models: { [model.id]: { ...model.defaults, acceleration, customNote: 'retained', opaque: { keep: true } } } }
    for (const environment of [mac, linux, windows, mac]) {
      const f = await open({ environment, stored })
      assert.equal(f.saves(), 0)
      const current = (await f.execute('status')).models.find(item => item.id === model.id)
      assertAcceleration(current, f.bindings.get(runtime), environment.platform, acceleration)
      assert.deepEqual(current.fields.find(field => field.key === 'customNote'), extra)
      assert.deepEqual(current.metadata, model.metadata)
      const field = current.fields.find(field => field.key === 'acceleration')
      if (field) {
        assert.deepEqual(field.metadata, { keep: 'acceleration' })
        assert.deepEqual(field.choices.find(choice => choice.value === 'gpu').metadata, { keep: 'gpu' })
      }
      assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...current.configuration, customNote: environment.platform } })).ok, true)
      assert.deepEqual(f.saved().custom, originalCustom)
      assert.equal(f.saved().models[model.id].acceleration, acceleration)
      assert.deepEqual(f.saved().models[model.id].opaque, { keep: true })
      assert.equal(f.saved().active[runtime], model.id)
      stored = f.saved()
    }
  })
}

for (const runtime of ['image', 'chat', 'vision']) test(runtime === 'image' ? 'Mac image discovery preserves unknown checkpoint state without creating a model' : `Mac-created custom ${runtime} stores canonical definition and projected defaults separately`, async () => {
  const paths = runtime === 'image' ? ['model.safetensors'] : runtime === 'vision' ? ['model.gguf', 'mmproj.gguf'] : ['model.gguf']
  const repository = `fixture/${runtime}`
  const bytes = Buffer.from(JSON.stringify({ id: repository, sha: '1'.repeat(40), pipeline_tag: runtime === 'image' ? 'text-to-image' : runtime === 'vision' ? 'image-text-to-text' : 'text-generation', siblings: paths.map(rfilename => ({ rfilename, size: 1024, lfs: { sha256: 'a'.repeat(64), size: 1024 } })) }))
  const network = { download: async url => { assert.match(new URL(url).pathname, /^\/api\/models\//); return { id: 'metadata', size: bytes.length } } }
  const localResources = { readBytes: async (_resource, { offset, length }) => ({ data: bytes.subarray(offset, offset + length), eof: offset + length >= bytes.length }), release: async () => {} }
  const f = await open({ network, localResources })
  const inspection = await f.execute('inspect-model', { repository, recipe: runtime })
  assert.equal(inspection.error, undefined)
  const input = { key: inspection.key, selection: { model: paths[0], ...(runtime === 'vision' ? { projector: paths[1] } : {}) }, mode: 'download' }
  if (runtime === 'image') {
    assert.equal(inspection.availability.state, 'unverified')
    await assert.rejects(f.execute('add-model', input), /架构|组件/)
    assert.equal(f.saves(), 0)
    return
  }
  const result = await f.execute('add-model', input)
  assert.equal(result.ok, true)
  const record = f.saved().custom.find(item => item.model.id === result.modelId)
  const template = catalog.models.find(model => model.runtime === runtime)
  assert.deepEqual(record.model.fields, template.fields)
  assert.deepEqual(record.model.defaults, template.defaults)
  assert.equal(record.model.resources[0], template.resources[0])
  assert.equal(f.saved().models[result.modelId].acceleration, runtime === 'image' ? 'gpu' : 'cpu')
  f.resources.push(registered(record.specification.id))
  assert.equal((await f.execute('activate-model', { modelId: result.modelId })).ok, true)
  const created = (await f.execute('status')).models.find(model => model.id === result.modelId)
  assertAcceleration(created, f.bindings.get(runtime), 'macos-arm64', 'cpu')
})

function localChatFile() {
  const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
  const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
  const string = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)])
  const metadata = { 'general.architecture': 'qwen3', 'general.type': 'model', 'qwen3.block_count': 1, 'qwen3.embedding_length': 4, 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': ['a', 'b'] }
  const pairs = Object.entries(metadata).map(([key, value]) => Buffer.concat([string(key), typeof value === 'string' ? Buffer.concat([u32(8), string(value)]) : Array.isArray(value) ? Buffer.concat([u32(9), u32(8), u64(value.length), ...value.map(string)]) : Buffer.concat([u32(4), u32(value)])]))
  const tensors = [['token_embd.weight', [4, 2]], ['output_norm.weight', [4]], ...['attn_norm', 'attn_output', 'ffn_norm', 'ffn_up', 'ffn_down', 'attn_q', 'attn_k', 'attn_v'].map(key => [`blk.0.${key}.weight`, [4, 4]])]
  let offset = 0
  const directory = tensors.map(([name, shape]) => {
    const entry = Buffer.concat([string(name), u32(shape.length), ...shape.map(u64), u32(0), u64(offset)])
    offset += Math.ceil(shape.reduce((a, b) => a * b, 4) / 32) * 32
    return entry
  })
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(pairs.length), ...pairs, ...directory])
  return Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 32) * 32 - header.length + offset)])
}

test('Mac local import also stores the canonical definition while immediately showing CPU/Metal controls', async () => {
  const bytes = localChatFile(), file = { id: 'local-model', name: 'model.gguf', size: bytes.length }
  const localResources = {
    listFiles: async () => [file],
    readBytes: async (_file, { offset, length }) => ({ data: bytes.subarray(offset, offset + length), size: bytes.length, eof: offset + length >= bytes.length }),
    hash: async () => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }),
  }
  const f = await open({ localResources })
  const inspection = await f.execute('inspect-local', { resourceIds: [file.id] })
  assert.equal(inspection.ok, true)
  const result = await f.execute('import-local', { token: inspection.token, recipe: 'chat', selection: { model: file.id } })
  assert.equal(result.ok, true)
  const record = f.saved().custom.find(item => item.model.id === result.modelId)
  const template = catalog.models.find(model => model.runtime === 'chat')
  assert.deepEqual(record.model.fields, template.fields)
  assert.deepEqual(record.model.defaults, template.defaults)
  assert.equal(record.model.resources[0], 'llama-b11747')
  assert.equal(f.saved().models[result.modelId].acceleration, 'cpu')
  f.resources.push(registered(record.specification.id))
  assert.equal((await f.execute('activate-model', { modelId: result.modelId })).ok, true)
  const current = (await f.execute('status')).models.find(model => model.id === result.modelId)
  assertAcceleration(current, f.bindings.get('chat'), 'macos-arm64', 'cpu')
})
