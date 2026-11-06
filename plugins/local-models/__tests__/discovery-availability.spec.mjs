import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

const sha = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const MiB = 1024 ** 2
const model = (name, files, extra = {}) => ({ id: `example/${name}`, sha, pipeline_tag: 'text-generation', siblings: files.map(rfilename => ({ rfilename })), ...extra })
function fixture(rows, details = rows) {
  const requests = []
  const discovery = createDiscovery({
    signal: new AbortController().signal,
    network: {
      get: async url => { requests.push(url); return { status: 200, text: JSON.stringify(rows), headers: {} } },
      download: async url => {
        requests.push(url)
        const parsed = new URL(url)
        assert.equal(parsed.searchParams.get('blobs'), 'true')
        assert.match(parsed.pathname, /^\/api\/models\//)
        const repository = parsed.pathname.replace('/api/models/', '').split('/revision/')[0]
        const bytes = new TextEncoder().encode(JSON.stringify(details.find(row => row.id === repository)))
        return { id: 'metadata', size: bytes.length, bytes }
      },
    },
    resources: {
      readBytes: async resource => ({ data: resource.bytes, eof: true }),
      release: async () => {},
    },
  })
  return { discovery, requests }
}

test('catalog reports known installation restrictions from one page and agrees with detail checks', async (t) => {
  const cases = [
    model('safetensors', ['config.json', 'model.safetensors'], { tags: ['safetensors'] }),
    model('vision-without-projector', ['model.gguf'], { pipeline_tag: 'image-text-to-text' }),
    model('incomplete-sharded-gguf', ['model-00001-of-00002.gguf']),
    model('embedding', ['model.safetensors'], { pipeline_tag: 'feature-extraction' }),
    model('adapter', ['adapter_config.json', 'adapter_model.safetensors'], { library_name: 'peft' }),
    model('gated', ['model.gguf'], { gated: 'manual' }),
    model('empty', []),
    model('tts-without-phonemes', ['model.onnx', 'voices.bin', 'tokens.txt'], { pipeline_tag: 'text-to-speech' }),
    model('split-image', ['unet/diffusion_pytorch_model.safetensors'], { pipeline_tag: 'text-to-image' }),
    { id: 'example/embedding-without-files', pipeline_tag: 'feature-extraction' },
    { id: 'example/gated-without-files', gated: 'manual' },
    { id: 'example/adapter-without-files', library_name: 'peft' },
  ]
  const { discovery, requests } = fixture(cases)
  const page = await discovery.search()
  assert.equal(requests.length, 1)
  assert.equal(page.items.length, cases.length)
  for (const item of page.items) await t.test(item.title, async () => {
    assert.equal(item.availability.state, item.recipe === 'image' ? 'unverified' : 'unsupported')
    const detail = await discovery.inspect(item)
    assert.equal(item.availability.reason, detail.unavailableReason)
    await assert.rejects(discovery.resolve({ key: detail.key }), { message: detail.unavailableReason })
  })
})

test('cards verify candidate checksums against the pinned revision and agree with inspect', async () => {
  const rows = [
    model('mixed-format-chat', ['model.safetensors', 'model.gguf'], { tags: ['safetensors'], downloads: 42, likes: 0 }),
    model('sharded-gguf', ['model-00002-of-00002.gguf', 'model-00001-of-00002.gguf']),
    model('vision', ['model.gguf', 'mmproj.gguf'], { pipeline_tag: 'image-text-to-text' }),
    model('tts', ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/en_dict'], { pipeline_tag: 'text-to-speech' }),
  ]
  const details = rows.map(row => ({ ...row, downloads: undefined, likes: undefined, siblings: row.siblings.map(file => ({ ...file, size: 32 * MiB, lfs: { sha256: hash } })) }))
  const { discovery, requests } = fixture(rows, details)
  const { items } = await discovery.search()
  assert.equal(items[0].downloads, 42)
  assert.equal(items[0].likes, 0)
  assert.ok(requests.slice(1).every(url => new URL(url).pathname.endsWith(`/revision/${sha}`)))
  for (const item of items) {
    assert.equal(item.availability.state, 'installable')
    assert.match(item.availability.reason, /不代表本机运行或硬件兼容性/)
    const detail = await discovery.inspect(item)
    assert.equal(detail.unavailableReason, null)
    assert.deepEqual(detail.availability, item.availability)
  }
})

test('omitted file or revision metadata is not treated as proof of unsupported format', async () => {
  const { discovery } = fixture([
    { id: 'example/incomplete', pipeline_tag: 'text-generation', tags: ['safetensors'], sha },
    model('without-revision', ['model.safetensors'], { sha: undefined }),
  ])
  const { items } = await discovery.search()
  for (const item of items) {
    assert.equal(item.availability.state, 'unverified')
    assert.match(item.availability.reason, /文件信息尚不完整|未提供可固定的版本/)
  }
})

test('精确仓库查询不被安装筛选隐藏，返回真实状态供用户修复', async () => {
  const detailed = [
    model('official', ['model.safetensors']),
    model('missing-checksum', [], { siblings: [{ rfilename: 'model.gguf', size: 32 * MiB }] }),
  ]
  const { discovery } = fixture(detailed)
  for (const [query, state, code] of [['example/official', 'unsupported', 'format'], ['example/missing-checksum', 'unverified', 'checksum']]) {
    const normal = await discovery.search({ query })
    assert.equal(normal.nextCursor, null)
    assert.equal(normal.pageComplete, true)
    assert.equal(normal.items[0].availability.state, state)
    assert.equal(normal.items[0].availability.code, code)
    const filtered = await discovery.search({ query, availability: 'installable' })
    assert.deepEqual(filtered.items, normal.items)
    assert.equal(filtered.nextCursor, null)
    assert.equal(filtered.pageComplete, true)
  }
})

test('用途缺失时 GGUF 可推断候选，完整模型不因 LoRA 标签被封禁', async () => {
  const rows = [
    model('unknown', ['model.gguf'], { pipeline_tag: undefined }),
    model('vision', ['model.gguf', 'mmproj.gguf'], { pipeline_tag: undefined }),
    model('merged-lora', ['model.gguf', 'adapter_config.json'], { tags: ['lora'], library_name: 'peft' }),
  ]
  const details = rows.map(row => ({ ...row, siblings: row.siblings.map(file => ({ ...file, size: 32 * MiB, lfs: { sha256: hash } })) }))
  const { discovery } = fixture(rows, details)
  const { items } = await discovery.search({ availability: 'installable' })
  assert.deepEqual(items.map(item => item.recipe), ['chat', 'vision', 'chat'])
  for (const item of items) {
    assert.equal(item.availability.state, 'installable')
    assert.equal(item.availability.code, 'inferred')
    assert.match(item.availability.reason, /尝试|兼容性/)
    const detail = await discovery.inspect(item)
    assert.equal(detail.unavailableReason, null)
    assert.deepEqual(detail.availability, item.availability)
    const selection = Object.fromEntries(detail.roles.map(role => [role.id, role.choices[0].path]))
    const resolved = await discovery.resolve({ key: detail.key, selection })
    assert.equal(resolved.recipe, item.recipe)
    assert.deepEqual(resolved.files, selection)
  }
})

test('candidate hash budgets require known small sizes or upstream SHA-256, without downloading weights', async (t) => {
  const file = (rfilename, size, sha256) => ({ rfilename, size, ...(sha256 ? { lfs: { sha256 } } : {}) })
  const chat = siblings => model('chat', [], { siblings })
  const vision = siblings => model('vision', [], { pipeline_tag: 'image-text-to-text', siblings })
  const tts = siblings => model('tts', [], { pipeline_tag: 'text-to-speech', siblings })
  const cases = [
    ['large unhashed', chat([file('model.gguf', 17 * MiB)]), 'unverified'],
    ['unknown size', chat([file('model.gguf')]), 'unverified'],
    ['negative size', chat([file('model.gguf', -1)]), 'unverified'],
    ['string size', chat([file('model.gguf', '1')]), 'unverified'],
    ['small known unhashed', chat([file('model.gguf', 16 * MiB)]), 'installable'],
    ['invalid upstream hash', chat([file('model.gguf', 17 * MiB, 'not-a-hash')]), 'unverified'],
    ['large hashed', chat([file('model.gguf', 1024 * MiB, hash)]), 'installable'],
    ['one safe alternative', chat([file('huge.gguf', 20 * MiB), file('small.gguf', 2 * MiB)]), 'installable'],
    ['aggregate role budget', vision([file('model.gguf', 9 * MiB), file('mmproj.gguf', 8 * MiB)]), 'unverified'],
    ['aggregate shard budget', chat([file('model-00001-of-00002.gguf', 9 * MiB), file('model-00002-of-00002.gguf', 8 * MiB)]), 'unverified'],
    ['shard budget at boundary', chat([file('model-00002-of-00002.gguf', 8 * MiB), file('model-00001-of-00002.gguf', 8 * MiB)]), 'installable'],
    ['unhashed later shard', chat([file('model-00001-of-00002.gguf', 1024 * MiB, hash), file('model-00002-of-00002.gguf', 17 * MiB)]), 'unverified'],
    ['hashed shards', chat([file('model-00001-of-00002.gguf', 1024 * MiB, hash), file('model-00002-of-00002.gguf', 1024 * MiB, hash)]), 'installable'],
    ['aggregate at boundary', vision([file('model.gguf', 8 * MiB), file('mmproj.gguf', 8 * MiB)]), 'installable'],
    ['unknown projector', vision([file('model.gguf', 30 * MiB, hash), file('mmproj.gguf')]), 'unverified'],
    ['phoneme budget', tts([file('model.onnx', 30 * MiB, hash), file('voices.bin', 30 * MiB, hash), file('tokens.txt', MiB), file('espeak-ng-data/en_dict', 16 * MiB)]), 'unverified'],
    ['optional lexicon may be omitted', tts([file('model.onnx', 30 * MiB, hash), file('voices.bin', 30 * MiB, hash), file('tokens.txt', MiB), file('espeak-ng-data/en_dict', MiB), file('lexicon.txt', 30 * MiB)]), 'installable'],
  ]
  for (const [name, detailed, expected] of cases) await t.test(name, async () => {
    const listing = { ...detailed, siblings: detailed.siblings.map(({ rfilename }) => ({ rfilename })) }
    const { discovery, requests } = fixture([listing], [detailed])
    const item = (await discovery.search()).items[0]
    assert.equal(item.availability.state, expected)
    const detail = await discovery.inspect(item)
    assert.deepEqual(detail.availability, item.availability)
    assert.equal(detail.unavailableReason, null)
    assert.equal(detail.availability.code, expected === 'installable' ? 'ready' : 'checksum')
    assert.ok(requests.every(url => new URL(url).pathname.startsWith('/api/models')))
  })
})
