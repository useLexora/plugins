import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReasoningStream } from '../reasoning.mjs'
import { initialize } from '../remote.mjs'

function parse(deltas, options = {}) {
  const events = []
  const parser = createReasoningStream({ emit: event => { events.push(event); return true }, tagged: true, enabled: true, ...options })
  for (const delta of deltas) parser.push(delta)
  parser.finish()
  return { thinking: events.filter(event => event.type === 'thinking').map(event => event.text).join(''), text: events.filter(event => event.type === 'text').map(event => event.text).join('') }
}

test('all tag boundaries preserve reasoning, Unicode, and literal body tags without duplication', () => {
  const input = ' \n<think>分析🙂 < 2 <thinking>字面</thinking></think>正文 <think>example</think>'
  const expected = { thinking: '分析🙂 < 2 <thinking>字面</thinking>', text: '正文 <think>example</think>' }
  for (let index = 0; index <= input.length; index++) assert.deepEqual(parse([{ content: input.slice(0, index) }, { content: input.slice(index) }]), expected)
  assert.deepEqual(parse([...input].map(content => ({ content }))), expected)
})

for (const text of ['normal <think>literal</think>', '```xml\n<think>literal</think>\n```', '<thinking>literal</thinking>', '<thi', '  <', ' '.repeat(300), '</think>literal', 'a\n</think>']) test(`literal prefix/body ${JSON.stringify(text.slice(0, 30))} is unchanged`, () => {
  assert.deepEqual(parse([...text].map(content => ({ content }))), { thinking: '', text })
})

test('explicitly disabled or unrequested thinking never leaks tagged reasoning into body', () => {
  assert.deepEqual(parse([{ content: '<think>secret' }, { content: '</think>answer' }], { enabled: false }), { thinking: '', text: 'answer' })
  assert.deepEqual(parse([{ reasoning_content: 'secret', content: 'answer' }], { enabled: false }), { thinking: '', text: 'answer' })
  assert.deepEqual(parse([{ content: '<think>literal</think>' }], { tagged: false }), { thinking: '', text: '<think>literal</think>' })
})

test('one reasoning source wins, including dual-channel content in the same delta', () => {
  assert.deepEqual(parse([{ reasoning_content: 'A', content: '<th' }, { reasoning_content: 'A', content: 'ink>AA</think>body' }]), { thinking: 'AA', text: 'body' })
  assert.deepEqual(parse([{ content: '<think>A' }, { reasoning_content: 'AA', content: 'A</think>body' }]), { thinking: 'AA', text: 'body' })
  assert.deepEqual(parse([{ content: '<think></think>body' }, { reasoning_content: 'separate' }]), { thinking: 'separate', text: 'body' })
})

test('unfinished reasoning remains thinking and channel rejection stops delivery', () => {
  assert.deepEqual(parse([{ content: '<think>unfinished</thi' }]), { thinking: 'unfinished</thi', text: '' })
  const parser = createReasoningStream({ tagged: true, enabled: true, emit: () => false })
  assert.throws(() => parser.push({ content: '<think>secret</think>answer' }), /CHANNEL_FULL/)
})

test('LFM3 recovers an unopened reasoning prefix across every stream boundary', () => {
  const input = '分析🙂：先查询订单。</think>正文 <think>example</think>'
  for (const enabled of [true, false]) {
    const options = { recoverUnopenedThinking: true, enabled }
    const expected = { thinking: enabled ? '分析🙂：先查询订单。' : '', text: '正文 <think>example</think>' }
    for (let index = 0; index <= input.length; index++) assert.deepEqual(parse([{ content: input.slice(0, index) }, { content: input.slice(index) }], options), expected)
    assert.deepEqual(parse([...input].map(content => ({ content })), options), expected)
  }
})

