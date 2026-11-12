import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

const repository = 'example/model'
const revision = '1'.repeat(40)
const hash = 'a'.repeat(64)
const siblings = (...paths) => paths.map(rfilename => ({ rfilename }))
const model = overrides => ({ id: repository, sha: revision, ...overrides })

function fixture(reply) {
  const requests = []
  const resources = new Map()
  const released = []
  const context = {
    signal: new AbortController().signal,
    network: {
      async get(url) {
        requests.push(url)
        const response = await reply(new URL(url))
        return { status: response.status ?? 200, text: response.raw ?? JSON.stringify(response.body), headers: response.headers ?? {} }
      },
      async download(url) {
        requests.push(url)
        const parsed = new URL(url)
        assert.equal(parsed.origin, 'https://huggingface.co')
        assert.match(parsed.pathname, /^\/api\/models\//)
        const response = await reply(parsed)
        const bytes = new TextEncoder().encode(response.raw ?? JSON.stringify(response.body))
        const resource = { id: resources.size, size: response.size ?? bytes.length }
        resources.set(resource, { bytes, stalled: response.stalled })
        return resource
      },
    },
    resources: {
      async readBytes(resource, { offset, length }) {
        const { bytes, stalled } = resources.get(resource)
        if (stalled) return { data: new Uint8Array(), eof: false }
        const data = bytes.slice(offset, offset + length)
        return { data, eof: offset + data.length >= bytes.length }
      },
      async release(resource) { released.push(resource) },
    },
  }
  return { discovery: createDiscovery(context), context, requests, resources, released }
}

const metadata = {
  tags: ['gguf', 'text-generation', 'en', 'license:mit', 'base_model:example/base', 'region:us', 'endpoints_compatible'],
  baseModels: ['example/base'],
  pipelineTag: 'text-generation',
  libraryName: 'transformers',
  likes: 0,
  downloads: 42,
  updated: '2025-03-01T00:00:00.000Z',
  license: 'apache-2.0',
  gated: false,
  source: 'huggingface',
}
const upstreamMetadata = {
  tags: metadata.tags,
  pipeline_tag: metadata.pipelineTag,
  library_name: metadata.libraryName,
  likes: metadata.likes,
  downloads: metadata.downloads,
  lastModified: metadata.updated,
  cardData: { license: metadata.license },
  gated: false,
}

function assertMetadata(actual, expected = metadata) {
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected)
}

test('HF search requests supported expansion fields and preserves upstream metadata and system tags', async () => {
  const { discovery, requests } = fixture(() => ({ body: [model(upstreamMetadata)] }))
  const { items, errors } = await discovery.search({ kind: 'chat', query: 'example' })
  assert.deepEqual(errors, [])
  assert.equal(items.length, 1)
  assert.equal(items[0].recipe, 'chat')
  assert.equal(items[0].repository, repository)
  assertMetadata(items[0])
  const url = new URL(requests[0])
  assert.equal(url.pathname, '/api/models')
  assert.equal(url.searchParams.get('filter'), null)
  assert.equal(url.searchParams.get('pipeline_tag'), 'text-generation')
  assert.deepEqual(url.searchParams.getAll('expand').sort(), ['downloads', 'lastModified', 'gated', 'tags', 'pipeline_tag', 'library_name', 'likes', 'siblings', 'sha'].sort())
})

test('missing or malformed metadata stays unknown instead of inheriting the requested recipe', async () => {
  const { discovery } = fixture(() => ({ body: [model({ tags: ['region:us', null, 7], likes: '42', downloads: -1, pipeline_tag: false, library_name: {}, lastModified: '' }), { id: 'invalid' }] }))
  const { items } = await discovery.search({ kind: 'image' })
  assert.equal(items.length, 1)
  assert.equal(items[0].recipe, null)
  assertMetadata(items[0], { tags: ['region:us'], pipelineTag: null, libraryName: null, likes: null, downloads: null, updated: null, license: null, gated: false, source: 'huggingface' })
  const empty = fixture(() => ({ body: [model({})] }))
  assert.deepEqual((await empty.discovery.search({ kind: 'chat' })).items[0].tags, [])
})

test('licenses retain multiple declared values and fall back only to real license tags', async () => {
  const { discovery } = fixture(() => ({ body: [
    model({ cardData: { license: ['mit', 'apache-2.0'] }, tags: ['license:other'] }),
    model({ id: 'example/second', tags: ['license:mit', 'license:apache-2.0', 'license:'] }),
  ] }))
  const { items } = await discovery.search({ kind: 'chat' })
  assert.equal(items[0].license, 'mit, apache-2.0')
  assert.equal(items[1].license, 'mit, apache-2.0')
})

