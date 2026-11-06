import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalImport } from '../localImport.js'

function traineddata() {
  const count = 24, header = 4 + count * 8
  const bytes = Buffer.alloc(header + 32)
  bytes.writeUInt32LE(count)
  for (let i = 0; i < count; i++) bytes.writeBigInt64LE(-1n, 4 + i * 8)
  for (const [i, index] of [17, 21, 22, 23].entries()) bytes.writeBigInt64LE(BigInt(header + i * 8), 4 + index * 8)
  return bytes
}

for (const mutate of [false, true]) test(`filesystem import ${mutate ? 'rejects a same-size mutation during hashing' : 'accepts unchanged bytes with their actual digest'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'local-import-fs-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'eng.traineddata'), original = traineddata()
  await writeFile(path, original)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const context = {
    signal: new AbortController().signal,
    resources: {
      async listFiles() { return [{ id: 'authorized-file', name: 'eng.traineddata', relativePath: 'eng.traineddata', size: (await stat(path)).size }] },
      async readBytes({ id }, { offset, length }) {
        assert.equal(id, 'authorized-file')
        const file = await open(path, 'r')
        try {
          const size = (await file.stat()).size, buffer = Buffer.alloc(length)
          const { bytesRead } = await file.read(buffer, 0, length, offset)
          return { data: buffer.subarray(0, bytesRead), size, eof: offset + bytesRead >= size }
        } finally { await file.close() }
      },
      async hash({ id }) {
        assert.equal(id, 'authorized-file')
        if (mutate) {
          const bytes = await readFile(path)
          bytes.writeUInt32LE(0)
          await writeFile(path, bytes)
        }
        const bytes = await readFile(path)
        return { sha256: digest(bytes), size: bytes.length }
      },
    },
  }
  const importer = createLocalImport(context)
  const inspected = await importer.inspect({ resourceIds: ['authorized-file'] })
  const candidate = inspected.candidates.find(item => item.recipe === 'ocr')
  assert.ok(candidate)
  const input = { token: inspected.token, recipe: 'ocr', selection: Object.fromEntries(candidate.roles.map(role => [role.id, role.choices[0].id])) }
  if (mutate) {
    await assert.rejects(importer.resolve(input), /变化|失效|不合法|无效|traineddata|组件/)
    assert.equal((await stat(path)).size, original.length)
    assert.equal((await readFile(path)).readUInt32LE(), 0)
  } else {
    const result = await importer.resolve(input)
    assert.equal(result.specification.files[0].sha256, digest(original))
  }
})
