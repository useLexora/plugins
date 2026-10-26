import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildGenoffice, genofficeResolver } from './build-genoffice.mjs'
import { buildPdf } from './build-pdf.mjs'
import { univerClipboardPatch } from './build-univer-clipboard.mjs'
import { univerContextMenuPatch } from './build-univer-contextmenu.mjs'
import { prepareVendor } from './prepare-vendor.mjs'

const root = import.meta.dirname
const out = path.join(root, 'dist')
await prepareVendor()
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })
const shared = {
  absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', minify: true,
  legalComments: 'eof', logLevel: 'info', jsx: 'automatic', plugins: [genofficeResolver()],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  inject: ['src/shims/buffer.ts'],
  alias: {
    'node:crypto': path.join(root, 'src/shims/crypto.ts'),
    'node:fs/promises': path.join(root, 'src/shims/fs.ts'),
    'node:fs': path.join(root, 'src/shims/fs.ts'),
    'node:path': path.join(root, 'src/shims/path.ts'),
  },
}
const separateEditors = { name: 'separate-editors', setup(api) {
  api.onResolve({ filter: /^\.\/(docx|sheets|slides|pdf)-editor$/ }, args => ({ path: `${args.path}.js`, external: true }))
} }
await build({ ...shared, entryPoints: ['src/view.ts'], outfile: 'dist/view.js', plugins: [separateEditors, genofficeResolver()], metafile: true }).then(async result => {
  if (Object.keys(result.metafile.inputs).some(input => input.includes('node_modules/@univerjs/'))) throw new Error('Office management must load Sheets separately')
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true }); await fs.writeFile(path.join(root, 'artifacts/view-metafile.json'), JSON.stringify(result.metafile))
})
await build({ ...shared, entryPoints: ['src/sheets-editor.ts'], outfile: 'dist/sheets-editor.js', plugins: [genofficeResolver(), univerClipboardPatch(), univerContextMenuPatch()], metafile: true }).then(async result => {
  await fs.writeFile(path.join(root, 'artifacts/sheets-metafile.json'), JSON.stringify(result.metafile))
})
await build({ ...shared, entryPoints: ['src/library-page.ts'], outfile: 'dist/library-page.js', plugins: [{ name: 'office-page', setup(api) { api.onResolve({ filter: /^\.\/view$/ }, () => ({ path: './view.js', external: true })) } }] })
await build({ ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' })
await build({ ...shared, entryPoints: ['src/worker.ts'], outfile: 'dist/engine-worker.js' })
await buildGenoffice(out)
await buildPdf(out)
await import('./generate-notices.mjs')
await fs.copyFile(path.join(root, 'fixtures/empty.xlsx'), path.join(out, 'blank.xlsx'))
for (const file of ['extension.json', 'icon.svg', 'LICENSE', 'NOTICE']) await fs.copyFile(path.join(root, file), path.join(out, file))
await fs.rm(path.join(out, 'skills'), { recursive: true, force: true })
await fs.cp(path.join(root, 'skills'), path.join(out, 'skills'), { recursive: true })
