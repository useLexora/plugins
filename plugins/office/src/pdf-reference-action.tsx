import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReferenceCapture, ReferenceChoice } from './lexora'
import type { OfficeEditorAssistant, OfficeEditorOptions } from './office-editor-types'

export function PdfReferenceAction({ options, assistant }: { options: OfficeEditorOptions; assistant: OfficeEditorAssistant }) {
  const [capture, setCapture] = useState<ReferenceCapture>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const host = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const active = useRef<ReferenceCapture>(undefined)
  const sequence = useRef(0)
  const pending = useRef(false)
  const release = (value?: ReferenceCapture) => { if (value) void options.context.references.release(value.id).catch(() => {}) }
  const close = () => { sequence.current++; pending.current = false; release(active.current); active.current = undefined; setCapture(undefined); setBusy(false); setError('') }
  const commit = async (value: ReferenceCapture, choice: ReferenceChoice) => {
    active.current = undefined
    setCapture(undefined)
    try {
      if (!await options.context.references.commit(value.id, choice)) throw new Error('来源或目标已变化，请重新选择文字。')
    } finally { release(value) }
  }
  const perform = async (choice: ReferenceChoice) => {
    const value = active.current
    if (!value || pending.current) return
    const request = sequence.current
    pending.current = true; setBusy(true)
    try { await commit(value, choice) }
    catch (reason) { if (request === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (request === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const open = async (choose: boolean) => {
    if (pending.current) return
    close()
    const request = sequence.current
    pending.current = true; setBusy(true)
    try {
      const reference = await assistant.reference()
      if (request !== sequence.current) return
      if (!reference || !options.captureReference) throw new Error('请先选择要引用的文字。')
      const value = await options.captureReference(reference)
      if (!value) throw new Error('当前视图不可引用，请重新选择文字。')
      if (request !== sequence.current) { release(value); return }
      active.current = value
      if (!choose && value.defaultId) await commit(value, { kind: 'view', id: value.defaultId })
      else setCapture(value)
    } catch (reason) { if (request === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (request === sequence.current) { pending.current = false; setBusy(false) } }
  }
  useEffect(() => {
    const outside = (event: Event) => { if (!host.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close() }
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape' && (active.current || pending.current)) {
        event.preventDefault(); event.stopPropagation(); close(); host.current?.querySelector('button')?.focus()
      } else if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && options.container.contains(event.target as Node)) {
        event.preventDefault(); event.stopPropagation(); void open(true)
      }
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      sequence.current++; release(active.current); active.current = undefined
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [])
  useLayoutEffect(() => {
    if ((!capture && !error) || !host.current || !menu.current) return
    const anchor = host.current.getBoundingClientRect()
    const box = menu.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8)), top: Math.max(8, anchor.bottom + box.height + 6 <= innerHeight - 8 ? anchor.bottom + 6 : anchor.top - box.height - 6) })
    menu.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [capture, error])
  const choices: { label: string; choice: ReferenceChoice }[] = capture ? [
    ...capture.targets.map(target => ({ label: target.label, choice: { kind: 'view' as const, id: target.id } })),
    { label: '新建任务并引用', choice: { kind: 'new-task' } },
    ...(capture.clipboard ? [{ label: '复制引用', choice: { kind: 'clipboard' as const } }] : []),
  ] : []
  return <span ref={host} className="office-pdf-reference-action" aria-busy={busy}>
    <button type="button" className="office-pdf-quote" disabled={busy} onClick={() => void open(false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M10 7H4v6h6V7Zm10 0h-6v6h6V7ZM10 13c0 3-2 5-5 5m15-5c0 3-2 5-5 5" /></svg>
      {busy ? '引用中…' : '引用'}
    </button>
    <button type="button" disabled={busy} aria-label="引用到其他位置" aria-haspopup="menu" aria-expanded={!!capture} onClick={() => void open(true)}>▾</button>
    {(capture || error) && createPortal(<div ref={menu} className="thumb-menu office-pdf-reference-menu" role={error ? 'alert' : 'menu'} aria-label={error ? undefined : '引用到'} style={position} onMouseDown={event => event.preventDefault()} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = [...menu.current!.querySelectorAll('button')]
      if (!buttons.length) return
      event.preventDefault(); event.stopPropagation()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
      {error ? <p>{error}</p> : choices.map((item, index) => <button type="button" role="menuitem" key={index} title={item.label} onClick={() => void perform(item.choice)}>{item.label}</button>)}
    </div>, options.container)}
  </span>
}
