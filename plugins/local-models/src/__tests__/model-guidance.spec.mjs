import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zImageTurbo } from '../../native/image/recipes.mjs'
import { engineGroups, engineIdentity, engineMutationBlocked, modelGuidance, modelInLibrary } from '../modelPresentation.js'

const specification = id => ({ id, kind: 'model', files: zImageTurbo.files.map(file => ({ ...file })) })
const specifications = [{ id: 'engine', kind: 'engine' }, specification('weights')]
const model = {
  id: 'image', title: 'Image', runtime: 'image', imageArchitecture: zImageTurbo.architecture,
  resources: ['engine', 'weights'], activeResources: ['engine', 'weights'],
  files: Object.fromEntries(zImageTurbo.files.map(file => [file.role, file.path])),
  acquisition: 'import', state: 'missing', filesReady: false, filesRegistered: false,
  prepared: false, active: false, bound: false, bindingWarning: '',
}
const authorized = id => ({ id, revision: 'current', authorized: true })
const available = [authorized('engine'), authorized('weights')]
const stateFor = (current, resources = [], job = null) => ({ models: [current], resources, job, supported: true })
const ready = { ...model, state: 'available', filesReady: true, filesRegistered: true, prepared: true }
const legacy = {
  ...model, id: 'old-fp8', state: 'unverified', imageArchitecture: 'checkpoint',
  resources: ['engine', 'old-weights'], activeResources: ['engine', 'old-weights'],
  files: { model: 'original.safetensors' },
  origin: { source: 'huggingface', repository: 'unsloth/Z-Image-Turbo-FP8', revision: 'a'.repeat(40) },
}

test('recovery shares manager candidate priority and excludes invalid recipes regardless of title', () => {
  const candidate = (id, title) => ({ ...model, id, title, resources: ['engine', `${id}-weights`], activeResources: ['engine', `${id}-weights`] })
  const first = candidate('first', '任意名称甲')
  const second = candidate('second', '任意名称乙')
  const invalid = candidate('invalid', 'Z-Image Turbo · 兼容版')
  const specs = [...specifications, specification('first-weights'), specification('second-weights'), { ...specification('invalid-weights'), files: [] }]
  for (const [activeId, resources, expected] of [
    ['first', [authorized('second-weights')], 'first'],
    ['invalid', [authorized('invalid-weights'), authorized('second-weights')], 'second'],
    [undefined, [authorized('second-weights')], 'second'],
    [undefined, [], 'first'],
  ]) {
    const models = [legacy, invalid, first, second].map(item => ({ ...item, active: item.id === activeId }))
    const guidance = modelGuidance(legacy, { models, resources }, specs)
    assert.equal(guidance.compatibleId, expected)
    assert.equal(guidance.action, 'recover')
    assert.equal(guidance.actionLabel, '打开兼容版')
  }
  assert.equal(modelGuidance(legacy, { models: [legacy, invalid], resources: [] }, specs).actionLabel, '添加兼容版本')
  const unrelated = { ...legacy, origin: undefined, title: 'Z-Image-Turbo-FP8' }
  assert.equal(modelGuidance(unrelated, stateFor(unrelated), specs).action, 'inspect')
})

test('authorization loss is explicit and an available revision supersedes an older unauthorized one', () => {
  const current = { ...model, filesRegistered: true, activeResources: ['engine', 'weights', 'extra'] }
  const specs = [...specifications, { id: 'extra', kind: 'model' }]
  for (const [records, label] of [
    [[{ id: 'weights', authorized: false }], '需重新授权'],
    [[{ id: 'weights' }], '文件状态待确认'],
    [[{ id: 'weights', revision: 'old', authorized: false }, authorized('weights')], '文件状态待确认'],
  ]) {
    const resources = [authorized('engine'), { id: 'extra' }, ...records]
    const guidance = modelGuidance(current, stateFor(current, resources), specs)
    assert.equal(guidance.label, label)
    assert.equal(guidance.action, 'import')
    assert.equal(guidance.actionLabel, '重新选择文件')
    assert.doesNotMatch(guidance.description, /损坏|已丢失/)
    if (label !== '需重新授权') assert.doesNotMatch(guidance.description, /未获授权|授权丢失/)
  }
  const job = { modelId: model.id, state: 'failed', mode: 'file', message: '所选版本不匹配' }
  const guidance = modelGuidance(current, stateFor(current, [{ id: 'weights', authorized: false }], job), specs)
  assert.equal(guidance.label, '需重新授权')
  assert.equal(guidance.error, job.message)
})

