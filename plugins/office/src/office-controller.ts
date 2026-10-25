import type { Json, LocalFile, Resource, ViewContext } from './lexora'
import type { OfficeEditor, OfficeEditorOptions } from './office-editor-types'
import { KIND_LABEL, MIME, PLUGIN_ID, fileName, kindOf, type OfficeDocument, type OfficeKind, type OfficeLibrary } from './office-library'
import { mountLibrary } from './library-view'
import { confirmLeaving, dialog, element } from './office-ui'
import { mountEditorChrome, mountOfficeNotices } from './editor-chrome'
import { createHash } from './shims/crypto'
import { createOfficeViewAgent } from './office-view-agent'
import { OFFICE_BRIDGE } from './office-agent'

export async function startOffice(context: ViewContext, root: HTMLElement, persistState = true) {
  const noticeHost = element('div', 'office-notice-host')
  const notices = mountOfficeNotices(noticeHost)
  const content = element('div', 'office-content')
  root.append(noticeHost, content)
  const libraryHost = element('div', 'office-library-host')
  const editorHost = element('div', 'office-editor-host')
  editorHost.hidden = true
  content.append(libraryHost, editorHost)
  const initialState = context.state && typeof context.state === 'object' && !Array.isArray(context.state) ? context.state : {}
  let requestedAgentSession = typeof initialState.agentSessionId === 'string' ? initialState.agentSessionId : undefined
  let editor: OfficeEditor | undefined
  let mounting: Promise<OfficeEditor> | undefined
  let current: OfficeDocument | undefined
  let documents: OfficeDocument[] = []
  let dirty = false
  let changed = 0
  let disposed = false
  let opening = false
  let libraryFocus: HTMLElement | undefined
  let editorGeneration = 0
  let saving: Promise<void> = Promise.resolve()
  let saveTransaction: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let chrome: ReturnType<typeof mountEditorChrome> | undefined
  let saveInProgress = false
  let ready = false
  let documentInfo = ''
  let documentInfoUpdate = Promise.resolve()
  let autoSaveFailed = false
  const notice = (text: string, error = false) => {
    if (disposed) return
    const generation = editorGeneration
    const recover = (action: () => Promise<void>) => async () => {
      if (disposed || generation !== editorGeneration) return
      try { await action() } catch (failure) { notice(failure instanceof Error ? failure.message : String(failure), true) }
    }
    notices.show(text, error, error && autoSaveFailed && current ? [
      { label: '重试保存', run: recover(() => save(true)) },
      { label: '导出', run: recover(exportCurrent) },
    ] : [])
  }
  const run = (action: () => Promise<void>) => { void action().catch(error => notice(error instanceof Error ? error.message : String(error), true)) }
  const command = async <T>(action: string, args: Record<string, Json> = {}): Promise<T> => {
    const response = await context.commands.execute(`${PLUGIN_ID}.manage`, { action, ...args }) as { ok: boolean; value?: Json; error?: string }
    if (!response.ok) throw new Error(response.error ?? '文档库操作失败。')
    return response.value as T
  }
  const loadLibrary = async () => {
    const library = await command<OfficeLibrary>('list')
    documents = library.documents; libraryView?.update(documents)
    if (current) {
      const latest = documents.find(doc => doc.id === current!.id)
      if (!latest || latest.trashedAt !== null) notice('此文档已移入回收站或被删除。当前内容仍可导出或另存副本。', true)
      else if (latest.revision !== current.revision) notice('此文档已在其他页面更新。可重新打开最新版本，或将当前内容另存副本。', true)
      else {
        current.name = latest.name
        updateSaveState()
      }
    }
  }
  const read = async (resource: Resource): Promise<Uint8Array> => {
    const response = await fetch(await context.resources.getUrl(resource), { signal: context.signal })
    if (!response.ok) throw new Error('文件读取失败，请重新打开或恢复历史版本。')
    if (!response.body) throw new Error('文件内容为空。')
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 64 * 1024 * 1024) throw new Error('此文件超过当前 Office 的 64 MB 文件上限。')
        parts.push(part.value)
      }
    } finally { await reader.cancel() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return bytes
  }
  const syncDocumentInfo = () => {
    const info = { title: current?.name ?? 'Office', dirty: !!current && dirty }
    const signature = JSON.stringify(info)
    if (disposed || signature === documentInfo || typeof context.setDocumentInfo !== 'function') return
    documentInfo = signature
    documentInfoUpdate = documentInfoUpdate.catch(() => {}).then(async () => {
      if (!disposed && documentInfo === signature) await context.setDocumentInfo(info)
    })
    void documentInfoUpdate.catch(() => { if (documentInfo === signature) documentInfo = '' })
  }
  const updateSaveState = () => {
    if (current) chrome?.update({ name: current.name, kind: current.kind, dirty, saving: saveInProgress, failed: autoSaveFailed, loading: !ready })
    syncDocumentInfo()
  }
  const persist = async (bytes: Uint8Array) => {
    if (!current || disposed) throw new Error('当前文档已关闭。')
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('文档超过 64 MB，当前内容仍保留，请先导出到本机。')
    const documentId = current.id
    const saveGeneration = editorGeneration
    const task = saving.catch(() => {}).then(async () => {
      if (disposed || current?.id !== documentId || editorGeneration !== saveGeneration) throw new Error('当前文档已关闭。')
      saveInProgress = true; updateSaveState()
      const file = await context.resources.createFile({ name: current.name, data: bytes, mimeType: MIME[current.kind], signal: context.signal })
      try {
        if (disposed || current?.id !== documentId || editorGeneration !== saveGeneration) throw new Error('文档保存会话已失效。')
        const saved = await command<OfficeDocument>('save', { id: documentId, revision: current.revision, resourceId: file.id })
        if (current?.id === documentId && editorGeneration === saveGeneration) current = saved
      } catch (error) {
        try {
          const latest = await command<OfficeLibrary>('list')
          if (!latest.documents.some(doc => doc.versions.some(version => version.file.id === file.id))) await context.resources.release(file)
        } catch { autoSaveFailed = true }
        throw error
      }
    })
    saving = task
    try { await task; autoSaveFailed = false; notice(''); run(loadLibrary) }
    catch (error) { autoSaveFailed = true; throw error }
    finally { saveInProgress = false; updateSaveState() }
  }
  const save = (flushEditor = false): Promise<void> => {
    if (saveTransaction) return saveTransaction
    const task = (async () => {
      clearTimeout(timer)
      if (!editor || !current) return
      if (!dirty && !flushEditor) { await saving; return }
      const revision = changed
      const active = editor
      const bytes = await active.save()
      if (!dirty && !autoSaveFailed) { await saving; return }
      await persist(bytes)
      if (editor === active) {
        if (active.markSaved) await active.markSaved(bytes)
        else if (revision === changed) dirty = false
      }
      updateSaveState()
    })().catch(error => {
      autoSaveFailed = true
      updateSaveState()
      throw error
    })
    saveTransaction = task
    void task.finally(() => {
      if (saveTransaction !== task) return
      saveTransaction = null
      if (dirty && !disposed && !autoSaveFailed) {
        clearTimeout(timer)
        timer = setTimeout(() => run(save), 1200)
      }
    }).catch(() => {})
    return task
  }
  const flush = async (signal?: AbortSignal) => {
    await mounting
    while (dirty && !disposed && !signal?.aborted) {
      await save()
      if (dirty) await new Promise(resolve => setTimeout(resolve, 0))
    }
    await saving
  }
  const prepareLeave = async (signal?: AbortSignal) => {
    try { await flush(signal); return !signal?.aborted && !dirty }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notice(message, true)
      const choice = await confirmLeaving(root, message, signal)
      if (signal?.aborted || choice === 'cancel') return false
      if (choice === 'discard') return true
      try {
        if (!editor || !current) return false
        const success = await context.resources.saveFile({ name: current.name, data: await editor.save() })
        return success && !signal?.aborted
      } catch (failure) { notice(failure instanceof Error ? failure.message : String(failure), true); return false }
    }
  }
  const agent = createOfficeViewAgent(context, {
    editor: () => editor,
    document: () => current,
    revision: () => `${editorGeneration}:${changed}`,
    dirty: () => dirty,
    save: () => save(true),
    checkStored: async () => {
      const snapshot = current
      if (!snapshot) throw new Error('文档已关闭。')
      await saving
      const library = await command<OfficeLibrary>('list')
      const latest = library.documents.find(doc => doc.id === snapshot.id)
      if (!latest || latest.trashedAt !== null || latest.revision !== current?.revision) throw new Error('文档库中的版本已变化，请重新打开后再引用。')
    },
    open: async documentId => {
      await loadLibrary()
      const document = documents.find(doc => doc.id === documentId && doc.trashedAt === null)
      if (!document) throw new Error('引用文档已删除或在回收站中。')
      await open(document)
    },
  })
  const closeGuard = typeof context.onBeforeClose === 'function' ? context.onBeforeClose(prepareLeave) : { dispose() {} }
  const clearEditor = () => {
    agent.close()
    editorGeneration++
    clearTimeout(timer); editor?.dispose(); editor = undefined; saving = Promise.resolve(); current = undefined; dirty = false; ready = false; saveInProgress = false; chrome?.dispose(); chrome = undefined
    editorHost.replaceChildren()
  }
  const exportDocument = async (doc: OfficeDocument, versionId?: string) => {
    const version = versionId ? doc.versions.find(item => item.id === versionId) : doc.versions[0]
    if (!version) throw new Error('此版本已不存在。')
    const saved = await context.resources.saveFile({ name: doc.name, data: await read(version.file) })
    notice(saved ? `已导出 ${doc.name}` : '已取消导出，文档仍保存在文档库中。')
  }
  const exportCurrent = async () => {
    if (!current || !editor) return
    const name = current.name
    const exported = await context.resources.saveFile({ name, data: await editor.save() })
    notice(exported ? `已导出 ${name}` : '已取消导出。')
  }
  const copyCurrent = async () => {
    if (!current || !editor) return
    const name = await dialog(root, '另存副本', '在文档库中新建一份独立副本。', { value: `${current.name.replace(/\.[^.]+$/, '')} 副本`, confirm: '创建副本' })
    if (typeof name !== 'string') return
    clearTimeout(timer)
    await saveTransaction?.catch(() => {})
    await saving.catch(() => {})
    const snapshotRevision = changed
    const data = await editor.save()
    const file = await context.resources.createFile({ name: fileName(name, current.kind), data, mimeType: MIME[current.kind], signal: context.signal })
    const copy = await addFile(file, file.name)
    await saveTransaction?.catch(() => {})
    if (changed !== snapshotRevision) { notice('已创建副本，当前页面仍有新的修改。'); return }
    await editor.markSaved?.(data)
    if (dirty) { notice('已创建副本，当前页面仍有新的修改。'); return }
    saving = Promise.resolve(); await open(copy)
  }
  const mutate = async (action: string, doc: OfficeDocument, extra: Record<string, string | number | boolean> = {}) => {
    await command(action, { id: doc.id, revision: doc.revision, ...extra }); await loadLibrary()
  }
  const actions = () => ({ open, create, import: importFiles, mutate, export: exportDocument, run })
  const showLibrary = async () => {
    if (!await prepareLeave()) return
    clearEditor()
    libraryHost.hidden = false; editorHost.hidden = true
    if (persistState) await context.setState({ documentId: null })
    await loadLibrary(); notice(''); syncDocumentInfo()
    if (libraryFocus?.isConnected) libraryFocus.focus({ preventScroll: true })
  }
  const open = async (document: OfficeDocument) => {
    if (opening) return
    opening = true
    const requestGeneration = editorGeneration
    try {
      if (!await prepareLeave()) return
      await loadLibrary()
      if (disposed || requestGeneration !== editorGeneration) return
      const latest = documents.find(item => item.id === document.id && item.trashedAt === null)
      if (!latest) throw new Error('文档已移入回收站或被删除。')
      notice('正在打开文件…')
      const bytes = await read(latest.versions[0].file)
      const mount = await editorMount(latest.kind)
      if (disposed || requestGeneration !== editorGeneration) return
      clearEditor(); current = latest; autoSaveFailed = false
      if (libraryHost.contains(root.ownerDocument.activeElement)) libraryFocus = root.ownerDocument.activeElement as HTMLElement
      libraryHost.hidden = true; editorHost.hidden = false
      const sessionGeneration = editorGeneration
      const page = element('section', 'office-editor-page')
      const toolbar = element('div', 'office-chrome-host')
      chrome = mountEditorChrome(toolbar, { name: latest.name, kind: latest.kind, dirty: false, saving: false, failed: false, loading: true }, {
        back: showLibrary, quote: () => agent.quote(), save: () => save(true), reopen: async () => { if (current) await open(current) }, export: exportCurrent, copy: copyCurrent,
        error: error => notice(error instanceof Error ? error.message : String(error), true),
      })
      syncDocumentInfo()
      const canvas = element('div', 'office-editor-canvas')
      page.append(toolbar, canvas); editorHost.append(page)
      const options: OfficeEditorOptions = {
        context, container: canvas, bytes, name: latest.name,
        onReference: reference => agent.quote(reference),
        onSaveRequest: () => { if (current?.id !== latest.id || editorGeneration !== sessionGeneration) return Promise.reject(new Error('文档会话已失效。')); return save(true) },
        onDirty(value) {
          if (disposed || !current || editorGeneration !== sessionGeneration) return
          dirty = value; if (value) changed++; updateSaveState(); clearTimeout(timer)
          if (value && !autoSaveFailed) timer = setTimeout(() => run(save), 1200)
        },
        onSave: async bytes => {
          if (current?.id !== latest.id || editorGeneration !== sessionGeneration) throw new Error('文档会话已失效。')
          const revision = changed; await persist(bytes)
          if (revision === changed) dirty = false
          updateSaveState()
        },
      }
      const mountTask = mount(options)
      mounting = mountTask
      try {
        const mounted = await mountTask
        if (disposed || editorGeneration !== sessionGeneration) { mounted.dispose(); return }
        editor = mounted; ready = true; updateSaveState()
        await agent.register(requestedAgentSession ?? crypto.randomUUID())
        requestedAgentSession = undefined
      } catch (error) {
        if (disposed || editorGeneration !== sessionGeneration) return
        clearEditor(); libraryHost.hidden = false; editorHost.hidden = true; syncDocumentInfo(); throw error
      } finally { if (mounting === mountTask) mounting = undefined }
      await command('opened', { id: latest.id })
      if (disposed || editorGeneration !== sessionGeneration) return
      if (persistState) await context.setState({ documentId: latest.id })
      notice('')
    } finally { opening = false }
  }
  const addFile = async (file: LocalFile, name: string, sourceId?: string, sourceHash?: string) => {
    try { return await command<OfficeDocument>('add', { resourceId: file.id, name, ...(sourceId ? { sourceId, sourceHash: sourceHash ?? '' } : {}) }) }
    catch (error) {
      try {
        const latest = await command<OfficeLibrary>('list')
        if (!latest.documents.some(doc => doc.versions.some(version => version.file.id === file.id))) await context.resources.release(file)
      } catch { notice('文件状态暂时无法确认，请重新打开文档库。', true) }
      throw error
    }
  }
  async function create(kind: OfficeKind, requestedName?: string) {
    const name = requestedName ?? await dialog(root, `新建${KIND_LABEL[kind]}`, '文件会自动保存到文档库。', { value: `未命名${KIND_LABEL[kind]}`, confirm: '创建' })
    if (typeof name !== 'string') return
    const normalized = fileName(name, kind)
    const bytes = await blankFile(kind)
    const file = await context.resources.createFile({ name: normalized, data: bytes, mimeType: MIME[kind], signal: context.signal })
    const doc = await addFile(file, normalized)
    documents = [doc, ...documents.filter(item => item.id !== doc.id)]
    if (persistState) await context.setState({ documentId: doc.id })
    libraryView.update(documents)
    try { await open(doc) }
    catch (error) {
      if (requestedAgentSession) throw error
      notice(`文件已创建，但暂时无法打开：${error instanceof Error ? error.message : String(error)} 请从文档库重新打开。`, true)
    }
  }
  async function importResource(resource: Resource, reuseSource = false) {
    const kind = kindOf(resource.name)
    if ('size' in resource && typeof resource.size === 'number' && resource.size > 64 * 1024 * 1024) throw new Error('此文件超过当前 Office 的 64 MB 文件上限。')
    const sourceId = reuseSource ? resource.sourceId : undefined
    const sourceBytes = sourceId ? await read(resource) : undefined
    const sourceHash = sourceBytes ? createHash('sha256').update(sourceBytes).digest('hex') : undefined
    const existing = sourceId && documents.find(doc => doc.sourceId === sourceId)
    if (existing) {
      if (existing.trashedAt !== null) throw new Error('此文件的文档库副本在回收站中，请先恢复。')
      return { document: existing, sourceChanged: !!existing.sourceHash && sourceHash !== existing.sourceHash }
    }
    let file: LocalFile
    if (/\.csv$/i.test(resource.name)) {
      const { importCsv } = await import('./sheets-import')
      file = await context.resources.createFile({ name: resource.name.replace(/\.csv$/i, '.xlsx'), data: await importCsv(sourceBytes ?? await read(resource), resource.name), mimeType: MIME.xlsx, signal: context.signal })
    } else file = await context.resources.importFile(resource, { signal: context.signal })
    return { document: await addFile(file, fileName(file.name, kind), sourceId, sourceHash), sourceChanged: false }
  }
  async function importFiles() {
    const files = await context.resources.pickFiles({ filters: [{ name: 'Office 文件', extensions: ['docx', 'xlsx', 'csv', 'pptx', 'pdf'] }], multiple: true })
    if (!files.length) return
    const failures: string[] = []; let count = 0
    for (const file of files) {
      try { await importResource(file); count++ }
      catch (error) { failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`) }
    }
    await loadLibrary()
    notice(`已导入 ${count} 个文件${failures.length ? `。${failures.join('；')}` : '。'}`, failures.length > 0)
  }
  const onKey = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); run(() => save(true)) }
  }
  root.addEventListener('keydown', onKey)
  const messages = context.onMessage(message => {
    if (message && typeof message === 'object' && !Array.isArray(message) && message.type === 'office-library-changed') run(loadLibrary)
  })
  context.signal.addEventListener('abort', () => { disposed = true; clearTimeout(timer); editor?.dispose(); chrome?.dispose(); notices.dispose(); libraryView?.dispose(); messages.dispose(); closeGuard.dispose(); root.removeEventListener('keydown', onKey) }, { once: true })
  if (typeof context.resources.createFile !== 'function' || typeof context.onBeforeClose !== 'function') {
    notice('此版本 Lexora 尚不支持 Office 文档库，请使用配套新版 Lexora。已有文件会保留。', true); return
  }
  const libraryView = mountLibrary(libraryHost, actions())
  syncDocumentInfo()
  await loadLibrary()
  const state = initialState
  const requestedCreate = state.create && typeof state.create === 'object' && !Array.isArray(state.create) ? state.create : undefined
  const restored = documents.find(doc => doc.id === state.documentId && doc.trashedAt === null)
  try {
  if (requestedCreate && ['docx', 'xlsx', 'pptx', 'pdf'].includes(String(requestedCreate.kind)) && typeof requestedCreate.name === 'string') await create(requestedCreate.kind as OfficeKind, requestedCreate.name)
  else if (restored) await open(restored)
  else if (context.resource) {
    const imported = await importResource(context.resource, true)
    await open(imported.document)
    if (imported.sourceChanged) notice('源文件已变化。当前保留文档库中的编辑版本，如需新源文件，请使用导入文件。')
  } else if (requestedAgentSession) throw new Error('文档不存在或已移入回收站。')
  } catch (error) {
    if (requestedAgentSession) await context.commands.execute(OFFICE_BRIDGE, { type: 'failed', sessionId: requestedAgentSession, error: error instanceof Error ? error.message : String(error) }).catch(() => {})
    throw error
  }
}

async function editorMount(kind: OfficeKind): Promise<(options: OfficeEditorOptions) => Promise<OfficeEditor>> {
  if (kind === 'docx') return (await import('./docx-editor')).mountDocxEditor
  if (kind === 'xlsx') return (await import('./sheets-editor')).mountSheets
  if (kind === 'pptx') return (await import('./slides-editor')).mountSlidesEditor
  return (await import('./pdf-editor')).mountPdfEditor
}
async function blankFile(kind: OfficeKind): Promise<Uint8Array> {
  if (kind === 'docx') return (await import('./docx-editor')).createBlankDocx()
  if (kind === 'xlsx') {
    const response = await fetch(new URL('./blank.xlsx', import.meta.url))
    if (!response.ok) throw new Error('新建表格模板读取失败。')
    return new Uint8Array(await response.arrayBuffer())
  }
  if (kind === 'pptx') return (await import('./slides-editor')).createBlankPptx()
  return (await import('./pdf-editor')).createBlankPdf()
}
