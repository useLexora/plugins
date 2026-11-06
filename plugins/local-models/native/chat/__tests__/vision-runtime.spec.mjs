import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initialize } from '../../reading/reading.mjs'

const image = (mimeType = 'image/png', data = 'cGljdHVyZQ==') => ({ type: 'image', mimeType, data })
const text = text => ({ type: 'text', text })
const chatRequest = messages => ({ messages, tools: [], maxTokens: 96 })
const readingRequest = question => ({ requestId: 'fixture-reading', operation: 'understand', question, image: image() })

async function fixture(t, configuration = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-vision-test-'))
  let runtime
  t.after(async () => { try { await runtime?.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  const executable = join(directory, 'llama-server')
  await copyFile(new URL('./fixtures/llama-server.cjs', import.meta.url), executable)
  await chmod(executable, 0o700)
  const observations = async () => (await readFile(join(directory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const waitForRequest = marker => new Promise((resolve, reject) => {
    const watcher = watch(directory, async () => {
      try { if ((await observations()).some(item => item.type === 'request' && JSON.stringify(item.payload).includes(marker))) { watcher.close(); resolve() } }
      catch (error) { watcher.close(); reject(error) }
    })
    t.after(() => watcher.close())
  })
  runtime = await initialize({ resources: { engine: directory, model: directory }, configuration: { backend: 'vision', threads: 6, ...configuration } })
  const invoke = async (capability, request, controller = new AbortController(), onEmit = () => true) => {
    const events = []
    const session = runtime.start(capability, {}, { signal: controller.signal, emit: event => { events.push(event); return onEmit(event) } })
    const bytes = Buffer.from(JSON.stringify(request))
    for (let offset = 0; offset < bytes.length; offset += 31) session.write(bytes.subarray(offset, offset + 31))
    await session.finish()
    return events
  }
  return { directory, runtime, invoke, observations, waitForRequest }
}

const linux = { skip: process.platform !== 'linux', timeout: 10000 }

test('vision chat and legacy reading share one server, identity and configured model/projector', linux, async t => {
  const f = await fixture(t, { contextWindow: 65536, maxTokens: 768, chatReasoning: true, files: { model: 'custom.gguf', projector: 'custom-mmproj.gguf' } })
  const user = { role: 'user', content: [text('__reasoning__'), image(), text('between'), image('image/jpeg', 'c2Vjb25k'), text('last')] }
  const tool = { role: 'tool', toolCallId: 'read-1', toolName: 'read', content: [text('tool first'), image('image/webp'), text('tool last')] }
  const assistant = { role: 'assistant', text: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: { path: 'image.webp' } }] }
  const chatEvents = await f.invoke('vision-chat', { ...chatRequest([{ role: 'system', text: 'system' }, user, assistant, tool]), reasoning: 'medium' })
  assert.deepEqual(chatEvents, [{ type: 'thinking', text: 'fixture thinking' }, { type: 'text', text: 'fixture reply' }, { type: 'done', reason: 'stop', usage: { input: 10, output: 3, cacheRead: 2 } }])
  assert.deepEqual(await f.invoke('vision', readingRequest('__reasoning__ read image')), [{ type: 'text', sequence: 0, text: 'fixture reply' }, { type: 'done' }])
  await f.invoke('vision-chat', chatRequest([{ role: 'user', text: 'plain text' }]))
  for (const operation of ['extract', 'document']) await f.invoke('vision', { ...readingRequest(''), operation })
  const observations = await f.observations()
  const starts = observations.filter(item => item.type === 'start')
  assert.equal(starts.length, 1)
  const { pid, args } = starts[0]
  assert.equal(args[args.indexOf('-m') + 1], join(f.directory, 'custom.gguf'))
  assert.equal(args[args.indexOf('--mmproj') + 1], join(f.directory, 'custom-mmproj.gguf'))
  assert.equal(args[args.indexOf('-c') + 1], '65536')
  assert.equal(args[args.indexOf('-t') + 1], '6')
  assert.ok(args.includes('--jinja'))
  const requests = observations.filter(item => item.type === 'request')
  assert.equal(requests.length, 5)
  assert.ok(requests.every(item => item.pid === pid))
  const convert = part => part.type === 'text' ? part : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
  assert.deepEqual(requests[0].payload.messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: user.content.map(convert) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"image.webp"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: tool.content.map(convert) },
  ])
  assert.deepEqual(requests[0].payload.chat_template_kwargs, { enable_thinking: true })
  assert.deepEqual(requests[1].payload.messages[1].content, [text('__reasoning__ read image'), convert(image())])
  assert.equal(requests[1].payload.max_tokens, 768)
  assert.deepEqual(requests[2].payload.messages, [{ role: 'user', content: 'plain text' }])
  assert.match(requests[3].payload.messages[0].content, /Transcribe the visible text exactly/)
  assert.match(requests[4].payload.messages[0].content, /Markdown preserving headings/)
  await f.runtime.dispose()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('legacy vision defaults keep the original model files and bounded reading output', linux, async t => {
  const f = await fixture(t)
  const [{ args }] = await f.observations()
  assert.equal(args[args.indexOf('-m') + 1], join(f.directory, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'))
  assert.equal(args[args.indexOf('--mmproj') + 1], join(f.directory, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'))
  assert.equal(args[args.indexOf('-c') + 1], '4096')
  const emitted = []
  await assert.rejects(f.invoke('vision', readingRequest('__length__'), undefined, event => { emitted.push(event); return true }), /EXTENSION_INFERENCE_OUTPUT_INCOMPLETE/)
  assert.deepEqual(emitted, [])
  await assert.rejects(f.invoke('vision', readingRequest('__context__')), /EXTENSION_INFERENCE_CONTEXT_TOO_LARGE/)
  assert.deepEqual(await f.invoke('vision', readingRequest('recovered')), [{ type: 'text', sequence: 0, text: 'fixture reply' }, { type: 'done' }])
  assert.equal((await f.observations()).filter(item => item.type === 'start').length, 1)
})

for (const capability of ['vision-chat', 'vision']) test(`${capability} cancellation stops and drains the shared server before reuse`, linux, async t => {
  const f = await fixture(t)
  const [{ pid }] = await f.observations()
  const controller = new AbortController()
  const arrived = f.waitForRequest('__wait__')
  const pending = f.invoke(capability, capability === 'vision' ? readingRequest('__wait__') : chatRequest([{ role: 'user', content: [text('__wait__'), image()] }]), controller)
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'ABORT_ERR')
  await arrived
  controller.abort()
  await rejected
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await f.invoke('vision-chat', chatRequest([{ role: 'user', text: 'recovered' }]))
  await f.invoke('vision', readingRequest('read after restart'))
  const starts = (await f.observations()).filter(item => item.type === 'start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[1].pid, pid)
})

test('OCR stays separate and rejects chat capability without loading a vision engine', async () => {
  const runtime = await initialize({ resources: {}, configuration: { backend: 'ocr', threads: 2 } })
  try {
    assert.throws(() => runtime.start('vision-chat', {}, { signal: new AbortController().signal }), /EXTENSION_INFERENCE_CAPABILITY_UNAVAILABLE/)
    const controller = new AbortController()
    const session = runtime.start('ocr', {}, { signal: controller.signal })
    controller.abort()
    assert.throws(() => session.write(Buffer.from('{}')), { name: 'AbortError' })
    await assert.rejects(session.finish(), { name: 'AbortError' })
  } finally { await runtime.dispose() }
})