test('LFM3 recovery keeps ordinary content exactly once and does not change other backends', () => {
  for (const text of ['普通回复🙂', '重复。重复。', 'normal <think>literal', 'a</thi']) {
    assert.deepEqual(parse([...text].map(content => ({ content })), { recoverUnopenedThinking: true }), { thinking: '', text })
  }
  assert.deepEqual(parse([{ content: 'reason</think>body' }]), { thinking: '', text: 'reason</think>body' })
  assert.deepEqual(parse([{ content: 'reason</think>body' }], { tagged: false, recoverUnopenedThinking: true }), { thinking: '', text: 'reason</think>body' })
  assert.deepEqual(parse([{ reasoning_content: 'trace', content: 'body <think>literal</think>' }], { recoverUnopenedThinking: true }), { thinking: 'trace', text: 'body <think>literal</think>' })
})

test('LFM3 recovery preserves inline and fenced tag examples across stream boundaries', () => {
  for (const text of ['normal <think>literal</think> end', '```xml\n<think>literal</think>\n```', '结束标签是 `</think>`。', '``example ` </think>``', '```xml\n</think>\n```\n正文']) {
    for (let index = 0; index <= text.length; index++) assert.deepEqual(parse([{ content: text.slice(0, index) }, { content: text.slice(index) }], { recoverUnopenedThinking: true }), { thinking: '', text })
    assert.deepEqual(parse([...text].map(content => ({ content })), { recoverUnopenedThinking: true }), { thinking: '', text })
  }
  assert.deepEqual(parse([{ content: '分析中的 `</think>` 是示例，继续分析。</think>正文' }], { recoverUnopenedThinking: true }), { thinking: '分析中的 `</think>` 是示例，继续分析。', text: '正文' })
})

test('unmatched backticks and longer closing fences do not hide the real thinking boundary', () => {
  for (const thinking of ['We need count the ` character.', 'Example:\n```xml\n</think>\n````\nContinue thinking.']) {
    const input = thinking + '</think>answer'
    for (let index = 0; index <= input.length; index++) {
      for (const enabled of [true, false]) assert.deepEqual(parse([{ content: input.slice(0, index) }, { content: input.slice(index) }], { recoverUnopenedThinking: true, enabled }), { thinking: enabled ? thinking : '', text: 'answer' })
    }
  }
})

test('late structured reasoning releases undecided body without consuming literal tags', () => {
  for (const enabled of [true, false]) assert.deepEqual(parse([{ content: 'body ' }, { reasoning_content: 'trace', content: '<think>literal</think>' }], { recoverUnopenedThinking: true, enabled }), { thinking: enabled ? 'trace' : '', text: 'body <think>literal</think>' })
})

test('LFM3 buffered text respects event size, Unicode, and output backpressure', () => {
  const events = []
  const input = 'a'.repeat(8191) + '🙂'.repeat(10000)
  const parser = createReasoningStream({ tagged: true, enabled: false, recoverUnopenedThinking: true, emit: event => { events.push(event); return true } })
  parser.push({ content: input })
  assert.equal(events.length, 0)
  parser.finish()
  assert.equal(events.map(event => event.text).join(''), input)
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event)) < 65536 && event.text.isWellFormed()))
  const blocked = createReasoningStream({ tagged: true, enabled: false, recoverUnopenedThinking: true, emit: () => false })
  blocked.push({ content: 'ordinary reply' })
  assert.throws(() => blocked.finish(), /CHANNEL_FULL/)
  const oversized = createReasoningStream({ tagged: true, enabled: false, recoverUnopenedThinking: true, emit: () => true })
  assert.throws(() => oversized.push({ content: 'a'.repeat(16 * 1024 * 1024 + 1) }), /OUTPUT_INVALID/)
})

