import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogTags, choiceBytes, initialSelection, quantization } from '../catalogPresentation.js'

test('model identity tags always contain a task and preserve known metadata after adding locally', () => {
  const metadata = { tags: ['gguf', 'license:apache-2.0', 'en', 'zh', 'region:us'], libraryName: 'gguf' }
  assert.deepEqual(catalogTags({ recipe: 'chat', ...metadata }), ['对话', 'GGUF', 'apache-2.0', 'en', 'zh'])
  assert.deepEqual(catalogTags({ runtime: 'vision', metadata }), ['对话＋图片', 'GGUF', 'apache-2.0', 'en', 'zh'])
  assert.deepEqual(catalogTags({ recipe: 'asr' }), ['语音转写'])
})

test('a sharded choice shows the size of its whole download, not just its first file', () => {
  const first = { path: 'model-00001-of-00002.gguf', bytes: 1024 }
  const second = { path: 'model-00002-of-00002.gguf', bytes: 512 }
  assert.equal(choiceBytes({ ...first, parts: [first, second] }), 1536)
  assert.equal(choiceBytes({ ...first, parts: [first, { ...second, bytes: null }] }), null)
  assert.equal(choiceBytes({ path: 'model.gguf', bytes: 0 }), 0)
})

test('file precision is extracted from file names, never invented for arbitrary files', () => {
  assert.equal(quantization('weights/model-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(quantization('model.IQ3_XXS.gguf'), 'IQ3_XXS')
  assert.equal(quantization('model-F16.gguf'), 'F16')
  assert.equal(quantization('encoder.int8.onnx'), 'INT8')
  assert.equal(quantization('tokens.txt'), '')
  assert.equal(quantization('Qwen3-8B.gguf'), '')
})

test('initial file selection covers required roles without opting into optional files', () => {
  assert.deepEqual(initialSelection([
    { id: 'model', choices: [{ path: 'model-Q8_0.gguf' }, { path: 'model-Q4_K_M.gguf' }] },
    { id: 'projector', choices: [{ path: 'mmproj-F16.gguf' }] },
    { id: 'lexicon', optional: true, choices: [{ path: 'lexicon.txt' }] },
    { id: 'missing', choices: [] },
  ]), { model: 'model-Q4_K_M.gguf', projector: 'mmproj-F16.gguf', lexicon: '', missing: '' })
})
