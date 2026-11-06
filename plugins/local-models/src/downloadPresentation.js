import { formatBytes } from './catalogPresentation.js'

export const downloadActive = job => !!job && ['preparing', 'cancelling', 'committing'].includes(job.state)
const finiteBytes = value => Number.isSafeInteger(value) && value >= 0
export const latestJob = (current, incoming) => current?.updatedAt > incoming?.updatedAt ? current : incoming

export function downloadPresentation(job, now = Date.now()) {
  const active = downloadActive(job)
  const phase = job.phase ?? job.progress?.phase ?? 'preparing'
  const download = job.mode === 'download'
  const received = download && finiteBytes(job.downloadedBytes) ? job.downloadedBytes : finiteBytes(job.progress?.bytes) ? job.progress.bytes : 0
  const total = download && Object.hasOwn(job, 'totalBytes') ? finiteBytes(job.totalBytes) ? job.totalBytes : null : finiteBytes(job.progress?.totalBytes) ? job.progress.totalBytes : null
  const percent = job.state === 'interrupted' ? null : total > 0 && received <= total ? Math.min(100, Math.floor(received / total * 100)) : total === 0 && job.state === 'completed' ? 100 : null
  const lastReceived = job.lastReceivedAt ?? job.startedAt
  const idleSeconds = Number.isFinite(lastReceived) ? Math.max(0, Math.floor((now - lastReceived) / 1000)) : 0
  const waiting = active && download && ['connect', 'download'].includes(phase) && idleSeconds >= 10
  const resuming = finiteBytes(job.resumedBytes) && job.resumedBytes > 0
  const stages = { preparing: '准备中', connect: resuming ? '正在续传' : '连接中', download: resuming ? '正在续传' : received ? '下载中' : '等待数据', verify: '校验中', extract: '解压中', ready: '正在保存' }
  const states = { completed: '已完成', failed: download ? '下载失败' : '导入失败', cancelled: '已取消', interrupted: '已中断', cancelling: '正在取消', committing: '正在保存' }
  const label = states[job.state] ?? (download ? stages[phase] : { download: '正在读取文件', verify: '校验中', extract: '解压中', ready: '正在保存' }[phase]) ?? '准备中'
  const rate = active && download && phase === 'download' && !waiting && Number.isFinite(job.bytesPerSecond) && job.bytesPerSecond > 0 ? `${formatBytes(job.bytesPerSecond)}/s` : ''
  return {
    active, phase, percent, label, received, total, rate,
    amount: `${job.state === 'interrupted' ? '下载量未保存' : formatBytes(received)} / ${total === null ? '总量未知' : formatBytes(total)}`,
    waiting: waiting ? `${idleSeconds} 秒未收到数据` : '',
    tone: active ? 'busy' : job.state === 'completed' ? 'ready' : ['failed', 'interrupted'].includes(job.state) ? 'attention' : 'neutral',
  }
}

export function downloadEntries(state, specifications, inLibrary) {
  const history = [...(state.downloadHistory ?? [])]
  const job = state.job
  if (job?.mode === 'download' && job.modelId && job.id) {
    const index = history.findIndex(item => item.id === job.id)
    if (index < 0) history.unshift(job)
    else history[index] = { ...history[index], ...job }
  }
  const recorded = new Set(history.map(item => item.modelId))
  const pending = state.models.filter(model => !recorded.has(model.id) && !inLibrary(model, state.resources, specifications)).map(model => ({ id: `pending:${model.id}`, modelId: model.id, title: model.title, state: 'pending' }))
  return [...history, ...pending].map(entry => ({ ...entry, model: state.models.find(model => model.id === entry.modelId) }))
}
