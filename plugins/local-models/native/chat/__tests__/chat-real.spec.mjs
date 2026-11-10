import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialize } from '../chat.mjs'

const engine = process.env.LEXORA_CHAT_TEST_ENGINE
const model = process.env.LEXORA_CHAT_TEST_MODEL
const lfm3 = process.env.LEXORA_CHAT_TEST_PROFILE === 'lfm3'

test('opt-in real CPU engine validates the selected model profile', { skip: !engine || !model, timeout: 180000 }, async t => {
  const runtime = await initialize({
    resources: { engine, model: engine },
    resourceFiles: { model: { 'model.gguf': model } },
    configuration: { engineBackend: 'cpu', acceleration: 'cpu', engineVersion: process.env.LEXORA_CHAT_TEST_ENGINE_VERSION, ...(lfm3 ? { architecture: 'lfm3', minimumEngineVersion: 'b12211' } : {}), contextWindow: 4096, threads: 4, files: { model: 'model.gguf' }, chatReasoning: true },
  })
  t.after(() => runtime.dispose())
  const invoke = async (messages, tools = [], options = {}) => {
    const controller = options.controller ?? new AbortController()
    const events = []
    const session = runtime.start('chat', {}, { signal: controller.signal, emit: event => { events.push(event); options.onEmit?.(event); return true } })
    session.write(Buffer.from(JSON.stringify({ messages, tools, maxTokens: 96, reasoning: 'off', ...options.request })))
    await session.finish()
    return events
  }
  await t.test(lfm3 ? 'LFM3 Q6_K loads and gives a short Chinese response without thinking leakage' : 'short completion uses model sampling defaults and ends once', async () => {
    const events = await invoke([{ role: 'user', text: lfm3 ? '请只用一句简短中文解释什么是本地模型。' : 'Reply with only the word hello.' }], [], lfm3 ? { request: { temperature: 0.1 } } : {})
    assert.ok(events.some(event => event.type === 'text' && event.text.trim()))
    assert.equal(events.filter(event => event.type === 'done').length, 1)
    assert.equal(events.at(-1).reason, 'stop')
    assert.ok(events.at(-1).usage.input > 0)
    assert.ok(events.at(-1).usage.output > 0)
    assert.ok(events.every(event => event.type !== 'thinking'))
    const text = events.filter(event => event.type === 'text').map(event => event.text).join('')
    assert.doesNotMatch(text, /<\/?think>/)
    if (lfm3) assert.match(text, /[\u3400-\u9fff]/)
  })
  if (lfm3) return
  await t.test('structured tool arguments and tool result survive a real round-trip', async () => {
    const tools = [{ name: 'get_weather', description: 'Read the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string', enum: ['Paris'] }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city'] } }]
    const messages = [{ role: 'system', text: 'You must use get_weather to look up weather. Never invent a weather result. After getting a result, answer briefly using its temperature.' }, { role: 'user', text: 'What is the current weather in Paris? Call get_weather first.' }]
    const first = await invoke(messages, tools, { request: { temperature: 0 } })
    const calls = first.filter(event => event.type === 'tool').map(event => event.call)
    assert.equal(first.at(-1).reason, 'toolUse')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'get_weather')
    assert.equal(calls[0].arguments.city, 'Paris')
    const next = await invoke([...messages, { role: 'assistant', text: first.filter(event => event.type === 'text').map(event => event.text).join(''), toolCalls: calls }, { role: 'tool', toolCallId: calls[0].id, text: '{"temperature":17,"unit":"celsius","condition":"sunny"}', isError: false }], tools, { request: { temperature: 0 } })
    assert.equal(next.at(-1).reason, 'stop')
    assert.match(next.filter(event => event.type === 'text').map(event => event.text).join(''), /17/)
  })
  await t.test('cancellation during output rejects and drains its own engine', async () => {
    const controller = new AbortController()
    let partial = false
    await assert.rejects(invoke([{ role: 'user', text: 'Count from one to one hundred, with each number on its own line.' }], [], { controller, onEmit: event => { if (event.type === 'text') { partial = true; controller.abort() } } }), error => error.name === 'AbortError' || error.code === 'ABORT_ERR')
    assert.equal(partial, true)
  })
})
