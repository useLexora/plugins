import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/office-agent.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { registerOfficeAgent, OFFICE_BRIDGE, parseOfficeLocator } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const id = 'pa99d3189286f4fa191b597bd1a1f227d.genoffice-xlsx'
function fixture(compact = false, text = 'before') {
  const tools = new Map(), commands = new Map(), messages = [], views = new Map()
  const lifetime = new AbortController()
  let allowed = true
  let scope = { taskId: 'task-a', branchId: 'branch-a', runId: 'run-a' }
  let latestMessageId = 'message-a'
  const resolutions = []
  const reference = { label: '段落', text, locator: { from: 1, to: 7 }, version: 'v1' }
  registerOfficeAgent({ signal: lifetime.signal, commands: { register(name, callback) { commands.set(name, callback); return { dispose() {} } } }, agent: { registerTool(name, callback) { tools.set(name, callback); return { dispose() {} } } }, subscriptions: { add() {} }, views: {
    async broadcast(message) { messages.push(message); await views.get(message.sessionId)?.(message) },
    async open(_type, { state }) { await connect(state.agentSessionId, state.documentId); return state.agentSessionId },
  } })
  const bridge = message => commands.get(OFFICE_BRIDGE)({ arguments: message })
  async function connect(sessionId, documentId) {
    let revision = 1
    views.set(sessionId, async message => {
      if (message.type !== 'office-agent-request') return
      const { text, ...location } = reference
      if (message.operation === 'edit') revision++
      const value = message.operation === 'read' ? { revision: `${sessionId}:${revision}`, text, operations: ['replace_text'], reference: compact ? location : reference } : message.operation === 'edit' ? { revision: `${sessionId}:${revision}`, text: 'after', mutated: true, saved: true } : { ready: true }
      bridge({ type: 'reply', sessionId, requestId: message.requestId, value })
    })
    await bridge({ type: 'ready', sessionId, documentId })
  }
  const toolContext = signal => ({ signal, scope, references: { list: async () => ({ items: [{ referenceId: 'quote-a', sourceMessageId: latestMessageId, title: 'A', excerpt: 'before' }], truncated: false }), resolve: async (referenceId, options) => {
    const sourceMessageId = options?.sourceMessageId ?? latestMessageId
    resolutions.push({ referenceId, sourceMessageId })
    if (!options?.sourceMessageId && latestMessageId !== 'message-a') throw Error('EXTENSION_REFERENCE_AMBIGUOUS')
    if (!['message-a', latestMessageId].includes(sourceMessageId)) throw Error('REFERENCE_DENIED')
    if (!allowed || referenceId !== 'quote-a') throw Error('REFERENCE_DENIED')
    const { text, ...location } = reference
    return { referenceId, sourceMessageId, title: 'A', text: text.slice(0, 32768), textLength: text.length, textDigest: createHash('sha256').update(text).digest('hex'), offset: 0, nextOffset: text.length > 32768 ? 32768 : null, scope, locator: { version: 1, data: { documentId: 'doc-a', documentVersion: 'content-v1', sessionId: 'session-a', reference: compact ? location : reference } } }
  } } })
  const call = (tool, input, signal = new AbortController().signal) => tools.get(`${id}.${tool}`)(input, toolContext(signal))
  return { connect, bridge, messages, views, call, lifetime, resolutions, nextMessage: () => { latestMessageId = 'message-b' }, run: id => { scope = { ...scope, runId: id } }, revoke: () => { allowed = false }, branch: () => { scope = { ...scope, branchId: 'branch-b' } } }
}
test('引用绑定文档A，打开B不改变读取和写入目标，旧修订与旁支不能复用目标', async () => {
  const x = fixture()
  await x.connect('session-a', 'doc-a'); await x.connect('session-b', 'doc-b')
  const read = await x.call('read', { referenceId: 'quote-a' })
  assert.equal(read.ok, true); assert.equal('reference' in read, false)
  const changed = await x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: read.revision, operation: 'replace_text', input: '{"text":"after"}' })
  assert.equal(changed.saved, true)
  assert.equal(x.messages.filter(message => message.operation === 'edit')[0].sessionId, 'session-a')
  const stale = await x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: read.revision, operation: 'replace_text' })
  assert.equal(stale.ok, false)
  x.branch()
  const other = await x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: changed.revision, operation: 'undo' })
  assert.equal(other.ok, false)
  x.lifetime.abort()
})
test('引用撤回和编辑器关闭使目标失效，未打开的文档按库ID恢复', async () => {
  const x = fixture()
  const read = await x.call('read', { referenceId: 'quote-a' })
  assert.equal(read.ok, true)
  const session = x.messages.find(message => message.operation === 'read').sessionId
  await x.bridge({ type: 'closed', sessionId: session })
  const closed = await x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: read.revision, operation: 'undo' })
  assert.equal(closed.ok, false)
  x.revoke()
  assert.equal((await x.call('read', { referenceId: 'quote-a' })).ok, false)
  x.lifetime.abort()
})
test('取消等待的编辑请求发送同一request取消消息，晚回复不会触发重试', async () => {
  const x = fixture(); await x.connect('session-a', 'doc-a')
  const read = await x.call('read', { referenceId: 'quote-a' })
  x.views.set('session-a', async () => {})
  const abort = new AbortController()
  const editing = x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: read.revision, operation: 'undo' }, abort.signal)
  await new Promise(resolve => setTimeout(resolve, 0)); abort.abort()
  const result = await editing
  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'unknown')
  assert.equal((await x.call('read', { targetId: read.targetId })).ok, false)
  const writes = x.messages.filter(message => message.operation === 'edit')
  assert.equal(writes.length, 1)
  assert.ok(x.messages.some(message => message.type === 'office-agent-cancel' && message.requestId === writes[0].requestId))
  x.lifetime.abort()
})

