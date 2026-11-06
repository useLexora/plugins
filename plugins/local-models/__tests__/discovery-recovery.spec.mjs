import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

const revision = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const otherHash = 'c'.repeat(64)
const MiB = 1024 ** 2
const file = (rfilename, size = 1024, sha256 = hash) => ({ rfilename, size, ...(sha256 ? { lfs: { sha256 } } : {}) })
const model = (siblings, extra = {}) => ({ id: 'example/recovery', sha: revision, pipeline_tag: 'text-generation', siblings, ...extra })
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(data, weights = {}) {
  const weightDownloads = [], released = [], writes = []
  const context = {
    signal: new AbortController().signal,
    extension: { version: '1.0.0' },
    network: {
      async get() {
        return { status: 200, text: JSON.stringify([data]), headers: {} }
      },
      async download(address) {
        const url = new URL(address)
        assert.equal(url.origin, 'https://huggingface.co')
        let bytes
        if (url.pathname.startsWith('/api/models/')) {
          assert.equal(url.searchParams.get('blobs'), 'true')
          bytes = Buffer.from(JSON.stringify(data))
        } else {
          const prefix = `/${data.id}/resolve/${revision}/`
          assert.ok(url.pathname.startsWith(prefix))
          const path = decodeURIComponent(url.pathname.slice(prefix.length))
          weightDownloads.push(path)
          assert.ok(Object.hasOwn(weights, path), `不应预下载权重：${path}`)
          bytes = Buffer.from(weights[path])
        }
        return { id: address, bytes, size: bytes.length }
      },
    },
    resources: {
      async readBytes(resource, { offset, length }) {
        const data = resource.bytes.subarray(offset, offset + length)
        return { data, eof: offset + data.length === resource.bytes.length }
      },
      async release(resource) { released.push(resource.id) },
    },
  }
  const discovery = createDiscovery(context, { persist: async value => { writes.push(value) } })
  return { discovery, weightDownloads, released, writes }
}

const inspect = fx => fx.discovery.inspect({ repository: 'example/recovery', revision })

test('完整分片在详情只显示首片，清单展开每片并保留独立大小、哈希和固定版本 URL', async () => {
  const first = file('weights/model Q4-00001-of-00002.gguf', 32 * MiB, hash)
  const second = file('weights/model Q4-00002-of-00002.gguf', 24 * MiB, otherHash)
  const projector = file('mmproj.gguf', 8 * MiB, 'd'.repeat(64))
  const fx = fixture(model([second, projector, first], { pipeline_tag: 'image-text-to-text' }))
  const page = await fx.discovery.search({ availability: 'installable' })
  assert.equal(page.items[0].availability.state, 'installable')
  const detail = await inspect(fx)
  const choices = detail.roles.find(role => role.id === 'model').choices
  assert.equal(choices.length, 1)
  assert.equal(choices[0].path, first.rfilename)
  assert.deepEqual(choices[0].parts.map(part => part.path), [first.rfilename, second.rfilename])
  const selection = { model: first.rfilename, projector: projector.rfilename }
  const result = await fx.discovery.resolve({ key: detail.key, selection })
  assert.deepEqual(result.files, selection)
  assert.equal(result.specification.bytes, 64 * MiB)
  assert.deepEqual(result.specification.files, [first, second, projector].map(part => ({
    path: part.rfilename,
    source: part.rfilename,
    size: part.size,
    sha256: part.lfs.sha256,
    url: `https://huggingface.co/example/recovery/resolve/${revision}/${part.rfilename.split('/').map(encodeURIComponent).join('/')}`,
  })))
  assert.deepEqual(fx.weightDownloads, [])
})

test('后续分片缺 hash 仍可修复，未补校验时拒绝大权重预下载，补齐后全部进入清单', async () => {
  const first = file('model-00001-of-00002.gguf', 1024 * MiB, hash)
  const second = file('model-00002-of-00002.gguf', 32 * MiB, null)
  const fx = fixture(model([second, first]))
  const page = await fx.discovery.search({ availability: 'installable' })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].availability.state, 'unverified')
  assert.equal(page.items[0].availability.code, 'checksum')
  const detail = await inspect(fx)
  assert.equal(detail.unavailableReason, null)
  const request = { key: detail.key, selection: { model: first.rfilename } }
  await assert.rejects(fx.discovery.resolve(request), /SHA-256.*导入本地模型/)
  const checksums = { [first.rfilename]: otherHash, [second.rfilename]: ` ${otherHash.toUpperCase()} ` }
  const resolved = await fx.discovery.resolve({ ...request, checksums })
  assert.equal(resolved.files.model, first.rfilename)
  assert.equal(resolved.specification.bytes, 1056 * MiB)
  assert.deepEqual(resolved.specification.files.map(part => [part.path, part.sha256, part.size]), [[first.rfilename, hash, 1024 * MiB], [second.rfilename, otherHash, 32 * MiB]])
  assert.deepEqual(fx.weightDownloads, [])
  assert.ok(fx.writes.every(cache => !cache.entries.some(entry => entry.repository === 'example/recovery')))
  await assert.rejects(fx.discovery.resolve(request), /SHA-256/)
})

