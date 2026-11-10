export function createReasoningStream({ emit, enabled, tagged }) {
  let mode = tagged ? 'prefix' : 'text', pending = '', source
  const send = (type, text) => {
    if (text && !emit({ type, text })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
  }
  const thinking = (text, channel) => {
    if (!text) return
    source ??= channel
    if (enabled && source === channel) send('thinking', text)
  }
  function content(text) {
    if (!text) return
    if (mode === 'text') { send('text', text); return }
    pending += text
    if (mode === 'prefix') {
      const trimmed = pending.trimStart()
      if (trimmed.startsWith('<think>')) {
        pending = trimmed.slice(7)
        mode = 'thinking'
      } else if (pending.length <= 256 && '<think>'.startsWith(trimmed)) return
      else { mode = 'text'; send('text', pending); pending = ''; return }
    }
    const closing = '</think>'
    const end = pending.indexOf(closing)
    if (end >= 0) {
      thinking(pending.slice(0, end), 'tagged')
      const rest = pending.slice(end + closing.length)
      pending = ''
      mode = 'text'
      send('text', rest)
      return
    }
    let kept = Math.min(closing.length - 1, pending.length)
    while (kept && !closing.startsWith(pending.slice(-kept))) kept--
    thinking(pending.slice(0, pending.length - kept), 'tagged')
    pending = kept ? pending.slice(-kept) : ''
  }
  return {
    push(delta) {
      if (typeof delta?.reasoning_content === 'string') thinking(delta.reasoning_content, 'structured')
      if (typeof delta?.content === 'string') content(delta.content)
    },
    finish() {
      if (mode === 'thinking') thinking(pending, 'tagged')
      else send('text', pending)
      pending = ''
    },
  }
}
