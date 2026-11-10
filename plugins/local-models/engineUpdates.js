const catalogURL = 'https://raw.githubusercontent.com/useLexora/plugins/main/plugins/local-models/resources.json'
const releaseURL = 'https://github.com/ggml-org/llama.cpp/releases/download/'
const maxCatalogBytes = 2 * 1024 ** 2
const maxArchiveBytes = 2 * 1024 ** 3
const maxUnpackedBytes = 8 * 1024 ** 3
const targets = {
  'linux-x64': { system: 'ubuntu', extension: 'tar.gz', entry: 'llama-server', backends: ['cpu', 'vulkan', 'cuda'] },
  'windows-x64': { system: 'win', extension: 'zip', entry: 'llama-server.exe', backends: ['cpu', 'vulkan', 'cuda'] },
  'macos-arm64': { system: 'macos', extension: 'tar.gz', entry: 'llama-server', backends: ['metal'] },
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const requireValue = (condition, reason) => { if (!condition) throw Error(`引擎更新目录无效：${reason}`) }
const boundedBytes = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max
const versionNumber = value => typeof value === 'string' && /^b[1-9]\d{3,7}$/.test(value) ? Number(value.slice(1)) : 0
const safeName = value => typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..') && !value.endsWith('.')
const hash = value => {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value), '缺少有效 SHA-256')
  return value.toLowerCase()
}
const sorted = (items, key) => [...items].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)

function archiveName(spec, target, runtime = false) {
  const variant = spec.backend === 'cuda' ? `cuda-${spec.cudaRuntimeVersion}-` : spec.backend === 'vulkan' ? 'vulkan-' : ''
  const machine = spec.platforms[0] === 'macos-arm64' ? 'arm64' : 'x64'
  const prefix = runtime && target.system === 'win' ? 'cudart-llama' : `${runtime ? 'cudart-' : ''}llama-${spec.version}`
  return `${prefix}-bin-${target.system}-${variant}${machine}.${target.extension}`
}

function normalizeArchive(input, spec, target) {
  requireValue(record(input) && ['engine', 'llama', 'cudart'].includes(input.id), '压缩包标识不受支持')
  const runtime = input.id === 'cudart'
  requireValue(!runtime || spec.backend === 'cuda', '只有 CUDA 后端可包含 runtime 包')
  const name = archiveName(spec, target, runtime)
  requireValue(input.name === name && record(input.source) && Object.keys(input.source).length === 1 && input.source.url === `${releaseURL}${spec.version}/${name}`, '必须使用对应固定版本的官方发布包')
  requireValue(boundedBytes(input.size, maxArchiveBytes) && boundedBytes(input.unpackedBytes, maxUnpackedBytes), '压缩包体积超出限制')
  return { id: input.id, name, sha256: hash(input.sha256), size: input.size, unpackedBytes: input.unpackedBytes, source: { url: input.source.url } }
}

function libraryName(name, platform, runtime) {
  if (runtime) return platform === 'windows-x64' ? /^(?:cublas|cublasLt|cudart)64_\d+\.dll$/.test(name) : /^lib(?:cublas|cublasLt|cudart)\.so\.\d+(?:\.\d+)*$/.test(name)
  if (/^LICENSE(?:-[A-Za-z0-9-]+)?$/.test(name)) return true
  const family = '(?:ggml(?:-[a-z0-9-]+)?|llama(?:-[a-z0-9-]+)?|mtmd|omp)'
  if (platform === 'windows-x64') return new RegExp(`^(?:${family}|libomp)\\.dll$`).test(name)
  if (platform === 'macos-arm64') return new RegExp(`^lib${family}(?:\\.\\d+)*\\.dylib$`).test(name)
  return new RegExp(`^lib${family}\\.so(?:\\.\\d+)*$`).test(name)
}

function archiveFileMatches(path, member, platform) {
  if (path === member) return true
  if (platform === 'linux-x64' && path.includes('.so')) return member.startsWith(`${path}.`) && /^\d+(?:\.\d+)*$/.test(member.slice(path.length + 1))
  if (platform === 'macos-arm64' && path.endsWith('.dylib')) {
    const stem = path.slice(0, -6)
    return member.startsWith(`${stem}.`) && member.endsWith('.dylib') && /^\d+(?:\.\d+)*$/.test(member.slice(stem.length + 1, -6))
  }
  return false
}

