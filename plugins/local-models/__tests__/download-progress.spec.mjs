import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDownloadProgress, exactFileSize } from '../downloadProgress.js'

const event = (path, bytes, totalBytes = null, phase = 'download') => ({ path, bytes, totalBytes, phase })

test('only exact nonnegative safe file sizes are accepted, including zero', () => {
  for (const size of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(exactFileSize({ size }), size)
    assert.equal(exactFileSize({ bytes: size }), size)
  }
  for (const size of [undefined, null, '10', -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(exactFileSize({ size }), null)
  assert.equal(exactFileSize({ size: 0, bytes: 123 }), 0)
})

test('input counters are resource-scoped and aggregate files and archives without counting verification or extraction', () => {
  const tracker = createDownloadProgress([
    { id: 'a', files: [{ path: 'same', size: 10 }, { path: 'unknown' }] },
    { id: 'b', files: [{ path: 'same', bytes: 20 }] },
    { id: 'archive', archives: [{ id: 'input', size: 5 }], files: [{ path: 'expanded', bytes: 100 }] },
  ], 'download')
  assert.equal(tracker.snapshot().totalBytes, null)
  assert.equal(tracker.update('a', event('same', 10, 10)).downloadedBytes, 10)
  assert.equal(tracker.update('a', event('same', 8, 10)).downloadedBytes, 10)
  assert.equal(tracker.update('a', event('same', 10, 10, 'verify')).downloadedBytes, 10)
  let value = tracker.update('a', event('unknown', 3, 7))
  assert.equal(value.downloadedBytes, 13)
  assert.equal(value.totalBytes, 42)
  assert.equal(tracker.update('a', event('unknown', 7, 7)).downloadedBytes, 17)
  assert.equal(tracker.update('b', event('same', 20, 20)).downloadedBytes, 37)
  assert.equal(tracker.update('archive', event('input', 5, 5)).downloadedBytes, 42)
  assert.equal(tracker.update('archive', event('expanded', 100, 100, 'extract')).downloadedBytes, 42)
  value = tracker.update('archive', event('', 100, 100, 'ready'))
  assert.equal(value.downloadedBytes, 42)
  assert.equal(value.totalBytes, 42)
})

test('real byte increases alone update last reception and speed, with no invented timeout failure', t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const tracker = createDownloadProgress([{ id: 'a', files: [{ path: 'x', size: 100 }] }], 'download')
  now = 2000
  let value = tracker.update('a', event('x', 0, 100, 'connect'))
  assert.equal(value.updatedAt, 2000)
  assert.equal(value.lastReceivedAt, null)
  assert.equal(value.bytesPerSecond, 0)
  now = 3000
  value = tracker.update('a', event('x', 20, 100))
  assert.equal(value.lastReceivedAt, 3000)
  assert.equal(value.bytesPerSecond, 10)
  now = 4000
  value = tracker.update('a', event('x', 40, 100))
  assert.equal(value.bytesPerSecond, 20)
  value = tracker.update('a', event('x', 50, 100))
  assert.ok(Number.isFinite(value.bytesPerSecond))
  now = 5000
  value = tracker.update('a', event('x', 60, 100))
  assert.equal(value.bytesPerSecond, 20)
  now = 80000
  value = tracker.update('a', event('x', 60, 100))
  assert.equal(value.lastReceivedAt, 5000)
  assert.equal(value.phase, 'download')
  assert.equal(value.state, undefined)
  value = tracker.update('a', event('x', 100, 100, 'verify'))
  assert.equal(value.downloadedBytes, 60)
  assert.equal(value.lastReceivedAt, 5000)
  assert.equal(value.bytesPerSecond, 0)
  assert.equal(tracker.finish(false).downloadedBytes, 60)
})

test('resumed bytes count toward completion but not speed, and ignored Range resets the real baseline', t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const tracker = createDownloadProgress([{ id: 'a', files: [{ path: 'x', size: 100 }, { path: 'y', size: 10 }] }], 'download')
  now = 2000
  let value = tracker.update('a', { ...event('x', 60, 100, 'connect'), resumedBytes: 60 })
  assert.equal(value.downloadedBytes, 60)
  assert.equal(value.resumedBytes, 60)
  assert.equal(value.bytesPerSecond, 0)
  assert.equal(value.lastReceivedAt, null)
  now = 3000
  value = tracker.update('a', { ...event('x', 70, 100), resumedBytes: 60 })
  assert.equal(value.bytesPerSecond, 10)
  assert.equal(value.lastReceivedAt, 3000)
  now = 4000
  value = tracker.update('a', { ...event('x', 0, 100), resumedBytes: 0 })
  assert.equal(value.downloadedBytes, 0)
  assert.equal(value.resumedBytes, 0)
  assert.equal(value.bytesPerSecond, 0)
  assert.equal(value.lastReceivedAt, 3000)
  now = 5000
  value = tracker.update('a', { ...event('x', 20, 100), resumedBytes: 0 })
  assert.equal(value.bytesPerSecond, 20)
  assert.equal(value.downloadedBytes, 20)
  now = 6000
  value = tracker.update('a', { ...event('y', 10, 10), resumedBytes: 10 })
  assert.equal(value.downloadedBytes, 30)
  assert.equal(value.resumedBytes, 10)
  assert.equal(value.bytesPerSecond, 0)
  assert.equal(value.lastReceivedAt, 5000)
})

test('unknown totals stay unknown even after successful preparation, while empty files remain exact zero', () => {
  const tracker = createDownloadProgress([{ id: 'a', bytes: 999, files: [{ path: 'x' }] }], 'download')
  tracker.update('a', event('x', 10))
  assert.equal(tracker.finish(true).totalBytes, null)
  const empty = createDownloadProgress([{ id: 'a', files: [{ path: 'x', size: 0 }] }], 'download')
  assert.equal(empty.update('a', event('x', 0, 0)).lastReceivedAt, null)
  assert.equal(empty.finish(true).totalBytes, 0)
  const imported = createDownloadProgress([{ id: 'a', files: [{ path: 'x', size: 10 }] }], 'file')
  assert.equal(imported.update('a', event('x', 10, 10, 'verify')).downloadedBytes, 0)
})
