import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Button, Dropdown, Tooltip, type MenuProps } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, CopyOutlined, DownOutlined, DownloadOutlined, InfoCircleOutlined, LoadingOutlined, ReloadOutlined, SaveOutlined, WarningOutlined } from '@ant-design/icons'
import { OfficeTheme } from './office-theme'
import { OfficeFileBadge } from './office-home-icons'
import type { OfficeKind } from './office-library'

export interface EditorChromeState {
  name: string
  kind: OfficeKind
  dirty: boolean
  saving: boolean
  failed: boolean
  loading: boolean
}

interface EditorChromeActions {
  back(): Promise<void>
  quote(): Promise<void>
  save(): Promise<void>
  reopen(): Promise<void>
  export(): Promise<void>
  copy(): Promise<void>
  error(error: unknown): void
}

function EditorChrome({ state, actions }: { state: EditorChromeState; actions: EditorChromeActions }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)
  const focusFrame = useRef(0)
  const menuFocusFrame = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelAnimationFrame(focusFrame.current); cancelAnimationFrame(menuFocusFrame.current) } }, [])
  const perform = async (key: string, action: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    setPending(key)
    try { await action() } catch (error) { actions.error(error) }
    finally { busy.current = false; if (mounted.current) setPending(undefined) }
  }
  const menuPopupRef = useCallback((node: HTMLDivElement | null) => {
    cancelAnimationFrame(menuFocusFrame.current)
    if (menuOpen && node) {
      const focus = (frames: number) => {
        menuFocusFrame.current = requestAnimationFrame(() => {
          if (frames > 1) focus(frames - 1)
          else node.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true })
        })
      }
      focus(3)
    }
  }, [menuOpen])
  const disabled = state.loading || !!pending
  const status = state.loading ? '正在打开' : state.saving ? '正在保存' : state.failed ? '保存失败' : state.dirty ? '未保存' : '已保存'
  const statusTip = state.failed ? '修改仍保留在当前页面，可重试保存、导出或另存副本。' : state.dirty ? '修改将自动保存到文档库。' : '文档保存在 Office 文档库中。'
  const items: MenuProps['items'] = [
    { key: 'export', icon: <DownloadOutlined aria-hidden="true" />, label: '导出', onClick: () => void perform('export', actions.export) },
    { key: 'copy', icon: <CopyOutlined aria-hidden="true" />, label: '另存副本', onClick: () => void perform('copy', actions.copy) },
    { type: 'divider' },
    { key: 'reopen', icon: <ReloadOutlined aria-hidden="true" />, label: '重新打开', onClick: () => void perform('reopen', actions.reopen) },
  ]
  const restoreMenuFocus = () => {
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const closeMenu = () => { setMenuOpen(false); restoreMenuFocus() }
  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() }
  }
  return <header className="office-document-bar" aria-label="文档操作" onKeyDownCapture={event => {
    if (event.key === 'Escape' && menuOpen) onMenuKeyDown(event)
  }}>
    <Tooltip title="文档库"><Button type="text" className="office-chrome-icon" icon={<ArrowLeftOutlined aria-hidden="true" />} aria-label="文档库" disabled={disabled} onClick={() => void perform('back', actions.back)} /></Tooltip>
    <span className="office-document-separator" aria-hidden="true" />
    <Dropdown trigger={['click']} destroyOnHidden popupRender={menu => <div ref={menuPopupRef}>{menu}</div>} open={menuOpen} disabled={disabled} menu={{ items, onClick: () => setMenuOpen(false), onKeyDown: onMenuKeyDown }} onOpenChange={(open, info) => {
      setMenuOpen(open)
      if (!open && info.source === 'menu') restoreMenuFocus()
    }}>
      <Button ref={trigger} type="text" className="office-document-title" disabled={disabled} aria-label="文件菜单" aria-haspopup="menu" aria-expanded={menuOpen} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true) }
      }}>
        <OfficeFileBadge kind={state.kind} size={20} />
        <span className="office-document-name" title={state.name}>{state.name}</span>
        <DownOutlined aria-hidden="true" className="office-document-caret" />
      </Button>
    </Dropdown>
    <div className="office-document-save">
      <Tooltip title="将选中内容引用到任务，或复制引用"><Button type="text" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => void perform('quote', actions.quote)}>引用</Button></Tooltip>
      <Tooltip title={statusTip}><span className="office-save-state" role="status" aria-live="polite" data-dirty={state.dirty} data-failed={state.failed}>
        {state.loading || state.saving ? <LoadingOutlined aria-hidden="true" /> : state.failed ? <WarningOutlined aria-hidden="true" /> : state.dirty ? <span className="office-dirty-dot" aria-hidden="true" /> : <CheckOutlined aria-hidden="true" />}
        <span>{status}</span>
      </span></Tooltip>
      <Tooltip title={state.failed ? '重试保存 (Ctrl/⌘+S)' : '保存 (Ctrl/⌘+S)'}><Button type="text" className="office-chrome-icon" icon={<SaveOutlined aria-hidden="true" />} aria-label="保存" loading={pending === 'save' || state.saving ? { icon: <LoadingOutlined aria-hidden="true" /> } : false} disabled={disabled || state.saving} onClick={() => void perform('save', actions.save)} /></Tooltip>
    </div>
  </header>
}

