import { installOfficeReferenceMenu } from './office-reference-menu'
import { createSlidesAssistant } from './slides-assistant'
import type { ExportImagesOp, SavePictureOp } from '../vendor/genoffice/apps/slides/src/shared/ipc'
import { readOfficeResource } from './office-resource-bytes'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../vendor/genoffice/apps/slides/src/renderer/App'
import { LocaleProvider, setModuleLang } from '../vendor/genoffice/apps/slides/src/renderer/i18n/locale'
import { flushActiveEdit } from '../vendor/genoffice/apps/slides/src/renderer/file-actions'
import { readEditSelection } from '../vendor/genoffice/apps/slides/src/renderer/TextEditOverlay'
import type { ActionCtx } from '../vendor/genoffice/apps/slides/src/renderer/action-context'
import { createBlankPptx as buildBlank } from '../vendor/genoffice/packages/pptx-engine/src/blank'
import { defaultAiSettings } from '../vendor/genoffice/packages/ai-provider/src/providers'
import { applyAiPanelPrefs, installScreenTips } from '../vendor/genoffice/packages/ui/src'
import { createSlidesApi } from '../generated/slides-api.mjs'
import type { OfficeEditor, OfficeEditorOptions } from './office-editor-types'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/ai-model-picker.css'
import '@genoffice/ui/ai-queue-strip.css'
import '@genoffice/ui/ai-usage.css'
import '@genoffice/ui/ai-skills.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '../vendor/genoffice/apps/slides/src/renderer/styles.css'
import './slides-style.css'

export const createBlankPptx = (): Promise<Uint8Array> => buildBlank()
const prefs = { side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: false, openInNewDocs: false, showAiSidebar: false } as const
const bytesFromBase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))
const toBase64 = (bytes: Uint8Array) => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text) }

