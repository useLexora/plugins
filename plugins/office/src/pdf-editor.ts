import { PdfReferenceAction } from './pdf-reference-action'
import { Buffer } from 'buffer'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfOfficeBridge } from '../vendor/genoffice/apps/pdf/src/renderer/office-bridge'
import { createPdfAssistant, PDF_WRITE_OPERATIONS } from './pdf-assistant'
import { officeVersion } from './office-assistant'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument } from 'pdf-lib'
import { zipSync } from 'fflate'
import App from '../vendor/genoffice/apps/pdf/src/renderer/App'
import { LocaleProvider } from '../vendor/genoffice/apps/pdf/src/renderer/i18n/locale'
import { applySaveRequest, cropPagesBytes, extractPagesBytes, insertBlankPageBytes, insertPdfBytes, mergePagesBytes, mergePdfBytes, readStaticFormFills, replacePagesBytes, setPageSizeBytes, splitPagesBytes, splitPdfBytes } from '../vendor/genoffice/apps/pdf/src/main/save-pdf'
import { canDrawText, listEditFonts, validateTextEdits } from '../vendor/genoffice/apps/pdf/src/main/text-edit'
import { listPageImages, renderImagePng, renderPagePreviewPng } from '../vendor/genoffice/apps/pdf/src/main/image-edit'
import { defaultAiSettings } from '../vendor/genoffice/packages/ai-provider/src/providers'
import { applyAiPanelPrefs, installScreenTips } from '../vendor/genoffice/packages/ui/src/index'
import type { PdfApi, SavedSignature, SignatureData } from '../vendor/genoffice/apps/pdf/src/shared/ipc'
import type { OfficeEditor, OfficeEditorOptions } from './office-editor-types'
import type { Json, LocalFile } from './lexora'
import { DOC_OPTS } from '../vendor/genoffice/apps/pdf/src/renderer/view-config'
import { preparePdfRuntime } from './pdf-browser-runtime'
import { readOfficeResource } from './office-resource-bytes'
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
import '../vendor/genoffice/apps/pdf/src/renderer/styles.css'
import './pdf-style.css'

const command = 'pa99d3189286f4fa191b597bd1a1f227d.genoffice-xlsx.manage'
const prefs = { side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: false, openInNewDocs: false, showAiSidebar: false } as const
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const failure = (error: unknown) => ({ ok: false as const, error: message(error) })

export async function createBlankPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([595.28, 841.89])
  return pdf.save()
}

