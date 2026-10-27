import type { AgentReference, AgentToolContext, ExtensionContext, Json } from './lexora'
import type { OfficeEditorReference } from './office-editor-types'
import { compactOfficeReference } from './office-assistant'
import { PLUGIN_ID, fileName, type OfficeDocument, type OfficeLibraryService, type OfficeKind } from './office-library'

export const OFFICE_BRIDGE = `${PLUGIN_ID}.editor-bridge`
export interface OfficeReferenceLocator {
  state: 'saved' | 'session'
  revision?: string
  documentId: string
  documentVersion: string
  sessionId: string
  reference: OfficeEditorReference
}
interface Session { documentId: string; sessionId: string }
interface Target extends Session {
  referenceId?: string
  sourceMessageId?: string
  taskId: string
  branchId: string
  runId: string
  revision: string
  reference?: OfficeEditorReference
  expires: number
}
interface Pending { sessionId: string; finish: (result?: Json, error?: Error) => void }
const object = (value: unknown): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : null
const parameters = (value: Json | undefined): Record<string, Json> => {
  if (value === undefined || value === '') return {}
  const parsed = object(typeof value === 'string' ? JSON.parse(value) : value)
  if (!parsed) throw new Error('input 必须是 JSON 对象。')
  return parsed
}
const summary = (doc: OfficeDocument) => ({ documentId: doc.id, name: doc.name, kind: doc.kind, revision: doc.revision, documentVersion: doc.versions[0].id, favorite: doc.favorite, trashed: doc.trashedAt !== null, updatedAt: doc.updatedAt, size: doc.versions[0].file.size })
export function parseOfficeLocator(value: Json, snapshotText?: string, snapshot?: { textDigest?: string; textLength?: number }): OfficeReferenceLocator {
  const data = object(value)
  const reference = data && object(data.reference)
  const text = snapshotText ?? reference?.text
  if (!data || typeof data.documentId !== 'string' || typeof data.documentVersion !== 'string' || !data.documentVersion || typeof data.sessionId !== 'string' || !reference || typeof text !== 'string' || typeof reference.label !== 'string' || typeof reference.version !== 'string' || !object(reference.locator)) throw new Error('引用缺少 Office 文档定位，请重新引用原文。')
  if (data.state !== undefined && data.state !== 'saved' && data.state !== 'session') throw new Error('引用的来源状态无效。')
  return { state: data.state ?? 'saved', ...(typeof data.revision === 'string' ? { revision: data.revision } : {}), documentId: data.documentId, documentVersion: data.documentVersion, sessionId: data.sessionId, reference: { label: reference.label, text, ...(snapshot?.textDigest ? { textDigest: snapshot.textDigest, textLength: snapshot.textLength } : {}), locator: reference.locator as Record<string, Json>, version: reference.version } }
}

