import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthorAvatars } from '../authorAvatars.js'

function fixture(options = {}) {
  const controller = new AbortController()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const requests = [], resources = new Set()
  const context = {
    signal: controller.signal,
    network: { download: async (url, { signal }) => {
      requests.push(url)
      await options.wait?.(signal)
      signal.throwIfAborted()
      const resource = { id: url, mimeType: 'image/png', size: options.size ?? bytes.length }
      resources.add(resource)
      return resource
    } },
    resources: {
      readBytes: async () => ({ data: bytes, eof: true }),
      release: async resource => { resources.delete(resource) },
    },
  }
  return { avatars: createAuthorAvatars(context), controller, requests, resources, bytes }
}

test('author avatars share one downloaded image and release data only after the last consumer leaves', async () => {
  const f = fixture()
  const first = f.avatars.acquire('Author'), second = f.avatars.acquire('author')
  const [url, same] = await Promise.all([first.value, second.value])
  assert.equal(url, same)
  assert.deepEqual(f.requests, ['https://huggingface.co/api/avatars/Author'])
  assert.equal(f.resources.size, 0)
  first.release()
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), f.bytes)
  second.release()
  await assert.rejects(fetch(url))
  f.avatars.dispose()
})

test('releasing avatar consumers cancels active requests and prevents queued downloads', async () => {
  const f = fixture({ wait: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const leases = Array.from({ length: 12 }, (_, i) => f.avatars.acquire(`author-${i}`))
  const started = f.requests.length
  assert.ok(started > 0 && started < leases.length, 'exercise both active and queued consumers')
  leases.forEach(lease => lease.release())
  assert.deepEqual(await Promise.all(leases.map(lease => lease.value)), Array(leases.length).fill(''))
  assert.equal(f.requests.length, started)
  assert.equal(f.resources.size, 0)
  f.avatars.dispose()
})

test('view closure invalidates image URLs and prevents further avatar work', async () => {
  const f = fixture()
  const lease = f.avatars.acquire('author')
  const url = await lease.value
  f.controller.abort()
  await assert.rejects(fetch(url))
  assert.equal(await f.avatars.acquire('another').value, '')
  assert.equal(f.requests.length, 1)
  lease.release()
})

test('malformed authors and oversized images produce a quiet fallback without retaining temporary files', async () => {
  const f = fixture({ size: 3 * 1024 * 1024 })
  for (const owner of ['', '../escape', 'https://other.test/a', 'user?token=private'])
    assert.equal(await f.avatars.acquire(owner).value, '')
  assert.deepEqual(f.requests, [])
  const lease = f.avatars.acquire('valid-author')
  assert.equal(await lease.value, '')
  assert.equal(f.resources.size, 0)
  lease.release()
  f.avatars.dispose()
})