test('ready model files supersede historical failures and request only the remaining setup step', () => {
  const job = { modelId: model.id, state: 'failed', mode: 'download', message: '历史下载失败' }
  for (const { current, resources, action } of [
    { current: ready, resources: available, action: 'activate' },
    { current: { ...ready, prepared: false, bindingWarning: '当前宿主仅支持独立识图' }, resources: [authorized('weights')], action: 'engine' },
  ]) {
    const guidance = modelGuidance(current, stateFor(current, resources, job), specifications)
    assert.equal(guidance.action, action)
    assert.equal(guidance.error, '')
    assert.notEqual(guidance.tone, 'error')
    assert.doesNotMatch(guidance.label, /失败/)
    if (action === 'engine') {
      assert.equal(guidance.engineId, 'engine')
      assert.match(guidance.description, /无需重复导入模型文件/)
      assert.equal(guidance.warning, current.bindingWarning)
    } else assert.match(guidance.description, /首次使用时按需加载/)
  }
})

test('failures remain actionable when model files are not ready', () => {
  const job = { modelId: model.id, state: 'failed', mode: 'file', message: '所选版本不匹配' }
  const guidance = modelGuidance(model, stateFor(model, [], job), specifications)
  assert.equal(guidance.tone, 'error')
  assert.equal(guidance.error, job.message)
  assert.equal(guidance.action, 'import')
})

test('active bound models retain capability notices without asking for ineffective reactivation', () => {
  const current = { ...ready, active: true, bound: true, bindingWarning: '升级宿主以使用工具能力匹配' }
  const guidance = modelGuidance(current, stateFor(current, available), specifications)
  assert.equal(guidance.action, '')
  assert.equal(guidance.actionLabel, '')
  assert.match(guidance.description, /使用时加载/)
  assert.ok(guidance.description.includes(current.bindingWarning))
  const updated = { ...current, activationWarning: '文件已更新，绑定尚未切换', bindingWarning: '文件已更新，绑定尚未切换' }
  assert.equal(modelGuidance(updated, stateFor(updated, available), specifications).action, 'activate')
})

test('preparation exposes cancellation only for the current model job', () => {
  for (const state of ['preparing', 'cancelling']) {
    const job = { modelId: ready.id, state, mode: 'directory' }
    const guidance = modelGuidance(ready, stateFor(ready, available, job), specifications)
    assert.equal(guidance.action, 'cancel')
    assert.equal(guidance.tone, 'busy')
    assert.match(guidance.description, /不会自动切换当前模型/)
    assert.equal(modelGuidance(ready, stateFor(ready, available, { ...job, modelId: 'other' }), specifications).action, 'activate')
  }
})

test('known compatibility failures direct users to the engine without hiding file repair', () => {
  const compatibilityWarning = '此模型要求 llama.cpp b9000 或更新版本；当前引擎较旧。'
  for (const { current, resources, expected } of [
    { current: { ...ready, compatibilityWarning }, resources: available, expected: 'engine' },
    { current: { ...ready, active: true, bound: true, compatibilityWarning }, resources: available, expected: 'engine' },
    { current: { ...model, filesRegistered: true, compatibilityWarning }, resources: [{ id: 'weights', authorized: false }], expected: 'import' },
    { current: { ...ready, prepared: false, compatibilityWarning }, resources: [authorized('weights')], expected: 'engine' },
  ]) {
    const guidance = modelGuidance(current, stateFor(current, resources), specifications)
    assert.equal(guidance.action, expected)
    assert.ok((guidance.description + guidance.warning).includes(compatibilityWarning))
    assert.equal(guidance.tone, 'attention')
    assert.doesNotMatch(guidance.label + guidance.description, /已验证|兼容性已确认/)
  }
})

