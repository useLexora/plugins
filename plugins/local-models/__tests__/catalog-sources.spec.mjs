import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiscovery } from '../discovery.js'

function fixture() {
  const requests = []
  const discovery = createDiscovery({
    signal: new AbortController().signal,
    network: {
      get: async url => { requests.push(url); return { status: 200, text: '[]', headers: {} } },
    },
  })
  return { discovery, requests }
}

test('each catalog request uses only its actual pipeline without injecting engine keywords', async () => {
  for (const [kind, pipeline] of [['chat', 'text-generation'], ['vision', 'image-text-to-text'], ['asr', 'automatic-speech-recognition'], ['tts', 'text-to-speech'], ['image', 'text-to-image'], ['all', null]]) {
    for (const query of ['', 'Qwen']) {
      const { discovery, requests } = fixture()
      await discovery.search({ kind, query })
      assert.equal(requests.length, 1)
      const url = new URL(requests[0])
      assert.equal(url.origin, 'https://huggingface.co')
      const params = url.searchParams
      assert.equal(params.get('pipeline_tag'), pipeline)
      assert.equal(params.get('filter'), null)
      assert.equal(params.get('search'), query || null)
      assert.equal(params.get('limit'), '24')
    }
  }
})

test('unsupported sources, uses and sorts are rejected before issuing requests', async () => {
  const { discovery, requests } = fixture()
  for (const source of ['sherpa', 'tesseract', 'github']) {
    await assert.rejects(discovery.search({ source }), /仅支持 Hugging Face/)
    await assert.rejects(discovery.inspect({ source, recipe: 'tts', repository: 'k2-fsa/sherpa-onnx' }), /Hugging Face/)
  }
  await assert.rejects(discovery.search({ kind: 'ocr' }), /支持的模型用途/)
  await assert.rejects(discovery.search({ sort: 'name' }), /不支持此排序/)
  assert.deepEqual(requests, [])
})

test('discovery accepts only canonical Hugging Face repository links', async () => {
  const { discovery, requests } = fixture()
  for (const query of ['https://github.com/example/arbitrary', 'https://huggingface.co.evil.test/example/model', 'https://user:password@huggingface.co/example/model', 'https://huggingface.co/example/model?token=123'])
    await assert.rejects(discovery.search({ query }), /只接受 Hugging Face/)
  assert.deepEqual(requests, [])
})
