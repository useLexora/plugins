import fs from 'node:fs/promises'
import path from 'node:path'
const root = import.meta.dirname
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
const seen = new Set()
const notices = ['Third-party notices for Lexora Office\n\nGenOffice (Mainfunc, Inc.), Apache-2.0.\nRevision: 8ab58a51433577a1317af4206137cee425b86606\n']
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!location.startsWith('node_modules/') || entry.dev) continue
  const folder = path.join(root, location)
  let pkg
  try { pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) } catch { continue }
  const key = `${pkg.name}@${pkg.version}`
  if (seen.has(key)) continue
  seen.add(key)
  const files = (await fs.readdir(folder)).filter(name => /^(license|licence|copying|notice)(?:\.|$|-)/i.test(name))
  let content = ''
  for (const name of files) {
    const file = path.join(folder, name)
    if ((await fs.stat(file)).isFile()) content += `\n${name}\n${await fs.readFile(file, 'utf8')}\n`
  }
  notices.push(`\n${'='.repeat(72)}\n${key}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'See upstream source')}\n${content}`)
}
for (const relative of ['vendor/genoffice/LICENSE', 'vendor/genoffice/NOTICE', 'vendor/genoffice/LICENSE-UNICODE.txt', 'vendor/genoffice/packages/pptx-engine/src/vendor/mtx/LICENSE', 'vendor/genoffice/packages/pptx-engine/src/vendor/mtx/README.md', 'vendor/genoffice/packages/docx-engine/src/vendor/emf-converter/LICENSE', 'vendor/genoffice/packages/docx-engine/src/vendor/emf-converter/README.md', 'vendor/genoffice/apps/docs/src/renderer/fonts/LICENSE-OFL.txt', 'vendor/genoffice/apps/docs/src/renderer/fonts/README.md']) notices.push(`\n${'='.repeat(72)}\n${relative}\n${await fs.readFile(path.join(root, relative), 'utf8')}`)
await fs.mkdir(path.join(root, 'dist'), { recursive: true })
await fs.writeFile(path.join(root, 'dist/THIRD-PARTY-NOTICES.txt'), notices.join('\n'))
console.log(`Third-party notices: ${seen.size} packages and GenOffice font licenses`)
