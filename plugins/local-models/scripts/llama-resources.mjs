import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { t as listTar } from 'tar'
import { openPromise } from 'yauzl'
import { extractArchive } from '../src/preparation/prepare.mjs'
import { safePath } from '../src/preparation/zip.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const repository = 'https://api.github.com/repos/ggml-org/llama.cpp'
const requirements = {
  'vulkan:linux-x64': ['glibc >= 2.34；libstdc++ 提供 GLIBCXX_3.4.30', 'OpenSSL 3、libgomp.so.1；GPU 模式需要 Vulkan loader 与兼容驱动'],
  'vulkan:windows-x64': ['Microsoft Visual C++ x64 运行库', 'GPU 模式需要提供 vulkan-1.dll 的兼容 Vulkan 驱动'],
  'metal:macos-arm64': ['Apple Silicon；遵循宿主 macOS 15+ 基线', 'GPU 模式需要系统 Metal 支持'],
  'cuda:linux-x64': ['glibc >= 2.38；libstdc++ 提供 GLIBCXX_3.4.32', 'OpenSSL 3、libgomp.so.1；系统 NVIDIA 驱动提供 libcuda.so.1', 'CUDA 13.5：推荐 NVIDIA R620+；R580 仅为次版本兼容下限，不保证 PTX/JIT 或新功能可用', 'Turing / RTX 20 及更新架构；不支持更早 GPU；随资源提供 cudart/cuBLAS，无需安装 Toolkit'],
  'cuda:windows-x64': ['Microsoft Visual C++ x64 运行库', 'CUDA 13.5：推荐 NVIDIA R620+；R580 仅为次版本兼容下限，不保证 PTX/JIT 或新功能可用', 'Turing / RTX 20 及更新架构；不支持更早 GPU；随资源提供 cudart/cuBLAS，无需安装 Toolkit'],
}
const variants = [
  ['vulkan', 'linux-x64', 'ubuntu-vulkan-x64.tar.gz'],
  ['vulkan', 'windows-x64', 'win-vulkan-x64.zip'],
  ['metal', 'macos-arm64', 'macos-arm64.tar.gz'],
  ['cuda', 'linux-x64', 'ubuntu-cuda-13.5-x64.tar.gz'],
  ['cuda', 'windows-x64', 'win-cuda-13.5-x64.zip'],
]

