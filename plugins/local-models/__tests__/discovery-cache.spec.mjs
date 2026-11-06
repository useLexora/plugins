import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'
import { createAvailabilityCache, discoveryCacheMaxBytes, discoveryCacheMaxEntries, discoveryCacheTTL } from '../discoveryCache.js'

const revision = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const repository = 'example/model'
function fixture(options = {}, overrides = {}) {
  const requests = [], downloads = []
  const row = { id: repository, pipeline_tag: 'text-generation', sha: revision, siblings: [{ rfilename: 'model.gguf' }], ...overrides }
  const detail = { ...row, siblings: row.siblings.map(file => ({ size: 1024 ** 3, lfs: { sha256: hash }, ...file })) }
  const context = {
    extension: { version: '1.0.0' },
    signal: new AbortController().signal,
    network: {
      async get(url) { requests.push(url); return { status: 200, text: JSON.stringify([row]), headers: {} } },
      async download(url) {
        assert.match(new URL(url).pathname, /^\/api\/models\//)
        downloads.push(url)
        const bytes = new TextEncoder().encode(JSON.stringify(detail))
        return { bytes, size: bytes.length }
      },
    },
    resources: { readBytes: async resource => ({ data: resource.bytes, eof: true }), release: async () => {} },
  }
  return { discovery: createDiscovery(context, options), context, row, detail, requests, downloads }
}
const item = async discovery => (await discovery.search()).items[0]

async function seed() {
  let cached
  const fx = fixture({ persist: async value => { cached = JSON.parse(JSON.stringify(value)) } })
  assert.equal((await item(fx.discovery)).availability.state, 'installable')
  return cached
}

test('small persisted results survive instance reconstruction without storing file lists or model settings', async () => {
  const cached = await seed()
  assert.deepEqual(Object.keys(cached.entries[0]).sort(), ['checkedAt', 'code', 'reason', 'repository', 'revision', 'state'])
  const fx = fixture({ cached })
  assert.equal((await item(fx.discovery)).availability.state, 'installable')
  assert.equal(fx.requests.length, 1)
  assert.equal(fx.downloads.length, 0)
  const detail = await fx.discovery.inspect({ repository })
  assert.equal(detail.availability.state, 'installable')
  assert.equal(fx.downloads.length, 1)
  assert.equal(detail.roles[0].choices[0].sha256, hash)
})

test('cache invalidates on commit, rule version, plugin version, expiry and future timestamps', async (t) => {
  const cached = await seed()
  for (const [name, mutate] of [
    ['rule version', value => { value.rulesVersion++ }],
    ['plugin version', value => { value.extensionVersion = '0.9.0' }],
    ['expired', value => { value.entries[0].checkedAt = Date.now() - discoveryCacheTTL }],
    ['future', value => { value.entries[0].checkedAt = Date.now() + 60000 }],
  ]) await t.test(name, async () => {
    const value = structuredClone(cached)
    mutate(value)
    const fx = fixture({ cached: value })
    assert.equal((await item(fx.discovery)).availability.state, 'installable')
    assert.equal(fx.downloads.length, 1)
  })
  const changed = fixture({ cached }, { sha: 'c'.repeat(40) })
  assert.equal((await item(changed.discovery)).availability.state, 'installable')
  assert.equal(changed.downloads.length, 1)
  assert.match(changed.downloads[0], new RegExp(`/revision/${'c'.repeat(40)}\\?blobs=true$`))
})

test('TTL expires within the same instance instead of being refreshed by cache reads', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const fx = fixture()
  await item(fx.discovery)
  now += discoveryCacheTTL - 1
  await item(fx.discovery)
  assert.equal(fx.downloads.length, 1)
  now++
  await item(fx.discovery)
  assert.equal(fx.downloads.length, 2)
})

