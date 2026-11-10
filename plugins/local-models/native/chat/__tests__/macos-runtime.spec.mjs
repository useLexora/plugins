import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchConfiguration } from '../chat.mjs'
import { createTransport } from '../transport.mjs'
import { launchConfiguration as imageLaunch } from '../../image/image.mjs'

const at = (...parts) => join(tmpdir(), 'runtime fixture 空格', ...parts)
const input = { resources: { engine: at('engine'), model: at('model') }, configuration: { backend: 'vision', acceleration: 'cpu', contextWindow: 4096, threads: 4, files: { model: 'model.gguf', projector: 'projector.gguf' } } }

for (const acceleration of ['cpu', 'gpu']) test(`macOS ${acceleration} launch keeps the shared model/projector and dylib directory`, () => {
  const transport = createTransport('/very-long-tmp/'.repeat(20) + 'model.sock', 'darwin')
  const launch = launchConfiguration({ ...input, configuration: { ...input.configuration, acceleration } }, transport, 'darwin')
  assert.equal(launch.executable, join(input.resources.engine, 'llama-server'))
  assert.equal(launch.options.cwd, input.resources.engine)
  assert.deepEqual(transport.args, ['--host', '127.0.0.1', '--port', '0'])
  if (acceleration === 'cpu') assert.equal(launch.args[launch.args.indexOf('-ngl') + 1], '0')
  else assert.equal(launch.args.includes('-ngl'), false)
  assert.equal(launch.args.includes('--no-mmproj-offload'), acceleration === 'cpu')
  if (acceleration === 'cpu') assert.equal(launch.args[launch.args.indexOf('--device') + 1], 'none')
  assert.equal(launch.args[launch.args.indexOf('--mmproj') + 1], join(input.resources.model, 'projector.gguf'))
  assert.match(launch.options.env.LLAMA_API_KEY, /^[a-f0-9]{64}$/)
  assert.ok(!launch.args.includes(launch.options.env.LLAMA_API_KEY))
  assert.notEqual(createTransport('', 'darwin').environment.LLAMA_API_KEY, transport.environment.LLAMA_API_KEY)
})

test('macOS overrides inherited server settings and resolves separately authorized weights', t => {
  const prior = process.env.LLAMA_ARG_HOST
  process.env.LLAMA_ARG_HOST = '0.0.0.0'
  t.after(() => { if (prior === undefined) delete process.env.LLAMA_ARG_HOST; else process.env.LLAMA_ARG_HOST = prior })
  const mapped = { ...input, resourceFiles: { model: { 'model.gguf': at('original', 'weights.gguf'), 'projector.gguf': at('other', 'mmproj.gguf') } } }
  const launch = launchConfiguration(mapped, createTransport('', 'darwin'), 'darwin')
  assert.equal(launch.options.env.LLAMA_ARG_HOST, undefined)
  assert.equal(launch.args[launch.args.indexOf('-m') + 1], at('original', 'weights.gguf'))
  assert.equal(launch.args[launch.args.indexOf('--mmproj') + 1], at('other', 'mmproj.gguf'))
})

for (const backend of ['cpu', 'metal']) test(`macOS image ${backend} launch uses colocated dylibs, checkpoint roles and supported attention flags`, () => {
  const model = { ...input, configuration: { imageArchitecture: 'checkpoint', imageValidation: { version: 1, kind: 'ldm-header', architecture: 'sd1', sha256: 'a'.repeat(64) }, files: { model: 'checkpoint.safetensors' }, backend, vramGiB: 8, steps: 15, seed: -1 }, resourceFiles: { model: { 'checkpoint.safetensors': at('original', 'model.safetensors') } } }
  const request = { operation: 'generate', images: [], output: { size: '768x768' }, prompt: 'fixture' }
  const launch = imageLaunch(model, request, at('output.png'), 'darwin')
  assert.equal(launch.executable, at('engine', 'sd-cli'))
  assert.equal(launch.options.cwd, input.resources.engine)
  assert.equal(launch.args[launch.args.indexOf('-m') + 1], at('original', 'model.safetensors'))
  assert.equal(launch.args[launch.args.indexOf('--backend') + 1], backend)
  assert.equal(launch.args[launch.args.indexOf('--flash-attn') + 1], 'auto')
  assert.equal(launch.args[launch.args.indexOf('-W') + 1], '768')
})
