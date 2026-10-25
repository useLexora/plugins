import type { ViewContext } from './lexora'
import { startOffice } from './office-controller'
import './office.css'

export async function renderOffice(context: ViewContext, container: HTMLElement, persistState: boolean) {
  if (context.signal.aborted) return
  const css = document.createElement('link')
  css.rel = 'stylesheet'; css.href = new URL('./view.css', import.meta.url).href
  const root = document.createElement('div')
  root.className = 'office-app'; root.dataset.office = ''
  const loading = document.createElement('p')
  loading.setAttribute('role', 'status'); loading.textContent = '正在打开 Office…'
  loading.style.cssText = 'padding:20px;margin:0;font:13px/1.5 var(--lexora-font-ui,system-ui,sans-serif);color:var(--lexora-text,CanvasText)'
  root.append(loading)
  container.append(root)
  let rejectStyles: ((error: Error) => void) | undefined
  const clearLoadHandlers = () => { css.onload = null; css.onerror = null; rejectStyles = undefined }
  const stylesReady = new Promise<void>((resolve, reject) => {
    rejectStyles = reject
    css.onload = () => { clearLoadHandlers(); resolve() }
    css.onerror = () => { clearLoadHandlers(); reject(new Error('Office 样式加载失败，请关闭后重新打开。')) }
  })
  context.signal.addEventListener('abort', () => {
    rejectStyles?.(new DOMException('Office 已关闭。', 'AbortError'))
    clearLoadHandlers(); css.remove(); root.remove()
  }, { once: true })
  document.head.append(css)
  const reportError = (error: unknown) => {
    if (context.signal.aborted) return
    loading.remove()
    const message = document.createElement('p'); message.className = 'office-start-error'; message.setAttribute('role', 'alert')
    message.style.cssText = 'padding:20px;margin:0;font:13px/1.5 var(--lexora-font-ui,system-ui,sans-serif);color:var(--lexora-text,CanvasText)'
    message.textContent = error instanceof Error ? error.message : String(error); root.append(message)
  }
  try {
    await stylesReady
    if (context.signal.aborted) return
    root.replaceChildren()
    void startOffice(context, root, persistState).catch(reportError)
  } catch (error) { reportError(error) }
}

export function render(context: ViewContext, container: HTMLElement) { return renderOffice(context, container, true) }
