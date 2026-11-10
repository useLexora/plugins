import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchConfiguration, initialize } from '../chat.mjs'
import { createTransport } from '../transport.mjs'
import { classifyEngineFailure, checkEngineVersion } from '../errors.mjs'
import { createEngineDiagnostics, safeTimings } from '../diagnostics.mjs'

for (const platform of ['linux', 'win32', 'darwin']) test(`${platform} delegates GPU sizing, fit and attention to the engine; CPU stays CPU`, () => {
  const input = { resources: { engine: '/authorized/engine', model: '/authorized/model' }, configuration: { backend: 'vision', contextWindow: 8192, threads: 8 } }
  for (const engineBackend of ['cpu', 'cuda', 'vulkan', 'metal', undefined]) {
    const launch = launchConfiguration({ ...input, configuration: { ...input.configuration, engineBackend } }, createTransport('/test.sock', platform), platform)
    assert.equal(launch.options.cwd, input.resources.engine)
    assert.equal(launch.args.includes('-fa'), false)
    assert.equal(launch.args.includes('--fit'), false)
    assert.equal(launch.args.includes('-ngl'), engineBackend === 'cpu')
    assert.equal(launch.args.includes('--no-mmproj-offload'), engineBackend === 'cpu')
    assert.equal(launch.args[launch.args.indexOf('-c') + 1], '8192')
    assert.equal(launch.args[launch.args.indexOf('-t') + 1], '8')
    const cpu = launchConfiguration({ ...input, configuration: { ...input.configuration, acceleration: 'cpu', engineBackend } }, createTransport('/test.sock', platform), platform)
    assert.equal(cpu.args[cpu.args.indexOf('-ngl') + 1], '0')
    assert.equal(cpu.args[cpu.args.indexOf('--device') + 1], 'none')
    assert.ok(cpu.args.includes('--no-mmproj-offload'))
  }
})

test('known trace-only builds report devices without changing GPU allocation or user context', () => {
  for (const version of ['b11747', 'b12211', 'b12212', 'custom', undefined]) {
    const input = { resources: { engine: '/engine', model: '/model' }, configuration: { engineVersion: version, engineBackend: 'cuda', contextWindow: 65536 } }
    const { args } = launchConfiguration(input, createTransport('/fixture.sock'))
    assert.equal(args.includes('-lv'), version === 'b12211' || version === 'b12212')
    if (args.includes('-lv')) assert.equal(args[args.indexOf('-lv') + 1], '4')
    assert.equal(args.includes('-ngl'), false)
    assert.equal(args.includes('--fit'), false)
    assert.equal(args[args.indexOf('-c') + 1], '65536')
  }
})

test('context observations distinguish requested, allocated and trained capacities', () => {
  const diagnostics = createEngineDiagnostics({ contextWindow: 65536 })
  assert.deepEqual(diagnostics.snapshot().context, { requested: 65536 })
  diagnostics.observe(Buffer.from('0.00.123 I print_info: n_ctx_train = 262144\n0.00.456 I llama_context: n_ctx = 32768\nllama_context: n_ctx_seq (32768) < n_ctx_train (262144)\nprivate prompt n_ctx = 42\n'))
  assert.deepEqual(diagnostics.snapshot().context, { requested: 65536, actual: 32768, train: 262144 })
  diagnostics.observe(Buffer.from('llama_context: n_ctx = 99999999999999999\nprint_info: n_ctx_train = 0\n'))
  assert.deepEqual(diagnostics.snapshot().context, { requested: 65536, actual: 32768, train: 262144 })
  assert.equal(createEngineDiagnostics({ contextWindow: Infinity }).snapshot().context, undefined)
})

test('llama build metadata rejects known older engines, not unknown version schemes', () => {
  assert.throws(() => checkEngineVersion({ engineVersion: 'b999', minimumEngineVersion: 'b1000' }), /^Error: EXTENSION_INFERENCE_ENGINE_TOO_OLD$/)
  for (const configuration of [{}, { minimumEngineVersion: 'b1000' }, { engineVersion: 'custom', minimumEngineVersion: 'b1000' }, { engineVersion: 'b1000', minimumEngineVersion: 'b1000' }, { engineVersion: 'b1001', minimumEngineVersion: 'b1000' }]) checkEngineVersion(configuration)
  assert.throws(() => launchConfiguration({ configuration: { engineVersion: 'b999', minimumEngineVersion: 'b1000' }, resources: {} }, createTransport('/fixture')), /ENGINE_TOO_OLD/)
})

