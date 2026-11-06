import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'
import { zImageTurbo, zImageTurboFiles } from '../native/image/recipes.mjs'

const diffusion = zImageTurboFiles[0]
const upstream = { id: zImageTurbo.repository, sha: zImageTurbo.revision, pipeline_tag: 'text-to-image', siblings: [{ rfilename: diffusion.path, size: diffusion.bytes, lfs: { sha256: diffusion.sha256 } }] }
function fixture(data) {
  const requests = []
  const discovery = createDiscovery({
    signal: new AbortController().signal,
    network: {
      get: async url => { requests.push(url); return { status: 200, headers: {}, text: JSON.stringify([data]) } },
      download: async url => { requests.push(url); assert.match(new URL(url).pathname, /^\/api\/models\//); const bytes = new TextEncoder().encode(JSON.stringify(data)); return { bytes, size: bytes.length } },
    },
    resources: { readBytes: async resource => ({ data: resource.bytes, eof: true }), release: async () => {} },
  })
  return { discovery, requests }
}

test('audited Z-Image revision resolves a complete independently pinned three-component recipe', async () => {
  const { discovery, requests } = fixture(upstream)
  const listed = (await discovery.search({ kind: 'image' })).items[0]
  assert.equal(listed.availability.state, 'installable')
  const detail = await discovery.inspect({ repository: upstream.id })
  assert.equal(detail.imageArchitecture, 'z-image-turbo')
  assert.deepEqual(detail.roles.map(role => role.id), ['diffusion', 'llm', 'vae'])
  const resolved = await discovery.resolve({ key: detail.key, selection: Object.fromEntries(detail.roles.map(role => [role.id, role.choices[0].path])) })
  assert.equal(resolved.imageArchitecture, 'z-image-turbo')
  assert.equal(resolved.specification.bytes, 6696835812)
  assert.deepEqual(resolved.specification.files.map(file => [file.path, file.sha256, file.size]), zImageTurboFiles.map(file => [file.path, file.sha256, file.bytes]))
  assert.deepEqual(resolved.specification.files.map(file => file.url), zImageTurboFiles.map(file => file.url))
  assert.ok(requests.every(url => new URL(url).pathname.startsWith('/api/models')))
})

test('a familiar filename, quantization label or upstream identity is not sufficient compatibility evidence', async () => {
  for (const data of [
    { ...upstream, sha: '1'.repeat(40) },
    { ...upstream, id: 'other/Z-Image-Turbo-GGUF' },
    { ...upstream, id: 'unsloth/Z-Image-Turbo-FP8', siblings: [{ rfilename: 'Z-Image-Turbo-FP8.safetensors', size: 6290000000, lfs: { sha256: 'a'.repeat(64) } }] },
  ]) {
    const { discovery } = fixture(data)
    const detail = await discovery.inspect({ repository: data.id })
    assert.equal(detail.availability.state, 'unverified')
    assert.equal(detail.availability.code, 'components')
    assert.match(detail.unavailableReason, /导入本地模型/)
    assert.deepEqual(detail.roles, [])
    await assert.rejects(discovery.resolve({ key: detail.key }), /完整的生图组件/)
    assert.deepEqual((await discovery.search({ kind: 'image', availability: 'installable' })).items, [])
  }
})

test('pinned recipe retains known integrity values despite incomplete upstream metadata', async () => {
  for (const sibling of [{ rfilename: diffusion.path }, { ...upstream.siblings[0], lfs: { sha256: 'a'.repeat(64) } }, { ...upstream.siblings[0], size: diffusion.bytes - 1 }]) {
    const { discovery } = fixture({ ...upstream, siblings: [sibling] })
    const detail = await discovery.inspect({ repository: upstream.id })
    const resolved = await discovery.resolve({ key: detail.key, selection: Object.fromEntries(detail.roles.map(role => [role.id, role.choices[0].path])) })
    assert.equal(resolved.specification.files[0].sha256, diffusion.sha256)
    assert.equal(resolved.specification.files[0].size, diffusion.bytes)
  }
  const { discovery } = fixture({ ...upstream, siblings: undefined })
  assert.equal((await discovery.search()).items[0].availability.state, 'unverified')
})
