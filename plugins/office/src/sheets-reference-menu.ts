import { CommandType, ICommandService, type Injector } from '@univerjs/core'
import { ComponentManager, ContextMenuPosition, IContextMenuService, IMenuManagerService, IMessageService, MenuItemType, type IValueOption } from '@univerjs/ui'
import { createElement } from 'react'
import { BehaviorSubject, Observable, map, shareReplay, switchMap } from 'rxjs'
import type { ReferenceCapture, ReferenceChoice } from './lexora'
import type { OfficeEditorAssistant, OfficeEditorOptions, OfficeEditorReference } from './office-editor-types'

interface MenuState {
  capture?: ReferenceCapture
  error?: string
}

export function installSheetsReferenceMenu(options: OfficeEditorOptions, assistant: OfficeEditorAssistant, injector: Injector) {
  const menus = injector.get(IMenuManagerService)
  const contextMenu = injector.get(IContextMenuService)
  const commandId = 'office.operation.reference'
  const icon = injector.get(ComponentManager).register('OfficeReferenceIcon', () => createElement('svg', { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, createElement('path', { d: 'M10 7H4v6h6V7Zm10 0h-6v6h6V7ZM10 13c0 3-2 5-5 5m15-5c0 3-2 5-5 5' })))
  let current: { capture: ReferenceCapture; claimed: boolean } | undefined
  let disposed = false
  let cancelFocus = () => {}
  const focusWhenVisible = (selector: string) => {
    cancelFocus()
    const observer = new MutationObserver(focus)
    const timeout = setTimeout(() => observer.disconnect(), 1000)
    cancelFocus = () => { observer.disconnect(); clearTimeout(timeout) }
    function focus() {
      const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(candidate => {
        const rect = candidate.getBoundingClientRect()
        return candidate.checkVisibility({ visibilityProperty: true }) && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      })
      if (!button) return
      cancelFocus()
      button.focus({ preventScroll: true })
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'disabled'] })
    focus()
  }
  const release = (capture: ReferenceCapture) => { void options.context.references.release(capture.id).catch(() => {}) }
  const requests = new BehaviorSubject<Promise<OfficeEditorReference | null> | undefined>(undefined)
  const captureSelection = () => {
    if (disposed) return
    const reference = assistant.reference()
    void reference.catch(() => {})
    requests.next(reference)
  }
  const state$ = requests.pipe(switchMap(reference => new Observable<MenuState>(subscriber => {
    let active = true
    let selected: typeof current
    subscriber.next({})
    void (async () => {
      const value = await (reference ?? assistant.reference())
      if (!active || disposed) return
      if (!value || !options.captureReference) throw new Error('请先选择要引用的单元格。')
      const capture = await options.captureReference(value)
      if (!capture) throw new Error('当前视图不可引用，请重新打开菜单。')
      if (!active || disposed) { release(capture); return }
      selected = { capture, claimed: false }
      current = selected
      subscriber.next({ capture })
    })().catch(error => {
      if (active && !disposed) subscriber.next({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      active = false
      if (current === selected) current = undefined
      if (selected && !selected.claimed) release(selected.capture)
    }
  })), shareReplay({ bufferSize: 1, refCount: true }))
  const selections = state$.pipe(map(({ capture, error }): IValueOption[] => capture ? [
    ...capture.targets.map(target => ({ label: target.label, params: { captureId: capture.id, choice: { kind: 'view', id: target.id } } })),
    { label: '新建任务并引用', params: { captureId: capture.id, choice: { kind: 'new-task' } } },
    ...(capture.clipboard ? [{ label: '复制引用', params: { captureId: capture.id, choice: { kind: 'clipboard' } } }] : []),
  ] : [{ label: error ?? '准备引用…', disabled: true }]))
  const command = injector.get(ICommandService).registerCommand({
    id: commandId,
    type: CommandType.OPERATION,
    handler: async (_, params?: { captureId?: string; choice?: ReferenceChoice }) => {
      const selected = current
      if (!selected || selected.claimed || params?.captureId !== selected.capture.id) return false
      const choice = params.choice ?? (selected.capture.defaultId ? { kind: 'view' as const, id: selected.capture.defaultId } : undefined)
      if (!choice) return false
      selected.claimed = true
      try {
        if (!await options.context.references.commit(selected.capture.id, choice)) throw new Error('来源或目标已变化，请重新打开菜单。')
        return true
      } catch (error) {
        if (!disposed) injector.get(IMessageService).show({ content: error instanceof Error ? error.message : String(error) })
        return false
      } finally { release(selected.capture) }
    },
  })
  for (const position of [ContextMenuPosition.MAIN_AREA, ContextMenuPosition.ROW_HEADER, ContextMenuPosition.COL_HEADER]) {
    menus.mergeMenu({ [position]: { 'office-reference': {
      order: 1,
      'office.reference.select': { order: 0, menuItemFactory: () => ({
        id: 'office.reference.select', title: '引用', icon: 'OfficeReferenceIcon', type: MenuItemType.SELECTOR,
        selections, selectionsCommandId: commandId,
        disabled$: state$.pipe(map(state => !state.capture && !state.error)),
        hidden$: state$.pipe(map(state => !!state.capture?.defaultId)),
      }) },
      'office.reference.direct': { order: 1, menuItemFactory: () => ({
        id: 'office.reference.direct', title: '引用', icon: 'OfficeReferenceIcon', type: MenuItemType.BUTTON_SELECTOR,
        commandId, selections, selectionsCommandId: commandId,
        params: () => ({ captureId: current?.capture.id }),
        hidden$: state$.pipe(map(state => !state.capture?.defaultId)),
      }) },
    } } })
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || !(event.target instanceof Element)) return
    if (event.key === 'Escape') cancelFocus()
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      if (!options.container.contains(event.target) && !event.target.closest('[data-u-comp=editor]')) return
      event.preventDefault(); event.stopPropagation()
      captureSelection()
      const rect = options.container.getBoundingClientRect()
      contextMenu.triggerContextMenu(Object.assign(new MouseEvent('contextmenu', { clientX: rect.left + 24, clientY: rect.top + 24 }), { deviceType: 1, inputIndex: 4, previousState: 0, currentState: 1 }), ContextMenuPosition.MAIN_AREA)
      focusWhenVisible('section.univer-popup button:not(:disabled)')
      return
    }
    if (!contextMenu.visible) return
    const menu = event.target.closest('[data-u-context-menu-submenu],section.univer-popup')
    if (!menu) return
    if (event.key === 'ArrowRight' && event.target.closest('button')?.textContent?.trim() === '引用') {
      event.preventDefault(); event.stopPropagation()
      event.target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      focusWhenVisible('[data-u-context-menu-submenu] button:not(:disabled)')
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button => button.getClientRects().length)
    if (!buttons.length) return
    event.preventDefault(); event.stopPropagation()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  const pointerdown = (event: PointerEvent) => {
    if (event.button === 2) queueMicrotask(captureSelection)
  }
  options.container.addEventListener('pointerdown', pointerdown, true)
  document.addEventListener('keydown', keydown, true)
  return () => {
    disposed = true
    cancelFocus()
    if (current && !current.claimed) release(current.capture)
    current = undefined
    command.dispose()
    icon.dispose()
    requests.complete()
    options.container.removeEventListener('pointerdown', pointerdown, true)
    document.removeEventListener('keydown', keydown, true)
  }
}
