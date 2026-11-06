import { dirname, join, relative, resolve, sep } from 'node:path'

export function resourceFile(input, mount, role) {
  return input.resourceFiles?.[mount]?.[role] ?? join(input.resources[mount], role)
}

export function resourceDirectory(input, mount, role = '') {
  const files = Object.entries(input.resourceFiles?.[mount] ?? {}).filter(([path]) => !role || path.startsWith(`${role}/`))
  if (!files.length) return join(input.resources[mount], role)
  let directory
  for (const [path, absolute] of files) {
    const suffix = role ? path.slice(role.length + 1) : path
    let root = absolute
    for (const _ of suffix.split('/')) root = dirname(root)
    const candidate = resolve(root)
    if (relative(candidate, absolute).split(sep).join('/') !== suffix || directory && directory !== candidate) throw Error('EXTENSION_INFERENCE_RESOURCE_LAYOUT_INVALID')
    directory = candidate
  }
  return directory
}

export function engineEnvironment(directory, platform = process.platform) {
  if (platform !== 'win32') return { ...process.env }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  return { ...env, PATH: directory + (path ? `;${path}` : '') }
}
