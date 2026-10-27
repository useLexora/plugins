import type { EditableDocument, Json, LocalFile, Resource, ViewContext } from './lexora'
import type { OfficeEditor, OfficeEditorOptions } from './office-editor-types'
import { KIND_LABEL, MIME, PLUGIN_ID, fileName, type OfficeDocument, type OfficeKind, type OfficeLibrary } from './office-library'
import { libraryDocument, localDocument, type OfficeOpenDocument } from './office-document'
import { mountLibrary } from './library-view'
import { confirmLeaving, confirmLocalClose, dialog, element } from './office-ui'
import { mountEditorChrome, mountOfficeNotices } from './editor-chrome'
import { createOfficeViewAgent } from './office-view-agent'
import { OFFICE_BRIDGE } from './office-agent'

const filters = [{ name: 'Office 文件', extensions: ['docx', 'xlsx', 'csv', 'pptx', 'pdf'] }]
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('FILE_CONFLICT')) return '文件已在其他程序中修改。请另存为，或重新加载后继续编辑。'
  if (message.includes('ALREADY_OPEN')) return '此文件已在其他页面打开，请回到已有页面继续编辑。'
  if (message.includes('RECOVERY_REQUIRED')) return '上次保存的结果尚未确认。恢复草稿已保留，可以另存为保留当前内容。'
  if (message.includes('REVOKED') || message.includes('EXPIRED')) return '文件授权或编辑会话已失效，请重新打开文件。'
  return message
}

