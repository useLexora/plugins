import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const maxFiles = 128
const maxBytes = 8 * 1024 ** 3
const platforms = {
  'linux-x64': { entry: 'llama-server', backends: ['cpu', 'vulkan', 'cuda'], library: /^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*\.so(?:\.[0-9]+)*$/ },
  'windows-x64': { entry: 'llama-server.exe', backends: ['cpu', 'vulkan', 'cuda'], library: /^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*\.dll$/i },
  'macos-arm64': { entry: 'llama-server', backends: ['cpu', 'metal'], library: /^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*\.dylib$/ },
}
const parent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const checkAbort = signal => signal?.throwIfAborted()
const invalidated = () => Error('引擎文件或授权已变化，请重新选择目录')
const safePath = value => typeof value === 'string' && value.length <= 1024 && value.split('/').length <= 16 && value.split('/').every(part => part && part.length <= 255 && !['.', '..'].includes(part) && !/[\\<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
const sameFile = (a, b) => a.id === b.id && a.name === b.name && a.source === b.source && a.size === b.size

export function isEngineFile(name, platform) {
  const target = Object.hasOwn(platforms, platform) ? platforms[platform] : undefined
  if (!target || typeof name !== 'string' || name.includes('/') || !safePath(name)) return false
  return (platform === 'windows-x64' ? name.toLowerCase() : name) === target.entry || target.library.test(name)
}

function normalize(resource) {
  const source = resource.relativePath ?? resource.name
  if (!safePath(source) || typeof resource.name !== 'string' || resource.name.includes('/') || !safePath(resource.name) || source.split('/').at(-1) !== resource.name) throw Error('引擎资源路径不合法：不接受绝对路径、目录穿越或不可移植文件名')
  if (!Number.isSafeInteger(resource.size) || resource.size <= 0) throw Error('引擎文件大小不合法')
  return { id: resource.id, name: resource.name, source, size: resource.size }
}

async function authorizedFiles(context, signal) {
  checkAbort(signal)
  const resources = await context.resources.listFiles()
  checkAbort(signal)
  if (!Array.isArray(resources)) throw Error('宿主返回的资源列表不合法')
  const files = new Map()
  for (const resource of resources) {
    if (!resource || typeof resource.id !== 'string' || !resource.id || files.has(resource.id)) throw Error('宿主返回了无效或重复的资源句柄')
    files.set(resource.id, resource)
  }
  return files
}

export async function importEngine(context, input, platform, { signal = context.signal } = {}) {
  checkAbort(signal)
  const { resourceIds, backend } = input ?? {}
  const target = Object.hasOwn(platforms, platform) ? platforms[platform] : undefined
  if (!target || !target.backends.includes(backend)) throw Error('当前平台不支持所选 llama.cpp 后端')
  if (!Array.isArray(resourceIds) || !resourceIds.length || resourceIds.length > maxFiles || resourceIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(resourceIds).size !== resourceIds.length) throw Error('请选择 1–128 个不重复的授权引擎文件')
  const ids = [...resourceIds]
  if (typeof context.resources?.hash !== 'function') throw Error('当前宿主缺少 resources.hash，请升级 Lexora 后导入引擎')
  const authorized = await authorizedFiles(context, signal)
  const files = ids.map(id => {
    const resource = authorized.get(id)
    if (!resource) throw invalidated()
    return normalize(resource)
  })
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length) throw Error('引擎文件名重复或存在大小写冲突')
  if (files.some(file => parent(file.source) !== parent(files[0].source))) throw Error('引擎和动态库必须位于同一相对目录')
  const isEntry = file => (platform === 'windows-x64' ? file.name.toLowerCase() : file.name) === target.entry
  if (files.filter(isEntry).length !== 1) throw Error(`请选择一个 ${target.entry} 入口及其同目录动态库`)
  for (const file of files) {
    if (!isEngineFile(file.name, platform)) throw Error('只接受当前平台的 llama-server 入口和动态库，不接受脚本或其他文件')
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw Error('引擎文件总量超过 8 GiB 上限')
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const entries = []
  for (const file of files) {
    checkAbort(signal)
    const hash = await context.resources.hash({ id: file.id }, { signal })
    checkAbort(signal)
    if (!hash || typeof hash.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(hash.sha256) || hash.size !== file.size) throw Error('引擎文件摘要或大小校验失败，请重新选择目录')
    entries.push({ path: isEntry(file) ? target.entry : file.name, source: file.source, resourceId: file.id, sha256: hash.sha256.toLowerCase(), size: file.size, ...(isEntry(file) ? { entry: true, executable: true } : {}) })
  }
  const fresh = await authorizedFiles(context, signal)
  for (const file of files) {
    if (!fresh.has(file.id) || !sameFile(file, normalize(fresh.get(file.id)))) throw invalidated()
  }
  const identity = JSON.stringify([platform, backend, entries.map(file => [file.path, file.sha256])])
  const id = `llama-custom-${bytesToHex(sha256(new TextEncoder().encode(identity))).slice(0, 32)}`
  const specification = { id, kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', backend, platforms: [platform], custom: true, bytes: totalBytes, files: entries }
  checkAbort(signal)
  const prepared = await context.inference.resources.prepare({
    id, kind: 'engine', files: entries.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, ...(file.executable ? { executable: true } : {}), source: { resourceId: file.resourceId, reference: true } })),
  }, { signal })
  checkAbort(signal)
  return { specification, prepared }
}
