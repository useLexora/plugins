import { inferenceEnvironment, platformModel, resourceSupported } from './platform.js'
import { engineSpecification, engineKey, initialEngineSelections, selectModelEngine, modelEngineRequirement, engineCompatibility } from './enginePolicy.js'
import { importEngine } from './engineImport.js'
import { checkEngineUpdates, validateEngineUpdates } from './engineUpdates.js'
import { createDiscovery } from './discovery.js'
import { createLocalImport } from './localImport.js'
import { recommendConfiguration } from './runtimeGuidance.js'
import { imageModelWarning, zImageTurbo } from './native/image/recipes.mjs'
import { compatibleImageModel, compatibleImageRecipe } from './imageRecovery.js'
import { modelToolBinding } from './modelToolSupport.js'
import { groupGgufFiles } from './modelFileGroups.js'
import { createDownloadProgress, exactFileSize } from './downloadProgress.js'
import { boundDownloadHistory, fitStorage, historyRecord, historyWarningMessage, jsonBytes, restoreDownloadHistory, storageMaxBytes } from './downloadHistory.js'

const success = () => ({ ok: true })
const failure = error => ({ error })
const authorized = (resources, id, revision) => resources.findLast(resource => resource.id === id && resource.authorized && (revision === undefined || resource.revision === revision))

function validField(field, value) {
  if (field.type === 'select') return field.choices.some(choice => choice.value === value)
  if (field.type === 'number') return Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isInteger(value))
  return typeof value === 'string' && value.trim().length > 0 && value.length <= (field.key === 'baseUrl' ? 1024 : 100)
}

function configurationFor(definition, stored) {
  return Object.fromEntries(definition.fields.map(field => [field.key, validField(field, stored?.[field.key]) ? stored[field.key] : definition.defaults[field.key]]))
}

function validateConfiguration(definition, input) {
  const configuration = {}
  for (const field of definition.fields) {
    const value = input?.[field.key]
    if (!validField(field, value)) return failure(`参数不合法：${field.label}`)
    configuration[field.key] = typeof value === 'string' ? value.trim() : value
  }
  if (['chat', 'vision'].includes(definition.runtime) && configuration.maxTokens > configuration.contextWindow) return failure('最大输出不能超过上下文长度')
  return { configuration }
}

function modelResources(model, resources, revisions = {}) {
  if (model.resources.every(id => authorized(resources, id, revisions[id]))) return model.resources
  if (model.directoryResources?.length === model.resources.length && model.directoryResources.every(id => authorized(resources, id, revisions[id]))) return model.directoryResources
  return model.resources
}

function runtimeBusy(runtime) {
  return runtime?.instances.some(instance => instance.active > 0 || instance.pending > 0 || ['loading', 'stopping'].includes(instance.state)) ?? false
}

function runtimeState(runtime, available) {
  const instances = runtime?.instances ?? []
  if (instances.some(instance => instance.state === 'stopping')) return 'stopping'
  if (instances.some(instance => instance.state === 'loading')) return 'loading'
  if (instances.some(instance => instance.state === 'ready' && instance.active > 0)) return 'running'
  if (instances.some(instance => instance.state === 'ready')) return 'idle'
  return available ? 'available' : 'missing'
}

function modelBinding(model, configuration, resources, chatImageInput, chatToolMatching, chatReasoning, platform, revisions = {}, chatModelMetadata = false) {
  configuration = configurationFor(model, configuration)
  const selected = modelResources(model, resources, revisions).map(id => authorized(resources, id, revisions[id]))
  if (selected.some(resource => !resource)) return null
  const binding = {
    runtime: model.runtime,
    resources: selected.map((resource, index) => ({ mount: index === 0 ? 'engine' : 'model', id: resource.id, revision: resource.revision })),
    configuration: { ...configuration, ...(model.bundle ? { bundle: true } : {}), ...(model.files ? { files: model.files, ...(model.phonemes ? { phonemes: model.phonemes } : {}), ...(model.languages ? { languages: model.languages } : {}), ...(model.imageArchitecture ? { imageArchitecture: model.imageArchitecture } : {}), ...(model.imageValidation ? { imageValidation: model.imageValidation } : {}) } : {}) },
  }
  if (model.runtime === 'chat' || model.runtime === 'vision') Object.assign(binding.configuration, { chatReasoning, modelId: model.id })
  if (model.runtime === 'chat' || (model.runtime === 'vision' && chatImageInput)) binding.models = [{ id: model.id, title: model.title, capability: model.runtime === 'vision' ? 'vision-chat' : 'chat', ...(model.runtime === 'vision' ? { input: ['text', 'image'] } : {}), contextWindow: configuration.contextWindow, maxTokens: configuration.maxTokens, ...modelToolBinding(model, chatToolMatching, chatReasoning, chatModelMetadata) }]
  if (model.runtime === 'asr' || model.runtime === 'tts') {
    binding.configuration = { ...binding.configuration, kind: model.runtime }
    if (platform === 'linux-x64') binding.libraryPaths = [{ mount: 'engine', path: 'node_modules/sherpa-onnx-linux-x64' }]
  }
  if (model.runtime === 'ocr' || model.runtime === 'vision') {
    binding.configuration = { ...binding.configuration, backend: model.runtime, ...(model.runtime === 'ocr' ? { ocrEngine: selected[0].id === 'tesseract-wasm' ? 'wasm' : 'native' } : {}) }
    binding.imageReaders = [{ id: model.id, title: model.title, capability: model.runtime, support: { operations: model.runtime === 'ocr' ? ['extract'] : ['understand', 'extract', 'document'] } }]
  }
  if (model.runtime === 'image') {
    binding.configuration = { ...binding.configuration, backend: platform === 'macos-arm64' ? (configuration.acceleration === 'cpu' ? 'cpu' : 'metal') : platform === 'windows-x64' ? 'Vulkan0' : 'CUDA0' }
    const generateOnly = ['checkpoint', 'z-image-turbo'].includes(model.imageArchitecture)
    binding.imageModels = [{ id: model.id, title: model.title, capability: 'image', support: { operations: generateOnly ? ['generate'] : ['generate', 'edit'], maxReferenceImages: generateOnly ? 0 : 4, sizes: ['auto', '512x512', '768x768', '1024x1024'], qualities: ['auto'], backgrounds: ['auto'] } }]
  }
  return binding
}

function serviceBinding(service, configuration) {
  const endpoint = (id, path, contentType) => ({ id, url: configuration.baseUrl + path, contentType, ...(configuration.auth === 'bearer' ? { credential: service.id } : {}) })
  const binding = { runtime: service.runtime, resources: [], configuration }
  if (service.id === 'speech-api') {
    binding.endpoints = [endpoint('transcribe', '/audio/transcriptions', 'multipart/form-data'), endpoint('synthesize', '/audio/speech', 'application/json')]
  }
  else {
    binding.endpoints = [endpoint('generate', '/images/generations', 'application/json'), endpoint('edit', '/images/edits', 'multipart/form-data')]
    binding.imageModels = [{ id: 'api-image', title: `图像 API · ${configuration.model}`.slice(0, 100), capability: 'api-image', support: { operations: configuration.operations === 'both' ? ['generate', 'edit'] : ['generate'], maxReferenceImages: 4, sizes: ['auto', configuration.defaultSize], qualities: ['auto'], backgrounds: ['auto'] } }]
  }
  return binding
}

