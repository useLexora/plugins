import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { test } from 'node:test'
import { createTransport } from '../transport.mjs'
import { launchConfiguration } from '../chat.mjs'
import { resourceDirectory, resourceFile } from '../../resources.mjs'

const at = (...parts) => join(tmpdir(), 'runtime fixture 空格', ...parts)
const input = { resources: { engine: at('engine'), model: at('model') }, configuration: { backend: 'vision', acceleration: 'cpu', contextWindow: 4096, threads: 4, files: { model: 'model.gguf', projector: 'projector.gguf' } } }

test('Windows CPU launch uses exe, private loopback, ephemeral binding and no GPU projector offload', () => {
  const transport = createTransport('/unused.sock', 'win32')
  const launch = launchConfiguration(input, transport, 'win32')
  assert.equal(launch.executable, join(input.resources.engine, 'llama-server.exe'))
  assert.deepEqual(transport.args, ['--host', '127.0.0.1', '--port', '0'])
  assert.equal(launch.args[launch.args.indexOf('-ngl') + 1], '0')
  assert.equal(launch.args[launch.args.indexOf('--device') + 1], 'none')
  assert.ok(launch.args.includes('--no-mmproj-offload'))
  assert.equal(launch.args[launch.args.indexOf('--mmproj') + 1], join(input.resources.model, 'projector.gguf'))
  assert.equal(launch.options.cwd, input.resources.engine)
  assert.equal(launch.options.windowsHide, true)
  assert.match(launch.options.env.LLAMA_API_KEY, /^[a-f0-9]{64}$/)
  assert.ok(!launch.args.includes(launch.options.env.LLAMA_API_KEY))
  assert.notEqual(createTransport('', 'win32').environment.LLAMA_API_KEY, transport.environment.LLAMA_API_KEY)
})

// Both supervised platforms share the loopback protocol; keep one HTTP harness.
for (const platform of ['win32', 'darwin']) test(`${platform} transport accepts only explicit loopback listener announcements and authenticates actual requests`, async t => {
  const transport = createTransport('/unusable-socket', platform)
  const requests = []
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization })
    if (req.headers.authorization !== `Bearer ${transport.environment.LLAMA_API_KEY}`) { res.writeHead(401).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.end(req.url === '/health' ? 'ready' : Buffer.concat(chunks))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  for (const bad of ['listening on http://0.0.0.0:8000\n', 'listening on http://localhost:8000\n', 'listening on http://127.0.0.1:70000\n']) transport.observe(bad)
  await assert.rejects(transport.request('/health'), /STARTING/)
  transport.observe('srv    main: listening on http://127.0.0.1:')
  transport.observe(`${server.address().port}\n`)
  const health = await transport.request('/health')
  assert.equal(health.status, 200)
  health.body.resume()
  const payload = Buffer.from('{"messages":[]}')
  const result = await transport.request('/v1/chat/completions', payload)
  const chunks = []
  for await (const chunk of result.body) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), payload)
  assert.deepEqual(requests.map(item => item.url), ['/health', '/v1/chat/completions'])
  assert.ok(requests.every(item => item.authorization === `Bearer ${transport.environment.LLAMA_API_KEY}` && item.host.startsWith('127.0.0.1:')))
  await assert.rejects(transport.request('/health', undefined, AbortSignal.abort()))
})

test('Linux keeps Unix socket transport and does not require Windows authentication environment', () => {
  const transport = createTransport('/fixture/model.sock', 'linux')
  assert.deepEqual(transport.args, ['--host', '/fixture/model.sock'])
  assert.deepEqual(transport.environment, {})
  const launch = launchConfiguration({ ...input, configuration: { backend: 'chat' } }, transport, 'linux')
  assert.equal(launch.executable, join(input.resources.engine, 'llama-server'))
  assert.equal(launch.args[launch.args.indexOf('-m') + 1], join(input.resources.model, 'model.gguf'))
  assert.equal(launch.args.includes('--mmproj'), false)
})

test('reference mapping resolves original model and projector files without copying or assuming mount roots', () => {
  const mapped = { ...input, resourceFiles: { model: { 'model.gguf': at('external', 'weights', 'original.gguf'), 'projector.gguf': at('other', 'vision', 'mmproj.gguf') } } }
  const launch = launchConfiguration(mapped, createTransport('', 'win32'), 'win32')
  assert.equal(launch.args[launch.args.indexOf('-m') + 1], at('external', 'weights', 'original.gguf'))
  assert.equal(launch.args[launch.args.indexOf('--mmproj') + 1], at('other', 'vision', 'mmproj.gguf'))
  assert.throws(() => resourceDirectory(mapped, 'model'), /RESOURCE_LAYOUT_INVALID/)
  assert.equal(resourceFile(input, 'model', 'model.gguf'), join(input.resources.model, 'model.gguf'))
})

test('phoneme and engine directory resolution verifies complete relative layout and rejects scattered inputs', () => {
  const mapped = { resources: { model: at('empty'), engine: at('empty-engine') }, resourceFiles: { model: { 'model.onnx': at('weights', 'a.onnx'), 'espeak-ng-data/phontab': at('original', 'phonemes', 'phontab'), 'espeak-ng-data/lang/cmn': at('original', 'phonemes', 'lang', 'cmn') }, engine: { 'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node': at('original', 'engine', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'), 'node_modules/sherpa-onnx-node/addon.js': at('original', 'engine', 'node_modules', 'sherpa-onnx-node', 'addon.js') } } }
  assert.equal(resourceDirectory(mapped, 'model', 'espeak-ng-data'), at('original', 'phonemes'))
  assert.equal(resourceDirectory(mapped, 'engine'), at('original', 'engine'))
  mapped.resourceFiles.model['espeak-ng-data/lang/cmn'] = at('elsewhere', 'cmn')
  assert.throws(() => resourceDirectory(mapped, 'model', 'espeak-ng-data'), /RESOURCE_LAYOUT_INVALID/)
})
