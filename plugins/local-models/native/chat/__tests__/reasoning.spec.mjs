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

for (const temperature of [0, 0.7]) test(`explicit sampling temperature ${temperature} is preserved`, async () => {
  const runtime = await initialize({ configuration: { model: 'fixture' } })
  const session = runtime.start('chat', {}, { signal: new AbortController().signal, emit: () => true, network: { post: async (_name, bytes) => {
    assert.equal(JSON.parse(bytes).temperature, temperature)
    return new Response(frame({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 0 } }) + 'data: [DONE]\n\n')
  } } })
  session.write(Buffer.from(JSON.stringify({ messages: [{ role: 'user', text: 'hello' }], tools: [], maxTokens: 16, temperature })))
  await session.finish()
})