export function registerOfficeAgent(context: ExtensionContext, library?: OfficeLibraryService) {
  const sessions = new Map<string, Session>()
  const pending = new Map<string, Pending>()
  const targets = new Map<string, Target>()
  const ready = new Map<string, { resolve: (session: Session) => void; reject: (error: Error) => void }>()
  context.subscriptions.add(context.commands.register(OFFICE_BRIDGE, ({ arguments: raw }) => {
    const message = object(raw)
    if (!message || typeof message.sessionId !== 'string') throw new Error('编辑器消息无效。')
    if (message.type === 'ready' && typeof message.documentId === 'string') {
      const session = { sessionId: message.sessionId, documentId: message.documentId }
      sessions.set(session.sessionId, session)
      ready.get(session.sessionId)?.resolve(session)
    } else if (message.type === 'failed') {
      ready.get(message.sessionId)?.reject(new Error(typeof message.error === 'string' ? message.error : '文档打开失败。'))
    } else if (message.type === 'closed') {
      sessions.delete(message.sessionId)
      for (const request of pending.values()) if (request.sessionId === message.sessionId) request.finish(undefined, new Error('文档编辑会话已关闭，请重新打开目标。'))
      for (const [id, target] of targets) if (target.sessionId === message.sessionId) targets.delete(id)
    } else if (message.type === 'reply' && typeof message.requestId === 'string') {
      const request = pending.get(message.requestId)
      if (request?.sessionId === message.sessionId) request.finish(message.value, typeof message.error === 'string' ? new Error(message.error) : undefined)
      else {
        const value = object(message.value)
        if (Array.isArray(value?.images)) for (const image of value.images) {
          const resource = object(image)
          if (typeof resource?.id === 'string') void context.resources.release({ id: resource.id }).catch(() => {})
        }
      }
    }
    return null
  }))
  const request = (session: Session, operation: string, args: Record<string, Json>, signal: AbortSignal, timeout = 30000): Promise<Json> => {
    signal.throwIfAborted()
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        void context.views.broadcast({ type: 'office-agent-cancel', sessionId: session.sessionId, requestId }).catch(() => {})
        finish(undefined, signal.reason instanceof Error ? signal.reason : new Error('操作已取消。'))
      }
      const timer = setTimeout(() => {
        void context.views.broadcast({ type: 'office-agent-cancel', sessionId: session.sessionId, requestId }).catch(() => {})
        finish(undefined, new Error('编辑器响应超时。请先检查文档中的实际内容，再重新读取；不要直接重试写入或新建。'))
      }, timeout)
      const finish = (value?: Json, error?: Error) => {
        if (!pending.delete(requestId)) return
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (error) reject(error); else resolve(value ?? null)
      }
      pending.set(requestId, { sessionId: session.sessionId, finish })
      signal.addEventListener('abort', cancel, { once: true })
      void context.views.broadcast({ type: 'office-agent-request', sessionId: session.sessionId, documentId: session.documentId, requestId, operation, ...args }).catch(error => finish(undefined, error))
      if (signal.aborted) cancel()
    })
  }
  const openView = async (state: Record<string, Json>, signal: AbortSignal): Promise<Session> => {
    signal.throwIfAborted()
    const sessionId = crypto.randomUUID()
    const session = await new Promise<Session>((resolve, reject) => {
      const finish = (value?: Session, error?: Error) => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel); ready.delete(sessionId)
        if (error) reject(error); else resolve(value!)
      }
      const cancel = () => finish(undefined, new Error('等待文档打开已取消。新建操作可能已完成，请先查询文档库，不要重复新建。'))
      const timer = setTimeout(() => finish(undefined, new Error('文档未能打开。请检查 Office 文档库，勿直接重试新建。')), 45000)
      ready.set(sessionId, { resolve: value => finish(value), reject: error => finish(undefined, error) })
      signal.addEventListener('abort', cancel, { once: true })
      void context.views.open(`${PLUGIN_ID}.editor`, { state: { ...state, agentSessionId: sessionId } }).catch(error => finish(undefined, error))
      if (signal.aborted) cancel()
    })
    signal.throwIfAborted()
    return session
  }
  const ensureSession = async (documentId: string, preferred: string | undefined, signal: AbortSignal): Promise<Session> => {
    const candidates = [...sessions.values()].filter(session => session.documentId === documentId).sort((a, b) => Number(b.sessionId === preferred) - Number(a.sessionId === preferred))
    for (const session of candidates) {
      try { await request(session, 'ping', {}, signal, 2000); return session }
      catch { signal.throwIfAborted(); sessions.delete(session.sessionId) }
    }
    return openView({ documentId }, signal)
  }
  const resolve = async (id: unknown, tool: AgentToolContext, sourceMessageId?: unknown): Promise<AgentReference> => {
    if (typeof id !== 'string') throw new Error('请先列出任务中的 Office 引用并使用返回的 referenceId。')
    if (sourceMessageId !== undefined && (typeof sourceMessageId !== 'string' || !sourceMessageId)) throw new Error('sourceMessageId 必须使用 references 返回的消息 ID。')
    const reference = await tool.references.resolve(id, typeof sourceMessageId === 'string' ? { sourceMessageId } : undefined)
    if (reference.locator?.version !== 1 && reference.locator?.version !== 2) throw new Error('此引用版本不受支持，请重新引用。')
    return reference
  }
  const assertTarget = async (input: Record<string, Json>, tool: AgentToolContext) => {
    const target = typeof input.targetId === 'string' ? targets.get(input.targetId) : undefined
    if (!target || target.expires < Date.now() || target.taskId !== tool.scope.taskId || target.branchId !== tool.scope.branchId || target.runId !== tool.scope.runId) throw new Error('文档目标已过期或不属于本次执行。请在当前执行中重新读取引用或打开文档 ID。')
    if (target.referenceId) {
      const source = await resolve(target.referenceId, tool, target.sourceMessageId)
      if (source.scope.taskId !== target.taskId || source.scope.branchId !== target.branchId || source.sourceMessageId !== target.sourceMessageId || (input.referenceId !== undefined && input.referenceId !== target.referenceId)) throw new Error('原引用的访问权限已变化。')
    }
    target.expires = Date.now() + 600000
    return target
  }
  const bind = (session: Session, result: Record<string, Json>, tool: AgentToolContext, source?: AgentReference, fallback?: OfficeEditorReference) => {
    tool.signal.throwIfAborted()
    if (typeof result.revision !== 'string') throw new Error('编辑器未返回有效文档版本。')
    const targetId = crypto.randomUUID()
    for (const [id, target] of targets) if (target.expires < Date.now()) targets.delete(id)
    while (targets.size >= 128) targets.delete(targets.keys().next().value!)
    const raw = object(result.reference)
    const reference = raw ? { ...raw, text: raw.text ?? fallback?.text ?? '' } as unknown as OfficeEditorReference : fallback
    targets.set(targetId, { ...session, ...(source ? { referenceId: source.referenceId, sourceMessageId: source.sourceMessageId } : {}), ...tool.scope, revision: result.revision, reference, expires: Date.now() + 600000 })
    const publicResult = { ...result }; delete publicResult.reference
    return { ok: true, documentId: session.documentId, targetId, ...(source ? { referenceId: source.referenceId, sourceMessageId: source.sourceMessageId } : {}), ...publicResult }
  }
  const documents = async () => {
    if (!library) throw new Error('文档库未初始化。')
    return (await library.execute('list') as unknown as { documents: OfficeDocument[] }).documents
  }
  const handle = (id: string, run: (input: Record<string, Json>, tool: AgentToolContext) => Promise<Json>) => {
    context.subscriptions.add(context.agent.registerTool(`${PLUGIN_ID}.${id}`, async (input, tool) => {
      try { tool.signal.throwIfAborted(); return await run(input, tool) }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }))
  }
  handle('capabilities', async (input, tool) => {
    if (input.targetId) {
      const target = await assertTarget(input, tool)
      return request(target, 'capabilities', { expectedRevision: target.revision }, tool.signal)
    }
    return { ok: true, formats: ['docx', 'xlsx', 'pptx', 'pdf'], skills: ['office', 'docx', 'xlsx', 'pptx', 'pdf'], entryPoints: { snapshot: 'lexora_reference_list → lexora_reference_read(sourceMessageId,kind,referenceId[,offset,limit])', reference: 'references → read(sourceMessageId,referenceId)（验证当前定位并绑定目标）', library: 'documents → read(documentId)', create: 'create(kind,name)' }, workflow: 'lexora_reference_read 读取不可变历史快照；read 读取当前文档并返回 targetId/revision，定位或原文改变时拒绝重新绑定。targetId 仅在当前执行有效，不跨轮次或子 Agent 复用。edit 使用 expectedRevision；自身修改后用 read(targetId) 继续读取最新文档，原引用仍是快照。export 发布任务产物；render 返回模型图片（以目标能力为准）。', tools: ['references', 'documents', 'create', 'read', 'edit', 'organize', 'render', 'export'], limits: { fileBytes: 67108864, retainedVersions: 12, targetLifetimeSeconds: 600 }, persistence: '本地文件编辑先应用到当前缓冲，edit(action=save) 才写回原件；Office 新建和导入的文档库文件自动保存。export 发布当前内容为任务产物，不改变原件保存状态。' }
  })
  handle('references', async (_input, tool) => {
    const result = await tool.references.list()
    return { ok: true, items: result.items.map(item => ({ referenceId: item.referenceId, sourceMessageId: item.sourceMessageId, title: item.title, excerpt: item.excerpt })), truncated: result.truncated }
  })
  handle('documents', async input => {
    const query = typeof input.query === 'string' ? input.query.toLocaleLowerCase() : ''
    const docs = (await documents()).filter(doc => (input.trash === true ? doc.trashedAt !== null : doc.trashedAt === null) && (!input.kind || doc.kind === input.kind) && (!query || doc.name.toLocaleLowerCase().includes(query)))
    return { ok: true, documents: docs.map(summary) }
  })
  handle('create', async (input, tool) => {
    if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(String(input.kind))) throw new Error('kind 必须是 docx、xlsx、pptx 或 pdf。')
    const name = fileName(input.name, input.kind as OfficeKind)
    const session = await openView({ create: { kind: input.kind, name } }, tool.signal)
    const result = object(await request(session, 'read', {}, tool.signal))
    if (!result) throw new Error('文件已创建，但读取失败。请先查询文档库，勿重复新建。')
    return bind(session, result, tool)
  })
  handle('read', async (input, tool) => {
    const query = object(input.query)
    const queryArgs: Record<string, Json> = query ? { query: { operation: typeof query.operation === 'string' ? query.operation : 'context', input: parameters(query.input) } } : {}
    if (input.targetId) {
      const target = await assertTarget(input, tool)
      const result = object(await request(target, 'read', { expectedRevision: target.revision, ...(target.reference ? { reference: compactOfficeReference(target.reference) as unknown as Json } : {}), ...queryArgs }, tool.signal))
      if (!result || result.revision !== target.revision) throw new Error('读取时文档版本变化。请重新打开最新文档目标。')
      if (object(result.reference)) target.reference = result.reference as unknown as OfficeEditorReference
      const publicResult = { ...result }; delete publicResult.reference
      return { ok: true, targetId: input.targetId, documentId: target.documentId, ...publicResult }
    }
    if (input.referenceId) {
      const source = await resolve(input.referenceId, tool, input.sourceMessageId)
      const locator = parseOfficeLocator(source.locator!.data as Json, source.text, source)
      if (locator.state === 'session' && sessions.get(locator.sessionId)?.documentId !== locator.documentId) throw new Error('未保存引用的编辑会话已关闭。请读取历史快照，或重新打开文档并引用。')
      const session = await ensureSession(locator.documentId, locator.sessionId, tool.signal)
      const result = object(await request(session, 'read', { ...(locator.state === 'saved' ? { documentVersion: locator.documentVersion } : { referenceState: 'session', referenceRevision: locator.revision ?? '' }), reference: compactOfficeReference(locator.reference) as unknown as Json, ...queryArgs }, tool.signal))
      if (!result) throw new Error('无法读取引用。')
      return bind(session, result, tool, source, locator.reference)
    }
    const doc = (await documents()).find(doc => doc.id === input.documentId && doc.trashedAt === null)
    if (!doc) throw new Error('请提供 references 返回的 referenceId、已有 targetId，或 documents 返回的 documentId。不要按名称猜测目标。')
    const session = await ensureSession(doc.id, undefined, tool.signal)
    const result = object(await request(session, 'read', { ...queryArgs }, tool.signal))
    if (!result) throw new Error('文档读取失败。')
    return bind(session, result, tool)
  })
  handle('edit', async (input, tool): Promise<Json> => {
    const target = await assertTarget(input, tool)
    if (target.revision !== input.expectedRevision) throw new Error('修改目标版本已变化。请使用最近一次读取或修改返回的 revision，勿重试旧修改。')
    if (typeof input.operation !== 'string') throw new Error('请使用 capabilities 或读取结果中公布的操作。')
    const args = { expectedRevision: target.revision, ...(target.reference ? { reference: compactOfficeReference(target.reference) as unknown as Json } : {}), action: input.operation, input: parameters(input.input) }
    let result: Record<string, Json> | null
    try {
      result = object(await request(target, 'edit', args, tool.signal))
      if (!result || typeof result.revision !== 'string' || typeof result.mutated !== 'boolean' || typeof result.saved !== 'boolean') throw new Error('编辑器未返回完整操作回执。')
    } catch (error) {
      targets.delete(String(input.targetId))
      return { ok: false, outcome: 'unknown', documentId: target.documentId, error: `${error instanceof Error ? error.message : String(error)} 请检查当前文档；此目标已撤回，不要重复执行修改。` }
    }
    target.revision = result.revision as string
    if (result.mutated === true) target.reference = undefined
    return { ok: true, targetId: input.targetId, documentId: target.documentId, ...result }
  })
  handle('organize', async (input, tool): Promise<Json> => {
    const actions = ['rename', 'favorite', 'trash', 'restore', 'duplicate', 'restoreVersion']
    if (input.action === 'versions') {
      const doc = (await documents()).find(doc => doc.id === input.documentId)
      if (!doc) throw new Error('文档不存在。')
      return { ok: true, ...summary(doc), versions: doc.versions.map(v => ({ id: v.id, createdAt: v.createdAt, label: v.label, size: v.file.size })) }
    }
    if (!actions.includes(String(input.action))) throw new Error('不支持此文档管理操作。永久删除请在文档库中操作。')
    const doc = (await documents()).find(doc => doc.id === input.documentId)
    if (!doc || doc.revision !== input.expectedRevision) throw new Error('文档库记录已变化，请重新查询 documents。')
    tool.signal.throwIfAborted()
    const result = await library!.execute(String(input.action), { id: doc.id, revision: doc.revision, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.value !== undefined ? { value: input.value } : {}), ...(input.versionId !== undefined ? { versionId: input.versionId } : {}) }) as unknown as OfficeDocument
    return { ok: true, document: summary(result) }
  })
  handle('render', async (input, tool) => {
    const target = await assertTarget(input, tool)
    const result = object(await request(target, 'render', { expectedRevision: target.revision, input: parameters(input.input) }, tool.signal, 45000))
    const images = Array.isArray(result?.images) ? result.images : []
    try {
      for (const image of images) {
        const resource = object(image)
        if (!resource || typeof resource.id !== 'string') throw new Error('渲染资源无效。')
        await tool.results.addImage({ resource: { id: resource.id } })
      }
      return { ok: true, targetId: input.targetId, revision: target.revision, images: images.map(image => { const r = object(image)!; return { name: r.name, mimeType: r.mimeType, size: r.size } }) }
    } finally {
      for (const image of images) { const resource = object(image); if (typeof resource?.id === 'string') await context.resources.release({ id: resource.id }).catch(() => {}) }
    }
  })
  handle('export', async (input, tool) => {
    const target = await assertTarget(input, tool)
    if (input.expectedRevision !== target.revision) throw new Error('导出版本已变化，请使用最新 revision。')
    const result = object(await request(target, 'export', { expectedRevision: target.revision }, tool.signal))
    const file = object(result?.file)
    if (!file || typeof file.id !== 'string' || typeof result?.revision !== 'string') throw new Error('文档未能导出。')
    target.revision = result.revision
    try {
      const artifact = await tool.artifacts.publish({ resource: { id: file.id }, name: fileName(input.name ?? file.name, result.kind as OfficeKind) })
      return { ok: true, targetId: input.targetId, revision: target.revision, documentVersion: result.documentVersion, artifact: { ...artifact } }
    } finally { await context.resources.release({ id: file.id }).catch(() => {}) }
  })
  context.signal.addEventListener('abort', () => {
    for (const item of [...pending.values()]) item.finish(undefined, new Error('Office 插件已停止。'))
    for (const item of [...ready.values()]) item.reject(new Error('Office 插件已停止。'))
    sessions.clear(); targets.clear()
  }, { once: true })
}
