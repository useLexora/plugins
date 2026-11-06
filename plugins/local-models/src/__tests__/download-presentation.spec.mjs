import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadEntries, downloadPresentation, latestJob } from '../downloadPresentation.js'

const job = { id: 'transfer', modelId: 'model', mode: 'download', state: 'preparing', phase: 'download', startedAt: 1000, lastReceivedAt: 2000, downloadedBytes: 1024, totalBytes: 4096, bytesPerSecond: 512 }

test('shows real aggregate bytes, percentage and rate without treating a partial file total as aggregate', () => {
  assert.equal(downloadPresentation(job, 3000).percent, 25)
  assert.equal(downloadPresentation(job, 3000).rate, '512 B/s')
  const unknown = downloadPresentation({ ...job, totalBytes: null, progress: { bytes: 1, totalBytes: 1 } }, 3000)
  assert.equal(unknown.percent, null)
  assert.match(unknown.amount, /总量未知/)
  assert.equal(downloadPresentation({ ...job, downloadedBytes: 5000 }, 3000).percent, null)
  assert.equal(downloadPresentation({ ...job, mode: 'file', downloadedBytes: 0, totalBytes: 0, progress: { bytes: 5, totalBytes: 10 } }).percent, 50)
})

test('shows continuation only when the host confirms reused bytes', () => {
  assert.equal(downloadPresentation({ ...job, phase: 'connect', resumedBytes: 1024 }, 3000).label, '正在续传')
  assert.equal(downloadPresentation({ ...job, resumedBytes: 1024 }, 3000).label, '正在续传')
  assert.equal(downloadPresentation({ ...job, resumedBytes: 0 }, 3000).label, '下载中')
})

test('reports lack of received data rather than a network fault or stale nonzero speed', () => {
  const stale = downloadPresentation({ ...job, updatedAt: 14000 }, 14000)
  assert.equal(stale.waiting, '12 秒未收到数据')
  assert.equal(stale.rate, '')
  assert.equal(stale.label, '下载中')
  const connection = downloadPresentation({ ...job, phase: 'connect', lastReceivedAt: null, downloadedBytes: 0 }, 14000)
  assert.equal(connection.label, '连接中')
  assert.equal(connection.waiting, '13 秒未收到数据')
  assert.equal(downloadPresentation({ ...job, phase: 'verify' }, 14000).waiting, '')
})

test('keeps newer progress when an older status poll completes, but permits an explicit reset', () => {
  const current = { ...job, updatedAt: 3000 }
  assert.deepEqual(latestJob(current, { ...job, updatedAt: 2000 }), current)
  assert.equal(latestJob(current, null), null)
})

test('distinguishes validation and terminal states without inventing restart progress', () => {
  assert.equal(downloadPresentation({ ...job, phase: 'verify' }, 3000).label, '校验中')
  assert.equal(downloadPresentation({ ...job, state: 'cancelled' }, 14000).received, 1024)
  assert.equal(downloadPresentation({ ...job, state: 'cancelled' }, 14000).waiting, '')
  const interrupted = downloadPresentation({ ...job, state: 'interrupted' }, 14000)
  assert.equal(interrupted.percent, null)
  assert.match(interrupted.amount, /下载量未保存/)
})

test('merges current job into its exact historical attempt while keeping pending records accessible', () => {
  const state = { job, resources: [], models: [{ id: 'model' }, { id: 'pending', title: 'Pending' }], downloadHistory: [{ ...job, downloadedBytes: 0 }, { ...job, id: 'older', state: 'failed' }] }
  const entries = downloadEntries(state, [], () => false)
  assert.deepEqual(entries.map(entry => entry.id), ['transfer', 'older', 'pending:pending'])
  assert.equal(entries[0].downloadedBytes, 1024)
  assert.equal(entries[1].state, 'failed')
  assert.equal(downloadEntries({ ...state, job: { ...job, modelId: undefined } }, [], () => false)[0].downloadedBytes, 0)
})
