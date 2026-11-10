import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export * from './src/Configuration.jsx'; export * from './src/RuntimeObservation.jsx'; export { ModelDetail } from './src/ModelDetail.jsx'", resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'jsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  plugins: [{ name: 'render-without-styles', setup(build) {
    build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'styles' }))
    build.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'empty' }))
  } }],
})
const require = createRequire(import.meta.url)
const { MantineProvider } = require('@mantine/core')
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports)
const { ModelConfiguration, BudgetPreview, RuntimeObservation, ModelDetail, configurationDraftReducer, configurationDraftState, configurationErrors, observationWarnings, runtimeRecovery } = compiled.exports
const render = (Component, props) => renderToStaticMarkup(React.createElement(MantineProvider, null, React.createElement(Component, props)))
const plain = html => html.replace(/<[^>]*>/g, '')
const GiB = 1024 ** 3
const model = {
  id: 'example', title: 'Example', runtime: 'chat', activeResources: ['engine'], resources: ['engine'], state: 'available', active: true, filesReady: true,
  fields: [
    { key: 'acceleration', label: '加速方式', type: 'select', choices: [{ value: 'cpu', title: 'CPU' }, { value: 'gpu', title: 'Vulkan GPU' }, { value: 'cuda', title: 'CUDA' }] },
    { key: 'threads', label: 'CPU 线程', type: 'number', min: 1, max: 16, step: 1, integer: true },
    { key: 'contextWindow', label: '上下文长度', type: 'number', min: 4096, max: 2000000, step: 1, integer: true },
    { key: 'maxTokens', label: '最大输出', type: 'number', min: 64, max: 2000000, step: 1, integer: true },
  ],
  configuration: { acceleration: 'cuda', threads: 4, contextWindow: 32768, maxTokens: 512 },
  metadata: { inference: { weightBytes: 4 * GiB, kvBytesPerToken: 16384, kvEstimate: 'full-context-f16' } },
  recommendation: { configuration: { acceleration: 'cpu', threads: 2, contextWindow: 4096, maxTokens: 256 }, reasons: ['按当前硬件估算，仍可修改。'] },
}
const hardware = { logicalCores: 8, totalMemoryBytes: 16 * GiB, availableMemoryBytes: 8 * GiB, gpus: [{ name: 'Unmapped GPU name', vendor: 'nvidia', totalMemoryBytes: 8 * GiB, availableMemoryBytes: 6 * GiB }] }
const initial = () => ({ draft: null, saved: null, saving: false, error: '' })

test('draft remains explicit across polling, failure and delayed success without overwriting later edits', () => {
  const draft = { ...model.configuration, maxTokens: 1024 }
  let editing = configurationDraftReducer(initial(), { type: 'edit', draft })
  const polled = { ...model, configuration: { ...model.configuration, threads: 8 } }
  assert.equal(configurationDraftState(editing, polled.configuration).draft, draft)
  editing = configurationDraftReducer(editing, { type: 'saving' })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted: draft, ok: false })
  assert.equal(editing.draft, draft)
  assert.equal(editing.saving, false)
  assert.match(editing.error, /草稿已保留/)
  const newer = { ...draft, contextWindow: 65536 }
  editing = configurationDraftReducer(editing, { type: 'edit', draft: newer })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted: draft, ok: true })
  assert.equal(editing.draft, newer)
  assert.equal(configurationDraftState(editing, polled.configuration).saved, draft)
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...draft } })
  assert.equal(editing.saved, null)
  assert.equal(editing.draft, newer)
  assert.equal(configurationDraftState(editing, draft).dirty, true)
  editing = configurationDraftReducer(editing, { type: 'saved', submitted: newer, ok: true })
  assert.equal(configurationDraftState(editing, polled.configuration).draft, newer)
  assert.equal(configurationDraftState(editing, polled.configuration).dirty, false)
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...newer } })
  const external = { ...newer, threads: 6 }
  assert.equal(configurationDraftState(editing, external).draft, external)
  assert.equal(editing.error, '')
})

