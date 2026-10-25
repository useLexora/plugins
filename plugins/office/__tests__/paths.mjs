import { existsSync } from 'node:fs'
import path from 'node:path'

export const project = path.resolve(import.meta.dirname, '..')
export const pluginRepository = path.resolve(project, '../..')
export const repository = path.resolve(process.env.LEXORA_REPOSITORY ?? path.join(pluginRepository, '..', 'Lexora'))

if (!existsSync(path.join(repository, 'apps/buddy/package.json')))
  throw new Error('Set LEXORA_REPOSITORY to a Lexora checkout with dependencies installed; the default is a sibling Lexora directory.')

export function pluginPackage(version) {
  return path.resolve(process.env.OFFICE_PLUGIN_PACKAGE ?? path.join(pluginRepository, 'dist', `office-${version}.lexora-extension`))
}