for (const [detail, code] of [
  ['unknown model architecture: future', 'MODEL_ARCHITECTURE_UNSUPPORTED'],
  ['model architecture is not supported', 'MODEL_ARCHITECTURE_UNSUPPORTED'],
  ['unsupported quantization type Q_NEW', 'MODEL_QUANTIZATION_UNSUPPORTED'],
  ['unknown tensor type: 999', 'MODEL_QUANTIZATION_UNSUPPORTED'],
  ['std::bad_alloc', 'RESOURCE_EXHAUSTED'],
  ['VK_ERROR_OUT_OF_DEVICE_MEMORY', 'RESOURCE_EXHAUSTED'],
  ['CUDA_ERROR_OUT_OF_MEMORY', 'RESOURCE_EXHAUSTED'],
  ['CUDA driver version is insufficient for CUDA runtime version', 'DRIVER_INCOMPATIBLE'],
  ['VK_ERROR_INCOMPATIBLE_DRIVER', 'DRIVER_INCOMPATIBLE'],
  ['no kernel image is available for execution on the device', 'DRIVER_INCOMPATIBLE'],
  ['failed to initialize Metal', 'BACKEND_UNAVAILABLE'],
  ['libcuda.so.1: cannot open shared object file', 'BACKEND_UNAVAILABLE'],
  ['no Vulkan devices found', 'BACKEND_UNAVAILABLE'],
  ['failed to load model /secret/path token=secret', 'LOAD_FAILED'],
]) test(`engine failure classification ${detail.split(' ').slice(0, 3).join(' ')}`, () => {
  assert.equal(classifyEngineFailure(detail), `EXTENSION_INFERENCE_${code}`)
})

test('bounded fragmented diagnostics only retain safe engine/device/offload/timing fields', () => {
  const diagnostics = createEngineDiagnostics({ engineVersion: 'b8498', engineBackend: 'vulkan', architecture: 'qwen35', files: { model: '/secret/model.gguf' }, token: 'secret' })
  const lines = 'llama_model_load: using device Vulkan0 (private GPU name)\nload_tensors: offloaded 12/24 layers to GPU\nprompt eval time = 120.50 ms / 5 tokens (24.10 ms per token, 41.49 tokens per second)\neval time = 80.00 ms / 4 runs (20 ms per token, 50 tokens per second)\nprivate prompt Bearer secret /secret/model.gguf\n'
  const bytes = Buffer.from(lines)
  for (let index = 0; index < bytes.length; index += 3) diagnostics.observe(bytes.subarray(index, index + 3))
  const value = diagnostics.snapshot()
  assert.deepEqual(value, { engine: { name: 'llama.cpp', version: 'b8498' }, backend: { requested: 'vulkan', observed: ['vulkan'] }, device: [{ backend: 'vulkan', index: 0 }], architecture: 'qwen35', offload: { layers: 12, total: 24 }, degraded: false, timings: { prompt: { ms: 120.5, tokens: 5, tokensPerSecond: 41.49 }, decode: { ms: 80, tokens: 4, tokensPerSecond: 50 } } })
  diagnostics.observe(Buffer.from('private prompt'.repeat(10000) + '\n'))
  assert.deepEqual(diagnostics.snapshot(), value)
  diagnostics.observe(Buffer.from('load_tensors: offloaded 0/24 layers to GPU\n'))
  assert.equal(diagnostics.snapshot().degraded, true)
  assert.deepEqual(diagnostics.snapshot().backend.observed, ['vulkan', 'cpu'])
  diagnostics.beginRequest()
  assert.deepEqual(diagnostics.snapshot().timings, {})
  diagnostics.observe(Buffer.from('unknown model archite'))
  diagnostics.observe(Buffer.from('cture: private-model'))
  diagnostics.flush()
  assert.equal(diagnostics.failure(), 'EXTENSION_INFERENCE_MODEL_ARCHITECTURE_UNSUPPORTED')
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|secret|Bearer|prompt.*model/)
  diagnostics.beginRequest()
  assert.equal(diagnostics.failure('EXTENSION_INFERENCE_REQUEST_REJECTED'), 'EXTENSION_INFERENCE_REQUEST_REJECTED')
})

