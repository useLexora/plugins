import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const specifications = JSON.parse(await readFile(new URL('../../../resources.json', import.meta.url), 'utf8'))
const engines = specifications.filter(spec => spec.platforms?.includes('macos-arm64') || spec.id === 'tesseract-wasm')

test('macOS engine resources pin archive and file contents without case-colliding output paths', () => {
  for (const engine of engines) {
    assert.ok(engine.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)))
    assert.ok(engine.archives.every(archive => /^[0-9a-f]{64}$/.test(archive.sha256) && archive.size > 0 && archive.unpackedBytes > 0))
    assert.equal(new Set(engine.files.map(file => file.path.toLowerCase())).size, engine.files.length)
  }
})
