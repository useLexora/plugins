import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/office-library.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { OfficeLibraryService, readLibrary, fileName } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
function setup() {
  let stored = null
  let failing = false
  const released = []
  const files = Array.from({ length: 20 }, (_, i) => ({ id: `file-${i}`, name: '项目.xlsx', mimeType: 'application/octet-stream', size: 300 + i }))
  const ports = { get: async () => structuredClone(stored), set: async value => { if (failing) throw Error('disk full'); stored = structuredClone(value) }, files: async () => files, release: async file => released.push(file.id), publish: async () => {} }
  const service = new OfficeLibraryService(ports)
  return { service, files, released, restart: () => new OfficeLibraryService(ports), data: () => stored, fail: value => { failing = value } }
}
test('导入、重命名、收藏、回收站和恢复保持文件内容与历史', async () => {
  const x = setup()
  let doc = await x.service.execute('add', { resourceId: 'file-0' })
  doc = await x.service.execute('rename', { id: doc.id, name: '中文预算' })
  assert.equal(doc.name, '中文预算.xlsx')
  doc = await x.service.execute('favorite', { id: doc.id, value: true })
  assert.equal(doc.favorite, true)
  doc = await x.service.execute('trash', { id: doc.id })
  assert.ok(doc.trashedAt)
  await assert.rejects(x.service.execute('save', { id: doc.id, revision: doc.revision, resourceId: 'file-1' }), /回收站/)
  doc = await x.service.execute('restore', { id: doc.id })
  assert.equal(doc.trashedAt, null)
  assert.equal(doc.versions[0].file.id, 'file-0')
  assert.deepEqual(x.released, [])
})
test('并发保存拒绝旧 revision，不覆盖较新内容', async () => {
  const x = setup(); const doc = await x.service.execute('add', { resourceId: 'file-0' })
  const results = await Promise.allSettled([1, 2].map(n => x.service.execute('save', { id: doc.id, revision: 1, resourceId: `file-${n}` })))
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  assert.equal(x.data().documents[0].versions[0].file.id, 'file-1')
  assert.equal(x.data().documents[0].revision, 2)
})
test('索引落盘失败保留原版本且不释放现有内容', async () => {
  const x = setup(); const doc = await x.service.execute('add', { resourceId: 'file-0' }); const before = structuredClone(x.data())
  x.fail(true)
  await assert.rejects(x.service.execute('save', { id: doc.id, revision: 1, resourceId: 'file-1' }), /disk full/)
  assert.deepEqual(x.data(), before); assert.deepEqual(x.released, [])
})
test('复制文档引用的版本不随源文档淘汰或删除释放', async () => {
  const x = setup(); let doc = await x.service.execute('add', { resourceId: 'file-0' })
  const copy = await x.service.execute('duplicate', { id: doc.id })
  for (let n = 1; n < 15; n++) doc = await x.service.execute('save', { id: doc.id, revision: doc.revision, resourceId: `file-${n}` })
  assert.equal(doc.versions.length, 12)
  assert.equal(x.released.includes('file-0'), false)
  doc = await x.service.execute('trash', { id: doc.id })
  await x.service.execute('delete', { id: doc.id, revision: doc.revision })
  assert.equal(x.released.includes('file-0'), false)
  assert.equal(x.data().documents[0].id, copy.id)
})
test('恢复历史创建新 revision，保留当前内容供撤回', async () => {
  const x = setup(); let doc = await x.service.execute('add', { resourceId: 'file-0' })
  const initial = doc.versions[0].id
  doc = await x.service.execute('save', { id: doc.id, revision: 1, resourceId: 'file-1' })
  doc = await x.service.execute('restoreVersion', { id: doc.id, revision: 2, versionId: initial })
  assert.equal(doc.revision, 3); assert.equal(doc.versions[0].file.id, 'file-0'); assert.equal(doc.versions[1].file.id, 'file-1')
})
test('错误索引不自动清空，拒绝非法名称和未授权资源', async () => {
  assert.deepEqual(readLibrary({}), { schema: 1, documents: [] })
  assert.throws(() => readLibrary({ schema: 2, documents: [] }), /格式/)
  assert.throws(() => fileName('../secret', 'docx'), /名称/)
  const x = setup(); await assert.rejects(x.service.execute('add', { resourceId: 'other-plugin-file' }), /授权/)
  assert.equal(x.data(), null)
})

test('签名偏好和文档索引串行保存，互不覆盖且有界', async () => {
  const x = setup()
  const [doc] = await Promise.all([x.service.execute('add', {resourceId:'file-0'}), x.service.execute('preferences.set', {key:'pdfSignatures', value:[{id:'signature',name:'验收签名'}]})])
  assert.equal(x.data().documents[0].id, doc.id)
  assert.deepEqual(await x.service.execute('preferences.get',{key:'pdfSignatures'}), [{id:'signature',name:'验收签名'}])
  await assert.rejects(x.service.execute('preferences.set',{key:'pdfSignatures',value:'x'.repeat(70000)}), /64 KB/)
})

test('同一产物重复打开复用记录，并发导入也不制造副本；显式复制独立于来源', async () => {
  const x = setup()
  const sourceId = 'a'.repeat(64), sourceHash = 'b'.repeat(64)
  const [first, second] = await Promise.all([0, 1].map(index => x.service.execute('add', { resourceId: `file-${index}`, sourceId, sourceHash })))
  assert.equal(first.id, second.id)
  assert.equal(x.data().documents.length, 1)
  assert.deepEqual(x.released, ['file-1'])
  const copy = await x.service.execute('duplicate', { id: first.id })
  assert.equal(copy.sourceId, undefined)
  const original = await x.service.execute('add', { resourceId: 'file-2', sourceId, sourceHash })
  assert.equal(original.id, first.id)
  assert.equal(x.data().documents.length, 2)
  const sameName = await x.service.execute('add', { resourceId: 'file-3', sourceId: 'c'.repeat(64), sourceHash })
  assert.notEqual(sameName.id, first.id)
  const legacyImport = await x.service.execute('add', { resourceId: 'file-4' })
  assert.notEqual(legacyImport.id, first.id)
  await x.service.execute('trash', { id: first.id })
  await assert.rejects(x.service.execute('add', { resourceId: 'file-5', sourceId, sourceHash }), /回收站/)
  assert.equal(x.data().documents.length, 4)
})


test('重启后相同来源复用已编辑版本，来源变化与同内容不同身份不自动覆盖合并', async () => {
  const x = setup()
  const sourceId = 'a'.repeat(64), sourceHash = 'b'.repeat(64)
  const imported = await x.service.execute('add', { resourceId: 'file-0', sourceId, sourceHash })
  const edited = await x.service.execute('save', { id: imported.id, revision: imported.revision, resourceId: 'file-1' })
  const restarted = x.restart()
  const reopened = await restarted.execute('add', { resourceId: 'file-2', sourceId, sourceHash: 'c'.repeat(64) })
  assert.equal(reopened.id, imported.id)
  assert.equal(reopened.revision, edited.revision)
  assert.equal(reopened.versions[0].file.id, 'file-1')
  assert.equal(reopened.sourceHash, sourceHash)
  assert.equal(x.data().documents.length, 1)
  assert.deepEqual(x.released, ['file-2'])
  const another = await restarted.execute('add', { resourceId: 'file-3', sourceId: 'd'.repeat(64), sourceHash })
  assert.notEqual(another.id, imported.id)
  assert.equal(x.data().documents.length, 2)
})