export async function mountPdfEditor(options: OfficeEditorOptions): Promise<OfficeEditor> {
  const { context, container, name } = options
  const virtualPath = `office-pdf:${crypto.randomUUID()}/${name}`
  let bytes: Uint8Array = options.bytes.slice()
  let appDirty = false
  let notifiedDirty = false
  let notifiedEditorState = ''
  let generation = 0
  let acknowledged = 0
  let serializing = false
  let disposed = false
  let resolveSave: ((ok: boolean) => void) | undefined
  let lastSaveError = ''
  let lastSnapshot: Uint8Array | undefined
  const snapshots = new WeakMap<Uint8Array, number>()
  const events = new Map<string, Set<(...args: unknown[]) => void>>()
  const active = () => { context.signal.throwIfAborted(); if (disposed) throw new Error('PDF 已关闭。') }
  let officeBridge: PdfOfficeBridge | null = null
  let toolUndo: { bytes: Uint8Array; version: string; saved: boolean } | undefined
  let toolBusy = false
  const state = () => ({ generation, editor: officeBridge?.state() })
  const stateVersion = () => officeVersion(state())
  const currentBridge = () => {
    if (!officeBridge) throw new Error('PDF 尚未准备就绪。')
    return officeBridge
  }
  const assistant = createPdfAssistant(() => {
    const bridge = currentBridge()
    return {
      ...bridge,
      state,
      canUndo: () => toolUndo ? toolUndo.version === stateVersion() : bridge.canUndo(),
      undo: async (assertCurrent = active) => {
        if (serializing || toolBusy) throw new Error('PDF 正在处理修改，请稍后重试。')
        assertCurrent()
        const checkpoint = toolUndo
        if (checkpoint && checkpoint.version !== stateVersion()) throw new Error('上次工具修改后 PDF 已发生变化，无法安全撤销。')
        if (!checkpoint?.saved) {
          const changed = await bridge.undo(assertCurrent)
          if (changed) toolUndo = undefined
          return changed
        }
        toolBusy = true
        try {
          const fills = await readStaticFormFills(checkpoint.bytes)
          assertCurrent()
          await bridge.restore(checkpoint.bytes, fills, () => {
            assertCurrent()
            bytes = checkpoint.bytes
            generation++
            toolUndo = undefined
            notifyDirty()
          })
          return true
        } finally { toolBusy = false }
      },
      execute: async (operation, input, assertCurrent, signal) => {
        if (!PDF_WRITE_OPERATIONS.has(operation) || (operation === 'apply_ops' && input.dry_run === true)) return bridge.execute(operation, input, assertCurrent, signal)
        if (serializing || toolBusy) throw new Error('PDF 正在处理修改，请稍后重试。')
        toolBusy = true
        try {
          assertCurrent()
          if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('PDF 超过 64 MB，无法保留安全撤销快照。')
          const request = bridge.snapshot()
          const checkpoint = request ? (await checkedSave(bytes, request)).slice() : bytes.slice()
          if (checkpoint.byteLength > 64 * 1024 * 1024) throw new Error('PDF 超过 64 MB，无法保留安全撤销快照。')
          assertCurrent()
          const result = await bridge.execute(operation, input, assertCurrent, signal)
          if (result.mutated && !result.isError) toolUndo = { bytes: checkpoint, version: stateVersion(), saved: false }
          return result
        } finally { toolBusy = false }
      },
    }
  }, active, name, async request => {
    active()
    const preview = request ? await checkedSave(bytes, request) : bytes.slice()
    active()
    return getDocument({ data: preview, ...DOC_OPTS }).promise
  })
  const onOfficeBridge = (bridge: PdfOfficeBridge | null) => { officeBridge = bridge }
  const notifyDirty = (contentChanged = true) => {
    if (disposed) return
    const dirty = appDirty || generation > acknowledged
    if (!contentChanged && dirty === notifiedDirty) return
    if (contentChanged && !dirty && notifiedDirty) options.onDirty(true)
    notifiedDirty = dirty
    options.onDirty(dirty)
  }
  const checkPath = (path: string) => { active(); if (path !== virtualPath) throw new Error('PDF 文档引用已失效。') }
  const emit = (event: string, ...args: unknown[]) => { for (const handler of events.get(event) ?? []) handler(...args) }
  const unavailable = async () => { throw new Error('当前宿主未提供此功能，请使用 Office 管理页或 Lexora 对话。') }
  const read = (file: LocalFile) => readOfficeResource(context, file, 64 * 1024 * 1024)
  const pick = (multiple = false) => context.resources.pickFiles({ multiple, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  const publish = async (next: Uint8Array) => {
    active()
    bytes = next.slice()
    generation++
    notifyDirty(!serializing)
    if (!serializing) {
      if (options.onSaveRequest) await options.onSaveRequest()
      else {
        if (!options.onSave) throw new Error('请使用 Office 顶栏保存。')
        await options.onSave(next)
        active()
        acknowledged = generation
        notifyDirty(false)
      }
    }
  }
  const exportPdf = async (next: Uint8Array, suggestedName: string) => {
    const fileName = suggestedName.replace(/\.pdf$/i, '') + '.pdf'
    const saved = await context.resources.saveFile({ name: fileName, data: next })
    return saved ? { ok: true as const, savedPath: fileName } : { ok: false as const, error: '已取消导出。' }
  }
  const readSignatures = async (): Promise<SavedSignature[]> => {
    const result = await context.commands.execute(command, { action: 'preferences.get', key: 'pdfSignatures' }) as { ok: boolean; value?: Json; error?: string }
    if (!result.ok) throw new Error(result.error || '签名收藏读取失败。')
    return Array.isArray(result.value) ? result.value as unknown as SavedSignature[] : []
  }
  const writeSignatures = async (value: SavedSignature[]) => {
    const result = await context.commands.execute(command, { action: 'preferences.set', key: 'pdfSignatures', value: value as unknown as Json }) as { ok: boolean; error?: string }
    if (!result.ok) throw new Error(result.error || '签名收藏保存失败。')
    return value
  }
  const checkedSave = async (source: Uint8Array, request: Parameters<PdfApi['save']>[0]) => {
    const result = await applySaveRequest(source, request)
    const skipped = [...result.skippedTextEdits, ...result.skippedTextInserts, ...result.skippedImageEdits]
    if (skipped.length) throw new Error(`有 ${skipped.length} 处修改无法写入：${skipped[0]?.reason || '请检查字体或编辑对象。'}`)
    return result.bytes
  }
  const api: Partial<PdfApi> = {
    consumePending: async () => virtualPath,
    readFile: async path => { checkPath(path); return bytes.slice().buffer },
    save: async request => {
      try {
        checkPath(request.path)
        if (request.targetPath) throw new Error('请使用 Office 顶栏的导出或另存副本。')
        await publish(await checkedSave(bytes, request))
        return { ok: true }
      } catch (error) { lastSaveError = message(error); return failure(error) }
    },
    requestRedactionCopy: async () => { throw new Error('当前宿主暂不支持永久涂黑。') },
    autoRename: async () => ({ renamed: false }), isUntitled: async () => false,
    validateTextEdits: async request => { checkPath(request.path); return validateTextEdits(bytes, request.edits) },
    listEditFonts: async () => listEditFonts(), canDrawText: async (...args) => canDrawText(...args),
    listPageImages: async path => { checkPath(path); return listPageImages(bytes) },
    listStaticFormFills: async path => { checkPath(path); return readStaticFormFills(bytes) },
    ocrPage: async () => null,
    pageImagePng: async request => { checkPath(request.path); return renderImagePng(bytes, request.pageIndex, request.rect, request.scale) },
    pagePreviewPng: async request => { checkPath(request.path); return renderPagePreviewPng(bytes, request) },
    extractPages: async request => { try { checkPath(request.path); return await exportPdf(await extractPagesBytes(bytes, request.pages), request.suggestedName) } catch (error) { return failure(error) } },
    insertPdf: async request => {
      try {
        checkPath(request.path)
        const [file] = await pick()
        if (!file) return { ok: true, canceled: true }
        const result = await insertPdfBytes(bytes, await read(file), request.afterPageIndex)
        await publish(result.merged)
        return { ok: true, insertedCount: result.count }
      } catch (error) { return failure(error) }
    },
    insertBlankPage: async request => { try { checkPath(request.path); await publish(await insertBlankPageBytes(bytes, request.afterPageIndex)); return { ok: true } } catch (error) { return failure(error) } },
    splitPdf: async request => {
      try {
        checkPath(request.path)
        const parts = await splitPdfBytes(bytes, request.chunkSize)
        const saved = await context.resources.saveFile({ name: `${request.baseName}.zip`, data: zipSync(Object.fromEntries(parts.map((part, index) => [`${request.baseName}-${index + 1}.pdf`, part]))) })
        return saved ? { ok: true, count: parts.length, savedDir: `${request.baseName}.zip` } : { ok: true, canceled: true }
      } catch (error) { return failure(error) }
    },
    mergePdf: async request => {
      try {
        checkPath(request.path)
        const files = await pick(true)
        if (!files.length) return { ok: true, canceled: true }
        const others = []
        for (const file of files) others.push(await read(file))
        const result = await mergePdfBytes(bytes, others)
        const saved = await exportPdf(result.merged, request.suggestedName)
        return saved.ok ? { ...saved, appendedCount: result.appended } : saved
      } catch (error) { return failure(error) }
    },
    mergePages: async request => { try { checkPath(request.path); return await exportPdf(await mergePagesBytes(bytes, request), request.suggestedName) } catch (error) { return failure(error) } },
    replacePages: async request => {
      try {
        checkPath(request.path)
        const [file] = await pick()
        if (!file) return { ok: true, canceled: true }
        const result = await replacePagesBytes(bytes, await read(file), request.pages)
        await publish(result.merged)
        return { ok: true, removed: result.removed, inserted: result.inserted }
      } catch (error) { return failure(error) }
    },
    setPageSize: async request => { try { checkPath(request.path); await publish(await setPageSizeBytes(bytes, request.width, request.height)); return { ok: true } } catch (error) { return failure(error) } },
    splitPages: async request => { try { checkPath(request.path); return await exportPdf(await splitPagesBytes(bytes, request.perPage), request.suggestedName) } catch (error) { return failure(error) } },
    cropPages: async request => { try { checkPath(request.path); await publish(await cropPagesBytes(bytes, request.pages, request.rect)); return { ok: true } } catch (error) { return failure(error) } },
    exportImages: async request => {
      try {
        const files = Object.fromEntries(request.images.map((image, index) => [`${request.baseName}-${request.pageNumbers[index]}.png`, Buffer.from(image, 'base64')]))
        const saved = await context.resources.saveFile({ name: `${request.baseName}-images.zip`, data: zipSync(files) })
        return saved ? { ok: true, count: request.images.length, savedDir: `${request.baseName}-images.zip` } : { ok: true, canceled: true }
      } catch (error) { return failure(error) }
    },
    openSourcePath: unavailable, convertOffice: unavailable, createDocument: unavailable,
    imageSearch: unavailable, fetchImage: unavailable, generateImage: unavailable,
    listDigitalSignatures: async () => [], pickCertificate: unavailable,
    listSystemCertificates: async () => ({ certs: [], issues: ['platform-unsupported'] }),
    releaseCertificate: () => {}, inspectCertificate: async () => ({ ok: false, error: 'cert-store-unsupported' }),
    signWithCertificate: async () => ({ ok: false, error: 'cert-store-unsupported', message: '当前宿主未提供数字证书签名。' }),
    listSavedSignatures: readSignatures,
    addSavedSignature: async (data: SignatureData) => {
      const old = await readSignatures()
      const encoded = JSON.stringify(data)
      return writeSignatures([{ id: crypto.randomUUID(), createdAt: Date.now(), data }, ...old.filter(item => JSON.stringify(item.data) !== encoded)].slice(0, 20))
    },
    removeSavedSignature: async id => writeSignatures((await readSignatures()).filter(item => item.id !== id)),
    getUsername: async () => 'Lexora',
    setDirty: dirty => {
      appDirty = dirty
      const editorState = officeBridge?.state() as { pending?: unknown; drafts?: unknown; redactions?: unknown } | undefined
      const signature = officeVersion({ pending: editorState?.pending, drafts: editorState?.drafts, redactions: editorState?.redactions })
      const changed = signature !== notifiedEditorState
      notifiedEditorState = signature
      notifyDirty(changed && !(serializing && !dirty))
    },
    sendCloseSaveResult: ok => { resolveSave?.(ok); resolveSave = undefined },
    print: async () => ({ ok: false, error: '请先导出 PDF，再使用系统 PDF 阅读器打印。' }), listPrinters: async () => [],
    getLanguage: async () => 'zh', getTheme: async () => context.environment.colorScheme,
    getAiPanelPrefs: async () => prefs, setAiPanelPrefs: async () => prefs,
    getAiSettings: async () => defaultAiSettings(), setAiSettings: unavailable,
    openAiModelSettings: unavailable, openSkillsSettings: unavailable, skillsList: async () => [], skillText: unavailable,
    gskStatus: async () => ({ loggedIn: false }), aiStream: unavailable, aiStreamCancel: async () => {},
  }
  await preparePdfRuntime(context.signal)
  const worker = await context.workers.create(new URL('./pdf-worker.js', import.meta.url), { type: 'module' })
  if (context.signal.aborted) { worker.terminate(); context.signal.throwIfAborted() }
  GlobalWorkerOptions.workerPort = worker
  const pdfWindow = window as unknown as { pdfApi: PdfApi }
  const previous = pdfWindow.pdfApi
  pdfWindow.pdfApi = new Proxy(api, {
    get(target, property) {
      if (property in target) return target[property as keyof PdfApi]
      if (typeof property === 'string' && property.startsWith('on')) return (handler: (...args: unknown[]) => void) => {
        const set = events.get(property) ?? new Set()
        set.add(handler)
        events.set(property, set)
        return () => set.delete(handler)
      }
      return unavailable
    },
  }) as PdfApi
  const previousTheme = document.documentElement.getAttribute('data-theme')
  document.documentElement.setAttribute('data-theme', context.environment.colorScheme)
  const themeSubscription = context.onEnvironmentChange(() => {
    document.documentElement.setAttribute('data-theme', context.environment.colorScheme)
    emit('onThemeChanged', context.environment.colorScheme)
  })
  applyAiPanelPrefs(prefs)
  const stopTips = installScreenTips()
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = new URL('./pdf-editor.css', import.meta.url).href
  document.head.append(css)
  container.classList.add('office-pdf-editor')
  const root = createRoot(container)
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  root.render(createElement(LocaleProvider, { initial: 'zh', children: createElement(App, {
    onOfficeBridge,
    referenceAction: createElement(PdfReferenceAction, { options, assistant }),
    onStatus: (status: string) => { if (status === 'ready') resolveReady?.(); else if (status === 'error') rejectReady?.(new Error('PDF 加载失败，请检查文件。')) },
    onSaveRequest: options.onSaveRequest ? async () => {
      try { await options.onSaveRequest!(); return true } catch (error) { lastSaveError = message(error); throw error }
    } : undefined,
  }) }))
  const dispose = () => {
    if (disposed) return
    disposed = true
    toolUndo = undefined
    rejectReady?.(new Error('PDF 打开已取消。'))
    resolveSave?.(false)
    root.unmount()
    worker.terminate()
    GlobalWorkerOptions.workerPort = null
    events.clear()
    stopTips()
    themeSubscription.dispose()
    css.remove()
    container.classList.remove('office-pdf-editor')
    pdfWindow.pdfApi = previous
    if (previousTheme) document.documentElement.setAttribute('data-theme', previousTheme)
    else document.documentElement.removeAttribute('data-theme')
    context.signal.removeEventListener('abort', dispose)
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  const timeout = setTimeout(() => rejectReady?.(new Error('PDF 加载超时。')), 90000)
  try { await ready } catch (error) { dispose(); throw error } finally { clearTimeout(timeout) }
  return {
    assistant,
    async save() {
      active()
      if (serializing || toolBusy) throw new Error('PDF 正在保存或处理修改，请稍候。')
      if (!events.get('onCloseSaveRequest')?.size) throw new Error('PDF 尚未准备好。')
      const checkpoint = toolUndo?.version === stateVersion() ? toolUndo : undefined
      serializing = true
      lastSaveError = ''
      try {
        const result = new Promise<boolean>(resolve => { resolveSave = resolve })
        emit('onCloseSaveRequest', { flushAll: true })
        if (!await result) throw new Error(lastSaveError || 'PDF 尚有无法保存的修改，请完成当前编辑或应用涂黑后重试。')
        active()
        if (checkpoint && checkpoint === toolUndo) {
          try {
            if (!currentBridge().snapshot()) {
              checkpoint.version = stateVersion()
              checkpoint.saved = true
            }
          } catch { /* A draft or concurrent edit cannot inherit the saved undo checkpoint. */ }
        }
        const snapshot = bytes.slice()
        snapshots.set(snapshot, generation)
        lastSnapshot = snapshot
        return snapshot
      } finally { serializing = false; resolveSave = undefined }
    },
    markSaved(savedBytes = lastSnapshot) {
      if (!savedBytes) return
      const savedGeneration = snapshots.get(savedBytes)
      if (savedGeneration === undefined) return
      acknowledged = Math.max(acknowledged, savedGeneration)
      snapshots.delete(savedBytes)
      notifyDirty(false)
    },
    dispose,
  }
}
