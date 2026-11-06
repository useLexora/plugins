import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

const revision = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const row = (id, installable = true) => ({ id: `example/${id}`, sha: revision, pipeline_tag: 'text-generation', siblings: [{ rfilename: installable ? 'model.gguf' : 'model.safetensors' }] })
const rows = (prefix, count = 24, installable = true) => Array.from({ length: count }, (_, i) => row(`${prefix}-${i}`, installable))
const repositories = items => items.map(item => item.repository)
function fixture(pages, options = {}) {
  const requests = [], downloads = []
  const stored = new Map(pages.flat().map(item => [item.id, item]))
  const behavior = { failPage: -1, failRepository: '', changedRevision: false, malformedLink: false }
  let active = 0, maximum = 0
  const context = {
    signal: new AbortController().signal,
    extension: { version: '1.0.0' },
    network: {
      async get(address) {
        const url = new URL(address)
        requests.push(url)
        const index = Number(url.searchParams.get('cursor') ?? 0)
        if (behavior.failPage === index) return { status: 503, text: '', headers: {} }
        let link
        if (index + 1 < pages.length) {
          url.searchParams.set('cursor', String(index + 1))
          if (behavior.malformedLink) url.hostname = 'evil.test'
          link = `<${url}>; rel="next"`
        }
        return { status: 200, text: JSON.stringify(pages[index]), headers: { link } }
      },
      async download(address) {
        const url = new URL(address)
        assert.equal(url.searchParams.get('blobs'), 'true')
        assert.match(url.pathname, /^\/api\/models\//)
        downloads.push(url)
        const repository = url.pathname.slice('/api/models/'.length).split('/revision/')[0]
        active++
        maximum = Math.max(maximum, active)
        try {
          await new Promise(resolve => setImmediate(resolve))
          if (repository === behavior.failRepository) throw Error('metadata temporarily unavailable')
          const item = stored.get(repository)
          const value = { ...item, ...(behavior.changedRevision ? { sha: 'c'.repeat(40) } : {}), siblings: item.siblings.map(file => ({ ...file, size: 1024 ** 3, lfs: { sha256: hash } })) }
          const bytes = new TextEncoder().encode(JSON.stringify(value))
          return { bytes, size: bytes.length }
        } finally { active-- }
      },
    },
    resources: { readBytes: async resource => ({ data: resource.bytes, eof: true }), release: async () => {} },
  }
  return { discovery: createDiscovery(context, options), context, requests, downloads, behavior, get maximum() { return maximum } }
}

test('all keeps one 24-row upstream page and bounds candidate metadata concurrency to three', async () => {
  const fx = fixture([rows('first'), rows('second')])
  const first = await fx.discovery.search()
  assert.equal(first.items.length, 24)
  assert.equal(first.pageComplete, true)
  assert.equal(fx.requests[0].searchParams.get('limit'), '24')
  assert.ok(first.items.every(item => item.availability.state === 'installable'))
  assert.equal(fx.requests.length, 1)
  assert.equal(fx.downloads.length, 24)
  assert.ok(fx.maximum <= 3)
  assert.equal(typeof first.nextCursor, 'string')
  assert.ok(fx.downloads.every(url => url.pathname.endsWith(`/revision/${revision}`)))
})

test('overflow and cross-page deduplication survive failed requests and cursor replay in upstream order', async () => {
  const firstRows = rows('a', 23)
  const pages = [firstRows, rows('b'), [firstRows[0], ...rows('c', 5)]]
  const fx = fixture(pages)
  const first = await fx.discovery.search({ availability: 'installable' })
  assert.equal(fx.requests.length, 2)
  fx.behavior.failPage = 2
  await assert.rejects(fx.discovery.search({ availability: 'installable', cursor: first.nextCursor }), /503/)
  fx.behavior.failPage = -1
  const second = await fx.discovery.search({ availability: 'installable', cursor: first.nextCursor })
  const third = await fx.discovery.search({ availability: 'installable', cursor: second.nextCursor })
  assert.deepEqual(repositories([...first.items, ...second.items, ...third.items]), [...new Set(pages.flat().map(item => item.id))])
  assert.equal(third.nextCursor, null)
  assert.deepEqual((await fx.discovery.search({ availability: 'installable', cursor: first.nextCursor })).items, second.items)
})

test('three empty filtered pages retain a real continuation instead of claiming global absence', async () => {
  const fx = fixture([rows('a', 24, false), [], rows('c', 4, false), rows('d', 2)])
  const first = await fx.discovery.search({ availability: 'installable' })
  assert.deepEqual(first.items, [])
  assert.equal(first.pageComplete, false)
  assert.equal(fx.requests.length, 3)
  assert.equal(typeof first.nextCursor, 'string')
  const second = await fx.discovery.search({ availability: 'installable', cursor: first.nextCursor })
  assert.deepEqual(repositories(second.items), ['example/d-0', 'example/d-1'])
  assert.equal(second.nextCursor, null)
  assert.equal(second.pageComplete, true)
  assert.equal(fx.requests.length, 4)
})

test('availability is validated and bound into cursors in both directions', async () => {
  const invalid = fixture([[]])
  await assert.rejects(invalid.discovery.search({ availability: 'unsupported' }), /安装支持筛选/)
  assert.equal(invalid.requests.length, 0)
  for (const availability of ['all', 'installable']) {
    const fx = fixture([rows('a'), rows('b')])
    const first = await fx.discovery.search({ availability })
    const before = fx.requests.length
    await assert.rejects(fx.discovery.search({ availability: availability === 'all' ? 'installable' : 'all', cursor: first.nextCursor }), /分页游标无效或已过期/)
    assert.equal(fx.requests.length, before)
    const reset = await fx.discovery.search({ availability: availability === 'all' ? 'installable' : 'all' })
    assert.deepEqual(repositories(reset.items), repositories(first.items))
  }
})

test('metadata 暂时失败在两种筛选下都保留候选，不污染缓存且详情可重试', async t => {
  for (const availability of ['all', 'installable']) await t.test(availability, async () => {
    const writes = []
    const fx = fixture([rows('a'), rows('b', 2)], { persist: async cache => { writes.push(cache) } })
    const first = await fx.discovery.search({ availability })
    fx.behavior.failRepository = 'example/b-1'
    const second = await fx.discovery.search({ availability, cursor: first.nextCursor })
    assert.deepEqual(repositories(second.items), ['example/b-0', 'example/b-1'])
    assert.deepEqual(second.items.map(item => item.availability.state), ['installable', 'unverified'])
    assert.equal(second.items[1].availability.code, 'metadata')
    assert.equal(second.nextCursor, null)
    assert.equal(second.pageComplete, true)
    assert.ok(writes.every(cache => !cache.entries.some(entry => entry.repository === 'example/b-1')))
    assert.ok(writes.at(-1).entries.some(entry => entry.repository === 'example/b-0' && entry.state === 'installable'))
    fx.behavior.failRepository = ''
    const detail = await fx.discovery.inspect({ ...second.items[1], revision })
    assert.equal(detail.availability.state, 'installable')
    assert.equal(detail.unavailableReason, null)
    assert.ok(writes.at(-1).entries.some(entry => entry.repository === 'example/b-1' && entry.state === 'installable'))
    const retried = await fx.discovery.search({ availability, cursor: first.nextCursor })
    assert.ok(retried.items.every(item => item.availability.state === 'installable'))
  })
})

test('revision 不一致在列表中保留未验证候选，不缓存支持且详情拒绝错误版本', async () => {
  const writes = []
  const fx = fixture([rows('a', 1)], { persist: async cache => { writes.push(cache) } })
  fx.behavior.changedRevision = true
  for (const availability of ['all', 'installable']) {
    const { items } = await fx.discovery.search({ availability })
    assert.equal(items.length, 1)
    assert.equal(items[0].availability.state, 'unverified')
    assert.equal(items[0].availability.code, 'metadata')
  }
  await assert.rejects(fx.discovery.inspect({ repository: 'example/a-0', revision }), /版本与当前目录不一致/)
  assert.ok(writes.every(cache => !cache.entries.some(entry => entry.repository === 'example/a-0')))
  fx.behavior.changedRevision = false
  assert.equal((await fx.discovery.search({ availability: 'installable' })).items[0].availability.state, 'installable')
  assert.ok(writes.at(-1).entries.some(entry => entry.repository === 'example/a-0' && entry.state === 'installable' && entry.revision === revision))
})

test('invalid links reject the query before any candidate preflight or cache write', async () => {
  const writes = []
  const fx = fixture([rows('a', 1), []], { persist: async cache => { writes.push(cache) } })
  fx.behavior.malformedLink = true
  await assert.rejects(fx.discovery.search({ availability: 'installable' }), /分页链接与当前查询不匹配/)
  assert.equal(writes.length, 0)
  assert.equal(fx.downloads.length, 0)
})

test('按用途限定安装候选，对话与视觉使用 GGUF 筛选', async t => {
  const cases = [
    ['installable', 'chat', '24', 'gguf'],
    ['installable', 'vision', '24', 'gguf'],
    ['installable', 'asr', '24', null],
    ['installable', 'tts', '24', null],
    ['installable', 'image', '24', null],
  ]
  for (const [availability, kind, limit, filter] of cases) await t.test(`${availability}/${kind}`, async () => {
    const fx = fixture([[]])
    const page = await fx.discovery.search({ availability, kind })
    assert.equal(fx.requests[0].searchParams.get('limit'), limit)
    assert.equal(fx.requests[0].searchParams.get('filter'), filter)
    assert.equal(page.pageComplete, true)
    assert.equal(page.nextCursor, null)
  })
})

test('满 100 条上游页拆分为 24 条展示页，溢出依序保留到真实末尾', async () => {
  const source = rows('many', 100)
  const fx = fixture([source])
  const all = []
  let cursor = null
  for (const count of [24, 24, 24, 24, 4]) {
    const page = await fx.discovery.search({ availability: 'installable', cursor })
    assert.equal(page.items.length, count)
    assert.equal(page.pageComplete, true)
    all.push(...page.items)
    cursor = page.nextCursor
  }
  assert.equal(cursor, null)
  assert.equal(fx.requests.length, 1)
  assert.equal(fx.requests[0].searchParams.get('limit'), '100')
  assert.deepEqual(repositories(all), source.map(item => item.id))
})

test('三页后未满的结果继续累积同一页，重试不丢失、跨批去重且满页后保留溢出', async () => {
  const pages = [rows('a', 7), rows('unsupported', 100, false), rows('b', 8), [row('a-0'), ...rows('c', 10)], rows('d', 3)]
  const fx = fixture(pages)
  const partial = await fx.discovery.search({ availability: 'installable' })
  assert.equal(fx.requests.length, 3)
  assert.equal(partial.pageComplete, false)
  assert.deepEqual(repositories(partial.items), [...pages[0], ...pages[2]].map(item => item.id))
  assert.equal(typeof partial.nextCursor, 'string')
  fx.behavior.failPage = 3
  await assert.rejects(fx.discovery.search({ availability: 'installable', cursor: partial.nextCursor }), /503/)
  fx.behavior.failPage = -1
  const full = await fx.discovery.search({ availability: 'installable', cursor: partial.nextCursor })
  assert.equal(full.pageComplete, true)
  assert.equal(full.items.length, 24)
  assert.deepEqual(repositories(full.items.slice(0, partial.items.length)), repositories(partial.items))
  const tail = await fx.discovery.search({ availability: 'installable', cursor: full.nextCursor })
  assert.equal(tail.pageComplete, true)
  assert.equal(tail.nextCursor, null)
  const expected = [...new Set([...pages[0], ...pages[2], ...pages[3], ...pages[4]].map(item => item.id))]
  assert.deepEqual(repositories([...full.items, ...tail.items]), expected)
})

test('连续未满页每批最多读取三页，直到真实末尾返回合并的同一页', async () => {
  const pages = Array.from({ length: 7 }, (_, index) => rows(`batch-${index}`, 1))
  const fx = fixture(pages)
  let cursor = null
  for (const [count, pageComplete] of [[3, false], [6, false], [7, true]]) {
    const page = await fx.discovery.search({ availability: 'installable', cursor })
    assert.equal(fx.requests.length, count)
    assert.equal(page.pageComplete, pageComplete)
    assert.deepEqual(repositories(page.items), pages.slice(0, count).flat().map(item => item.id))
    cursor = page.nextCursor
    if (!pageComplete) assert.equal(typeof cursor, 'string')
  }
  assert.equal(cursor, null)
})
