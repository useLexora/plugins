export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
export function button(text: string, action: () => void, className = '') {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
export function sizeLabel(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`
}
export function dateLabel(time: number) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time) }
export function dialog(root: HTMLElement, title: string, description: string, options: { confirm?: string; value?: string; danger?: boolean } = {}): Promise<string | boolean | null> {
  return new Promise(resolve => {
    const overlay = element('dialog', 'office-dialog')
    const heading = element('h2', '', title)
    heading.id = `office-dialog-${crypto.randomUUID()}`
    overlay.setAttribute('aria-labelledby', heading.id)
    overlay.append(heading, element('p', '', description))
    let input: HTMLInputElement | undefined
    if (options.value !== undefined) {
      const label = element('label', '', '名称')
      input = element('input'); input.value = options.value; input.maxLength = 105; input.required = true
      label.append(input); overlay.append(label)
    }
    const finish = (value: string | boolean | null) => { overlay.close(); overlay.remove(); resolve(value) }
    const actions = element('div', 'office-dialog-actions')
    actions.append(button('取消', () => finish(null)), button(options.confirm ?? '确定', () => { if (input && !input.value.trim()) { input.focus(); return }; finish(input ? input.value : true) }, options.danger ? 'danger' : 'primary'))
    overlay.append(actions)
    overlay.addEventListener('cancel', event => { event.preventDefault(); finish(null) })
    input?.addEventListener('keydown', event => { if (event.key === 'Enter' && input!.value.trim()) finish(input!.value) })
    root.append(overlay); overlay.showModal(); input?.select()
  })
}

export function confirmLeaving(root: HTMLElement, error: string, signal?: AbortSignal): Promise<'cancel' | 'discard' | 'export'> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve('cancel'); return }
    const panel = element('dialog', 'office-dialog')
    const heading = element('h2', '', '修改尚未保存')
    heading.id = `office-leave-${crypto.randomUUID()}`
    panel.setAttribute('aria-labelledby', heading.id)
    panel.append(heading, element('p', '', `${error} 已保存的版本会保留。你可以继续编辑、导出当前内容，或放弃本次修改。`))
    const finish = (choice: 'cancel' | 'discard' | 'export') => { signal?.removeEventListener('abort', cancelled); panel.close(); panel.remove(); resolve(choice) }
    const cancelled = () => finish('cancel')
    const actions = element('div', 'office-dialog-actions')
    actions.append(button('继续编辑', cancelled), button('放弃修改', () => finish('discard'), 'danger-text'), button('导出后离开', () => finish('export'), 'primary'))
    panel.append(actions)
    panel.addEventListener('cancel', event => { event.preventDefault(); cancelled() })
    signal?.addEventListener('abort', cancelled, { once: true })
    root.append(panel); panel.showModal()
  })
}