async function digest(stream) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export function selectFiles(entries, archive) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  assert.equal(byPath.size, entries.length, 'Duplicate archive entry')
  const selected = entries.filter(entry => /^(?:llama-server(?:\.exe)?|.*\.(?:dll|dylib)|.*\.so(?:\.[\d.]+)?|LICENSE.*)$/.test(path.posix.basename(entry.path)))
  const outputs = new Set()
  return selected.map(entry => {
    const output = path.posix.basename(entry.path)
    assert.ok(safePath(entry.path) && safePath(output), `Unsafe path: ${entry.path}`)
    assert.ok(!outputs.has(output.toLowerCase()), `Duplicate output: ${output}`)
    outputs.add(output.toLowerCase())
    const seen = new Set()
    let target = entry
    while (target.link) {
      assert.ok(!seen.has(target.path), 'Archive link cycle')
      seen.add(target.path)
      assert.ok(safePath(target.link), `Unsafe link: ${target.link}`)
      const resolved = path.posix.join(path.posix.dirname(target.path), target.link)
      assert.ok(safePath(resolved), `Unsafe link: ${target.link}`)
      target = byPath.get(resolved)
      assert.ok(target, `Missing link target: ${resolved}`)
    }
    assert.match(target.sha256, /^[a-f0-9]{64}$/)
    return { path: output, sha256: target.sha256, source: `engine/${output}`, archivePath: target.path, archive, ...(/^llama-server(?:\.exe)?$/.test(output) ? { executable: true } : {}) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function inspect(file) {
  const entries = []
  let unpackedBytes = 0
  if (file.endsWith('.zip')) {
    const zip = await openPromise(file, { autoClose: false })
    try {
      for await (const entry of zip.eachEntry()) {
        unpackedBytes += entry.uncompressedSize
        if (entry.fileName.endsWith('/')) continue
        entries.push({ path: entry.fileName, sha256: await digest(await zip.openReadStreamPromise(entry)) })
      }
    } finally { zip.close() }
  } else {
    await listTar({ file, strict: true, onReadEntry(entry) {
      unpackedBytes += entry.size
      if (entry.type === 'Directory') return
      assert.ok(['File', 'SymbolicLink'].includes(entry.type), `Unsupported entry: ${entry.type}`)
      const record = { path: entry.path.replace(/^(?:\.\/)+/, '') }
      entries.push(record)
      if (entry.type === 'SymbolicLink') record.link = entry.linkpath
      else {
        const hash = createHash('sha256')
        entry.on('data', chunk => hash.update(chunk))
        entry.on('end', () => { record.sha256 = hash.digest('hex') })
      }
    } })
  }
  return { entries, unpackedBytes }
}

export async function verifyPreparation(file, archive, files) {
  const found = new Set()
  let active, hash
  await extractArchive(file, archive, files, {
    signal: new AbortController().signal,
    async emitAsync(event, chunk) {
      if (event.type === 'file') { active = event.path; hash = createHash('sha256') }
      if (event.type === 'chunk') hash.update(chunk)
      if (event.type === 'end') {
        assert.equal(hash.digest('hex'), files.find(file => file.path === active).sha256)
        found.add(active)
      }
      if (event.type === 'alias') {
        assert.ok(found.has(event.target))
        found.add(event.path)
      }
    },
  })
  assert.deepEqual([...found].sort(), files.filter(file => file.archive === archive.id).map(file => file.path).sort())
}

export function releasePlan(release) {
  assert.match(release.tag_name, /^b\d+$/)
  assert.ok(!release.draft && release.published_at, 'Release must be published')
  return variants.map(([backend, platform, suffix]) => {
    const names = [`llama-${release.tag_name}-bin-${suffix}`]
    if (backend === 'cuda') names.push(platform === 'windows-x64' ? `cudart-llama-bin-${suffix}` : `cudart-llama-${release.tag_name}-bin-${suffix}`)
    const assets = names.map(name => {
      const asset = release.assets.find(asset => asset.name === name)
      assert.ok(asset, `Missing official asset: ${name}`)
      assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/)
      assert.equal(asset.browser_download_url, `https://github.com/ggml-org/llama.cpp/releases/download/${release.tag_name}/${name}`)
      return asset
    })
    return { id: `llama-${backend}-${platform}-${release.tag_name}`, backend, platform, assets }
  })
}

async function main() {
  const { values } = parseArgs({ options: { release: { type: 'string' }, cache: { type: 'string' }, output: { type: 'string' }, download: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('node scripts/llama-resources.mjs --release b12211 [--cache /tmp/llama-assets] [--download] [--output /tmp/resources.json]\nDefault: read-only release/asset plan. --download writes only the explicit cache. --output verifies cached assets and preparation before writing a merged manifest. Requires Node 22+ and plugin dependencies; no engines are executed.')
    return
  }
  assert.match(values.release ?? '', /^b\d+$/, 'Specify a fixed --release bNNNNN (never latest)')
  assert.ok(!(values.download || values.output) || values.cache, '--download/--output requires --cache')
  const response = await fetch(`${repository}/releases/tags/${values.release}`)
  assert.ok(response.ok, `Release metadata: HTTP ${response.status}`)
  const release = await response.json()
  assert.equal(release.tag_name, values.release)
  const plan = releasePlan(release)
  console.error(JSON.stringify({ release: release.tag_name, prerelease: release.prerelease, assets: plan.flatMap(item => item.assets.map(({ name, size, digest }) => ({ name, size, digest }))) }, null, 2))
  if (!values.output && !values.download) return
  if (values.download) await mkdir(values.cache, { recursive: true })
  const resources = JSON.parse(await readFile(path.join(root, 'resources.json'), 'utf8'))
  for (const variant of plan) {
    const files = [], archives = []
    for (const [index, asset] of variant.assets.entries()) {
      const file = path.join(values.cache, asset.name)
      if (values.download && !await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })) {
        const download = await fetch(asset.browser_download_url)
        assert.ok(download.ok, `Download: HTTP ${download.status}`)
        const partial = `${file}.partial`
        try {
          await pipeline(Readable.fromWeb(download.body), createWriteStream(partial, { flags: 'wx' }))
          assert.equal((await stat(partial)).size, asset.size)
          assert.equal(`sha256:${await digest(createReadStream(partial))}`, asset.digest)
          await rename(partial, file)
        } finally { await rm(partial, { force: true }) }
      }
      assert.equal((await stat(file)).size, asset.size)
      assert.equal(`sha256:${await digest(createReadStream(file))}`, asset.digest)
      if (!values.output) continue
      const { entries, unpackedBytes } = await inspect(file)
      const archive = { id: index ? 'cudart' : 'engine', name: asset.name, sha256: asset.digest.slice(7), size: asset.size, unpackedBytes, source: { url: asset.browser_download_url } }
      const selected = selectFiles(entries, archive.id)
      await verifyPreparation(file, archive, selected)
      files.push(...selected)
      archives.push(archive)
    }
    if (!values.output) continue
    assert.equal(new Set(files.map(file => file.path.toLowerCase())).size, files.length)
    assert.equal(files.filter(file => file.executable).length, 1)
    const resource = { id: variant.id, kind: 'engine', engineId: 'llama.cpp', version: release.tag_name, backend: variant.backend, platforms: [variant.platform], title: 'llama.cpp', prerelease: release.prerelease, requirements: requirements[`${variant.backend}:${variant.platform}`], ...(variant.backend === 'cuda' ? { cudaRuntimeVersion: '13.5', recommendedDriverBranch: 'R620', minorCompatibilityDriverBranch: 'R580' } : {}), files, archives, bytes: archives.reduce((total, archive) => total + archive.size, 0) }
    const existing = resources.findIndex(item => item.id === resource.id)
    if (existing < 0) resources.push(resource)
    else resources[existing] = resource
    console.error(`Verified ${resource.id}: ${files.length} files, ${resource.bytes} archive bytes`)
  }
  if (values.output) {
    for (const resource of resources.filter(resource => /^llama-b\d+/.test(resource.id))) {
      Object.assign(resource, { engineId: 'llama.cpp', version: resource.id.match(/^llama-(b\d+)/)[1], backend: resource.id.includes('macos') ? 'metal' : 'vulkan', platforms: resource.platforms ?? ['linux-x64'], title: 'llama.cpp', legacy: true })
    }
    await writeFile(values.output, JSON.stringify(resources, null, 2) + '\n')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
