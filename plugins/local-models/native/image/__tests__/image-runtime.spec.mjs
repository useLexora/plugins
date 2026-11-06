import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initialize, launchConfiguration } from '../image.mjs'
import { zImageTurboFiles } from '../recipes.mjs'

const request = { requestId: 'image-fixture', operation: 'generate', images: [], prompt: 'success', output: { size: '512x512' } }
const input = { resources: { engine: '/fixture/engine', model: '/fixture/model' }, configuration: { imageArchitecture: 'z-image-turbo', files: Object.fromEntries(zImageTurboFiles.map(file => [file.role, file.path])), backend: 'CUDA0', vramGiB: 10, seed: -1 } }
const flag = (launch, key) => launch.args[launch.args.indexOf(key) + 1]

test('Z-Image uses three explicit component roles and Turbo parameters, not a full checkpoint or Qwen-Image vision stack', () => {
  const mapped = { ...input, resourceFiles: { model: Object.fromEntries(zImageTurboFiles.map(file => [file.path, `/external/${file.role}/renamed weights`])) } }
  const launch = launchConfiguration(mapped, request, '/output.png')
  assert.equal(flag(launch, '--diffusion-model'), '/external/diffusion/renamed weights')
  assert.equal(flag(launch, '--llm'), '/external/llm/renamed weights')
  assert.equal(flag(launch, '--vae'), '/external/vae/renamed weights')
  assert.equal(flag(launch, '--steps'), '8')
  assert.equal(flag(launch, '--cfg-scale'), '1')
  assert.equal(flag(launch, '--sampling-method'), 'euler')
  assert.ok(launch.args.includes('--offload-to-cpu'))
  assert.ok(!launch.args.includes('-m') && !launch.args.includes('--llm_vision'))
  assert.equal(flag(launchConfiguration({ ...input, configuration: { ...input.configuration, steps: 6 } }, request, '/out.png'), '--steps'), '6')
  for (const changed of [{ operation: 'edit' }, { images: [{ data: '' }] }]) assert.throws(() => launchConfiguration(input, { ...request, ...changed }, '/out.png'), /UNSUPPORTED/)
  assert.throws(() => launchConfiguration({ ...input, configuration: { ...input.configuration, files: { diffusion: 'alone.gguf' } } }, request, '/out.png'), /UNSUPPORTED/)
})

test('a checkpoint needs structure-validation evidence; existing platform launch environment remains unchanged', () => {
  const checkpoint = { ...input, configuration: { ...input.configuration, imageArchitecture: 'checkpoint', files: { model: 'complete.safetensors' }, imageValidation: { version: 1, kind: 'ldm-header', architecture: 'sdxl', sha256: 'a'.repeat(64) } } }
  for (const [platform, flash] of [['linux', 'on'], ['win32', 'off,diffusion=on'], ['darwin', 'auto']]) {
    const launch = launchConfiguration(checkpoint, request, '/out.png', platform)
    assert.equal(flag(launch, '-m'), '/fixture/model/complete.safetensors')
    assert.equal(flag(launch, '--flash-attn'), flash)
    assert.equal(flag(launch, '--cfg-scale'), '6')
    assert.equal(launch.executable, `/fixture/engine/${platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'}`)
    assert.equal(launch.options.cwd, '/fixture/engine')
  }
  assert.throws(() => launchConfiguration({ ...checkpoint, configuration: { ...checkpoint.configuration, imageValidation: undefined } }, request, '/out.png'), /UNSUPPORTED/)
})

