import type { Json, ViewContext, LocalFile } from './lexora'
import type { OfficeEditor, OfficeEditorQuery, OfficeEditorReference } from './office-editor-types'
import type { OfficeOpenDocument } from './office-document'
import { OFFICE_BRIDGE, parseOfficeLocator } from './office-agent'
import { assertOfficeReferenceText, compactOfficeReference } from './office-assistant'

interface ViewAgentPorts {
  editor(): OfficeEditor | undefined
  document(): OfficeOpenDocument | undefined
  revision(): string
  dirty(): boolean
  save(): Promise<void>
  checkpoint?(): Promise<void>
  export(): Promise<LocalFile>
  checkStored(): Promise<void>
  open(documentId: string): Promise<void>
}
const object = (value: Json): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null

export function createOfficeViewAgent(context: ViewContext, ports: ViewAgentPorts) {
  let sessionId = ''
  let queue = Promise.resolve()
  const requests = new Map<string, AbortController>()
  const send = (message: Record<string, Json>) => context.commands.execute(OFFICE_BRIDGE, message)
  const close = () => {
    for (const request of requests.values()) request.abort()
    requests.clear()
    if (sessionId) void send({ type: 'closed', sessionId }).catch(() => {})
    sessionId = ''
  }
  const register = async (id: string) => {
    sessionId = id
    const document = ports.document()
    if (document) await send({ type: 'ready', sessionId, documentId: document.id })
  }
  const capture = async (selected: OfficeEditorReference) => {
    const editor = ports.editor()
    const document = ports.document()
    const capturedSession = sessionId
    const revision = ports.revision()
    const state = ports.dirty() ? 'session' : 'saved'
    if (!editor?.assistant || !document || !capturedSession) throw new Error('文档尚未准备好，请稍后重试。')
    if (!selected.text.trim()) throw new Error('请先选择要引用的文字、单元格或页面对象。')
    const captured = structuredClone(selected)
    const current = () => {
      if (editor !== ports.editor() || sessionId !== capturedSession || ports.document()?.id !== document.id || ports.revision() !== revision) throw new Error('内容已变化，请重新选择并引用。')
    }
    const reference = editor.assistant.resolveReference ? await editor.assistant.resolveReference(captured) : (await editor.assistant.read(captured)).reference ?? captured
    current()
    assertOfficeReferenceText(captured, reference)
    const { text, ...location } = captured
    const title = reference.label.startsWith(`${document.name} · `) ? reference.label : `${document.name} · ${reference.label}`
    return context.references.capture({ kind: 'content', source: 'view', title, text, locator: { version: 2, data: { documentId: document.id, documentVersion: document.version, state, revision, sessionId: capturedSession, reference: JSON.parse(JSON.stringify(location)) as Json } } })
  }
  const subscription = context.onMessage(raw => {
    const message = object(raw)
    if (!message || message.sessionId !== sessionId || typeof message.requestId !== 'string') return
    if (message.type === 'office-agent-cancel') { requests.get(message.requestId)?.abort(); return }
    if (message.type !== 'office-agent-request' || message.documentId !== ports.document()?.id) return
    const capturedSession = sessionId
    const requestId = message.requestId
    if (requests.has(requestId)) return
    const abort = new AbortController()
    requests.set(requestId, abort)
    const signal = AbortSignal.any([context.signal, abort.signal])
    const reply = (value: Json | undefined, error?: unknown) => {
      const json = JSON.stringify(value ?? null)
      if (!error && new TextEncoder().encode(json).length > 240 * 1024) error = new Error('返回内容过大，请缩小读取范围或分批查询。')
      return send({ type: 'reply', sessionId: capturedSession, requestId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : { value: JSON.parse(json) as Json }) }).catch(() => {})
    }
    const execute = async () => {
      signal.throwIfAborted()
      const editor = ports.editor()
      const document = ports.document()
      const revision = ports.revision()
      const assertCurrent = () => {
        signal.throwIfAborted()
        if (!editor || editor !== ports.editor() || sessionId !== capturedSession || document?.id !== ports.document()?.id || ports.revision() !== revision) throw new Error('文档已变化或关闭。请重新读取引用后再修改。')
      }
      assertCurrent()
      if (!editor?.assistant) throw new Error('此编辑器暂不支持文档工具。')
      let reference = object(message.reference) ? message.reference as unknown as OfficeEditorReference : undefined
      if (message.expectedRevision !== undefined && message.expectedRevision !== revision) throw new Error('文档已被其他操作修改。请重新打开文档目标，禁止重试旧修改。')
      await ports.checkStored()
      assertCurrent()
      if (message.operation === 'ping') return { ready: true }
      if (message.operation === 'read' || message.operation === 'capabilities' || message.operation === 'render') {
        if (message.operation === 'capabilities') {
          const capabilities = await editor.assistant.capabilities?.() ?? { writeOperations: (await editor.assistant.read(reference)).operations }
          assertCurrent()
          return { ok: true, kind: document!.kind, revision, render: !!editor.assistant.render, capabilities } as Json
        }
        if (message.operation === 'render') {
          if (!editor.assistant.render) throw new Error('此格式暂不提供模型图片渲染，请使用格式 inspect 与编辑器核对。')
          const previews = await editor.assistant.render(object(message.input) ?? {}, { signal, assertCurrent })
          assertCurrent()
          if (!previews.length || previews.length > 4) throw new Error('每次渲染应返回 1–4 张图片。')
          const images = []
          try {
            for (const preview of previews) {
              assertCurrent()
              images.push(await context.resources.createFile({ ...preview, signal }))
            }
            assertCurrent()
            return { revision, images } as unknown as Json
          } catch (error) {
            for (const image of images) await context.resources.release(image).catch(() => {})
            throw error
          }
        }
        if (reference && editor.assistant.resolveReference) reference = await editor.assistant.resolveReference(reference)
        assertCurrent()
        const result = await editor.assistant.read(reference, object(message.query) as OfficeEditorQuery | undefined)
        assertCurrent()
        if (document!.version !== ports.document()?.version) throw new Error('读取期间文档已变化，请重新读取当前目标。')
        const selected = result.reference ?? reference
        const location = selected ? compactOfficeReference(selected) : undefined
        const documentVersion = document!.version
        const value = { ...result, contentState: 'current', dirty: ports.dirty(), persistence: document!.local ? document!.local.kind : 'library', revision, kind: document!.kind, name: document!.name, documentVersion, ...(location ? { reference: location } : {}), ...(message.referenceState === 'session' ? { referenceState: 'session', sourceChangedSinceReference: message.referenceRevision !== revision } : typeof message.documentVersion === 'string' ? { referenceState: 'saved', referenceDocumentVersion: message.documentVersion, sourceChangedSinceReference: message.documentVersion !== documentVersion } : {}) } as unknown as Record<string, Json>
        if (new TextEncoder().encode(JSON.stringify(value)).length > 220 * 1024) {
          value.text = result.text.slice(0, 2000) + '\n上下文已截断，请用格式查询缩小范围；定位原文仍完整保留。'
          value.truncated = true
        }
        if (new TextEncoder().encode(JSON.stringify(value)).length > 220 * 1024) {
          delete value.data
          value.truncated = true
        }
        return value
      }
      if ((message.operation !== 'edit' && message.operation !== 'export') || message.expectedRevision !== revision) throw new Error('文档版本已变化，请重新读取目标，禁止重试旧修改。')
      if (message.operation === 'export') {
        const file = await ports.export()
        assertCurrent()
        return { revision, kind: document!.kind, documentVersion: document!.version, file } as unknown as Json
      }
      if (document?.local && !document.local.writable) throw new Error('原文件只读，请先另存为后再编辑。')
      const action = message.action
      if (action !== 'save' && action !== 'undo') {
        const current = await editor.assistant.read(reference)
        assertCurrent()
        if (typeof action !== 'string' || !current.operations.includes(action)) throw new Error('当前目标不支持此操作。请查询 capabilities。')
      }
      const result = action === 'save' ? { text: '保存文档', mutated: false } : await editor.assistant.execute({ operation: String(action), input: object(message.input) ?? {}, reference }, { signal, assertCurrent })
      if (sessionId !== capturedSession || editor !== ports.editor()) throw new Error('文档会话已关闭，请检查已执行的修改。')
      const appliedRevision = ports.revision()
      let recoveryError: string | undefined
      if (document?.local && action !== 'save' && result.mutated) {
        try { await ports.checkpoint?.() } catch (error) { recoveryError = error instanceof Error ? error.message : String(error) }
      }
      if (sessionId !== capturedSession || editor !== ports.editor()) throw new Error('文档会话已关闭，请检查已执行的修改。')
      if (ports.revision() !== appliedRevision) throw new Error('保存恢复草稿期间文档被修改，请重新读取目标。')
      try {
        signal.throwIfAborted()
        if (document?.local && action !== 'save') {
          return { ...result, revision: appliedRevision, documentVersion: document.version, saved: false, dirty: ports.dirty(), persistence: document.local.kind, ...(recoveryError ? { recoveryError } : {}) } as unknown as Json
        }
        await ports.save()
        if (ports.dirty()) throw new Error('编辑内容尚未全部保存，请使用当前 revision 重试 save，不要重复修改。')
      } catch (error) {
        if (ports.revision() !== appliedRevision) throw new Error('保存期间文档被修改，请检查实际内容后重新打开目标。')
        return { ...result, revision: appliedRevision, saved: false, saveError: error instanceof Error ? error.message : String(error) } as unknown as Json
      }
      signal.throwIfAborted()
      if (sessionId !== capturedSession || editor !== ports.editor() || ports.revision() !== appliedRevision) throw new Error('保存期间文档被修改，请检查实际内容后重新打开目标。')
      const savedDocument = ports.document()!
      return { ...result, revision: appliedRevision, documentVersion: savedDocument.version, saved: true } as unknown as Json
    }
    queue = queue.catch(() => {}).then(async () => {
      try { await reply(await execute()) } catch (error) { await reply(undefined, error) }
      finally { requests.delete(requestId) }
    })
  })
  const reveal = context.references.onReveal(async (input, signal) => {
    if (input.locator?.version !== 1 && input.locator?.version !== 2) return false
    const locator = parseOfficeLocator(input.locator.data as Json, input.text)
    signal.throwIfAborted()
    if (locator.state === 'session' && (ports.document()?.id !== locator.documentId || sessionId !== locator.sessionId)) throw new Error('未保存引用的编辑会话已关闭；历史快照仍可阅读。')
    if (ports.document()?.id !== locator.documentId) await ports.open(locator.documentId)
    signal.throwIfAborted()
    if (ports.document()?.id !== locator.documentId) return false
    try { if (!ports.dirty()) await ports.checkStored() }
    catch (error) {
      signal.throwIfAborted()
      if (ports.dirty() || ports.document()?.id !== locator.documentId) throw error
      await ports.open(locator.documentId)
      signal.throwIfAborted()
      await ports.checkStored()
    }
    signal.throwIfAborted()
    const editor = ports.editor()
    const capturedSession = sessionId
    if (!editor?.assistant?.reveal || !capturedSession || ports.document()?.id !== locator.documentId) return false
    const revision = ports.revision()
    const savedVersion = ports.document()?.version
    const revealed = await editor.assistant.reveal(locator.reference)
    signal.throwIfAborted()
    if (editor === ports.editor() && sessionId === capturedSession && (ports.revision() !== revision || ports.document()?.version !== savedVersion)) throw new Error('定位期间文档已变化，请重试定位当前内容。')
    return revealed && editor === ports.editor() && sessionId === capturedSession && ports.document()?.id === locator.documentId
  })
  context.signal.addEventListener('abort', () => { close(); subscription.dispose(); reveal.dispose() }, { once: true })
  return { register, close, capture }
}
