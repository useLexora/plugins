const isBytes = value => Number.isSafeInteger(value) && value >= 0

export function exactFileSize(file) {
  if (isBytes(file.size)) return file.size
  return isBytes(file.bytes) ? file.bytes : null
}

export function createDownloadProgress(resources, mode, startedAt = Date.now()) {
  const inputs = new Map(resources.map(resource => [resource.id, new Map(mode === 'download'
    ? (resource.archives ?? resource.files).map(file => [resource.archives ? file.id : file.path, { bytes: 0, resumed: 0, total: exactFileSize(file) }])
    : [])]))
  let updatedAt = Date.now()
  let lastReceivedAt = null
  let measuredAt = startedAt
  let measuredBytes = 0
  let bytesPerSecond = 0
  let phase = 'preparing'

  function snapshot() {
    const files = [...inputs.values()].flatMap(files => [...files.values()])
    const downloadedBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const resumedBytes = files.reduce((sum, file) => sum + file.resumed, 0)
    const total = files.every(file => file.total !== null && file.total >= file.bytes) ? files.reduce((sum, file) => sum + file.total, 0) : null
    return { startedAt, updatedAt, lastReceivedAt, downloadedBytes, resumedBytes, totalBytes: isBytes(total) ? total : null, bytesPerSecond, phase }
  }

  function update(resourceId, progress) {
    updatedAt = Date.now()
    phase = ['connect', 'download', 'verify', 'extract', 'ready'].includes(progress.phase) ? progress.phase : 'preparing'
    const file = inputs.get(resourceId)?.get(progress.path)
    if (file && ['connect', 'download'].includes(phase)) {
      if (file.total === null && isBytes(progress.totalBytes)) file.total = progress.totalBytes
      if (isBytes(progress.resumedBytes) && progress.resumedBytes <= progress.bytes && progress.resumedBytes !== file.resumed) {
        file.bytes = progress.resumedBytes
        file.resumed = progress.resumedBytes
        const value = snapshot()
        measuredBytes = value.downloadedBytes - value.resumedBytes
        measuredAt = updatedAt
        bytesPerSecond = 0
      }
      if (phase === 'download' && isBytes(progress.bytes) && progress.bytes > file.bytes) {
        file.bytes = progress.bytes
        lastReceivedAt = updatedAt
        const value = snapshot()
        const bytes = value.downloadedBytes - value.resumedBytes
        if (updatedAt > measuredAt) {
          bytesPerSecond = (bytes - measuredBytes) * 1000 / (updatedAt - measuredAt)
          measuredAt = updatedAt
          measuredBytes = bytes
        }
      }
    }
    if (phase !== 'download') bytesPerSecond = 0
    return snapshot()
  }

  function finish(completed) {
    updatedAt = Date.now()
    bytesPerSecond = 0
    if (completed) phase = 'ready'
    return snapshot()
  }

  return { snapshot, update, finish }
}
