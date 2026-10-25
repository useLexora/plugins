import { officeVersion } from './office-assistant'
import { createDocxAssistant } from './docx-assistant'
import { pickMergeDataSource, writeMergeOutput } from './docx-mail-merge'
import { readOfficeResource } from './office-resource-bytes'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from '../vendor/genoffice/apps/docs/src/renderer/App'
import { buildDocBytes, type FileActionContext } from '../vendor/genoffice/apps/docs/src/renderer/file-actions'
import { setParseWorker } from '../vendor/genoffice/apps/docs/src/renderer/parse-off-thread'
import { setDocBytesReader } from '../vendor/genoffice/apps/docs/src/renderer/doc-bytes'
import { LocaleProvider, setModuleLang } from '../vendor/genoffice/apps/docs/src/renderer/i18n/locale'
import { buildBlankDocx } from '../vendor/genoffice/packages/docx-engine/src/blank'
import { defaultAiSettings } from '../vendor/genoffice/packages/ai-provider/src/providers'
import { applyAiPanelPrefs, installScreenTips } from '../vendor/genoffice/packages/ui/src/index'
import type { DesktopApi, MergeOutputRequest } from '../vendor/genoffice/apps/docs/src/shared/ipc'
import type { OfficeEditor, OfficeEditorOptions } from './office-editor-types'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/image-viewer.css'
import '../vendor/genoffice/apps/docs/src/renderer/styles.css'
import '../vendor/genoffice/apps/docs/src/renderer/fonts/fonts.css'
import './docx-style.css'

export async function createBlankDocx(): Promise<Uint8Array> {
  return buildBlankDocx()
}

const prefs = { side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: false, openInNewDocs: false, showAiSidebar: false } as const

