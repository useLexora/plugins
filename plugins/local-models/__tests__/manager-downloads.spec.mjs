import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { activateManager } from '../manager.js'
import { jsonBytes, storageMaxBytes } from '../downloadHistory.js'

const originalCatalog = JSON.parse(await fs.readFile(new URL('../catalog.json', import.meta.url)))
const file = (path, size) => ({ path, sha256: 'a'.repeat(64), url: `https://example.invalid/${path}?secret=private`, ...(size === undefined ? {} : { size }) })
const defaultSpecs = () => [{ id: 'engine', kind: 'engine', files: [file('engine.bin', 5)] }, { id: 'weights', kind: 'model', files: [file('model.bin', 10)] }]
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const cachePorts = {
  extension: { version: '1.0.0' },
  network: { get: async () => ({ status: 200, headers: {}, text: JSON.stringify([{ id: 'example/model', sha: 'a'.repeat(40), pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.safetensors' }] }]) }) },
}

async function fixture({ specs = defaultSpecs(), stored, onSave = async () => {}, prepare = async () => {}, existing = [] } = {}) {
  const commands = new Map(), broadcasts = [], writes = [], prepared = [], removed = []
  const model = { ...originalCatalog.models[0], id: 'test-model', title: 'Test model', resources: specs.map(spec => spec.id) }
  const catalog = { ...structuredClone(originalCatalog), models: [model] }
  const initial = stored ?? { version: 2, active: {}, models: { 'test-model': model.defaults, legacy: { threads: 7 } }, retainedField: { keep: true } }
  let saved = structuredClone(initial)
  const resources = [{ id: 'weights', authorized: false, revision: 'previous-reference' }, ...existing]
  const execute = (name, input) => commands.get(`test.plugin.${name}`)({ arguments: input })
  const context = {
    ...cachePorts, signal: new AbortController().signal,
    views: { broadcast: async value => { broadcasts.push(structuredClone(value)) } },
    storage: { get: async () => structuredClone(saved), set: async value => { await onSave(value, execute); saved = structuredClone(value); writes.push(structuredClone(value)) } },
    commands: { register: (id, handler) => { commands.set(id, handler); return () => {} } }, subscriptions: { add() {} },
    inference: {
      capabilities: { runtimeIsolation: true }, status: async () => [], bind: async () => {}, stop: async () => {}, credentials: { has: async () => false },
      resources: {
        list: async () => resources,
        prepare: async (spec, options) => {
          prepared.push(spec)
          await prepare(spec, options, execute)
          const result = { id: spec.id, kind: spec.kind, authorized: true, revision: `prepared-${prepared.length}` }
          resources.push(result)
          return result
        },
        remove: async target => { removed.push(target); throw Error('Download history must not remove files') },
      },
    },
  }
  await activateManager(context, { manifest: { id: 'test.plugin' }, catalog, specifications: specs })
  return { execute, resources, prepared, removed, broadcasts, writes, saved: () => saved, model, initial }
}

function emit(onProgress, path, bytes, totalBytes, phase = 'download') {
  onProgress({ path, bytes, totalBytes, phase, completedFiles: 0, totalFiles: 1 })
}

test('manager aggregates every pending input across resources and persists only start/end snapshots', async () => {
  const specs = [
    { id: 'engine', kind: 'engine', archives: [{ id: 'packed', size: 5, unpackedBytes: 100, sha256: 'a'.repeat(64), source: { url: 'https://example.invalid/archive' } }], files: [{ path: 'expanded', archive: 'packed', archivePath: 'expanded' }] },
    { id: 'weights', kind: 'model', files: [file('same', 10), file('unknown')] },
    { id: 'more-weights', kind: 'model', files: [{ ...file('same'), bytes: 20 }] },
  ]
  const f = await fixture({ specs, prepare: async (spec, { onProgress }) => {
    if (spec.preparation) {
      emit(onProgress, 'packed', 0, 5, 'connect')
      emit(onProgress, 'packed', 5, 5)
      emit(onProgress, 'expanded', 100, 100, 'extract')
      emit(onProgress, '', 100, 100, 'ready')
    } else for (const input of spec.files) {
      const size = input.path === 'unknown' ? 7 : input.size
      emit(onProgress, input.path, 0, input.size ?? null, 'connect')
      emit(onProgress, input.path, 2, size)
      emit(onProgress, input.path, size, size)
      emit(onProgress, input.path, size, size, 'verify')
    }
  } })
  assert.equal((await f.execute('prepare', { modelId: f.model.id })).ok, true)
  const state = await f.execute('status')
  assert.equal(state.job.downloadedBytes, 42)
  assert.equal(state.job.totalBytes, 42)
  assert.equal(state.job.state, 'completed')
  assert.equal(state.job.phase, 'ready')
  assert.equal(state.job.progress, null)
  assert.equal(state.downloadHistory.length, 1)
  assert.equal(state.downloadHistory[0].downloadedBytes, 42)
  assert.equal(state.downloadHistory[0].state, 'completed')
  assert.equal(state.downloadHistory[0].id, state.job.id)
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[0].downloadHistory[0].state, 'preparing')
  assert.deepEqual(f.saved().retainedField, f.initial.retainedField)
  assert.deepEqual(f.saved().models, f.initial.models, '历史写入不得规范化模型配置')
  assert.equal(JSON.stringify(f.saved().downloadHistory).includes('secret'), false)
  assert.equal(f.prepared[1].files[0].size, 10)
  assert.equal(f.prepared[1].files[1].size, undefined)
  assert.equal(f.prepared[2].files[0].size, 20)
  const jobs = f.broadcasts.map(event => event.job)
  for (let i = 1; i < jobs.length; i++) assert.ok(jobs[i].downloadedBytes >= jobs[i - 1].downloadedBytes)
  const engineReady = jobs.find(job => job.progress?.phase === 'ready')
  assert.equal(engineReady.state, 'preparing')
  assert.equal(engineReady.downloadedBytes, 5)
  assert.equal(engineReady.totalBytes, null)
  assert.deepEqual(f.removed, [])
})

for (const cancelled of [false, true]) test(`${cancelled ? 'cancellation' : 'failure'} retains observed bytes without deleting existing or external resources`, async () => {
  const f = await fixture({ prepare: async (_spec, { onProgress, signal }, execute) => {
    emit(onProgress, 'model.bin', 4, 10)
    if (cancelled) { await execute('cancel-preparation'); signal.throwIfAborted() }
    throw Error('DOWNLOAD_FAILED https://private.invalid/?token=secret')
  } })
  const result = await f.execute('prepare', { modelId: f.model.id, scope: 'model' })
  assert.ok(result.error)
  const state = await f.execute('status')
  assert.equal(state.job.state, cancelled ? 'cancelled' : 'failed')
  assert.equal(state.job.downloadedBytes, 4)
  assert.equal(state.job.totalBytes, 10)
  assert.equal(state.downloadHistory[0].downloadedBytes, 4)
  assert.equal(state.downloadHistory[0].totalBytes, 10)
  assert.ok(Number.isSafeInteger(state.downloadHistory[0].endedAt))
  assert.deepEqual(f.removed, [])
  assert.equal(f.resources[0].revision, 'previous-reference')
  assert.equal(JSON.stringify(state.downloadHistory).includes('private.invalid'), false)
})

for (const interrupted of [false, true]) test(`retry after ${interrupted ? 'restart interruption' : 'failure'} continues the selected history record without trusting saved byte counts`, async () => {
  const older = { id: 'older', modelId: 'removed-model', title: 'Earlier download', mode: 'download', state: 'cancelled', startedAt: 1, endedAt: 2, downloadedBytes: 2, totalBytes: 20 }
  const first = await fixture({ stored: { downloadHistory: [older] }, prepare: async (_spec, { onProgress }) => {
    emit(onProgress, 'model.bin', 4, 10)
    throw Error('DOWNLOAD_FAILED')
  } })
  await first.execute('prepare', { modelId: first.model.id, scope: 'model' })
  const saved = first.saved()
  const id = saved.downloadHistory[0].id
  if (interrupted) { saved.downloadHistory[0].state = 'preparing'; saved.downloadHistory[0].endedAt = null }
  const restored = await fixture({ stored: saved, prepare: async (_spec, { onProgress }) => {
    onProgress({ path: 'model.bin', bytes: 3, totalBytes: 10, phase: 'connect', resumedBytes: 3 })
    onProgress({ path: 'model.bin', bytes: 10, totalBytes: 10, phase: 'download', resumedBytes: 3 })
  } })
  assert.equal((await restored.execute('prepare', { modelId: restored.model.id, scope: 'model', retryId: id })).ok, true)
  const state = await restored.execute('status')
  assert.equal(state.job.id, id)
  assert.equal(state.job.state, 'completed')
  assert.equal(state.job.downloadedBytes, 10)
  assert.equal(state.job.resumedBytes, 3)
  assert.deepEqual(state.downloadHistory.map(record => record.id), [id, 'older'])
  assert.deepEqual(state.downloadHistory[1], older)
  assert.ok(restored.broadcasts.some(item => item.job?.downloadedBytes === 3 && item.job.resumedBytes === 3))
  const completed = restored.saved()
  assert.ok((await restored.execute('prepare', { modelId: restored.model.id, retryId: id })).error)
  assert.deepEqual(restored.saved(), completed)
})

test('history storage failure does not turn a successfully downloaded model into a failure', async () => {
  const f = await fixture({ onSave: async () => { throw Error('disk full') }, prepare: async (_spec, { onProgress }) => { emit(onProgress, 'model.bin', 10, 10) } })
  const result = await f.execute('prepare', { modelId: f.model.id, scope: 'model' })
  assert.equal(result.ok, true)
  assert.ok(result.historyWarning)
  const state = await f.execute('status')
  assert.equal(state.job.state, 'completed')
  assert.equal(state.downloadHistory[0].state, 'completed')
  assert.ok(state.historyWarning)
  assert.equal(state.models[0].filesReady, true)
  assert.deepEqual(f.removed, [])
  assert.deepEqual(f.saved(), f.initial)
})

test('a failed initial history write recovers on completion without poisoning the shared queue', async () => {
  let attempts = 0
  const f = await fixture({ onSave: async () => { if (++attempts === 1) throw Error('temporary storage failure') }, prepare: async (_spec, { onProgress }) => emit(onProgress, 'model.bin', 10, 10) })
  const result = await f.execute('prepare', { modelId: f.model.id, scope: 'model' })
  assert.equal(result.ok, true)
  assert.equal(result.historyWarning, undefined)
  assert.equal((await f.execute('status')).historyWarning, '')
  assert.equal(f.saved().downloadHistory[0].state, 'completed')
  await f.execute('discover', {})
  assert.equal(f.saved().downloadHistory[0].state, 'completed')
  assert.ok(f.saved().discoveryCache.entries.length)
})

test('prepared engines are skipped and explicit model downloads have independent bounded history across reload', async () => {
  const f = await fixture({ existing: [{ id: 'engine', authorized: true }], prepare: async (_spec, { onProgress }) => emit(onProgress, 'model.bin', 10, 10) })
  await f.execute('prepare', { modelId: f.model.id })
  assert.deepEqual(f.prepared.map(spec => spec.id), ['weights'])
  assert.equal((await f.execute('status')).job.totalBytes, 10)
  for (let i = 0; i < 52; i++) await f.execute('prepare', { modelId: f.model.id, resourceId: 'weights' })
  const state = await f.execute('status')
  assert.equal(state.downloadHistory.length, 50)
  assert.equal(new Set(state.downloadHistory.map(record => record.id)).size, 50)
  assert.equal(state.downloadHistory[0].id, state.job.id)
  assert.equal(f.saved().downloadHistory.length, 50)
  const restored = await fixture({ stored: f.saved() })
  assert.deepEqual((await restored.execute('status')).downloadHistory, state.downloadHistory)
  assert.equal(restored.writes.length, 0)
})

test('restart interrupts an unfinished task once and preserves completed history without auto-download', async () => {
  const base = { id: 'previous', modelId: 'test-model', title: 'Previous title', mode: 'download', startedAt: 123, endedAt: null, state: 'preparing', downloadedBytes: 4, totalBytes: 10 }
  const completed = { ...base, id: 'done', startedAt: 100, endedAt: 110, state: 'completed', downloadedBytes: 10 }
  const stored = { version: 1, retainedField: { raw: true }, active: {}, downloadHistory: [base, completed] }
  const f = await fixture({ stored })
  const state = await f.execute('status')
  assert.equal(state.job, null)
  assert.equal(state.downloadHistory[0].state, 'interrupted')
  assert.equal(state.downloadHistory[0].endedAt, null)
  assert.equal(state.downloadHistory[0].downloadedBytes, 4)
  assert.deepEqual(state.downloadHistory[1], completed)
  assert.deepEqual(f.prepared, [])
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.saved().retainedField, stored.retainedField)
  assert.equal(f.saved().version, 1)
  assert.equal(f.saved().models, undefined)
  const restarted = await fixture({ stored: f.saved() })
  assert.equal(restarted.writes.length, 0)
  assert.deepEqual((await restarted.execute('status')).downloadHistory, state.downloadHistory)
})

test('engine downloads and manual file preparation stay out of model download history', async () => {
  const f = await fixture()
  await f.execute('prepare', { modelId: f.model.id, resourceId: 'engine' })
  await f.execute('prepare', { modelId: f.model.id, resourceId: 'weights', mode: 'file', files: [{ id: 'model.bin', resourceId: 'external-reference' }] })
  assert.deepEqual((await f.execute('status')).downloadHistory, [])
  assert.deepEqual(f.writes, [
    { ...f.initial, resourceRevisions: { engine: 'prepared-1' } },
    { ...f.initial, resourceRevisions: { engine: 'prepared-1', weights: 'prepared-2' } },
  ])
  assert.equal(f.prepared[1].files[0].source.reference, true)
  assert.equal(f.prepared[1].files[0].size, undefined)
  assert.deepEqual(f.removed, [])
})

test('known direct sizes fail explicitly on an old strict host without retrying after discarding size', async () => {
  const f = await fixture({ prepare: async () => { throw Error('EXTENSION_INVALID_ARGUMENT') } })
  const result = await f.execute('prepare', { modelId: f.model.id, scope: 'model' })
  assert.match(result.error, /更新 Lexora/)
  assert.equal(f.prepared.length, 1)
  assert.equal(f.prepared[0].files[0].size, 10)
  assert.equal((await f.execute('status')).downloadHistory[0].state, 'failed')
})

test('cache and history writes preserve each other in either queue order', async t => {
  for (const first of ['cache', 'history']) await t.test(first, async () => {
    const entered = deferred(), release = deferred()
    let calls = 0
    const f = await fixture({ onSave: async () => { if (++calls === 1) { entered.resolve(); await release.promise } }, prepare: async (_spec, { onProgress }) => emit(onProgress, 'model.bin', 10, 10) })
    const download = () => f.execute('prepare', { modelId: f.model.id, scope: 'model' })
    const cache = () => f.execute('discover', {})
    const pending = first === 'cache' ? cache() : download()
    await entered.promise
    const second = first === 'cache' ? download() : cache()
    await new Promise(setImmediate)
    assert.equal(calls, 1)
    release.resolve()
    await Promise.all([pending, second])
    assert.ok(f.saved().discoveryCache.entries.length)
    assert.equal(f.saved().downloadHistory[0].state, 'completed')
    assert.deepEqual(f.saved().models, f.initial.models)
  })
})

test('a failed cache write between download start and completion cannot replace history or configuration', async () => {
  const f = await fixture({ onSave: async value => { if (value.discoveryCache) throw Error('cache write rejected') }, prepare: async (_spec, { onProgress }, execute) => {
    emit(onProgress, 'model.bin', 4, 10)
    const discovery = await execute('discover', {})
    assert.equal(discovery.items[0].availability.state, 'unsupported')
    emit(onProgress, 'model.bin', 10, 10)
  } })
  assert.equal((await f.execute('prepare', { modelId: f.model.id, scope: 'model' })).ok, true)
  assert.equal(f.saved().downloadHistory[0].state, 'completed')
  assert.equal(f.saved().downloadHistory[0].downloadedBytes, 10)
  assert.equal(f.saved().discoveryCache, undefined)
  assert.deepEqual(f.saved().models, f.initial.models)
  assert.equal(f.writes.length, 2)
})

test('configuration growth trims old history after cache without rolling back the requested settings', async () => {
  const f = await fixture()
  for (let i = 0; i < 3; i++) await f.execute('prepare', { modelId: f.model.id, resourceId: 'weights' })
  await f.execute('configure', { modelId: f.model.id, configuration: { ...f.model.defaults, threads: 6 } })
  const stored = f.saved()
  stored.models.legacy.note = ''
  stored.models.legacy.note = 'x'.repeat(storageMaxBytes - jsonBytes(stored))
  const next = await fixture({ stored, onSave: async value => assert.ok(jsonBytes(value) <= storageMaxBytes) })
  assert.equal((await next.execute('configure', { modelId: next.model.id, configuration: { ...next.model.defaults, threads: 12 } })).ok, true)
  assert.equal(next.saved().models[next.model.id].threads, 12)
  assert.equal(next.saved().models.legacy.note, stored.models.legacy.note)
  assert.equal(next.saved().downloadHistory.length, 2)
  assert.equal(next.saved().downloadHistory[0].id, stored.downloadHistory[0].id)
  assert.equal((await next.execute('status')).downloadHistory.length, 3)
  assert.ok((await next.execute('status')).historyWarning)
})

test('history evicts cache at the shared budget and degrades without changing full configuration', async () => {
  const stored = { active: {}, models: { retained: { note: '' } }, discoveryCache: { padding: 'c'.repeat(1000) } }
  stored.models.retained.note = 'x'.repeat(storageMaxBytes - jsonBytes(stored))
  const f = await fixture({ stored, onSave: async value => { assert.ok(jsonBytes(value) <= storageMaxBytes) } })
  await f.execute('prepare', { modelId: f.model.id, scope: 'model' })
  assert.equal(f.saved().discoveryCache, undefined)
  assert.equal(f.saved().downloadHistory[0].state, 'completed')
  assert.equal(f.saved().models.retained.note, stored.models.retained.note)
  const full = { active: {}, models: { retained: { note: '' } } }
  full.models.retained.note = 'x'.repeat(storageMaxBytes - jsonBytes(full))
  const limited = await fixture({ stored: full, onSave: async value => assert.ok(jsonBytes(value) <= storageMaxBytes) })
  const result = await limited.execute('prepare', { modelId: limited.model.id, scope: 'model' })
  assert.equal(result.ok, true)
  assert.ok(result.historyWarning)
  assert.deepEqual(limited.saved(), full)
  assert.equal((await limited.execute('status')).downloadHistory[0].state, 'completed')
  assert.deepEqual(limited.removed, [])
})
