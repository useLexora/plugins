import assert from 'node:assert/strict'
import test from 'node:test'
import { expandModelFiles, groupGgufFiles } from '../modelFileGroups.js'

const file = (path, overrides = {}) => ({ path, bytes: 1024, sha256: 'a'.repeat(64), url: `https://example.com/models/${path}`, ...overrides })
const shard = (stem, index, total, overrides = {}) => file(`${stem}-${String(index).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`, overrides)
const split = (stem, total = 2) => Array.from({ length: total }, (_, index) => shard(stem, index + 1, total))

test('完整分片只输出第一片选项，逐片保留大小、校验和、URL 和其他字段', () => {
  const parts = Object.freeze([
    Object.freeze(shard('model-Q4_K_M', 1, 3, { bytes: 8 * 1024 ** 3, sha256: 'b'.repeat(64), role: 'model' })),
    Object.freeze(shard('model-Q4_K_M', 2, 3, { bytes: 4 * 1024 ** 3, sha256: 'c'.repeat(64), url: 'https://example.com/second', etag: 'second' })),
    Object.freeze(shard('model-Q4_K_M', 3, 3, { bytes: null, sha256: null, revision: 'fixed-revision' })),
  ])
  const choices = groupGgufFiles(parts)
  assert.deepEqual(choices, [{ ...parts[0], parts }])
})

test('乱序分片按序放入 parts，选项保留第一片的位置与普通文件顺序', () => {
  const parts = split('model', 3)
  const before = file('before.gguf')
  const middle = file('middle.gguf')
  const after = file('after.gguf')
  const files = Object.freeze([parts[2], before, parts[1], middle, parts[0], after])
  const choices = groupGgufFiles(files)
  assert.deepEqual(choices, [before, middle, { ...parts[0], parts }, after])
})

test('不同量化、视觉投影与其他 stem 各自形成独立选项', () => {
  const q4 = split('model-Q4_K_M')
  const q8 = split('model-Q8_0', 3)
  const projector = split('mmproj-model-Q4_K_M')
  const other = split('another-model-Q4_K_M')
  const choices = groupGgufFiles([q4[1], q8[2], projector[1], other[1], q8[0], q4[0], other[0], q8[1], projector[0]])
  assert.deepEqual(choices, [q8, q4, other, projector].map(parts => ({ ...parts[0], parts })))
})

test('不同目录以及大小写不同的 stem 不混组', () => {
  const sets = ['model', 'Model', 'a/model', 'b/model', 'a/nested/model'].map(stem => split(stem))
  const choices = groupGgufFiles([...sets.map(parts => parts[1]), ...sets.map(parts => parts[0])])
  assert.deepEqual(choices, sets.map(parts => ({ ...parts[0], parts })))
})

test('不会用其他量化、目录或视觉投影中的分片补齐缺片', () => {
  const complete = split('complete')
  const files = [
    shard('model-Q4', 1, 2),
    shard('model-Q8', 2, 2),
    shard('mmproj-model-Q4', 2, 2),
    shard('nested/model-Q4', 2, 2),
    ...complete,
  ]
  assert.deepEqual(groupGgufFiles(files), [{ ...complete[0], parts: complete }])
})

test('缺片、重复序号、计数冲突和越界序号排除整个组，但不影响其他文件', async t => {
  const parts = split('broken', 3)
  const cases = [
    ['缺第一片', parts.slice(1)],
    ['缺中间片', [parts[0], parts[2]]],
    ['重复第一片', [...parts, parts[0]]],
    ['重复路径元数据不同', [...parts, { ...parts[1], bytes: 99, sha256: 'd'.repeat(64) }]],
    ['完整组混入另一总数', [...parts, shard('broken', 1, 2)]],
    ['非重复序号的总数冲突', [shard('broken', 1, 2), shard('broken', 2, 3)]],
    ['零序号', [...parts, shard('broken', 0, 3)]],
    ['超过总数', [...parts, shard('broken', 4, 3)]],
    ['零总数', [shard('broken', 1, 0)]],
  ]
  for (const [name, broken] of cases) {
    await t.test(name, () => {
      const standalone = file('standalone.gguf')
      const complete = split('complete')
      assert.deepEqual(groupGgufFiles([...broken, standalone, ...complete]), [standalone, { ...complete[0], parts: complete }])
    })
  }
})

test('仅含一片的标准分片组仍可选择', () => {
  const parts = split('model', 1)
  assert.deepEqual(groupGgufFiles(parts), [{ ...parts[0], parts }])
})

test('非分片和非 GGUF 文件原样保留，不承担角色筛选', () => {
  const files = [
    file('model.gguf'),
    file('mmproj-model.gguf'),
    file('tokenizer.json'),
    file('model-00001-of-00002.safetensors'),
    file('model-1-of-2.gguf'),
    file('model-00001-of-00002.gguf.backup'),
    file('folder-00001-of-00002.gguf/model.gguf'),
  ]
  const choices = groupGgufFiles(files)
  assert.deepEqual(choices, files)
})

test('GGUF 扩展名大小写与现有角色筛选一致', () => {
  const parts = split('model').map(part => ({ ...part, path: part.path.replace(/gguf$/, 'GGUF') }))
  assert.deepEqual(groupGgufFiles(parts), [{ ...parts[0], parts }])
})

test('展开选项时按 parts 顺序保留逐片元数据，按 path 去重并保留首次出现', () => {
  const parts = split('model', 3)
  const option = groupGgufFiles(parts)[0]
  const standalone = file('single.gguf')
  const duplicate = { ...parts[1], bytes: 9, sha256: null }
  const other = file('nested/single.gguf')
  const expanded = expandModelFiles([standalone, option, duplicate, option, standalone, other])
  assert.deepEqual(expanded, [standalone, ...parts, other])
  assert.deepEqual(expandModelFiles([duplicate, option]), [duplicate, parts[0], parts[2]])
})