const frame = value => `data: ${JSON.stringify(value)}\n\n`
for (const reasoning of [undefined, 'off', 'medium']) test(`SSE byte chunks preserve thinking gates and native template switch: ${reasoning}`, async () => {
  const runtime = await initialize({ configuration: { model: 'fixture', chatReasoning: true, chatTemplateReasoning: true } })
  const events = [], diagnostics = []
  let payload
  const bytes = Buffer.from(['<th', 'ink>思考🙂', '</th', 'ink>正文'].map(content => frame({ choices: [{ delta: { content } }] })).join('') + frame({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 }, timings: { prompt_n: 5, prompt_ms: 50, predicted_n: 4, predicted_ms: 20, path: '/secret/path' } }) + 'data: [DONE]\n\n')
  const session = runtime.start('chat', {}, {
    signal: new AbortController().signal,
    emit: event => { events.push(event); return true }, diagnostics: value => diagnostics.push(value),
    network: { post: async (_name, body) => {
      payload = JSON.parse(body)
      return { ok: true, body: (async function* () { for (let index = 0; index < bytes.length; index++) yield bytes.subarray(index, index + 1) })() }
    } },
  })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'hello' }], tools: [], maxTokens: 16, reasoning })))
  await session.finish()
  assert.deepEqual(events, [...(reasoning === 'medium' ? [{ type: 'thinking', text: '思考🙂' }] : []), { type: 'text', text: '正文' }, { type: 'done', reason: 'stop', usage: { input: 5, output: 4, cacheRead: 0 } }])
  assert.deepEqual(payload.chat_template_kwargs, reasoning === undefined ? undefined : { enable_thinking: reasoning !== 'off' })
  assert.equal(Object.hasOwn(payload, 'temperature'), false)
  assert.deepEqual(diagnostics, [{ prompt: { tokens: 5, ms: 50 }, decode: { tokens: 4, ms: 20 } }])
})

for (const reasoning of ['off', 'medium']) test(`LFM3 SSE recovery preserves structured tools and never executes XML prose: ${reasoning}`, async () => {
  const runtime = await initialize({ configuration: { model: 'fixture', chatReasoning: true, chatTemplateReasoning: true, recoverUnopenedThinking: true } })
  const tools = [{ name: 'lookup', description: 'Read an order', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }]
  const events = []
  const xml = '示例：<tool_call>\n<function=lookup>\n<parameter=id>42</parameter>\n</function>\n</tool_call>'
  const frames = [
    { choices: [{ delta: { content: '需要查订单🙂</thi' } }] },
    { choices: [{ delta: { content: 'nk>' + xml, tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"id":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"42"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 9 } },
  ]
  const bytes = Buffer.from(frames.map(frame).join('') + 'data: [DONE]\n\n')
  const session = runtime.start('chat', {}, {
    signal: new AbortController().signal,
    emit: event => { events.push(event); return true },
    network: { post: async (_endpoint, body) => {
      assert.deepEqual(JSON.parse(body).chat_template_kwargs, { enable_thinking: reasoning !== 'off' })
      return { ok: true, body: (async function* () { for (let index = 0; index < bytes.length; index++) yield bytes.subarray(index, index + 1) })() }
    } },
  })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'Read order 42' }], tools, maxTokens: 128, reasoning })))
  await session.finish()
  assert.deepEqual(events, [
    ...(reasoning === 'medium' ? [{ type: 'thinking', text: '需要查订单🙂' }] : []),
    { type: 'text', text: xml },
    { type: 'tool', call: { id: 'call-1', name: 'lookup', arguments: { id: '42' } } },
    { type: 'done', reason: 'toolUse', usage: { input: 8, output: 9, cacheRead: 0 } },
  ])
})

for (const temperature of [0, 0.7]) test(`explicit sampling temperature ${temperature} is preserved`, async () => {
  const runtime = await initialize({ configuration: { model: 'fixture' } })
  const session = runtime.start('chat', {}, { signal: new AbortController().signal, emit: () => true, network: { post: async (_name, bytes) => {
    assert.equal(JSON.parse(bytes).temperature, temperature)
    return new Response(frame({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 0 } }) + 'data: [DONE]\n\n')
  } } })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'hello' }], tools: [], maxTokens: 16, temperature })))
  await session.finish()
})