test('missing checksums remain recoverable and are never cached as incompatibility', async () => {
  const writes = []
  const fx = fixture({ persist: async value => { writes.push(value) } })
  fx.detail.siblings = [{ rfilename: 'model.gguf', size: 17 * 1024 ** 2 }]
  assert.equal((await item(fx.discovery)).availability.code, 'checksum')
  assert.equal((await item(fx.discovery)).availability.state, 'unverified')
  assert.equal(fx.downloads.length, 2)
  assert.equal(writes.length, 0)
})

test('fresh gated evidence overrides cached installability without fetching candidate metadata', async () => {
  const cached = await seed()
  const fx = fixture({ cached }, { gated: 'manual' })
  assert.equal((await item(fx.discovery)).availability.state, 'unsupported')
  assert.equal(fx.downloads.length, 0)
})

test('storage failures degrade to memory without rejecting successful queries or touching context storage', async () => {
  let attempts = 0
  const fx = fixture({ persist: async () => { attempts++; throw Error('storage full') } })
  Object.defineProperty(fx.context, 'storage', { get() { throw Error('discovery must not use whole-config storage') } })
  assert.equal((await item(fx.discovery)).availability.state, 'installable')
  assert.equal((await item(fx.discovery)).availability.state, 'installable')
  assert.equal(fx.downloads.length, 1)
  assert.equal(attempts, 1)
})

test('cache validates entries and enforces count, byte and reason bounds on writes and reconstruction', async () => {
  let saved
  const persist = async value => { saved = value }
  const cache = createAvailabilityCache({ persist, extensionVersion: '1.0.0' })
  await cache.put(Array.from({ length: discoveryCacheMaxEntries + 12 }, (_, index) => ({ repository: `example/model-${index}`, revision, availability: { state: 'installable', reason: '已验证文件组合'.repeat(80) } })))
  assert.ok(saved.entries.length <= discoveryCacheMaxEntries)
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length <= discoveryCacheMaxBytes)
  assert.ok(saved.entries.every(entry => entry.reason.length <= 240))
  assert.equal(cache.get('example/model-0', revision), null)
  const original = structuredClone(saved)
  const badEntries = [
    { ...saved.entries[0], repository: '../unsafe' },
    { ...saved.entries[0], state: 'unverified' },
    { ...saved.entries[0], reason: 'x'.repeat(241) },
    { ...saved.entries[0], revision: 'main' },
  ]
  for (const entry of badEntries) {
    const invalid = createAvailabilityCache({ cached: { ...original, entries: [entry] }, extensionVersion: '1.0.0' })
    assert.equal(invalid.get(entry.repository, entry.revision), null)
  }
  const oversized = { ...original, entries: Array.from({ length: 1000 }, (_, i) => ({ ...original.entries[0], repository: `example/restored-${i}`, unexpected: 'not retained' })) }
  const restored = createAvailabilityCache({ cached: oversized, persist, extensionVersion: '1.0.0' })
  await restored.put([{ repository: 'example/final', revision, availability: { state: 'unsupported', reason: 'missing files' } }])
  assert.ok(saved.entries.length <= discoveryCacheMaxEntries)
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length <= discoveryCacheMaxBytes)
  assert.ok(saved.entries.every(entry => !('unexpected' in entry)))
})

test('persistence stays sequential and a rejected write cannot prevent subsequent saves', async () => {
  let release
  const first = new Promise(resolve => { release = resolve })
  const order = []
  const cache = createAvailabilityCache({ persist: async value => {
    order.push(value.entries.length)
    if (value.entries.length === 1) { await first; throw Error('first save failed') }
  } })
  const put = name => cache.put([{ repository: `example/${name}`, revision, availability: { state: 'installable', reason: 'verified' } }])
  const a = put('a'), b = put('b')
  await Promise.resolve()
  assert.deepEqual(order, [1])
  release()
  await Promise.all([a, b])
  assert.deepEqual(order, [1, 2])
  assert.equal(cache.get('example/b', revision).state, 'installable')
})