export async function startOffice(context: ViewContext, root: HTMLElement, persistState = true) {
  const noticeHost = element('div', 'office-notice-host')
  const notices = mountOfficeNotices(noticeHost)
  const content = element('div', 'office-content')
  const libraryHost = element('div', 'office-library-host')
  const editorHost = element('div', 'office-editor-host'); editorHost.hidden = true
  root.append(noticeHost, content); content.append(libraryHost, editorHost)
  const initial = context.state && typeof context.state === 'object' && !Array.isArray(context.state) ? context.state : {}
  let requestedAgentSession = typeof initial.agentSessionId === 'string' ? initial.agentSessionId : undefined
  let current: OfficeOpenDocument | undefined
  let editor: OfficeEditor | undefined
  let mounting: Promise<OfficeEditor> | undefined
  let documents: OfficeDocument[] = []
  let dirty = false; let recoveredDirty = false; let changed = 0; let generation = 0
  let disposed = false; let opening = false; let ready = false; let failed = false; let saving = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let io: Promise<unknown> = Promise.resolve()
  let chrome: ReturnType<typeof mountEditorChrome> | undefined
  let documentInfo = ''
  const run = (action: () => Promise<unknown>) => { void action().catch(error => notice(errorText(error), true)) }
  const notice = (text: string, error = false) => notices.show(text, error, error && current ? [
    { label: '另存为…', run: () => saveAs() },
    ...(failed ? [{ label: '重试保存', run: () => save() }] : []),
    { label: '重新加载', run: async () => { if (current) await openId(current.id) } },
  ] : [])
  const command = async <T>(action: string, args: Record<string, Json> = {}): Promise<T> => {
    const result = await context.commands.execute(`${PLUGIN_ID}.manage`, { action, ...args }) as { ok: boolean, value?: Json, error?: string }
    if (!result.ok) throw new Error(result.error ?? '文档库操作失败。')
    return result.value as T
  }
  const refresh = async () => {
    const [stored, recent] = await Promise.all([command<OfficeLibrary>('list'), context.documents.list()])
    documents = stored.documents
    library?.update(documents, recent.filter(document => filters[0].extensions.includes(document.name.split('.').pop()?.toLowerCase() ?? '')))
  }
  const update = () => {
    if (current) chrome?.update({ name: current.name, kind: current.kind, dirty, saving, failed, loading: !ready, location: current.local?.location ?? 'Office 文档库', local: !!current.local, writable: current.local?.writable ?? true })
    const info = { title: current?.name ?? 'Office', dirty: !!current && dirty }
    const signature = JSON.stringify(info)
    if (signature !== documentInfo && !disposed) {
      documentInfo = signature
      void context.setDocumentInfo(info).catch(() => { documentInfo = '' })
    }
  }
  const transaction = <T,>(action: () => Promise<T>): Promise<T> => {
    const task = io.catch(() => {}).then(action); io = task; return task
  }
  const read = async (resource: Resource) => {
    const response = await fetch(await context.resources.getUrl(resource), { signal: context.signal })
    if (!response.ok) throw new Error('文件读取失败，请重新打开。')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > 64 * 1024 * 1024) throw new Error('此文件超过 Office 的 64 MB 文件上限。')
    return bytes
  }
  const adoptLocal = (document: EditableDocument) => { current = localDocument(document) }
  const persist = async (bytes: Uint8Array) => {
    const target = current; const version = generation
    if (!target) throw new Error('文档已关闭。')
    if (bytes.length > 64 * 1024 * 1024) throw new Error('文档超过 Office 的 64 MB 文件上限。')
    if (target.local) {
      const saved = target.local.kind === 'file' && target.local.writable
        ? await context.documents.save(target.local, { data: bytes, signal: context.signal })
        : await context.documents.saveAs({ name: target.name, data: bytes, signal: context.signal })
      if (!saved) return false
      if (current !== target || generation !== version) throw new Error('文档会话已变化。')
      if (saved.id !== target.local.id) {
        if (target.local.writable) await context.documents.discardRecovery(target.local).catch(() => {})
        await context.documents.close(target.local)
      }
      adoptLocal(saved)
    } else {
      const file = await context.resources.createFile({ name: target.name, data: bytes, mimeType: MIME[target.kind], signal: context.signal })
      let saved: OfficeDocument
      try { saved = await command<OfficeDocument>('save', { id: target.id, revision: target.library!.revision, resourceId: file.id }) }
      catch (error) {
        const library = await command<OfficeLibrary>('list').catch(() => undefined)
        if (library && !library.documents.some(document => document.versions.some(version => version.file.id === file.id))) await context.resources.release(file).catch(() => {})
        throw error
      }
      if (current !== target || generation !== version) throw new Error('文档会话已变化。')
      current = libraryDocument(saved)
    }
    if (persistState) await context.setState({ documentId: current!.id })
    return true
  }
  const save = () => transaction(async () => {
    if (!editor || !current) return
    clearTimeout(timer); saving = true; update()
    const active = editor; const identity = current.id
    try {
      const bytes = await active.save(); const revision = changed
      if (!dirty && !failed && current.local?.kind !== 'draft') return
      if (!await persist(bytes)) return
      await active.markSaved?.(bytes)
      if (revision === changed) { dirty = false; recoveredDirty = false }
      failed = false; notice('')
      if (identity !== current!.id) await agent.register(crypto.randomUUID())
      await refresh()
    } catch (error) { failed = true; throw error }
    finally { saving = false; update() }
  })
  const backup = () => transaction(async () => {
    if (!editor || !current?.local || !dirty || !current.local.writable) return
    const target = current; const bytes = await editor.save()
    const stored = await context.documents.backup(target.local!, { data: bytes, signal: context.signal })
    if (current === target) current = localDocument(stored)
    update()
  })
  const saveAs = () => transaction(async () => {
    if (!editor || !current) return
    clearTimeout(timer)
    const target = current; const active = editor
    const bytes = await active.save(); const revision = changed
    const saved = await context.documents.saveAs({ name: target.name, data: bytes, signal: context.signal })
    if (!saved) return
    if (target.local) {
      if (target.local.writable) await context.documents.discardRecovery(target.local).catch(() => {})
      await context.documents.close(target.local)
    }
    adoptLocal(saved); await active.markSaved?.(bytes)
    if (revision === changed) { dirty = false; recoveredDirty = false }
    failed = false; update(); notice('')
    if (persistState) await context.setState({ documentId: current!.id })
    await agent.register(crypto.randomUUID()); await refresh()
  })
  const copy = async () => {
    if (!editor || !current) return
    const saved = await context.resources.saveFile({ name: current.name, data: await editor.save() })
    if (saved) notice('已保存副本，当前文档保持不变。')
  }
  const prepareLeave = async (signal?: AbortSignal) => {
    if (signal?.aborted) return false
    clearTimeout(timer)
    await mounting
    if (signal?.aborted) return false
    await io.catch(() => {})
    if (signal?.aborted) return false
    if (editor) await transaction(() => editor!.save())
    if (signal?.aborted) return false
    if (!dirty || !current) return !signal?.aborted
    if (current.local) {
      await backup().catch(error => notice(errorText(error), true))
      const choice = await confirmLocalClose(root, current.name, signal)
      if (choice === 'cancel') return false
      if (choice === 'discard') { if (current.local.writable) await context.documents.discardRecovery(current.local); return !signal?.aborted }
      try { await save(); return !dirty && !signal?.aborted }
      catch (error) { notice(errorText(error), true); return false }
    }
    try { await save(); return !dirty && !signal?.aborted }
    catch (error) {
      notice(errorText(error), true)
      const choice = await confirmLeaving(root, errorText(error), signal)
      if (choice === 'discard') return !signal?.aborted
      if (choice === 'export' && editor) return await context.resources.saveFile({ name: current.name, data: await editor.save() }) && !signal?.aborted
      return false
    }
  }
  const agent = createOfficeViewAgent(context, {
    editor: () => editor, document: () => current, revision: () => `${generation}:${changed}`, dirty: () => dirty,
    save: async () => {
      if (current?.local && current.local.kind !== 'file') throw new Error('文档尚无保存位置。请在编辑器中另存为，或使用 export 发布任务产物。')
      await save()
    },
    checkpoint: backup,
    export: async () => {
      if (!editor || !current) throw new Error('文档已关闭。')
      return context.resources.createFile({ name: current.name, data: await editor.save(), mimeType: MIME[current.kind], signal: context.signal })
    },
    checkStored: async () => {
      if (current?.local) { await context.documents.status(current.local); return }
      const target = current?.library
      if (!target) throw new Error('文档已关闭。')
      const latest = (await command<OfficeLibrary>('list')).documents.find(doc => doc.id === target.id)
      if (!latest || latest.trashedAt !== null || latest.revision !== target.revision) throw new Error('文档库中的版本已变化，请重新打开。')
    },
    open: openId,
  })
  const clear = async () => {
    agent.close(); generation++; clearTimeout(timer)
    if (current?.local) await context.documents.close(current.local).catch(() => {})
    editor?.dispose(); editor = undefined; current = undefined; dirty = false; ready = false; failed = false
    chrome?.dispose(); chrome = undefined; editorHost.replaceChildren()
  }
  const showHome = async () => {
    if (!await prepareLeave()) return
    await clear(); libraryHost.hidden = false; editorHost.hidden = true
    if (persistState) await context.setState({})
    await refresh(); update(); notice('')
  }
  const mount = async (document: OfficeOpenDocument, bytes: Uint8Array) => {
    if (disposed) return false
    await clear()
    if (document.local) {
      document = localDocument(await context.documents.resume(document.local))
      bytes = await context.documents.read(document.local!, { signal: context.signal })
    }
    if (disposed) return false
    current = document; dirty = document.local?.recovery ?? false; recoveredDirty = dirty
    libraryHost.hidden = true; editorHost.hidden = false
    const sessionGeneration = generation
    const page = element('section', 'office-editor-page')
    const toolbar = element('div', 'office-chrome-host')
    const canvas = element('div', 'office-editor-canvas')
    page.append(toolbar, canvas); editorHost.append(page)
    chrome = mountEditorChrome(toolbar, { name: document.name, kind: document.kind, dirty, saving: false, failed: false, loading: true, location: document.local?.location ?? 'Office 文档库', local: !!document.local, writable: document.local?.writable ?? true }, {
      back: showHome, save, saveAs, copy, reopen: async () => { if (current) await openId(current.id) },
      reveal: async () => { if (current?.local) await context.documents.reveal(current.local) },
      error: error => notice(errorText(error), true),
    })
    const recovered = document.local?.recovery ?? false
    const options: OfficeEditorOptions = {
      context, container: canvas, bytes, name: document.name,
      captureReference: reference => agent.capture(reference),
      onSaveRequest: () => {
        if (disposed || sessionGeneration !== generation) return Promise.reject(new Error('文档会话已失效。'))
        return save()
      },
      onDirty(value) {
        if (disposed || sessionGeneration !== generation) return
        dirty = value || recoveredDirty; if (value) changed++; update(); clearTimeout(timer)
        if (value && !failed) timer = setTimeout(() => run(current?.local ? backup : save), current?.local ? 1800 : 1200)
      },
      onSave: async bytes => {
        await transaction(async () => {
          if (sessionGeneration !== generation) throw new Error('文档会话已失效。')
          const revision = changed
          if (await persist(bytes) && revision === changed) { dirty = false; recoveredDirty = false }
          update()
        })
      },
    }
    const mountEditor = await editorMount(document.kind)
    if (disposed || sessionGeneration !== generation) return false
    const task = mountEditor(options)
    mounting = task
    try {
      const mounted = await task
      if (disposed || sessionGeneration !== generation) { mounted.dispose(); return false }
      editor = mounted; ready = true; update()
    } catch (error) {
      if (disposed || sessionGeneration !== generation) return false
      await clear(); libraryHost.hidden = false; editorHost.hidden = true
      update(); await refresh(); throw error
    } finally { if (mounting === task) mounting = undefined }
    if (dirty) timer = setTimeout(() => run(current?.local ? backup : save), current?.local ? 1800 : 1200)
    if (persistState) await context.setState({ documentId: document.id })
    const session = requestedAgentSession ?? crypto.randomUUID(); requestedAgentSession = undefined
    await agent.register(session)
    if (recovered) notice('已恢复上次未保存的草稿，原文件尚未更新。')
    else if (document.local && !document.local.writable) notice('原文件只读或已在其他页面打开；请另存为后继续编辑。')
    else notice('')
    return true
  }
  const openingTask = async (action: () => Promise<void>) => {
    if (opening) return
    opening = true
    try { if (await prepareLeave()) await action() } finally { opening = false }
  }
  async function openLibrary(document: OfficeDocument) {
    await openingTask(async () => {
      const latest = (await command<OfficeLibrary>('list')).documents.find(doc => doc.id === document.id && doc.trashedAt === null)
      if (!latest) throw new Error('文档已移入回收站或被删除。')
      if (!await mount(libraryDocument(latest), await read(latest.versions[0].file))) return
      await command('opened', { id: latest.id }); await refresh()
    })
  }
  async function openLocal(document: EditableDocument) {
    const bytes = await context.documents.read(document, { signal: context.signal })
    if (bytes.length > 64 * 1024 * 1024) throw new Error('此文件超过 Office 的 64 MB 文件上限。')
    if (!document.writable) {
      const approved = await dialog(root, '原文件不可编辑', '文件只读或已在其他页面打开。可以创建独立草稿，保存时选择新位置。', { confirm: '编辑副本' })
      await context.documents.close(document)
      if (!approved) return
      const draft = await context.documents.create({ name: document.name, data: bytes, signal: context.signal })
      await mount(localDocument(draft), bytes)
    } else if (/\.csv$/i.test(document.name)) {
      const { importCsv } = await import('./sheets-import')
      const converted = await context.documents.create({ name: document.name.replace(/\.csv$/i, '.xlsx'), data: await importCsv(bytes, document.name), signal: context.signal })
      await context.documents.close(document)
      await mount(localDocument(converted), await context.documents.read(converted))
      notice('CSV 已转换为工作簿，保存时将创建 XLSX 文件。')
    } else await mount(localDocument(document), bytes)
    await refresh()
  }
  async function openId(id: string) {
    if (id.startsWith('local:')) await openingTask(async () => openLocal(await context.documents.resume({ id: id.slice(6) })))
    else {
      await refresh()
      const document = documents.find(doc => doc.id === id && doc.trashedAt === null)
      if (!document) throw new Error('文档不存在或已移入回收站。')
      await openLibrary(document)
    }
  }
  const pick = () => openingTask(async () => {
    const document = await context.documents.pick({ filters })
    if (document) await openLocal(document)
  })
  async function create(kind: OfficeKind, requestedName?: string) {
    const bytes = await blankFile(kind)
    const name = fileName(requestedName ?? `未命名${KIND_LABEL[kind]}`, kind)
    const file = await context.resources.createFile({ name, data: bytes, mimeType: MIME[kind] })
    const document = await command<OfficeDocument>('add', { resourceId: file.id, name })
    try { await openLibrary(document) }
    catch (error) { notice(`文件已创建，但暂时无法打开：${errorText(error)} 请从文档库重新打开。`, true) }
    await refresh()
  }
  const importFiles = async () => {
    const files = await context.resources.pickFiles({ filters, multiple: true })
    for (const selected of files) {
      let file: LocalFile
      if (/\.csv$/i.test(selected.name)) {
        const { importCsv } = await import('./sheets-import')
        file = await context.resources.createFile({ name: selected.name.replace(/\.csv$/i, '.xlsx'), data: await importCsv(await read(selected), selected.name), mimeType: MIME.xlsx })
      } else file = await context.resources.importFile(selected)
      await command('add', { resourceId: file.id, name: file.name })
    }
    await refresh(); if (files.length) notice(`已创建 ${files.length} 份文档库副本。`)
  }
  const closeGuard = context.onBeforeClose(prepareLeave)
  const keydown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); run(event.shiftKey ? saveAs : save) }
  }
  root.ownerDocument.addEventListener('keydown', keydown, true)
  const checkExternal = () => {
    const target = current
    if (!ready || saving || !target?.local || target.local.kind !== 'file') return
    void context.documents.status(target.local).then(status => {
      if (current === target && status.changed) notice('文件已在其他程序中修改。当前编辑内容已保留，请重新加载或另存为。', true)
    }).catch(error => { if (current === target) notice(errorText(error), true) })
  }
  root.ownerDocument.defaultView?.addEventListener('focus', checkExternal)
  const stop = context.onMessage(message => { if (message && typeof message === 'object' && !Array.isArray(message) && message.type === 'office-library-changed') run(refresh) })
  context.signal.addEventListener('abort', () => {
    disposed = true; root.ownerDocument.defaultView?.removeEventListener('focus', checkExternal); clearTimeout(timer); stop.dispose(); closeGuard.dispose(); root.ownerDocument.removeEventListener('keydown', keydown, true)
    agent.close(); editor?.dispose(); chrome?.dispose(); library?.dispose(); notices.dispose()
  }, { once: true })
  if (!context.documents) { notice('请使用支持本地文件编辑的新版 Lexora。已有文档库会保留。', true); return }
  const library = mountLibrary(libraryHost, {
    open: openLibrary, create, pick,
    resume: document => openId(`local:${document.id}`),
    forget: async document => { await context.documents.forget(document); await refresh() },
    import: importFiles, mutate: async (action, document, extra = {}) => { await command(action, { id: document.id, revision: document.revision, ...extra }); await refresh() }, export: async (document, versionId) => {
    const version = versionId ? document.versions.find(item => item.id === versionId) : document.versions[0]
    if (!version) throw new Error('版本已不存在。')
    await context.resources.saveFile({ name: document.name, data: await read(version.file) })
  }, run })
  update(); await refresh()
  try {
    const requested = initial.create && typeof initial.create === 'object' && !Array.isArray(initial.create) ? initial.create : undefined
    if (requested && ['docx', 'xlsx', 'pptx', 'pdf'].includes(String(requested.kind)) && typeof requested.name === 'string') await create(requested.kind as OfficeKind, requested.name)
    else if (typeof initial.documentId === 'string') await openId(initial.documentId)
    else if (context.resource) {
      const document = await context.documents.open(context.resource)
      if (!document) throw new Error('此文件没有可编辑的本地来源，请从本地文件或文档库打开。')
      await openLocal(document)
    }
  } catch (error) {
    if (requestedAgentSession) await context.commands.execute(OFFICE_BRIDGE, { type: 'failed', sessionId: requestedAgentSession, error: errorText(error) }).catch(() => {})
    notice(errorText(error), true)
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
