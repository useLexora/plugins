import { useLayoutEffect, useRef, useState } from 'react'
import type { ReferenceCapture, ReferenceChoice } from './lexora'
import type { OfficeEditorAssistant, OfficeEditorOptions } from './office-editor-types'

type Binding = { options: OfficeEditorOptions; assistant: () => OfficeEditorAssistant | undefined; active: boolean; cancel: Set<() => void> }
let binding: Binding | undefined

export function useOfficeReferenceMenu(identity: unknown, close: () => void, report: (message: string) => void) {
  const [capture, setCapture] = useState<ReferenceCapture>()
  const [error, setError] = useState('')
  const current = useRef<{ capture: ReferenceCapture; claimed: boolean; binding: Binding } | undefined>(undefined)
  useLayoutEffect(() => {
    const source = binding
    if (!identity || !source?.active) return
    let alive = true
    const cancel = () => {
      alive = false
      const selected = current.current
      current.current = undefined
      if (selected && !selected.claimed) void source.options.context.references.release(selected.capture.id).catch(() => {})
    }
    source.cancel.add(cancel)
    setCapture(undefined); setError('')
    void (async () => {
      const reference = await source.assistant()?.reference()
      if (!alive || !source.active) return
      if (!reference || !source.options.captureReference) throw new Error('请先选择要引用的内容。')
      const value = await source.options.captureReference(reference)
      if (!value) throw new Error('来源已变化，请重新打开菜单。')
      if (!alive || !source.active) { void source.options.context.references.release(value.id).catch(() => {}); return }
      current.current = { capture: value, claimed: false, binding: source }
      setCapture(value)
    })().catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancel(); source.cancel.delete(cancel) }
  }, [identity])
  const perform = (choice: ReferenceChoice) => {
    const selected = current.current
    if (!selected || selected.claimed || !selected.binding.active) return
    selected.claimed = true
    close()
    void selected.binding.options.context.references.commit(selected.capture.id, choice).then(accepted => {
      if (!accepted) throw new Error('来源或目标已变化，请重新引用。')
    }).catch(reason => {
      if (selected.binding.active) report(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { void selected.binding.options.context.references.release(selected.capture.id).catch(() => {}) })
  }
  return identity ? {
    label: '引用',
    disabled: !capture,
    title: error || (capture ? '引用所选内容' : '准备引用…'),
    onClick: capture?.defaultId ? () => perform({ kind: 'view', id: capture.defaultId! }) : undefined,
    sub: capture ? [
      ...capture.targets.map(target => ({ label: target.label, onClick: () => perform({ kind: 'view', id: target.id }) })),
      { label: '新建任务并引用', onClick: () => perform({ kind: 'new-task' }) },
      ...(capture.clipboard ? [{ label: '复制引用', onClick: () => perform({ kind: 'clipboard' }) }] : []),
    ] : [],
  } : undefined
}

export function installOfficeReferenceMenu(options: OfficeEditorOptions, assistant: () => OfficeEditorAssistant | undefined) {
  const source: Binding = { options, assistant, active: true, cancel: new Set() }
  binding = source
  return () => {
    source.active = false
    for (const cancel of source.cancel) cancel()
    source.cancel.clear()
    if (binding === source) binding = undefined
  }
}
