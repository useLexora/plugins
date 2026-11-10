import { downloadActive, downloadPresentation } from './downloadPresentation.js'
import { compatibleImageModel, compatibleImageRecipe } from '../imageRecovery.js'
import { zImageTurbo } from '../native/image/recipes.mjs'

export const modelRecipes = { chat: 'llamacpp', vision: 'llamacpp', ocr: 'tesseract', asr: 'sherpa-onnx', tts: 'sherpa-onnx', image: 'sd-cpp' }
export const modelSymbols = { chat: 'chat', vision: 'vision', ocr: 'scan-eye', asr: 'mic', tts: 'tts', image: 'image' }
export const modelKinds = [
  { value: 'all', label: '全部类型' }, { value: 'chat', label: '对话' }, { value: 'vision', label: '对话＋图片' },
  { value: 'asr', label: '语音转写' }, { value: 'tts', label: '语音朗读' }, { value: 'image', label: '生图' }, { value: 'ocr', label: '文字识别' },
]

export function engineIdentity(engine) {
  return {
    title: engine.engineId || engine.title?.replace(/ 引擎$/, '') || engine.id,
    version: engine.version || '',
    backend: { vulkan: 'Vulkan', cuda: 'CUDA', metal: 'Metal', cpu: 'CPU' }[engine.backend] || engine.backend || '',
  }
}

export function engineGroups(state, specifications) {
  const groups = new Map()
  for (const engine of state.engines) {
    const spec = specifications.find(item => item.id === engine.id && item.kind === 'engine')
    if (!spec) continue
    const resource = state.resources.find(item => item.id === engine.id && item.authorized)
    const entry = { ...spec, ...engine, resource, installed: engine.installed ?? !!resource }
    if (spec.legacy && !entry.installed && !entry.selected && !state.resources.some(item => item.id === engine.id)) continue
    const key = JSON.stringify([entry.engineId || entry.id, entry.backend || ''])
    if (!groups.has(key)) groups.set(key, { key, engineId: entry.engineId || entry.id, ...engineIdentity(entry), versions: [], capabilities: [] })
    const group = groups.get(key)
    group.versions.push(entry)
    group.capabilities = [...new Set([...group.capabilities, ...(engine.capabilities ?? [])])]
  }
  const families = [...new Set([...groups.values()].map(group => group.engineId))]
  return [...groups.values()].sort((a, b) => families.indexOf(a.engineId) - families.indexOf(b.engineId))
}

export function engineFamilies(state, specifications) {
  const families = new Map()
  for (const group of engineGroups(state, specifications)) {
    if (!families.has(group.engineId)) families.set(group.engineId, { engineId: group.engineId, title: group.title, capabilities: [], backends: [] })
    const family = families.get(group.engineId)
    family.backends.push(group)
    family.capabilities = [...new Set([...family.capabilities, ...group.capabilities])]
  }
  return [...families.values()]
}

export function engineMutationBlocked(group, state, specifications, pending) {
  if (pending || !state.supported || downloadActive(state.job)) return true
  const familyIds = new Set(specifications.filter(spec => spec.kind === 'engine' && (spec.engineId || spec.id) === group.engineId).map(spec => spec.id))
  return state.models.some(model => model.runtimeBusy && [...(model.activeResources ?? []), ...(model.resources ?? []), ...(model.directoryResources ?? [])].some(id => familyIds.has(id)))
}

export function modelInLibrary(model, resources, specifications) {
  return model.prepared || model.activeResources.some(id => specifications.some(spec => spec.id === id && spec.kind === 'model') && resources.some(resource => resource.id === id))
}

export function modelOriginLabel(model) {
  if (model.origin?.source === 'local' || model.metadata?.source === 'local') return '本地导入 · 原始来源未知'
  const repository = model.origin?.repository
  const source = model.origin?.source ?? model.metadata?.source
  const label = { huggingface: 'Hugging Face', sherpa: 'sherpa-onnx 官方模型', tesseract: 'Tesseract 语言包' }[source]
  return [label, repository].filter(Boolean).join(' · ') || model.description || '原始来源未知'
}

export function modelMatches(model, query, kind) {
  if (kind !== 'all' && model.runtime !== kind) return false
  const text = `${model.title} ${model.origin?.repository ?? ''} ${Object.values(model.files ?? {}).join(' ')} ${(model.metadata?.tags ?? []).join(' ')}`.toLowerCase()
  return text.includes(query.trim().toLowerCase())
}

export function modelPresentation(model, job) {
  if (job?.modelId === model.id) {
    if (downloadActive(job)) return { label: downloadPresentation(job).label, tone: 'busy' }
    if (job.state === 'failed' && !model.filesReady) return { label: job.mode === 'download' ? '下载失败' : '导入失败', tone: 'error' }
    if (job.state === 'cancelled' && !model.filesReady) return { label: '已取消', tone: 'neutral' }
  }
  const running = { loading: '启动中', running: '处理中', idle: '待命', stopping: '停止中' }[model.state]
  if (running) return { label: running, tone: model.state === 'idle' ? 'ready' : 'busy' }
  if (model.state === 'unsupported') return { label: '不支持', tone: 'attention' }
  if (model.state === 'unverified') return { label: compatibleImageRecipe(model) ? '需使用兼容版本' : '需重新验证', tone: 'attention' }
  if (model.compatibilityWarning) return { label: '需检查兼容性', tone: 'attention' }
  if (model.active && model.bound) return { label: '已启用', tone: 'ready' }
  if (model.prepared) return { label: '可启用', tone: 'ready' }
  if (model.filesReady) return { label: '需安装引擎', tone: 'attention' }
  if (model.filesRegistered) return { label: '文件状态待确认', tone: 'attention' }
  return { label: model.acquisition === 'import' ? '等待导入' : '尚未下载', tone: 'neutral' }
}

