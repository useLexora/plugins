import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = import.meta.dirname
const repository = path.resolve(root, '../..')
const host = process.env.LEXORA_REPOSITORY ? path.resolve(process.env.LEXORA_REPOSITORY) : path.resolve(repository, '../Lexora')
const tools = path.join(host, 'apps/buddy/extensions/tools.mjs')
const sdk = path.join(root, 'artifacts/sdk')
const compiled = path.join(root, 'dist')
const [command = 'pack', ...extra] = process.argv.slice(2)
assert(['check', 'pack', 'dev'].includes(command) && !extra.length, 'Usage: node package.mjs [check|pack|dev]')
await fs.access(tools).catch(() => { throw new Error(`Lexora source tools not found at ${tools}. Set LEXORA_REPOSITORY to the matching host checkout.`) })
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'))
assert.equal(metadata.version, manifest.version, 'package.json and extension.json versions must match')

function run(...args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(tools, 'export-sdk', sdk)
const { readPlugin, packPlugin } = await import(pathToFileURL(path.join(sdk, 'plugin.mjs')).href)
if (command !== 'check') run(path.join(root, 'build.mjs'))
let input = compiled
if (command === 'dev') {
  const hostVersion = JSON.parse(await fs.readFile(path.join(host, 'apps/buddy/buddy.version.json'), 'utf8')).version
  const development = path.join(root, 'artifacts/dev')
  await fs.rm(development, { recursive: true, force: true })
  await fs.cp(compiled, development, { recursive: true })
  const developmentManifest = JSON.parse(await fs.readFile(path.join(development, 'extension.json'), 'utf8'))
  developmentManifest.engines.lexora = hostVersion
  await fs.writeFile(path.join(development, 'extension.json'), `${JSON.stringify(developmentManifest, null, 2)}\n`)
  input = development
}
const checked = await readPlugin(input)
assert.equal(checked.manifest.version, manifest.version, 'Built manifest is stale; run npm run build')
console.log(`${checked.manifest.id}@${checked.manifest.version}: package valid; requires Lexora ${checked.manifest.engines.lexora}, API ${checked.manifest.apiVersion}`)
if (command === 'dev') console.log(`Local development only: load this directory using Lexora's development-directory action: ${input}`)
if (command === 'pack') {
  const output = path.join(repository, 'dist', `office-${manifest.version}.lexora-extension`)
  const packed = await packPlugin(compiled, output)
  console.log(`${output} (${packed.size} bytes, SHA-256 ${packed.sha256})`)
}