test('unobserved backends stay unknown and unsafe timing metadata is rejected', () => {
  const diagnostics = createEngineDiagnostics({ engineVersion: '/secret/version', engineBackend: '/private/backend', architecture: '/private/model' })
  assert.deepEqual(diagnostics.snapshot(), { engine: { name: 'llama.cpp' }, backend: { requested: 'unknown', observed: [] }, device: [], timings: {} })
  assert.deepEqual(safeTimings({ prompt_n: 'secret', prompt_ms: Infinity, predicted_n: -1, predicted_ms: 12, predicted_per_second: 0, prompt: '/secret/prompt', path: '/private/path' }), { decode: { ms: 12, tokensPerSecond: 0 } })
})

async function fixture(t, model) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-engine-test-'))
  let runtime
  t.after(async () => { try { await runtime?.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  const executable = join(directory, 'llama-server')
  await copyFile(new URL('./fixtures/llama-server.cjs', import.meta.url), executable)
  await chmod(executable, 0o700)
  const records = []
  t.mock.method(process.stderr, 'write', line => { records.push(String(line)); return true })
  const load = async () => { runtime = await initialize({ resources: { engine: directory, model: directory }, configuration: { files: { model }, engineBackend: 'vulkan', engineVersion: 'b8498', architecture: 'qwen35', chatReasoning: true } }); return runtime }
  return { directory, load, records }
}

const linux = { skip: process.platform !== 'linux', timeout: 10000 }
for (const [name, code] of [['architecture', 'MODEL_ARCHITECTURE_UNSUPPORTED'], ['quantization', 'MODEL_QUANTIZATION_UNSUPPORTED'], ['memory', 'RESOURCE_EXHAUSTED'], ['driver', 'DRIVER_INCOMPATIBLE'], ['backend', 'BACKEND_UNAVAILABLE']]) test(`actual engine process startup maps ${name} failure and drains without leaking stderr`, linux, async t => {
  const f = await fixture(t, `failure-${name}.gguf`)
  await assert.rejects(f.load(), { message: `EXTENSION_INFERENCE_${code}` })
  const [{ pid }] = (await readFile(join(f.directory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const records = f.records.map(line => JSON.parse(line))
  assert.ok(records.some(item => item.event === 'chat.gpu.exit' && item.error === `EXTENSION_INFERENCE_${code}`))
  assert.doesNotMatch(f.records.join(''), /private|secret|failure-|\.gguf/)
})

test('actual local protocol logs load/backend/offload/timings without prompt and keeps the server after HTTP OOM', linux, async t => {
  const f = await fixture(t, 'diagnostics.gguf')
  const runtime = await f.load()
  const invoke = async text => {
    const events = []
    const session = runtime.start('chat', {}, { signal: new AbortController().signal, emit: event => { events.push(event); return true } })
    session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text }], tools: [], maxTokens: 32, reasoning: 'medium' })))
    await session.finish()
    return events
  }
  await assert.rejects(invoke('__oom__'), /EXTENSION_INFERENCE_RESOURCE_EXHAUSTED/)
  assert.deepEqual(await invoke('__tagged__ secret prompt'), [{ type: 'thinking', text: '分析' }, { type: 'text', text: 'answer <think>literal</think>' }, { type: 'done', reason: 'stop', usage: { input: 3, output: 4, cacheRead: 0 } }])
  const records = f.records.map(line => JSON.parse(line))
  const ready = records.find(item => item.event === 'chat.gpu.ready')
  assert.ok(ready.loadMs >= 0)
  assert.deepEqual(ready.engine, { name: 'llama.cpp', version: 'b8498' })
  assert.deepEqual(ready.offload, { layers: 12, total: 24 })
  const timing = records.find(item => item.event === 'chat.gpu.timings')
  assert.deepEqual(timing.prompt, { tokens: 3, ms: 51 })
  assert.deepEqual(timing.decode, { tokens: 4, ms: 12 })
  assert.doesNotMatch(f.records.join(''), /secret|private|diagnostics\.gguf|__tagged__/)
  assert.ok(f.records.every(line => Buffer.byteLength(line) < 8192))
  const starts = (await readFile(join(f.directory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(item => item.type === 'start')
  assert.equal(starts.length, 1)
})
