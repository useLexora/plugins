import assert from 'node:assert/strict'
import test from 'node:test'
import { huggingFaceBaseModels, modelCatalogReferences, modelToolBinding } from '../modelToolSupport.js'

const origin = { source: 'huggingface', repository: 'unsloth/Qwen3.5-9B-GGUF', revision: '1'.repeat(40) }
const ref = modelId => ({ providerId: 'huggingface', modelId })

test('card declarations and saved quantization tags preserve exact base identities', () => {
  assert.deepEqual(huggingFaceBaseModels({ cardData: { base_model: ['Qwen/Qwen3.5-9B', 'Qwen/Qwen3.5-9B-Base'] }, tags: ['base_model:Qwen/Qwen3.5-9B', 'base_model:quantized:Qwen/Qwen3.5-9B', 'gguf', null] }), ['Qwen/Qwen3.5-9B', 'Qwen/Qwen3.5-9B-Base'])
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { tags: ['base_model:quantized:Qwen/Qwen3.5-9B'] } }), [ref('Qwen/Qwen3.5-9B')])
})

test('all explicit sources are retained so the host can reject unknown or conflicting evidence', () => {
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { baseModels: ['Qwen/Qwen3.5-9B'], tags: ['base_model:Qwen/Qwen3.5-9B-Base', 'base_model:unknown/model'] } }), ['Qwen/Qwen3.5-9B', 'Qwen/Qwen3.5-9B-Base', 'unknown/model'].map(ref))
})

test('repository fallback is exact and never strips GGUF or guesses from display names', () => {
  assert.deepEqual(modelCatalogReferences({ origin, title: 'Qwen/Qwen3.5-9B' }), [ref(origin.repository)])
  assert.deepEqual(modelCatalogReferences({ title: 'Qwen/Qwen3.5-9B-GGUF', id: 'Qwen/Qwen3.5-9B', metadata: { baseModels: ['Qwen/Qwen3.5-9B'] } }), [])
})

for (const source of ['local', 'github']) test(`${source} metadata cannot impersonate pinned Hugging Face evidence`, () => {
  assert.deepEqual(modelCatalogReferences({ origin: { ...origin, source }, metadata: { tags: ['base_model:Qwen/Qwen3.5-9B'] } }), [])
})

test('unfixed revisions and malformed repository IDs never become source references', () => {
  for (const revision of ['', 'main', 'latest']) assert.deepEqual(modelCatalogReferences({ origin: { ...origin, revision } }), [])
  for (const repository of ['../model', 'example/..', 'https://huggingface.co/example/model', 'example/model/extra']) assert.deepEqual(modelCatalogReferences({ origin: { ...origin, repository } }), [])
})

test('too many base models remain unsupported rather than trusting the first eight', () => {
  const baseModels = huggingFaceBaseModels({ cardData: { base_model: Array.from({ length: 100 }, (_, index) => `example/model-${index}`) } })
  assert.deepEqual(modelCatalogReferences({ origin, metadata: { baseModels } }), [])
})

for (const automatic of [false, true]) test(`reasoning auto shares exact catalog sources with tool matching ${automatic}`, () => {
  const model = { origin, runtime: 'vision', metadata: { baseModels: ['Qwen/Qwen3.5-9B'], tags: ['base_model:unknown/model'] } }
  assert.deepEqual(modelToolBinding(model, automatic, true), { tools: automatic ? 'auto' : false, reasoning: 'auto', catalogModels: [ref('Qwen/Qwen3.5-9B'), ref('unknown/model')] })
})

test('display names and untrusted reasoning metadata cannot invent reasoning support or provenance', () => {
  for (const source of [undefined, { ...origin, source: 'local' }, { ...origin, revision: 'main' }]) {
    const model = { id: 'Qwen/Qwen3.5-9B', title: 'Reasoning model', runtime: 'chat', origin: source, reasoning: true, metadata: { reasoning: true, baseModels: ['Qwen/Qwen3.5-9B'], tags: ['reasoning'] } }
    assert.deepEqual(modelToolBinding(model, true, true), { tools: 'auto', reasoning: 'auto', catalogModels: [] })
    assert.deepEqual(modelToolBinding(model, false, false), { tools: false })
  }
})

test('new hosts resolve auto while old hosts never receive an unsupported auto value', () => {
  const model = { origin, runtime: 'vision', metadata: { baseModels: ['Qwen/Qwen3.5-9B'] } }
  assert.deepEqual(modelToolBinding(model, true), { tools: 'auto', catalogModels: [ref('Qwen/Qwen3.5-9B')] })
  assert.deepEqual(modelToolBinding({ runtime: 'chat' }, true), { tools: 'auto', catalogModels: [] })
  assert.deepEqual(modelToolBinding(model, false), { tools: false })
})
