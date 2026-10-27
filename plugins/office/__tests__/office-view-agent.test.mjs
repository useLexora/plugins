import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['src/office-view-agent.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { createOfficeViewAgent } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const host = await build({ stdin: { contents: `export { extensionReferenceInputSchema } from './apps/buddy/shared/extensions/extensionReferences.ts'; export { extensionJsonSchema } from './apps/buddy/shared/extensions/extensionApi.ts'`, resolveDir: repository }, bundle: true, write: false, format: 'esm', platform: 'node' })
const { extensionReferenceInputSchema, extensionJsonSchema } = await import(`data:text/javascript;base64,${Buffer.from(host.outputFiles[0].text).toString('base64')}`)

async function fixture() {
  let reveal
  let acceptReference = true
  let onMessage
  let reply
  let document = { id: 'document-a', name: 'Report.docx', kind: 'docx', version: 'content-v1' }
  let dirty = false
  let revision = 1
  let stale = false
  let save = async () => {}
  let checkpoint = async () => {}
  let nextRead
  let writes = 0
  let currentSession = 'session-a'
  const reference = { label: 'Report.docx · 段落', text: 'Same text in both documents', locator: { from: 1, to: 28 }, version: '1' }
  const captured = []
  const revealed = []
  let nextReveal
  const editor = { assistant: { read: async value => { await nextRead; return { reference: { ...reference, version: '2' }, text: reference.text, operations: ['replace_text'] } }, execute: async ({ input }, guard) => { guard.assertCurrent(); writes++; reference.text = input.text; revision++; dirty = true; return { text: reference.text, mutated: true } }, reveal: async reference => {
    revealed.push({ documentId: document.id, reference })
    return nextReveal ? nextReveal : true
  } } }
  let open = async () => {}
  const context = {
    signal: new AbortController().signal,
    commands: { execute: async (_command, message) => { extensionJsonSchema.parse(message); if (message.type === 'reply') reply(message); return null } },
    onMessage: callback => { onMessage = callback; return { dispose() {} } },
    references: { capture: async input => { if (!acceptReference) return null; captured.push(extensionReferenceInputSchema.parse(input)); return { id: crypto.randomUUID(), targets: [], defaultId: null, clipboard: true } }, onReveal: callback => { reveal = callback; return { dispose() {} } } },
  }
  const agent = createOfficeViewAgent(context, {
    editor: () => editor,
    document: () => document,
    open: id => open(id),
    revision: () => String(revision),
    dirty: () => dirty,
    save: () => save(),
    checkpoint: () => checkpoint(),
    export: async () => ({ id: crypto.randomUUID(), name: document.name, size: 1 }),
    checkStored: async () => { if (stale) throw new Error('stored version changed') },
  })
  await agent.register('session-a')
  const locate = (documentId, signal = new AbortController().signal) => reveal({ text: reference.text, locator: { version: 1, data: { documentId, documentVersion: 'content-v1', sessionId: 'old-session', reference } } }, signal)
  return {
    readBridge: (documentVersion = 'content-v1', target = false) => new Promise(resolve => { reply = resolve; onMessage(extensionJsonSchema.parse({ type: 'office-agent-request', sessionId: currentSession, documentId: 'document-a', ...(target ? { expectedRevision: '1' } : { documentVersion }), requestId: crypto.randomUUID(), operation: 'read', reference: { ...reference, text: '', textDigest: createHash('sha256').update(reference.text).digest('hex'), textLength: reference.text.length } })) }),
    editBridge: (expectedRevision, action, input = {}) => new Promise(resolve => { reply = resolve; onMessage(extensionJsonSchema.parse({ type: 'office-agent-request', sessionId: currentSession, documentId: 'document-a', requestId: crypto.randomUUID(), operation: 'edit', expectedRevision, action, input })) }),
    failSave: () => { save = async () => { throw new Error('disk full') } },
    writes: () => writes,
    deferCheckpoint: () => new Promise(resolve => { checkpoint = () => new Promise(finish => resolve(finish)) }),
    setLocal: () => { document = { ...document, local: { kind: 'file', writable: true } } },
    cancelReference: () => { acceptReference = false },
    agent, locate, revealed, captured, reference, revealCaptured: () => reveal({ text: captured.at(-1).text, locator: captured.at(-1).locator }, new AbortController().signal),
    staleStored: () => { stale = true },
    allowOpening: () => { open = async id => { stale = false; document = { ...document, id }; currentSession = `session-${id}`; await agent.register(currentSession) } },
    deferReveal: () => new Promise(resolve => { nextReveal = new Promise(finish => resolve(finish)) }),
    deferRead: () => new Promise(resolve => { nextRead = new Promise(finish => resolve(finish)) }),
    setDirty: value => { dirty = value; revision++ },
    setVersion: id => { document = { ...document, version: id }; revision++ },
    saveAsVersion: id => { save = async () => { document = { ...document, version: id }; dirty = false } },
    switchDocument: async id => { document = { ...document, id }; currentSession = `session-${id}`; await agent.register(currentSession) },
  }
}

test('取消切换或正在打开时，不向当前另一份文档传递引用定位', async () => {
  const f = await fixture()
  assert.equal(await f.locate('document-b'), false)
  assert.deepEqual(f.revealed, [])
  f.allowOpening()
  assert.equal(await f.locate('document-b'), true)
  assert.equal(f.revealed[0].documentId, 'document-b')
})

test('引用定位结束前切换编辑会话，旧结果失效', async () => {
  const f = await fixture()
  const finish = await f.deferReveal()
  const locating = f.locate('document-a')
  await f.switchDocument('document-b')
  finish(true)
  assert.equal(await locating, false)
})

test('引用定位完成前取消，不报告定位成功', async () => {
  const f = await fixture()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.locate('document-a', abort.signal), { name: 'AbortError' })
  assert.deepEqual(f.revealed, [])
  const controller = new AbortController()
  const finish = await f.deferReveal()
  const locating = f.locate('document-a', controller.signal)
  controller.abort()
  finish(true)
  await assert.rejects(locating, { name: 'AbortError' })
})

