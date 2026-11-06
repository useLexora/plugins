import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const root = import.meta.dirname
const host = process.env.LEXORA_REPOSITORY ?? path.resolve(root, '../../../Lexora')
execFileSync(process.execPath, [path.join(root, 'build.mjs')], { stdio: 'inherit' })
for (const config of ['tsconfig.json', 'tsconfig.native.json']) execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', config], { cwd: root, stdio: 'inherit' })
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'))
const output = path.resolve(root, '../../dist', `local-models-${manifest.version}.lexora-extension`)
execFileSync(process.execPath, [path.join(host, 'apps/buddy/extensions/tools.mjs'), 'pack', path.resolve(root, '../../dist/local-models'), output], { stdio: 'inherit' })
