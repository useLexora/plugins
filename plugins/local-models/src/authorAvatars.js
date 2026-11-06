const maxBytes = 2 * 1024 * 1024
const ownerPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/

export function createAuthorAvatars(context) {
  const entries = new Map()
  const queue = []
  let active = 0
  let disposed = context.signal.aborted

  async function load(owner, entry) {
    let resource
    try {
      const signal = AbortSignal.any([context.signal, entry.controller.signal, AbortSignal.timeout(15000)])
      signal.throwIfAborted()
      resource = await context.network.download(`https://huggingface.co/api/avatars/${encodeURIComponent(owner)}`, { name: `${owner}.webp`, signal })
      if (!Number.isSafeInteger(resource.size) || resource.size <= 0 || resource.size > maxBytes) return ''
      const chunks = []
      let offset = 0
      for (;;) {
        signal.throwIfAborted()
        const chunk = await context.resources.readBytes(resource, { offset, length: 64 * 1024 })
        offset += chunk.data.length
        if (offset > resource.size || (!chunk.eof && !chunk.data.length)) return ''
        chunks.push(chunk.data)
        if (chunk.eof) break
      }
      signal.throwIfAborted()
      if (offset !== resource.size || !entry.users || disposed) return ''
      entry.url = URL.createObjectURL(new Blob(chunks, { type: resource.mimeType }))
      return entry.url
    } catch {
      return ''
    } finally {
      if (resource) await context.resources.release(resource).catch(() => {})
    }
  }

  function drain() {
    while (active < 4 && queue.length) {
      const { owner, entry, resolve } = queue.shift()
      if (entry.controller.signal.aborted || disposed) { resolve(''); continue }
      active++
      void load(owner, entry).then(resolve).finally(() => { active--; drain() })
    }
  }

  function acquire(owner) {
    if (disposed || !ownerPattern.test(owner)) return { value: Promise.resolve(''), release() {} }
    const key = owner.toLowerCase()
    let entry = entries.get(key)
    if (!entry) {
      entry = { users: 0, controller: new AbortController(), url: '', value: null }
      entry.value = new Promise(resolve => queue.push({ owner, entry, resolve }))
      entries.set(key, entry)
    }
    entry.users++
    drain()
    let released = false
    return {
      value: entry.value,
      release() {
        if (released) return
        released = true
        if (--entry.users) return
        entry.controller.abort()
        if (entry.url) URL.revokeObjectURL(entry.url)
        entries.delete(key)
      },
    }
  }

  function dispose() {
    disposed = true
    context.signal.removeEventListener('abort', dispose)
    for (const entry of entries.values()) {
      entry.controller.abort()
      if (entry.url) URL.revokeObjectURL(entry.url)
    }
    entries.clear()
    drain()
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  return { acquire, dispose }
}
