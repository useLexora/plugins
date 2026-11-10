import React, { useEffect, useId, useReducer } from 'react'
import { TextInput } from '@mantine/core'
import { Button } from './ui'
import { Select } from './Select'
import { modelBudget } from '../runtimeGuidance.js'
import { formatBytes } from './catalogPresentation'

const basicKeys = ['acceleration', 'contextWindow', 'maxTokens']
const fieldHelp = {
  contextWindow: '上下文总容量，包括输入、输出和对话模板；较大值通常需要更多内存。',
  maxTokens: '单次生成的输出上限，不是保证输出的长度，且不能超过上下文容量。',
}

const contextPresets = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

export function Fields({ fields, draft, setDraft, disabled, errors = {}, explain = false }) {
  const id = useId()
  return <div className="configuration-fields">{fields.map(field => <div key={field.key} className="configuration-field">
    <label id={`${id}-${field.key}`} htmlFor={`${id}-${field.key}-input`}>{field.label}</label>
    <div className="configuration-control">{field.type === 'select'
      ? <Select id={`${id}-${field.key}-input`} aria-labelledby={`${id}-${field.key}`} aria-describedby={errors[field.key] || (explain && fieldHelp[field.key]) ? `${id}-${field.key}-help` : undefined} aria-invalid={!!errors[field.key]} value={draft[field.key] ?? ''} disabled={disabled} onChange={value => setDraft({ ...draft, [field.key]: value })} options={field.choices.map(choice => ({ value: choice.value, label: choice.title }))} />
      : <div className="configuration-value">
        <TextInput id={`${id}-${field.key}-input`} aria-labelledby={`${id}-${field.key}`} aria-describedby={errors[field.key] || (explain && fieldHelp[field.key]) ? `${id}-${field.key}-help` : undefined} aria-invalid={!!errors[field.key]} type={field.type === 'number' ? 'number' : 'text'} value={Number.isNaN(draft[field.key]) ? '' : draft[field.key] ?? ''} min={field.min} max={field.key === 'maxTokens' && Number.isFinite(draft.contextWindow) ? Math.min(field.max, draft.contextWindow) : field.max} step={field.step} disabled={disabled} onChange={event => setDraft({ ...draft, [field.key]: field.type === 'number' ? event.currentTarget.valueAsNumber : event.currentTarget.value })} />
        {field.key === 'contextWindow' && <Select className="context-presets" aria-label="上下文预设" value={contextPresets.includes(draft.contextWindow) ? String(draft.contextWindow) : 'custom'} disabled={disabled} onChange={value => { if (value !== 'custom') setDraft({ ...draft, contextWindow: Number(value) }) }} options={[{ value: 'custom', label: '自定义', disabled: true }, ...contextPresets.filter(value => value >= field.min && value <= field.max).map(value => ({ value: String(value), label: `${value / 1024}K` }))]} />}
      </div>}
      {(errors[field.key] || (explain && fieldHelp[field.key])) && <p id={`${id}-${field.key}-help`} className={errors[field.key] ? 'field-error' : 'field-help'}>{errors[field.key] || fieldHelp[field.key]}</p>}
    </div>
  </div>)}</div>
}

const sameConfiguration = (left, right) => Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))

export function configurationDraftState(state, configuration) {
  const saved = state.saved ?? configuration
  const draft = state.draft ?? saved
  return { saved, draft, dirty: !sameConfiguration(draft, saved) }
}

export function configurationDraftReducer(state, event) {
  if (event.type === 'edit') return { ...state, draft: event.draft, error: '' }
  if (event.type === 'saving') return { ...state, saving: true, error: '' }
  if (event.type === 'confirmed') return state.saved && sameConfiguration(state.saved, event.configuration) ? { ...state, saved: null } : state
  if (event.type === 'saved') return { ...state, saving: false, saved: event.ok ? event.configuration ?? event.submitted : state.saved, draft: event.ok && state.draft === event.submitted ? null : state.draft, error: event.ok ? '' : event.error || '保存失败，草稿已保留。请查看错误信息后再保存。' }
  return state
}

export function configurationErrors(model, draft) {
  const errors = {}
  for (const field of model.fields) {
    const value = draft[field.key]
    const valid = field.type === 'select' ? field.choices.some(choice => choice.value === value)
      : field.type === 'number' ? Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isInteger(value))
        : typeof value === 'string' && value.trim().length > 0 && value.length <= (field.key === 'baseUrl' ? 1024 : 100)
    if (!valid) errors[field.key] = field.type === 'number' ? `请输入 ${field.min}–${field.max} 范围内的${field.integer ? '整数' : '数值'}。` : `请填写有效的${field.label}。`
  }
  if (['chat', 'vision'].includes(model.runtime) && draft.maxTokens > draft.contextWindow) errors.maxTokens = '最大输出不能超过上下文容量；请按需修改其中一项，不会自动调整。'
  return errors
}