test('exact HF repository discovery uses real tasks without hiding incompatible formats', async (t) => {
  const cases = [
    ['chat', { pipeline_tag: 'text-generation', siblings: siblings('model.gguf') }, ['chat']],
    ['tag-only chat', { tags: ['text-generation'], siblings: siblings('model.gguf') }, ['chat']],
    ['vision', { pipeline_tag: 'image-text-to-text', siblings: siblings('model.gguf', 'mmproj.gguf') }, ['vision']],
    ['vision with text-generation pipeline', { pipeline_tag: 'text-generation', siblings: siblings('model.gguf', 'mmproj.gguf') }, ['vision']],
    ['vision files without task', { siblings: siblings('model.gguf', 'mmproj.gguf') }, ['vision']],
    ['ASR without task', { tags: ['onnx'], siblings: siblings('encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt') }, [null]],
    ['TTS without task', { siblings: siblings('model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/phontab') }, [null]],
    ['image', { pipeline_tag: 'text-to-image', siblings: siblings('sdxl.safetensors') }, ['image']],
    ['unknown GGUF', { siblings: siblings('model.gguf') }, ['chat']],
    ['embedding GGUF', { pipeline_tag: 'feature-extraction', tags: ['conversational'], siblings: siblings('model.gguf') }, [null]],
    ['diffusion GGUF is not chat', { pipeline_tag: 'text-to-image', siblings: siblings('model.gguf') }, ['image']],
    ['ASR task', { pipeline_tag: 'automatic-speech-recognition', siblings: siblings('encoder.onnx', 'decoder.onnx', 'tokens.txt') }, ['asr']],
    ['TTS task', { pipeline_tag: 'text-to-speech', siblings: siblings('model.onnx', 'voices.bin', 'tokens.txt') }, ['tts']],
  ]
  for (const [name, data, expected] of cases) {
    await t.test(name, async () => {
      const { discovery, requests, released } = fixture(() => ({ body: model(data) }))
      const { items, errors, nextCursor } = await discovery.search({ kind: 'all', query: `https://huggingface.co/${repository}/` })
      assert.deepEqual(items.map(item => item.recipe), expected)
      assert.equal(requests.length, 1)
      assert.equal(new URL(requests[0]).pathname, `/api/models/${repository}`)
      assert.equal(released.length, 1)
      assert.equal(nextCursor, null)
      assert.deepEqual(errors, [])
      assert.equal(items[0].source, 'huggingface')
      assert.equal(items[0].repository, repository)
    })
  }
})

test('explicit repository search always shows its real task instead of hiding a kind mismatch', async () => {
  const { discovery } = fixture(() => ({ body: model({ ...upstreamMetadata, siblings: siblings('model.gguf') }) }))
  const found = await discovery.search({ kind: 'chat', query: repository })
  assertMetadata(found.items[0])
  const explicit = await discovery.search({ kind: 'image', query: repository })
  assert.equal(explicit.items[0].recipe, 'chat')
  assert.deepEqual(explicit.errors, [])
})

test('vision detection and requested recipes cannot bypass required weights or projector', async () => {
  for (const [task, files, missing] of [
    [{ pipeline_tag: 'image-text-to-text' }, ['model.gguf'], ['视觉投影']],
    [{ pipeline_tag: 'image-text-to-text' }, ['mmproj.gguf'], ['模型权重']],
    [{ pipeline_tag: 'text-generation', tags: ['image-text-to-text'] }, ['model.gguf'], ['视觉投影']],
  ]) {
    const { discovery } = fixture(() => ({ body: model({ ...task, siblings: siblings(...files) }) }))
    const detail = await discovery.inspect({ recipe: 'chat', repository })
    assert.equal(detail.recipe, 'vision')
    assert.deepEqual(detail.missing, missing)
    await assert.rejects(discovery.resolve({ key: detail.key }), /需要补充|GGUF/)
  }
})

test('GGUF adapters and standalone components cannot become chat weights', async () => {
  for (const filename of ['lora.gguf', 'adapter.gguf', 'clip.gguf', 'vae.gguf', 'controlnet.gguf', 'text_encoder.gguf']) {
    const { discovery } = fixture(() => ({ body: model({ pipeline_tag: 'text-generation', siblings: siblings(filename) }) }))
    const detail = await discovery.inspect({ recipe: 'chat', repository })
    assert.deepEqual(detail.missing, ['模型权重'])
    await assert.rejects(discovery.resolve({ key: detail.key, selection: { model: filename } }), /需要补充模型权重/)
  }
})

