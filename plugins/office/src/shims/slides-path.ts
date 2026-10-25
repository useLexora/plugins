const normalize = (value: string) => {
  const out: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${value.startsWith('/') ? '/' : ''}${out.join('/')}` || '.'
}
export const join = (...parts: string[]) => normalize(parts.join('/'))
export const resolve = (...parts: string[]) => join('/', ...parts)
export const basename = (value: string, suffix?: string) => {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? ''
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
}
export const dirname = (value: string) => value.replaceAll('\\', '/').split('/').slice(0, -1).join('/') || '.'
export const extname = (value: string) => { const name = basename(value); const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot) : '' }
