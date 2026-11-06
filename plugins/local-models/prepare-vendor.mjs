import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root = import.meta.dirname
export async function prepareVendor() {
  await fs.mkdir(path.join(root, 'vendor'), { recursive: true })
  const lock = JSON.parse(await fs.readFile(path.join(root, 'upstream/lemonade.json'), 'utf8'))
  const target = path.join(root, 'vendor/lemonade')
  const patch = await fs.readFile(path.join(root, 'upstream/lemonade.patch'))
  const fingerprint = createHash('sha256').update(JSON.stringify(lock)).update(patch).digest('hex')
  const marker = path.join(target, '.source.json')
  const hash = data => createHash('sha256').update(data).digest('hex')
  try {
    const previous = JSON.parse(await fs.readFile(marker, 'utf8'))
    for (const [file, digest] of Object.entries(previous.files)) {
      if (hash(await fs.readFile(path.join(target, file))) !== digest) throw new Error(`Modified vendor file: ${file}; preserve changes in upstream/lemonade.patch`)
    }
    if (previous.fingerprint === fingerprint) return target
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const staging = await fs.mkdtemp(path.join(root, 'vendor/.lemonade-'))
  try {
    for (const [file, digest] of Object.entries(lock.files)) {
      let content
      try { const cached = await fs.readFile(path.join(target, file)); if (hash(cached) === digest) content = cached } catch {}
      if (!content) {
        const response = await fetch(`https://raw.githubusercontent.com/${lock.repository}/${lock.revision}/${file}`)
        if (!response.ok) throw new Error(`Upstream download failed: ${file} (${response.status})`)
        content = Buffer.from(await response.arrayBuffer())
      }
      if (hash(content) !== digest) throw new Error(`Upstream checksum mismatch: ${file}`)
      await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true })
      await fs.writeFile(path.join(staging, file), content)
    }
    execFileSync('git', ['apply', path.join(root, 'upstream/lemonade.patch')], { cwd: staging })
    const files = {}
    for (const file of Object.keys(lock.files)) files[file] = hash(await fs.readFile(path.join(staging, file)))
    await fs.writeFile(path.join(staging, '.source.json'), JSON.stringify({ fingerprint, files }))
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
  return target
}

if (process.argv[1] === new URL(import.meta.url).pathname) await prepareVendor()
