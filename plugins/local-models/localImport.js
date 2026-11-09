import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { recipes } from './discovery.js'
import { checkAbort, parseFile, safePath } from './localImportFormats.js'

const maxFiles = 4096
const parent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const join = (directory, name) => directory ? `${directory}/${name}` : name
const digest = value => bytesToHex(sha256(new TextEncoder().encode(value)))
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const localTitle = file => file.info.title || file.name.replace(/\.(gguf|onnx|safetensors|traineddata)$/i, '')
const choice = file => ({ id: file.id, path: file.path, name: file.name, bytes: file.bytes })
const sameFile = (a, b) => a.id === b.id && a.path === b.path && a.name === b.name && a.bytes === b.bytes
const invalidated = () => Error('本地文件或授权已变化，请重新选择并识别；重启前的句柄不能直接复用')
const warningLimit = 32

async function authorizedFiles(context, signal) {
  checkAbort(signal)
  const resources = await context.resources.listFiles()
  checkAbort(signal)
  if (!Array.isArray(resources)) throw Error('宿主返回的资源列表不合法')
  const files = new Map()
  for (const item of resources) {
    if (!item || typeof item.id !== 'string' || !item.id || files.has(item.id)) throw Error('宿主返回了无效或重复的资源句柄')
    files.set(item.id, item)
  }
  return files
}
function normalize(resource) {
  const path = resource.relativePath ?? resource.name
  if (!safePath(path) || typeof resource.name !== 'string' || resource.name.includes('/') || !safePath(resource.name) || path.split('/').at(-1) !== resource.name) throw Error('资源路径不合法：只接受授权根内的相对路径，不接受绝对路径或目录穿越')
  if (!Number.isSafeInteger(resource.size) || resource.size <= 0) throw Error(`文件大小不合法：${resource.name}`)
  return { id: resource.id, path, name: resource.name, bytes: resource.size }
}
function companionsFor(files, model) {
  const prefix = `${join(parent(model.path), 'espeak-ng-data')}/`
  return files.filter(file => file.info.format === 'espeak' && file.path.startsWith(prefix))
}
function espeakMissing(files, model) {
  const prefix = `${join(parent(model.path), 'espeak-ng-data')}/`, paths = new Set(files.map(f => f.path))
  const missing = ['phontab', 'phonindex', 'phondata', 'intonations', 'en_dict'].filter(name => !paths.has(prefix + name))
  if (!files.some(f => f.path.startsWith(`${prefix}lang/`))) missing.push('lang/')
  return missing.map(name => `espeak-ng-data/${name}`)
}
function matches(recipe, role, file) {
  const info = file.info
  if (recipe === 'chat') return info.format === 'gguf' && info.role === 'model'
  if (recipe === 'vision') return info.format === 'gguf' && info.role === role
  if (recipe === 'asr') return role === 'tokens' ? info.format === 'tokens' : info.format === 'onnx' && (!info.role || info.role === role) && info.family !== 'kokoro'
  if (recipe === 'tts') return role === 'model' ? info.format === 'onnx' && (!info.role || info.family === 'kokoro') : info.role === role && ['voices', 'tokens', 'lexicon'].includes(info.format)
  if (recipe === 'image') return info.format === 'safetensors'
  return info.format === 'traineddata'
}
function validatePairing(recipe, selected, companions) {
  const primary = selected.model ?? selected.encoder ?? selected.language
  if (Object.values(selected).some(file => parent(file.path) !== parent(primary.path))) throw Error('配套文件必须来自同一相对目录，请重新选择完整模型目录')
  if (recipe === 'vision') {
    const family = selected.projector.info.family, architecture = selected.model.info.architecture
    if ([family, architecture].every(value => ['qwen2vl', 'qwen3vl'].includes(value)) && family !== architecture) throw Error('视觉模型与投影架构不匹配')
  }
  if (recipe === 'asr') {
    const { encoder, decoder, joiner, tokens } = selected
    if (tokens.info.maxId !== tokens.info.vocab - 1 || [decoder.info.vocab, joiner.info.vocab].some(vocab => vocab && vocab !== tokens.info.vocab) || [encoder.info.width, decoder.info.width].some((width, i) => width && joiner.info.widths?.[i] && width !== joiner.info.widths[i])) throw Error('Zipformer 编解码器、连接器维度或词表不匹配')
  }
  if (recipe === 'tts') {
    if (selected.model.info.voicesBytes && selected.voices.bytes !== selected.model.info.voicesBytes) throw Error('Kokoro 音色文件大小与模型 style_dim/n_speakers 不匹配')
    const missing = espeakMissing(companions, selected.model)
    if (missing.length) throw Error(`Kokoro 配套数据不完整：${missing.join('、')}`)
  }
}

