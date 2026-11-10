import React from 'react'

const backendLabels = { cpu: 'CPU', cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', unknown: '未知' }
const backendLabel = value => backendLabels[value] ?? value ?? '未知'
const number = value => Number.isFinite(value) && value >= 0
const tokens = value => number(value) ? `${value.toLocaleString('zh-CN')} tokens` : '未知'
const milliseconds = value => number(value) ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ms` : '未知'

export function observationWarnings(model) {
  const observation = model.runtimeObservation
  if (!observation) return []
  const warnings = []
  const { offload, context, backend } = observation
  if (number(offload?.layers) && number(offload?.total) && offload.total > 0) {
    if (offload.layers === 0 && ['gpu', 'cuda'].includes(model.configuration.acceleration)) warnings.push('GPU 卸载层数为 0：当前观测为 CPU 回退，已保存的加速选择未被自动更改。')
    else if (offload.layers > 0 && offload.layers < offload.total) warnings.push('仅部分层在 GPU，属于 CPU / GPU 混合运行；不代表全部运算由 GPU 完成。')
  } else if (backend?.observed?.includes('cpu') && ['gpu', 'cuda'].includes(model.configuration.acceleration) && !backend.observed.some(value => ['cuda', 'vulkan', 'metal'].includes(value))) {
    warnings.push('目前仅观测到 CPU，尚未确认 GPU 卸载；可能发生 CPU 回退。')
  } else if (backend?.observed?.includes('cpu') && backend.observed.some(value => ['cuda', 'vulkan', 'metal'].includes(value))) {
    warnings.push('同时观测到 CPU 与 GPU 后端，可能存在混合运行；不能据此判断各类运算的位置。')
  }
  if (number(context?.actual) && number(model.configuration.contextWindow) && context.actual !== model.configuration.contextWindow) warnings.push(`实际上下文 ${tokens(context.actual)} 与已保存配置 ${tokens(model.configuration.contextWindow)} 不一致；当前实例可能使用了不同值，请核对后再使用。`)
  if (number(context?.actual) && number(context?.requested) && context.actual !== context.requested && context.requested !== model.configuration.contextWindow) warnings.push(`实例请求的上下文为 ${tokens(context.requested)}，与实际值不一致。`)
  return warnings
}

export function runtimeRecovery(error) {
  if (!error) return ''
  if (error === 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED') return '资源不足：可按需求降低上下文容量以减少 KV 缓存，或选择 CPU / 其它可用加速方式；CPU 仍需要足够系统内存。缩短输出上限不一定减少已分配的上下文缓存。'
  if (['EXTENSION_INFERENCE_ENGINE_TOO_OLD', 'EXTENSION_INFERENCE_MODEL_ARCHITECTURE_UNSUPPORTED', 'EXTENSION_INFERENCE_MODEL_QUANTIZATION_UNSUPPORTED'].includes(error)) return '当前引擎可能不支持该模型结构或量化格式。可在引擎管理中选择兼容版本；仅减少上下文通常无法修复兼容性问题。'
  if (['EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE', 'EXTENSION_INFERENCE_BACKEND_UNAVAILABLE'].includes(error)) return '可检查驱动与引擎后端是否匹配，或自行选择 CPU。修改参数或更换引擎后，由你决定何时再次运行。'
  return '可先核对运行参数与预算，再检查引擎兼容性。修改参数需要保存；不会自动降级、切换引擎或重试。'
}

function Timing({ label, value }) {
  return <div><dt>{label}</dt><dd>{number(value?.tokensPerSecond) ? `${value.tokensPerSecond.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} tokens/s` : '速率未知'}{number(value?.ms) && <small>{milliseconds(value.ms)}{number(value.tokens) ? ` · ${tokens(value.tokens)}` : ''}</small>}</dd></div>
}

export function RuntimeObservation({ model }) {
  const observation = model.runtimeObservation
  const selected = model.fields.find(field => field.key === 'acceleration')?.choices?.find(choice => choice.value === model.configuration.acceleration)?.title ?? model.configuration.acceleration ?? '未提供'
  const warnings = observationWarnings(model)
  const timestamp = observation?.updatedAt ?? observation?.observedAt
  const updatedAt = timestamp ? new Date(timestamp) : null
  return <section className="runtime-observation" aria-label="实际运行">
    <div className="section-heading"><h3>实际运行</h3>{updatedAt && Number.isFinite(updatedAt.getTime()) && <span>更新于 {updatedAt.toLocaleTimeString('zh-CN')}</span>}</div>
    <p className="field-help">已保存的选择：{selected} · 上下文 {tokens(model.configuration.contextWindow)} · 输出上限 {tokens(model.configuration.maxTokens)}</p>
    {!observation ? <p className="runtime-empty">尚未获得运行数据。当前实例未提供观测，或宿主尚不支持；配置与预算不能证明 GPU 已生效。</p> : <>
      <dl className="runtime-metrics">
        <div><dt>观测后端</dt><dd>{observation.backend?.observed?.length ? observation.backend.observed.map(backendLabel).join(' / ') : '尚未观测到'}</dd></div>
        <div><dt>观测设备</dt><dd>{observation.device?.length ? observation.device.map(device => `${backendLabel(device.backend)}${device.index}`).join(' / ') : '尚未观测到'}</dd></div>
        <div><dt>GPU 层卸载</dt><dd>{number(observation.offload?.layers) && number(observation.offload?.total) ? `${observation.offload.layers}/${observation.offload.total} 层在 GPU` : '未知'}</dd></div>
        <div><dt>实际上下文</dt><dd>{tokens(observation.context?.actual)}</dd></div>
      </dl>
      <details className="configuration-notes"><summary>更多运行数据</summary><dl className="runtime-metrics">
        <div><dt>实例请求后端</dt><dd>{backendLabel(observation.backend?.requested)}</dd></div>
        <div><dt>实例请求上下文</dt><dd>{tokens(observation.context?.requested)}</dd></div>
        <div><dt>训练上下文</dt><dd>{tokens(observation.context?.train)}</dd></div>
        <div><dt>加载耗时</dt><dd>{milliseconds(observation.loadMs)}</dd></div>
        <Timing label="输入处理" value={observation.timings?.prompt} /><Timing label="输出生成" value={observation.timings?.decode} />
      </dl><p className="field-help">设备编号来自引擎，未与系统硬件名称建立映射；全层卸载也不表示所有运算都在 GPU。</p></details>
      <p className="field-help">当前实例的观测，不代表质量或兼容性认证。</p>
      {warnings.length > 0 && <ul className="guidance-list runtime-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {observation.error && <p className="inline-error" role="alert">运行失败：{observation.error}</p>}
    </>}
  </section>
}
