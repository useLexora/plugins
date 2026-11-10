import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { initialize } from '../remote.mjs'
import { createTransport } from '../transport.mjs'

async function invoke(response, { reasoning, inspectPayload = () => {}, emit = () => true } = {}) {
  const runtime = await initialize({ configuration: { model: 'local' } })
  const session = runtime.start('chat', {}, { signal: new AbortController().signal, emit, network: { post: async (_endpoint, body) => { inspectPayload(JSON.parse(body.toString('utf8'))); return response } } })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'Hello' }], tools: [], maxTokens: 64, ...(reasoning !== undefined ? { reasoning } : {}) })))
  await session.finish()
}

test('generic remote endpoints do not receive local template parameters', async () => {
  const response = new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\ndata: [DONE]\n\n')
  await invoke(response, { reasoning: 'off', inspectPayload: payload => assert.equal(Object.hasOwn(payload, 'chat_template_kwargs'), false) })
})

for (const error of [
  { type: 'exceed_context_size_error', message: 'Request exceeds the available context size' },
  { code: 'context_length_exceeded', message: 'Input is too long' },
]) test('classifies context rejection without reporting a network failure', async () => {
  await assert.rejects(invoke(Response.json({ error }, { status: 400 })), /EXTENSION_INFERENCE_CONTEXT_TOO_LARGE/)
})
for (const usage of [
  { prompt_tokens: 2, completion_tokens: 'private-output' },
  { prompt_tokens: -1, completion_tokens: 2 },
  { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } },
]) test('invalid token usage cannot reach output or diagnostics as arbitrary content', async () => {
  const response = new Response(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
  const events = []
  await assert.rejects(invoke(response, { emit: event => { events.push(event); return true } }), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
  assert.deepEqual(events, [])
})

test('in-stream engine errors keep partial output but never produce a successful terminal', async () => {
  const response = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"out of memory /private/path secret"}}\n\n')
  const events = []
  await assert.rejects(invoke(response, { emit: event => { events.push(event); return true } }), /^Error: EXTENSION_INFERENCE_RESOURCE_EXHAUSTED$/)
  assert.deepEqual(events, [{ type: 'text', text: 'partial' }])
})

test('bounds rejected response bodies without reflecting backend content', async () => {
  await assert.rejects(invoke(new Response('private'.repeat(10000), { status: 400 })), /^Error: EXTENSION_INFERENCE_REQUEST_REJECTED$/)
})

const lineLimit = 262144
const complete = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\ndata: [DONE]\n\n'
const stream = parts => ({ ok: true, body: (async function* () { for (const part of parts) yield Buffer.from(part) })() })

test('SSE drains complete small events before limiting an unfinished line across transport chunks', async () => {
  const content = 'x'.repeat(1000)
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  const body = Buffer.from(event.repeat(280) + complete)
  const events = []
  await invoke(stream([body.subarray(0, 200), body.subarray(200, 200 + lineLimit), body.subarray(200 + lineLimit)]), { emit: event => { events.push(event); return true } })
  assert.equal(events.length, 281)
  assert.ok(events.slice(0, -1).every(event => event.type === 'text' && event.text === content))
  assert.equal(events.at(-1).type, 'done')
})

test('SSE accepts a single line exactly at the existing limit even with the next event in its chunk', async () => {
  const prefix = 'data: {"padding":"', suffix = '"}'
  const line = prefix + 'x'.repeat(lineLimit - prefix.length - suffix.length) + suffix
  await invoke(stream([line + '\n\n' + complete]))
})

test('SSE accepts a bounded event through real loopback HTTP and the runtime transport', async t => {
  const prefix = 'data: {"padding":"', suffix = '"}'
  const payload = prefix + 'x'.repeat(lineLimit - prefix.length - suffix.length) + suffix + '\n\n' + complete
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(payload) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const transport = createTransport(undefined, 'win32')
  transport.observe(`listening on http://127.0.0.1:${server.address().port}\n`)
  const runtime = await initialize({ configuration: { model: 'fixture' } }), events = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const session = runtime.start('chat', {}, {
    signal: controller.signal,
    emit: event => { events.push(event); return true },
    network: { post: (_id, body) => transport.request('/chat', body, controller.signal) },
  })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'test' }], tools: [], maxTokens: 1 })))
  await session.finish()
  assert.deepEqual(events, [{ type: 'done', reason: 'stop', usage: { input: 1, output: 0, cacheRead: 0 } }])
})

for (const [name, parts] of [
  ['complete overlong line', ['data: ' + 'x'.repeat(lineLimit) + '\n\n' + complete]],
  ['unfinished overlong line', ['data: ' + 'x'.repeat(lineLimit)]],
  ['fragmented overlong line', ['data: ' + 'x'.repeat(lineLimit / 2), 'x'.repeat(lineLimit / 2)]],
]) test(`SSE rejects a ${name} without emitting a terminal or consuming later chunks`, async () => {
  const events = []
  const response = { ok: true, body: (async function* () { for (const part of parts) yield Buffer.from(part); assert.fail('read beyond the line limit') })() }
  await assert.rejects(invoke(response, { emit: event => { events.push(event); return true } }), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
  assert.deepEqual(events, [])
})