test('长引用符合宿主定位大小契约，定位恢复完整原文并复用已有文件标题', async () => {
  const f = await fixture()
  f.reference.text = '字'.repeat(262144)
  await f.agent.capture(f.reference)
  assert.equal(f.captured[0].text, f.reference.text)
  assert.equal(f.captured[0].title, 'Report.docx · 段落')
  assert.ok(Buffer.byteLength(JSON.stringify(f.captured[0].locator)) < 1024)
  assert.equal(await f.revealCaptured(), true)
  assert.equal(f.revealed[0].reference.text, f.reference.text)
  assert.equal(f.revealed[0].reference.version, '1')
  f.reference.label = 'Sheet1!A1:B3'
  await f.agent.capture(f.reference)
  assert.equal(f.captured[1].title, 'Report.docx · Sheet1!A1:B3')
})

test('24k 中文和最坏转义文本的内部 read 往返均符合宿主 256KB 限额', async () => {
  for (const text of ['字'.repeat(24000), 'a' + String.fromCharCode(1).repeat(23999)]) {
    const f = await fixture()
    f.reference.text = text
    await f.agent.capture(f.reference)
    const reply = await f.readBridge()
    assert.equal(reply.value.text, text)
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 160000)
    assert.equal(reply.value.reference.version, '2')
  }
})

test('其它内容保存后旧引用仍可验证定位，未保存编辑可读取当前缓冲区', async () => {
  const f = await fixture()
  f.setVersion('content-v2')
  const current = (await f.readBridge()).value
  assert.equal(current.documentVersion, 'content-v2')
  assert.equal(current.contentState, 'current')
  assert.equal(current.referenceDocumentVersion, 'content-v1')
  assert.equal(current.sourceChangedSinceReference, true)
  assert.equal(await f.locate('document-a'), true)
  f.setDirty(true)
  assert.equal((await f.readBridge()).value.dirty, true)
  assert.equal(await f.locate('document-a'), true)
})

test('保存失败仍能引用未保存快照，关闭会话后不把旧磁盘内容当原文', async () => {
  const f = await fixture()
  f.setDirty(true)
  f.failSave()
  await f.agent.capture(f.reference)
  assert.equal(f.captured[0].locator.version, 2)
  assert.equal(f.captured[0].locator.data.state, 'session')
  assert.equal(f.captured[0].locator.data.documentVersion, 'content-v1')
  assert.equal(await f.revealCaptured(), true)
  f.agent.close()
  await f.switchDocument('document-a')
  await assert.rejects(f.revealCaptured(), /会话已关闭/)
})

test('异步读取或定位期间新增手改，不能接受旧引用结果', async () => {
  const f = await fixture()
  const finishRead = await f.deferRead()
  const reading = f.readBridge()
  await new Promise(resolve => setTimeout(resolve, 0))
  f.setDirty(true)
  finishRead()
  assert.match((await reading).error, /文档已变化/)
  f.setDirty(false)
  const finishReveal = await f.deferReveal()
  const revealing = f.locate('document-a')
  await new Promise(resolve => setTimeout(resolve, 0))
  f.setVersion('content-v2')
  finishReveal(true)
  await assert.rejects(revealing, /文档已变化/)
})