test('successful saves retain their baseline across failed refresh and stale polls when editing another field', () => {
  const old = { ...model.configuration, contextWindow: 4096 }
  const submitted = { ...old, contextWindow: 32768 }
  let editing = configurationDraftReducer(initial(), { type: 'edit', draft: submitted })
  editing = configurationDraftReducer(editing, { type: 'saving' })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted, ok: true })
  assert.equal(editing.saving, false)
  assert.deepEqual(configurationDraftState(editing, old), { saved: submitted, draft: submitted, dirty: false })
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...old } })
  assert.equal(configurationDraftState(editing, old).draft.contextWindow, 32768)
  const next = { ...configurationDraftState(editing, old).draft, threads: 8 }
  editing = configurationDraftReducer(editing, { type: 'edit', draft: next })
  assert.equal(configurationDraftState(editing, old).dirty, true)
  assert.deepEqual(configurationDraftState(editing, old).draft, { ...submitted, threads: 8 })
  editing = configurationDraftReducer(editing, { type: 'saving' })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted: next, ok: false })
  assert.equal(editing.saved, submitted)
  assert.equal(editing.draft, next)
  editing = configurationDraftReducer(editing, { type: 'saved', submitted: next, ok: true })
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...submitted } })
  assert.equal(editing.saved, next)
  assert.deepEqual(configurationDraftState(editing, submitted), { saved: next, draft: next, dirty: false })
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...next } })
  assert.equal(editing.saved, null)
  assert.deepEqual(configurationDraftState(editing, next), { saved: next, draft: next, dirty: false })
})

test('an explicit revert during save survives completion and confirmation of the submitted value', () => {
  const old = { ...model.configuration, contextWindow: 4096 }
  const submitted = { ...old, contextWindow: 32768 }
  let editing = configurationDraftReducer(initial(), { type: 'edit', draft: submitted })
  editing = configurationDraftReducer(editing, { type: 'saving' })
  const reverted = { ...old }
  editing = configurationDraftReducer(editing, { type: 'edit', draft: reverted })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted, ok: true })
  assert.deepEqual(configurationDraftState(editing, old), { saved: submitted, draft: reverted, dirty: true })
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { ...submitted } })
  assert.equal(configurationDraftState(editing, submitted).draft, reverted)
  assert.equal(configurationDraftState(editing, submitted).dirty, true)
})

test('confirmation compares field values rather than object identity or key order and uses normalized submitted values', () => {
  const submitted = { language: ' en ', threads: 4 }
  const configuration = { language: 'en', threads: 4 }
  let editing = configurationDraftReducer(initial(), { type: 'edit', draft: submitted })
  editing = configurationDraftReducer(editing, { type: 'saved', submitted, configuration, ok: true })
  assert.equal(configurationDraftState(editing, { language: 'zh', threads: 4 }).draft, configuration)
  editing = configurationDraftReducer(editing, { type: 'confirmed', configuration: { threads: 4, language: 'en' } })
  assert.equal(editing.saved, null)
  const changed = { language: 'fr', threads: 2 }
  assert.equal(configurationDraftState(editing, changed).draft, changed)
})

test('recommendations do not replace saved fields on render and advanced parameters start collapsed', () => {
  const html = render(ModelConfiguration, { model, hardware, disabled: false, run: async () => true })
  assert.match(html, /使用推荐值/)
  assert.match(html, /只替换本地草稿，仍须保存/)
  assert.match(html, /value="32768"/)
  assert.match(html, /value="512"/)
  assert.match(html, /<details class="configuration-advanced"><summary>高级参数<\/summary>/)
  const advanced = html.match(/<details class="configuration-advanced">([\s\S]*?)<\/details>/)?.[1] ?? ''
  assert.match(advanced, /CPU 线程/)
  assert.doesNotMatch(advanced, /上下文长度|最大输出|加速方式/)
  assert.match(html, /包括输入、输出和对话模板/)
  assert.match(html, /单次生成的输出上限/)
  assert.match(html, /<details class="configuration-notes"><summary>推荐依据<\/summary>/)
  assert.match(html, /<details class="configuration-notes"><summary>估算说明<\/summary>/)
  const other = render(ModelConfiguration, { model: { ...model, runtime: 'image' }, disabled: false, run: async () => true })
  assert.doesNotMatch(other, /configuration-advanced|运行预算预检|使用推荐值/)
  assert.match(other, /CPU 线程/)
})

test('only field contracts reject configuration; large contexts remain valid and no companion value is changed', () => {
  const draft = { ...model.configuration, contextWindow: 2000000, maxTokens: 128 }
  assert.deepEqual(configurationErrors(model, draft), {})
  assert.deepEqual(draft, { acceleration: 'cuda', threads: 4, contextWindow: 2000000, maxTokens: 128 })
  assert.match(configurationErrors(model, { ...draft, threads: NaN }).threads, /整数/)
  assert.match(configurationErrors(model, { ...draft, maxTokens: 2000001 }).maxTokens, /不会自动调整/)
  assert.match(configurationErrors(model, { ...draft, acceleration: 'automatic' }).acceleration, /有效/)
  assert.deepEqual(configurationErrors(model, { ...draft, acceleration: 'gpu' }), {})
})