export async function activateManager(context, { manifest, catalog, specifications }) {
  let environment = await inferenceEnvironment(context.inference)
  const supported = environment.executionMode !== 'unsupported'
  const platform = environment.platform
  const chatImageInput = context.inference?.capabilities?.chatImageInput === true
  const resumableDownloads = context.inference?.capabilities?.resumableDownloads === true
  const chatToolMatching = context.inference?.capabilities?.chatToolMatching === true
  const chatReasoning = context.inference?.capabilities?.chatReasoning === true
  const chatModelMetadata = context.inference?.capabilities?.chatModelMetadata === true
  const toolWarning = model => !chatToolMatching && (model.runtime === 'chat' || (model.runtime === 'vision' && chatImageInput)) ? '当前宿主不支持工具能力匹配与手动修正，请升级 Lexora。' : ''
  const visionWarning = model => model.runtime === 'vision' && !chatImageInput ? '当前 Lexora 版本仅支持此模型的独立识图；请升级 Lexora 后使用对话与图片输入。' : ''
  const compatibilityMessage = supported ? '' : '当前版本不支持本地推理，请更新 Lexora 后使用。'
  const stored = await context.storage.get()
  const restoredHistory = restoreDownloadHistory(stored?.downloadHistory)
  let downloadHistory = restoredHistory.history
  let historyWarning = ''
  let jobSequence = 0
  const definitions = catalog.models
  const cachedEngines = Array.isArray(stored?.engineCatalog) ? stored.engineCatalog : []
  const engineCatalog = validateEngineUpdates(cachedEngines, [...specifications, ...cachedEngines.filter(spec => !specifications.some(current => current.id === spec?.id))])
  specifications = [...new Map([...specifications, ...engineCatalog, ...(Array.isArray(stored?.customEngines) ? stored.customEngines : [])].map(spec => [spec.id, engineSpecification(spec)])).values()]
  const resourceDefinitions = specifications
  const availableBackends = [...new Set(resourceDefinitions.filter(spec => spec.engineId === 'llama.cpp' && resourceSupported(spec, platform)).map(spec => spec.backend))]
  const recommendationFor = model => recommendConfiguration(model, environment.hardware, platform, availableBackends)
  const projectModel = model => {
    const projected = platformModel(model, platform)
    return { ...projected, defaults: { ...projected.defaults, ...recommendationFor(projected).configuration } }
  }
  const templates = definitions.map(projectModel)
  const custom = Array.isArray(stored?.custom) ? stored.custom : []
  const projectCustom = (model) => {
    if (['chat', 'vision'].includes(model.runtime)) {
      const template = definitions.find(item => item.runtime === model.runtime)
      model = {
        ...model,
        fields: [
          ...model.fields.map(field => ['contextWindow', 'maxTokens'].includes(field.key) ? { ...field, ...template.fields.find(current => current.key === field.key) } : field),
          ...template.fields.filter(field => !model.fields.some(existing => existing.key === field.key)),
        ],
        defaults: { ...template.defaults, ...model.defaults },
        capabilities: [...new Set([...template.capabilities, ...model.capabilities])],
      }
    }
    return projectModel(model)
  }
  const existingResources = supported ? await context.inference.resources.list() : []
  const retainedModels = templates.filter(model => model.resources.some(id => specifications.find(spec => spec.id === id)?.kind === 'model' && existingResources.some(resource => resource.id === id)))
  catalog = { ...catalog, models: [...retainedModels, ...custom.map(item => projectCustom(item.model))] }
  specifications = [...specifications.filter(spec => resourceSupported(spec, platform) && (spec.kind === 'engine' || retainedModels.some(model => model.resources.includes(spec.id)))), ...custom.map(item => item.specification)]
  const platformName = platform === 'macos-arm64' ? 'macOS ARM64' : 'Windows x64'
  const platformWarning = model => ['windows-x64', 'macos-arm64'].includes(platform) && !specifications.some(spec => spec.id === model.resources[0] && spec.kind === 'engine') ? `此模型的原生引擎尚无 ${platformName} 适配；文件和配置已保留。` : ''
  const localImport = createLocalImport(context)
  let settings = {
    version: 3,
    customEngines: Array.isArray(stored?.customEngines) ? stored.customEngines : [],
    engineCatalog,
    engineSelections: initialEngineSelections(specifications, existingResources, stored?.engineSelections?.[platform]),
    ...(stored?.discoveryCache ? { discoveryCache: stored.discoveryCache } : {}),
    ...(stored?.downloadHistory ? { downloadHistory: stored.downloadHistory } : {}),
    custom,
    resourceRevisions: Object.fromEntries(Object.entries(stored?.resourceRevisions ?? {}).filter(([, revision]) => typeof revision === 'string' && revision.length > 0)),
    active: stored?.active ?? Object.fromEntries(retainedModels.map(model => [model.runtime, model.id])),
    models: { ...stored?.models, ...Object.fromEntries(catalog.models.map(model => [model.id, { ...stored?.models?.[model.id], ...configurationFor(model, stored?.models?.[model.id]) }])) },
    services: Object.fromEntries(catalog.services.map(service => [service.id, { enabled: stored?.services?.[service.id]?.enabled === true, credentialPending: stored?.services?.[service.id]?.credentialPending === true, configuration: configurationFor(service, stored?.services?.[service.id]?.configuration) }])),
  }
  const currentModel = (model, configuration = model && settings.models[model.id]) => selectModelEngine(model, configuration, specifications, settings.engineSelections, platform)
  const compatibility = model => engineCompatibility(model, specifications.find(spec => spec.id === model.resources[0]))
  const bindingFor = (model, configuration, resources) => {
    model = currentModel(model, configuration)
    if (compatibility(model)) return null
    const binding = modelBinding(model, configuration, resources, chatImageInput, chatToolMatching, chatReasoning, platform, settings.resourceRevisions, chatModelMetadata)
    const engine = specifications.find(spec => spec.id === model.resources[0])
    if (binding && engine?.engineId === 'llama.cpp') Object.assign(binding.configuration, {
      ...(engine.version ? { engineVersion: engine.version } : {}),
      engineBackend: configuration?.acceleration === 'cpu' ? 'cpu' : engine.backend,
      ...(model.metadata?.architecture ? { architecture: model.metadata.architecture } : {}),
      ...modelEngineRequirement(model),
    })
    return binding
  }
  const bindings = new Map()
  const activationMessages = new Map()
  let mutating = false, mutationRevision = 0
  let preparation
  let resolution
  let job = null
  const publish = value => {
    job = value
    void context.views.broadcast({ type: 'resource-preparation', job }).catch(() => {})
  }
  const register = (name, handler) => context.subscriptions.add(context.commands.register(`${manifest.id}.${name}`, command => name !== 'status' && !supported ? failure(compatibilityMessage) : handler(command.arguments ?? {})))
  const mutate = handler => async (input) => {
    if (mutating) return failure('请先完成当前操作，或取消正在进行的资源准备')
    mutating = true
    mutationRevision++
    try { return await handler(input) }
    finally { mutating = false; mutationRevision++ }
  }
  let writing = Promise.resolve()
  let persisted = stored
  const exceedsStorageLimit = value => jsonBytes(value) > storageMaxBytes
  const enqueueSave = build => {
    const commit = writing.catch(() => {}).then(async () => {
      const next = build(settings, persisted)
      await context.storage.set(next.value)
      persisted = next.value
      settings = next.settings
      if (next.historyTrimmed) historyWarning = historyWarningMessage
      else if (next.historySaved) historyWarning = ''
    })
    writing = commit
    return commit
  }
  const save = next => enqueueSave(current => {
    const value = { ...persisted, ...next, engineSelections: { ...persisted?.engineSelections, [platform]: next.engineSelections } }
    if (current.discoveryCache) value.discoveryCache = current.discoveryCache
    else delete value.discoveryCache
    if (current.downloadHistory) value.downloadHistory = current.downloadHistory
    else delete value.downloadHistory
    const fitted = fitStorage(value)
    return { ...fitted, settings: { ...fitted.value, engineSelections: next.engineSelections } }
  })
  const saveHistory = async () => {
    const snapshot = downloadHistory.map(record => ({ ...record }))
    try {
      await enqueueSave((current, previous) => {
        if (previous != null && (typeof previous !== 'object' || Array.isArray(previous))) throw Error('插件存储格式不支持下载历史')
        const fitted = fitStorage({ ...previous, ...(Object.keys(current.resourceRevisions).length ? { resourceRevisions: current.resourceRevisions } : {}), downloadHistory: snapshot })
        const next = { ...current }
        for (const key of ['discoveryCache', 'downloadHistory']) {
          if (Object.hasOwn(fitted.value, key)) next[key] = fitted.value[key]
          else delete next[key]
        }
        return { ...fitted, settings: next, historySaved: true }
      })
    } catch { historyWarning = historyWarningMessage }
  }
  if (restoredHistory.changed) await saveHistory()
  const discovery = createDiscovery(context, {
    cached: stored?.discoveryCache,
    persist: cache => enqueueSave((current, previous) => {
      if (previous != null && (typeof previous !== 'object' || Array.isArray(previous))) throw Error('插件存储格式不支持缓存')
      const value = { ...previous, discoveryCache: cache }
      if (exceedsStorageLimit(value)) throw Error('模型目录缓存空间不足')
      return { value, settings: { ...current, discoveryCache: cache } }
    }),
  })
  async function bind(binding) {
    if (!binding) return
    const signature = JSON.stringify(binding)
    if (bindings.get(binding.runtime) === signature) return
    await context.inference.bind(binding)
    bindings.set(binding.runtime, signature)
  }
  const imageWarning = model => imageModelWarning(model, specifications.find(spec => spec.id === model.resources[1]))
  const applyModel = async (model, configuration = settings.models[model.id]) => {
    model = currentModel(model, configuration)
    if (settings.active[model.runtime] !== model.id) return
    const binding = platformWarning(model) || imageWarning(model) || compatibility(model) ? null : bindingFor(model, configuration, await context.inference.resources.list())
    const runtime = (await context.inference.status()).find(runtime => runtime.runtime === model.runtime)
    if (!runtime || runtime.configured === false) bindings.delete(model.runtime)
    if ((!binding && !bindings.has(model.runtime)) || (binding && bindings.get(model.runtime) === JSON.stringify(binding))) return
    if (runtimeBusy(runtime)) throw Error('当前模型正在使用，请等待任务结束后重新启用')
    if (binding) await bind(binding)
    else {
      await context.inference.unbind({ runtime: model.runtime })
      bindings.delete(model.runtime)
    }
  }

  register('check-engine-updates', mutate(async () => {
    const known = [...new Map([...resourceDefinitions, ...settings.engineCatalog].map(spec => [spec.id, spec])).values()]
    const updates = await checkEngineUpdates(context, known)
    const added = updates.filter(spec => !known.some(current => current.id === spec.id)).length
    const engineCatalog = [...new Map([...settings.engineCatalog, ...updates].map(spec => [spec.id, spec])).values()]
    await save({ ...settings, engineCatalog })
    specifications = [...new Map([...specifications, ...updates.filter(spec => resourceSupported(spec, platform))].map(spec => [spec.id, spec])).values()]
    return { ok: true, added, message: added ? `发现 ${added} 个引擎构建；安装后可手动切换，当前运行不受影响` : '未发现新的引擎版本，当前选择保持不变' }
  }))

  register('use-engine', mutate(async ({ resourceId }) => {
    const engine = specifications.find(spec => spec.id === resourceId && spec.engineId && resourceSupported(spec, platform))
    if (!engine) return failure('请选择当前平台可用的引擎')
    const resources = await context.inference.resources.list()
    if (!authorized(resources, engine.id, settings.resourceRevisions[engine.id])) return failure('请先安装或重新授权此引擎')
    const previous = settings
    const previousBindings = new Map(bindings)
    const selections = { ...settings.engineSelections, [engineKey(engine)]: engine.id }
    const affected = catalog.models.filter(model => {
      if (settings.active[model.runtime] !== model.id) return false
      const before = currentModel(model)
      const after = selectModelEngine(model, settings.models[model.id], specifications, selections, platform)
      return after.resources[0] === engine.id || before.resources[0] !== after.resources[0] || !!before.engineSelectionMissing !== !!after.engineSelectionMissing
    })
    const runtimes = await context.inference.status()
    if (affected.some(model => runtimeBusy(runtimes.find(runtime => runtime.runtime === model.runtime)))) return failure('模型正在使用，请等待任务结束后切换引擎')
    const incompatible = affected.map(model => selectModelEngine(model, settings.models[model.id], specifications, selections, platform)).find(model => compatibility(model))
    if (incompatible) return failure(compatibility(incompatible))
    settings = { ...settings, engineSelections: selections }
    try {
      for (const model of affected) await applyModel(model)
      await save(settings)
    } catch (error) {
      settings = previous
      try {
        for (const model of affected) {
          const before = previousBindings.get(model.runtime)
          if (before) await bind(JSON.parse(before))
          else { await context.inference.unbind({ runtime: model.runtime }); bindings.delete(model.runtime) }
        }
      } catch {
        throw Error('引擎切换未保存，运行绑定恢复失败；请停止模型后重新启用', { cause: error })
      }
      throw error
    }
    return success()
  }))

  register('import-engine', mutate(async input => {
    const controller = new AbortController()
    preparation = controller
    const signal = AbortSignal.any([controller.signal, context.signal])
    const target = { kind: 'engine-import', title: 'llama.cpp', mode: 'file' }
    publish({ ...target, state: 'preparing', progress: null })
    try {
      const { specification, prepared } = await importEngine(context, input, platform, { signal })
      signal.throwIfAborted()
      publish({ ...target, resourceId: specification.id, state: 'committing', progress: null })
      const customEngines = [...settings.customEngines.filter(spec => spec.id !== specification.id), specification]
      await save({ ...settings, customEngines, resourceRevisions: { ...settings.resourceRevisions, [specification.id]: prepared.revision } })
      specifications = [...specifications.filter(spec => spec.id !== specification.id), specification]
      publish({ ...target, resourceId: specification.id, state: 'completed', progress: null })
      return { ok: true, resourceId: specification.id }
    } catch (error) {
      const message = signal.aborted ? '已取消，原文件和已准备资源保留' : error.message || '引擎导入失败，请重新选择文件'
      publish({ ...target, state: signal.aborted ? 'cancelled' : 'failed', message, progress: null })
      return failure(message)
    } finally { preparation = undefined }
  }))

  const createModel = (resolved, acquisition) => {
    const template = definitions.find(model => model.runtime === resolved.recipe && model.imageArchitecture === resolved.imageArchitecture) ?? definitions.find(model => model.runtime === resolved.recipe)
    const { directoryResources: _directoryResources, ...base } = template
    return { ...base, id: resolved.id, title: resolved.title, description: resolved.origin?.repository ?? '本地导入 · 原始来源未知', custom: true, acquisition, origin: resolved.origin, metadata: resolved.metadata, ...(resolved.recipe === 'tts' ? { defaults: { ...base.defaults, speaker: 0 } } : {}), ...(resolved.bundle ? { bundle: true } : { files: resolved.files }), ...(resolved.phonemes ? { phonemes: resolved.phonemes } : {}), ...(resolved.recipe === 'image' ? { imageArchitecture: resolved.imageArchitecture, ...(resolved.imageValidation ? { imageValidation: resolved.imageValidation } : {}), capabilities: ['生图'] } : {}), ...(resolved.recipe === 'ocr' ? { languages: resolved.languages ?? resolved.files.language.replace('.traineddata', '') } : {}), resources: [template.resources[0], resolved.specification.id] }
  }

  register('inspect-local', mutate(input => localImport.inspect(input).then(result => ({ ok: true, ...result })).catch(error => failure(error.message))))
  register('import-local', mutate(async input => {
    const controller = new AbortController()
    preparation = controller
    const signal = AbortSignal.any([context.signal, controller.signal])
    const target = { kind: 'local-import', title: '本地模型', mode: 'file' }
    let created
    let retained = false
    let committed = false
    publish({ ...target, state: 'preparing', progress: null })
    try {
      const resolved = await localImport.resolve(input, { signal, onProgress: progress => publish({ ...target, state: signal.aborted ? 'cancelling' : 'preparing', progress }) })
      signal.throwIfAborted()
      const existing = catalog.models.find(model => model.id === resolved.id)
      if (existing && settings.active[existing.runtime] === existing.id && runtimeBusy((await context.inference.status()).find(runtime => runtime.runtime === existing.runtime))) throw Error('当前模型正在使用，请等待任务结束后重新导入')
      const persisted = existing && specifications.find(spec => spec.id === resolved.specification.id)
      const roles = new Map(Object.entries(resolved.files).map(([role, path]) => [path, existing?.files?.[role]]))
      const files = resolved.specification.files.map(file => {
        if (!existing) return file
        const path = roles.get(file.path) ?? (resolved.phonemes && existing.phonemes && file.path.startsWith(`${resolved.phonemes}/`) ? existing.phonemes + file.path.slice(resolved.phonemes.length) : file.path)
        if (!persisted?.files.some(stored => stored.path === path && stored.sha256 === file.sha256)) throw Error('已有模型的文件结构不一致，请保留原模型并重新检查所选文件')
        return { ...file, path }
      })
      const previous = new Set((await context.inference.resources.list()).map(resource => `${resource.id}:${resource.revision}`))
      created = await context.inference.resources.prepare({ id: resolved.specification.id, kind: 'model', files: files.map(file => ({ path: file.path, sha256: file.sha256, source: { resourceId: file.resourceId, reference: true } })) }, { signal, onProgress: progress => publish({ ...target, title: resolved.title, state: signal.aborted ? 'cancelling' : 'preparing', progress }) })
      retained = previous.has(`${created.id}:${created.revision}`)
      signal.throwIfAborted()
      publish({ ...target, title: resolved.title, state: 'committing', progress: null })
      const resourceRevisions = { ...settings.resourceRevisions, [created.id]: created.revision }
      if (!existing) {
        const model = createModel(resolved, 'import')
        const specification = { ...resolved.specification, files: resolved.specification.files.map(({ resourceId: _resourceId, ...file }) => file) }
        const projected = projectCustom(model)
        await save({ ...settings, resourceRevisions, custom: [...settings.custom, { model, specification }], models: { ...settings.models, [model.id]: configurationFor(projected) } })
        catalog.models.push(projected); specifications.push(specification)
      } else {
        const specification = { ...persisted, files: persisted.files.map(file => ({ ...file, source: files.find(current => current.path === file.path)?.source ?? file.source })) }
        const validatedMetadata = {
          ...(resolved.recipe === 'image' ? { imageValidation: resolved.imageValidation } : {}),
          ...(resolved.metadata?.inference ? { metadata: { ...existing.metadata, ...resolved.metadata } } : {}),
        }
        await save({ ...settings, resourceRevisions, custom: settings.custom.map(item => item.model.id === existing.id ? { ...item, model: { ...item.model, ...validatedMetadata }, specification } : item) })
        Object.assign(existing, validatedMetadata)
        specifications = specifications.map(item => item.id === specification.id ? specification : item)
      }
      committed = true
      let warning
      if (existing) {
        try {
          if (settings.active[existing.runtime] === existing.id && runtimeBusy((await context.inference.status()).find(runtime => runtime.runtime === existing.runtime))) throw Error('Runtime busy')
          await applyModel(existing)
          activationMessages.delete(existing.id)
        } catch {
          warning = '文件已导入，当前运行绑定未切换；请在任务结束后重新启用此模型'
          activationMessages.set(existing.id, warning)
        }
      }
      publish({ ...target, modelId: resolved.id, title: resolved.title, state: 'completed', progress: null })
      return { ok: true, modelId: resolved.id, ...(warning ? { warning } : {}) }
    } catch (error) {
      let cleanupError
      if (created && !retained && !committed) {
        try { await context.inference.resources.remove({ id: created.id, revision: created.revision }) }
        catch (error) { cleanupError = error }
      }
      const message = cleanupError ? '导入未完成，临时资源记录未能清理；原文件未改动，请重试或检查插件资源' : signal.aborted ? '已取消导入，原文件未改动' : error.message || '导入失败，原文件未改动'
      publish({ ...target, state: signal.aborted ? 'cancelled' : 'failed', progress: null, message })
      return failure(message)
    } finally { preparation = undefined }
  }))

  register('discover', input => discovery.search(input).catch(error => failure(error.message)))
  register('inspect-model', input => discovery.inspect(input).catch(error => failure(error.message)))
  register('add-model', mutate(async input => {
    const controller = new AbortController()
    resolution = controller
    const signal = AbortSignal.any([context.signal, controller.signal])
    let resolved
    try { resolved = await discovery.resolve(input, { signal }); signal.throwIfAborted() }
    finally { resolution = undefined }
    const existing = catalog.models.find(model => model.id === resolved.id)
    if (existing) {
      const current = settings.custom.find(item => item.model.id === existing.id)
      if (!current || current.specification.id !== resolved.specification.id) return failure('已有模型记录与资源清单不一致，请保留原模型并检查后重试')
      const specification = { ...current.specification, ...resolved.specification, title: current.specification.title }
      if (JSON.stringify(specification) === JSON.stringify(current.specification)) return { ok: true, modelId: existing.id }
      const [resources, runtimes] = await Promise.all([context.inference.resources.list(), context.inference.status()])
      if (settings.active[existing.runtime] === existing.id && runtimeBusy(runtimes.find(runtime => runtime.runtime === existing.runtime))) return failure('当前模型正在使用，请等待任务结束后再更正文件校验信息；原记录未改动')
      if (resources.some(resource => resource.id === specification.id)) return failure('此模型已有文件或资源引用，请先在“我的模型”中清理模型文件，再更正校验信息；现有文件和配置未改动')
      await save({ ...settings, custom: settings.custom.map(item => item.model.id === existing.id ? { ...item, specification } : item) })
      specifications = specifications.map(item => item.id === specification.id ? specification : item)
      return { ok: true, modelId: existing.id }
    }
    const model = createModel(resolved, input.mode)
    const projected = projectCustom(model)
    const next = { ...settings, custom: [...settings.custom, { model, specification: resolved.specification }], models: { ...settings.models, [model.id]: configurationFor(projected) } }
    await save(next)
    catalog.models.push(projected); specifications.push(resolved.specification)
    return { ok: true, modelId: model.id }
  }))
  register('add-compatible-model', mutate(async input => {
    const source = catalog.models.find(model => model.id === input.modelId)
    if (!source) return failure('模型不存在')
    const recipe = compatibleImageRecipe(source)
    if (!imageWarning(source) || !recipe) return failure('此模型无需或不支持添加兼容版')
    try {
      const resources = await context.inference.resources.list()
      const existing = compatibleImageModel(source, catalog.models, specifications, resources, settings.active.image)
      if (existing) return { ok: true, modelId: existing.id }
      const id = 'compatible-z-image-turbo'
      const resourceId = `${id}-model`
      if (catalog.models.some(model => model.id === id) || specifications.some(spec => spec.id === resourceId)) return failure('兼容版标识已存在，请先检查已有记录')
      const template = definitions.find(model => model.id === recipe)
      const fixed = resourceDefinitions.find(spec => spec.id === template?.resources[1] && spec.kind === 'model')
      if (!template || !fixed || imageModelWarning(template, fixed)) return failure('固定兼容配方不可用，请更新插件后重试')
      const { directoryResources: _directoryResources, ...base } = structuredClone(template)
      const model = projectCustom({
        ...base, id, title: 'Z-Image Turbo · 兼容版', custom: true, acquisition: 'import',
        origin: { source: 'huggingface', repository: zImageTurbo.repository, revision: zImageTurbo.revision },
        directoryHint: '选择直接包含指定 diffusion GGUF、Qwen3 文本编码器 GGUF 和 FLUX ae.safetensors 三个文件的 model 目录。',
        resources: [base.resources[0], resourceId],
      })
      const specification = { ...structuredClone(fixed), id: resourceId, files: fixed.files.map(file => ({ ...file, source: file.path })) }
      await save({ ...settings, custom: [...settings.custom, { model, specification }], models: { ...persisted?.models, [id]: configurationFor(model) } })
      catalog.models.push(model); specifications.push(specification)
      return { ok: true, modelId: id }
    } catch (error) { return failure(error.message || '添加兼容版失败，请重试') }
  }))
  register('activate-model', mutate(async input => {
    const model = catalog.models.find(model => model.id === input.modelId)
    if (!model) return failure('模型不存在')
    if (platformWarning(model)) return failure(platformWarning(model))
    if (imageWarning(model)) return failure(imageWarning(model))
    if (compatibility(currentModel(model))) return failure(compatibility(currentModel(model)))
    const binding = bindingFor(model, settings.models[model.id], await context.inference.resources.list())
    if (!binding) return failure('请先准备模型及引擎资源')
    const runtime = (await context.inference.status()).find(item => item.runtime === model.runtime)
    if (runtimeBusy(runtime)) return failure('当前模型正在使用，请等待任务结束后再切换')
    const previous = bindings.get(model.runtime)
    await bind(binding)
    try { await save({ ...settings, active: { ...settings.active, [model.runtime]: model.id } }) }
    catch (error) {
      try {
        if (previous) await bind(JSON.parse(previous))
        else {
          await context.inference.unbind({ runtime: model.runtime })
          bindings.delete(model.runtime)
        }
      } catch {
        bindings.delete(model.runtime)
        throw new Error(`${error.message || '模型选择保存失败'}；运行绑定恢复失败，当前绑定状态未确认，请停止模型后重试`, { cause: error })
      }
      throw error
    }
    activationMessages.delete(model.id)
    return { ok: true, ...(visionWarning(model) ? { warning: visionWarning(model) } : {}) }
  }))
  const validateService = (service, input) => {
    const result = validateConfiguration(service, input)
    if (result.error) return result
    let url
    try { url = new URL(result.configuration.baseUrl) }
    catch { return failure('请输入完整的 API 基础地址') }
    if (url.username || url.password || url.search || url.hash) return failure('服务地址不能包含凭据、查询参数或片段')
    if (!manifest.permissions.inferenceNetwork.includes(url.origin)) return failure('此服务来源尚未授权，请使用已授权地址')
    result.configuration.baseUrl = url.href.replace(/\/+$/, '')
    return result
  }
  const readCredential = async (service, configuration) => {
    if (configuration.auth !== 'bearer') return { hasCredential: false, credentialError: null }
    try {
      return { hasCredential: await context.inference.credentials.has({ id: service.id, origin: new URL(configuration.baseUrl).origin }), credentialError: null }
    }
    catch {
      return { hasCredential: null, credentialError: '暂时无法读取密钥，请检查系统密钥库后重试。' }
    }
  }
  const unbindService = async (service) => {
    try { await context.inference.unbind({ runtime: service.runtime }) }
    finally { bindings.delete(service.runtime) }
  }

  register('status', async () => {
    const revision = mutationRevision
    const [resources, runtimes, refreshed] = supported ? await Promise.all([context.inference.resources.list(), context.inference.status(), inferenceEnvironment(context.inference).catch(() => null)]) : [[], [], null]
    if (refreshed?.platform === platform && refreshed.executionMode === environment.executionMode) environment = refreshed
    return {
      supported, environment, compatibilityMessage, resumableDownloads, specifications,
      engines: specifications.filter(spec => spec.kind === 'engine').map(spec => ({ id: spec.id, ...(spec.engineId ? { engineId: spec.engineId } : {}), ...(spec.title ? { title: spec.title } : {}), ...(spec.version ? { version: spec.version } : {}), ...(spec.backend ? { backend: spec.backend } : {}), custom: spec.custom === true, installed: !!authorized(resources, spec.id, settings.resourceRevisions[spec.id]), selected: spec.engineId ? settings.engineSelections[engineKey(spec)] === spec.id : true, capabilities: spec.engineId === 'llama.cpp' ? ['对话', '图片理解'] : [...new Set(templates.filter(model => [...model.resources, ...(model.directoryResources ?? [])].includes(spec.id)).flatMap(model => model.capabilities))] })),
      models: catalog.models.map((original) => {
        const model = currentModel(original)
        const compatibilityWarning = compatibility(model)
        const active = settings.active[model.runtime] === model.id
        const sharedRuntime = runtimes.find(item => item.runtime === model.runtime)
        const expectedBinding = bindingFor(original, settings.models[original.id], resources)
        const runtime = active && revision % 2 === 0 && revision === mutationRevision && expectedBinding && bindings.get(model.runtime) === JSON.stringify(expectedBinding) ? sharedRuntime : undefined
        const activeResources = modelResources(model, resources, settings.resourceRevisions)
        const missingResources = activeResources.filter(id => !authorized(resources, id, settings.resourceRevisions[id]))
        const fileIds = activeResources.filter(id => specifications.find(spec => spec.id === id)?.kind === 'model')
        const filesReady = fileIds.length > 0 && fileIds.every(id => authorized(resources, id, settings.resourceRevisions[id]))
        const filesRegistered = fileIds.some(id => resources.some(resource => resource.id === id))
        const instances = runtime?.instances ?? []
        const observation = instances.filter(instance => instance.observation).sort((a, b) => b.observation.observedAt - a.observation.observedAt)[0]?.observation
        const recommendation = recommendationFor({ ...model, instances })
        return { ...model, recommendation, ...(observation ? { runtimeObservation: observation } : {}), compatibilityWarning, capabilities: visionWarning(model) ? model.capabilities.filter(capability => !['对话', '图片输入'].includes(capability)) : model.capabilities, filesReady, filesRegistered, activationWarning: activationMessages.get(model.id) || '', bindingWarning: [platformWarning(model), imageWarning(model), activationMessages.get(model.id), visionWarning(model), active ? toolWarning(model) : ''].filter(Boolean).join(' '), active, runtimeBusy: runtimeBusy(sharedRuntime), configuration: configurationFor(model, settings.models[model.id]), prepared: supported && !compatibilityWarning && !platformWarning(model) && !imageWarning(model) && missingResources.length === 0, bound: supported && !compatibilityWarning && !platformWarning(model) && !imageWarning(model) && (runtime?.configured ?? false), state: !supported || platformWarning(model) ? 'unsupported' : imageWarning(model) ? 'unverified' : runtimeState(runtime, missingResources.length === 0), instances: runtime?.instances ?? [], activeResources, missingResources }
      }),
      services: await Promise.all(catalog.services.map(async (service) => {
        const runtime = runtimes.find(item => item.runtime === service.runtime)
        const { configuration, enabled, credentialPending } = settings.services[service.id]
        const credential = supported ? await readCredential(service, configuration) : { hasCredential: null, credentialError: null }
        const credentialPresent = credential.hasCredential
        const bound = supported && enabled && !credentialPending && !credential.credentialError && (configuration.auth === 'none' || credentialPresent === true) && (runtime?.configured ?? false) && bindings.get(service.runtime) === JSON.stringify(serviceBinding(service, configuration))
        const activationMessage = credential.credentialError ?? activationMessages.get(service.id) ?? (credentialPending ? '上次密钥保存尚未完成，请重新填写密钥并保存。' : enabled && configuration.auth === 'bearer' && !credentialPresent ? '请填写当前服务的密钥并保存。' : enabled && !bound ? '配置已保存，请再次保存以激活服务。' : '')
        return { ...service, configuration, configured: enabled, bound, credentialPending, ...credential, activationMessage, state: !supported ? 'unsupported' : enabled && !bound ? 'pending' : runtimeState(runtime, bound), instances: runtime?.instances ?? [] }
      })),
      resources, runtimes, job, downloadHistory, historyWarning,
    }
  })

  register('configure', mutate(async (input) => {
    const model = catalog.models.find(model => model.id === input.modelId)
    if (!model) return failure('请选择需要设置的模型')
    const result = validateConfiguration(model, input.configuration)
    if (result.error) return result
    if (settings.active[model.runtime] === model.id) {
      const runtime = (await context.inference.status()).find(item => item.runtime === model.runtime)
      if (runtimeBusy(runtime)) return failure('当前模型正在使用，请等待任务结束后再修改参数')
    }
    const previous = settings.models[model.id]
    try {
      await applyModel(model, result.configuration)
      await save({ ...settings, models: { ...settings.models, [model.id]: { ...previous, ...result.configuration } } })
    }
    catch (error) { await applyModel(model, previous); throw error }
    return success()
  }))

  register('stop', async (input) => {
    if (!!input.modelId === !!input.serviceId) return failure('请选择需要停止的模型或服务')
    const target = input.modelId ? catalog.models.find(model => model.id === input.modelId) : catalog.services.find(service => service.id === input.serviceId)
    if (!target) return failure('模型或服务不存在')
    if (input.modelId && settings.active[target.runtime] !== target.id) return success()
    await context.inference.stop({ runtime: target.runtime })
    return success()
  })

  register('clear', mutate(async (input) => {
    const model = catalog.models.find(model => model.id === input.modelId)
    if (!model) return failure('请选择需要清理的模型')
    if (settings.active[model.runtime] === model.id) await context.inference.stop({ runtime: model.runtime })
    const [resources, runtimes] = await Promise.all([context.inference.resources.list(), context.inference.status()])
    const protectedIds = new Set(catalog.models.filter(other => other.id !== model.id && (runtimes.some(runtime => runtime.runtime === other.runtime && runtime.configured) || other.resources.some(id => specifications.find(specification => specification.id === id)?.kind === 'model' && authorized(resources, id)))).flatMap(other => [...other.resources, ...(other.directoryResources ?? [])]))
    const candidates = [...new Set([...model.resources, ...(model.directoryResources ?? [])])].filter(id => specifications.find(spec => spec.id === id)?.kind === 'model')
    const removedResources = []
    const retainedResources = []
    for (const id of candidates) {
      if (protectedIds.has(id)) { retainedResources.push(id); continue }
      for (const resource of resources.filter(item => item.id === id)) {
        await context.inference.resources.remove({ id, revision: resource.revision })
        for (const [runtime, serialized] of bindings) {
          if (JSON.parse(serialized).resources.some(item => item.id === id && item.revision === resource.revision)) bindings.delete(runtime)
        }
      }
      removedResources.push(id)
    }
    return { ok: true, removedResources, retainedResources }
  }))

  register('remove-record', mutate(async input => {
    const model = catalog.models.find(model => model.id === input.modelId && model.custom)
    if (!model) return failure('请选择尚未下载或导入的模型记录')
    const resources = await context.inference.resources.list()
    if (resources.some(resource => model.resources.includes(resource.id) && specifications.find(spec => spec.id === resource.id)?.kind === 'model')) return failure('模型仍有资源记录，请先处理模型文件')
    const models = { ...settings.models }
    delete models[model.id]
    const active = Object.fromEntries(Object.entries(settings.active).filter(([, id]) => id !== model.id))
    await save({ ...settings, active, custom: settings.custom.filter(item => item.model.id !== model.id), models })
    catalog.models = catalog.models.filter(item => item.id !== model.id)
    specifications = specifications.filter(spec => spec.kind === 'engine' || !model.resources.includes(spec.id))
    if (job?.modelId === model.id) publish(null)
    return success()
  }))

  register('cancel-preparation', () => {
    if (job?.state === 'committing') return failure('文件已校验，正在保存模型；此阶段不能取消')
    resolution?.abort(new Error('已取消模型添加'))
    if (preparation) { preparation.abort(); publish({ ...job, state: 'cancelling', ...(job?.id ? { updatedAt: Date.now() } : {}) }) }
    return success()
  })

  register('prepare', mutate(async (input) => {
    const model = currentModel(catalog.models.find(model => model.id === input.modelId))
    const mode = input.mode ?? 'download'
    const scope = input.scope ?? 'all'
    const allowedIds = new Set(model ? [...model.resources, ...(model.directoryResources ?? [])] : specifications.filter(spec => spec.kind === 'engine').map(spec => spec.id))
    const target = specifications.find(resource => resource.id === input.resourceId && allowedIds.has(resource.id))
    if ((!model && (!target || input.modelId || mode === 'directory')) || !['model', 'all'].includes(scope)) return failure('请选择需要准备的模型或引擎')
    if (!['directory', 'file', 'download'].includes(mode) || (input.resourceId && !target) || (mode === 'directory' && typeof input.directoryId !== 'string') || (mode === 'file' && !target) || (mode !== 'directory' && target?.legacy)) return failure('请选择需要准备的资源和对应文件')
    if (mode === 'file') {
      const expected = target.archives ?? target.files
      const supplied = target.archives ? input.archives : input.files
      if (!Array.isArray(supplied) || supplied.length !== expected.length || !expected.every(file => supplied.filter(item => item?.id === (file.id ?? file.path) && typeof item.resourceId === 'string').length === 1)) return failure('请为每个资源文件选择对应的官方文件')
    }
    const recordHistory = mode === 'download' && model && target?.kind !== 'engine'
    const retry = recordHistory && downloadHistory.find(record => record.id === input.retryId && record.modelId === model.id && ['failed', 'cancelled', 'interrupted'].includes(record.state))
    if (input.retryId !== undefined && !retry) return failure('此下载记录无法重试，请刷新后选择未完成的下载')
    const controller = new AbortController()
    preparation = controller
    const signal = AbortSignal.any([controller.signal, context.signal])
    const startedAt = Date.now()
    const jobTarget = { id: retry ? retry.id : `${startedAt.toString(36)}-${++jobSequence}-${Math.random().toString(36).slice(2, 10)}`, ...(model ? { modelId: model.id } : {}), ...(target ? { resourceId: target.id } : {}), mode }
    let metrics
    publish({ ...jobTarget, startedAt, updatedAt: startedAt, lastReceivedAt: null, downloadedBytes: 0, totalBytes: null, bytesPerSecond: 0, phase: 'preparing', state: 'preparing', progress: null })
    const updateHistory = async endedAt => {
      if (!recordHistory) return
      downloadHistory = boundDownloadHistory([historyRecord(job, model.title, endedAt), ...downloadHistory.filter(record => record.id !== job.id)])
      await saveHistory()
    }
    await updateHistory(null)
    try {
      const existing = await context.inference.resources.list()
      const ids = target ? [target.id] : mode === 'directory' ? model.directoryResources ?? model.resources : model.resources
      const selected = ids.map(id => specifications.find(resource => resource.id === id)).filter(resource => resource && (target || scope === 'all' || resource.kind === 'model') && (target || !authorized(existing, resource.id, settings.resourceRevisions[resource.id])))
      if (selected.some(resource => resource.kind === 'engine') && JSON.stringify(persisted?.engineSelections?.[platform]) !== JSON.stringify(settings.engineSelections)) await save(settings)
      metrics = createDownloadProgress(selected, mode, startedAt)
      publish({ ...jobTarget, ...metrics.snapshot(), state: signal.aborted ? 'cancelling' : 'preparing', progress: null })
      for (const resource of selected) {
        signal.throwIfAborted()
        if (mode === 'download' && !resource.archives && resource.files.some(file => !file.url)) throw Error('本地导入的模型没有下载来源，请重新选择原文件导入')
        const copiedParts = new Set(mode === 'file' ? groupGgufFiles(resource.files).flatMap(file => file.parts?.map(part => part.path) ?? []) : [])
        const archives = mode === 'directory' ? undefined : resource.archives?.map(({ name: _name, ...archive }) => ({ ...archive, source: mode === 'file' ? { resourceId: input.archives.find(item => item.id === archive.id).resourceId } : archive.source }))
        const files = archives ? [] : resource.files.map(file => ({
          path: file.path, sha256: file.sha256,
          ...(mode === 'download' && exactFileSize(file) !== null ? { size: exactFileSize(file) } : {}),
          ...(file.executable ? { executable: true } : {}),
          source: mode === 'directory' ? { directoryId: input.directoryId, path: scope === 'model' && resource.kind === 'model' ? file.path : file.source, reference: true }
            : mode === 'file' ? { resourceId: input.files?.find(item => item.id === file.path)?.resourceId, ...(copiedParts.has(file.path) ? {} : { reference: true }) } : { url: file.url },
        }))
        const multiplicity = Math.max(1, ...resource.files.map(file => resource.files.filter(other => other.archive === file.archive && other.archivePath === file.archivePath).length))
        const request = {
          id: resource.id, kind: resource.kind,
          files: archives ? [] : files,
          ...(archives ? { preparation: {
            inputs: archives.map(({ id, sha256, size, source }) => ({ id, sha256, size, source })),
            options: { archives: archives.map(({ id, unpackedBytes, modelDirectory }) => ({ id, unpackedBytes, ...(modelDirectory ? { modelDirectory } : {}) })), files: resource.files },
            maxBytes: Math.min(64 * 1024 ** 3, archives.reduce((sum, archive) => sum + archive.unpackedBytes, 0) * multiplicity),
            maxFiles: archives.some(archive => archive.modelDirectory) ? 4096 : resource.files.length,
          } } : {}),
        }
        try {
          const prepared = await context.inference.resources.prepare(request, { signal, onProgress: progress => publish({ ...jobTarget, ...metrics.update(resource.id, progress), state: signal.aborted ? 'cancelling' : 'preparing', progress }) })
          if (prepared?.id === resource.id && typeof prepared.revision === 'string') {
            await writing.catch(() => {})
            settings = { ...settings, resourceRevisions: { ...settings.resourceRevisions, [prepared.id]: prepared.revision } }
          }
        }
        catch (error) {
          if (files.some(file => file.size !== undefined) && `${error?.code ?? ''} ${error?.message ?? ''}`.includes('EXTENSION_INVALID_ARGUMENT')) throw Error('当前 Lexora 不支持带精确大小的模型下载，请更新 Lexora 后重试；未降级忽略文件大小。')
          throw error
        }
      }
      signal.throwIfAborted()
      const warnings = []
      if (!recordHistory && JSON.stringify(settings.resourceRevisions) !== JSON.stringify(persisted?.resourceRevisions ?? {})) {
        try {
          await enqueueSave((current, previous) => {
            const fitted = fitStorage({ ...previous, resourceRevisions: current.resourceRevisions })
            const next = { ...current }
            for (const key of ['discoveryCache', 'downloadHistory']) {
              if (Object.hasOwn(fitted.value, key)) next[key] = fitted.value[key]
              else delete next[key]
            }
            return { ...fitted, settings: next }
          })
        } catch { warnings.push('资源已准备，但修订信息未能保存；请检查存储空间并重新准备，当前会话仍使用本次修订') }
      }
      for (const candidate of model ? [model] : catalog.models.filter(candidate => currentModel(candidate).resources.includes(target.id))) {
        try { await applyModel(candidate); activationMessages.delete(candidate.id) }
        catch {
          const warning = '资源已准备，当前运行绑定未切换；请在任务结束后重新启用此模型'
          activationMessages.set(candidate.id, warning)
          warnings.push(warning)
        }
      }
      const warning = [...new Set(warnings)].join(' ')
      publish({ ...jobTarget, ...metrics.finish(true), state: 'completed', progress: null, ...(warning ? { message: warning } : {}) })
      await updateHistory(Date.now())
      return { ok: true, ...(warning ? { warning } : {}), ...(recordHistory && historyWarning ? { historyWarning } : {}) }
    }
    catch (error) {
      const code = error?.message ?? ''
      const message = signal.aborted ? mode === 'download' && resumableDownloads ? '已取消，重试时会优先续传已保留的文件' : '已取消，已完成的资源会保留'
        : code.includes('CHECKSUM') ? '文件校验失败，请使用本页指定版本；原有资源已保留'
          : code.includes('ARCHIVE') ? '压缩包内容不完整或格式不支持，请选择本页指定的官方文件'
            : code.includes('NETWORK_DENIED') ? '下载来源尚未授权，请手动导入官方文件'
              : code.includes('DOWNLOAD') || code.includes('NETWORK') ? '下载未完成，可重试或手动导入文件'
                : code.startsWith('本地导入') || code.startsWith('当前 Lexora 不支持') ? code : '资源准备失败，请检查文件、可用磁盘空间和授权后重试'
      publish({ ...job, ...(metrics?.finish(false) ?? { updatedAt: Date.now(), bytesPerSecond: 0 }), state: signal.aborted ? 'cancelled' : 'failed', progress: null, message })
      await updateHistory(Date.now())
      return { ...failure(message), ...(recordHistory && historyWarning ? { historyWarning } : {}) }
    }
    finally { preparation = undefined }
  }))

  register('configure-service', mutate(async (input) => {
    const service = catalog.services.find(service => service.id === input.serviceId)
    if (!service || !settings.services[service.id]?.enabled) return failure('请在设置的模型服务中添加连接')
    const result = validateService(service, input.configuration)
    if (result.error) return result
    const { configuration } = result
    if (input.token && (typeof input.token !== 'string' || configuration.auth !== 'bearer')) return failure('填写密钥时请选择 Bearer 认证')
    if (configuration.auth === 'bearer' && !input.token && settings.services[service.id].credentialPending) return failure('上次密钥保存尚未完成，请重新填写密钥')
    if (configuration.auth === 'bearer' && !input.token) {
      const credential = await readCredential(service, configuration)
      if (credential.credentialError) return failure(credential.credentialError)
      if (!credential.hasCredential) return failure('请为当前服务填写密钥')
    }
    let stage = 'unbind'
    try {
      await unbindService(service)
      stage = 'configuration'
      await save({ ...settings, services: { ...settings.services, [service.id]: { enabled: true, credentialPending: !!input.token, configuration } } })
      if (input.token) {
        stage = 'credential'
        await context.inference.credentials.set({ id: service.id, origin: new URL(configuration.baseUrl).origin, token: input.token })
        stage = 'credential-state'
        await save({ ...settings, services: { ...settings.services, [service.id]: { enabled: true, credentialPending: false, configuration } } })
      }
      stage = 'binding'
      await bind(serviceBinding(service, configuration))
      activationMessages.delete(service.id)
    }
    catch {
      const message = stage === 'unbind' ? '暂时无法停止此服务，配置尚未修改，请稍后重试。'
        : stage === 'configuration' ? '服务已停止，配置保存失败，请重新保存。'
          : stage === 'credential' ? '配置已保存，但密钥保存失败，服务尚未激活。请重新填写密钥并保存。'
            : stage === 'credential-state' ? '密钥已保存，但配置状态保存失败，服务尚未激活。请重新填写密钥并保存。'
              : '配置已保存，但服务激活失败。请再次保存重试。'
      activationMessages.set(service.id, message)
      return failure(message)
    }
    return success()
  }))

  register('remove-credential', mutate(async (input) => {
    const service = catalog.services.find(service => service.id === input.serviceId)
    if (!service) return failure('请选择需要移除密钥的服务')
    await unbindService(service)
    await context.inference.credentials.remove(service.id)
    activationMessages.set(service.id, '服务已停止，密钥已移除。请检查认证方式并重新保存。')
    return success()
  }))

  if (!supported) return
  for (const model of catalog.models) {
    try { await applyModel(model) }
    catch { activationMessages.set(model.id, '当前运行绑定未切换；请在任务结束后重新启用此模型') }
  }
  for (const service of catalog.services) {
    const storedService = settings.services[service.id]
    if (!storedService.enabled || storedService.credentialPending) continue
    const result = validateService(service, storedService.configuration)
    if (result.error) continue
    const credential = await readCredential(service, result.configuration)
    if (credential.credentialError) continue
    if (result.configuration.auth === 'bearer' && !credential.hasCredential) continue
    try { await bind(serviceBinding(service, result.configuration)) }
    catch { activationMessages.set(service.id, '配置已保存，但服务激活失败。请再次保存重试。') }
  }
}
