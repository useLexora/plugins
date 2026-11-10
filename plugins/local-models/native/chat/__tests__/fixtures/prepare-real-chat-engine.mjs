import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractArchive } from '../../../../src/preparation/prepare.mjs'

const digest = async path => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function prepareRealChatEngine({ resourceId, cache, output }) {
  const resources = JSON.parse(await readFile(new URL('../../../../resources.json', import.meta.url), 'utf8'))
  const resource = resources.find(item => item.id === resourceId)
  assert.ok(resource?.archives?.length && resource.files?.length, 'A complete archive resource is required')
  const directory = resolve(output)
  await mkdir(directory, { recursive: false })
  const destination = path => {
    const target = resolve(directory, path)
    assert.ok(target.startsWith(directory + sep), 'Resource paths must stay within the acceptance directory')
    return target
  }
  const found = new Set(), events = [], verifiedArchives = []
  let active, handle, bytes
  try {
    for (const archive of resource.archives) {
      assert.equal(basename(archive.name), archive.name)
      const path = join(cache, archive.name)
      assert.equal((await stat(path)).size, archive.size)
      assert.equal(await digest(path), archive.sha256)
      verifiedArchives.push({ name: archive.name, sha256: archive.sha256, size: archive.size })
      await extractArchive(path, archive, resource.files, {
        signal: new AbortController().signal,
        async emitAsync(event, chunk) {
          if (event.type !== 'chunk') events.push(event)
          if (event.type === 'file') {
            assert.equal(handle, undefined)
            assert.ok(!found.has(event.path))
            active = event
            bytes = 0
            await mkdir(dirname(destination(event.path)), { recursive: true })
            handle = await open(destination(event.path), 'wx', 0o600)
          } else if (event.type === 'chunk') {
            assert.ok(handle)
            let offset = 0
            while (offset < chunk.length) {
              const written = await handle.write(chunk, offset, chunk.length - offset)
              assert.ok(written.bytesWritten > 0)
              offset += written.bytesWritten
            }
            bytes += chunk.length
          } else if (event.type === 'end') {
            assert.ok(handle)
            await handle.close()
            handle = undefined
            assert.equal(bytes, active.size)
            assert.equal(await digest(destination(active.path)), event.sha256)
            await chmod(destination(active.path), active.executable ? 0o755 : 0o644)
            found.add(active.path)
          } else if (event.type === 'alias') {
            assert.ok(found.has(event.target))
            assert.ok(!found.has(event.path))
            await mkdir(dirname(destination(event.path)), { recursive: true })
            await copyFile(destination(event.target), destination(event.path), 1)
            found.add(event.path)
          } else assert.fail(`Unsupported preparation event: ${event.type}`)
          return true
        },
      })
    }
    assert.deepEqual([...found].sort(), resource.files.map(file => file.path).sort())
    const files = []
    for (const file of resource.files) {
      const path = destination(file.path)
      const sha256 = await digest(path), info = await stat(path)
      assert.equal(sha256, file.sha256)
      assert.equal(Boolean(info.mode & 0o111), Boolean(file.executable))
      files.push({ path: file.path, sha256, size: info.size, mode: (info.mode & 0o777).toString(8) })
    }
    const report = { resourceId, directory, archives: verifiedArchives, files, events }
    await writeFile(join(directory, 'preparation-verification.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally { await handle?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [resourceId, cache, output] = process.argv.slice(2)
  assert.ok(resourceId && cache && output, 'Usage: prepare-real-chat-engine.mjs resourceId cache output')
  const report = await prepareRealChatEngine({ resourceId, cache, output })
  console.log(JSON.stringify({ resourceId, directory: report.directory, verifiedFiles: report.files.length, archives: report.archives.length, aliases: report.events.filter(event => event.type === 'alias').length }))
}
