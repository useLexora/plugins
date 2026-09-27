import type { Json, ViewContext } from './lexora'

interface Settings { enabled: boolean, intervalMinutes: number, nextRunAt: number | null }
const command = 'lexora.water-reminder'

function settings(value: Json): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || typeof value.intervalMinutes !== 'number' || (value.nextRunAt !== null && typeof value.nextRunAt !== 'number'))
    throw new Error('EXTENSION_SETTINGS_INVALID')
  return { enabled: value.enabled, intervalMinutes: value.intervalMinutes, nextRunAt: value.nextRunAt }
}

export async function render(api: ViewContext, container: HTMLElement) {
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('./style.css', import.meta.url).href
  document.head.append(stylesheet)
  api.signal.addEventListener('abort', () => stylesheet.remove(), { once: true })
  container.innerHTML = `<article class="reminder">
    <img class="reminder__mark" src="${new URL('./icon.svg', import.meta.url).href}" alt="" aria-hidden="true">
    <h1>喝水提醒小助手</h1>
    <p class="description">给忙碌的自己，留一点喝水的时间。</p>
    <form>
      <label class="row"><span><strong>开启提醒</strong><small>到时间后发送一条系统通知</small></span><input name="enabled" type="checkbox" role="switch" aria-label="开启提醒"></label>
      <label class="row"><span><strong>提醒间隔</strong><small>每次保存后重新计时</small></span><span class="interval"><input name="interval" type="number" min="1" max="1440" step="1" required aria-label="提醒间隔"><span>分钟</span></span></label>
      <div class="next"><span>下一次提醒</span><time>—</time></div>
      <div class="actions"><button type="submit" class="primary">保存设置</button><button type="button" data-test-notification>发送测试通知</button></div>
    </form>
    <p class="feedback" role="status" aria-live="polite"></p>
    <p class="note">关闭此页面后仍会提醒；退出 Lexora 后暂停，重新打开后继续。错过的提醒不会补发。</p>
  </article>`
  const form = container.querySelector('form')!
  const enabled = container.querySelector<HTMLInputElement>('[name="enabled"]')!
  const interval = container.querySelector<HTMLInputElement>('[name="interval"]')!
  const next = container.querySelector('time')!
  const feedback = container.querySelector<HTMLParagraphElement>('.feedback')!
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
  let current = settings(await api.commands.execute(`${command}.get`))
  if (api.signal.aborted)
    return
  let busy = false
  function updateNext() {
    next.textContent = current.enabled && current.nextRunAt ? new Date(current.nextRunAt).toLocaleTimeString(api.environment.language, { hour: '2-digit', minute: '2-digit' }) : '已暂停'
    next.dateTime = current.nextRunAt ? new Date(current.nextRunAt).toISOString() : ''
  }
  function restoreForm() {
    enabled.checked = current.enabled
    interval.value = String(current.intervalMinutes)
    updateNext()
  }
  async function run(action: () => Promise<void>) {
    if (busy)
      return
    busy = true
    feedback.textContent = ''
    feedback.classList.remove('is-error')
    for (const button of buttons) button.disabled = true
    try { await action() }
    catch (error) {
      feedback.textContent = `操作未完成，请重试。${error instanceof Error ? error.message : ''}`
      feedback.classList.add('is-error')
    }
    finally {
      busy = false
      for (const button of buttons) button.disabled = false
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!form.reportValidity())
      return
    void run(async () => {
      current = settings(await api.commands.execute(`${command}.save`, { enabled: enabled.checked, intervalMinutes: interval.valueAsNumber }))
      restoreForm()
      feedback.textContent = current.enabled ? '已保存，将按新的间隔提醒。' : '已暂停提醒。'
    })
  }, { signal: api.signal })
  buttons[1]!.addEventListener('click', () => void run(async () => {
    const shown = await api.commands.execute(`${command}.notify`)
    feedback.textContent = shown ? '测试通知已发送。' : '系统通知未开启，请在 Lexora 和系统设置中检查通知权限。'
  }), { signal: api.signal })
  let timer: ReturnType<typeof setInterval> | undefined
  function refresh() {
    if (busy || !api.visible || api.signal.aborted)
      return
    void api.commands.execute(`${command}.get`).then((value) => {
      if (busy || !api.visible || api.signal.aborted)
        return
      current = settings(value)
      updateNext()
    }).catch(() => {})
  }
  function setVisible(visible: boolean) {
    clearInterval(timer)
    if (!visible || api.signal.aborted)
      return
    refresh()
    timer = setInterval(refresh, 15000)
  }
  const visibility = api.onVisibilityChange(setVisible)
  const environment = api.onEnvironmentChange(updateNext)
  api.signal.addEventListener('abort', () => {
    clearInterval(timer)
    visibility.dispose()
    environment.dispose()
  }, { once: true })
  restoreForm()
  setVisible(api.visible)
}
