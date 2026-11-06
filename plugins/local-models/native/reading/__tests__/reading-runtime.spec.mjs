import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { initialize } from '../reading.mjs'

const image = Buffer.from('private original image fixture')
const request = { requestId: 'reading-fixture', operation: 'extract', image: { mimeType: 'image/png', data: image.toString('base64') } }

async function fixture(t, launch, controller = new AbortController()) {
  const directory = await mkdtemp(join(tmpdir(), 'reading-runtime-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const originalSpawn = childProcess.spawn
  let temporary
  const mock = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    temporary = dirname(args[0])
    assert.deepEqual(readFileSync(args[0]), image)
    return launch({ executable, args, options, originalSpawn })
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const runtime = await initialize({ resources: { engine: directory, model: directory }, configuration: { backend: 'ocr', threads: 1 } })
  const events = []
  const session = runtime.start('ocr', {}, { signal: controller.signal, emit: event => { events.push(event); return true } })
  session.write(Buffer.from(JSON.stringify(request)))
  return { session, events, temporary: () => temporary }
}

function processFixture() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
  child.kill = signal => {
    child.signalCode = signal
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }
  return child
}

async function assertRemoved(f) {
  assert.ok(f.temporary())
  await assert.rejects(access(f.temporary()), { code: 'ENOENT' })
}

function textProcess(text) {
  const child = processFixture()
  queueMicrotask(() => {
    const bytes = Buffer.from(text)
    for (let offset = 0; offset < bytes.length && !child.signalCode; offset += 4096) child.stdout.write(bytes.subarray(offset, offset + 4096))
    child.stdout.end(); child.stderr.end()
    if (!child.signalCode) { child.exitCode = 0; child.emit('close', 0, null) }
  })
  return child
}

async function visionFixture(t, text) {
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = processFixture()
    queueMicrotask(() => child.stdout.write('listening on http://127.0.0.1:12345\n'))
    return child
  })
  const request = t.mock.method(http, 'request', (options, callback) => {
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.end = () => {
      const body = options.path === '/health' ? '{}' : `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200 })))
      return req
    }
    return req
  })
  syncBuiltinESMExports()
  t.after(() => { spawn.mock.restore(); request.mock.restore(); syncBuiltinESMExports() })
  const runtime = await initialize({ resources: { engine: '/fixture/engine', model: '/fixture/model' }, configuration: { backend: 'vision', threads: 1 } })
  t.after(() => runtime.dispose())
  const events = []
  const session = runtime.start('vision', {}, { signal: new AbortController().signal, emit: event => { events.push(event); return true } })
  session.write(Buffer.from(JSON.stringify({ requestId: 'vision-fixture', operation: 'extract', image: { mimeType: 'image/png', data: image.toString('base64') } })))
  return { session, events }
}

test('OCR incrementally decodes Chinese and emoji split at every UTF-8 byte and cleans its image', async t => {
  const expected = '中文🙂与𠀀 mixed text'
  const f = await fixture(t, () => {
    const child = processFixture()
    queueMicrotask(() => {
      for (const byte of Buffer.from(`  ${expected}\n`)) child.stdout.write(Buffer.from([byte]))
      child.stdout.end(); child.stderr.end()
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    return child
  })
  await f.session.finish()
  assert.deepEqual(f.events, [{ type: 'text', sequence: 0, text: expected }, { type: 'done' }])
  await assertRemoved(f)
})

test('OCR preserves split UTF-8 from a real OS child and removes its input file', { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reading-os-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'tesseract'), receipt = join(directory, 'input-path')
  const expected = '真实子进程：中文🙂𠀀'
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const {setTimeout:wait}=require('node:timers/promises');fs.writeFileSync(${JSON.stringify(receipt)},process.argv[2]);(async()=>{for(const byte of Buffer.from(${JSON.stringify(expected)})){await new Promise(resolve=>process.stdout.write(Buffer.from([byte]),resolve));await wait(5)}})().catch(()=>{process.exitCode=1})\n`)
  await chmod(executable, 0o755)
  const runtime = await initialize({ resources: { engine: directory, model: directory }, configuration: { backend: 'ocr', threads: 1 } })
  const events = []
  const session = runtime.start('ocr', {}, { signal: new AbortController().signal, emit: event => { events.push(event); return true } })
  session.write(Buffer.from(JSON.stringify(request)))
  await session.finish()
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), expected)
  assert.deepEqual(events.at(-1), { type: 'done' })
  await assert.rejects(access(dirname(await readFile(receipt, 'utf8'))), { code: 'ENOENT' })
})

