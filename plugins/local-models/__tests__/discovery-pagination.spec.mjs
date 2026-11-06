import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

const row = (id, downloads = 0) => ({ id: `example/${id}`, downloads, pipeline_tag: 'text-generation' })
const rows = page => Array.from({ length: 24 }, (_, index) => row(`${page}-${index}`, index))
function nextLink(url, cursor, mutate = () => {}) {
  const next = new URL(url)
  next.searchParams.set('cursor', cursor)
  mutate(next)
  return `<${next}>; rel="next"`
}
function fixture(reply) {
  const requests = []
  const discovery = createDiscovery({
    signal: new AbortController().signal,
    network: { get: async address => {
      const url = new URL(address)
      requests.push(url)
      const response = await reply(url)
      return { status: 200, text: JSON.stringify(response.items ?? []), headers: {}, ...response }
    } },
  })
  return { discovery, requests }
}

test('all-purpose search is one upstream query, keeps upstream order and follows opaque next cursors', async () => {
  const { discovery, requests } = fixture(url => ({
    items: rows(url.searchParams.has('cursor') ? 'second' : 'first'),
    headers: url.searchParams.has('cursor') ? {} : { link: nextLink(url, 'upstream-next-token') },
  }))
  const first = await discovery.search({ query: 'Qwen' })
  assert.deepEqual(first.items.map(item => item.repository), rows('first').map(item => item.id))
  assert.equal(typeof first.nextCursor, 'string')
  assert.ok(!first.nextCursor.includes('upstream-next-token'))
  assert.equal(requests.length, 1)
  const second = await discovery.search({ query: 'Qwen', cursor: first.nextCursor })
  assert.deepEqual(second.items.map(item => item.repository), rows('second').map(item => item.id))
  assert.equal(requests[1].searchParams.get('cursor'), 'upstream-next-token')
  assert.equal(second.nextCursor, null)
  assert.equal(requests.length, 2)
})

test('only explicit next links advance independent pages, regardless of page length or unrelated Link parameters', async () => {
  for (const items of [[], [row('short')], rows('full')]) {
    const { discovery } = fixture(url => url.searchParams.has('cursor')
      ? { items: [row('second')] }
      : { items, headers: { link: nextLink(url, 'next') } })
    const first = await discovery.search()
    assert.equal(first.pageComplete, true)
    assert.equal(typeof first.nextCursor, 'string')
    const second = await discovery.search({ cursor: first.nextCursor })
    assert.deepEqual(second.items.map(item => item.repository), ['example/second'])
    assert.equal(second.pageComplete, true)
    assert.equal(second.nextCursor, null)
    const terminal = fixture(() => ({ items }))
    assert.equal((await terminal.discovery.search()).nextCursor, null)
  }
  const { discovery } = fixture(url => ({ headers: { link: `<${url}>; rel="prev", <${url}>; rel="first"` } }))
  assert.equal((await discovery.search()).nextCursor, null)
  const titleOnly = fixture(url => ({ headers: { link: nextLink(url, 'next').replace('rel="next"', 'title="not a relation; rel=next"; rel="last"') } }))
  assert.equal((await titleOnly.discovery.search()).nextCursor, null)
})

test('duplicate repositories retain a single card without re-sorting the upstream page', async () => {
  const { discovery } = fixture(() => ({ items: [row('z', 1), row('a', 200), row('z', 3)] }))
  const result = await discovery.search({ sort: 'downloads' })
  assert.deepEqual(result.items.map(item => item.repository), ['example/z', 'example/a'])
})

test('failed next-page requests do not consume a cursor or masquerade as terminal pages', async () => {
  let fail = true
  const { discovery, requests } = fixture(url => {
    if (!url.searchParams.has('cursor')) return { items: [row('first')], headers: { link: nextLink(url, 'second') } }
    if (fail) return { status: 429, text: 'Too Many Requests' }
    return { items: [row('second')] }
  })
  const { nextCursor } = await discovery.search({ kind: 'vision', query: 'Qwen' })
  await assert.rejects(discovery.search({ kind: 'vision', query: 'Qwen', cursor: nextCursor }), /请求额度暂时用尽/)
  fail = false
  const retry = await discovery.search({ kind: 'vision', query: 'Qwen', cursor: nextCursor })
  assert.equal(retry.items[0].repository, 'example/second')
  assert.equal(retry.nextCursor, null)
  assert.equal(requests[1].href, requests[2].href)
})