test('committing preserves busy state without offering cancellation or a second mutation', () => {
  const guidance = modelGuidance(ready, stateFor(ready, available, { modelId: ready.id, state: 'committing' }), specifications)
  assert.equal(guidance.tone, 'busy')
  assert.equal(guidance.label, '正在保存')
  assert.equal(guidance.action, '')
})

const engineSpecs = [
  { id: 'old', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b100', backend: 'vulkan', legacy: true },
  { id: 'new', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b200', backend: 'vulkan' },
  { id: 'cuda', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b200', backend: 'cuda' },
  { id: 'mac', kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', version: 'b200', backend: 'metal' },
  { id: 'speech', kind: 'engine', engineId: 'sherpa-onnx', title: 'sherpa-onnx' },
]
const engineState = {
  supported: true, models: [], resources: [authorized('old'), authorized('new')],
  engines: engineSpecs.filter(spec => spec.id !== 'mac').map(spec => ({
    id: spec.id, engineId: spec.engineId, version: spec.version, backend: spec.backend,
    installed: ['old', 'new'].includes(spec.id), selected: spec.id === 'new', capabilities: spec.id === 'speech' ? ['语音转写'] : ['对话'],
  })),
}

test('engine families group builds by backend using platform-filtered manager candidates', () => {
  const groups = engineGroups(engineState, engineSpecs)
  assert.deepEqual(groups.map(group => [group.title, group.backend]), [['llama.cpp', 'Vulkan'], ['llama.cpp', 'CUDA'], ['sherpa-onnx', '']])
  assert.deepEqual(groups[0].versions.map(version => [version.id, version.installed, version.selected]), [['old', true, false], ['new', true, true]])
  assert.deepEqual(groups[0].capabilities, ['对话'])
  assert.deepEqual(engineIdentity(engineSpecs[1]), { title: 'llama.cpp', backend: 'Vulkan', version: 'b200' })
  assert.equal(engineIdentity({ engineId: 'llama.cpp', custom: true }).version, '')
})

test('legacy registrations remain recoverable after authorization loss without exposing absent old builds', () => {
  const state = { ...engineState, engines: engineState.engines.map(engine => ({ ...engine, installed: false })), resources: [{ id: 'old', authorized: false }] }
  assert.deepEqual(engineGroups(state, engineSpecs)[0].versions.map(version => version.id), ['old', 'new'])
  assert.equal(engineGroups(state, engineSpecs)[0].versions[0].installed, false)
  assert.deepEqual(engineGroups({ ...state, resources: [] }, engineSpecs)[0].versions.map(version => version.id), ['new'])
})

test('engine mutations are blocked across builds and backends while a family runtime is busy', () => {
  const group = engineGroups(engineState, engineSpecs)[0]
  for (const resources of [{ activeResources: ['old'] }, { resources: ['new'] }, { directoryResources: ['cuda'] }]) {
    assert.equal(engineMutationBlocked(group, { ...engineState, models: [{ ...resources, runtimeBusy: true }] }, engineSpecs, false), true)
  }
  assert.equal(engineMutationBlocked(group, { ...engineState, models: [{ activeResources: ['speech'], runtimeBusy: true }] }, engineSpecs, false), false)
  assert.equal(engineMutationBlocked(group, engineState, engineSpecs, true), true)
  assert.equal(engineMutationBlocked(group, { ...engineState, supported: false }, engineSpecs, false), true)
  for (const state of ['preparing', 'cancelling', 'committing']) assert.equal(engineMutationBlocked(group, { ...engineState, job: { state } }, engineSpecs, false), true)
  assert.equal(engineMutationBlocked(group, { ...engineState, job: { state: 'failed' } }, engineSpecs, false), false)
})

test('library membership remains based on prepared models or registered model resources', () => {
  assert.equal(modelInLibrary(ready, [], specifications), true)
  assert.equal(modelInLibrary({ ...model, custom: true }, [], specifications), false)
  assert.equal(modelInLibrary(model, [authorized('engine')], specifications), false)
  for (const resource of [{ id: 'weights' }, { id: 'weights', authorized: false }, authorized('weights')]) {
    assert.equal(modelInLibrary(model, [resource], specifications), true)
  }
})
