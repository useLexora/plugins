import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { activateManager } from '../manager.js'

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await readFile(new URL('../resources.json', import.meta.url)))
const revision = 'a'.repeat(40)
const wrongHash = 'b'.repeat(64)
const correctHash = 'c'.repeat(64)
const engine = { id: 'llama-b11747', kind: 'engine', revision: 'engine-revision', authorized: true }
const file = rfilename => ({ rfilename, size: 32 * 1024 ** 2 })
const metadata = (siblings = [file('model.gguf')], pipeline_tag = 'text-generation') => ({ id: 'example/repair', sha: revision, pipeline_tag, siblings })

async function fixture({ stored = { models: { unrelated: { threads: 7 } } }, data = metadata(), resources = [engine] } = {}) {
  let saved = structuredClone(stored)
  const commands = new Map(), bindings = new Map(), sets = structuredClone(resources), runtimes = [], writes = [], prepared = [], removed = []
  const behavior = { failSave: false, failPrepare: false }
  const execute = (name, input) => commands.get(`test.local-models.${name}`)({ arguments: input })
  const context = {
    signal: new AbortController().signal,
    storage: {
      get: async () => structuredClone(saved),
      set: async value => {
        if (behavior.failSave) throw Error('disk full')
        saved = structuredClone(value)
        writes.push(structuredClone(value))
      },
    },
    views: { broadcast: async () => {} },
    commands: { register: (name, handler) => { commands.set(name, handler); return () => {} } },
    subscriptions: { add() {} },
    network: {
      get: async () => { throw Error('本测试不需要列表请求') },
      download: async address => {
        const url = new URL(address)
        assert.equal(url.origin, 'https://huggingface.co')
        assert.ok(url.pathname.startsWith('/api/models/'), '不得下载真实模型权重')
        const bytes = Buffer.from(JSON.stringify(data))
        return { bytes, size: bytes.length }
      },
    },
    resources: {
      readBytes: async (resource, { offset, length }) => ({ data: resource.bytes.subarray(offset, offset + length), eof: offset + length >= resource.bytes.length }),
      release: async () => {},
    },
    inference: {
      capabilities: { runtimeIsolation: true, chatImageInput: true, chatToolMatching: true },
      status: async () => {
        const states = new Map([...bindings.keys()].map(runtime => [runtime, { runtime, configured: true, instances: [] }]))
        for (const state of runtimes) states.set(state.runtime, state)
        return [...states.values()]
      },
      credentials: { has: async () => false },
      bind: async binding => { bindings.set(binding.runtime, structuredClone(binding)) },
      unbind: async ({ runtime }) => { bindings.delete(runtime) },
      stop: async ({ runtime }) => { for (const item of runtimes) if (item.runtime === runtime) item.instances = [] },
      resources: {
        list: async () => sets,
        prepare: async spec => {
          prepared.push(structuredClone(spec))
          if (behavior.failPrepare) throw Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
          const resource = { id: spec.id, kind: spec.kind, revision: `prepared-${prepared.length}`, authorized: true }
          sets.push(resource)
          return resource
        },
        remove: async target => { removed.push(structuredClone(target)); const index = sets.findIndex(item => item.id === target.id && item.revision === target.revision); if (index >= 0) sets.splice(index, 1) },
      },
    },
  }
  await activateManager(context, { manifest: { id: 'test.local-models' }, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  const detail = await execute('inspect-model', { repository: data.id, revision })
  assert.equal(detail.unavailableReason, null)
  const selection = Object.fromEntries(detail.roles.filter(role => !role.optional).map(role => [role.id, role.choices[0].path]))
  const input = { key: detail.key, selection, title: '保留的模型名称', mode: 'download' }
  const add = checksum => execute('add-model', { ...input, checksums: Object.fromEntries(data.siblings.map(file => [file.rfilename, checksum])) })
  return { execute, input, add, behavior, bindings, sets, runtimes, writes, prepared, removed, saved: () => saved }
}

async function seeded(data = metadata()) {
  const initial = await fixture({ data })
  const added = await initial.add(wrongHash)
  assert.equal(added.ok, true)
  const stored = structuredClone(initial.saved())
  const runtime = stored.custom[0].model.runtime
  stored.active[runtime] = added.modelId
  stored.models[added.modelId] = { ...stored.models[added.modelId], threads: 6, futureSetting: 'retain' }
  return { stored, modelId: added.modelId, resourceId: stored.custom[0].specification.id, runtime }
}

const currentSpec = (state, id) => state.specifications.find(spec => spec.id === id)

test('错误校验导致下载失败后可原身份更正，保存新规范并让重试绑定新资源', async () => {
  const seed = await seeded()
  const f = await fixture({ stored: seed.stored })
  f.behavior.failPrepare = true
  const failed = await f.execute('prepare', { modelId: seed.modelId, scope: 'model' })
  assert.match(failed.error, /文件校验失败/)
  assert.equal(f.prepared[0].files[0].sha256, wrongHash)
  const oldModel = structuredClone(f.saved().custom[0].model)
  const oldSettings = structuredClone(f.saved().models)
  const oldActive = structuredClone(f.saved().active)
  assert.deepEqual(await f.add(correctHash), { ok: true, modelId: seed.modelId })
  assert.equal(f.saved().custom.length, 1)
  assert.deepEqual(f.saved().custom[0].model, oldModel)
  assert.deepEqual(f.saved().models, oldSettings)
  assert.deepEqual(f.saved().active, oldActive)
  assert.equal(f.saved().custom[0].specification.files[0].sha256, correctHash)
  assert.equal(currentSpec(await f.execute('status'), seed.resourceId).files[0].sha256, correctHash)
  f.behavior.failPrepare = false
  assert.equal((await f.execute('prepare', { modelId: seed.modelId, scope: 'model' })).ok, true)
  assert.equal(f.prepared[1].files[0].sha256, correctHash)
  assert.equal(f.bindings.get('chat').configuration.threads, 6)
  assert.deepEqual(f.bindings.get('chat').resources, [{ mount: 'engine', id: engine.id, revision: engine.revision }, { mount: 'model', id: seed.resourceId, revision: 'prepared-2' }])
  assert.deepEqual(f.removed, [])
  const restarted = await fixture({ stored: f.saved(), resources: f.sets })
  const state = await restarted.execute('status')
  assert.equal(state.models.find(model => model.id === seed.modelId).active, true)
  assert.equal(currentSpec(state, seed.resourceId).files[0].sha256, correctHash)
  assert.equal(restarted.saved().models[seed.modelId].futureSetting, 'retain')
})

test('保存更正失败时持久记录、内存规范、参数和启用状态均保留，随后可重试', async () => {
  const seed = await seeded()
  const f = await fixture({ stored: seed.stored })
  const before = structuredClone(f.saved())
  f.behavior.failSave = true
  await assert.rejects(f.add(correctHash), /disk full/)
  assert.deepEqual(f.saved(), before)
  const state = await f.execute('status')
  assert.equal(currentSpec(state, seed.resourceId).files[0].sha256, wrongHash)
  assert.equal(state.models[0].configuration.threads, 6)
  assert.equal(state.models[0].active, true)
  assert.deepEqual(f.removed, [])
  f.behavior.failSave = false
  assert.deepEqual(await f.add(correctHash), { ok: true, modelId: seed.modelId })
  assert.equal(f.saved().custom[0].specification.files[0].sha256, correctHash)
})

test('相同资源规范重复添加幂等，不重命名、不覆盖参数且不干扰已准备的运行模型', async () => {
  const seed = await seeded()
  const f = await fixture({ stored: seed.stored, resources: [engine, { id: seed.resourceId, revision: 'existing', kind: 'model', authorized: true }] })
  f.runtimes.push({ runtime: 'chat', configured: true, instances: [{ state: 'ready', active: 1, pending: 0 }] })
  const before = structuredClone(f.saved())
  const binding = structuredClone(f.bindings.get('chat'))
  const input = { ...f.input, title: '不应覆盖既有名称', checksums: { 'model.gguf': wrongHash } }
  assert.deepEqual(await f.execute('add-model', input), { ok: true, modelId: seed.modelId })
  assert.deepEqual(f.saved(), before)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.bindings.get('chat'), binding)
  assert.deepEqual(f.prepared, [])
  assert.deepEqual(f.removed, [])
})

test('已有排队任务的模型不接受规范替换，原件和状态保留', async () => {
  // 全部忙碌状态由 manager-image 的切换保护覆盖；这里保护规范更正入口。
  const seed = await seeded()
  const f = await fixture({ stored: seed.stored })
  f.runtimes.push({ runtime: 'chat', configured: true, instances: [{ state: 'ready', active: 0, pending: 1 }] })
  const before = structuredClone(f.saved())
  const result = await f.add(correctHash)
  assert.match(result.error, /正在使用.*任务结束/)
  assert.deepEqual(f.saved(), before)
  assert.equal(currentSpec(await f.execute('status'), seed.resourceId).files[0].sha256, wrongHash)
  assert.deepEqual(f.sets, [engine])
  assert.deepEqual(f.removed, [])
})

test('既有文件或失效引用要求明确处理，不静默覆盖；用户主动清理后可原身份更正', async t => {
  for (const authorized of [true, false]) await t.test(`authorized=${authorized}`, async () => {
    const seed = await seeded()
    const existing = { id: seed.resourceId, kind: 'model', revision: 'retained', authorized }
    const f = await fixture({ stored: seed.stored, resources: [engine, existing] })
    const before = structuredClone(f.saved())
    const bindings = structuredClone([...f.bindings])
    const blocked = await f.add(correctHash)
    assert.match(blocked.error, /已有文件或资源引用.*清理模型文件/)
    assert.deepEqual(f.saved(), before)
    assert.deepEqual([...f.bindings], bindings)
    assert.deepEqual(f.sets, [engine, existing])
    assert.deepEqual(f.removed, [])
    assert.equal((await f.execute('clear', { modelId: seed.modelId })).ok, true)
    assert.deepEqual(await f.add(correctHash), { ok: true, modelId: seed.modelId })
    assert.equal(f.saved().custom.length, 1)
    assert.equal(f.saved().custom[0].specification.files[0].sha256, correctHash)
    assert.deepEqual(f.saved().models, before.models)
    assert.deepEqual(f.saved().active, before.active)
  })
})

const splitFiles = ['nested/model-00001-of-00002.gguf', 'nested/model-00002-of-00002.gguf', 'mmproj.gguf']

test('逐文件导入完整分片复制到清单路径，普通视觉投影仍保持原地引用', async () => {
  const data = metadata(splitFiles.map(file), 'image-text-to-text')
  const seed = await seeded(data)
  const f = await fixture({ stored: seed.stored, data })
  const files = splitFiles.map((id, index) => ({ id, resourceId: `picked-renamed-${index}` }))
  const result = await f.execute('prepare', { modelId: seed.modelId, resourceId: seed.resourceId, mode: 'file', scope: 'model', files })
  assert.equal(result.ok, true)
  assert.deepEqual(f.prepared.map(spec => spec.id), [seed.resourceId])
  assert.deepEqual(f.prepared[0].files, splitFiles.map((path, index) => ({ path, sha256: wrongHash, source: { resourceId: files[index].resourceId, ...(index === 2 ? { reference: true } : {}) } })))
  assert.deepEqual(f.bindings.get('vision').configuration.files, { model: splitFiles[0], projector: splitFiles[2] })
  assert.deepEqual(f.removed, [])
})

test('分片目录引用和下载保留原协议、完整路径及 model 范围，不重复准备引擎', async t => {
  for (const mode of ['directory', 'download']) await t.test(mode, async () => {
    const data = metadata(splitFiles.map(file), 'image-text-to-text')
    const seed = await seeded(data)
    const f = await fixture({ stored: seed.stored, data })
    const result = await f.execute('prepare', { modelId: seed.modelId, scope: 'model', mode, ...(mode === 'directory' ? { directoryId: 'picked-directory' } : {}) })
    assert.equal(result.ok, true)
    assert.deepEqual(f.prepared.map(spec => spec.id), [seed.resourceId])
    assert.deepEqual(f.prepared[0].files.map(file => file.path), splitFiles)
    for (const [index, part] of f.prepared[0].files.entries()) {
      assert.equal(part.sha256, wrongHash)
      assert.deepEqual(part.source, mode === 'directory' ? { directoryId: 'picked-directory', path: splitFiles[index], reference: true } : { url: `https://huggingface.co/example/repair/resolve/${revision}/${splitFiles[index]}` })
      assert.equal(part.size, mode === 'download' ? 32 * 1024 ** 2 : undefined)
    }
    assert.deepEqual(f.sets[0], engine)
    assert.deepEqual(f.removed, [])
  })
})