test('缺失校验只接受 64hex', async t => {
  const fx = fixture(model([file('model.gguf', 32 * MiB, null)]))
  const detail = await inspect(fx)
  const request = { key: detail.key, selection: { model: 'model.gguf' } }
  for (const value of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'sha256:' + hash]) {
    await t.test(value.slice(0, 12) + `/${value.length}`, async () => {
      await assert.rejects(fx.discovery.resolve({ ...request, checksums: { 'model.gguf': value } }), /model\.gguf.*SHA-256.*64/)
    })
  }
  assert.deepEqual(fx.weightDownloads, [])
})

test('分片总预读取预算超过 16MiB 时不会先下载某一小片', async () => {
  const first = file('model-00001-of-00002.gguf', 9 * MiB, null)
  const second = file('model-00002-of-00002.gguf', 8 * MiB, null)
  const fx = fixture(model([first, second]))
  const detail = await inspect(fx)
  assert.equal(detail.availability.state, 'unverified')
  assert.equal(detail.availability.code, 'checksum')
  assert.equal(detail.unavailableReason, null)
  await assert.rejects(fx.discovery.resolve({ key: detail.key, selection: { model: first.rfilename } }), /SHA-256/)
  assert.deepEqual(fx.weightDownloads, [])
})

test('预算内小分片分别计算真实 hash 与大小，随后释放每片临时资源', async () => {
  const first = 'model-00001-of-00002.gguf', second = 'model-00002-of-00002.gguf'
  const weights = { [first]: 'first', [second]: 'second shard' }
  const fx = fixture(model([file(second, 12, null), file(first, 5, null)]), weights)
  const detail = await inspect(fx)
  assert.equal(detail.availability.state, 'installable')
  const result = await fx.discovery.resolve({ key: detail.key, selection: { model: first } })
  assert.equal(result.specification.bytes, 17)
  assert.deepEqual(result.specification.files.map(part => [part.path, part.size, part.sha256]), [first, second].map(path => [path, Buffer.byteLength(weights[path]), checksum(weights[path])]))
  assert.deepEqual(fx.weightDownloads, [first, second])
  assert.ok(result.specification.files.every(part => fx.released.includes(part.url)))
})

test('手动选择 chat、vision、asr、tts 后生成对应清单，不改写自动分类缓存', async t => {
  const cases = [
    ['chat', ['model.gguf'], { model: 'model.gguf' }],
    ['vision', ['model.gguf', 'mmproj.gguf'], { model: 'model.gguf', projector: 'mmproj.gguf' }],
    ['asr', ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'], { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' }],
    ['tts', ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/en_dict'], { model: 'model.onnx', voices: 'voices.bin', tokens: 'tokens.txt' }],
  ]
  for (const [recipeOverride, paths, selection] of cases) await t.test(recipeOverride, async () => {
    const fx = fixture(model(paths.map(path => file(path)), { pipeline_tag: 'feature-extraction' }))
    const automatic = await fx.discovery.inspect({ repository: 'example/recovery', revision, recipe: recipeOverride })
    assert.equal(automatic.recipe, null)
    assert.equal(automatic.availability.state, 'unsupported')
    assert.equal(automatic.availability.code, 'task')
    const detail = await fx.discovery.inspect({ repository: 'example/recovery', revision, recipeOverride })
    assert.equal(detail.recipe, recipeOverride)
    assert.equal(detail.availability.state, 'installable')
    assert.equal(detail.availability.code, 'inferred')
    assert.equal(detail.unavailableReason, null)
    const manifest = await fx.discovery.resolve({ key: detail.key, selection })
    assert.equal(manifest.recipe, recipeOverride)
    assert.deepEqual(manifest.files, selection)
    assert.deepEqual(manifest.specification.files.map(part => part.path), paths)
    assert.ok(fx.writes.at(-1).entries.some(entry => entry.repository === 'example/recovery' && entry.state === 'unsupported' && entry.code === 'task'))
    assert.ok(fx.writes.every(cache => !cache.entries.some(entry => entry.state === 'installable')))
    assert.equal((await inspect(fx)).availability.code, 'task')
  })
})

test('手动加载方式不接受未开放的 recipe', async () => {
  const fx = fixture(model([file('model.gguf')]))
  await assert.rejects(fx.discovery.inspect({ repository: 'example/recovery', recipeOverride: 'image' }), /有效的加载方式/)
})
