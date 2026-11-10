import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { importEngine, isEngineFile } from '../engineImport.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const local = (name, overrides = {}) => ({ id: name, name, size: 64, mimeType: 'application/octet-stream', relativePath: `engine/${name}`, ...overrides })
function fixture(files = [local('llama-server'), local('libggml.so.0')]) {
  const state = { files, hashes: new Map(), prepared: new Map(), requests: [], hashed: [], lists: 0 }
  const context = {
    resources: {
      async listFiles() { state.lists++; return state.files.map(file => ({ ...file })) },
      async hash({ id }, { signal }) {
        signal?.throwIfAborted()
        state.hashed.push(id)
        const file = state.files.find(file => file.id === id)
        if (!file) throw Error('AUTHORIZATION_REVOKED')
        return state.hashes.get(id) ?? { sha256: digest(file.name), size: file.size }
      },
    },
    inference: { resources: {
      async prepare(request, { signal }) {
        signal?.throwIfAborted()
        state.requests.push(structuredClone(request))
        const result = { id: request.id, revision: digest(JSON.stringify(request.files)), kind: request.kind, files: request.files.length, bytes: request.files.reduce((sum, file) => sum + file.size, 0) }
        state.prepared.set(result.id, result)
        return result
      },
    } },
  }
  const run = (input = {}, platform = 'linux-x64', options = {}) => importEngine(context, { resourceIds: files.map(file => file.id), backend: 'cpu', ...input }, platform, options)
  return { state, context, run }
}

test('imports exact authorized references and returns a custom specification without claiming an upstream version', async () => {
  const { run, state } = fixture()
  const { specification: spec, prepared } = await run()
  const identity = ['linux-x64', 'cpu', [['libggml.so.0', digest('libggml.so.0')], ['llama-server', digest('llama-server')]]]
  assert.equal(spec.id, `llama-custom-${digest(JSON.stringify(identity)).slice(0, 32)}`)
  assert.deepEqual(spec, {
    id: spec.id, kind: 'engine', engineId: 'llama.cpp', title: 'llama.cpp', backend: 'cpu', platforms: ['linux-x64'], custom: true, bytes: 128,
    files: [
      { path: 'libggml.so.0', source: 'engine/libggml.so.0', resourceId: 'libggml.so.0', sha256: digest('libggml.so.0'), size: 64 },
      { path: 'llama-server', source: 'engine/llama-server', resourceId: 'llama-server', sha256: digest('llama-server'), size: 64, entry: true, executable: true },
    ],
  })
  assert.deepEqual(state.requests[0], {
    id: spec.id, kind: 'engine', files: [
      { path: 'libggml.so.0', sha256: digest('libggml.so.0'), size: 64, source: { resourceId: 'libggml.so.0', reference: true } },
      { path: 'llama-server', sha256: digest('llama-server'), size: 64, executable: true, source: { resourceId: 'llama-server', reference: true } },
    ],
  })
  assert.equal(prepared, state.prepared.get(spec.id))
})

test('identity is independent of selection order, directory and resource handles, but changes with content, library names, backend and platform', async () => {
  const first = fixture(), second = fixture([local('libggml.so.0', { id: 'library-new', relativePath: 'other/libggml.so.0' }), local('llama-server', { id: 'entry-new', relativePath: 'other/llama-server' })])
  const id = (await first.run()).specification.id
  assert.equal((await second.run()).specification.id, id)
  first.state.hashes.set('libggml.so.0', { sha256: digest('different bytes'), size: 64 })
  assert.notEqual((await first.run()).specification.id, id)
  assert.notEqual((await fixture([local('llama-server'), local('libother.so.0')]).run()).specification.id, id)
  assert.notEqual((await second.run({ backend: 'vulkan' })).specification.id, id)
  const single = fixture([local('llama-server')])
  assert.notEqual((await single.run()).specification.id, (await single.run({}, 'macos-arm64')).specification.id)
})

