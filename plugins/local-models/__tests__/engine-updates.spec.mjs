import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { checkEngineUpdates, validateEngineUpdates } from '../engineUpdates.js'

const resources = JSON.parse(await fs.readFile(new URL('../resources.json', import.meta.url)))
const official = resources.filter(spec => spec.engineId === 'llama.cpp')
const baseline = official.find(spec => spec.backend === 'vulkan' && spec.platforms[0] === 'linux-x64' && !spec.legacy)
const future = () => JSON.parse(JSON.stringify(baseline).replaceAll(baseline.version, `b${Number(baseline.version.slice(1)) + 1}`))
const catalogURL = 'https://raw.githubusercontent.com/useLexora/plugins/main/plugins/local-models/resources.json'

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }
  return value
}

test('official catalogs normalize to detached resource specs, accept newer builds and never mutate inputs', async () => {
  const next = future()
  next.requirements = ['运行兼容性仍需在本机验证']
  next.untrusted = { command: 'never execute' }
  next.files[0].untrusted = { reference: 'never persist' }
  const input = frozen([...structuredClone(resources), next])
  const current = frozen(structuredClone(resources))
  const updates = validateEngineUpdates(input, current)
  assert.deepEqual(updates.map(spec => spec.id), [...official.map(spec => spec.id), next.id])
  const normalized = updates.at(-1)
  assert.deepEqual(normalized.requirements, next.requirements)
  assert.equal(Object.hasOwn(normalized, 'untrusted'), false)
  assert.equal(Object.hasOwn(normalized.files[0], 'untrusted'), false)
  assert.notEqual(normalized.files[0], next.files[0])
  const result = await checkEngineUpdates({ network: { get: async url => {
    assert.equal(url, catalogURL)
    return { status: 200, text: JSON.stringify(input), headers: {} }
  } } }, current)
  assert.deepEqual(result, updates)
})

test('immutable identities include archive and file content but allow presentation and ordering changes', () => {
  const changedTitle = structuredClone(baseline)
  changedTitle.title = '官方 llama.cpp'
  changedTitle.requirements = ['请在本机验证']
  changedTitle.files.reverse()
  assert.equal(validateEngineUpdates([changedTitle], resources)[0].title, changedTitle.title)
  const mutations = [
    spec => { spec.files[0].sha256 = 'f'.repeat(64) },
    spec => { spec.archives[0].sha256 = 'f'.repeat(64) },
    spec => { spec.archives[0].size++; spec.bytes++ },
    spec => { spec.archives[0].unpackedBytes++ },
  ]
  for (const mutate of mutations) {
    const input = structuredClone(baseline)
    mutate(input)
    assert.throws(() => validateEngineUpdates([input], resources), /冲突/)
  }
})

test('untrusted download sources, path remapping, executable roles, budgets and invalid identities fail closed', () => {
  const mutations = [
    spec => { spec.kind = 'model' },
    spec => { spec.custom = true },
    spec => { spec.version = 'latest' },
    spec => { spec.id = 'llama-custom-test' },
    spec => { spec.backend = 'custom' },
    spec => { spec.platforms.push('windows-x64') },
    spec => { spec.archives[0].source.url = spec.archives[0].source.url.replace('ggml-org', 'foreign') },
    spec => { spec.archives[0].source.url = spec.archives[0].source.url.replace('/releases/download/', '/releases/latest/') },
    spec => { spec.archives[0].source.url += '?redirect=evil' },
    spec => { spec.archives[0].source.resourceId = 'host-local' },
    spec => { spec.archives[0].source.directoryId = 'host-directory' },
    spec => { spec.archives[0].sha256 = 'not-a-hash' },
    spec => { spec.archives[0].size = 3 * 1024 ** 3; spec.bytes = spec.archives[0].size },
    spec => { spec.archives[0].unpackedBytes = 9 * 1024 ** 3 },
    spec => { spec.files[0].archive = 'undeclared' },
    spec => { spec.files[0].path = '../llama-server' },
    spec => { spec.files[0].archivePath = `llama-${spec.version}/../llama-server` },
    spec => { spec.files[0].archivePath = `llama-${spec.version}/llama-server` },
    spec => { spec.files[0].source = { resourceId: 'host-local' } },
    spec => { spec.files[0].executable = true },
    spec => { spec.files.find(file => file.executable).executable = false },
    spec => { spec.files.push({ ...spec.files[0] }) },
    spec => { spec.files[0].path = 'install.sh'; spec.files[0].source = 'engine/install.sh'; spec.files[0].archivePath = `llama-${spec.version}/install.sh` },
    spec => { spec.files[0].sha256 = '0' },
    spec => { spec.bytes++ },
    spec => { spec.requirements = [{ command: 'bad' }] },
  ]
  for (const mutate of mutations) {
    const input = future()
    mutate(input)
    assert.throws(() => validateEngineUpdates([input], resources), /引擎更新目录无效/, mutate.toString())
  }
  assert.throws(() => validateEngineUpdates(Array(65).fill(future()), resources), /数量/)
  assert.throws(() => validateEngineUpdates([future(), future()], resources), /重复/)
  const newer = future()
  assert.throws(() => validateEngineUpdates([baseline], [newer]), /低于当前版本/)
  const cuda = structuredClone(official.find(spec => spec.backend === 'cuda' && spec.platforms[0] === 'linux-x64'))
  const runtime = cuda.files.find(file => file.archive === 'cudart')
  runtime.archivePath = `llama-${cuda.version}/llama-server`
  assert.throws(() => validateEngineUpdates([cuda], resources), /目录与版本不匹配/)
  runtime.path = runtime.path.replace(/\.so\.\d+$/, '.so.99')
  assert.throws(() => validateEngineUpdates([cuda], resources), /主版本不匹配/)
})

test('network, invalid JSON, oversized responses and cancellation fail without changing current resources', async () => {
  const current = frozen(structuredClone(resources))
  for (const response of [
    { status: 503, text: 'unavailable' },
    { status: 200, text: 'not json' },
    { status: 200, text: ' '.repeat(2 * 1024 ** 2 + 1) },
    { status: 200, text: '{}' },
  ]) await assert.rejects(checkEngineUpdates({ network: { get: async () => response } }, current))
  await assert.rejects(checkEngineUpdates({ network: { get: async () => { throw Error('offline') } } }, current), /offline/)
  const controller = new AbortController()
  await assert.rejects(checkEngineUpdates({ signal: controller.signal, network: { get: async () => {
    controller.abort()
    return { status: 200, text: JSON.stringify(resources) }
  } } }, current), { name: 'AbortError' })
  assert.deepEqual(current, resources)
})
