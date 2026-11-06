import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundDownloadHistory, downloadHistoryMaxBytes, fitStorage, jsonBytes, restoreDownloadHistory, storageMaxBytes } from '../downloadHistory.js'

const record = (i, state = 'completed') => ({ id: `job-${i}`, modelId: 'model', title: '模型', mode: 'download', startedAt: i, endedAt: state === 'preparing' ? null : i + 10, state, downloadedBytes: 12, totalBytes: 20 })

test('restart preserves completed records and marks only unfinished records interrupted without inventing an end time', () => {
  const completed = record(1)
  const pending = { ...record(2, 'preparing'), url: 'https://secret.invalid/?token=secret', handle: 'temporary' }
  const restored = restoreDownloadHistory([pending, completed])
  assert.equal(restored.changed, true)
  assert.deepEqual(restored.history[1], completed)
  assert.equal(restored.history[0].state, 'interrupted')
  assert.equal(restored.history[0].endedAt, null)
  assert.equal(restored.history[0].downloadedBytes, 12)
  assert.equal(restored.history[0].url, undefined)
  assert.equal(restored.history[0].handle, undefined)
  assert.equal(restoreDownloadHistory(restored.history).changed, false)
})

test('history rejects malformed fields and deduplicates IDs without accepting imports or engine records', () => {
  const invalid = [null, {}, { ...record(1), downloadedBytes: -1 }, { ...record(1), totalBytes: Infinity }, { ...record(1), totalBytes: 0.5 }, { ...record(1), state: 'invented' }, { ...record(1), mode: 'file' }, { ...record(1), modelId: undefined }, { ...record(1), startedAt: -1 }]
  assert.deepEqual(restoreDownloadHistory(invalid).history, [])
  assert.equal(restoreDownloadHistory([record(1), record(1)]).history.length, 1)
  assert.deepEqual(restoreDownloadHistory(null), { history: [], changed: false })
  assert.deepEqual(restoreDownloadHistory([record(3), record(1), record(2)]).history.map(item => item.id), ['job-3', 'job-2', 'job-1'])
})

test('history is bounded both by record count and encoded storage bytes, keeping the newest first', () => {
  const many = Array.from({ length: 80 }, (_, i) => record(80 - i))
  assert.equal(boundDownloadHistory(many).length, 50)
  const large = many.map(item => ({ ...item, title: '模'.repeat(160), message: '信'.repeat(240) }))
  const bounded = boundDownloadHistory(large)
  assert.ok(bounded.length < 50)
  assert.ok(jsonBytes(bounded) <= downloadHistoryMaxBytes)
  assert.equal(bounded[0].id, 'job-80')
})

test('storage drops cache before history and drops oldest history before touching configuration', () => {
  const history = [record(3), record(2), record(1)]
  let base = { models: { retained: 'x' }, downloadHistory: history, discoveryCache: { large: 'c'.repeat(1000) } }
  base.models.retained = 'x'.repeat(storageMaxBytes - jsonBytes(base) + 500)
  let fitted = fitStorage(base)
  assert.equal(fitted.value.discoveryCache, undefined)
  assert.deepEqual(fitted.value.downloadHistory, history)
  assert.equal(fitted.value.models.retained, base.models.retained)
  assert.equal(fitted.historyTrimmed, false)
  const value = { ...fitted.value }
  value.models = { retained: 'x'.repeat(storageMaxBytes - jsonBytes({ models: { retained: '' }, downloadHistory: [record(3)] })) }
  fitted = fitStorage(value)
  assert.deepEqual(fitted.value.downloadHistory, [record(3)])
  assert.equal(fitted.historyTrimmed, true)
  assert.equal(fitted.value.models.retained, value.models.retained)
  assert.equal(jsonBytes(fitted.value), storageMaxBytes)
  assert.throws(() => fitStorage({ models: { retained: 'x'.repeat(storageMaxBytes) } }), /空间不足/)
})
