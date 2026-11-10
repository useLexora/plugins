const GiB = 1024 ** 3
const positive = value => Number.isSafeInteger(value) && value > 0
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const chatModel = model => ['chat', 'vision'].includes(model?.runtime ?? model?.recipe)
const fieldsFor = model => (model?.fields ?? []).filter(field => ['acceleration', 'threads', 'contextWindow', 'maxTokens'].includes(field.key))

function valid(field, value) {
  if (field.type === 'select') return field.choices?.some(choice => choice.value === value)
  return field.type === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isInteger(value))
}

function memoryPool(configuration, hardware, warnings) {
  const mode = configuration?.acceleration
  if (mode === 'cpu') return { scope: 'ram', memory: hardware, complete: true }
  if (!['gpu', 'cuda'].includes(mode)) {
    warnings.push('加速方式未知，不能确定使用内存还是显存。')
    return { scope: 'unknown', complete: false }
  }
  const gpus = (hardware?.gpus ?? []).filter(gpu => mode !== 'cuda' || gpu.vendor === 'nvidia')
  if (!gpus.length) {
    warnings.push('缺少所选 GPU 的显存信息；不会用整机 RAM 替代独立显存。')
    return { scope: 'unknown', complete: false }
  }
  if (gpus.length !== 1) {
    warnings.push('存在多个候选 GPU，尚未确认实际使用的设备；不会累加不同设备的显存。')
    return { scope: 'vram', complete: false }
  }
  if (gpus[0].vendor === 'apple') {
    warnings.push('Apple GPU 与 CPU 共用统一内存，容量只计算一次。')
    return { scope: 'unified', memory: hardware, complete: true }
  }
  return { scope: 'vram', memory: gpus[0], complete: true }
}

export function modelBudget(model, configuration, hardware) {
  const inference = model?.metadata?.inference
  const warnings = [...(Array.isArray(inference?.limitations) ? inference.limitations.filter(value => typeof value === 'string') : [])]
  warnings.push('仅为权重与全上下文 F16 KV 的估算；不含精确计算缓冲、加载副本和驱动开销，预留量不能保证峰值或启动成功。')
  warnings.push('最大输出属于上下文内的预留，不会在 KV 内存之外重复相加；预算仅提示，不限制保存或运行。')
  const pool = memoryPool(configuration, hardware, warnings)
  const result = { scope: pool.scope, status: 'unknown', warnings }
  let complete = pool.complete && chatModel(model)
  const loaded = ['idle', 'running', 'loading', 'stopping'].includes(model?.state)
    || (model?.instances ?? []).some(instance => ['ready', 'loading', 'stopping'].includes(instance.state))
  if (loaded) {
    complete = false
    warnings.push('当前剩余容量已包含已加载模型的占用，不能再次扣除完整权重与 KV；实际分配量未知，重载前预算需重新检查。')
  }
  if (positive(inference?.weightBytes)) result.weightBytes = inference.weightBytes
  else { complete = false; warnings.push('权重内存信息缺失，旧模型仍可使用；不会自动重读文件。') }
  const ctx = configuration?.contextWindow
  const kvBytes = positive(ctx) && positive(inference?.kvBytesPerToken) ? ctx * inference.kvBytesPerToken : null
  if (positive(kvBytes)) result.kvBytes = kvBytes
  if (!positive(kvBytes) || inference?.kvEstimate !== 'full-context-f16') {
    complete = false
    warnings.push('完整 KV 估算未知；缺失或局部估算不能视为内存充足。')
  }
  if ((model?.runtime ?? model?.recipe) === 'vision') {
    complete = false
    warnings.push('未包含视觉投影、图片编码及其计算内存，整体预算未知。')
  }
  if (positive(inference?.contextWindow) && positive(ctx) && ctx > inference.contextWindow) warnings.push(`所选上下文超过模型声明的原生长度 ${inference.contextWindow}；长上下文质量与兼容性需验证，不限制用户选择。`)
  const estimated = result.weightBytes + result.kvBytes
  if (positive(estimated)) result.estimatedBytes = estimated
  else complete = false
  const memory = pool.memory
  if (nonnegative(memory?.availableMemoryBytes)) result.availableBytes = memory.availableMemoryBytes
  else if (positive(memory?.totalMemoryBytes)) {
    result.availableBytes = memory.totalMemoryBytes
    complete = false
    warnings.push('只有总容量，没有当前可用容量；显示值只是容量上界，预算仍未知。')
  } else {
    complete = false
    warnings.push(pool.scope === 'vram' ? '当前可用显存未知。' : '当前可用内存未知。')
  }
  if (positive(memory?.totalMemoryBytes) && result.estimatedBytes > memory.totalMemoryBytes) warnings.push('估算部分已超过设备总容量；这是总容量风险提示，不代表当前运行已发生内存不足，实际分配方式需验证。')
  const capacity = positive(memory?.totalMemoryBytes) ? memory.totalMemoryBytes : result.availableBytes
  if (nonnegative(capacity)) result.reserveBytes = Math.ceil(Math.max(pool.scope === 'vram' ? 0.5 * GiB : 2 * GiB, capacity * (pool.scope === 'vram' ? 0.1 : 0.15)))
  if (complete) {
    result.status = result.estimatedBytes + result.reserveBytes > result.availableBytes ? 'risk' : 'within-estimate'
    if (result.status === 'risk') warnings.push('估算加预留超过当前可用容量；可自行调整上下文或加速方式，原配置不会被更改。')
  }
  return result
}

