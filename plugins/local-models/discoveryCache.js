export const discoveryCacheRulesVersion = 3
export const discoveryCacheTTL = 6 * 60 * 60 * 1000
export const discoveryCacheMaxEntries = 128
export const discoveryCacheMaxBytes = 32 * 1024

const repositoryPattern = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/
const keyOf = entry => entry.repository.toLowerCase()
const codes = new Set(['ready', 'inferred', 'checksum', 'metadata', 'access', 'adapter', 'task', 'components', 'format'])
const supportCode = code => codes.has(code) ? { code } : {}
const validTime = (time, now) => Number.isSafeInteger(time) && time <= now && now - time < discoveryCacheTTL

export function createAvailabilityCache({ cached = null, persist = undefined, extensionVersion = null } = {}) {
  const entries = new Map()
  let writing = Promise.resolve()
  function snapshot() {
    const now = Date.now()
    for (const [key, entry] of entries) if (!validTime(entry.checkedAt, now)) entries.delete(key)
    const result = () => ({ rulesVersion: discoveryCacheRulesVersion, extensionVersion, entries: [...entries.values()] })
    while (entries.size > discoveryCacheMaxEntries || (entries.size && new TextEncoder().encode(JSON.stringify(result())).length > discoveryCacheMaxBytes)) entries.delete(entries.keys().next().value)
    return result()
  }
  if (cached?.rulesVersion === discoveryCacheRulesVersion && cached.extensionVersion === extensionVersion && Array.isArray(cached.entries)) {
    const now = Date.now()
    for (const entry of cached.entries.slice(-discoveryCacheMaxEntries)) {
      if (!entry || typeof entry.repository !== 'string' || entry.repository.length > 256 || !repositoryPattern.test(entry.repository) || !/^[a-f0-9]{40}$/.test(entry.revision) || !['installable', 'unsupported'].includes(entry.state) || typeof entry.reason !== 'string' || !entry.reason || entry.reason.length > 240 || !validTime(entry.checkedAt, now)) continue
      const { repository, revision, state, reason, checkedAt } = entry
      entries.set(keyOf(entry), { repository, revision, state, reason, checkedAt, ...supportCode(entry.code) })
    }
    snapshot()
  }
  function get(repository, revision) {
    const entry = entries.get(repository.toLowerCase())
    if (!entry || entry.revision !== revision || !validTime(entry.checkedAt, Date.now())) return null
    return { state: entry.state, reason: entry.reason, ...supportCode(entry.code) }
  }
  async function put(results) {
    let changed = false
    for (const { repository, revision, availability } of results) {
      if (typeof repository !== 'string' || repository.length > 256 || !repositoryPattern.test(repository) || !/^[a-f0-9]{40}$/.test(revision) || !['installable', 'unsupported'].includes(availability.state)) continue
      const entry = { repository, revision, state: availability.state, reason: availability.reason.slice(0, 240), checkedAt: Date.now(), ...supportCode(availability.code) }
      entries.delete(keyOf(entry))
      entries.set(keyOf(entry), entry)
      changed = true
    }
    if (!changed) return
    const value = snapshot()
    if (typeof persist === 'function') {
      writing = writing.then(() => persist(value)).then(() => {}, () => {})
      await writing
    }
  }
  return { get, put }
}