function normalizeFile(input, spec, target, archives) {
  requireValue(record(input) && safeName(input.path) && typeof input.archivePath === 'string' && input.archivePath.length <= 320, '文件路径不合法')
  const archive = archives.find(item => item.id === input.archive)
  requireValue(archive, '文件未关联已声明的压缩包')
  const runtime = archive.id === 'cudart'
  const entry = input.path === target.entry
  requireValue(entry ? !runtime && input.executable === true : libraryName(input.path, spec.platforms[0], runtime) && (input.executable === undefined || input.executable === false), '只接受 llama-server 入口及对应动态库、许可证')
  if (runtime) {
    const major = target.system === 'win' ? /_(\d+)\.dll$/.exec(input.path)?.[1] : /\.so\.(\d+)/.exec(input.path)?.[1]
    requireValue(major === spec.cudaRuntimeVersion.split('.')[0], 'CUDA 库与 runtime 主版本不匹配')
  }
  const prefix = target.system === 'win' ? '' : runtime ? `${archive.name.slice(0, -7)}/` : `llama-${spec.version}/`
  requireValue(input.archivePath.startsWith(prefix), '压缩包内目录与版本不匹配')
  const member = input.archivePath.slice(prefix.length)
  requireValue(safeName(member) && archiveFileMatches(input.path, member, spec.platforms[0]), '文件与压缩包成员不匹配')
  requireValue(input.source === `engine/${input.path}` && !own(input, 'resourceId') && !own(input, 'directoryId') && !own(input, 'url'), '不能使用网络提供的本地句柄或单文件来源')
  const file = { path: input.path, sha256: hash(input.sha256), source: `engine/${input.path}`, archivePath: input.archivePath, archive: archive.id }
  if (entry) file.executable = true
  if (input.bytes !== undefined) {
    requireValue(boundedBytes(input.bytes, archive.unpackedBytes), '文件体积不合法')
    file.bytes = input.bytes
  }
  return file
}

function normalizeSpecification(input) {
  requireValue(record(input) && input.kind === 'engine' && input.engineId === 'llama.cpp' && !input.custom, '只接受官方 llama.cpp 引擎')
  requireValue(versionNumber(input.version), '版本必须是固定 bNNNN 发布版本')
  requireValue(Array.isArray(input.platforms) && input.platforms.length === 1 && own(targets, input.platforms[0]), '平台不受支持')
  const platform = input.platforms[0], target = targets[platform]
  requireValue(target.backends.includes(input.backend), '后端与平台不匹配')
  const expectedId = `llama-${input.backend}-${platform}-${input.version}`
  const legacyId = `llama-${input.version}${platform === 'linux-x64' ? '' : `-${platform}`}`
  requireValue(input.id === expectedId || input.id === legacyId && input.backend === (platform === 'macos-arm64' ? 'metal' : 'vulkan'), '资源 ID 与版本、后端或平台不匹配')
  requireValue(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 160 && !/[\x00-\x1f\x7f]/.test(input.title), '标题不合法')
  const spec = { id: input.id, kind: 'engine', engineId: 'llama.cpp', version: input.version, backend: input.backend, platforms: [platform], title: input.title }
  if (input.requirements !== undefined) {
    requireValue(Array.isArray(input.requirements) && input.requirements.length <= 12 && input.requirements.every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value)), '运行要求不合法')
    spec.requirements = [...input.requirements]
  }
  for (const key of ['legacy', 'prerelease']) if (input[key] !== undefined) {
    requireValue(typeof input[key] === 'boolean', '发布标记不合法')
    spec[key] = input[key]
  }
  if (input.backend === 'cuda') {
    requireValue(typeof input.cudaRuntimeVersion === 'string' && /^\d{1,2}\.\d{1,2}$/.test(input.cudaRuntimeVersion), 'CUDA runtime 版本不合法')
    spec.cudaRuntimeVersion = input.cudaRuntimeVersion
    for (const key of ['recommendedDriverBranch', 'minorCompatibilityDriverBranch']) if (input[key] !== undefined) {
      requireValue(typeof input[key] === 'string' && /^R\d{3,4}$/.test(input[key]), '驱动分支不合法')
      spec[key] = input[key]
    }
  } else requireValue(['cudaRuntimeVersion', 'recommendedDriverBranch', 'minorCompatibilityDriverBranch'].every(key => input[key] === undefined), '非 CUDA 后端不能声明 CUDA 元数据')
  requireValue(Array.isArray(input.archives) && input.archives.length === (spec.backend === 'cuda' ? 2 : 1), '压缩包数量不合法')
  spec.archives = input.archives.map(archive => normalizeArchive(archive, spec, target))
  requireValue(spec.archives.filter(archive => archive.id !== 'cudart').length === 1 && new Set(spec.archives.map(archive => archive.id)).size === spec.archives.length, '压缩包标识重复或缺少主包')
  spec.bytes = spec.archives.reduce((sum, archive) => sum + archive.size, 0)
  requireValue(input.bytes === spec.bytes, '资源体积与压缩包不一致')
  requireValue(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= 128, '文件数量超出限制')
  spec.files = input.files.map(file => normalizeFile(file, spec, target, spec.archives))
  requireValue(new Set(spec.files.map(file => file.path.toLowerCase())).size === spec.files.length && spec.files.filter(file => file.executable).length === 1, '文件重名或缺少唯一入口')
  const members = new Map()
  for (const file of spec.files) {
    const key = `${file.archive}/${file.archivePath}`
    const previous = members.get(key)
    requireValue(!previous || previous.sha256 === file.sha256 && previous.bytes === file.bytes, '同一压缩包成员的摘要或体积冲突')
    members.set(key, file)
  }
  for (const archive of spec.archives) {
    const files = [...members.values()].filter(file => file.archive === archive.id)
    requireValue(files.length > 0 && files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) <= archive.unpackedBytes, '压缩包文件体积不一致')
  }
  return spec
}

