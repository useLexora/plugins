import assert from 'node:assert/strict'
import test from 'node:test'
import { declaredModelMetadata, ggufModelMetadata, huggingFaceBaseModels, modelCatalogReferences, modelToolBinding, templateModelMetadata } from '../modelToolSupport.js'
import { serverModelMetadata } from '../native/chat/model-metadata.mjs'

const origin = { source: 'huggingface', repository: 'example/converted-model', revision: '1'.repeat(40) }
const ref = modelId => ({ providerId: 'huggingface', modelId })
const template = `{% if tools %}{{ tools | tojson }}{% endif %}
{% for message in messages %}{% if message.tool_calls %}{{ message.tool_calls | tojson }}{% endif %}{% endfor %}
{% if enable_thinking %}{{ '<think>' }}{% else %}{{ '<think></think>' }}{% endif %}`

test('base model declarations remain identity hints, not unconditional inherited capabilities', () => {
  const baseModels = huggingFaceBaseModels({ cardData: { base_model: ['example/base', 'example/base'] }, tags: ['base_model:other/base', 'base_model:quantized:example/quantized-source', null] })
  assert.deepEqual(baseModels, ['example/base', 'other/base', 'example/quantized-source'])
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { baseModels } }), [ref(origin.repository)])
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { baseModels, baseModelRelation: 'quantized' } }), [origin.repository, ...baseModels].map(ref))
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { tags: ['base_model:other/base', 'base_model:quantized:example/source'] } }), [ref(origin.repository), ref('example/source')])
})

test('references use exact pinned identity, never a title, guessed base or local filename', () => {
  for (const source of ['local', 'github']) assert.deepEqual(modelCatalogReferences({ origin: { ...origin, source } }), [])
  for (const revision of ['', 'main', 'latest']) assert.deepEqual(modelCatalogReferences({ origin: { ...origin, revision } }), [])
  for (const repository of ['../model', 'example/..', 'https://huggingface.co/example/model', 'example/model/extra']) assert.deepEqual(modelCatalogReferences({ origin: { ...origin, repository } }), [])
  assert.deepEqual(modelCatalogReferences({ id: 'example/model', title: 'Reasoning GGUF', metadata: { baseModels: ['example/base'] } }), [])
})

test('overflow does not silently select the first subset of competing candidates', () => {
  const baseModels = huggingFaceBaseModels({ cardData: { base_model: Array.from({ length: 100 }, (_, i) => `example/model-${i}`) } })
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { baseModels, baseModelRelation: 'quantized' } }), [])
})

test('offline GGUF template evidence enables tools and the supported thinking toggle without an online identity', () => {
  const capabilities = ggufModelMetadata({ 'general.architecture': 'test', 'test.context_length': 262144, 'tokenizer.chat_template': template })
  assert.deepEqual(capabilities, { contextWindow: 262144, toolCall: true, reasoningOptions: ['off', 'medium'] })
  const binding = modelToolBinding({ runtime: 'chat', origin: { source: 'local' }, metadata: { capabilities } }, true, true, true)
  assert.deepEqual(binding, { tools: true, reasoning: true, catalogModels: [], metadata: capabilities })
})

test('absent template evidence is unknown, not an explicit negative or a claim from architecture or prose', () => {
  for (const value of [undefined, '', 'tools tool_calls enable_thinking <think>', `{# ${template} #}`, `{{ 'tools tool_calls enable_thinking <think>' }}`, '{{ messages }}']) assert.deepEqual(templateModelMetadata(value), {})
  assert.deepEqual(ggufModelMetadata({ 'general.architecture': 'lfm3', 'general.name': 'Tool Reasoning' }), {})
  assert.deepEqual(templateModelMetadata('a'.repeat(256 * 1024 + 1) + template), {})
  assert.deepEqual(templateModelMetadata(`{% if tools %}{{ tools }}{% endif %}`), {})
  assert.deepEqual(templateModelMetadata(`{{ message.tool_calls }}`), {})
})

test('a template that explicitly rejects tool inputs is not promoted by its condition variables', () => {
  const rejected = `{% if tools %}{{ raise_exception('Tools are not supported') }}{% endif %}{% for message in messages %}{% if message.tool_calls %}{{ raise_exception('Tool calls are not supported') }}{% endif %}{{ message.content }}{% endfor %}`
  assert.deepEqual(templateModelMetadata(rejected), {})
  assert.deepEqual(serverModelMetadata({ chat_template: rejected }, {}), {})
  const rejectedDefinitions = `{% if tools %}{{ raise_exception('Tools are not supported') }}{% endif %}{% for message in messages %}{{ message.tool_calls | tojson }}{{ message.content }}{% endfor %}`
  assert.deepEqual(templateModelMetadata(rejectedDefinitions), {})
  assert.deepEqual(serverModelMetadata({ chat_template: rejectedDefinitions }, {}), {})
})

