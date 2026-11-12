import type { Json, LegacyTaskCleanupProgress } from './lexora'

export const pluginId = 'p95e8d9a8d120433d9ba2058e1c844ed0.legacy-task-cleanup'
export const stateMessage = 'cleanup-state'
export type CleanupState = Omit<LegacyTaskCleanupProgress, 'phase' | 'errorCode'> & {
  requestId: string | null
  countsKnown: boolean
  revision: number
  phase: LegacyTaskCleanupProgress['phase'] | 'idle' | 'starting' | 'interrupted'
  errorMessage: string | null
}

export function initialState(): CleanupState {
  return { revision: 0, requestId: null, phase: 'idle', total: null, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 0, countsKnown: false, errorMessage: null }
}

export function localizedError(code: string | null): string {
  switch (code) {
    case 'EXTENSION_TASK_CLEANUP_BUSY':
      return '已有清理操作正在处理，请稍后从插件菜单重新确认。'
    case 'EXTENSION_METHOD_DENIED':
    case 'EXTENSION_PERMISSION_DENIED':
      return '当前入口或授权不可用，请从插件卡片的清理菜单重新发起。'
    default:
      return '本次清理未能完整完成。已受理的作业可能继续处理，请勿将未知结果视为已删除。'
  }
}

export function readState(value: Json): CleanupState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const phases = ['idle', 'starting', 'scanning', 'confirming', 'running', 'completed', 'cancelled', 'failed', 'interrupted']
  if (typeof value.phase !== 'string' || !phases.includes(value.phase))
    return null
  for (const key of ['revision', 'processed', 'deleted', 'pending', 'failed', 'skipped']) {
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
      return null
  }
  for (const key of ['total']) {
    if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0))
      return null
  }
  if (value.requestId !== null && (typeof value.requestId !== 'string' || !value.requestId))
    return null
  if (typeof value.countsKnown !== 'boolean')
    return null
  if (value.errorMessage !== null && typeof value.errorMessage !== 'string')
    return null
  return value as CleanupState
}
