import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
const root = import.meta.dirname
const out = path.resolve(root, '../../dist/local-models')
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })
const viewBuild = await build({ metafile: true, absWorkingDir: root, entryPoints: ['src/view.jsx'], outfile: path.join(out, 'view.js'), loader: { '.svg': 'dataurl' }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', minify: true, jsx: 'automatic', legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' })
const entryBuild = await build({ metafile: true, absWorkingDir: root, entryPoints: ['entry.js'], outfile: path.join(out, 'entry.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', minify: true, legalComments: 'eof', logLevel: 'info' })
for (const file of [ 'catalog.json', 'resources.json', 'icon.svg', 'LICENSE', 'NOTICE']) await fs.copyFile(path.join(root, file), path.join(out, file))
await fs.cp(path.join(root, 'native'), path.join(out, 'native'), { recursive: true, filter: source => !source.split(path.sep).includes('__tests__') })
const preparationBuild = await build({ metafile: true, absWorkingDir: root, entryPoints: ['src/preparation/prepare.mjs'], outfile: path.join(out, 'native/prepare.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', minify: true, legalComments: 'eof', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, logLevel: 'info' })
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'))
manifest.format = 'compiled'
await fs.writeFile(path.join(out, 'extension.json'), JSON.stringify(manifest, null, 2) + '\n')
const libraries = new Set(Object.keys({ ...viewBuild.metafile.inputs, ...entryBuild.metafile.inputs, ...preparationBuild.metafile.inputs }).flatMap(file => {
  const parts = file.split('/')
  const index = parts.lastIndexOf('node_modules')
  return index < 0 ? [] : [parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/')]
}))
const missingPackageLicenses = { 'xz-decompress@0.2.3': 'upstream/licenses/xz-decompress.LICENSE', 'react-remove-scroll-bar@2.3.8': 'upstream/licenses/react-remove-scroll-bar.LICENSE' }
for (const library of [...libraries].sort()) {
  const directory = path.join(root, library)
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  const licenses = (await fs.readdir(directory)).filter(name => /^licen[sc]e(?:\..*)?$/i.test(name)).sort().map(name => path.join(directory, name))
  const fallback = missingPackageLicenses[`${metadata.name}@${metadata.version}`]
  if (!licenses.length && fallback) licenses.push(path.join(root, fallback))
  if (!licenses.length) throw new Error(`Missing bundled dependency license: ${metadata.name}`)
  await fs.appendFile(path.join(out, 'NOTICE'), `\n${metadata.name} ${metadata.version} (${metadata.license})\n`)
  for (const license of licenses) await fs.appendFile(path.join(out, 'NOTICE'), await fs.readFile(license, 'utf8') + '\n')
}