test('budget separates weight, KV and safety reserve and reports risk without field validation failure', () => {
  const html = plain(render(BudgetPreview, { model, draft: model.configuration, hardware }))
  assert.match(html, /权重4.00 GiB/)
  assert.match(html, /KV 缓存512.0 MiB/)
  assert.match(html, /估算占用4.50 GiB/)
  assert.match(html, /安全预留819.2 MiB/)
  assert.match(html, /扣除预留后余量716.8 MiB/)
  const draft = { ...model.configuration, contextWindow: 2000000 }
  const risky = plain(render(BudgetPreview, { model, draft, hardware }))
  assert.match(risky, /存在风险/)
  assert.match(risky, /风险提示不阻止保存/)
  assert.deepEqual(configurationErrors(model, draft), {})
})

test('old hosts and total-only hardware do not invent available headroom', () => {
  const html = plain(render(BudgetPreview, { model, draft: model.configuration }))
  assert.match(html, /当前宿主未提供硬件信息/)
  assert.match(html, /扣除预留后余量未知/)
  const totalOnly = { ...hardware, gpus: [{ ...hardware.gpus[0], availableMemoryBytes: undefined }] }
  const partial = plain(render(BudgetPreview, { model, draft: model.configuration, hardware: totalOnly }))
  assert.match(partial, /信息不足/)
  assert.match(partial, /扣除预留后余量未知/)
  assert.match(partial, /容量上界/)
  const loaded = plain(render(BudgetPreview, { model: { ...model, state: 'idle' }, draft: model.configuration, hardware }))
  assert.match(loaded, /模型已在运行或加载/)
  assert.match(loaded, /扣除预留后余量未知/)
  assert.doesNotMatch(loaded, /存在风险/)
})

test('saved CUDA choice does not establish actual GPU use and device indices are not hardware names', () => {
  const empty = plain(render(RuntimeObservation, { model }))
  assert.match(empty, /已保存的选择：CUDA/)
  assert.match(empty, /尚未获得运行数据/)
  const observed = { ...model, runtimeObservation: { backend: { requested: 'cuda', observed: [] }, device: [], context: { requested: 32768 } } }
  const partial = plain(render(RuntimeObservation, { model: observed }))
  assert.match(partial, /观测后端尚未观测到/)
  assert.match(partial, /GPU 层卸载未知/)
  assert.match(partial, /实际上下文未知/)
  observed.runtimeObservation.device = [{ backend: 'cuda', index: 0 }, { backend: 'vulkan', index: 1 }]
  const devices = plain(render(RuntimeObservation, { model: observed, hardware }))
  assert.match(devices, /CUDA0 \/ Vulkan1/)
  assert.doesNotMatch(devices, /Unmapped GPU name/)
})

test('actual context mismatch, partial GPU layers and CPU fallback remain explicit', () => {
  const observed = { ...model, runtimeObservation: { backend: { requested: 'cuda', observed: ['cuda'] }, offload: { layers: 20, total: 33 }, context: { requested: 32768, actual: 4096, train: 131072 }, timings: { decode: { tokens: 64, ms: 2000, tokensPerSecond: 32 } }, loadMs: 1234 } }
  const html = plain(render(RuntimeObservation, { model: observed }))
  assert.match(html, /20\/33 层在 GPU/)
  assert.match(html, /CPU \/ GPU 混合运行/)
  assert.match(html, /实际上下文 4,096 tokens 与已保存配置 32,768 tokens 不一致/)
  assert.match(html, /输出生成32 tokens\/s/)
  assert.match(html, /训练上下文131,072 tokens/)
  const fallback = { ...observed, runtimeObservation: { ...observed.runtimeObservation, offload: { layers: 0, total: 33 } } }
  assert.ok(observationWarnings(fallback).some(value => value.includes('CPU 回退')))
  const full = plain(render(RuntimeObservation, { model: { ...observed, runtimeObservation: { offload: { layers: 33, total: 33 } } } }))
  assert.match(full, /33\/33 层在 GPU/)
  assert.match(full, /全层卸载也不表示所有运算都在 GPU/)
})

test('failure recovery gives parameter and engine routes without automatic execution', () => {
  const failed = { ...model, runtimeObservation: { error: 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED' } }
  const specs = [{ id: 'engine', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b200', backend: 'cuda' }]
  const html = plain(render(ModelDetail, { model: failed, state: { supported: true, models: [failed], resources: [{ id: 'engine', authorized: true }], environment: { hardware } }, specifications: specs, manager: { pending: false, isPending: () => false } }))
  assert.match(html, /修改运行参数/)
  assert.match(html, /管理推理引擎/)
  assert.match(html, /这些入口不会自动修改配置或重新运行模型/)
  assert.match(html, /缩短输出上限不一定减少/)
  assert.match(runtimeRecovery('EXTENSION_INFERENCE_ENGINE_TOO_OLD'), /仅减少上下文通常无法修复/)
  assert.match(runtimeRecovery('EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE'), /驱动与引擎后端/)
})