test('dictionary tool access and thinking conditions are recognized without executing the template', () => {
  assert.deepEqual(templateModelMetadata(`{% if tools %}{{ tools }}{% endif %}{{ message['tool_calls'] }}`), { toolCall: true })
  assert.deepEqual(templateModelMetadata(`{% if tools %}{{ tools }}{% endif %}{{ message.get('tool_calls') }}`), { toolCall: true })
  assert.deepEqual(templateModelMetadata(`{% if add_generation_prompt and enable_thinking %}{{ '<think>' }}{% endif %}`), { reasoningOptions: ['off', 'medium'] })
})

test('bounded template aliases connect actual tool-definition and tool-call outputs', () => {
  const value = `{% for tool in tools %}{% set fn = tool.function %}{% set ns.definitions = ns.definitions + [fn] %}{% endfor %}{{ ns.definitions | tojson }}{% for call in message.tool_calls %}{{ call.function.name }}{% endfor %}`
  assert.deepEqual(templateModelMetadata(value), { toolCall: true })
})

test('structured declarations retain false and empty options, drop invalid fields and never coerce strings', () => {
  assert.deepEqual(declaredModelMetadata({ toolCall: false, reasoningOptions: [], contextWindow: 8192, input: ['text'], maxTokens: 1024, unknown: true }), { toolCall: false, reasoningOptions: [], input: ['text'], contextWindow: 8192, maxTokens: 1024 })
  assert.deepEqual(declaredModelMetadata({ toolCall: 'true', reasoningOptions: ['high', null], input: ['text', 'unknown'], contextWindow: -1, maxTokens: Infinity }), {})
  assert.deepEqual(declaredModelMetadata(null), {})
})

test('explicit source capability declarations do not need a second public catalogue endorsement', () => {
  const metadata = { toolCall: false, reasoningOptions: ['off'], contextWindow: 16384 }
  const result = modelToolBinding({ origin, runtime: 'chat', metadata: { capabilities: metadata } }, true, true, true)
  assert.deepEqual(result, { tools: false, reasoning: false, catalogModels: [ref(origin.repository)], metadata })
})

test('old hosts receive supported legacy boolean declarations but not the new metadata field', () => {
  const model = { runtime: 'chat', metadata: { capabilities: { toolCall: true, reasoningOptions: ['off', 'medium'] } } }
  assert.deepEqual(modelToolBinding(model, false, false), { tools: true })
  assert.deepEqual(modelToolBinding(model, true, true), { tools: true, reasoning: true, catalogModels: [] })
  assert.deepEqual(modelToolBinding({ runtime: 'chat' }, false), { tools: false })
  assert.deepEqual(modelToolBinding({ origin, runtime: 'chat' }, true, true), { tools: 'auto', reasoning: 'auto', catalogModels: [ref(origin.repository)] })
})

test('legacy catalogue intersection hosts retain their original base-only references', () => {
  const model = { origin, runtime: 'chat', metadata: { tags: ['base_model:quantized:example/base'] } }
  assert.deepEqual(modelToolBinding(model, true, true, false).catalogModels, [ref('example/base')])
  assert.deepEqual(modelToolBinding(model, true, true, true).catalogModels, [ref(origin.repository), ref('example/base')])
})

test('display names and tags never become capabilities and unsupported transports are filtered', () => {
  assert.deepEqual(modelToolBinding({ title: 'Reasoning model', reasoning: true, metadata: { reasoning: true, tags: ['reasoning', 'tools'] } }, true, true, true), { tools: 'auto', reasoning: 'auto', catalogModels: [] })
  const metadata = { capabilities: { input: ['text', 'image', 'video', 'audio', 'pdf'] } }
  assert.deepEqual(modelToolBinding({ runtime: 'chat', metadata }, true, true, true).metadata.input, ['text'])
  assert.deepEqual(modelToolBinding({ runtime: 'vision', metadata }, true, true, true).metadata.input, ['text', 'image'])
})

test('llama props capabilities override offline hints while actual context and modalities stay constrained', () => {
  const props = { chat_template: template, chat_template_caps: { supports_tools: true, supports_tool_calls: false }, default_generation_settings: { n_ctx: 65536 }, modalities: { vision: true, audio: true, video: true } }
  assert.deepEqual(serverModelMetadata(props, { chatReasoning: true }), { toolCall: false, reasoningOptions: ['off', 'medium'], contextWindow: 65536, input: ['text'] })
  assert.deepEqual(serverModelMetadata({ ...props, chat_template_caps: { supports_tools: true, supports_tool_calls: true } }, { backend: 'vision', chatReasoning: false }), { toolCall: true, contextWindow: 65536, input: ['text', 'image'] })
})

test('partial or missing props never manufacture a negative or confuse history support with a thinking switch', () => {
  assert.deepEqual(serverModelMetadata(undefined, {}), {})
  assert.deepEqual(serverModelMetadata({ chat_template_caps: { supports_tools: true, supports_preserve_reasoning: true, supports_reasoning_effort: true } }, { chatReasoning: true }), {})
  assert.deepEqual(serverModelMetadata({ chat_template_caps: { supports_tools: false } }, {}), { toolCall: false })
  assert.deepEqual(serverModelMetadata({ chat_template: '{{ messages }}', modalities: { vision: false } }, { backend: 'vision', chatReasoning: true }), { input: ['text'] })
})
