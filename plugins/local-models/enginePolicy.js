import { resourceSupported } from './platform.js'

const buildNumber = version => /^b\d+$/.test(version ?? '') ? Number(version.slice(1)) : 0
export const engineKey = spec => `${spec.engineId}:${spec.backend}`

export function engineSpecification(spec) {
  if (spec.kind !== 'engine' || spec.engineId) return spec
  const legacy = /^llama-(b\d+)(?:-(windows-x64|macos-arm64))?$/.exec(spec.id)
  return legacy ? { ...spec, engineId: 'llama.cpp', title: 'llama.cpp', version: legacy[1], backend: legacy[2] === 'macos-arm64' ? 'metal' : 'vulkan' } : spec
}

export function initialEngineSelections(specifications, resources, stored = {}) {
  const selections = { ...stored }
  for (const spec of specifications.filter(spec => spec.engineId)) {
    const key = engineKey(spec)
    if (selections[key]) continue
    const candidates = specifications.filter(item => item.engineId === spec.engineId && item.backend === spec.backend && !item.custom)
    const installed = candidates.filter(item => resources.some(resource => resource.id === item.id && resource.authorized))
    const preferred = (installed.length ? installed : candidates.filter(item => !item.legacy)).sort((a, b) => buildNumber(b.version) - buildNumber(a.version))[0]
    if (preferred) selections[key] = preferred.id
  }
  return selections
}

export function selectModelEngine(model, configuration, specifications, selections, platform) {
  if (!model || !['chat', 'vision'].includes(model.runtime)) return model
  const original = specifications.find(spec => spec.id === model.resources[0])
  if (original?.engineId !== 'llama.cpp') return model
  const backend = configuration?.acceleration === 'cpu' && selections['llama.cpp:cpu'] ? 'cpu' : configuration?.acceleration === 'cuda' ? 'cuda' : platform === 'macos-arm64' ? 'metal' : 'vulkan'
  const id = selections[`llama.cpp:${backend}`]
  const engine = specifications.find(spec => spec.id === id && spec.engineId === 'llama.cpp' && spec.backend === backend && resourceSupported(spec, platform))
  if (!engine) return { ...model, engineSelectionMissing: true }
  return { ...model, resources: [engine.id, ...model.resources.slice(1)], ...(model.directoryResources ? { directoryResources: [engine.id, ...model.directoryResources.slice(1)] } : {}) }
}

export function modelEngineRequirement(model) {
  if (!model || !['chat', 'vision'].includes(model.runtime)) return null
  const architecture = model.metadata?.architecture
  const references = [model.origin?.repository, ...(model.metadata?.baseModels ?? [])]
  const lfm3 = architecture === 'lfm3' || references.some(value => /^LiquidAI\/LFM3-1\.7B(?:-GGUF)?$/i.test(value ?? ''))
  if (!lfm3) return null
  const nvfp4 = model.metadata?.quantization === 'NVFP4' || Object.values(model.files ?? {}).some(value => /(?:^|[-_.])NVFP4(?:[-_.]|$)/i.test(String(value)))
  return { minimumEngineVersion: nvfp4 ? 'b12088' : 'b11960', architecture: 'lfm3' }
}

export function engineCompatibility(model, spec) {
  if (model.engineSelectionMissing) return '所选引擎在当前平台不可用，请在运行参数中选择可用后端，并在引擎管理中选择已安装版本。'
  const requirement = modelEngineRequirement(model)
  if (!requirement || !buildNumber(spec?.version) || buildNumber(spec.version) >= buildNumber(requirement.minimumEngineVersion)) return ''
  return `此模型需要 llama.cpp ${requirement.minimumEngineVersion} 或更新版本，当前为 ${spec.version}。请更新引擎后再启用，模型文件无需重新下载。`
}
