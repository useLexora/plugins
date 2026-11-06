import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { huggingFaceCatalog } from './catalogSources.js'
import { createAvailabilityCache } from './discoveryCache.js'
import { huggingFaceBaseModels } from './modelToolSupport.js'
import { expandModelFiles, groupGgufFiles } from './modelFileGroups.js'
import { zImageTurbo, zImageTurboFiles } from './native/image/recipes.mjs'

const hf = 'https://huggingface.co'
const repositoryPattern = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/
const safePath = value => typeof value === 'string' && value.split('/').every(part => part && !['.', '..'].includes(part) && !/[\\<>:"|?*]/.test(part))
const encodedPath = value => value.split('/').map(encodeURIComponent).join('/')
const role = (id, title, pattern, optional = false) => ({ id, title, pattern, optional })
export const recipes = [
  { id: 'chat', title: '对话', engine: 'llama.cpp', roles: [role('model', '模型权重', /^(?!.*mmproj).*\.gguf$/i)] },
  { id: 'vision', title: '对话＋图片', engine: 'llama.cpp', roles: [role('model', '模型权重', /^(?!.*mmproj).*\.gguf$/i), role('projector', '视觉投影', /mmproj.*\.gguf$/i)] },
  { id: 'asr', title: '转写', engine: 'sherpa-onnx · Zipformer', roles: [role('encoder', '编码器', /(?:^|\/)encoder[^/]*\.onnx$/i), role('decoder', '解码器', /(?:^|\/)decoder[^/]*\.onnx$/i), role('joiner', '连接器', /(?:^|\/)joiner[^/]*\.onnx$/i), role('tokens', '词表', /(?:^|\/)tokens\.txt$/)] },
  { id: 'tts', title: '朗读', engine: 'sherpa-onnx · Kokoro', roles: [role('model', '模型权重', /\.onnx$/i), role('voices', '音色', /(?:^|\/)voices[^/]*\.bin$/i), role('tokens', '词表', /(?:^|\/)tokens\.txt$/), role('lexicon', '发音词典', /(?:^|\/)lexicon[^/]*\.txt$/, true)] },
  { id: 'image', title: '生图', engine: 'stable-diffusion.cpp', roles: [] },
  { id: 'ocr', title: '提字', engine: 'Tesseract', roles: [role('language', '语言数据', /\.traineddata$/)] },
]
const digest = value => bytesToHex(sha256(new TextEncoder().encode(value)))
const textValue = value => typeof value === 'string' && value.trim() ? value : null
const countValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
function hfMetadata(data) {
  const tags = Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : []
  const cardLicense = data.cardData?.license
  const licenses = (Array.isArray(cardLicense) ? cardLicense : [cardLicense]).filter(textValue)
  return {
    tags,
    baseModels: huggingFaceBaseModels(data),
    pipelineTag: textValue(data.pipeline_tag),
    libraryName: textValue(data.library_name),
    likes: countValue(data.likes),
    downloads: countValue(data.downloads),
    updated: textValue(data.lastModified),
    license: (licenses.length ? licenses : tags.filter(tag => tag.startsWith('license:')).map(tag => tag.slice(8)).filter(textValue)).join(', ') || null,
    gated: !!data.gated,
    source: 'huggingface',
  }
}
const siblingsOf = data => Array.isArray(data.siblings) ? data.siblings.filter(item => item && safePath(item.rfilename)) : []
const componentFile = path => /^(?:adapter|lora|controlnet|vae|text_encoder|clip|embedding)(?:[._-]|$)/i.test(path.split('/').at(-1))
const standaloneAdapter = data => /^(peft)$/i.test(data.library_name ?? '') || hfMetadata(data).tags.some(tag => /^(lora|peft|adapter|controlnet)$/i.test(tag)) || siblingsOf(data).some(item => /(?:^|\/)adapter_config\.json$/i.test(item.rfilename))
function classify(data, override = null) {
  if (override) return override
  const { tags, pipelineTag } = hfMetadata(data)
  const hasTask = (...tasks) => pipelineTag ? tasks.includes(pipelineTag) : tasks.some(task => tags.includes(task))
  if (data.id?.toLowerCase() === zImageTurbo.repository.toLowerCase() && data.sha === zImageTurbo.revision) return 'image'
  if (hasTask('image-text-to-text', 'image-to-text', 'visual-question-answering')) return 'vision'
  if (hasTask('text-generation', 'conversational', 'chat')) return tags.some(tag => ['vision', 'image-text-to-text', 'image-to-text', 'visual-question-answering'].includes(tag)) || siblingsOf(data).some(item => /mmproj.*\.gguf$/i.test(item.rfilename)) ? 'vision' : 'chat'
  if (hasTask('automatic-speech-recognition')) return 'asr'
  if (hasTask('text-to-speech', 'text-to-audio')) return 'tts'
  if (hasTask('text-to-image')) return 'image'
  if (!pipelineTag && siblingsOf(data).some(item => /\.gguf$/i.test(item.rfilename))) return siblingsOf(data).some(item => /mmproj.*\.gguf$/i.test(item.rfilename)) ? 'vision' : 'chat'
  return null
}
const hashBudget = 16 * 1024 ** 2
const hasHash = file => /^[a-f0-9]{64}$/.test(file.sha256 ?? '')
const fileCost = (file, unknown = Infinity) => hasHash(file) ? 0 : Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? file.bytes : unknown
const totalCost = (files, unknown = Infinity) => expandModelFiles(files).reduce((sum, file) => sum + fileCost(file, unknown), 0)
const hashReason = '来源未提供完整校验信息。可填写所选文件的 SHA-256 后下载，或下载后通过“导入本地模型”添加。'
const unknownHashReason = '文件大小或校验信息尚不完整；可重试读取、填写 SHA-256，或导入本地模型。'
function checksumSupport(roles, companionFiles) {
  const required = roles.filter(role => !role.optional)
  const cheapest = unknown => required.map(role => role.choices.reduce((best, file) => totalCost([file], unknown) < totalCost([best], unknown) ? file : best))
  if (totalCost([...companionFiles, ...cheapest(Infinity)]) <= hashBudget) return { state: 'installable', code: 'ready', reason: '已确认可选文件组合及校验信息；不代表本机运行或硬件兼容性。' }
  return { state: 'unverified', code: 'checksum', reason: totalCost([...companionFiles, ...cheapest(0)], 0) > hashBudget ? hashReason : unknownHashReason }
}
function modelFiles(data, repository = data.id) {
  return siblingsOf(data).map(item => ({ path: item.rfilename, bytes: item.size ?? item.lfs?.size ?? null, sha256: item.lfs?.sha256 ?? null, url: `${hf}/${repository}/resolve/${data.sha}/${encodedPath(item.rfilename)}` }))
}
function fileSupport(data, files, verified = false, override = null) {
  const metadata = hfMetadata(data)
  const recipeId = classify(data, override)
  const recipe = recipes.find(item => item.id === recipeId)
  const revision = /^[a-f0-9]{40}$/.test(data.sha) ? data.sha : null
  const imageRecipe = recipeId === 'image' && data.id?.toLowerCase() === zImageTurbo.repository.toLowerCase() && revision === zImageTurbo.revision
  const imageRequirement = '仅已验证的多组件配方可直接安装；其他图像权重需通过本地导入解析完整结构，不能由文件名或量化后缀判断兼容性。'
  const fullGguf = files.some(file => /\.gguf$/i.test(file.path) && !/mmproj/i.test(file.path) && !componentFile(file.path))
  const restriction = metadata.gated ? { code: 'access', reason: '请先在 Hugging Face 申请访问并下载文件，再通过“导入本地模型”添加。' } : standaloneAdapter(data) && !fullGguf ? { code: 'adapter', reason: '这是适配器，需要配套基础模型；可查找合并后的完整模型版本。' } : !recipe && metadata.pipelineTag ? { code: 'task', reason: `当前未接入 ${metadata.pipelineTag} 用途；若标签不准确，可手动选择加载方式尝试。` } : null
  let unavailableReason = restriction?.reason ?? (!revision ? '模型来源未提供可固定的版本，请重试读取信息或导入本地模型。' : !recipe ? '任务信息尚不完整；可手动选择加载方式，再选择对应文件尝试。' : !Array.isArray(data.siblings) ? '文件信息尚不完整，请重试读取或导入本地模型。' : null)
  let code = restriction?.code ?? 'metadata'
  if (!unavailableReason && recipeId === 'image' && !imageRecipe) {
    unavailableReason = '此仓库需要配置完整的生图组件。可下载所需组件后，通过“导入本地模型”选择文件。'
    code = 'components'
  }
  const roles = unavailableReason ? [] : imageRecipe ? zImageTurboFiles.map(expected => ({ id: expected.role, title: expected.title, optional: false, choices: expected.role === 'diffusion' ? files.filter(file => file.path === expected.path).map(file => ({ ...file, sha256: expected.sha256, bytes: expected.bytes })) : [{ ...expected }] })) : recipe.roles.map(role => ({ id: role.id, title: role.title, optional: role.optional, choices: groupGgufFiles(files.filter(file => role.pattern.test(file.path) && (override || role.id !== 'model' || !componentFile(file.path)))) }))
  const missing = roles.filter(role => !role.optional && !role.choices.length).map(role => role.title)
  const companionFiles = recipeId === 'tts' && !unavailableReason ? files.filter(file => /(?:^|\/)espeak-ng-data\//.test(file.path)) : []
  if (recipeId === 'tts' && !unavailableReason && !companionFiles.length) missing.push('espeak-ng-data')
  let availability = { state: restriction ? 'unsupported' : 'unverified', code, reason: unavailableReason ?? '已找到候选文件，可打开详情选择文件尝试；兼容性由实际加载结果确认。' }
  if (missing.length) {
    code = ['chat', 'vision'].includes(recipeId) && !files.some(file => /\.gguf$/i.test(file.path)) ? 'format' : 'components'
    unavailableReason = code === 'format' ? '当前对话引擎使用 GGUF；此仓库未提供 GGUF 权重。可查找同模型的 GGUF 版本，或导入已有文件。' : `需要补充${missing.join('、')}；可选择其他加载方式，或下载完整文件后导入。`
    availability = { state: 'unsupported', code, reason: unavailableReason }
  } else if (!unavailableReason && verified) {
    availability = checksumSupport(roles, companionFiles)
    if (availability.state === 'installable' && (override || !metadata.pipelineTag || standaloneAdapter(data))) availability = { state: 'installable', code: 'inferred', reason: '可尝试使用所选文件加载；未依赖来源标签保证架构兼容性，运行失败时可更换文件或加载方式。' }
  }
  return { recipe: recipeId, revision, roles, missing, unavailableReason, availability, companionFiles, engine: recipe?.engine ?? null, ...metadata, ...(recipeId === 'image' ? { requirement: imageRequirement, ...(imageRecipe ? { imageArchitecture: zImageTurbo.architecture } : {}) } : {}) }
}
function hfItem(data, availability) {
  return { key: `huggingface:${data.id}`, repository: data.id, title: data.id.split('/')[1], recipe: classify(data), ...hfMetadata(data), availability }
}
const boundParameters = url => JSON.stringify([...url.searchParams].filter(([key]) => key !== 'cursor').map(([key, value]) => [key === 'expand[]' ? 'expand' : key, value]).sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)))
function nextPageURL(link, firstURL) {
  if (link == null || link === '') return null
  if (typeof link !== 'string' || new TextEncoder().encode(link).length > 16 * 1024) throw Error('模型目录返回了无效的分页链接，请重试')
  const next = []
  for (const entry of link.split(/,(?=\s*<)/)) {
    const match = entry.match(/^\s*<([^<>]+)>\s*((?:;\s*[\w-]+\s*=\s*(?:"[^"]*"|[^;,\s"]+)\s*)*)$/)
    if (!match) throw Error('模型目录返回了无效的分页链接，请重试')
    const relations = [...match[2].matchAll(/;\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^;,\s"]+))/g)].filter(parameter => parameter[1].toLowerCase() === 'rel')
    if (relations.length > 1) throw Error('模型目录返回了冲突的分页链接，请重试')
    if (relations.some(relation => (relation[2] ?? relation[3]).split(/\s+/).includes('next'))) next.push(match[1])
  }
  if (!next.length) return null
  if (next.length !== 1) throw Error('模型目录返回了冲突的分页链接，请重试')
  let url
  try { url = new URL(next[0], hf) } catch { throw Error('模型目录返回了无效的分页链接，请重试') }
  if (url.origin !== hf || url.pathname !== '/api/models' || url.username || url.password || url.hash || url.searchParams.getAll('cursor').length !== 1 || !url.searchParams.get('cursor') || boundParameters(url) !== boundParameters(firstURL)) throw Error('模型目录分页链接与当前查询不匹配，已拒绝访问')
  return url.href
}

export function createDiscovery(context, { cached = null, persist = undefined } = {}) {
  const snapshots = new Map()
  const cursors = new Map()
  const cache = createAvailabilityCache({ cached, persist, extensionVersion: context.extension?.version ?? null })
  async function page(url) {
    const response = await context.network.get(url)
    if (response.status !== 200) {
      const limited = response.status === 429 || (response.status === 403 && /rate limit/i.test(response.text))
      throw Error(limited ? '来源请求额度暂时用尽，请稍后重试；也可直接导入本地模型' : `无法读取模型目录（${response.status}）`)
    }
    if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) throw Error('当前 Lexora 版本不支持目录分页响应头，请升级宿主后重试')
    const items = JSON.parse(response.text)
    if (!Array.isArray(items) || items.length > Number(new URL(url).searchParams.get('limit'))) throw Error('模型目录返回了无效的列表')
    return { items, link: response.headers.link }
  }
  async function json(url) {
    const resource = await context.network.download(url, { signal: context.signal })
    try {
      if (resource.size > 4 * 1024 * 1024) throw Error('目录内容过大，请缩小搜索范围')
      const decoder = new TextDecoder()
      let text = '', offset = 0
      for (;;) {
        const chunk = await context.resources.readBytes(resource, { offset, length: 64 * 1024 })
        text += decoder.decode(chunk.data, { stream: !chunk.eof }); offset += chunk.data.length
        if (offset > 4 * 1024 * 1024) throw Error('目录内容过大，请缩小搜索范围')
        if (chunk.eof) return JSON.parse(text)
        if (!chunk.data.length) throw Error('模型目录读取未完成')
      }
    } finally { await context.resources.release(resource) }
  }
  async function repositoryData(repository, revision = null) {
    const suffix = revision ? `/revision/${revision}` : ''
    const data = await json(`${hf}/api/models/${repository}${suffix}?blobs=true`)
    if (!repositoryPattern.test(data?.id) || data.id.toLowerCase() !== repository.toLowerCase()) throw Error('模型目录返回了无效的仓库信息')
    if (revision && data.sha !== revision) throw Error('模型来源返回的版本与当前目录不一致，请重试')
    return data
  }
  async function assess(data, updates, verified = false) {
    const support = fileSupport(data, modelFiles(data), verified)
    if (verified || support.unavailableReason) {
      if (support.availability.state !== 'unverified') updates.push({ repository: data.id, revision: support.revision, availability: support.availability })
      return hfItem(data, support.availability)
    }
    const cached = cache.get(data.id, support.revision)
    if (cached) return hfItem(data, cached)
    const detailed = await repositoryData(data.id, support.revision)
    const item = await assess(detailed, updates, true)
    return { ...item, ...hfMetadata({ ...data, ...detailed }) }
  }
  async function assessPage(rows, updates) {
    const items = [...new Map(rows.filter(item => repositoryPattern.test(item?.id)).map(item => [item.id, item])).values()]
    const results = new Array(items.length)
    let index = 0
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (index < items.length) {
        const current = index++
        try { results[current] = await assess(items[current], updates) }
        catch {
          results[current] = hfItem(items[current], { state: 'unverified', code: 'metadata', reason: '暂时无法读取完整文件信息；可打开详情重试，不影响其他模型。' })
        }
      }
    }))
    context.signal?.throwIfAborted()
    return results
  }
  async function search({ source = 'huggingface', kind = 'all', query = '', sort = '', cursor = null, availability = 'all' } = {}) {
    if (source !== 'huggingface') throw Error('发现仅支持 Hugging Face；已有模型仍可在我的模型中管理')
    const directory = huggingFaceCatalog
    if (typeof query !== 'string' || query.length > 300 || (kind !== 'all' && !directory.kinds.includes(kind))) throw Error('请选择 Hugging Face 目录支持的模型用途')
    sort ||= directory.sorts[0]
    if (!directory.sorts.includes(sort)) throw Error('该来源不支持此排序方式')
    query = query.trim()
    if (/https?:\/\//i.test(query)) {
      let url
      try { url = new URL(query) } catch { throw Error('请输入完整的 Hugging Face 仓库链接') }
      if (source !== 'huggingface' || url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password || url.search || url.hash || !repositoryPattern.test(url.pathname.replace(/^\/|\/$/g, ''))) throw Error('此入口只接受 Hugging Face 仓库链接，不支持任意 GitHub 仓库')
      query = url.pathname.replace(/^\/|\/$/g, '')
    }
    if (!['all', 'installable'].includes(availability)) throw Error('请选择有效的安装支持筛选方式')
    const binding = JSON.stringify([source, kind, query, sort, availability])
    const updates = []
    let state
    if (cursor !== null) {
      state = typeof cursor === 'string' ? cursors.get(cursor) : null
      if (!state || state.binding !== binding) throw Error('分页游标无效或已过期，请返回第一页重新查询')
      cursors.delete(cursor)
      cursors.set(cursor, state)
    }
    if (repositoryPattern.test(query)) {
      const data = await repositoryData(query)
      const item = await assess(data, updates, true)
      await cache.put(updates)
      return { items: [item], errors: [], nextCursor: null, pageComplete: true }
    }
    const parameters = new URLSearchParams({ limit: String(availability === 'installable' && kind === 'all' ? 100 : directory.pageSize), sort, direction: '-1', ...(query ? { search: query } : {}), ...(kind === 'all' ? {} : { pipeline_tag: directory.pipelines[kind] }), ...(availability === 'installable' && ['chat', 'vision'].includes(kind) ? { filter: 'gguf' } : {}) })
    for (const field of ['downloads', 'lastModified', 'gated', 'tags', 'pipeline_tag', 'library_name', 'likes', 'siblings', 'sha']) parameters.append('expand', field)
    const firstURL = new URL(`${hf}/api/models?${parameters}`)
    let url = state ? state.url : firstURL.href
    let items = [...(state?.overflow ?? [])]
    const seen = new Set(state?.seen ?? [])
    const visited = [...(state?.visited ?? [])]
    const scanLimit = availability === 'installable' ? 3 : 1
    for (let scanned = 0; url && items.length < directory.pageSize && scanned < scanLimit; scanned++) {
      const response = await page(url)
      const nextURL = nextPageURL(response.link, firstURL)
      visited.push(digest(new URL(url).searchParams.get('cursor') ?? ''))
      if (nextURL) {
        if (visited.includes(digest(new URL(nextURL).searchParams.get('cursor')))) throw Error('模型目录返回了循环分页链接，请重试')
        if (visited.length >= 512) throw Error('本次查询已达到分页上限，请缩小搜索范围')
      }
      const assessed = await assessPage(response.items, updates)
      const selected = availability === 'installable' ? assessed.filter(item => item.availability.state === 'installable' || item.availability.code === 'checksum' || item.availability.code === 'metadata' && item.recipe && item.recipe !== 'image') : assessed
      items = [...new Map([...items, ...selected.filter(item => !seen.has(item.repository))].map(item => [item.repository, item])).values()]
      url = nextURL
    }
    await cache.put(updates)
    const pageComplete = availability === 'all' || items.length >= directory.pageSize || !url
    const overflow = pageComplete ? items.slice(directory.pageSize) : items
    if (pageComplete) for (const item of items.slice(0, directory.pageSize)) seen.add(item.repository)
    let nextCursor = null
    if (url || overflow.length) {
      nextCursor = globalThis.crypto.randomUUID()
      cursors.set(nextCursor, { binding, url, visited, overflow, seen: [...seen].slice(-4096) })
      while (cursors.size > 128) cursors.delete(cursors.keys().next().value)
    }
    return { items: items.slice(0, directory.pageSize), errors: [], nextCursor, pageComplete }
  }
  async function inspect({ source = 'huggingface', recipe: recipeId, repository, revision, file, recipeOverride = null }) {
    if (recipeOverride !== null && !['chat', 'vision', 'asr', 'tts'].includes(recipeOverride)) throw Error('请选择有效的加载方式')
    if (source !== 'huggingface' || (recipeId != null && !huggingFaceCatalog.kinds.includes(recipeId))) throw Error('请选择 Hugging Face 目录支持的模型用途')
    if (!repositoryPattern.test(repository)) throw Error('模型仓库地址不合法')
    const data = await repositoryData(repository, /^[a-f0-9]{40}$/.test(revision) ? revision : null)
    const sha = /^[a-f0-9]{40}$/.test(data.sha) ? data.sha : null
    const files = sha ? modelFiles(data, repository) : []
    const support = fileSupport(data, files, true, recipeOverride)
    if (!recipeOverride && support.availability.state !== 'unverified') await cache.put([{ repository, revision: sha, availability: support.availability }])
    const key = `${support.recipe ?? 'unknown'}:${repository}:${sha ?? 'unversioned'}:${file ?? ''}`
    const result = { key, repository, ...support }
    snapshots.set(key, { ...result, files, phonemes: support.companionFiles, metadata: hfMetadata(data) })
    return result
  }
  async function hashResource(resource, signal) {
    const hash = sha256.create()
    let offset = 0
    for (;;) {
      signal.throwIfAborted()
      const chunk = await context.resources.readBytes(resource, { offset, length: 64 * 1024 })
      hash.update(chunk.data); offset += chunk.data.length
      if (chunk.eof) break
      if (!chunk.data.length) throw Error('文件读取未完成')
    }
    return bytesToHex(hash.digest())
  }
  async function resolve({ key, selection, title, mode = 'download', checksums = {} }, { signal = context.signal } = {}) {
    signal.throwIfAborted()
    if (!['import', 'download'].includes(mode)) throw Error('请选择下载或导入模型文件')
    const snapshot = snapshots.get(key)
    if (!snapshot) throw Error('目录已更新，请重新选择模型版本')
    if (snapshot.unavailableReason) throw Error(snapshot.unavailableReason)
    if (!snapshot.recipe || !snapshot.roles.length || snapshot.missing.length) throw Error('此仓库尚未适配可运行的模型文件，当前无法安装')
    const selected = {}
    for (const role of snapshot.roles) {
      const item = role.choices.find(item => item.path === selection?.[role.id])
      if (!item && !role.optional) throw Error(`请选择${role.title}`)
      if (item) selected[role.id] = item
    }
    const files = expandModelFiles([...Object.values(selected), ...snapshot.phonemes]).map(file => {
      if (hasHash(file) || !checksums?.[file.path]) return { ...file }
      const sha256 = String(checksums[file.path]).trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error(`请填写 ${file.path} 的完整 SHA-256（64 位十六进制字符）`)
      return { ...file, sha256 }
    })
    const unhashed = files.filter(file => !hasHash(file))
    if (mode === 'import' && unhashed.length) throw Error('来源未提供完整的 SHA-256 校验信息，暂不支持直接导入这些文件。请选择下载，或使用提供校验信息的版本。')
    if (totalCost(files) > hashBudget) throw Error(hashReason)
    const temporary = []
    try {
      for (const file of files) {
        if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
          const resource = await context.network.download(file.url, { signal })
          temporary.push(resource)
          file.sha256 = await hashResource(resource, signal)
          file.bytes = resource.size
        }
      }
      signal.throwIfAborted()
      const id = `custom-${digest(key + JSON.stringify(Object.fromEntries(Object.entries(selected).map(([role, file]) => [role, file.path])))).slice(0, 20)}`
      return { id, title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : snapshot.repository.split('/')[1], recipe: snapshot.recipe, ...(snapshot.imageArchitecture ? { imageArchitecture: snapshot.imageArchitecture } : {}), origin: { source: snapshot.metadata?.source, repository: snapshot.repository, revision: snapshot.revision }, ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}), files: Object.fromEntries(Object.entries(selected).map(([role, file]) => [role, file.path])), ...(snapshot.phonemes.length ? { phonemes: snapshot.phonemes[0].path.split('espeak-ng-data/')[0] + 'espeak-ng-data' } : {}), specification: { id: `${id}-model`, kind: 'model', title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : snapshot.repository.split('/')[1], bytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0), files: files.map(file => ({ path: file.path, source: file.path, url: file.url, sha256: file.sha256, ...(Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? { size: file.bytes } : {}) })) } }
    } finally {
      await Promise.all(temporary.map(resource => context.resources.release(resource).catch(() => {})))
      signal.throwIfAborted()
    }
  }
  return { search, inspect, resolve }
}