async function fixture(t, scenario, { signal, emit } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'image-runtime-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'sd-cli'), invocations = join(directory, 'invocations')
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');fs.appendFileSync(path.join(__dirname,'invocations'),'1\\n');const value=k=>process.argv[process.argv.indexOf(k)+1];const mode=value('-p');if(mode==='cancel')setTimeout(()=>{},30000);else if(mode==='unsupported'){console.log('unsupported model architecture');process.exitCode=1}else if(mode==='oom'){console.error('CUDA_ERROR_OUT_OF_MEMORY');process.exitCode=1}else if(mode==='crash')process.kill(process.pid,'SIGKILL');else if(mode==='empty'){}else if(mode==='failed')process.exitCode=2;else{fs.writeFileSync(value('-o'),Buffer.from('fixture image'));if(mode==='partial')process.exitCode=1;else if(mode==='crash-after-output')process.kill(process.pid,'SIGKILL')}\n`)
  await chmod(executable, 0o755)
  const events = [], frames = [], controller = new AbortController()
  const runtime = await initialize({ ...input, resources: { ...input.resources, engine: directory } })
  const stream = runtime.start('image', {}, { signal: signal ?? controller.signal, emit: (event, bytes) => { events.push(event); if (bytes) frames.push(Buffer.from(bytes)); return emit?.(event) ?? true } })
  stream.write(Buffer.from(JSON.stringify({ ...request, prompt: scenario })))
  return { events, frames, stream, controller, directory, invocations: async () => (await readFile(invocations, 'utf8')).trim().split('\n').length }
}

for (const [scenario, code] of [['unsupported', 'UNSUPPORTED'], ['oom', 'RESOURCE_EXHAUSTED']]) test(`known terminal ${scenario} without output emits explicit ${code} exactly once`, async t => {
  const f = await fixture(t, scenario)
  await f.stream.finish()
  assert.deepEqual(f.events, [{ type: 'submitted', requestId: request.requestId }, { type: 'failed', code, retryable: false }])
  assert.equal(await f.invocations(), 1)
  assert.deepEqual(f.frames, [])
})

for (const scenario of ['failed', 'empty', 'crash', 'partial', 'crash-after-output']) test(`incomplete ${scenario} preserves an unknown result without emitting failed or retrying`, async t => {
  const f = await fixture(t, scenario)
  await assert.rejects(f.stream.finish(), /BACKEND_FAILED/)
  assert.deepEqual(f.events, [{ type: 'submitted', requestId: request.requestId }])
  assert.equal(await f.invocations(), 1)
  assert.deepEqual(f.frames, [])
})

test('spawn failure before an engine starts remains an explicit non-retryable failure', async t => {
  const missing = await fixture(t, 'success')
  await rm(join(missing.directory, 'sd-cli'))
  await missing.stream.finish()
  assert.deepEqual(missing.events, [{ type: 'submitted', requestId: request.requestId }, { type: 'failed', code: 'FAILED', retryable: false }])
})

test('cancellation and failed terminal delivery remain unresolved rather than being relabelled as engine failure', async t => {
  const controller = new AbortController()
  const cancelled = await fixture(t, 'cancel', { signal: controller.signal, emit: event => { if (event.type === 'submitted') setImmediate(() => controller.abort(new Error('cancel fixture'))); return true } })
  await assert.rejects(cancelled.stream.finish(), /cancel fixture/)
  assert.deepEqual(cancelled.events.map(event => event.type), ['submitted'])
  const blocked = await fixture(t, 'oom', { emit: event => event.type !== 'failed' })
  await assert.rejects(blocked.stream.finish(), /CHANNEL_FULL/)
  assert.equal(await blocked.invocations(), 1)
})

test('incomplete checkpoint configuration fails before submission without spawning an engine', async () => {
  const runtime = await initialize({ ...input, configuration: { ...input.configuration, imageArchitecture: 'checkpoint', files: { model: 'old.safetensors' } } })
  const events = []
  const stream = runtime.start('image', {}, { signal: new AbortController().signal, emit: event => { events.push(event); return true } })
  stream.write(Buffer.from(JSON.stringify(request)))
  await stream.finish()
  assert.deepEqual(events, [{ type: 'failed', code: 'UNSUPPORTED', retryable: false }])
})

test('successful image bytes still stream once and finish with the original request identity', async t => {
  const f = await fixture(t, 'success')
  await f.stream.finish()
  assert.deepEqual(f.events.map(event => event.type), ['submitted', 'image', 'done'])
  assert.equal(Buffer.concat(f.frames).toString(), 'fixture image')
  assert.deepEqual(f.events.at(-1), { type: 'done', responseId: request.requestId })
  assert.equal(await f.invocations(), 1)
})
