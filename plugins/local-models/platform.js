const variants = {
  'llama-b11747': { 'windows-x64': 'llama-b11747-windows-x64', 'macos-arm64': 'llama-b11747-macos-arm64' },
  'sherpa-onnx': { 'windows-x64': 'sherpa-onnx-windows-x64', 'macos-arm64': 'sherpa-onnx-macos-arm64' },
  'image-cuda': { 'windows-x64': 'image-vulkan-windows-x64', 'macos-arm64': 'image-metal-macos-arm64' },
}

export async function inferenceEnvironment(inference) {
  if (inference?.capabilities?.nativeRuntime === true) {
    if (typeof inference.environment !== 'function') return { platform: null, executionMode: 'unsupported' }
    const value = await inference.environment()
    if (value?.platform === 'linux-x64' && value.executionMode === 'isolated'
      || ['windows-x64', 'macos-arm64'].includes(value?.platform) && value.executionMode === 'supervised') return value
    return { platform: null, executionMode: 'unsupported' }
  }
  return inference?.capabilities?.runtimeIsolation === true
    ? { platform: 'linux-x64', executionMode: 'isolated' }
    : { platform: null, executionMode: 'unsupported' }
}

export function engineForPlatform(id, platform) {
  const linux = Object.entries(variants).find(([, platforms]) => Object.values(platforms).includes(id))?.[0] ?? id
  return variants[linux]?.[platform] ?? linux
}

export function platformModel(model, platform) {
  const resources = model.resources.map(id => engineForPlatform(id, platform))
  const directoryResources = model.directoryResources?.map(id => engineForPlatform(id, platform))
  const windows = platform === 'windows-x64'
  const mac = platform === 'macos-arm64'
  const choices = [{ value: 'cpu', title: 'CPU' }, { value: 'gpu', title: mac ? 'Metal' : 'Vulkan' }, ...(!mac && ['chat', 'vision'].includes(model.runtime) ? [{ value: 'cuda', title: 'CUDA · NVIDIA' }] : [])]
  let fields = model.fields, defaults = model.defaults
  if ((windows || mac) && model.runtime === 'chat') defaults = { ...defaults, acceleration: 'cpu' }
  const selectableAcceleration = model.runtime === 'chat' || model.runtime === 'vision' || mac && model.runtime === 'image'
  if (selectableAcceleration) {
    if (!fields.some(field => field.key === 'acceleration')) {
      fields = [...fields, { key: 'acceleration', label: '加速方式', type: 'select', choices }]
      defaults = { ...defaults, acceleration: model.runtime === 'image' || platform === 'linux-x64' && model.runtime === 'vision' ? 'gpu' : 'cpu' }
    }
    fields = fields.map(field => field.key === 'acceleration' ? {
      ...field,
      choices: choices.map(choice => ({ ...field.choices.find(existing => existing.value === choice.value), ...choice })),
    } : field)
  } else if (model.runtime === 'image' || model.runtime === 'vision') {
    fields = fields.filter(field => field.key !== 'acceleration')
    const { acceleration: _acceleration, ...rest } = defaults
    defaults = rest
  }
  return {
    ...model, resources, fields, defaults,
    ...(windows ? { setupHint: model.runtime === 'image' ? 'Windows x64 / Vulkan；需要兼容驱动及 VC++ x64 运行库。模型格式可安装不代表显存或硬件足够。' : 'Windows x64；当前用户受监督进程，无操作系统文件和网络隔离。原生引擎需 VC++ x64 运行库；GPU 需与所选后端兼容的驱动。' } : {}),
    ...(mac ? { setupHint: 'macOS ARM64；引擎和权重按需准备，首次使用时加载。' } : {}),
    ...(directoryResources ? { directoryResources: (windows || mac) && directoryResources.includes('tesseract-native') ? resources : directoryResources } : {}),
  }
}

export function resourceSupported(resource, platform) {
  if (resource.kind !== 'engine') return true
  const platforms = resource.platforms ?? (resource.id === 'tesseract-wasm' ? ['linux-x64', 'windows-x64', 'macos-arm64'] : ['linux-x64'])
  return platforms.includes(platform)
}