export function createLocalImport(context) {
  const snapshots = new Map()
  async function inspect(input, { signal = context.signal } = {}) {
    const { resourceIds } = input ?? {}
    checkAbort(signal)
    if (!Array.isArray(resourceIds) || !resourceIds.length || resourceIds.length > maxFiles || resourceIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(resourceIds).size !== resourceIds.length) throw Error('请选择 1–4096 个不重复的授权文件句柄')
    const authorized = await authorizedFiles(context, signal)
    const files = resourceIds.map(id => {
      const resource = authorized.get(id)
      if (!resource) throw invalidated()
      return normalize(resource)
    })
    if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length) throw Error('所选资源包含重复或大小写冲突的相对路径，请按模型目录分别导入')
    const budget = { bytes: 0 }, parsed = [], warnings = []
    for (const file of files) {
      checkAbort(signal)
      try { parsed.push({ ...file, info: await parseFile(context, file, signal, budget) }) }
      catch (error) {
        checkAbort(signal)
        if (warnings.length < warningLimit) warnings.push(`${file.path}：${error.message}`)
      }
      if (budget.bytes > 64 * 1024 ** 2) throw Error('所选文件元数据总量超过 64 MiB 解析上限，请缩小选择范围')
    }
    if (!parsed.length) throw Error(`未识别到可用的本地模型。${warnings.slice(0, 8).join('；') || '请选择支持的完整模型文件。'}`)
    const candidates = []
    for (const recipe of recipes) {
      const roleDefinitions = recipe.id === 'image' ? [{ id: 'model', title: '完整检查点', optional: false }] : recipe.roles
      const roles = roleDefinitions.map(role => ({ id: role.id, title: role.title, optional: role.optional, choices: parsed.filter(file => matches(recipe.id, role.id, file)).map(choice) }))
      const anchor = recipe.id === 'asr' ? 'encoder' : recipe.id === 'ocr' ? 'language' : 'model'
      const anchors = parsed.filter(file => matches(recipe.id, anchor, file))
      const missing = roles.filter(role => !role.optional && !role.choices.length).map(role => role.title)
      const notes = [...warnings]
      if (recipe.id === 'asr') notes.push('当前转写引擎使用流式 Zipformer/Zipformer2，配套文件必须同目录且维度一致。')
      if (recipe.id === 'vision') notes.push('视觉投影须与所选模型配套。')
      let companionFiles
      if (recipe.id === 'tts') {
        companionFiles = [...new Map(anchors.flatMap(model => companionsFor(parsed, model)).map(file => [file.id, choice(file)])).values()]
        if (anchors.every(model => espeakMissing(companionsFor(parsed, model), model).length)) missing.push('完整 espeak-ng-data（phontab、phonindex、phondata、intonations、en_dict、lang/）')
        notes.push('音色按模型 style_dim/n_speakers 校验；仅支持 sherpa 导出的内嵌权重 Kokoro。配套数据需同目录。')
      }
      if (recipe.id === 'image') notes.push('只接收 LDM 命名的 SD1/SDXL base 完整 safetensors；结构检查不是一次真实推理验收。')
      const candidate = { recipe: recipe.id, title: anchors.length === 1 ? localTitle(anchors[0]) : `本地${recipe.title}模型`, roles, ...(companionFiles ? { companionFiles } : {}), missing, ...(notes.length ? { warnings: notes } : {}) }
      candidates.push(candidate)
    }
    const vision = parsed.some(file => file.info.format === 'gguf' && (file.info.vision || file.info.role === 'projector'))
    const detected = vision ? 'vision' : parsed.some(file => file.info.family === 'kokoro') ? 'tts' : parsed.some(file => file.info.format === 'onnx' && file.info.role) ? 'asr' : null
    const defaultRecipe = detected ?? candidates.find(item => !item.missing.length)?.recipe ?? candidates.find(item => item.roles.some(role => role.choices.length))?.recipe ?? 'chat'
    checkAbort(signal)
    const token = globalThis.crypto.randomUUID()
    snapshots.set(token, { files: parsed, candidates, created: Date.now() })
    while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value)
    return JSON.parse(JSON.stringify({ token, defaultRecipe, candidates }))
  }
  async function resolve(input, { signal = context.signal, onProgress = undefined } = {}) {
    const { token, recipe, selection, title } = input ?? {}
    checkAbort(signal)
    const snapshot = snapshots.get(token), candidate = snapshot?.candidates.find(item => item.recipe === recipe)
    if (!snapshot || !candidate || Date.now() - snapshot.created > 30 * 60 * 1000) throw Error('本地识别快照已失效，请重新选择文件并识别')
    if (candidate.missing.length) throw Error(`模型缺少必要文件：${candidate.missing.join('、')}`)
    if (!plain(selection) || Object.keys(selection).some(key => !candidate.roles.some(role => role.id === key))) throw Error('文件角色选择不合法，不能增加角色或提交路径')
    const selected = Object.create(null)
    for (const role of candidate.roles) {
      const id = selection[role.id]
      if (id === undefined || id === null || id === '') {
        if (!role.optional) throw Error(`请选择${role.title}`)
        continue
      }
      if (typeof id !== 'string' || !role.choices.some(file => file.id === id)) throw Error(`${role.title}不是此快照内的合法文件句柄`)
      selected[role.id] = snapshot.files.find(file => file.id === id)
    }
    if (new Set(Object.values(selected).map(file => file.id)).size !== Object.values(selected).length) throw Error('同一文件不能重复填入多个角色')
    const companions = recipe === 'tts' ? companionsFor(snapshot.files, selected.model) : []
    validatePairing(recipe, selected, companions)
    if (typeof context.resources.hash !== 'function') throw Error('当前宿主缺少 resources.hash；请升级 Lexora 后导入大型本地模型，不会下载、复制或回退到分块散列')
    const files = [...Object.values(selected), ...companions].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const authorized = await authorizedFiles(context, signal)
    for (const file of files) {
      const current = authorized.get(file.id)
      if (!current || !sameFile(file, normalize(current))) throw invalidated()
    }
    const hashes = new Map(), budget = { bytes: 0 }
    let completedBytes = 0
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    if (!Number.isSafeInteger(totalBytes)) throw Error('模型总大小超过安全范围')
    for (let i = 0; i < files.length; i++) {
      checkAbort(signal)
      const file = files[i]
      onProgress?.({ phase: 'hashing', completedFiles: i, totalFiles: files.length, completedBytes, totalBytes, path: file.path })
      checkAbort(signal)
      const info = await parseFile(context, file, signal, budget)
      if (JSON.stringify(info) !== JSON.stringify(file.info)) throw invalidated()
      const result = await context.resources.hash({ id: file.id }, { signal })
      checkAbort(signal)
      if (!result || !/^[a-f0-9]{64}$/i.test(result.sha256) || result.size !== file.bytes) throw Error('文件摘要或大小校验失败，请重新选择')
      hashes.set(file.id, result.sha256.toLowerCase()); completedBytes += file.bytes
    }
    const fresh = await authorizedFiles(context, signal)
    const verificationBudget = { bytes: 0 }
    for (const file of files) {
      if (!fresh.has(file.id) || !sameFile(file, normalize(fresh.get(file.id)))) throw invalidated()
      const info = await parseFile(context, file, signal, verificationBudget)
      if (JSON.stringify(info) !== JSON.stringify(file.info)) throw invalidated()
    }
    checkAbort(signal)
    const identity = [recipe, Object.entries(selected).sort(([a], [b]) => a < b ? -1 : 1).map(([role, file]) => [role, hashes.get(file.id)]), companions.map(file => [file.path.split('espeak-ng-data/').at(-1), hashes.get(file.id)]).sort(([a], [b]) => a < b ? -1 : 1)]
    const id = `local-${digest(JSON.stringify(identity)).slice(0, 32)}`
    const name = typeof title === 'string' && title.trim() ? title.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : candidate.title.slice(0, 80)
    const pathFor = file => recipe === 'ocr' ? file.name.replace(/\.traineddata$/i, '.traineddata') : file.path
    const tags = [...new Set(files.map(file => file.info.format))]
    const result = {
      id, title: name || '本地模型', recipe,
      files: Object.fromEntries(Object.entries(selected).map(([role, file]) => [role, pathFor(file)])),
      ...(recipe === 'tts' ? { phonemes: join(parent(selected.model.path), 'espeak-ng-data') } : {}),
      ...(recipe === 'image' ? { imageArchitecture: 'checkpoint', imageValidation: { version: 1, kind: 'ldm-header', architecture: selected.model.info.architecture, sha256: hashes.get(selected.model.id) } } : {}),
      ...(recipe === 'ocr' ? { languages: selected.language.name.slice(0, -'.traineddata'.length) } : {}),
      metadata: { source: 'local', tags }, origin: { source: 'local' },
      specification: { id: `${id}-model`, kind: 'model', title: name || '本地模型', bytes: totalBytes, files: files.map(file => ({ path: pathFor(file), source: file.path, sha256: hashes.get(file.id), resourceId: file.id })) },
    }
    if (recipe === 'ocr' && !/^[a-zA-Z0-9_-]{1,80}$/.test(result.languages)) throw Error('OCR 语言文件名不受当前引擎支持，请使用 eng、chi_sim 等语言名')
    onProgress?.({ phase: 'hashing', completedFiles: files.length, totalFiles: files.length, completedBytes, totalBytes })
    checkAbort(signal)
    return result
  }
  return { inspect, resolve }
}
