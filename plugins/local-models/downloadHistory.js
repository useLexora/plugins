export const downloadHistoryMaxEntries = 50
export const downloadHistoryMaxBytes = 32 * 1024
export const storageMaxBytes = 256 * 1024
export const historyWarningMessage = '下载历史未能完整保存，当前记录仍在内存中；已准备的模型和文件不受影响。'

export const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length
const isNumber = value => Number.isSafeInteger(value) && value >= 0
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const activeStates = new Set(['preparing', 'cancelling'])

export function historyRecord(job, title, endedAt = null) {
  return {
    id: job.id, modelId: job.modelId, title: title.slice(0, 160), mode: 'download',
    startedAt: job.startedAt, endedAt, state: job.state,
    downloadedBytes: job.downloadedBytes, totalBytes: job.totalBytes,
    ...(typeof job.message === 'string' && job.message ? { message: job.message.slice(0, 240) } : {}),
  }
}

export function boundDownloadHistory(records) {
  const bounded = records.slice(0, downloadHistoryMaxEntries)
  while (bounded.length && jsonBytes(bounded) > downloadHistoryMaxBytes) bounded.pop()
  return bounded
}

export function restoreDownloadHistory(stored) {
  const records = []
  const ids = new Set()
  let interrupted = false
  if (Array.isArray(stored)) for (const item of stored) {
    if (!item || !isText(item.id, 128) || !isText(item.modelId, 256) || !isText(item.title, 160) || item.mode !== 'download' || !isNumber(item.startedAt) || !(item.endedAt === null || isNumber(item.endedAt)) || !isNumber(item.downloadedBytes) || !(item.totalBytes === null || isNumber(item.totalBytes)) || (!terminalStates.has(item.state) && !activeStates.has(item.state)) || ids.has(item.id)) continue
    const record = historyRecord(item, item.title, item.endedAt)
    if (activeStates.has(record.state)) {
      interrupted = true
      record.state = 'interrupted'
      record.endedAt = null
      record.message = '上次下载未正常结束，未自动重试。'
    }
    records.push(record)
    ids.add(item.id)
  }
  records.sort((a, b) => b.startedAt - a.startedAt)
  const history = boundDownloadHistory(records)
  return { history, changed: interrupted || (Array.isArray(stored) && JSON.stringify(history) !== JSON.stringify(stored)) }
}

export function fitStorage(value) {
  value = { ...value }
  let historyTrimmed = false
  if (jsonBytes(value) > storageMaxBytes) delete value.discoveryCache
  if (Array.isArray(value.downloadHistory)) {
    const history = boundDownloadHistory(value.downloadHistory)
    historyTrimmed = history.length !== value.downloadHistory.length
    value.downloadHistory = history
    while (history.length && jsonBytes(value) > storageMaxBytes) { history.pop(); historyTrimmed = true }
    if (!history.length && jsonBytes(value) > storageMaxBytes) delete value.downloadHistory
  }
  if (jsonBytes(value) > storageMaxBytes) throw Error('插件配置存储空间不足')
  return { value, historyTrimmed }
}
