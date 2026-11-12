import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { initialize as initializeProtocol } from './remote.mjs'
import { createTransport } from './transport.mjs'
import { checkEngineVersion } from './errors.mjs'
import { createEngineDiagnostics } from './diagnostics.mjs'
import { serverModelMetadata } from './model-metadata.mjs'
import { engineEnvironment, resourceDirectory, resourceFile } from '../resources.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = value => process.stderr.write(JSON.stringify({ ...value, at: Date.now() }) + '\n')

export function launchConfiguration(input, transport, platform = process.platform) {
  const { configuration } = input
  const model = role => resourceFile(input, 'model', role)
  checkEngineVersion(configuration)
  const cpu = configuration.acceleration === 'cpu' || configuration.engineBackend === 'cpu'
  const args = ['-m', model(configuration.files?.model ?? (configuration.backend === 'vision' ? 'Qwen3VL-8B-Instruct-Q4_K_M.gguf' : 'model.gguf')), ...transport.args, '--alias', 'local', '--parallel', '1', '--jinja', '--no-context-shift', '--cache-ram', '0', '--no-webui']
  if (/^b\d+$/.test(configuration.engineVersion ?? '') && Number(configuration.engineVersion.slice(1)) >= 12211) args.push('-lv', '4')
  if (configuration.contextWindow !== undefined) args.push('-c', String(configuration.contextWindow))
  if (configuration.threads !== undefined) args.push('-t', String(configuration.threads))
  if (cpu) args.push('-ngl', '0', '--device', 'none')
  if (configuration.backend === 'vision') {
    args.push('--mmproj', model(configuration.files?.projector ?? 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'))
    if (cpu) args.push('--no-mmproj-offload')
  }
  const directory = resourceDirectory(input, 'engine')
  const env = engineEnvironment(directory, platform)
  for (const key of Object.keys(env)) if (/^(?:LLAMA_|AIP_)/i.test(key)) delete env[key]
  return { executable: resourceFile(input, 'engine', platform === 'win32' ? 'llama-server.exe' : 'llama-server'), args, options: { cwd: directory, env: { ...env, ...transport.environment }, windowsHide: true, stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']) } }
}

export async function initialize(input) {
  const { configuration } = input
  checkEngineVersion(configuration)
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
    const diagnostics = createEngineDiagnostics(configuration)
    const current = { child, transport, diagnostics, exited: false, closed: undefined, exitFailure: undefined }
    current.closed = new Promise(resolve => {
      child.once('error', () => { current.exited = true })
      child.once('close', (code, signal) => {
        current.exited = true
        diagnostics.flush()
        if (signal === 'SIGILL' || code === -1073741795 || code === 3221225501) current.exitFailure = 'EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE'
        if (code === -1073741515 || code === 3221225781) current.exitFailure = 'EXTENSION_INFERENCE_BACKEND_UNAVAILABLE'
        record({ event: 'chat.gpu.exit', pid: child.pid, code, signal, ...diagnostics.snapshot(), ...(current.exitFailure ? { error: current.exitFailure } : {}) })
        resolve()
      })
    })
    server = current
    for (const [channel, stream] of Object.entries({ stdout: child.stdout, stderr: child.stderr })) {
      stream.on('data', bytes => { diagnostics.observe(bytes, channel); transport.observe(bytes) })
    }
    record({ event: 'chat.gpu.start', pid: child.pid, ...diagnostics.snapshot() })
    try {
      const deadline = Date.now() + 110000
      for (;;) {
        signal?.throwIfAborted()
        if (current.exited) { await current.closed; throw Error(diagnostics.failure(current.exitFailure)) }
        try {
          const response = await transport.request('/health', undefined, signal)
          for await (const _ of response.body) {}
          if (response.ok) break
        } catch (error) { signal?.throwIfAborted(); if (Date.now() >= deadline) throw Error('EXTENSION_INFERENCE_LOAD_TIMEOUT') }
        if (Date.now() >= deadline) throw Error('EXTENSION_INFERENCE_LOAD_TIMEOUT')
        await pause(50)
      }
      let modelMetadata
      try {
        const metadataSignal = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])])
        const response = await transport.request('/props', undefined, metadataSignal)
        if (response.ok) {
          const chunks = []
          let size = 0
          for await (const chunk of response.body) {
            size += chunk.length
            if (size > 1024 * 1024) throw Error('Metadata exceeds limit')
            chunks.push(chunk)
          }
          const metadata = serverModelMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')), configuration)
          if (Object.keys(metadata).length) modelMetadata = metadata
        } else response.body.destroy()
      } catch { signal?.throwIfAborted() }
      record({ event: 'chat.gpu.ready', pid: child.pid, loadMs: Date.now() - started, ...diagnostics.snapshot(), ...(modelMetadata ? { modelMetadata, ...(configuration.modelId ? { modelId: configuration.modelId } : {}) } : {}) })
    } catch (error) { await stop(true); throw error }
  }
  try { await ready() } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  const protocol = await initializeProtocol({ configuration: { model: 'local', chatToolSchemaEnvelope: true, chatTemplateReasoning: true, chatReasoning: configuration.chatReasoning === true, recoverUnopenedThinking: configuration.architecture === 'lfm3' } })
  return {
    async dispose() { disposed = true; await stop(); await rm(directory, { recursive: true, force: true }) },
    start(capability, input, call) {
      const id = randomUUID()
      let first = true, started
      const session = protocol.start(capability, input, {
        ...call,
        network: { async post(_endpoint, body) { return server.transport.request('/v1/chat/completions', body, call.signal) } },
        diagnostics: timings => record({ event: 'chat.gpu.timings', id, ...timings }),
        emit(event) {
          if (first && (event.type === 'thinking' || event.type === 'text' || event.type === 'tool')) { first = false; record({ event: 'chat.gpu.first', id, ms: Date.now() - started, kind: event.type }) }
          if (event.type === 'done') record({ event: 'chat.gpu.done', id, ms: Date.now() - started, reason: event.reason, usage: event.usage, ...server?.diagnostics.snapshot() })
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
          try {
            await ready(call.signal)
            server.diagnostics.beginRequest()
            await session.finish()
            call.signal.throwIfAborted()
          } catch (error) {
            call.signal.throwIfAborted()
            let code = /^EXTENSION_INFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'EXTENSION_INFERENCE_REQUEST_REJECTED'
            if (['EXTENSION_INFERENCE_REQUEST_REJECTED', 'EXTENSION_INFERENCE_OUTPUT_INCOMPLETE', 'EXTENSION_INFERENCE_PROCESS_EXITED'].includes(code)) code = server?.diagnostics.failure(server.exitFailure ?? code) ?? code
            record({ event: 'chat.gpu.error', id, code, ...server?.diagnostics.snapshot() })
            throw Error(code)
          } finally {
            call.signal.removeEventListener('abort', cancel)
            if (call.signal.aborted) await stop(true)
            record({ event: 'chat.gpu.drain', id, cancelled: call.signal.aborted, ms: Date.now() - started })
          }
        },
      }
    },
  }
}