export function BudgetPreview({ model, draft, hardware }) {
  const budget = modelBudget(model, draft, hardware)
  const remaining = budget.status !== 'unknown' && Number.isFinite(budget.availableBytes) && Number.isFinite(budget.estimatedBytes) && Number.isFinite(budget.reserveBytes) ? budget.availableBytes - budget.estimatedBytes - budget.reserveBytes : undefined
  const bytes = value => Number.isFinite(value) ? formatBytes(value) : '未知'
  return <section className={`configuration-budget configuration-budget--${budget.status}`} aria-label="运行预算预检">
    <div className="section-heading"><h3>运行预算预检</h3><span>{({ risk: '存在风险', 'within-estimate': '估算范围内', unknown: '信息不足' })[budget.status]}</span></div>
    <p className="field-help">当前草稿 · {({ ram: '系统内存', vram: '显存', unified: '统一内存', unknown: '内存范围未知' })[budget.scope]} · 估算不保证启动成功</p>
    <dl className="runtime-metrics">
      <div><dt>权重</dt><dd>{bytes(budget.weightBytes)}</dd></div><div><dt>KV 缓存</dt><dd>{bytes(budget.kvBytes)}</dd></div>
      <div><dt>估算占用</dt><dd>{bytes(budget.estimatedBytes)}</dd></div><div><dt>容量参考</dt><dd>{bytes(budget.availableBytes)}</dd></div>
      <div><dt>安全预留</dt><dd>{bytes(budget.reserveBytes)}</dd></div><div><dt>扣除预留后余量</dt><dd>{Number.isFinite(remaining) && remaining < 0 ? `不足 ${bytes(-remaining)}` : bytes(remaining)}</dd></div>
    </dl>
    {!hardware && <p className="field-help">当前宿主未提供硬件信息，部分预算无法评估；仍可手动配置。</p>}
    {hardware && budget.status === 'unknown' && <p className="field-help">{!Number.isFinite(budget.kvBytes) ? 'KV 缓存信息不足，无法确认完整预算。' : !Number.isFinite(budget.availableBytes) ? '可用容量未知，无法确认预算余量。' : ['idle', 'running', 'loading', 'stopping'].includes(model.state) ? '模型已在运行或加载，剩余容量不能视为加载前预算。' : '现有信息不足以确认完整预算，请查看估算说明。'}</p>}
    {budget.warnings.length > 0 && <details className="configuration-notes"><summary>估算说明</summary><ul className="guidance-list">{budget.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    {budget.status === 'risk' && <p className="field-help">风险提示不阻止保存。可按需求修改上下文或加速方式，也可保留当前选择。</p>}
  </section>
}

export function ModelConfiguration({ model, hardware, disabled, run }) {
  const [editing, dispatch] = useReducer(configurationDraftReducer, { draft: null, saved: null, saving: false, error: '' })
  const { draft, dirty } = configurationDraftState(editing, model.configuration)
  const setDraft = value => dispatch({ type: 'edit', draft: value })
  useEffect(() => {
    dispatch({ type: 'confirmed', configuration: model.configuration })
  }, [model.configuration, editing.saved])
  const conversational = ['chat', 'vision'].includes(model.runtime)
  const basic = conversational ? basicKeys.flatMap(key => model.fields.filter(field => field.key === key)) : model.fields
  const advanced = conversational ? model.fields.filter(field => !basicKeys.includes(field.key)) : []
  const errors = configurationErrors(model, draft)
  const invalid = Object.keys(errors).length > 0
  const locked = disabled || editing.saving
  const save = async event => {
    event.preventDefault()
    if (locked || !dirty || invalid) return
    dispatch({ type: 'saving' })
    try {
      const configuration = Object.fromEntries(model.fields.map(({ key }) => [key, typeof draft[key] === 'string' ? draft[key].trim() : draft[key]]))
      const result = await run('configure', { modelId: model.id, configuration }, '参数已保存')
      dispatch({ type: 'saved', submitted: draft, configuration, ok: !!result && result.ok !== false })
    } catch (error) {
      dispatch({ type: 'saved', submitted: draft, ok: false, error: `保存失败，草稿已保留：${error.message}` })
    }
  }
  return <form className="configuration" noValidate onSubmit={save}>
    {conversational && <section className="configuration-recommendation" aria-label="推荐参数">
      <div className="section-heading"><h3>按需求调整</h3><Button type="button" disabled={locked || !model.recommendation?.configuration} onClick={() => setDraft({ ...draft, ...Object.fromEntries(model.fields.filter(field => Object.hasOwn(model.recommendation.configuration, field.key)).map(field => [field.key, model.recommendation.configuration[field.key]])) })}>使用推荐值</Button></div>
      <p className="field-help">推荐可修改，也可能有风险；只替换本地草稿，仍须保存，不会持续自动调整。</p>
      {model.recommendation?.reasons?.length > 0 ? <details className="configuration-notes"><summary>推荐依据</summary><ul className="guidance-list">{model.recommendation.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details> : !model.recommendation?.configuration && <p className="field-help">尚无推荐值，请按需求手动配置。</p>}
    </section>}
    <Fields fields={basic} draft={draft} setDraft={setDraft} disabled={locked} errors={errors} explain={conversational} />
    {advanced.length > 0 && <details className="configuration-advanced"><summary>高级参数{advanced.some(field => errors[field.key]) ? '（有无效参数）' : ''}</summary><Fields fields={advanced} draft={draft} setDraft={setDraft} disabled={locked} errors={errors} /></details>}
    {conversational && <BudgetPreview model={model} draft={draft} hardware={hardware} />}
    {editing.error && <p className="inline-error" role="alert">{editing.error}</p>}
    <div className="form-actions"><Button type="submit" appearance="primary" disabled={locked || !dirty || invalid}>{editing.saving ? '正在保存…' : '保存参数'}</Button><span className="field-help" role="status">{dirty ? invalid ? '请修正无效参数后保存' : '有未保存的修改' : editing.saved ? '已保存，等待状态确认' : '与已保存参数一致'}</span></div>
  </form>
}
