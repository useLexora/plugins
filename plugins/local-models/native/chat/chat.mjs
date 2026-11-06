import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { initialize as initializeProtocol } from './remote.mjs'
import { createTransport } from './transport.mjs'
import { engineEnvironment, resourceDirectory, resourceFile } from '../resources.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = value => process.stderr.write(JSON.stringify({ ...value, at: Date.now() }) + '\n')

export function launchConfiguration(input, transport, platform = process.platform) {
  const { configuration } = input
  const model = role => resourceFile(input, 'model', role)
  const args = ['-m', model(configuration.files?.model ?? (configuration.backend === 'vision' ? 'Qwen3VL-8B-Instruct-Q4_K_M.gguf' : 'model.gguf')), ...transport.args, '--alias', 'local', '-c', String(configuration.contextWindow), '-t', String(configuration.threads), '-ngl', configuration.acceleration === 'cpu' ? '0' : 'all', '-fa', 'on', '--fit', 'off', '--parallel', '1', '--jinja', '--no-context-shift', '--cache-ram', '0', '--no-webui']
  if (configuration.acceleration === 'cpu') args.push('--device', 'none')
  if (configuration.backend === 'vision') {
    args.push('--mmproj', model(configuration.files?.projector ?? 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'))
    if (configuration.acceleration === 'cpu') args.push('--no-mmproj-offload')
  }
  const directory = resourceDirectory(input, 'engine')
  const env = engineEnvironment(directory, platform)
  if (platform === 'win32' || platform === 'darwin') for (const key of Object.keys(env)) if (/^(?:LLAMA_|AIP_)/i.test(key)) delete env[key]
  return { executable: resourceFile(input, 'engine', platform === 'win32' ? 'llama-server.exe' : 'llama-server'), args, options: { cwd: directory, env: { ...env, ...transport.environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } }
}

export async function initialize(input) {
  const { configuration } = input
  const directory = await mkdtemp(join(tmpdir(), 'chat-'))
  const socketPath = join(directory, 'model.sock')
  let server, stopping, disposed = false
  async function stop(force = false) {
    const current = server
    if (!current) return
    if (stopping) return stopping
    stopping = (async () => {
      current.child.kill(force ? 'SIGKILL' : 'SIGTERM')
      const timer = setTimeout(() => current.child.kill('SIGKILL'), 3000)
      try { await current.closed } finally { clearTimeout(timer); if (server === current) server = undefined; await rm(socketPath, { force: true }) }
    })()
    try { await stopping } finally { stopping = undefined }
  }
  async function ready(signal) {
    if (disposed) throw Error('EXTENSION_INFERENCE_PROCESS_EXITED')
    signal?.throwIfAborted()
    if (stopping) await stopping
    if (server && !server.exited) return
    const started = Date.now()
    await rm(socketPath, { force: true })
    const transport = createTransport(socketPath)
    const launch = launchConfiguration(input, transport)
    const child = spawn(launch.executable, launch.args, launch.options)
    const current = { child, transport, exited: false, closed: undefined, errors: '' }
    current.closed = new Promise((resolve, reject) => {
      child.once('error', error => { current.exited = true; reject(error) })
      child.once('close', (code, signal) => { current.exited = true; record({ event: 'chat.gpu.exit', pid: child.pid, code, signal }); resolve() })
    })
    void current.closed.catch(() => {})
    server = current
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', bytes => { current.errors = (current.errors + bytes).slice(-16000); transport.observe(bytes) })
      stream.pipe(process.stderr, { end: false })
    }
    record({ event: 'chat.gpu.start', pid: child.pid, configuration })
    try {
      const deadline = Date.now() + 110000
      for (;;) {
        signal?.throwIfAborted()
        if (current.exited) throw Error(/bad_alloc|Cannot allocate memory|failed to allocate|out of (?:device |host )?memory|ErrorOutOf(?:Device|Host)Memory/i.test(current.errors) ? 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED' : 'EXTENSION_INFERENCE_LOAD_FAILED')
        try {
          const response = await transport.request('/health', undefined, signal)
          for await (const _ of response.body) {}
          if (response.ok) break
        } catch (error) { signal?.throwIfAborted(); if (Date.now() >= deadline) throw Error('EXTENSION_INFERENCE_LOAD_TIMEOUT') }
        if (Date.now() >= deadline) throw Error('EXTENSION_INFERENCE_LOAD_TIMEOUT')
        await pause(50)
      }
      record({ event: 'chat.gpu.ready', pid: child.pid, loadMs: Date.now() - started })
    } catch (error) { await stop(true); throw error }
  }
  try { await ready() } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  const protocol = await initializeProtocol({ configuration: { model: 'local', chatTemplateReasoning: true, chatReasoning: configuration.chatReasoning === true } })
  return {
    async dispose() { disposed = true; await stop(); await rm(directory, { recursive: true, force: true }) },
    start(capability, input, call) {
      const id = randomUUID()
      let first = true, started
      const session = protocol.start(capability, input, {
        ...call,
        network: { async post(_endpoint, body) { return server.transport.request('/v1/chat/completions', body, call.signal) } },
        emit(event) {
          if (first && (event.type === 'text' || event.type === 'tool')) { first = false; record({ event: 'chat.gpu.first', id, ms: Date.now() - started, kind: event.type }) }
          if (event.type === 'done') record({ event: 'chat.gpu.done', id, ms: Date.now() - started, reason: event.reason, usage: event.usage })
          return call.emit(event)
        },
      })
      return {
        write: bytes => session.write(bytes),
        async finish() {
          started = Date.now()
          record({ event: 'chat.gpu.invoke', id })
          const cancel = () => { void stop(true).catch(() => {}) }
          call.signal.addEventListener('abort', cancel, { once: true })
          try { await ready(call.signal); await session.finish(); call.signal.throwIfAborted() }
          finally {
            call.signal.removeEventListener('abort', cancel)
            if (call.signal.aborted) await stop(true)
            record({ event: 'chat.gpu.drain', id, cancelled: call.signal.aborted, ms: Date.now() - started })
          }
        },
      }
    },
  }
}