test('accepts only platform-native entries, libraries and backend choices', async () => {
  for (const [platform, names, backends] of [
    ['linux-x64', ['llama-server', 'libllama.so', 'libggml.so.0.27.0', 'libcuda.so.1'], ['cpu', 'vulkan', 'cuda']],
    ['windows-x64', ['LLAMA-SERVER.EXE', 'ggml-cuda.DLL', 'cudart64_12.dll'], ['cpu', 'vulkan', 'cuda']],
    ['macos-arm64', ['llama-server', 'libllama.0.dylib', 'libggml-metal.dylib'], ['cpu', 'metal']],
  ]) {
    for (const backend of backends) {
      const { run } = fixture(names.map(name => local(name)))
      const { specification } = await run({ backend }, platform)
      assert.equal(specification.backend, backend)
      assert.deepEqual(specification.platforms, [platform])
      assert.equal(specification.files.filter(file => file.entry).length, 1)
      assert.equal(specification.files.find(file => file.entry).path, platform === 'windows-x64' ? 'llama-server.exe' : 'llama-server')
    }
  }
  for (const [platform, backend] of [['linux-x64', 'metal'], ['windows-x64', 'metal'], ['macos-arm64', 'cuda'], ['macos-arm64', 'vulkan'], ['linux-x64', 'gpu'], ['linux-arm64', 'cpu'], ['__proto__', 'cpu']]) {
    const { run, state } = fixture()
    await assert.rejects(run({ backend }, platform), /平台/)
    assert.equal(state.lists, 0)
  }
})

test('UI candidate predicate matches the import whitelist and rejects scripts, filenames with traversal or reserved names', () => {
  for (const name of ['llama-server', 'libggml.so', 'libggml.so.1.2']) assert.equal(isEngineFile(name, 'linux-x64'), true)
  for (const name of ['llama-server.exe', 'GGML.DLL']) assert.equal(isEngineFile(name, 'windows-x64'), true)
  assert.equal(isEngineFile('libggml.0.dylib', 'macos-arm64'), true)
  for (const name of ['run.sh', 'llama-server.sh', 'libggml.so.sh', 'libggml.so.1.sh', '../libggml.so', '/libggml.so', 'dir/libggml.so', 'libggml.so ', 'libggml.so:stream', 'NUL.so', 'libggml\\.so', null]) assert.equal(isEngineFile(name, 'linux-x64'), false)
  assert.equal(isEngineFile('llama-server', '__proto__'), false)
})

test('rejects unknown handles, repeated handles, empty selection and excessive file counts before hashing', async () => {
  for (const resourceIds of [[], ['missing'], ['llama-server', 'llama-server'], [null], ['x'.repeat(257)], Array.from({ length: 129 }, (_, i) => String(i)), 'llama-server']) {
    const { run, state } = fixture()
    await assert.rejects(run({ resourceIds }))
    assert.equal(state.hashed.length, 0)
    assert.equal(state.requests.length, 0)
  }
})

test('rejects script companions, wrong platform binaries, absent entries and case-colliding roles', async () => {
  for (const names of [
    ['llama-server', 'start.sh'], ['llama-server', 'README.md'], ['llama-server', 'other-server'], ['llama-server.exe'], ['libllama.so'],
    ['llama-server', 'ggml.dll'], ['llama-server', 'libggml.dylib'], ['llama-server', 'libggml.so.1.sh'], ['llama-server', 'libggml.so', 'LIBGGML.SO'],
  ]) {
    const { run, state } = fixture(names.map(name => local(name)))
    await assert.rejects(run())
    assert.equal(state.requests.length, 0)
    assert.equal(state.hashed.length, 0)
  }
})

test('rejects path traversal, absolute paths, inconsistent names and cross-relative-directory files', async () => {
  for (const relativePath of ['../libggml.so', '/libggml.so', 'C:/libggml.so', 'engine/../libggml.so', 'engine\\libggml.so', 'engine//libggml.so', 'engine/./libggml.so', 'engine/libggml.so:ads', 'elsewhere/libggml.so', 'engine/other.so', 'CON/libggml.so']) {
    const { run, state } = fixture([local('llama-server'), local('libggml.so', { relativePath })])
    await assert.rejects(run())
    assert.equal(state.requests.length, 0)
  }
})

test('enforces exact positive sizes, 128 files and 8 GiB total bounds', async () => {
  for (const size of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8 * 1024 ** 3 + 1]) {
    const { run, state } = fixture([local('llama-server', { size })])
    await assert.rejects(run())
    assert.equal(state.hashed.length, 0)
  }
  const full = fixture([local('llama-server'), ...Array.from({ length: 127 }, (_, i) => local(`lib${i}.so`))])
  assert.equal((await full.run()).specification.files.length, 128)
  const limit = fixture([local('llama-server', { size: 8 * 1024 ** 3 })])
  assert.equal((await limit.run()).specification.bytes, 8 * 1024 ** 3)
  const excessive = fixture([local('llama-server', { size: 8 * 1024 ** 3 }), local('libggml.so')])
  await assert.rejects(excessive.run(), /8 GiB/)
  assert.equal(excessive.state.hashed.length, 0)
})

