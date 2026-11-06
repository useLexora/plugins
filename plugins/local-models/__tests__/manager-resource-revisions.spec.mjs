import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { activateManager } from '../manager.js'

const catalog = JSON.parse(await fs.readFile(new URL('../catalog.json', import.meta.url)))
const specifications = JSON.parse(await fs.readFile(new URL('../resources.json', import.meta.url)))
const model = catalog.models.find(item => item.id === 'qwen3-4b')
const specification = specifications.find(item => item.id === model.resources[1])
const input = { modelId: model.id, resourceId: specification.id, mode: 'file', files: specification.files.map(file => ({ id: file.path, resourceId: 'selected-file' })) }

async function open({ resources, prepare, stored, runtime = () => undefined, save = async () => {} }) {
  const commands = new Map(), bindings = [], writes = []
  await activateManager({
    signal: new AbortController().signal,
    views: { broadcast: async () => {} },
    storage: { get: async () => stored, set: async value => { await save(value); writes.push(structuredClone(value)) } },
    commands: { register: (id, handler) => commands.set(id, handler) },
    subscriptions: { add() {} },
    inference: {
      capabilities: { runtimeIsolation: true },
      resources: { list: async () => structuredClone(resources), prepare },
      status: async () => runtime() ? [runtime()] : [],
      bind: async binding => bindings.push(structuredClone(binding)),
      credentials: { has: async () => false },
    },
  }, { manifest: { id: 'lexora.local-models' }, catalog: structuredClone(catalog), specifications: structuredClone(specifications) })
  return { bindings, writes, execute: (name, args) => commands.get(`lexora.local-models.${name}`)({ arguments: args }) }
}

const resource = revision => ({ id: specification.id, revision, kind: 'model', authorized: true })
const initial = () => [{ id: model.resources[0], revision: 'engine', kind: 'engine', authorized: true }, resource('old')]
const boundRevision = binding => binding.resources.find(item => item.id === specification.id).revision

test('prepare uses its exact returned revision despite reordered lists and restores it after reopening', async () => {
  const resources = initial()
  const manager = await open({ resources, prepare: async () => {
    const prepared = resource('new')
    resources.splice(1, 0, prepared)
    return prepared
  } })
  assert.equal(boundRevision(manager.bindings.at(-1)), 'old')
  assert.equal((await manager.execute('prepare', input)).ok, true)
  assert.equal(boundRevision(manager.bindings.at(-1)), 'new')
  const stored = manager.writes.at(-1)
  assert.equal(stored.resourceRevisions[specification.id], 'new')
  const reopened = await open({ resources, stored })
  assert.equal(boundRevision(reopened.bindings.at(-1)), 'new')
})

test('a selected revision that loses authorization never silently falls back to an old revision', async () => {
  const resources = [...initial(), { ...resource('new'), authorized: false }]
  const manager = await open({ resources, stored: { active: { chat: model.id }, resourceRevisions: { [specification.id]: 'new' } } })
  assert.deepEqual(manager.bindings, [])
  const state = await manager.execute('status')
  assert.equal(state.models.find(item => item.id === model.id).prepared, false)
  assert.equal(state.models.find(item => item.id === model.id).filesReady, false)
})

test('revision persistence failure warns without discarding prepared resources or the exact session binding', async () => {
  const resources = initial()
  const manager = await open({ resources, save: async () => { throw Error('disk full') }, prepare: async () => {
    const prepared = resource('new')
    resources.splice(1, 0, prepared)
    return prepared
  } })
  const result = await manager.execute('prepare', input)
  assert.equal(result.ok, true)
  assert.match(result.warning, /修订信息未能保存/)
  assert.equal(boundRevision(manager.bindings.at(-1)), 'new')
  assert.deepEqual(manager.writes, [])
  assert.ok(resources.some(item => item.revision === 'new'))
})

for (const instance of [
  { state: 'ready', active: 1, pending: 0 },
  { state: 'ready', active: 0, pending: 1 },
  { state: 'loading', active: 0, pending: 0 },
  { state: 'stopping', active: 0, pending: 0 },
]) test(`automatic rebind preserves a runtime that becomes busy during prepare: ${JSON.stringify(instance)}`, async () => {
  const resources = initial()
  let current, entered, release
  const started = new Promise(resolve => { entered = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const manager = await open({ resources, runtime: () => current, prepare: async () => {
    entered(); await waiting
    const prepared = resource('new')
    resources.splice(1, 0, prepared)
    return prepared
  } })
  const before = manager.bindings.length
  const operation = manager.execute('prepare', input)
  await started
  current = { runtime: model.runtime, instances: [instance] }
  release()
  const result = await operation
  assert.equal(result.ok, true)
  assert.match(result.warning, /重新启用/)
  assert.equal(manager.bindings.length, before)
  assert.deepEqual(current.instances, [instance])
  assert.equal(manager.writes.at(-1).resourceRevisions[specification.id], 'new')
  current = undefined
  assert.equal((await manager.execute('activate-model', { modelId: model.id })).ok, true)
  assert.equal(boundRevision(manager.bindings.at(-1)), 'new')
})