test('紧凑定位使用宿主引用原文恢复目标，同时兼容旧引用', async () => {
  const text = '字'.repeat(24000)
  const x = fixture(true, text)
  const read = await x.call('read', { referenceId: 'quote-a' })
  assert.equal(read.ok, true)
  assert.equal(read.text, text)
  assert.equal(x.messages.find(message => message.operation === 'read').reference.text, '')
  assert.equal(x.messages.find(message => message.operation === 'read').reference.textDigest, createHash('sha256').update(text).digest('hex'))
  assert.equal(x.messages.find(message => message.operation === 'read').documentVersion, 'content-v1')
  const edited = await x.call('edit', { referenceId: 'quote-a', targetId: read.targetId, expectedRevision: read.revision, operation: 'replace_text', input: '{"text":"new"}' })
  assert.equal(edited.ok, true)
  assert.equal(x.messages.find(message => message.operation === 'edit').reference.text, '')
  const legacy = { documentId: 'doc-a', documentVersion: 'content-v1', sessionId: 'session-a', reference: { label: '段落', text: 'legacy', locator: { from: 1, to: 7 }, version: '1' } }
  assert.equal(parseOfficeLocator(legacy).reference.text, 'legacy')
  const { documentVersion: _version, ...unversioned } = legacy
  assert.throws(() => parseOfficeLocator(unversioned, 'host snapshot'), /重新引用/)
  assert.equal(parseOfficeLocator(legacy, 'host snapshot').reference.text, 'host snapshot')
  x.lifetime.abort()
})


test('同一个目标在自身修改后连续读写，保持原引用鉴权但不重放旧选区', async () => {
  const x = fixture(); await x.connect('session-a', 'doc-a')
  const first = await x.call('read', { referenceId: 'quote-a' })
  const edit = await x.call('edit', { targetId: first.targetId, expectedRevision: first.revision, operation: 'replace_text', input: { text: 'after' } })
  assert.equal(edit.saved, true)
  const read = await x.call('read', { targetId: first.targetId, query: { operation: 'context' } })
  assert.equal(read.ok, true)
  assert.equal(read.revision, edit.revision)
  const request = x.messages.filter(message => message.operation === 'read').at(-1)
  assert.equal(request.expectedRevision, edit.revision)
  assert.equal('documentVersion' in request, false)
  assert.equal('reference' in request, false)
  x.revoke()
  assert.equal((await x.call('read', { targetId: first.targetId })).ok, false)
  x.lifetime.abort()
})

test('长快照resolve第一页不能当全文，传给编辑器的是宿主全文摘要和长度', async () => {
  const text = '中\u0001'.repeat(131072)
  const x = fixture(true, text)
  const read = await x.call('read', { referenceId: 'quote-a' })
  assert.equal(read.ok, true)
  const message = x.messages.find(value => value.operation === 'read')
  assert.equal(message.reference.text, '')
  assert.equal(message.reference.textLength, text.length)
  assert.equal(message.reference.textDigest, createHash('sha256').update(text).digest('hex'))
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 2048)
  x.lifetime.abort()
})


