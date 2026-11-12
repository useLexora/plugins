import type { Json, MountGeometry, ViewContext } from './lexora'
import type { CleanupState } from './state'
import { pluginId, readState, stateMessage } from './state'

export function render(context: ViewContext, container: HTMLElement) {
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('./style.css', import.meta.url).href
  container.append(stylesheet)
  const panel = document.createElement('section')
  panel.className = 'cleanup-panel'
  panel.dataset.testid = 'legacy-task-cleanup-panel'
  panel.setAttribute('aria-label', '任务残留清理确认、进度与结果')
  panel.innerHTML = `
    <header class="panel-header">
      <div class="panel-heading"><span class="panel-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg></span><h1>任务残留清理</h1></div>
      <button class="close-button" type="button" aria-label="关闭面板，不取消已受理的清理"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <div class="panel-content">
      <div class="status-row"><span class="status-dot" aria-hidden="true"></span><h2 role="status" aria-live="polite" aria-atomic="true">正在读取状态…</h2></div>
      <p class="description">仅展示本次应用会话中的最近一次清理。</p>
      <div class="confirmation-preview" data-testid="cleanup-preview" hidden>
        <div class="scope-summary"><span>待清理的任务残留</span><span class="scope-amount"><strong data-testid="cleanup-preview-total">0</strong><span>项</span></span></div>
        <p class="risk"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 3 8 14H2L10 3Z M10 8v3 M10 14h.01" /></svg>删除后不可恢复</p>
        <ul class="scope-boundaries"><li>不处理活动或已归档任务</li><li>不删除用户工作区及外部文件</li></ul>
        <p class="preview-skipped">另有 <span data-testid="cleanup-preview-skipped">0</span> 个不符合条件的任务已跳过。</p>
      </div>
      <div class="progress-section" hidden>
        <div class="progress-caption"><span class="progress-label"></span><span class="progress-count"><span data-testid="cleanup-processed">0</span> / <span data-testid="cleanup-total">—</span></span></div>
        <progress aria-label="已处理的清理项目" max="1" value="0"></progress>
      </div>
      <dl class="counts" hidden>
        <div><dt>已删除</dt><dd data-count="deleted" data-testid="cleanup-deleted">0</dd></div>
        <div><dt>后台处理中</dt><dd data-count="pending" data-testid="cleanup-pending">0</dd></div>
        <div><dt>失败</dt><dd data-count="failed" data-testid="cleanup-failed">0</dd></div>
        <div><dt>已跳过</dt><dd data-count="skipped" data-testid="cleanup-skipped">0</dd></div>
      </dl>
      <p class="notice" hidden></p>
      <p class="retry-guide">再次清理：返回本插件菜单「清理任务残留…」，重新确认范围。</p>
      <p class="local-error" role="alert" hidden></p>
    </div>
    <footer class="panel-footer"><p class="footer-note">可从插件菜单「查看进度与结果」重开。</p><div class="confirmation-actions" hidden><button class="cancel-button" data-testid="cleanup-cancel" type="button">取消</button><button class="delete-button" data-testid="cleanup-confirm-delete" type="button">删除</button></div><button class="hide-button" type="button">关闭</button></footer>
  `
  container.append(panel)
  const select = <T extends Element>(selector: string) => panel.querySelector<T>(selector)!
  const heading = select<HTMLHeadingElement>('h2')
  const description = select<HTMLParagraphElement>('.description')
  const progressSection = select<HTMLDivElement>('.progress-section')
  const progressLabel = select<HTMLSpanElement>('.progress-label')
  const processedCount = select<HTMLSpanElement>('[data-testid="cleanup-processed"]')
  const totalCount = select<HTMLSpanElement>('[data-testid="cleanup-total"]')
  const progressBar = select<HTMLProgressElement>('progress')
  const counts = select<HTMLDListElement>('.counts')
  const notice = select<HTMLParagraphElement>('.notice')
  const localError = select<HTMLParagraphElement>('.local-error')
  const hideButton = select<HTMLButtonElement>('.hide-button')
  const closeButton = select<HTMLButtonElement>('.close-button')
  const preview = select<HTMLDivElement>('.confirmation-preview')
  const actions = select<HTMLDivElement>('.confirmation-actions')
  const cancelButton = select<HTMLButtonElement>('.cancel-button')
  const deleteButton = select<HTMLButtonElement>('.delete-button')
  const footerNote = select<HTMLParagraphElement>('.footer-note')
  let lastRevision = -1
  let lastLayout = ''
  let preferredHeight = 360
  let requestId: string | null = null
  let visible = context.visible
  let hasPresented = visible

  function invalidate() {
    const current = requestId
    requestId = null
    actions.hidden = true
    preview.hidden = true
    if (current)
      return context.commands.execute(`${pluginId}.respond-confirmation`, { requestId: current, confirmed: false }).catch(() => {})
  }

  function display(value: Json) {
    const state = readState(value)
    if (!state || context.signal.aborted || state.revision <= lastRevision)
      return
    lastRevision = state.revision
    localError.hidden = true
    const previousRequest = requestId
    requestId = state.requestId
    if (hasPresented && !visible && requestId) {
      invalidate()
      return
    }
    const confirming = state.phase === 'confirming' && requestId !== null
    panel.dataset.phase = state.phase
    heading.textContent = title(state)
    description.textContent = detail(state)
    preview.hidden = !confirming
    actions.hidden = !confirming
    hideButton.hidden = confirming
    deleteButton.disabled = false
    cancelButton.disabled = false
    select<HTMLElement>('[data-testid="cleanup-preview-total"]').textContent = String(state.total ?? 0)
    select<HTMLElement>('[data-testid="cleanup-preview-skipped"]').textContent = String(state.skipped)
    select<HTMLElement>('.preview-skipped').hidden = state.skipped === 0
    hideButton.textContent = state.phase === 'running' ? '后台继续' : '关闭'
    footerNote.textContent = requestId
      ? '关闭面板即取消本轮清理'
      : state.phase === 'running' ? '关闭后仍会在后台继续' : '可从插件菜单重新查看结果'
    closeButton.setAttribute('aria-label', requestId ? '关闭面板并取消本轮清理' : '关闭面板，不取消已受理的清理')
    counts.hidden = !state.countsKnown || confirming || state.total === 0
    select<HTMLElement>('.retry-guide').hidden = confirming || (state.failed === 0 && !['failed', 'interrupted'].includes(state.phase))
    if (confirming && previousRequest !== requestId)
      cancelButton.focus()
    for (const key of ['deleted', 'pending', 'failed', 'skipped'] as const)
      select<HTMLElement>(`[data-count="${key}"]`).textContent = String(state[key] ?? '未知')

    const hasProgress = state.total !== null && state.total > 0 && !['scanning', 'confirming', 'cancelled'].includes(state.phase)
    progressSection.hidden = !hasProgress
    progressLabel.textContent = state.phase === 'running' ? '处理进度' : '已处理'
    processedCount.textContent = String(state.processed)
    totalCount.textContent = String(state.total ?? '—')
    progressBar.max = Math.max(1, state.total ?? 1)
    progressBar.value = state.processed
    progressBar.setAttribute('aria-valuetext', `共 ${state.total ?? '未知'} 项，已处理 ${state.processed} 项；不代表全部删除完成`)
    const notes = []
    if (state.pending > 0)
      notes.push('后台处理中的项目已受理，不代表已删除。')
    if (state.skipped > 0)
      notes.push('已跳过不符合清理条件的项目。')
    if (state.failed > 0 && state.phase !== 'failed')
      notes.push('部分项目失败；再次尝试需返回原清理菜单重新确认。')
    notice.textContent = notes.join(' ')
    notice.hidden = notes.length === 0
    preferredHeight = confirming ? 360 : state.failed > 0 || state.pending > 0 ? 400 : hasProgress ? 360 : 260
    fit(context.mount)
  }

  async function respond(confirmed: boolean) {
    const current = requestId
    if (!current || !visible || context.signal.aborted)
      return
    const responseRevision = lastRevision
    deleteButton.disabled = true
    cancelButton.disabled = true
    requestId = null
    try {
      const accepted = await context.commands.execute(`${pluginId}.respond-confirmation`, { requestId: current, confirmed })
      if (accepted !== true && !context.signal.aborted && lastRevision === responseRevision) {
        localError.textContent = '本次确认已失效，未提交删除。请从原菜单重新发起。'
        localError.hidden = false
      }
    }
    catch {
      if (!context.signal.aborted && lastRevision === responseRevision) {
        localError.textContent = '未能取得确认回执，请关闭面板后查看最新结果，不会自动重试。'
        localError.hidden = false
      }
    }
    finally {
      if (!context.signal.aborted && lastRevision === responseRevision) {
        actions.hidden = true
        preview.hidden = true
        hideButton.hidden = false
      }
    }
  }

  async function hide() {
    const current = requestId
    invalidate()
    hideButton.disabled = true
    closeButton.disabled = true
    try {
      await context.commands.execute(`${pluginId}.hide-progress`, { requestId: current })
    }
    catch {
      if (!context.signal.aborted) {
        localError.textContent = '暂时无法关闭面板，请稍后再试。'
        localError.hidden = false
      }
    }
    finally {
      if (!context.signal.aborted) {
        hideButton.disabled = false
        closeButton.disabled = false
      }
    }
  }
  cancelButton.addEventListener('click', () => { void respond(false) }, { signal: context.signal })
  deleteButton.addEventListener('click', () => { void respond(true) }, { signal: context.signal })
  hideButton.addEventListener('click', hide, { signal: context.signal })
  closeButton.addEventListener('click', hide, { signal: context.signal })
  const subscription = context.onMessage((message) => {
    if (message && typeof message === 'object' && !Array.isArray(message) && message.type === stateMessage)
      display(message.state)
  })
  function fit(mount: MountGeometry | null) {
    if (!mount || mount.width <= 0 || mount.height <= 0 || context.signal.aborted)
      return
    const inset = Math.min(16, Math.floor(Math.min(mount.width, mount.height) / 10))
    const presentation = { width: Math.min(460, mount.width - inset * 2), height: Math.min(preferredHeight, mount.height - inset * 2), right: inset, bottom: inset }
    const key = JSON.stringify(presentation)
    if (key === lastLayout)
      return
    lastLayout = key
    void context.setPresentation(presentation).catch(() => { lastLayout = '' })
  }
  const geometry = context.onMountChange(fit)
  const visibility = context.onVisibilityChange((value) => {
    visible = value
    if (value)
      hasPresented = true
    else if (hasPresented)
      invalidate()
  })
  const beforeClose = context.onBeforeClose(async () => {
    await invalidate()
    return true
  })
  fit(context.mount)
  context.signal.addEventListener('abort', () => {
    invalidate()
    subscription.dispose()
    geometry.dispose()
    visibility.dispose()
    beforeClose.dispose()
  }, { once: true })
  void context.commands.execute(`${pluginId}.get-status`).then(display).catch(() => {
    if (context.signal.aborted || lastRevision >= 0)
      return
    heading.textContent = '暂时无法读取状态'
    description.textContent = '请关闭后，从插件菜单「查看进度与结果」重新打开。不会自动重试清理。'
  })
}