test('requires host hashing and rejects malformed or size-mismatched digests', async () => {
  const missing = fixture()
  delete missing.context.resources.hash
  await assert.rejects(missing.run(), /升级/)
  for (const hash of [null, { sha256: 'bad', size: 64 }, { sha256: 'a'.repeat(64), size: 63 }, { sha256: 1, size: 64 }]) {
    const { run, state, context } = fixture()
    context.resources.hash = async () => hash
    await assert.rejects(run(), /摘要或大小/)
    assert.equal(state.requests.length, 0)
  }
  const upper = fixture()
  upper.state.hashes.set('llama-server', { sha256: 'A'.repeat(64), size: 64 })
  assert.equal((await upper.run()).specification.files.find(file => file.entry).sha256, 'a'.repeat(64))
})

test('refuses revoked or changed file identities after hashing and preserves host security errors', async () => {
  for (const mutate of [state => { state.files = state.files.slice(1) }, state => { state.files[0].size++ }, state => { state.files[0].relativePath = 'elsewhere/llama-server' }, state => { state.files[0].name = 'renamed' }]) {
    const { run, context, state } = fixture()
    const hash = context.resources.hash
    context.resources.hash = async (...args) => {
      const value = await hash(...args)
      if (args[0].id === 'llama-server') mutate(state)
      return value
    }
    await assert.rejects(run())
    assert.equal(state.requests.length, 0)
  }
  for (const code of ['AUTHORIZATION_REVOKED', 'SYMLINK_REJECTED', 'FILE_CHANGED']) {
    const { run, context, state } = fixture()
    const failure = Error(code)
    context.resources.hash = async () => { throw failure }
    await assert.rejects(run(), error => error === failure)
    assert.equal(state.requests.length, 0)
  }
})

test('snapshots input ids before yielding and refuses malformed host authorization lists', async () => {
  const { context } = fixture()
  const ids = ['llama-server']
  const promise = importEngine(context, { resourceIds: ids, backend: 'cpu' }, 'linux-x64')
  ids[0] = 'unknown'
  assert.equal((await promise).specification.files[0].resourceId, 'llama-server')
  for (const value of [null, [{ id: '' }], [local('llama-server'), local('llama-server')]]) {
    const broken = fixture()
    broken.context.resources.listFiles = async () => value
    await assert.rejects(broken.run(), /宿主返回/)
    assert.equal(broken.state.requests.length, 0)
  }
})

test('cancellation stops before preparation; a cancelled completed prepare is retained for an identical retry', async () => {
  const early = fixture(), abort = new AbortController()
  abort.abort()
  await assert.rejects(early.run({}, 'linux-x64', { signal: abort.signal }), { name: 'AbortError' })
  assert.equal(early.state.lists, 0)
  const middle = fixture(), duringHash = new AbortController(), hash = middle.context.resources.hash
  middle.context.resources.hash = async (...args) => { const value = await hash(...args); duringHash.abort(); return value }
  await assert.rejects(middle.run({}, 'linux-x64', { signal: duringHash.signal }), { name: 'AbortError' })
  assert.equal(middle.state.requests.length, 0)
  const late = fixture(), afterPrepare = new AbortController(), prepare = late.context.inference.resources.prepare
  late.context.inference.resources.prepare = async (...args) => { const value = await prepare(...args); afterPrepare.abort(); return value }
  await assert.rejects(late.run({}, 'linux-x64', { signal: afterPrepare.signal }), { name: 'AbortError' })
  const [retained] = late.state.prepared.values()
  late.context.inference.resources.prepare = prepare
  assert.deepEqual((await late.run()).prepared, retained)
  assert.equal(late.state.prepared.size, 1)
})

test('prepare failure preserves an existing revision, and caller persistence failure permits same-id retry', async () => {
  const { run, state, context } = fixture()
  const first = await run(), prepare = context.inference.resources.prepare
  const failure = Error('PREPARE_FAILED')
  context.inference.resources.prepare = async () => { throw failure }
  await assert.rejects(run(), error => error === failure)
  assert.equal(state.prepared.get(first.prepared.id), first.prepared)
  context.inference.resources.prepare = prepare
  await assert.rejects((async () => { await run(); throw Error('PERSISTENCE_FAILED') })(), /PERSISTENCE_FAILED/)
  const retried = await run()
  assert.deepEqual(retried, first)
  assert.equal(state.prepared.size, 1)
})
