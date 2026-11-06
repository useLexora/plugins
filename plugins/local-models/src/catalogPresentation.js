import { modelKinds } from './modelPresentation.js'
import { expandModelFiles } from '../modelFileGroups.js'

export const formatBytes = value => !Number.isFinite(value) ? '大小未知' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`
export const kindLabel = value => modelKinds.find(kind => kind.value === value)?.label ?? '模型'
export const formatCount = value => value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : value.toLocaleString('zh-CN')
export const formatDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : ''

export function installationLabel(availability) {
  return ({ ready: '可安装', inferred: '可尝试', checksum: '需确认校验', metadata: '待确认', access: '需访问授权', adapter: '需基础模型', task: '用途未接入', components: '需补充文件', format: '需 GGUF 版本' })[availability?.code] ?? (availability?.state === 'installable' ? '可安装' : '待确认')
}

export function choiceBytes(file) {
  const parts = expandModelFiles([file])
  return parts.every(part => Number.isFinite(part.bytes)) ? parts.reduce((sum, part) => sum + part.bytes, 0) : null
}

export function quantization(path) {
  return path.match(/(?:^|[./_-])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|FP16|F16|F32|INT8)(?=[._-]|$)/i)?.[1].toUpperCase() ?? ''
}

export function catalogTags(item) {
  const metadata = item.metadata ?? item
  const tags = (metadata.tags ?? []).filter(tag => typeof tag === 'string')
  const formats = [...tags, metadata.libraryName].filter(tag => typeof tag === 'string' && /^(gguf|onnx|safetensors|pytorch|mlx)$/i.test(tag)).map(tag => /^(gguf|onnx|mlx)$/i.test(tag) ? tag.toUpperCase() : tag)
  const license = metadata.license ?? tags.find(tag => tag.startsWith('license:'))?.slice(8)
  const languages = tags.filter(tag => /^(zh|en|ja|ko|fr|de|es|multilingual)$/.test(tag))
  const task = item.recipe || item.runtime ? kindLabel(item.recipe ?? item.runtime) : metadata.pipelineTag || '用途未标注'
  return [...new Set([task, ...formats, ...(license ? [license] : []), ...languages])]
}

export function sourceUrl(item) {
  return `https://huggingface.co/${item.repository}`
}

export function initialSelection(roles) {
  return Object.fromEntries(roles.map(role => [role.id, role.optional ? '' : role.choices.find(file => /Q4_K_M|Q4_K\.|\.int8\./i.test(file.path))?.path ?? role.choices[0]?.path ?? '']))
}
