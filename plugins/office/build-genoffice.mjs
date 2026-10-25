import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
export function genofficeResolver() {
  return {
    name: 'genoffice-packages',
    setup(api) {
      api.onResolve({ filter: /^@genoffice\// }, args => {
        const [name, ...rest] = args.path.slice('@genoffice/'.length).split('/')
        const base = path.join(root, 'vendor/genoffice/packages', name)
        const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
        const key = rest.length ? `./${rest.join('/')}` : '.'
        let target = manifest.exports[key]
        if (!target) {
          for (const [pattern, destination] of Object.entries(manifest.exports)) {
            const prefix = pattern.split('*')[0]
            if (pattern.includes('*') && key.startsWith(prefix)) target = destination.replace('*', key.slice(prefix.length))
          }
        }
        if (!target || typeof target !== 'string') throw new Error(`No GenOffice export ${args.path}`)
        return { path: path.join(base, target) }
      })
      api.onResolve({ filter: /\?bytes$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -6)), namespace: 'genoffice-bytes' }))
      api.onLoad({ filter: /.*/, namespace: 'genoffice-bytes' }, args => ({ contents: fs.readFileSync(args.path), loader: 'binary' }))
      api.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'genoffice-raw' }))
      api.onLoad({ filter: /.*/, namespace: 'genoffice-raw' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }))
    },
  }
}
export async function buildGenoffice(outdir = path.join(root, 'dist')) {
  const shared = {
    bundle: true, platform: 'browser', target: 'chrome130', format: 'esm', minify: true, jsx: 'automatic',
    absWorkingDir: root, legalComments: 'eof', logLevel: 'info',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'process.env': '{}', 'process.platform': '"browser"' },
    plugins: [genofficeResolver()],
    alias: {
      'node:crypto': path.join(root, 'src/shims/crypto.ts'),
      'node:fs/promises': path.join(root, 'src/shims/docx-fs.ts'),
      'node:fs': path.join(root, 'src/shims/docx-fs.ts'),
      'node:stream/promises': path.join(root, 'src/shims/docx-fs.ts'),
      'node:zlib': path.join(root, 'src/shims/docx-zlib.ts'),
      'node:path': path.join(root, 'src/shims/path.ts'),
    },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  }
  await import('./build-slides-kernel.mjs')
  await build({ ...shared, entryPoints: ['src/slides-editor.ts'], outfile: path.join(outdir, 'slides-editor.js'), inject: ['src/shims/buffer.ts', 'src/shims/storage.ts'] })
  await build({ ...shared, entryPoints: ['src/slides-worker.ts'], outfile: path.join(outdir, 'slides-worker.js'), inject: ['src/shims/buffer.ts'], alias: { ...shared.alias, 'node:path': path.join(root, 'src/shims/slides-path.ts') } })
  await build({ ...shared, entryPoints: ['src/docx-editor.ts'], outfile: path.join(outdir, 'docx-editor.js'), inject: ['src/shims/buffer.ts', 'src/shims/storage.ts'] })
  await build({ ...shared, entryPoints: ['vendor/genoffice/apps/docs/src/renderer/parse-worker.ts'], outfile: path.join(outdir, 'docx-worker.js'), inject: ['src/shims/buffer.ts'] })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildGenoffice()
