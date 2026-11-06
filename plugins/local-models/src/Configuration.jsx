import React, { useId, useState } from 'react'
import { TextInput } from '@mantine/core'
import { Button } from './ui'
import { Select } from './Select'

const contextPresets = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

export function Fields({ fields, draft, setDraft, disabled }) {
  const id = useId()
  return <div className="configuration-fields">{fields.map(field => <div key={field.key} className="configuration-field">
    <label id={`${id}-${field.key}`} htmlFor={`${id}-${field.key}-input`}>{field.label}</label>
    {field.type === 'select'
      ? <Select id={`${id}-${field.key}-input`} aria-labelledby={`${id}-${field.key}`} value={draft[field.key] ?? ''} disabled={disabled} onChange={value => setDraft({ ...draft, [field.key]: value })} options={field.choices.map(choice => ({ value: choice.value, label: choice.title }))} />
      : <div className="configuration-value">
        <TextInput id={`${id}-${field.key}-input`} aria-labelledby={`${id}-${field.key}`} type={field.type === 'number' ? 'number' : 'text'} value={Number.isNaN(draft[field.key]) ? '' : draft[field.key] ?? ''} min={field.min} max={field.key === 'maxTokens' && Number.isFinite(draft.contextWindow) ? Math.min(field.max, draft.contextWindow) : field.max} step={field.step} disabled={disabled} onChange={event => setDraft({ ...draft, [field.key]: field.type === 'number' ? event.currentTarget.valueAsNumber : event.currentTarget.value })} />
        {field.key === 'contextWindow' && <Select className="context-presets" aria-label="上下文预设" value={contextPresets.includes(draft.contextWindow) ? String(draft.contextWindow) : 'custom'} disabled={disabled} onChange={value => { if (value !== 'custom') setDraft({ ...draft, contextWindow: Number(value) }) }} options={[{ value: 'custom', label: '自定义', disabled: true }, ...contextPresets.filter(value => value >= field.min && value <= field.max).map(value => ({ value: String(value), label: `${value / 1024}K` }))]} />}
      </div>}
  </div>)}</div>
}

export function ModelConfiguration({ model, disabled, run }) {
  const [draft, setDraft] = useState(model.configuration)
  const dirty = JSON.stringify(draft) !== JSON.stringify(model.configuration)
  return <form className="configuration" onSubmit={event => { event.preventDefault(); void run('configure', { modelId: model.id, configuration: draft }, '参数已保存') }}>
    <Fields fields={model.fields} draft={draft} setDraft={setDraft} disabled={disabled} />
    <div className="form-actions"><Button type="submit" appearance="primary" disabled={disabled || !dirty}>保存参数</Button></div>
  </form>
}
