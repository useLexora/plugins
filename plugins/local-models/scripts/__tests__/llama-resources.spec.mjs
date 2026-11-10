import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { releasePlan, selectFiles } from '../llama-resources.mjs'

const hash = 'a'.repeat(64)
test('materializes versioned library aliases from the same regular entry', () => {
  const files = selectFiles([
    { path: 'bundle/libllama.so.0.9.0', sha256: hash },
    { path: 'bundle/libllama.so.0', link: 'libllama.so.0.9.0' },
    { path: 'bundle/libllama.so', link: 'libllama.so.0' },
    { path: 'bundle/llama-server', sha256: hash },
    { path: 'bundle/llama-cli', sha256: hash },
    { path: 'bundle/LICENSE', sha256: hash },
  ], 'engine')
  assert.equal(files.length, 5)
  assert.ok(files.filter(file => file.path.startsWith('libllama')).every(file => file.archivePath === 'bundle/libllama.so.0.9.0' && file.sha256 === hash))
  assert.deepEqual(files.filter(file => file.executable).map(file => file.path), ['llama-server'])
  assert.ok(files.every(file => file.source === `engine/${file.path}`))
})

test('rejects escaping, cyclic, missing and case-colliding library entries', () => {
  for (const entries of [
    [{ path: 'bundle/libx.so', link: '../libx.so' }],
    [{ path: 'bundle/libx.so', link: 'libx.so' }],
    [{ path: 'bundle/libx.so', link: 'missing.so' }],
    [{ path: 'a/libx.dll', sha256: hash }, { path: 'b/libx.dll', sha256: hash }],
    [{ path: 'bundle/X.dll', sha256: hash }, { path: 'bundle/x.dll', sha256: hash }],
  ]) assert.throws(() => selectFiles(entries, 'engine'))
})

test('requires published fixed releases with complete official assets and SHA256', () => {
  assert.throws(() => releasePlan({ tag_name: 'latest' }))
  assert.throws(() => releasePlan({ tag_name: 'b12211', draft: true }))
  assert.throws(() => releasePlan({ tag_name: 'b12211', published_at: '2026-11-08', assets: [] }), /Missing official asset/)
  const asset = { name: 'llama-b12211-bin-ubuntu-vulkan-x64.tar.gz', digest: hash }
  assert.throws(() => releasePlan({ tag_name: 'b12211', published_at: '2026-11-08', assets: [asset] }))
})

const resources = JSON.parse(await readFile(new URL('../../resources.json', import.meta.url), 'utf8'))
const current = resources.filter(resource => resource.engineId === 'llama.cpp' && !resource.legacy)
test('five pinned llama variants retain executable, CPU backend and archive checksum contracts', () => {
  assert.deepEqual(current.map(resource => `${resource.backend}:${resource.platforms[0]}`).sort(), ['cuda:linux-x64', 'cuda:windows-x64', 'metal:macos-arm64', 'vulkan:linux-x64', 'vulkan:windows-x64'])
  for (const resource of current) {
    assert.equal(resource.title, 'llama.cpp')
    assert.equal(resource.version, 'b12211')
    assert.equal(resource.prerelease, true)
    assert.ok(resource.requirements.length > 0 && resource.requirements.every(value => typeof value === 'string' && value.length > 0))
    assert.equal(resource.id, `llama-${resource.backend}-${resource.platforms[0]}-${resource.version}`)
    assert.equal(resource.bytes, resource.archives.reduce((sum, archive) => sum + archive.size, 0))
    assert.equal(new Set(resource.files.map(file => file.path.toLowerCase())).size, resource.files.length)
    assert.equal(resource.files.filter(file => file.executable).length, 1)
    assert.ok(resource.files.some(file => file.path.includes('ggml-cpu')))
    for (const file of resource.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/)
      assert.ok(resource.archives.some(archive => archive.id === file.archive))
    }
    for (const archive of resource.archives) {
      assert.match(archive.sha256, /^[a-f0-9]{64}$/)
      assert.match(archive.name, /\.(tar\.gz|zip)$/)
      assert.ok(archive.unpackedBytes > 0)
      assert.ok(archive.source.url.startsWith(`https://github.com/ggml-org/llama.cpp/releases/download/${resource.version}/`))
    }
  }
})

test('CUDA ships official runtime dependencies beside the server rather than relying on a toolkit', () => {
  for (const resource of current.filter(resource => resource.backend === 'cuda')) {
    const windows = resource.platforms[0] === 'windows-x64'
    const dependencies = windows ? ['cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll'] : ['libcublas.so.13', 'libcublasLt.so.13', 'libcudart.so.13']
    assert.equal(resource.cudaRuntimeVersion, '13.5')
    assert.equal(resource.recommendedDriverBranch, 'R620')
    assert.equal(resource.archives.length, 2)
    assert.deepEqual(resource.files.filter(file => file.archive === 'cudart').map(file => file.path).sort(), dependencies.sort())
  }
})

test('legacy llama IDs remain available with explicit identity and backend metadata', () => {
  const old = resources.filter(resource => /^llama-b11747/.test(resource.id))
  assert.equal(old.length, 3)
  for (const resource of old) {
    assert.equal(resource.legacy, true)
    assert.equal(resource.engineId, 'llama.cpp')
    assert.equal(resource.version, 'b11747')
    assert.equal(resource.title, 'llama.cpp')
    assert.ok(resource.files.length && resource.archives.length)
  }
})
