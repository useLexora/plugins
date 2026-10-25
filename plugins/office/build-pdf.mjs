import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { genofficeResolver } from './build-genoffice.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
export async function buildPdf(outdir = path.join(root, 'dist')) {
  const shim = path.join(root, 'src/pdf-browser-runtime.ts')
  const pdfResolver = {
    name: 'pdf-browser',
    setup(api) {
      api.onResolve({ filter: /^\.\/(?:font-locate|wasm-path|atomic-write)$/ }, args => args.importer.includes('/apps/pdf/src/main/') ? { path: shim } : undefined)
      api.onResolve({ filter: /^electron$/ }, () => ({ path: shim }))
      api.onResolve({ filter: /^pdfjs-dist\/.*\?url$/ }, () => ({ path: 'pdf-worker', namespace: 'pdf-worker-url' }))
      api.onLoad({ filter: /.*/, namespace: 'pdf-worker-url' }, () => ({ contents: 'export default new URL("./pdf-worker.js", import.meta.url).href', loader: 'js' }))
      api.onLoad({ filter: /apps\/pdf\/src\/renderer\/view-config\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace("new URL('pdfjs/', document.baseURI)", "new URL('./pdfjs/', import.meta.url)"), loader: 'ts' }))
    },
  }
  await build({
    absWorkingDir: root, entryPoints: ['src/pdf-editor.ts'], outfile: path.join(outdir, 'pdf-editor.js'),
    bundle: true, platform: 'browser', target: 'chrome130', format: 'esm', minify: true, jsx: 'automatic',
    legalComments: 'eof', logLevel: 'info', inject: ['src/shims/buffer.ts', 'src/shims/storage.ts'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    plugins: [pdfResolver, genofficeResolver()],
    alias: { 'node:fs': shim, 'node:fs/promises': shim, 'node:crypto': path.join(root, 'src/shims/crypto.ts') },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  })
  fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), path.join(outdir, 'pdf-worker.js'))
  for (const name of ['cmaps', 'standard_fonts', 'wasm']) fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', name), path.join(outdir, 'pdfjs', name), { recursive: true })
  const runtime = path.join(outdir, 'pdf-runtime')
  fs.mkdirSync(runtime, { recursive: true })
  fs.copyFileSync(path.join(root, 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'), path.join(runtime, 'pdfium.wasm'))
  fs.copyFileSync(path.join(root, 'node_modules/harfbuzzjs/hb-subset.wasm'), path.join(runtime, 'hb-subset.wasm'))
  fs.copyFileSync(path.join(root, 'src/pdf-assets/NotoSansCJKsc-Regular-subset.otf'), path.join(runtime, 'NotoSansCJKsc-Regular-subset.otf'))
  fs.copyFileSync(path.join(root, 'vendor/genoffice/apps/docs/src/renderer/fonts/LICENSE-OFL.txt'), path.join(runtime, 'LICENSE-OFL.txt'))
  fs.copyFileSync(path.join(root, 'node_modules/@embedpdf/pdfium/LICENSE.pdfium'), path.join(runtime, 'LICENSE.pdfium'))
  for (const family of ['Sans', 'Serif', 'Mono']) for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) {
    const name = `Liberation${family}-${style}.ttf`
    fs.copyFileSync(path.join(root, 'vendor/genoffice/apps/docs/src/renderer/fonts', name), path.join(runtime, name))
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPdf()