export function mountEditorChrome(host: HTMLElement, initial: EditorChromeState, actions: EditorChromeActions) {
  const root = createRoot(host)
  const render = (state: EditorChromeState) => root.render(<OfficeTheme host={host}><EditorChrome state={state} actions={actions} /></OfficeTheme>)
  render(initial)
  return { update: render, dispose: () => root.unmount() }
}

interface NoticeAction { label: string; run(): Promise<void> }
interface OfficeNotice { id: number; text: string; error: boolean; actions: NoticeAction[] }

function Notice({ notice }: { notice: OfficeNotice }) {
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const perform = async (action: NoticeAction) => {
    if (busy.current) return
    busy.current = true; setPending(action.label)
    try { await action.run() }
    finally { busy.current = false; if (mounted.current) setPending(undefined) }
  }
  useEffect(() => {
    if (notice.error) return
    const timer = setTimeout(() => setOpen(false), 3000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!open) return null
  return <div className="office-notice" role={notice.error ? 'alert' : 'status'} aria-live={notice.error ? 'assertive' : 'polite'}>
    <Alert type={notice.error ? 'error' : /^已(?:导出|导入|创建)/.test(notice.text) ? 'success' : 'info'} showIcon icon={notice.error ? <WarningOutlined aria-hidden="true" /> : /^已(?:导出|导入|创建)/.test(notice.text) ? <CheckOutlined aria-hidden="true" /> : <InfoCircleOutlined aria-hidden="true" />} message={notice.text} description={notice.actions.length ? <div className="office-notice-actions">{notice.actions.map(action => <Button key={action.label} size="small" disabled={!!pending} loading={pending === action.label ? { icon: <LoadingOutlined aria-hidden="true" /> } : false} onClick={() => void perform(action)}>{action.label}</Button>)}</div> : undefined} closable={{ closeIcon: <CloseOutlined aria-hidden="true" />, 'aria-label': '关闭提示', onClose: () => setOpen(false) }} />
  </div>
}

export function mountOfficeNotices(host: HTMLElement) {
  const root = createRoot(host)
  let nextId = 0
  return {
    show(text: string, error = false, actions: NoticeAction[] = []) {
      const notice = text ? { id: ++nextId, text, error, actions } : undefined
      root.render(<OfficeTheme host={host}>{notice && <Notice key={notice.id} notice={notice} />}</OfficeTheme>)
    },
    dispose: () => root.unmount(),
  }
}