function title(state: CleanupState): string {
  switch (state.phase) {
    case 'idle': return '本次会话尚未发起清理'
    case 'starting': return '等待宿主反馈'
    case 'scanning': return '正在扫描旧版已移除任务'
    case 'confirming': return '确认清理范围'
    case 'running': return '正在处理清理项目'
    case 'cancelled': return '已取消，未提交清理'
    case 'failed': return '本次清理未完整完成'
    case 'interrupted': return '清理结果尚未确认'
    case 'completed':
      if (state.failed > 0) return '本轮处理结束，部分失败'
      if (state.pending > 0) return '本轮已提交，后台处理中'
      if (state.total === null) return '已收到本轮清理结果'
      return state.total === 0 ? '没有可清理的旧版任务' : '本轮清理已完成'
  }
}

function detail(state: CleanupState): string {
  if (state.errorMessage)
    return state.errorMessage
  switch (state.phase) {
    case 'idle': return '这里只保留当前会话的最近状态，不恢复上次运行中的进度。'
    case 'starting': return '正在准备扫描，尚未提交删除。'
    case 'scanning': return '正在核实范围，尚未开始删除。扫描完成后请在此面板确认。'
    case 'confirming': return '仅清理旧版已移除任务的本地残留，请确认后再删除。'
    case 'running': return '正在逐项清理本地残留，你可以关闭面板并稍后查看结果。'
    case 'cancelled': return '你可以稍后从原菜单重新发起，届时会再次扫描并确认。'
    case 'completed':
      if (state.total === 0) return '本轮未发现需要清理的残留，无需执行删除。'
      if (state.pending > 0) return '仍有项目在后台处理，尚未计入已删除。'
      return '以下为本轮处理结果，现有任务与外部文件不受影响。'
    default: return '下方保留最后确认的计数。再次清理需通过原菜单重新确认。'
  }
}