export async function mountDocxEditor(options: OfficeEditorOptions): Promise<OfficeEditor> {
  const { context, container, name } = options
  context.signal.throwIfAborted()
  const documentId = `office-document:${crypto.randomUUID()}/${name}`
  const byteUrl = `office-bytes:${crypto.randomUUID()}`
  const bytes = options.bytes.slice()
  let readContext: (() => FileActionContext) | undefined
  let disposed = false
  let serialized: Uint8Array | undefined
  const snapshots = new WeakMap<Uint8Array, string>()
  let savedVersion: string | undefined
  let handle: OfficeEditor | null = null
  const events = new Map<string, Set<(...args: unknown[]) => void>>()
  const worker = await context.workers.create(new URL('./docx-worker.js', import.meta.url), { type: 'module' })
  if (context.signal.aborted) { worker.terminate(); context.signal.throwIfAborted() }
  context.signal.throwIfAborted()
  setParseWorker(worker)
  setDocBytesReader(async url => {
    if (url !== byteUrl || disposed) throw new Error('文档读取会话已失效。')
    return bytes.slice()
  })
  const ensureActive = () => {
    context.signal.throwIfAborted()
    if (disposed) throw new Error('文档已经关闭。')
  }
  const persist = async (data: ArrayBuffer): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      ensureActive()
      const next = new Uint8Array(data).slice()
      if (!options.onSave) throw new Error('请使用 Office 顶栏保存文档。')
      await options.onSave(next)
      ensureActive()
      return { ok: true, path: documentId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const saveAs = async (fileName: string, data: ArrayBuffer) => ({ ok: await context.resources.saveFile({ name: fileName, data }), path: documentId })
  const unavailable = async () => { throw new Error('请使用 Office 管理页或 Lexora 对话完成此操作。') }
  const known: Record<string, unknown> = {
    clipboard: {
      read: async () => {
        ensureActive()
        if (!context.clipboard) throw new Error('当前宿主不支持菜单粘贴，请使用 Ctrl+V。')
        const data = await context.clipboard.read()
        ensureActive()
        return data
      },
      write: async (data: { text?: string; html?: string }) => {
        ensureActive()
        if (!context.clipboard) throw new Error('当前宿主不支持菜单复制。')
        await context.clipboard.write(data)
        ensureActive()
      },
    },
    pickMergeDataSource: () => pickMergeDataSource(context),
    writeMergeOutput: (request: MergeOutputRequest) => writeMergeOutput(context, name, request),
    getLanguage: async () => 'zh', getSystemLocale: async () => 'zh-CN', getTheme: async () => context.environment.colorScheme,
    getDocumentTheme: async () => 'light', getAuthorName: async () => 'Lexora', getUsername: async () => 'Lexora',
    getAiPanelPrefs: async () => prefs, setAiPanelPrefs: async () => prefs,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 1 }),
    getAiSettings: async () => defaultAiSettings(), getRecentFiles: async () => [],
    fontMetrics: async () => null, spellLanguages: async () => ({ available: [], enabled: [] }),
    docPasswordIntentRevision: async () => 0, discardDocPasswordIntents: async () => ({ ok: true }),
    consumePendingOpenDocx: async () => ({ path: documentId, name, dataUrl: byteUrl, hash: documentId }),
    consumeNewBlankDoc: async () => false, consumeAiDocContent: async () => null, consumeHeadlessExport: async () => null,
    saveDocx: async (_path: string, data: ArrayBuffer) => persist(data),
    saveDocxNew: async (_name: string, data: ArrayBuffer) => persist(data),
    saveDocxAs: saveAs,
    writeRecoveryCopy: async (_path: string, data: ArrayBuffer) => {
      if (!options.onSave) return { ok: false }
      await options.onSave(new Uint8Array(data))
      return { ok: true }
    },
    openDocx: unavailable, openDocxPath: unavailable, openDocxDecrypt: unavailable,
    confirmDocumentReplace: async () => false, setDocPassword: unavailable,
    convertAltChunkHtml: async () => null,
    pickImage: async () => {
      const [file] = await context.resources.pickFiles({ filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif'] }] })
      if (!file) return null
      const data = await readOfficeResource(context, file, 8 * 1024 * 1024)
      const base64 = btoa(Array.from(data, value => String.fromCharCode(value)).join(''))
      return { base64, mime: file.mimeType, name: file.name }
    },
    exportHtml: async (fileName: string, html: string) => ({ ok: await context.resources.saveFile({ name: fileName, data: new TextEncoder().encode(html) }) }),
    exportMarkdown: async (fileName: string, content: string) => ({ ok: await context.resources.saveFile({ name: fileName, data: new TextEncoder().encode(content) }) }),
    kbList: async () => [], skillsList: async () => [], listDocsTabs: async () => [],
    armContextMenu: () => {}, claimContextMenu: () => {}, spellDiag: () => {}, reportViewMenuState: () => {},
    signalMcpReady: () => {}, reportMcpResult: () => {}, reportCloseCheck: () => {}, reportCloseSaveResult: () => {},
  }
  const previousDesktop = window.desktop
  window.desktop = new Proxy(known, {
    get(target, property) {
      if (property in target) return target[property as string]
      if (typeof property === 'string' && property.startsWith('on')) return (handler: (...args: unknown[]) => void) => {
        const set = events.get(property) ?? new Set()
        set.add(handler)
        events.set(property, set)
        return () => set.delete(handler)
      }
      return unavailable
    },
  }) as unknown as DesktopApi
  const oldTheme = document.documentElement.getAttribute('data-theme')
  const applyTheme = () => document.documentElement.setAttribute('data-theme', context.environment.colorScheme)
  applyTheme()
  const themeSubscription = context.onEnvironmentChange(applyTheme)
  setModuleLang('zh')
  applyAiPanelPrefs(prefs)
  const stopScreenTips = installScreenTips()
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = new URL('./docx-editor.css', import.meta.url).href
  document.head.append(css)
  container.classList.add('office-docx-editor')
  const root = createRoot(container)
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const onFileContext = (read: () => FileActionContext) => {
    readContext = read
    if (read().doc && read().editor) resolveReady?.()
  }
  let reportedVersion = ''
  let reportedDirty = false
  const versionOf = (current: FileActionContext) => {
    const persistedKeys = ['section', 'sections', 'trailingStartType', 'pageColor', 'header', 'footer', 'hfVariants', 'sectionHfEdits', 'hfLinks', 'titlePg', 'evenOddHf', 'mirrorMargins', 'pgNumEdit', 'pendingNumbering', 'defaultFonts', 'styleUpserts', 'comments', 'watermark', 'watermarkStyle', 'watermarkPicture', 'inkAnnotations', 'footnotes', 'endnotes', 'sources', 'zoteroDocumentData', 'themeFonts', 'themeColors', 'protection', 'writeProtection', 'removePersonalInfo'] as const
    return officeVersion([current.editor?.getJSON(), ...persistedKeys.map(key => current[key])])
  }
  const dirty = () => {
    const current = readContext?.()
    if (disposed || !current?.doc) return
    const version = versionOf(current)
    savedVersion ??= version
    const value = version !== savedVersion
    if (version !== reportedVersion || value !== reportedDirty) {
      reportedVersion = version; reportedDirty = value; options.onDirty(value)
    }
  }
  const saveRequest = async () => {
    if (options.onSaveRequest) return options.onSaveRequest()
    if (!handle || !options.onSave) throw new Error('请使用 Office 顶栏保存文档。')
    const data = await handle.save()
    await options.onSave(data)
    await handle.markSaved?.(data)
  }
  root.render(createElement(LocaleProvider, { initial: 'zh', children: createElement(App, { onFileContext, onDirty: dirty, onSaveRequest: saveRequest, onLoadError: (error: Error) => rejectReady?.(error) }) }))
  let stopDocumentChanges = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    rejectReady?.(new Error('文档打开已取消。'))
    for (const handler of events.get('onTeardown') ?? []) handler()
    stopDocumentChanges()
    root.unmount()
    setParseWorker(null)
    setDocBytesReader(null)
    worker.terminate()
    stopScreenTips()
    themeSubscription.dispose()
    css.remove()
    events.clear()
    container.classList.remove('office-docx-editor')
    window.desktop = previousDesktop
    if (oldTheme) document.documentElement.setAttribute('data-theme', oldTheme)
    else document.documentElement.removeAttribute('data-theme')
    context.signal.removeEventListener('abort', dispose)
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  const timeout = setTimeout(() => rejectReady?.(new Error('文档加载超时，请检查文件后重试。')), 90000)
  try { await ready } catch (error) { dispose(); throw error } finally { clearTimeout(timeout) }
  const getEditor = () => {
    ensureActive()
    const editor = readContext?.().editor
    if (!editor) throw new Error('文档尚未准备好。')
    return editor
  }
  const liveEditor = getEditor()
  const onDocumentChange = () => dirty()
  liveEditor.on('update', onDocumentChange)
  stopDocumentChanges = () => liveEditor.off('update', onDocumentChange)
  dirty()
  handle = {
    assistant: createDocxAssistant(getEditor, name, ensureActive, () => readContext!()),
    async save() {
      ensureActive()
      if (!readContext) throw new Error('文档尚未准备好。')
      flushSync(() => { window.dispatchEvent(new Event('ai-docs-commit-tables')) })
      const snapshot = readContext()
      const version = versionOf(snapshot)
      const result = await buildDocBytes(snapshot)
      if (!result) throw new Error('文档序列化失败。')
      ensureActive()
      if (versionOf(readContext()) !== version) throw new Error('文档在序列化期间发生变化，请重新保存。')
      serialized = result
      snapshots.set(result, version)
      return result
    },
    markSaved(savedBytes = serialized) {
      ensureActive()
      const version = savedBytes && snapshots.get(savedBytes)
      if (!version) return
      savedVersion = version
      snapshots.delete(savedBytes!)
      if (serialized === savedBytes) serialized = undefined
      dirty()
    },
    dispose,
  }
  return handle
}
