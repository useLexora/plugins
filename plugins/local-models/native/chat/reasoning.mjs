export function createReasoningStream({ emit, enabled, tagged, recoverUnopenedThinking = false }) {
  let mode = tagged ? 'prefix' : 'text', pending = '', source
  const send = (type, text) => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      if (!emit({ type, text: text.slice(start, end) })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
      start = end
    }
  }
  const thinking = (text, channel) => {
    if (!text) return
    source ??= channel
    if (enabled && source === channel) send('thinking', text)
  }
  function content(text, final = false) {
    if (!text && !final) return
    if (mode === 'text') { send('text', text); return }
    pending += text
    if (Buffer.byteLength(pending, 'utf8') > 16 * 1024 * 1024) throw Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
    if (mode === 'prefix') {
      const trimmed = pending.trimStart()
      if (trimmed.startsWith('<think>')) {
        pending = trimmed.slice(7)
        mode = 'thinking'
      } else if (pending.length <= 256 && '<think>'.startsWith(trimmed)) return
      else if (recoverUnopenedThinking && source !== 'structured') mode = 'unopened'
      else { mode = 'text'; send('text', pending); pending = ''; return }
    }
    const closing = '</think>'
    let end = pending.indexOf(closing)
    if (mode === 'unopened' && end >= 0) {
      end = -1
      const markers = /`+|<\/?think>/g
      let match
      while ((match = markers.exec(pending))) {
        if (match[0].startsWith('`')) {
          const width = match[0].length, quotes = /`+/g
          quotes.lastIndex = markers.lastIndex
          let quote
          while ((quote = quotes.exec(pending))) {
            if (width >= 3 ? quote[0].length >= width : quote[0].length === width) break
          }
          if (quote) markers.lastIndex = quotes.lastIndex
          else if (!final) return
        } else {
          if (match[0] === '<think>') { mode = 'text'; send('text', pending); pending = ''; return }
          end = match.index
          break
        }
      }
    }
    if (end >= 0) {
      thinking(pending.slice(0, end), 'tagged')
      const rest = pending.slice(end + closing.length)
      pending = ''
      mode = 'text'
      send('text', rest)
      return
    }
    if (mode === 'unopened') return
    let kept = Math.min(closing.length - 1, pending.length)
    while (kept && !closing.startsWith(pending.slice(-kept))) kept--
    thinking(pending.slice(0, pending.length - kept), 'tagged')
    pending = kept ? pending.slice(-kept) : ''
  }
  return {
    push(delta) {
      if (typeof delta?.reasoning_content === 'string') {
        thinking(delta.reasoning_content, 'structured')
        if (source === 'structured' && mode === 'unopened') { mode = 'text'; send('text', pending); pending = '' }
      }
      if (typeof delta?.content === 'string') content(delta.content)
    },
    finish() {
      if (mode === 'unopened') content('', true)
      if (mode === 'thinking') thinking(pending, 'tagged')
      else send('text', pending)
      pending = ''
    },
  }
}
