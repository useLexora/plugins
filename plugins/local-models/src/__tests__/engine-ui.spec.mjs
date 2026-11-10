import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { Engines, enginePreview } from './src/Engines.jsx'; export { ModelDetail } from './src/ModelDetail.jsx'; export { Fields } from './src/Configuration.jsx'", resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'jsx' },
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
const { Engines, enginePreview, ModelDetail, Fields } = compiled.exports
const render = (Component, props) => renderToStaticMarkup(React.createElement(MantineProvider, null, React.createElement(Component, props)))
const buttons = html => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [])
const button = (html, label) => buttons(html).find(value => value.replace(/<[^>]*>/g, '') === label)
const specs = [
  { id: 'old', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b100', backend: 'vulkan', legacy: true },
  { id: 'new', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b200', backend: 'vulkan', requirements: ['需要兼容的 Vulkan 驱动'] },
  { id: 'weights', kind: 'model', title: 'Example', files: [{ path: 'example.gguf' }] },
]
const model = { id: 'example', title: 'Example', runtime: 'chat', activeResources: ['old', 'weights'], resources: ['old', 'weights'], fields: [], configuration: {}, state: 'available', filesReady: true, filesRegistered: true, prepared: true }
const state = { supported: true, models: [model], resources: specs.map(spec => ({ id: spec.id, authorized: true })), engines: specs.filter(spec => spec.kind === 'engine').map(spec => ({ ...spec, installed: true, selected: spec.id === 'new', capabilities: ['对话'] })) }
const manager = { pending: false, isPending: () => false }

test('engine UI offers retained-version activation and blocks all family changes during runtime use', () => {
  const props = { state, specifications: specs, manager, selected: 'old' }
  const html = render(Engines, props)
  assert.equal((html.match(/<h3>/g) ?? []).length, 1)
  assert.match(button(html, '管理版本'), /aria-expanded="true"/)
  assert.match(button(html, '管理版本'), /aria-controls=/)
  const current = render(Engines, { ...props, selected: 'new' })
  assert.match(current, /需要兼容的 Vulkan 驱动/)
  assert.match(button(current, '当前选择'), /disabled/)
  assert.ok(button(html, '使用此版本'))
  assert.doesNotMatch(button(html, '使用此版本'), /disabled/)
  const busy = render(Engines, { ...props, state: { ...state, models: [{ ...model, runtimeBusy: true }] } })
  assert.match(button(busy, '使用此版本'), /disabled/)
  const cancelling = render(Engines, { ...props, state: { ...state, job: { resourceId: 'new', state: 'cancelling', mode: 'download' } } })
  assert.match(button(cancelling, '取消安装'), /disabled/)
  assert.match(button(cancelling, '使用此版本'), /disabled/)
})

test('engine hierarchy nests backend version lists under one family and distinguishes selection from execution', () => {
  const cuda = { id: 'cuda', kind: 'engine', engineId: 'llama.cpp', version: 'b200', backend: 'cuda', prerelease: true, requirements: ['CUDA driver required'] }
  const html = render(Engines, { state: { ...state, engines: [...state.engines, { ...cuda, installed: false, capabilities: ['图片理解'] }] }, specifications: [...specs, cuda], manager })
  assert.equal((html.match(/<h3>llama\.cpp<\/h3>/g) ?? []).length, 1)
  assert.match(html, /<h4>Vulkan<\/h4>/)
  assert.match(html, /<h4>CUDA<\/h4>/)
  assert.match(html, /对话 \/ 图片理解/)
  assert.match(html, /当前版本<\/span><strong>b200<\/strong>/)
  assert.ok(button(html, '安装'))
  assert.doesNotMatch(html, />未安装<|>预发布<|版本与状态|<table|>旧版<|>使用中</)
  const confirmation = render(Engines, { state: { ...state, engines: [...state.engines, { ...cuda, installed: false }] }, specifications: [...specs, cuda], manager, selected: 'cuda' })
  assert.match(confirmation, /此版本是上游预发布构建/)
  assert.match(confirmation, /CUDA driver required/)
  assert.match(confirmation, /安装不会切换已有的版本选择/)
  assert.ok(button(confirmation, '安装此版本'))
  const installed = { ...cuda, installed: true, selected: false }
  const afterInstall = render(Engines, { state: { ...state, engines: [installed] }, specifications: [cuda], manager, selected: 'cuda' })
  assert.match(afterInstall, /b200（预发布）/)
  assert.ok(button(afterInstall, '使用此版本'))
  assert.equal(button(afterInstall, '安装此版本'), undefined)
})

test('custom engines retain a traceable file identity and recover authorization without a download action', () => {
  const custom = { id: 'llama-custom-0123456789abcdef', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', custom: true, backend: 'vulkan', files: [{ path: 'llama-server' }] }
  const html = render(Engines, { state: { ...state, resources: [{ id: custom.id, authorized: false }], engines: [{ ...custom, installed: false, selected: true }] }, specifications: [custom], manager, selected: custom.id })
  assert.match(html, /01234567/)
  assert.match(html, /需重新授权/)
  assert.ok(button(html, '重新授权文件'))
  assert.equal(button(html, '安装'), undefined)
  assert.equal(button(html, '使用此版本'), undefined)
  assert.doesNotMatch(html, /版本未知|随插件提供|已验证/)
})

test('engine overview preserves current and installed versions rather than presenting a new download as current', () => {
  const current = { id: 'current', installed: true, selected: true }
  const installed = { id: 'retained', installed: true }
  const available = { id: 'new', installed: false }
  assert.equal(enginePreview({ versions: [available, installed, current] }, state), current)
  assert.equal(enginePreview({ versions: [available, installed] }, state), installed)
  const unauthorized = { id: 'custom', selected: true, installed: false, custom: true }
  assert.equal(enginePreview({ versions: [available, unauthorized] }, { resources: [{ id: 'custom', authorized: false }] }), unauthorized)
})

test('model detail keeps the actual engine in collapsed environment details and compatibility feedback actionable', () => {
  const warning = '该模型要求更新的 llama.cpp 版本。'
  const html = render(ModelDetail, { model: { ...model, prepared: false, compatibilityWarning: warning }, state, specifications: specs, manager })
  assert.match(html, /<details class="runtime-environment">/)
  assert.match(html, /<summary>运行环境<\/summary>/)
  assert.match(html, /b100/)
  assert.doesNotMatch(html, /b200/)
  assert.ok(html.includes(warning))
  assert.ok(button(html, '检查引擎'))
  assert.equal(button(html, '启用模型'), undefined)
  assert.ok(button(html, '重新选择文件'))
  assert.ok(button(html, '清理模型文件'))
})

test('configuration renders platform-supplied acceleration choices with associated field labels', () => {
  const html = render(Fields, { fields: [{ key: 'acceleration', label: '加速方式', type: 'select', choices: [{ value: 'cpu', title: 'CPU' }, { value: 'cuda', title: 'CUDA' }] }], draft: { acceleration: 'cuda' }, setDraft: () => {}, disabled: true })
  const label = html.match(/<label id="([^"]+)" for="([^"]+)">加速方式<\/label>/)
  assert.ok(label)
  const select = button(html, 'CUDA')
  assert.ok(select.includes(`aria-labelledby="${label[1]}"`))
  assert.ok(select.includes(`id="${label[2]}"`))
  assert.match(select, /disabled/)
})
