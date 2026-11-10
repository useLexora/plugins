import assert from 'node:assert/strict'
import test from 'node:test'
import { modelBudget, recommendConfiguration } from '../runtimeGuidance.js'

const GiB = 1024 ** 3
const model = {
  runtime: 'chat',
  fields: [
    { key: 'acceleration', type: 'select', choices: ['cpu', 'gpu', 'cuda'].map(value => ({ value })) },
    { key: 'threads', type: 'number', min: 1, max: 16, integer: true },
    { key: 'contextWindow', type: 'number', min: 4096, max: 2000000, integer: true },
    { key: 'maxTokens', type: 'number', min: 64, max: 2000000, integer: true },
  ],
  defaults: { acceleration: 'cpu', threads: 4, contextWindow: 32768, maxTokens: 512 },
  metadata: { inference: { contextWindow: 131072, weightBytes: 4 * GiB, kvBytesPerToken: 32 * 8 * (128 + 128) * 2, kvEstimate: 'full-context-f16', limitations: [] } },
}
const hardware = { logicalCores: 24, totalMemoryBytes: 32 * GiB, availableMemoryBytes: 24 * GiB, gpus: [] }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
freeze(model)
freeze(hardware)

function noUndefined(value) {
  assert.notEqual(value, undefined)
  if (value && typeof value === 'object') Object.values(value).forEach(noUndefined)
}

test('old models remain usable and absent hardware or metadata produces unknown, not a green estimate', () => {
  const old = { ...model, metadata: {} }
  const suggestion = recommendConfiguration(old, null, 'linux-x64')
  assert.deepEqual(suggestion.configuration, model.defaults)
  for (const result of [modelBudget(old, model.defaults, hardware), modelBudget(model, model.defaults, null)]) {
    assert.equal(result.status, 'unknown')
    noUndefined(result)
  }
  assert.deepEqual(recommendConfiguration({ runtime: 'image' }, hardware, 'linux-x64').configuration, {})
})

test('64K context computes F16 KV once and reserves system/compute capacity separately', () => {
  const configuration = freeze({ ...model.defaults, contextWindow: 65536, maxTokens: 8192 })
  const result = modelBudget(model, configuration, hardware)
  assert.equal(result.scope, 'ram')
  assert.equal(result.kvBytes, 8 * GiB)
  assert.equal(result.weightBytes, 4 * GiB)
  assert.equal(result.estimatedBytes, 12 * GiB)
  assert.equal(result.availableBytes, 24 * GiB)
  assert.ok(result.reserveBytes >= 2 * GiB)
  assert.equal(result.status, 'within-estimate')
  assert.equal(modelBudget(model, { ...configuration, maxTokens: 512 }, hardware).estimatedBytes, result.estimatedBytes)
  assert.match(result.warnings.join(' '), /不含.*缓冲/)
  noUndefined(result)
})

test('memory risk and exceeding native context only warn and never mutate the user configuration', () => {
  const configuration = freeze({ ...model.defaults, contextWindow: 262144, maxTokens: 4096 })
  const before = JSON.stringify(configuration)
  const result = modelBudget(model, configuration, hardware)
  assert.equal(result.status, 'risk')
  assert.match(result.warnings.join(' '), /超过模型声明的原生长度/)
  assert.equal(JSON.stringify(configuration), before)
  assert.equal(configuration.contextWindow, 262144)
})

test('discrete GPU memory is not system RAM and CUDA uses NVIDIA rather than unrelated devices', () => {
  const gpuHardware = { ...hardware, gpus: [{ name: 'GPU', vendor: 'nvidia', totalMemoryBytes: 8 * GiB, availableMemoryBytes: 6 * GiB }] }
  const result = modelBudget(model, { ...model.defaults, acceleration: 'cuda', contextWindow: 65536 }, gpuHardware)
  assert.equal(result.scope, 'vram')
  assert.equal(result.status, 'risk')
  assert.equal(result.availableBytes, 6 * GiB)
  assert.ok(result.reserveBytes >= 0.5 * GiB)
  assert.equal(modelBudget(model, model.defaults, gpuHardware).scope, 'ram')
  for (const gpus of [[], [{ name: 'GPU', vendor: 'nvidia' }], [{ name: 'GPU', vendor: 'amd', availableMemoryBytes: 16 * GiB }]]) {
    const unknown = modelBudget(model, { ...model.defaults, acceleration: 'cuda' }, { ...hardware, gpus })
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.availableBytes, undefined)
  }
})

test('loaded or loading models do not double-charge their allocation against freshly sampled free memory', () => {
  const configuration = freeze({ ...model.defaults, acceleration: 'cuda', contextWindow: 65536 })
  const occupied = { ...hardware, gpus: [{ name: 'GPU', vendor: 'nvidia', totalMemoryBytes: 16 * GiB, availableMemoryBytes: GiB }] }
  for (const state of [{ state: 'idle' }, { state: 'running' }, { state: 'loading' }, { instances: [{ state: 'ready' }] }, { instances: [{ state: 'loading' }] }]) {
    const result = modelBudget({ ...model, ...state }, configuration, occupied)
    assert.equal(result.status, 'unknown')
    assert.equal(result.availableBytes, GiB)
    assert.equal(result.estimatedBytes, 12 * GiB)
    assert.match(result.warnings.join(' '), /已包含已加载模型的占用.*重载前预算需重新检查/)
    assert.doesNotMatch(result.warnings.join(' '), /估算加预留超过/)
  }
  const totalRisk = modelBudget({ ...model, state: 'running' }, { ...configuration, contextWindow: 131072 }, occupied)
  assert.equal(totalRisk.status, 'unknown')
  assert.match(totalRisk.warnings.join(' '), /超过设备总容量/)
  assert.equal(configuration.contextWindow, 65536)
})