test('forged, cross-instance and cross-query cursors are rejected without network access', async () => {
  const { discovery, requests } = fixture(url => ({ headers: { link: nextLink(url, 'real-next') } }))
  const query = { query: 'Qwen', kind: 'chat', sort: 'downloads' }
  const { nextCursor } = await discovery.search(query)
  for (const args of [
    { ...query, cursor: 'https://evil.test/api/models' },
    { ...query, cursor: '' },
    { ...query, cursor: 1 },
    { ...query, cursor: nextCursor, query: 'different' },
    { ...query, cursor: nextCursor, kind: 'all' },
    { ...query, cursor: nextCursor, sort: 'lastModified' },
    { ...query, cursor: nextCursor, query: 'example/model' },
  ]) await assert.rejects(discovery.search(args), /分页游标无效或已过期/)
  const other = fixture(() => ({}))
  await assert.rejects(other.discovery.search({ ...query, cursor: nextCursor }), /分页游标无效或已过期/)
  assert.equal(requests.length, 1)
  assert.equal(other.requests.length, 0)
})

test('next links must bind the exact HF origin, endpoint, query, sort and expansion parameters', async (t) => {
  for (const [name, mutate] of [
    ['origin', url => { url.hostname = 'huggingface.co.evil.test' }],
    ['http', url => { url.protocol = 'http:' }],
    ['port', url => { url.port = '444' }],
    ['credentials', url => { url.username = 'user' }],
    ['path', url => { url.pathname = '/api/datasets' }],
    ['search', url => { url.searchParams.set('search', 'other') }],
    ['pipeline', url => { url.searchParams.set('pipeline_tag', 'text-to-image') }],
    ['format', url => { url.searchParams.set('filter', 'gguf') }],
    ['limit', url => { url.searchParams.set('limit', '100') }],
    ['sort', url => { url.searchParams.set('sort', 'lastModified') }],
    ['direction', url => { url.searchParams.set('direction', '1') }],
    ['expansion', url => { url.searchParams.delete('expand') }],
    ['duplicated cursor', url => { url.searchParams.append('cursor', 'different') }],
    ['missing cursor', url => { url.searchParams.delete('cursor') }],
    ['empty cursor', url => { url.searchParams.set('cursor', '') }],
    ['fragment', url => { url.hash = 'page-2' }],
  ]) await t.test(name, async () => {
    const { discovery, requests } = fixture(url => ({ headers: { link: nextLink(url, 'next', mutate) } }))
    await assert.rejects(discovery.search({ query: 'Qwen', kind: 'chat' }), /分页链接与当前查询不匹配/)
    assert.equal(requests.length, 1)
  })
})

test('HF expand and expand[] normalization is accepted', async () => {
  const { discovery } = fixture(url => ({ headers: { link: nextLink(url, 'next', next => {
    const expansions = next.searchParams.getAll('expand')
    next.searchParams.delete('expand')
    for (const value of expansions.reverse()) next.searchParams.append('expand[]', value)
  }) } }))
  assert.equal(typeof (await discovery.search()).nextCursor, 'string')
})

test('malformed, oversized, ambiguous and looping Link values fail explicitly and are retryable', async () => {
  for (const link of ['not a Link header', '<https://huggingface.co/api/models>; rel="next', 'x'.repeat(16 * 1024 + 1)]) {
    const { discovery } = fixture(() => ({ headers: { link } }))
    await assert.rejects(discovery.search(), /无效的分页链接/)
  }
  const ambiguous = fixture(url => ({ headers: { link: `${nextLink(url, 'a')}, ${nextLink(url, 'b')}` } }))
  await assert.rejects(ambiguous.discovery.search(), /冲突的分页链接/)
  let cycle = true
  const { discovery } = fixture(url => {
    const current = url.searchParams.get('cursor')
    return { headers: { link: nextLink(url, current === 'a' ? 'b' : current === 'b' && !cycle ? 'c' : 'a') } }
  })
  const first = await discovery.search()
  const second = await discovery.search({ cursor: first.nextCursor })
  await assert.rejects(discovery.search({ cursor: second.nextCursor }), /循环分页链接/)
  cycle = false
  assert.equal(typeof (await discovery.search({ cursor: second.nextCursor })).nextCursor, 'string')
})

test('old hosts lacking headers report an upgrade requirement rather than a false terminal page', async () => {
  const { discovery } = fixture(() => ({ items: rows('first'), headers: undefined }))
  await assert.rejects(discovery.search(), /升级宿主/)
})

test('cursor storage is bounded and evicted tokens fail without network access while recent queries still work', async () => {
  const { discovery, requests } = fixture(url => ({ headers: url.searchParams.has('cursor') ? {} : { link: nextLink(url, 'next') } }))
  const first = await discovery.search({ query: 'first' })
  for (let index = 0; index < 256; index++) await discovery.search({ query: `q${index}` })
  const recent = await discovery.search({ query: 'recent' })
  const before = requests.length
  await assert.rejects(discovery.search({ query: 'first', cursor: first.nextCursor }), /分页游标无效或已过期/)
  assert.equal(requests.length, before)
  assert.equal((await discovery.search({ query: 'recent', cursor: recent.nextCursor })).nextCursor, null)
})