test('OCR async spawn error preserves ENOENT and removes the temporary directory containing the original image', async t => {
  const f = await fixture(t, ({ executable, args, options, originalSpawn }) => originalSpawn(executable, args, options))
  await assert.rejects(f.session.finish(), { code: 'ENOENT' })
  assert.deepEqual(f.events, [])
  // Also clean up on the pre-fix failure, so the regression test itself never leaks the fixture image.
  t.after(() => rm(f.temporary(), { recursive: true, force: true }))
  await assertRemoved(f)
})

test('OCR synchronous launch errors also preserve the error and remove the original image', async t => {
  const error = new Error('synchronous spawn fixture')
  const f = await fixture(t, () => { throw error })
  await assert.rejects(f.session.finish(), actual => actual === error)
  assert.deepEqual(f.events, [])
  await assertRemoved(f)
})

test('OCR cancellation reaps its child, cleans the original image and never emits done', async t => {
  const controller = new AbortController(), reason = new Error('cancel reading fixture')
  let child
  const f = await fixture(t, () => {
    child = processFixture()
    queueMicrotask(() => controller.abort(reason))
    return child
  }, controller)
  await assert.rejects(f.session.finish(), actual => actual === reason)
  assert.equal(child.signalCode, 'SIGKILL')
  assert.deepEqual(f.events, [])
  await assertRemoved(f)
})

const outputLimit = 128 * 1024

test('OCR rejects Chinese output one UTF-8 byte over the total limit before any text and cleans its image', async t => {
  const text = '中'.repeat(Math.floor(outputLimit / 3) + 1)
  assert.equal(Buffer.byteLength(text), outputLimit + 1)
  let child
  const f = await fixture(t, () => { child = textProcess(text); return child })
  await assert.rejects(f.session.finish(), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
  assert.equal(child.signalCode, 'SIGKILL')
  assert.deepEqual(f.events, [])
  await assertRemoved(f)
})

test('OCR accepts exactly 128 KiB of UTF-8 text without dropping any Chinese characters', async t => {
  const text = '中'.repeat(Math.floor(outputLimit / 3)) + 'xx'
  assert.equal(Buffer.byteLength(text), outputLimit)
  const f = await fixture(t, () => textProcess(text))
  await f.session.finish()
  assert.equal(f.events.filter(event => event.type === 'text').map(event => event.text).join(''), text)
  assert.equal(f.events.at(-1).type, 'done')
  await assertRemoved(f)
})

test('OCR text events never split an emoji surrogate pair at the 8000-unit boundary', async t => {
  const text = 'a'.repeat(7999) + '🙂尾'
  const f = await fixture(t, () => textProcess(text))
  await f.session.finish()
  const parts = f.events.filter(event => event.type === 'text')
  assert.deepEqual(parts.map(event => event.sequence), [0, 1])
  assert.deepEqual(parts.map(event => event.text.length), [7999, 3])
  assert.equal(parts.map(event => Buffer.from(event.text).toString('utf8')).join(''), text)
  assert.equal(f.events.at(-1).type, 'done')
  await assertRemoved(f)
})

for (const excess of [0, 1]) test(`vision output ${excess ? 'one byte above' : 'exactly at'} 128 KiB is validated before any text event`, async t => {
  const text = '中'.repeat(Math.floor(outputLimit / 3)) + 'x'.repeat(2 + excess)
  assert.equal(Buffer.byteLength(text), outputLimit + excess)
  const f = await visionFixture(t, text)
  if (excess) {
    await assert.rejects(f.session.finish(), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
    assert.deepEqual(f.events, [])
  } else {
    await f.session.finish()
    assert.equal(f.events.filter(event => event.type === 'text').map(event => event.text).join(''), text)
    assert.equal(f.events.at(-1).type, 'done')
  }
})

test('successful empty OCR still completes without inventing text', async t => {
  const f = await fixture(t, () => {
    const child = processFixture()
    queueMicrotask(() => {
      child.stdout.end(); child.stderr.end()
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    return child
  })
  await f.session.finish()
  assert.deepEqual(f.events, [{ type: 'done' }])
  await assertRemoved(f)
})
