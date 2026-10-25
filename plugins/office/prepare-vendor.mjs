import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const hash = value => createHash('sha256').update(value).digest('hex')

async function treeHash(directory) {
  const digest = createHash('sha256')
  async function visit(relative) {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      if (!relative && name === '.source.json') continue
      const child = path.posix.join(relative, name)
      const file = path.join(directory, child)
      const stat = await fs.lstat(file)
      if (stat.isDirectory()) await visit(child)
      else if (stat.isFile()) digest.update(child).update('\0').update(hash(await fs.readFile(file))).update('\0')
      else throw new Error(`Unsupported source entry: ${child}`)
    }
  }
  await visit('')
  return digest.digest('hex')
}

export async function prepareVendor({ root = import.meta.dirname, archivePath = process.env.OFFICE_SOURCE_ARCHIVE } = {}) {
  const source = path.join(root, 'upstream')
  const lockBytes = await fs.readFile(path.join(source, 'genoffice.json'))
  const lock = JSON.parse(lockBytes)
  const patches = await Promise.all(lock.patches.map(name => fs.readFile(path.join(source, name))))
  const fingerprint = hash(Buffer.concat([lockBytes, ...patches]))
  const vendor = path.join(root, 'vendor')
  const target = path.join(vendor, 'genoffice')
  let previous
  try {
    previous = JSON.parse(await fs.readFile(path.join(target, '.source.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (await fs.stat(target).catch(() => null)) throw new Error('Unmanaged vendor/genoffice exists; preserve local changes before preparing sources.')
  }
  if (previous) {
    if (await treeHash(target) !== previous.tree) throw new Error('vendor/genoffice has local changes; preserve them in upstream patches before rebuilding the source cache.')
    if (previous.fingerprint === fingerprint) return target
  }
  await fs.mkdir(vendor, { recursive: true })
  const guard = path.join(vendor, '.prepare-lock')
  await fs.mkdir(guard).catch(error => {
    if (error.code !== 'EEXIST') throw error
    throw new Error('Source preparation is already running; remove vendor/.prepare-lock only if that process has stopped.', { cause: error })
  })
  const staging = await fs.mkdtemp(path.join(vendor, '.genoffice-'))
  const extracted = path.join(staging, 'source')
  const backup = path.join(staging, 'previous')
  try {
    const archiveCache = path.join(root, 'artifacts/upstream', `${lock.sha256}.zip`)
    let bytes
    if (archivePath) bytes = await fs.readFile(archivePath)
    else {
      bytes = await fs.readFile(archiveCache).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (!bytes) {
        console.log(`Downloading GenOffice source ${lock.revision}`)
        const response = await fetch(lock.archive, { signal: AbortSignal.timeout(120000) })
        if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}`)
        bytes = Buffer.from(await response.arrayBuffer())
      }
    }
    if (hash(bytes) !== lock.sha256) throw new Error('GenOffice source archive SHA-256 mismatch')
    await fs.mkdir(path.dirname(archiveCache), { recursive: true })
    await fs.writeFile(archiveCache, bytes)
    const zip = await JSZip.loadAsync(bytes)
    const prefix = `genoffice-${lock.revision}/`
    let count = 0
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.startsWith(prefix)) continue
      const relative = entry.name.slice(prefix.length)
      if (!lock.include.some(item => item.endsWith('/') ? relative.startsWith(item) : relative === item)) continue
      if (lock.exclude.some(pattern => path.matchesGlob(relative, pattern))) continue
      if (entry.unsafeOriginalName !== entry.name || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error(`Unsafe source path: ${entry.name}`)
      if (entry.unixPermissions && (entry.unixPermissions & 0o170000) !== 0o100000) throw new Error(`Unsupported source entry: ${entry.name}`)
      const file = path.join(extracted, relative)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, await entry.async('nodebuffer'))
      count++
    }
    if (!count) throw new Error('No selected GenOffice source files found in archive')
    for (const patch of patches) execFileSync('git', ['apply', '--no-index', '--whitespace=nowarn', '-'], { cwd: extracted, input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
    await fs.writeFile(path.join(extracted, 'REVISION'), `${lock.revision}\n`)
    await fs.writeFile(path.join(extracted, '.source.json'), `${JSON.stringify({ fingerprint, tree: await treeHash(extracted) })}\n`)
    if (previous) await fs.rename(target, backup)
    try { await fs.rename(extracted, target) }
    catch (error) {
      if (previous) await fs.rename(backup, target)
      throw error
    }
    console.log(`Prepared GenOffice ${lock.revision}: ${count} upstream files and ${patches.length} patch(es)`)
    return target
  } finally {
    if (!(await fs.stat(backup).catch(() => null)) || await fs.stat(target).catch(() => null)) await fs.rm(staging, { recursive: true, force: true })
    await fs.rm(guard, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareVendor()
