import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialize } from '../remote.mjs'

const text = text => ({ type: 'text', text })
const image = (mimeType, data = 'cGljdHVyZQ==') => ({ type: 'image', mimeType, data })
const frame = data => `data: ${JSON.stringify(data)}\n\n`
const finished = reason => frame({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + 'data: [DONE]\n\n'
const request = messages => ({ messages, tools: [], maxTokens: 64 })

async function sessionFor(body, { response = new Response(finished('stop')), controller = new AbortController(), emit, post, chatTemplateReasoning = false, chatReasoning } = {}) {
  const runtime = await initialize({ configuration: { model: 'test-model', chatTemplateReasoning, ...(chatReasoning !== undefined ? { chatReasoning } : {}) } })
  const events = []
  let payload, posts = 0
  const session = runtime.start('chat', {}, {
    signal: controller.signal,
    emit: event => { events.push(event); return emit ? emit(event) : true },
    network: { post: async (endpoint, bytes) => { assert.equal(endpoint, 'chat'); posts++; payload = JSON.parse(bytes.toString()); return post ? post(payload, bytes) : response } },
  })
  if (body) session.write(Buffer.from(JSON.stringify(body)))
  return { session, events, payload: () => payload, posts: () => posts }
}

test('text messages and structured tool errors preserve their wire semantics', async () => {
  const tool = { name: 'read', description: 'read data', parameters: { type: 'object', properties: { nested: { type: 'array', items: { type: 'integer' } } } } }
  const argumentsValue = { nested: [1, 2], quoted: '"' }
  const body = { ...request([
    { role: 'system', text: 'system' }, { role: 'user', text: 'hello' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'read', arguments: argumentsValue }] },
    { role: 'tool', toolCallId: 'call-1', text: 'success', isError: false },
    { role: 'tool', toolCallId: 'call-2', text: 'failed', isError: true },
  ]), tools: [tool], temperature: 0.2 }
  const f = await sessionFor(body, { chatTemplateReasoning: true })
  await f.session.finish()
  assert.deepEqual(f.payload(), {
    model: 'test-model', max_tokens: 64, temperature: 0.2, stream: true, stream_options: { include_usage: true },
    tools: [{ type: 'function', function: tool }],
    messages: [
      { role: 'system', content: 'system' }, { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify(argumentsValue) } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'success' },
      { role: 'tool', tool_call_id: 'call-2', content: '{"isError":true,"text":"failed"}' },
    ],
  })
})

test('multiple user and tool images preserve order and only use supplied data URIs', async () => {
  const parts = [text('before'), image('image/png'), text('middle'), image('image/jpeg'), image('image/webp'), image('image/gif'), text('after')]
  const expected = parts.map(part => part.type === 'text' ? part : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } })
  const f = await sessionFor(request([
    { role: 'user', content: parts },
    { role: 'tool', toolCallId: 'ok', content: parts, isError: false },
    { role: 'tool', toolCallId: 'failed', content: parts, isError: true },
  ]))
  await f.session.finish()
  assert.deepEqual(f.payload().messages, [
    { role: 'user', content: expected },
    { role: 'tool', tool_call_id: 'ok', content: expected },
    { role: 'tool', tool_call_id: 'failed', content: [text('{"isError":true}'), ...expected] },
  ])
})

test('the complete request remains limited to 32 MiB across chunks', async () => {
  const f = await sessionFor()
  const chunk = Buffer.alloc(1024 * 1024)
  for (let index = 0; index < 32; index++) f.session.write(chunk)
  assert.throws(() => f.session.write(Buffer.from('x')), /EXTENSION_INFERENCE_CONTEXT_TOO_LARGE/)
  assert.equal(f.payload(), undefined)
})

function sizedImageRequest(byteLength) {
  const body = request([{ role: 'user', content: [text('图'), image('image/png')] }])
  const padding = byteLength - Buffer.byteLength(JSON.stringify(body))
  body.messages[0].content[0].text += 'x'.repeat(padding % 4)
  body.messages[0].content[1].data = 'A'.repeat(padding - padding % 4) + body.messages[0].content[1].data
  assert.equal(Buffer.byteLength(JSON.stringify(body)), byteLength)
  return body
}

test('serialized transport body accepts exactly 32 MiB and rejects one byte above it', async () => {
  const limit = 32 * 1024 * 1024
  const sample = sizedImageRequest(1024)
  const calibration = await sessionFor(sample)
  await calibration.session.finish()
  const overhead = Buffer.byteLength(JSON.stringify(calibration.payload())) - 1024
  assert.ok(overhead > 1)
  for (const excess of [0, 1]) {
    const f = await sessionFor(sizedImageRequest(limit - overhead + excess), {
      post: (_payload, bytes) => {
        assert.ok(Buffer.isBuffer(bytes))
        assert.equal(bytes.length, limit)
        return new Response(finished('stop'))
      },
    })
    if (excess) {
      await assert.rejects(f.session.finish(), /EXTENSION_INFERENCE_CONTEXT_TOO_LARGE/)
      assert.equal(f.payload(), undefined)
      assert.deepEqual(f.events, [])
    } else {
      await f.session.finish()
      assert.equal(f.events.at(-1).type, 'done')
    }
  }
})