test('inspect rejects traversal repository names before requesting metadata', async () => {
  const { discovery, requests } = fixture(() => ({ body: model({}) }))
  for (const repository of ['../model', 'example/..', './model', 'example/.']) await assert.rejects(discovery.inspect({ repository }), /模型仓库地址不合法/)
  assert.equal(requests.length, 0)
})

test('inspect and resolve preserve metadata, fixed revision, safe choices and upstream hashes', async () => {
  const filename = 'weights/model Q4_K_M.gguf'
  const { discovery, requests } = fixture(() => ({ body: model({
    ...upstreamMetadata,
    siblings: [{ rfilename: filename, size: 2048, lfs: { sha256: hash, size: 2048 } }, { rfilename: '../unsafe.gguf' }],
  }) }))
  const inspected = await discovery.inspect({ recipe: 'chat', repository, revision })
  assertMetadata(inspected)
  assert.equal(inspected.recipe, 'chat')
  assert.equal(inspected.repository, repository)
  assert.equal(inspected.revision, revision)
  assert.deepEqual(inspected.missing, [])
  assert.equal(inspected.roles.length, 1)
  assert.deepEqual(inspected.roles[0].choices, [{ path: filename, bytes: 2048, sha256: hash, url: `https://huggingface.co/${repository}/resolve/${revision}/weights/model%20Q4_K_M.gguf` }])
  const url = new URL(requests[0])
  assert.equal(url.pathname, `/api/models/${repository}/revision/${revision}`)
  assert.equal(url.searchParams.get('blobs'), 'true')
  const resolved = await discovery.resolve({ key: inspected.key, selection: { model: filename }, title: 'My model' })
  assert.deepEqual(resolved.metadata, { ...metadata, capabilities: {} })
  assert.deepEqual(resolved.origin, { source: 'huggingface', repository, revision })
  assert.equal(resolved.recipe, 'chat')
  assert.equal(resolved.title, 'My model')
  assert.deepEqual(resolved.specification.files, [{ path: filename, source: filename, url: inspected.roles[0].choices[0].url, sha256: hash, size: 2048 }])
  await assert.rejects(discovery.resolve({ key: inspected.key, selection: { model: '../unsafe.gguf' } }), /请选择模型权重/)
})

test('pinned Hub structured capabilities are preserved as declarations, not inferred from tags or a base model', async () => {
  const capabilities = { toolCall: false, reasoningOptions: ['off', 'medium'], contextWindow: 65536, input: ['text'] }
  const { discovery } = fixture(() => ({ body: model({ cardData: { base_model: 'example/base', base_model_relation: 'finetune', capabilities }, tags: ['tools', 'reasoning'], siblings: [{ rfilename: 'model.gguf', size: 2048, lfs: { sha256: hash, size: 2048 } }] }) }))
  const inspected = await discovery.inspect({ recipe: 'chat', repository, revision })
  const resolved = await discovery.resolve({ key: inspected.key, selection: { model: 'model.gguf' } })
  assert.deepEqual(resolved.metadata.capabilities, capabilities)
  assert.equal(resolved.metadata.baseModelRelation, undefined)
  assert.deepEqual(resolved.origin, { source: 'huggingface', repository, revision })
})

test('restricted models retain inspectable metadata but cannot be resolved', async () => {
  const { discovery } = fixture(() => ({ body: model({ ...upstreamMetadata, gated: 'manual', siblings: siblings('model.gguf') }) }))
  assert.equal((await discovery.search({ query: repository })).items[0].gated, true)
  const detail = await discovery.inspect({ recipe: 'chat', repository })
  assert.equal(detail.availability.code, 'access')
  assert.match(detail.unavailableReason, /申请访问.*导入本地模型/)
  assertMetadata(detail, { ...metadata, gated: true })
  await assert.rejects(discovery.resolve({ key: detail.key, selection: { model: 'model.gguf' } }), /申请访问/)
})

test('inspect preserves unpinned metadata while resolve rejects it', async () => {
  const unpinned = fixture(() => ({ body: model({ sha: 'main' }) }))
  const detail = await unpinned.discovery.inspect({ recipe: 'chat', repository })
  assert.equal(detail.revision, null)
  assert.match(detail.unavailableReason, /未提供可固定的版本/)
  await assert.rejects(unpinned.discovery.resolve({ key: detail.key }), /未提供可固定的版本/)
})