export function modelGuidance(model, state, specifications) {
  const status = modelPresentation(model, state.job)
  const step = (title, description, action = '', actionLabel = '', extra = {}) => ({ ...status, title, description, action, actionLabel, engineId: '', compatibleId: '', error: '', warning: [...new Set([model.compatibilityWarning, model.bindingWarning])].filter(warning => warning && !description.includes(warning)).join(' '), ...extra })
  const job = state.job?.modelId === model.id ? state.job : null
  if (downloadActive(job)) return step(status.label, '完成后会更新文件状态，不会自动切换当前模型。', job.state === 'committing' ? '' : 'cancel', job.state === 'committing' ? '' : '取消任务')
  if (model.state === 'unverified' && compatibleImageRecipe(model)) {
    const compatible = compatibleImageModel(model, state.models, specifications, state.resources, state.models.find(item => item.runtime === 'image' && item.active)?.id)
    return step(compatible ? '已有可继续设置的兼容版本' : '换用兼容版本即可继续', compatible ? `可打开「${compatible.title}」继续。原模型、文件和参数都会保留，启用前不会切换当前选择。` : '此记录不能按完整检查点加载。添加兼容版后可导入已有的三个组件或下载，无需清理原模型。', 'recover', compatible ? '打开兼容版' : '添加兼容版本', { compatibleId: compatible?.id, warning: '', ...(compatible ? { label: '已有兼容版' } : {}) })
  }
  if (model.state === 'unsupported') return step('当前设备暂不能运行此模型', model.bindingWarning || state.compatibilityMessage || '可保留模型记录与文件，待设备或引擎支持后继续。')
  if (model.state === 'unverified') return step('重新识别文件以确认模型结构', '当前记录尚缺少有效的结构信息。请通过本地导入重新识别文件，确认配套组件后再使用；原记录和原文件会保留。', 'inspect', '重新识别文件')
  if (!model.filesReady) {
    const fileIds = model.activeResources.filter(id => specifications.some(spec => spec.id === id && spec.kind === 'model'))
    const needsAuthorization = fileIds.some(id => !state.resources.some(resource => resource.id === id && resource.authorized) && state.resources.some(resource => resource.id === id && resource.authorized === false))
    const imported = model.filesRegistered || model.acquisition === 'import' || model.origin?.source === 'local'
    const zImage = model.imageArchitecture === zImageTurbo.architecture
    const description = needsAuthorization ? '原文件引用未获授权。文件仍在时，重新选择即可恢复访问，无需重新下载。' : model.filesRegistered ? '目前无法确认已登记文件的访问状态。文件仍在时可重新选择，不必先删除或重新下载。' : zImage ? '已有文件？选择包含下方三个组件的模型文件夹即可直接引用；没有文件时也可下载。' : imported ? '选择已有模型文件即可继续，原文件会保留。' : '下载模型文件后再准备引擎；如果已经有文件，也可以直接导入。'
    const title = needsAuthorization ? '重新选择已有文件，恢复访问' : model.filesRegistered ? '重新关联已有模型文件' : imported ? '先导入已有模型文件' : '先准备模型文件'
    return step(job?.state === 'failed' && !needsAuthorization ? status.label : title, description, imported ? 'import' : 'download', imported ? model.filesRegistered ? '重新选择文件' : '导入已有文件' : '下载模型文件', { ...(needsAuthorization ? { label: '需重新授权', tone: 'attention' } : {}), error: job?.state === 'failed' ? job.message : undefined })
  }
  const missingEngine = model.activeResources.find(id => specifications.some(spec => spec.id === id && spec.kind === 'engine') && !state.resources.some(resource => resource.id === id && resource.authorized))
  if (missingEngine) return step('模型文件已准备好，还需准备引擎', '无需重复导入模型文件。打开对应引擎，安装或导入后再启用模型。', 'engine', '去安装引擎', { engineId: missingEngine })
  if (model.compatibilityWarning) return step('需要检查推理引擎', model.compatibilityWarning, 'engine', '检查引擎', { engineId: model.activeResources.find(id => specifications.some(spec => spec.id === id && spec.kind === 'engine')) || '' })
  if (model.prepared && (!model.active || !model.bound || model.activationWarning)) return step(model.activationWarning ? '重新启用以应用已更新文件' : '已准备好，可以启用', model.bindingWarning || '模型文件与引擎引用均已准备好。启用会将它设为当前用途的本地模型，首次使用时按需加载。', 'activate', model.activationWarning || (model.active && !model.bound) ? '重新启用模型' : '启用模型')
  if (model.active && model.bound) return step('已启用，可以使用', [(model.runtime === 'image' ? '在「模型服务 → 生图」选用此模型，再回到任务生成图片。模型将在使用时加载。' : '已设为当前用途的本地模型，使用时按需加载。'), model.bindingWarning].filter(Boolean).join(' '))
  return step('模型状态待确认', model.bindingWarning || '刷新状态后可继续设置；已有模型、文件和参数都会保留。', 'refresh', '刷新状态')
}