for (const message of [
  { role: 'user', text: 'text', content: [text('both')] },
  { role: 'tool', toolCallId: 't', text: 'text', content: [image('image/png')] },
  { role: 'user', content: [] },
  { role: 'user', content: [image('image/svg+xml')] },
  { role: 'user', content: [image('image/png', 'https://example.invalid/image.png')] },
  { role: 'user', content: [image('image/png', 'abc')] },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] },
]) test('invalid or ambiguous image messages are rejected before network transport', async () => {
  const f = await sessionFor(request([message]), { post: () => { assert.fail('Invalid request reached transport') } })
  await assert.rejects(f.session.finish(), /EXTENSION_INFERENCE_INPUT_INVALID/)
  assert.deepEqual(f.events, [])
})

// Cover each independent gate, not the Cartesian product of disabled gates.
for (const [chatReasoning, reasoning] of [[undefined, 'medium'], [false, 'medium'], [true, 'medium'], [true, 'high'], [true, 'off'], [true, undefined]]) test(`host reasoning ${chatReasoning} and request ${reasoning} keep thinking, text and tools separate across stream chunks`, async () => {
  const body = [
    { choices: [{ delta: { reasoning_content: null } }] },
    { choices: [{ delta: { reasoning_content: '分析🙂' } }] },
    { choices: [{ delta: { reasoning_content: '工具', content: '先', tool_calls: [{ index: 0, id: 'call-', function: { name: 're', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { content: '读', tool_calls: [{ index: 0, id: '1', function: { name: 'ad', arguments: '"file.png","nested":{"n":2}}' } }] } }] },
    { choices: [{ delta: { reasoning_content: '' }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } } },
  ].map(frame).join('') + 'data: [DONE]\n\n'
  const response = { ok: true, body: (async function* () {
    const bytes = Buffer.from(body)
    for (let offset = 0; offset < bytes.length; offset += 7) yield bytes.subarray(offset, offset + 7)
  })() }
  const f = await sessionFor({ ...request([{ role: 'user', text: 'read' }]), ...(reasoning !== undefined ? { reasoning } : {}) }, { response, chatTemplateReasoning: true, chatReasoning })
  await f.session.finish()
  assert.deepEqual(f.events, [
    ...(chatReasoning === true && ['medium', 'high'].includes(reasoning) ? [{ type: 'thinking', text: '分析🙂' }, { type: 'thinking', text: '工具' }] : []),
    { type: 'text', text: '先' }, { type: 'text', text: '读' },
    { type: 'tool', call: { id: 'call-1', name: 'read', arguments: { path: 'file.png', nested: { n: 2 } } } },
    { type: 'done', reason: 'toolUse', usage: { input: 10, output: 7, cacheRead: 2 } },
  ])
  assert.deepEqual(f.payload().chat_template_kwargs, reasoning === undefined ? undefined : { enable_thinking: reasoning !== 'off' })
  assert.equal(f.payload().max_tokens, 64)
  assert.equal(f.payload().temperature, 0)
  assert.equal(f.posts(), 1)
})

test('blocked thinking output stops the stream without leaking text or retrying', async () => {
  const body = frame({ choices: [{ delta: { reasoning_content: 'analysis', content: 'answer' } }] }) + finished('stop')
  const f = await sessionFor({ ...request([{ role: 'user', text: 'hello' }]), reasoning: 'medium' }, { response: new Response(body), emit: () => false, chatReasoning: true })
  await assert.rejects(f.session.finish(), /EXTENSION_INFERENCE_CHANNEL_FULL/)
  assert.deepEqual(f.events, [{ type: 'thinking', text: 'analysis' }])
  assert.equal(f.posts(), 1)
})

test('cancellation during thinking preserves partial output without completion or another POST', async () => {
  const controller = new AbortController()
  const response = { ok: true, body: (async function* () {
    yield Buffer.from(frame({ choices: [{ delta: { reasoning_content: 'partial' } }] }))
    controller.abort()
    yield Buffer.from(frame({ choices: [{ delta: { content: 'answer' } }] }) + finished('stop'))
  })() }
  const f = await sessionFor({ ...request([{ role: 'user', text: 'hello' }]), reasoning: 'medium' }, { controller, response, chatReasoning: true })
  await assert.rejects(f.session.finish(), { name: 'AbortError' })
  assert.deepEqual(f.events, [{ type: 'thinking', text: 'partial' }])
  assert.equal(f.posts(), 1)
})

test('malformed tool arguments fail without inventing a successful completion', async () => {
  const body = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{' } }] } }] }) + finished('tool_calls')
  const f = await sessionFor(request([{ role: 'user', text: 'read' }]), { response: new Response(body) })
  await assert.rejects(f.session.finish(), SyntaxError)
  assert.deepEqual(f.events, [])
})

test('pre-cancelled requests never reach transport and reject further writes', async () => {
  const controller = new AbortController()
  const f = await sessionFor(request([{ role: 'user', text: 'hello' }]), { controller })
  controller.abort()
  await assert.rejects(f.session.finish(), { name: 'AbortError' })
  assert.equal(f.payload(), undefined)
  assert.throws(() => f.session.write(Buffer.from('x')), { name: 'AbortError' })
})

test('incomplete streams and blocked output fail rather than reporting success', async () => {
  const f = await sessionFor(request([{ role: 'user', text: 'hello' }]), { response: new Response(frame({ choices: [{ delta: { content: 'partial' } }] })) })
  await assert.rejects(f.session.finish(), /EXTENSION_INFERENCE_OUTPUT_INCOMPLETE/)
  const g = await sessionFor(request([{ role: 'user', text: 'hello' }]), { emit: () => false })
  await assert.rejects(g.session.finish(), /EXTENSION_INFERENCE_CHANNEL_FULL/)
})