test('目标只属于本次执行：同分支下一轮或子执行必须重新读取', async () => {
  const x = fixture()
  const first = await x.call('read', { referenceId: 'quote-a', sourceMessageId: 'message-a' })
  for (const runId of ['run-next', 'run-child']) {
    x.run(runId)
    assert.equal((await x.call('read', { targetId: first.targetId })).ok, false)
    assert.equal((await x.call('edit', { targetId: first.targetId, expectedRevision: first.revision, operation: 'undo' })).ok, false)
    const own = await x.call('read', { referenceId: 'quote-a', sourceMessageId: 'message-a' })
    assert.equal(own.ok, true)
    assert.notEqual(own.targetId, first.targetId)
  }
  assert.equal(x.messages.filter(message => message.operation === 'edit').length, 0)
  x.lifetime.abort()
})

test('跨消息重用引用 ID 不改变已绑定目标，精确消息身份贯穿后续鉴权', async () => {
  const x = fixture()
  const listed = await x.call('references', {})
  assert.equal(listed.items[0].sourceMessageId, 'message-a')
  const first = await x.call('read', { referenceId: 'quote-a', sourceMessageId: 'message-a' })
  assert.equal(first.sourceMessageId, 'message-a')
  x.nextMessage()
  const ambiguous = await x.call('read', { referenceId: 'quote-a' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /AMBIGUOUS/)
  assert.equal((await x.call('read', { targetId: first.targetId })).ok, true)
  assert.deepEqual(x.resolutions.at(-1), { referenceId: 'quote-a', sourceMessageId: 'message-a' })
  const second = await x.call('read', { referenceId: 'quote-a', sourceMessageId: 'message-b' })
  assert.equal(second.sourceMessageId, 'message-b')
  x.lifetime.abort()
})

test('已修改但未保存保留新 revision，只补保存不重复原修改', async () => {
  const x = fixture(); await x.connect('session-a', 'doc-a')
  const first = await x.call('read', { referenceId: 'quote-a' })
  x.views.set('session-a', async message => {
    if (message.operation !== 'edit') return
    await x.bridge({ type: 'reply', sessionId: 'session-a', requestId: message.requestId, value: { revision: 'session-a:2', mutated: message.action !== 'save', saved: message.action === 'save', ...(message.action === 'save' ? {} : { saveError: 'disk full' }) } })
  })
  const changed = await x.call('edit', { targetId: first.targetId, expectedRevision: first.revision, operation: 'replace_text', input: { text: 'after' } })
  assert.equal(changed.ok, true); assert.equal(changed.mutated, true); assert.equal(changed.saved, false)
  assert.equal((await x.call('edit', { targetId: first.targetId, expectedRevision: first.revision, operation: 'replace_text', input: { text: 'after' } })).ok, false)
  const saved = await x.call('edit', { targetId: first.targetId, expectedRevision: changed.revision, operation: 'save' })
  assert.equal(saved.saved, true); assert.equal(saved.mutated, false)
  const writes = x.messages.filter(message => message.operation === 'edit')
  assert.deepEqual(writes.map(message => message.action), ['replace_text', 'save'])
  assert.equal('reference' in writes[1], false)
  x.lifetime.abort()
})

test('缺失完整写回回执时撤回目标，不能在不确定结果上继续修改', async () => {
  const x = fixture(); await x.connect('session-a', 'doc-a')
  const first = await x.call('read', { referenceId: 'quote-a' })
  x.views.set('session-a', async message => {
    await x.bridge({ type: 'reply', sessionId: 'session-a', requestId: message.requestId, value: { revision: 'session-a:2', mutated: true } })
  })
  const changed = await x.call('edit', { targetId: first.targetId, expectedRevision: first.revision, operation: 'undo' })
  assert.equal(changed.ok, false); assert.equal(changed.outcome, 'unknown')
  assert.equal((await x.call('edit', { targetId: first.targetId, expectedRevision: 'session-a:2', operation: 'undo' })).ok, false)
  assert.equal(x.messages.filter(message => message.operation === 'edit').length, 1)
  x.lifetime.abort()
})