test('Apple unified memory is counted only once; multiple discrete GPUs are not pooled', () => {
  const apple = { ...hardware, gpus: [{ name: 'Apple GPU', vendor: 'apple', totalMemoryBytes: 32 * GiB, availableMemoryBytes: 24 * GiB }] }
  const result = modelBudget(model, { ...model.defaults, acceleration: 'gpu' }, apple)
  assert.equal(result.scope, 'unified')
  assert.equal(result.availableBytes, hardware.availableMemoryBytes)
  assert.equal(result.status, 'within-estimate')
  const multi = { ...hardware, gpus: Array.from({ length: 2 }, () => ({ name: 'GPU', vendor: 'amd', availableMemoryBytes: 16 * GiB })) }
  const unknown = modelBudget(model, { ...model.defaults, acceleration: 'gpu' }, multi)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.availableBytes, undefined)
})

test('missing KV, partial KV, vision memory and total-only memory remain unknown', () => {
  for (const inference of [{ weightBytes: 4 * GiB }, { ...model.metadata.inference, kvEstimate: undefined }]) {
    const result = modelBudget({ ...model, metadata: { inference } }, model.defaults, hardware)
    assert.equal(result.status, 'unknown')
    noUndefined(result)
  }
  assert.equal(modelBudget({ ...model, runtime: 'vision' }, model.defaults, hardware).status, 'unknown')
  const result = modelBudget(model, model.defaults, { totalMemoryBytes: 32 * GiB })
  assert.equal(result.status, 'unknown')
  assert.equal(result.availableBytes, 32 * GiB)
  assert.match(result.warnings.join(' '), /容量上界/)
})

test('recommendation follows GPU evidence and engine choices, without promising driver support', () => {
  const nvidia = { ...hardware, gpus: [{ name: 'GPU', vendor: 'nvidia' }] }
  const cuda = recommendConfiguration(model, nvidia, 'linux-x64', ['cpu', 'vulkan', 'cuda'])
  assert.equal(cuda.configuration.acceleration, 'cuda')
  assert.match(cuda.reasons.join(' '), /启动后验证/)
  assert.equal(recommendConfiguration(model, nvidia, 'linux-x64', ['vulkan']).configuration.acceleration, 'gpu')
  for (const vendor of ['amd', 'intel', 'apple', 'unknown']) {
    assert.equal(recommendConfiguration(model, { ...hardware, gpus: [{ name: 'GPU', vendor }] }, vendor === 'apple' ? 'macos-arm64' : 'linux-x64', ['cuda']).configuration.acceleration, 'gpu')
  }
  assert.equal(recommendConfiguration(model, hardware, 'linux-x64', ['cuda']).configuration.acceleration, 'cpu')
  assert.equal(recommendConfiguration(model, {}, 'linux-x64', ['cuda']).configuration.acceleration, model.defaults.acceleration)
})

test('defaults use modest threads and native/budget context while retaining independent output reservation', () => {
  const constrained = { ...model, metadata: { inference: { ...model.metadata.inference, contextWindow: 16384 } } }
  const native = recommendConfiguration(constrained, hardware, 'linux-x64')
  assert.equal(native.configuration.threads, 8)
  assert.equal(native.configuration.contextWindow, 16384)
  assert.equal(native.configuration.maxTokens, 512)
  const nonPreset = { ...model, metadata: { inference: { ...model.metadata.inference, contextWindow: 24576 } } }
  assert.equal(recommendConfiguration(nonPreset, hardware, 'linux-x64').configuration.contextWindow, 16384)
  const budget = recommendConfiguration(model, { ...hardware, totalMemoryBytes: 8 * GiB, availableMemoryBytes: 8 * GiB }, 'linux-x64')
  assert.equal(budget.configuration.contextWindow, 16384)
  assert.equal(budget.configuration.maxTokens, 512)
  const short = recommendConfiguration({ ...model, defaults: { ...model.defaults, contextWindow: 4096, maxTokens: 8192 } }, hardware, 'linux-x64')
  assert.equal(short.configuration.maxTokens, 4096)
  for (const result of [native, budget, short]) {
    assert.ok(result.configuration.maxTokens <= result.configuration.contextWindow)
    assert.ok(Object.keys(result.configuration).every(key => model.fields.some(field => field.key === key)))
    noUndefined(result)
  }
  assert.equal(model.defaults.contextWindow, 32768)
})

test('recommendations honor the declared fields and numeric bounds, not extra default keys', () => {
  const restricted = { ...model, fields: model.fields.filter(field => field.key !== 'acceleration').map(field => field.key === 'threads' ? { ...field, max: 2 } : field), defaults: { ...model.defaults, unrelated: true } }
  const result = recommendConfiguration(restricted, hardware, 'linux-x64')
  assert.deepEqual(Object.keys(result.configuration).sort(), ['contextWindow', 'maxTokens', 'threads'])
  assert.equal(result.configuration.threads, 2)
})