test('生成引用期间出现新修改不发布过时的定位', async () => {
  const f = await fixture()
  f.saveAsVersion('content-v2')
  const finish = await f.deferRead()
  const capturing = f.agent.capture(f.reference)
  await new Promise(resolve => setTimeout(resolve, 0))
  f.setDirty(true)
  finish()
  await assert.rejects(capturing, /重新选择并引用/)
  assert.deepEqual(f.captured, [])
})


test('长引用只在宿主保存正文，连续目标用全文摘要校验且有界截断上下文', async () => {
  const f = await fixture()
  f.reference.text = 'a' + String.fromCharCode(1).repeat(262143)
  const reply = await f.readBridge(undefined, true)
  assert.equal(reply.error, undefined)
  assert.equal(reply.value.reference.text, '')
  assert.equal(reply.value.reference.textLength, 262144)
  assert.equal(reply.value.reference.textDigest, createHash('sha256').update(f.reference.text).digest('hex'))
  assert.equal(reply.value.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 240 * 1024)
})

test('同文档另一页面已保存时，干净回源重开最新后验证，未保存内容不被覆盖', async () => {
  const f = await fixture()
  f.allowOpening();f.staleStored()
  assert.equal(await f.locate('document-a'),true)
  f.staleStored();f.setDirty(true)
  assert.equal(await f.locate('document-a'),true)
  assert.equal(f.revealed.length,2)
})


test('引用捕获固定正文与位置，解析等待期间不能静默替换用户选区', async () => {
  for (const change of [reference => { reference.text = 'Changed after capture' }, reference => { reference.locator.to = 29 }]) {
    const f = await fixture()
    const finish = await f.deferRead()
    const capturing = f.agent.capture(f.reference)
    await new Promise(resolve => setTimeout(resolve, 0))
    change(f.reference)
    finish()
    await assert.rejects(capturing, /变化|定位/)
    assert.deepEqual(f.captured, [])
  }
})


test('编辑后保存失败返回已执行的新修订，旧请求拒绝，补保存不再次修改', async () => {
  const f = await fixture()
  f.failSave()
  const changed = await f.editBridge('1', 'replace_text', { text: 'Applied exactly once' })
  assert.deepEqual(changed.value, { text: 'Applied exactly once', mutated: true, revision: '2', saved: false, saveError: 'disk full' })
  const repeated = await f.editBridge('1', 'replace_text', { text: 'Must not replay' })
  assert.match(repeated.error, /其他操作修改/)
  assert.equal(f.reference.text, 'Applied exactly once')
  f.saveAsVersion('content-v2')
  const saved = await f.editBridge('2', 'save')
  assert.deepEqual(saved.value, { text: '保存文档', mutated: false, revision: '2', documentVersion: 'content-v2', saved: true })
  assert.equal(f.writes(), 1)
})


test('宿主来源失效时捕获返回空结果，不产生引用快照', async () => {
  const f = await fixture()
  f.cancelReference()
  assert.equal(await f.agent.capture(f.reference), null)
  assert.deepEqual(f.captured, [])
})


test('视觉与多区域 locator 转成独立 JSON 树，保持宿主的无循环快照契约', async () => {
  const f = await fixture()
  const rect = [0, 0, 100, 200]
  f.reference.locator = { kind: 'visual', rects: [rect], regions: [{ pageId: '5:0', rects: [rect] }] }
  await f.agent.capture(f.reference)
  assert.deepEqual(JSON.parse(JSON.stringify(f.captured[0].locator.data.reference.locator)), f.reference.locator)
  rect[0] = 10
  assert.equal(f.captured[0].locator.data.reference.locator.rects[0][0], 0)
})

 test('本地文件 AI 修改只改变缓冲区，显式保存后才报告已落盘', async () => {
 const f = await fixture()
 f.setLocal()
 f.failSave()
 const edited = await f.editBridge('1', 'replace_text', { text: 'unsaved buffer' })
 assert.equal(edited.value.mutated, true)
 assert.equal(edited.value.saved, false)
 assert.equal(edited.value.dirty, true)
 assert.equal(edited.value.saveError, undefined)
 const failed = await f.editBridge('2', 'save')
 assert.equal(failed.value.saved, false)
 assert.match(failed.value.saveError, /disk full/)
 assert.equal(f.writes(), 1)
 f.saveAsVersion('content-v2')
 const saved = await f.editBridge('2', 'save')
 assert.equal(saved.value.saved, true)
 assert.equal(saved.value.documentVersion, 'content-v2')
 })

test('记录 AI 恢复草稿期间的用户修改不能被当成本次操作的新目标', async () => {
 const f = await fixture()
 f.setLocal()
 const ready = f.deferCheckpoint()
 const editing = f.editBridge('1', 'replace_text', { text: 'AI change' })
 const finish = await ready
 f.setDirty(true)
 finish()
 assert.match((await editing).error, /期间文档被修改/)
 assert.equal(f.writes(), 1)
})