test('search reports rate limits, invalid API shapes and invalid input explicitly', async () => {
  const limited = fixture(() => ({ status: 429, body: {} }))
  await assert.rejects(limited.discovery.search({ kind: 'chat' }), /来源请求额度暂时用尽/)
  const invalidList = fixture(() => ({ body: { error: 'invalid' } }))
  await assert.rejects(invalidList.discovery.search({ kind: 'chat' }), /无效的列表/)
  await assert.rejects(invalidList.discovery.search({ query: repository }), /无效的仓库信息/)
  await assert.rejects(invalidList.discovery.search({ query: 'x'.repeat(301) }), /请选择 Hugging Face 目录支持的模型用途/)
  await assert.rejects(invalidList.discovery.search({ kind: 'unsupported' }), /请选择 Hugging Face 目录支持的模型用途/)
})

test('image adapters retain their task but require a base model', async () => {
  const adapter = fixture(() => ({ body: model({ pipeline_tag: 'text-to-image', tags: ['lora'], siblings: siblings('weights.safetensors') }) }))
  assert.equal((await adapter.discovery.search({ query: repository })).items[0].recipe, 'image')
  const detail = await adapter.discovery.inspect({ recipe: 'image', repository })
  assert.equal(detail.availability.code, 'adapter')
  assert.deepEqual(detail.roles, [])
  await assert.rejects(adapter.discovery.resolve({ key: detail.key }), /基础模型/)
})

test('import never fetches unhashed files and download rejects unbounded hash prefetch', async () => {
  for (const [mode, size, message] of [['import', 12, /暂不支持直接导入/], ['download', 17 * 1024 ** 2, /SHA-256/], ['download', undefined, /SHA-256/]]) {
    const { discovery, requests } = fixture(() => ({ body: model({ pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.gguf', size }] }) }))
    const detail = await discovery.inspect({ recipe: 'chat', repository })
    await assert.rejects(discovery.resolve({ key: detail.key, selection: { model: 'model.gguf' }, mode }), message)
    assert.ok(requests.every(url => new URL(url).pathname.startsWith('/api/models/')))
  }
})

test('cancelling catalog verification aborts its download without yielding a model', async () => {
  const { discovery, context } = fixture(() => ({ body: model({ pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.gguf', size: 12 }] }) }))
  const detail = await discovery.inspect({ recipe: 'chat', repository })
  const started = Promise.withResolvers()
  context.network.download = async (_url, { signal }) => {
    started.resolve()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const controller = new AbortController()
  const resolving = discovery.resolve({ key: detail.key, selection: { model: 'model.gguf' } }, { signal: controller.signal })
  await started.promise
  controller.abort(new Error('Cancelled verification'))
  await assert.rejects(resolving, /Cancelled verification/)
})

test('cancelling while temporary files are released cannot return an installable model', async () => {
  const { discovery, context } = fixture(() => ({ body: model({ pipeline_tag: 'text-generation', siblings: [{ rfilename: 'model.gguf', size: 3 }] }) }))
  const detail = await discovery.inspect({ recipe: 'chat', repository })
  const releasing = Promise.withResolvers()
  const released = Promise.withResolvers()
  context.network.download = async () => ({ id: 'weights', size: 3 })
  context.resources.readBytes = async () => ({ data: new TextEncoder().encode('abc'), eof: true })
  context.resources.release = async () => { releasing.resolve(); await released.promise }
  const controller = new AbortController()
  const resolving = discovery.resolve({ key: detail.key, selection: { model: 'model.gguf' } }, { signal: controller.signal })
  await releasing.promise
  controller.abort(new Error('Cancelled during cleanup'))
  released.resolve()
  await assert.rejects(resolving, /Cancelled during cleanup/)
})

test('exact repository metadata resource is released on oversized, invalid and stalled responses', async (t) => {
  for (const [name, response, error] of [
    ['oversized', { body: model({}), size: 4 * 1024 * 1024 + 1 }, /目录内容过大/],
    ['underreported size', { raw: JSON.stringify('x'.repeat(4 * 1024 * 1024)), size: 1 }, /目录内容过大/],
    ['invalid JSON', { raw: '{' }, SyntaxError],
    ['stalled', { body: model({}), stalled: true }, /目录读取未完成/],
  ]) {
    await t.test(name, async () => {
      const { discovery, resources, released } = fixture(() => response)
      await assert.rejects(discovery.search({ query: repository }), error)
      assert.deepEqual(released, [...resources.keys()])
    })
  }
})
