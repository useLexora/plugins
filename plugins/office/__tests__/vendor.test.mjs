import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { prepareVendor } from '../prepare-vendor.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-vendor-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'upstream'))
  const revision = 'a'.repeat(40)
  const zip = new JSZip()
  zip.file(`genoffice-${revision}/LICENSE`, 'license\n')
  zip.file(`genoffice-${revision}/packages/engine/src/index.ts`, 'export const value = 1\n')
  zip.file(`genoffice-${revision}/packages/engine/tests/engine.test.ts`, 'upstream test\n')
  zip.file(`genoffice-${revision}/apps/native/main.ts`, 'native app\n')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const archivePath = path.join(root, 'source.zip')
  await fs.writeFile(archivePath, bytes)
  const lock = { revision, archive: 'https://invalid.invalid/source.zip', sha256: createHash('sha256').update(bytes).digest('hex'), include: ['LICENSE', 'packages/engine/'], exclude: ['**/tests/**'], patches: ['browser.patch'] }
  await fs.writeFile(path.join(root, 'upstream/genoffice.json'), JSON.stringify(lock))
  await fs.writeFile(path.join(root, 'upstream/browser.patch'), '--- a/packages/engine/src/index.ts\n+++ b/packages/engine/src/index.ts\n@@ -1 +1 @@\n-export const value = 1\n+export const value = 2\n')
  return { root, archivePath, lock, target: path.join(root, 'vendor/genoffice') }
}

test('pinned source preparation preserves licenses, applies patches and excludes unused sources', async t => {
  const f = await fixture(t)
  await prepareVendor(f)
  assert.equal(await fs.readFile(path.join(f.target, 'LICENSE'), 'utf8'), 'license\n')
  assert.equal(await fs.readFile(path.join(f.target, 'packages/engine/src/index.ts'), 'utf8'), 'export const value = 2\n')
  await assert.rejects(fs.access(path.join(f.target, 'packages/engine/tests')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(f.target, 'apps')), { code: 'ENOENT' })
  await fs.rm(f.archivePath)
  assert.equal(await prepareVendor({ root: f.root }), f.target)
})

test('archive checksum and patch failures leave the previous prepared source intact', async t => {
  const f = await fixture(t)
  await prepareVendor(f)
  const marker = await fs.readFile(path.join(f.target, '.source.json'), 'utf8')
  const lockPath = path.join(f.root, 'upstream/genoffice.json')
  await fs.writeFile(lockPath, JSON.stringify({ ...f.lock, sha256: '0'.repeat(64) }))
  await assert.rejects(prepareVendor(f), /SHA-256 mismatch/)
  assert.equal(await fs.readFile(path.join(f.target, '.source.json'), 'utf8'), marker)
  await fs.writeFile(lockPath, JSON.stringify(f.lock))
  await fs.writeFile(path.join(f.root, 'upstream/browser.patch'), '--- a/packages/engine/src/index.ts\n+++ b/packages/engine/src/index.ts\n@@ -1 +1 @@\n-export const value = 999\n+export const value = 3\n')
  await assert.rejects(prepareVendor(f))
  assert.equal(await fs.readFile(path.join(f.target, '.source.json'), 'utf8'), marker)
  assert.equal(await fs.readFile(path.join(f.target, 'packages/engine/src/index.ts'), 'utf8'), 'export const value = 2\n')
})

test('source cache edits are detected and retained for the developer', async t => {
  const f = await fixture(t)
  await prepareVendor(f)
  const file = path.join(f.target, 'packages/engine/src/index.ts')
  await fs.writeFile(file, 'local edit\n')
  await assert.rejects(prepareVendor(f), /local changes/)
  assert.equal(await fs.readFile(file, 'utf8'), 'local edit\n')
})

test('archive paths cannot escape the selected source root', async t => {
  const f = await fixture(t)
  const zip = new JSZip()
  zip.file(`genoffice-${f.lock.revision}/packages/engine/../escape.ts`, 'escape\n')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  await fs.writeFile(f.archivePath, bytes)
  await fs.writeFile(path.join(f.root, 'upstream/genoffice.json'), JSON.stringify({ ...f.lock, sha256: createHash('sha256').update(bytes).digest('hex'), include: ['packages/'] }))
  await assert.rejects(prepareVendor(f), /Unsafe source path/)
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' })
})