function identity(spec) {
  return JSON.stringify({ id: spec.id, kind: spec.kind, engineId: spec.engineId, version: spec.version, backend: spec.backend, platforms: spec.platforms, cudaRuntimeVersion: spec.cudaRuntimeVersion, archives: sorted(spec.archives, 'id'), files: sorted(spec.files, 'path') })
}

export function validateEngineUpdates(catalog, currentSpecifications = []) {
  requireValue(Array.isArray(catalog) && catalog.length <= 512, '目录数量超出限制')
  requireValue(Array.isArray(currentSpecifications), '现有资源列表不合法')
  const candidates = catalog.filter(item => record(item) && item.engineId === 'llama.cpp')
  requireValue(candidates.length <= 64, '引擎版本数量超出限制')
  const updates = candidates.map(normalizeSpecification)
  requireValue(new Set(updates.map(spec => spec.id)).size === updates.length, '引擎资源 ID 重复')
  requireValue(updates.reduce((sum, spec) => sum + spec.archives.reduce((bytes, archive) => bytes + archive.unpackedBytes, 0), 0) <= 64 * 1024 ** 3, '目录展开体积超出限制')
  const existing = new Map(currentSpecifications.map(spec => [spec.id, spec]))
  for (const spec of updates) {
    const current = existing.get(spec.id)
    if (current) {
      requireValue(identity(normalizeSpecification(current)) === identity(spec), `不可变资源身份冲突（${spec.id}）`)
    } else {
      const minimum = Math.max(11747, ...currentSpecifications.filter(item => item.engineId === 'llama.cpp' && !item.custom && item.backend === spec.backend && item.platforms?.includes(spec.platforms[0])).map(item => versionNumber(item.version)))
      requireValue(versionNumber(spec.version) >= minimum, '拒绝新增低于当前版本的引擎')
    }
  }
  return updates
}

export async function checkEngineUpdates(context, currentSpecifications) {
  context.signal?.throwIfAborted()
  const response = await context.network.get(catalogURL)
  context.signal?.throwIfAborted()
  if (response?.status !== 200) throw Error(`无法检查引擎更新（${response?.status ?? '无响应'}）`)
  requireValue(typeof response.text === 'string' && response.text.length <= maxCatalogBytes && new TextEncoder().encode(response.text).length <= maxCatalogBytes, '目录内容超过 2 MiB')
  let catalog
  try { catalog = JSON.parse(response.text) } catch { throw Error('引擎更新目录不是有效 JSON') }
  return validateEngineUpdates(catalog, currentSpecifications)
}