export async function mountSlidesEditor(options: OfficeEditorOptions): Promise<OfficeEditor> {
  const { context, container, name } = options
  context.signal.throwIfAborted()
  const worker = await context.workers.create(new URL('./slides-worker.js', import.meta.url), { type: 'module' })
  if (context.signal.aborted) { worker.terminate(); context.signal.throwIfAborted() }
  let disposed = false
  let workerFailure: Error | undefined
  let nextId = 0
  let readContext: (() => ActionCtx) | undefined
  let latestBytes: Uint8Array | undefined
  const snapshots = new WeakMap<Uint8Array, number>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const events = new Map<string, Set<(...args: unknown[]) => void>>()
  const ensureActive = () => { context.signal.throwIfAborted(); if (disposed) throw new Error('演示文稿已关闭。'); if (workerFailure) throw workerFailure }
  const request = (method: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
    try { ensureActive(); const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }) }
    catch (error) { reject(error) }
  })
  const emit = (channel: string, ...args: unknown[]) => { for (const listener of events.get(channel) ?? []) listener({}, ...args) }
  const pickFiles = async (pick: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const files = await context.resources.pickFiles({ filters: pick.filters })
    return Promise.all(files.map(async file => {
      return { path: file.name, bytes: await readOfficeResource(context, file, 32 * 1024 * 1024) }
    }))
  }
  const confirm = (question: { message: string; detail?: string; buttons: string[]; cancelId?: number }) => new Promise<{ response: number }>(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'office-slides-confirm'
    const title = document.createElement('h3'); title.textContent = question.message
    const text = document.createElement('p'); text.textContent = question.detail ?? ''
    const actions = document.createElement('div')
    let settled = false
    const close = (response: number) => { if (settled) return; settled = true; dialog.remove(); resolve({ response }) }
    question.buttons.forEach((label, index) => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => close(index); actions.append(button) })
    dialog.append(title, text, actions); container.append(dialog)
    dialog.addEventListener('cancel', () => close(question.cancelId ?? 1))
    context.signal.addEventListener('abort', () => close(question.cancelId ?? 1), { once: true })
    dialog.showModal()
  })
  worker.onmessage = async ({ data }) => {
    if (data.bridge) {
      try {
        const value = data.channel === 'pick-files' ? await pickFiles(data.args[0]) : data.channel === 'confirm' ? await confirm(data.args[0]) : undefined
        worker.postMessage({ bridgeResult: data.bridge, value })
      } catch (error) { worker.postMessage({ bridgeResult: data.bridge, error: String(error) }) }
    } else if (data.event) emit(data.event, ...data.args)
    else if (typeof data.dirty === 'boolean') { if (!disposed) options.onDirty(data.dirty) }
    else {
      const call = pending.get(data.id); pending.delete(data.id)
      if (data.error) call?.reject(new Error(data.error)); else call?.resolve(data.value)
    }
  }
  const failWorker = (error: Error) => { workerFailure = error; for (const call of pending.values()) call.reject(error); pending.clear(); rejectReady?.(error) }
  worker.onerror = error => failWorker(new Error(error.message || '演示文稿编辑引擎已停止，请重新打开文件。'))
  worker.onmessageerror = () => failWorker(new Error('演示文稿编辑引擎通信失败，请重新打开文件。'))
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let openResult: Promise<unknown> | undefined
  const saveFile = async (fileName: string, data: Uint8Array) => context.resources.saveFile({ name: fileName, data })
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    ensureActive()
    switch (channel) {
      case 'app:get-language': return 'zh'
      case 'app:get-theme': return context.environment.colorScheme
      case 'app:get-auto-save-default': return { on: false, updatedAt: 1 }
      case 'app:get-ai-panel-prefs': case 'app:set-ai-panel-prefs': return prefs
      case 'ai:get-settings': return defaultAiSettings()
      case 'ai:skills-list': case 'ai:list-style-templates': case 'slides:recent':
      case 'slides:font-catalog': case 'slides:private-font-faces': case 'slides:font-missing': return []
      case 'ai:gsk-status': return { loggedIn: false }
      case 'slides:consume-headless-export': return null
      case 'slides:consume-pending-open':
        openResult ??= request('open', options.bytes, name, args[0])
        return openResult
      case 'slides:save-as':
      case 'slides:save':
        try {
          if (options.onSaveRequest) await options.onSaveRequest()
          else { const bytes = await editor.save(); if (!options.onSave) throw new Error('请使用 Office 顶栏保存。'); await options.onSave(bytes); await editor.markSaved?.(bytes) }
          return { ok: true, path: name }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      case 'slides:pick-export-dir': return '图片压缩包'
      case 'slides:export-images': {
        const { default: JSZip } = await import('jszip')
        const zip = new JSZip()
        const op = args[0] as ExportImagesOp
        const paths = op.pngsBase64.map((base64: string, index: number) => { const path = `${op.baseName}-${String(index + 1).padStart(2, '0')}.png`; zip.file(path, bytesFromBase64(base64)); return path })
        return { ok: await saveFile(`${op.baseName}-图片.zip`, await zip.generateAsync({ type: 'uint8array' })), paths }
      }
      case 'slides:save-picture': { const op = args[0] as SavePictureOp; return { ok: await saveFile(`${op.defaultName}.png`, bytesFromBase64(op.pngBase64)) } }
      case 'slides:insert-image': {
        const [file] = await pickFiles({ filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] })
        if (!file) return null
        const image = await createImageBitmap(new Blob([file.bytes.slice().buffer]))
        try { return request('slides:add-image-bytes', { slideIndex: args[0], fitWidthPx: args[1], base64: toBase64(file.bytes), ext: file.path.split('.').pop(), name: file.path, naturalPx: { width: image.width, height: image.height } }) }
        finally { image.close() }
      }
      case 'slides:show-fullscreen': throw new Error('当前仅支持页面内放映；系统全屏请导出后使用演示软件。')
      case 'slides:microphone-access': return false
      case 'slides:presenter-start': throw new Error('当前不支持独立演示窗口。')
    }
    if (channel === 'slides:native-clipboard' && args[0] === 'copy') {
      const selection = readEditSelection()
      if (!selection || selection.range.collapsed) return
      const fragment = document.createElement('div')
      fragment.append(selection.range.cloneContents())
      await context.clipboard.write({ text: selection.range.toString(), html: fragment.innerHTML })
      ensureActive()
      return
    }
    if (channel.startsWith('slides:')) return request(channel, ...args)
    throw new Error('此操作需要在 Lexora 对话或 Office 管理页完成。')
  }
  const previousApi = window.slidesApi
  const api = createSlidesApi({
    invoke, send: () => {},
    on: (channel, listener) => { const listeners = events.get(channel) ?? new Set(); listeners.add(listener); events.set(channel, listeners) },
    removeListener: (channel, listener) => { events.get(channel)?.delete(listener) },
  }, { getPathForFile: () => '' })
  window.slidesApi = api
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('./slides-editor.css', import.meta.url).href; document.head.append(css)
  container.classList.add('office-slides-editor')
  const oldTheme = document.documentElement.getAttribute('data-theme')
  const applyTheme = () => { document.documentElement.setAttribute('data-theme', context.environment.colorScheme); emit('app:theme-changed', context.environment.colorScheme) }
  applyTheme()
  const subscription = context.onEnvironmentChange(applyTheme)
  setModuleLang('zh'); applyAiPanelPrefs(prefs)
  const stopTips = installScreenTips()
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) void document.fonts.load(`${variant}16px 'Carlito GO'`).catch(() => {})
  const root = createRoot(container)
  root.render(createElement(LocaleProvider, { initial: 'zh', children: createElement(App, {
    onContext: (read: () => ActionCtx) => { readContext = read; if (read().slides.length) resolveReady?.() },
    onLoadError: (error: Error) => rejectReady?.(error),
  }) }))
  let stopReferenceMenu = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopReferenceMenu()
    rejectReady?.(new Error('演示文稿打开已取消。'))
    root.unmount(); worker.terminate(); css.remove(); stopTips(); subscription.dispose()
    for (const call of pending.values()) call.reject(new Error('演示文稿已关闭。'))
    pending.clear(); events.clear(); window.slidesApi = previousApi
    container.classList.remove('office-slides-editor')
    if (oldTheme) document.documentElement.setAttribute('data-theme', oldTheme); else document.documentElement.removeAttribute('data-theme')
    context.signal.removeEventListener('abort', dispose)
  }
  const editor: OfficeEditor = {
    assistant: createSlidesAssistant(() => {
      ensureActive()
      if (!readContext) throw new Error('演示文稿尚未准备好。')
      return readContext()
    }, request, ensureActive, name),
    async save() {
      ensureActive()
      if (!readContext) throw new Error('演示文稿尚未准备好。')
      await flushActiveEdit(readContext())
      await readContext().flushNotes()
      const { bytes, token } = await request('save') as { bytes: Uint8Array; token: number }
      latestBytes = bytes; snapshots.set(bytes, token)
      return bytes
    },
    async markSaved(bytes = latestBytes) {
      const token = bytes && snapshots.get(bytes)
      if (token === undefined) return
      await request('saved', token)
      snapshots.delete(bytes!)
      if (latestBytes === bytes) latestBytes = undefined
    },
    dispose,
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  const timeout = setTimeout(() => rejectReady?.(new Error('演示文稿加载超时。')), 90000)
  try { await ready; options.onDirty(false) } catch (error) { dispose(); throw error } finally { clearTimeout(timeout) }
  stopReferenceMenu = installOfficeReferenceMenu(options, () => editor.assistant)
  return editor
}
