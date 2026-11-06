import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { activateManager } from '../manager.js'
import { inferenceEnvironment } from '../platform.js'

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await readFile(new URL('../resources.json', import.meta.url)))
const manifest = JSON.parse(await readFile(new URL('../extension.json', import.meta.url)))
const registered = id => ({ id, authorized: true, revision: 'fixture' })
const windows = { platform: 'windows-x64', executionMode: 'supervised' }

async function open({ environment = windows, stored, resources = specifications.map(spec => registered(spec.id)) } = {}) {
  const commands = new Map(), bindings = new Map(), prepared = []
  let saved = structuredClone(stored), saves = 0
  await activateManager({
    signal: new AbortController().signal,
    subscriptions: { add() {} },
    storage: { get: async () => saved, set: async value => { saved = structuredClone(value); saves++ } },
    commands: { register: (id, handler) => commands.set(id, handler) },
    views: { broadcast: async () => {} },
    inference: {
      capabilities: { nativeRuntime: true, runtimeIsolation: true, chatImageInput: true, chatToolMatching: true },
      environment: async () => environment,
      resources: { list: async () => resources, prepare: async spec => { prepared.push(spec); return registered(spec.id) } },
      bind: async value => bindings.set(value.runtime, value),
      status: async () => [...bindings.keys()].map(runtime => ({ runtime, configured: true, instances: [] })),
      credentials: { has: async () => false },
    },
  }, { manifest, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  return { bindings, prepared, saved: () => saved, saves: () => saves, execute: (name, input) => commands.get(`${manifest.id}.${name}`)({ arguments: input }) }
}

test('environment uses native platform, fails closed on unsupported targets and retains legacy Linux contract', async () => {
  for (const value of [windows, { platform: 'linux-x64', executionMode: 'isolated' }]) assert.deepEqual(await inferenceEnvironment({ capabilities: { nativeRuntime: true }, environment: async () => value }), value)
  for (const value of [{ platform: 'windows-arm64', executionMode: 'supervised' }, { platform: 'linux-x64', executionMode: 'supervised' }, { platform: null, executionMode: 'unsupported' }]) assert.equal((await inferenceEnvironment({ capabilities: { nativeRuntime: true, runtimeIsolation: true }, environment: async () => value })).executionMode, 'unsupported')
  assert.equal((await inferenceEnvironment({ capabilities: { nativeRuntime: true, runtimeIsolation: true } })).executionMode, 'unsupported')
  assert.deepEqual(await inferenceEnvironment({ capabilities: { runtimeIsolation: true }, environment: async () => windows }), { platform: 'linux-x64', executionMode: 'isolated' })
})

test('Windows selects pinned x64 engines, CPU vision, WASM OCR and no Linux library paths', async () => {
  const f = await open()
  assert.equal(f.saves(), 0)
  const state = await f.execute('status')
  assert.deepEqual(state.environment, windows)
  assert.deepEqual(state.engines.map(item => item.id).sort(), ['image-vulkan-windows-x64', 'llama-b11747-windows-x64', 'sherpa-onnx-windows-x64', 'tesseract-wasm'])
  for (const [runtime, engine] of [['chat', 'llama-b11747-windows-x64'], ['vision', 'llama-b11747-windows-x64'], ['asr', 'sherpa-onnx-windows-x64'], ['tts', 'sherpa-onnx-windows-x64'], ['image', 'image-vulkan-windows-x64'], ['ocr', 'tesseract-wasm']]) {
    const binding = f.bindings.get(runtime)
    assert.equal(binding.resources[0].id, engine)
    assert.equal(binding.libraryPaths, undefined)
    if (runtime === 'chat' || runtime === 'vision') assert.equal(binding.configuration.acceleration, 'cpu')
  }
  assert.equal(f.bindings.get('vision').models[0].id, 'qwen3-vl')
  assert.equal(f.bindings.get('vision').imageReaders[0].id, 'qwen3-vl')
  assert.equal(f.bindings.get('image').configuration.backend, 'Vulkan0')
  assert.equal(f.bindings.get('ocr').configuration.ocrEngine, 'wasm')
  assert.ok((await f.execute('prepare', { resourceId: 'llama-b11747', mode: 'download' })).error)
  assert.equal((await f.execute('prepare', { resourceId: 'llama-b11747-windows-x64', mode: 'download' })).ok, true)
  assert.match(f.prepared[0].preparation.inputs[0].source.url, /win-vulkan-x64\.zip$/)
})

test('existing models, IDs, history and configuration survive Windows platform projection without storage migration', async () => {
  const model = { ...catalog.models[0], id: 'existing', custom: true }
  const stored = { custom: [{ model, specification: specifications.find(item => item.id === model.resources[1]) }], active: { chat: model.id }, models: { [model.id]: { ...model.defaults, threads: 7, contextWindow: 65536 } }, services: { 'speech-api': { enabled: true, configuration: catalog.services[0].defaults } } }
  const f = await open({ stored })
  assert.deepEqual(f.saved(), stored)
  assert.equal(f.saves(), 0)
  assert.equal(f.bindings.get('chat').resources[0].id, 'llama-b11747-windows-x64')
  assert.equal(f.bindings.get('chat').configuration.acceleration, 'gpu')
  assert.equal(f.bindings.get('chat').configuration.contextWindow, 65536)
  assert.ok(f.bindings.has('speech-api'))
  assert.equal((await f.execute('configure', { modelId: model.id, configuration: { ...stored.models[model.id], threads: 5 } })).ok, true)
  assert.deepEqual(f.saved().custom[0].model.resources, model.resources)
  assert.equal(f.saved().active.chat, 'existing')
})

test('Windows nondefault vision GPU choice survives Linux saves without changing Linux fields or runtime defaults', async () => {
  const acceleration = 'gpu'
  const first = await open()
  const vision = (await first.execute('status')).models.find(model => model.id === 'qwen3-vl')
  assert.equal((await first.execute('configure', { modelId: vision.id, configuration: { ...vision.configuration, acceleration } })).ok, true)
  assert.equal(first.saved().models[vision.id].acceleration, acceleration)

  const linux = await open({ environment: { platform: 'linux-x64', executionMode: 'isolated' }, stored: first.saved() })
  const models = (await linux.execute('status')).models
  const linuxVision = models.find(model => model.id === vision.id)
  const chat = models.find(model => model.id === 'qwen3-4b')
  assert.equal(linuxVision.fields.some(field => field.key === 'acceleration'), false)
  assert.equal(linuxVision.configuration.acceleration, undefined)
  assert.equal(linux.bindings.get('vision').configuration.acceleration, undefined)
  assert.equal((await linux.execute('configure', { modelId: chat.id, configuration: { ...chat.configuration, threads: 7 } })).ok, true)
  assert.equal(linux.saved().models[vision.id].acceleration, acceleration)

  const returned = await open({ stored: linux.saved() })
  assert.equal((await returned.execute('status')).models.find(model => model.id === vision.id).configuration.acceleration, acceleration)
  assert.equal(returned.bindings.get('vision').configuration.acceleration, acceleration)
  assert.equal(returned.saved().models[chat.id].threads, 7)

  assert.equal((await linux.execute('configure', { modelId: vision.id, configuration: { ...linuxVision.configuration, threads: 6 } })).ok, true)
  assert.equal(linux.saved().models[vision.id].acceleration, acceleration)
  assert.equal(linux.bindings.get('vision').configuration.acceleration, undefined)
  const returnedAgain = await open({ stored: linux.saved() })
  assert.equal(returnedAgain.bindings.get('vision').configuration.acceleration, acceleration)
  assert.equal(returnedAgain.bindings.get('vision').configuration.threads, 6)
})

test('Linux retains original engines and Windows-only registrations never satisfy its bindings', async () => {
  const environment = { platform: 'linux-x64', executionMode: 'isolated' }
  const f = await open({ environment })
  for (const model of catalog.models) {
    const selected = await open({ environment, stored: { active: { [model.runtime]: model.id } } })
    assert.deepEqual(selected.bindings.get(model.runtime).resources.map(item => item.id), model.resources)
  }
  assert.deepEqual(f.bindings.get('asr').libraryPaths, [{ mount: 'engine', path: 'node_modules/sherpa-onnx-linux-x64' }])
  assert.equal(f.bindings.get('image').configuration.backend, 'CUDA0')
  const resources = specifications.filter(spec => spec.kind === 'model' || spec.platforms?.includes('windows-x64')).map(spec => registered(spec.id))
  const unavailable = await open({ environment, resources })
  assert.equal(unavailable.bindings.size, 0)
})

test('unknown legacy engine stays visible but cannot run on Windows; API connections remain available', async () => {
  const model = { ...catalog.models[0], id: 'legacy', resources: ['legacy-engine', 'legacy-model'] }
  const stored = { custom: [{ model, specification: { id: 'legacy-model', kind: 'model', files: [] } }], active: { chat: 'legacy' }, services: { 'image-api': { enabled: true, configuration: catalog.services[1].defaults } } }
  const f = await open({ stored, resources: model.resources.map(registered) })
  assert.equal(f.bindings.has('chat'), false)
  assert.equal(f.bindings.has('image-api'), true)
  const state = await f.execute('status')
  assert.equal(state.models[0].state, 'unsupported')
  assert.match(state.models[0].bindingWarning, /Windows x64/)
  assert.ok((await f.execute('activate-model', { modelId: 'legacy' })).error)
  assert.deepEqual(f.saved(), stored)
})
