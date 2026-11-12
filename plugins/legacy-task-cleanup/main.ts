import type { ExtensionContext, LegacyTaskCleanupProgress } from './lexora'
import { initialState, localizedError, stateMessage } from './state'

export function activate(context: ExtensionContext) {
  const id = context.extension.id
  const placement = `${id}.progress-panel`
  let state = initialState()
  let active = false
  let revision = 0
  let withdrawn = false
  let waiting: { requestId: string, settle: (confirmed: boolean) => void } | null = null

  function publish() {
    state = { ...state, revision: ++revision }
    void context.views.broadcast({ type: stateMessage, state: { ...state } }).catch(() => {})
  }

  function cancel() {
    withdrawn = true
    waiting?.settle(false)
    if (state.requestId) {
      state = { ...state, phase: 'cancelled', requestId: null }
      publish()
    }
  }

  function applyProgress(progress: LegacyTaskCleanupProgress) {
    const terminal = ['completed', 'cancelled', 'failed'].includes(progress.phase)
    if (terminal)
      waiting?.settle(false)
    const { errorCode, ...snapshot } = progress
    state = { ...snapshot, revision, requestId: terminal ? null : state.requestId, countsKnown: progress.total !== null, errorMessage: progress.phase === 'failed' ? localizedError(errorCode) : null }
    publish()
  }

  context.signal.addEventListener('abort', cancel, { once: true })
  context.subscriptions.add(context.commands.register(`${id}.get-status`, () => ({ ...state })))
  context.subscriptions.add(context.commands.register(`${id}.show-progress`, async () => {
    await context.placements.show(placement)
  }))
  context.subscriptions.add(context.commands.register(`${id}.respond-confirmation`, ({ arguments: args, invocation }) => {
    if (invocation?.target !== 'view' || !args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.requestId !== 'string' || args.requestId !== state.requestId || typeof args.confirmed !== 'boolean')
      return false
    if (!args.confirmed) {
      cancel()
      return true
    }
    if (state.phase !== 'confirming' || waiting?.requestId !== args.requestId || withdrawn || context.signal.aborted)
      return false
    waiting.settle(true)
    return true
  }))
  context.subscriptions.add(context.commands.register(`${id}.hide-progress`, async ({ arguments: args }) => {
    if (state.requestId) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || args.requestId !== state.requestId)
        return false
      cancel()
    }
    await context.placements.hide(placement)
    return true
  }))
  context.subscriptions.add(context.commands.register(`${id}.cleanup`, async ({ taskCleanup, invocation }) => {
    if (invocation?.target !== 'extension.actions' || !taskCleanup)
      throw new Error('请从本插件卡片的“清理任务残留…”菜单发起。')
    if (active) {
      await context.placements.show(placement)
      return
    }

    active = true
    withdrawn = false
    let sealed = false
    let confirmed = false
    let asked = false
    state = { ...initialState(), revision, phase: 'starting', requestId: crypto.randomUUID() }
    publish()
    try {
      await context.placements.show(placement)
      if (context.signal.aborted || withdrawn)
        return
      const result = await taskCleanup.run({
        confirm(preview, signal) {
          if (asked || sealed || withdrawn || signal.aborted || context.signal.aborted || !state.requestId)
            return false
          asked = true
          const requestId = state.requestId
          return new Promise<boolean>((resolve) => {
            const abort = () => cancel()
            waiting = {
              requestId,
              settle(accepted) {
                if (waiting?.requestId !== requestId)
                  return
                waiting = null
                signal.removeEventListener('abort', abort)
                confirmed = accepted === true && !signal.aborted && !context.signal.aborted && !withdrawn
                state = { ...state, requestId: null, phase: confirmed ? 'running' : 'cancelled' }
                publish()
                resolve(confirmed)
              },
            }
            signal.addEventListener('abort', abort, { once: true })
            state = { ...state, ...preview, countsKnown: true, phase: 'confirming' }
            publish()
          })
        },
        onProgress(progress) {
          if (sealed || context.signal.aborted || progress.phase === 'confirming')
            return
          if (withdrawn && !confirmed && !['completed', 'cancelled', 'failed'].includes(progress.phase))
            return
          applyProgress(progress)
          sealed = ['completed', 'cancelled', 'failed'].includes(progress.phase)
        },
      })
      sealed = true
      if (!context.signal.aborted)
        applyProgress(result.summary)
    }
    catch {
      sealed = true
      waiting?.settle(false)
      if (!context.signal.aborted) {
        state = {
          ...state,
          requestId: null,
          phase: 'interrupted',
          errorMessage: confirmed
            ? '未能取得完整结果。下方保留最后确认的计数，已受理的作业可能仍在后台处理。'
            : '未能取得完整结果。本轮尚未确认删除，未提交清理；请从原菜单重新发起。',
        }
        publish()
      }
    }
    finally {
      sealed = true
      waiting?.settle(false)
      active = false
    }
  }))
}
