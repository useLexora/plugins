import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolArguments } from '../tool-arguments.mjs'
import { initialize } from '../remote.mjs'

const parameters = {
  type: 'object',
  anyOf: [
    { type: 'object', properties: { kind: { const: 'url', type: 'string' }, url: { type: 'string', pattern: '^https?://' }, background: { type: 'boolean' } }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'local-file', type: 'string' }, entryPath: { type: 'string', minLength: 1 } }, required: ['kind', 'entryPath'], additionalProperties: false },
  ],
}
const browser = { name: 'open_page', description: 'Open a URL or local file', parameters }
const plain = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const args = { kind: 'url', url: 'https://example.com/', background: false }

for (const keyword of ['anyOf', 'oneOf', 'allOf']) test(`${keyword} tool schemas retain their full constraints inside one required argument`, () => {
  const schema = { type: 'object', [keyword]: parameters.anyOf }
  const original = structuredClone(schema)
  const adapter = createToolArguments([{ ...browser, parameters: schema }, plain], true)
  assert.deepEqual(adapter.tools[0], { ...browser, parameters: { type: 'object', properties: { input: original }, required: ['input'], additionalProperties: false } })
  assert.deepEqual(schema, original)
  assert.equal(adapter.tools[1], plain)
  assert.deepEqual(adapter.decode(browser.name, adapter.encode(browser.name, args)), args)
  assert.equal(adapter.encode(plain.name, args), args)
  assert.equal(adapter.decode(plain.name, args), args)
})

test('nested unions and remote endpoint schemas remain unchanged', () => {
  const nested = { ...plain, parameters: { type: 'object', properties: { input: parameters } } }
  const tools = [browser, nested]
  const remote = createToolArguments(tools, false)
  assert.equal(remote.tools, tools)
  assert.equal(remote.encode(browser.name, args), args)
  assert.equal(remote.decode(browser.name, args), args)
  assert.equal(createToolArguments([nested], true).tools[0], nested)
})

test('root references and type alternatives use the same lossless boundary', () => {
  for (const schema of [{ $ref: '#/$defs/args', $defs: { args: parameters } }, { type: ['object'], properties: { input: { type: 'string' } } }]) {
    const adapter = createToolArguments([{ ...browser, parameters: schema }], true)
    assert.equal(adapter.tools[0].parameters.type, 'object')
    const value = { input: 'an original input field' }
    assert.deepEqual(adapter.decode(browser.name, adapter.encode(browser.name, value)), value)
  }
})

test('schema-local and same-resource URI pointers relocate without rewriting example data', () => {
  const schema = {
    $id: 'https://example.com/tool',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    anyOf: [{ $ref: '#/$defs/url' }, { $ref: '#/$defs/local' }],
    $defs: {
      url: { type: 'object', properties: { value: { $ref: '#' }, absolute: { $ref: 'https://example.com/tool#/$defs/local' }, relative: { $ref: 'tool#/$defs/local' } } },
      local: { type: 'object', properties: { value: { type: 'string' } } },
    },
    examples: [{ $ref: '#/literal-data' }],
    default: { $ref: '#/literal-default' },
  }
  const original = structuredClone(schema)
  const projected = createToolArguments([{ ...browser, parameters: schema }], true).tools[0].parameters
  assert.equal(projected.$id, schema.$id)
  assert.equal(projected.$schema, schema.$schema)
  assert.equal(projected.properties.input.$id, undefined)
  assert.equal(projected.properties.input.anyOf[0].$ref, '#/properties/input/$defs/url')
  assert.equal(projected.properties.input.$defs.url.properties.value.$ref, '#/properties/input')
  assert.equal(projected.properties.input.$defs.url.properties.absolute.$ref, '#/properties/input/$defs/local')
  assert.equal(projected.properties.input.$defs.url.properties.relative.$ref, '#/properties/input/$defs/local')
  assert.deepEqual(projected.properties.input.examples, schema.examples)
  assert.deepEqual(projected.properties.input.default, schema.default)
  assert.deepEqual(schema, original)
})

for (const schema of [
  { $ref: 'https://example.com/external' },
  { $ref: '#named-anchor' },
  { $dynamicRef: '#' },
  { $recursiveRef: '#' },
  { $id: 'nested', type: 'object' },
]) test(`non-local or dynamic schema references fail explicitly: ${JSON.stringify(schema)}`, () => {
  assert.throws(() => createToolArguments([{ ...browser, parameters: { anyOf: [schema] } }], true), /^Error: EXTENSION_INFERENCE_INPUT_INVALID$/)
})

for (const value of [null, [], {}, { kind: 'url' }, { input: null }, { input: [] }, { input: 'text' }, { input: args, extra: true }]) test(`malformed envelopes cannot become executable tool arguments: ${JSON.stringify(value)}`, () => {
  assert.throws(() => createToolArguments([browser], true).decode(browser.name, value), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
})

test('schema nesting is bounded before a model request', () => {
  let schema = { type: 'object' }
  for (let i = 0; i < 70; i++) schema = { anyOf: [schema] }
  assert.throws(() => createToolArguments([{ ...browser, parameters: schema }], true), /^Error: EXTENSION_INFERENCE_INPUT_INVALID$/)
})

const frame = value => `data: ${JSON.stringify(value)}\n\n`
async function invoke(envelope, returnedArguments) {
  const runtime = await initialize({ configuration: { model: 'fixture', chatToolSchemaEnvelope: envelope } })
  const events = []
  let payload
  const response = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: { name: browser.name, arguments: JSON.stringify(returnedArguments) } }] } }] },
    { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
  ].map(frame).join('') + 'data: [DONE]\n\n'
  const session = runtime.start('chat', {}, {
    signal: new AbortController().signal,
    emit: event => { events.push(event); return true },
    network: { post: async (_endpoint, body) => {
      payload = JSON.parse(body)
      const bytes = Buffer.from(response)
      return { ok: true, body: (async function* () { for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1) })() }
    } },
  })
  session.write(Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', text: 'Open the page' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: browser.name, arguments: args }] },
      { role: 'tool', toolCallId: 'call-1', name: browser.name, text: 'Page ready', isError: false },
      { role: 'user', text: 'Open it again' },
    ],
    tools: [browser, plain], maxTokens: 128,
  })))
  await session.finish()
  return { payload, events }
}

for (const envelope of [false, true]) test(`SSE and assistant history keep public tool identity and original argument shape: ${envelope}`, async () => {
  const { payload, events } = await invoke(envelope, envelope ? { input: args } : args)
  assert.deepEqual(payload.tools[0].function.parameters, envelope ? { type: 'object', properties: { input: parameters }, required: ['input'], additionalProperties: false } : parameters)
  assert.deepEqual(payload.tools[1].function, plain)
  assert.deepEqual(payload.messages[1].tool_calls[0], { id: 'call-1', type: 'function', function: { name: browser.name, arguments: JSON.stringify(envelope ? { input: args } : args) } })
  assert.deepEqual(payload.messages[2], { role: 'tool', tool_call_id: 'call-1', content: 'Page ready' })
  assert.deepEqual(events, [
    { type: 'tool', call: { id: 'call-2', name: browser.name, arguments: args } },
    { type: 'done', reason: 'toolUse', usage: { input: 7, output: 4, cacheRead: 0 } },
  ])
})

test('local protocol rejects a missing envelope rather than substituting empty arguments', async () => {
  await assert.rejects(invoke(true, args), /^Error: EXTENSION_INFERENCE_OUTPUT_INVALID$/)
})