export function recommendConfiguration(model, hardware, platform, supportedBackends = []) {
  const configuration = {}, reasons = ['以下仅为可修改的默认建议，不覆盖已保存的用户参数，也不构成运行上限。']
  if (!chatModel(model)) return { configuration, reasons }
  const fields = fieldsFor(model), byKey = key => fields.find(field => field.key === key)
  for (const field of fields) if (valid(field, model.defaults?.[field.key])) configuration[field.key] = model.defaults[field.key]
  const suggest = (key, value) => {
    const field = byKey(key)
    if (field && valid(field, value)) configuration[key] = value
  }
  const acceleration = byKey('acceleration'), gpus = hardware?.gpus
  if (acceleration && Array.isArray(gpus)) {
    if (gpus.length) {
      const cuda = gpus.some(gpu => gpu.vendor === 'nvidia') && supportedBackends.includes('cuda') && valid(acceleration, 'cuda')
      suggest('acceleration', cuda ? 'cuda' : 'gpu')
      reasons.push(cuda ? '已报告 NVIDIA GPU 且有 CUDA 引擎候选，优先建议 CUDA。' : `已报告 GPU，建议尝试 ${platform === 'macos-arm64' ? 'Metal' : 'Vulkan'}。`)
      reasons.push('设备存在不代表驱动或引擎兼容；需启动后验证，失败时由用户选择其他后端。')
    } else {
      suggest('acceleration', 'cpu')
      reasons.push('硬件报告未列出 GPU，建议先尝试 CPU；这不是 GPU 不存在的证明。')
    }
  } else reasons.push('缺少硬件或加速字段信息，保留现有加速默认值；未确认 GPU 或驱动兼容性。')
  const threads = byKey('threads')
  if (threads && positive(hardware?.logicalCores)) {
    suggest('threads', Math.max(threads.min, Math.min(threads.max, 8, Math.max(1, Math.floor(hardware.logicalCores / 2)))))
    reasons.push('线程建议使用约半数逻辑核、最多 8 个，给系统与交互留出余量。')
  }
  const context = byKey('contextWindow'), native = model.metadata?.inference?.contextWindow
  if (context && positive(configuration.contextWindow)) {
    const ceiling = positive(native) ? Math.min(configuration.contextWindow, native) : configuration.contextWindow
    const presets = [...new Set([context.min, 4096, 8192, 16384, 32768, 65536, 131072, configuration.contextWindow])].filter(value => valid(context, value) && value <= ceiling).sort((a, b) => b - a)
    if (presets.length) {
      let chosen = presets[0]
      for (const value of presets) {
        chosen = value
        if (modelBudget(model, { ...configuration, contextWindow: value }, hardware).status !== 'risk') break
      }
      suggest('contextWindow', chosen)
      reasons.push('上下文从现有默认值、模型原生长度与已知预算选择；未知预算不代表可承载，也不会限制手动填写更长上下文。')
    }
  }
  const output = byKey('maxTokens')
  if (output && positive(configuration.contextWindow)) {
    const value = Math.min(configuration.maxTokens ?? 512, configuration.contextWindow)
    if (valid(output, value)) suggest('maxTokens', value)
    else delete configuration.maxTokens
    reasons.push('最大输出保留独立默认值并放在上下文内，不与上下文等量增长或重复计入内存。')
  }
  return { configuration, reasons }
}
