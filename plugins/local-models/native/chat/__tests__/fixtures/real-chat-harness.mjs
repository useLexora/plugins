import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import { request } from 'node:http'
import { basename, join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { initialize } from '../../chat.mjs'

export const contextWindow = 65536

export async function createRealChatHarness({ engine, model, profile, output, backend = 'cpu', threads = 4, timeoutMs = 900000 }) {
  assert.ok(['cpu', 'vulkan', 'cuda'].includes(backend), 'Select cpu, vulkan or cuda explicitly')
  assert.equal(process.platform, 'linux', 'This acceptance harness currently requires Linux for memory accounting and the local Unix transport')
  await mkdir(output, { recursive: true })
  const logVerbosity = process.env.LEXORA_CHAT_TEST_LOG_VERBOSITY
  assert.ok(logVerbosity === undefined || logVerbosity === '4', 'Acceptance logging only supports explicit -lv 4; default leaves product arguments unchanged')
  const originalSpawn = childProcess.spawn
  const originalWrite = process.stderr.write
  const children = new Set()
  const diagnostics = [], gpuSamples = [], launches = []
  const execFile = promisify(childProcess.execFile)
  const rawLog = createWriteStream(join(output, 'engine-stderr.log'), { flags: 'wx' })
  let logError
  rawLog.on('error', error => { logError = error.message })
  const acceleration = backend === 'vulkan' ? 'gpu' : backend
  const metadata = { profile, contextWindow, threads, engineVersion: process.env.LEXORA_CHAT_TEST_ENGINE_VERSION, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), backend, requestedBackend: backend, acceleration, launches, startedAt: new Date().toISOString(), pageCache: 'not flushed', cases: [] }
  metadata.instrumentation = { logVerbosity: logVerbosity === undefined ? null : Number(logVerbosity), extraArguments: logVerbosity === undefined ? [] : ['-lv', logVerbosity], note: logVerbosity === undefined ? 'Unmodified product launch arguments' : 'Acceptance-only trace logging; timings include trace observation overhead, not an uninstrumented product benchmark' }
  let activeCase = 'initialization', observed
  let child, socketPath, stderr = '', pending = '', runtime, activeController, sampling = false, terminated = false, guardFailure, memorySamples = 0, peakRssKiB = 0, peakSwapKiB = 0, minimumAvailableKiB = Infinity
  childProcess.spawn = function (executable, args, options) {
    if (basename(String(executable)) === 'llama-server' && logVerbosity !== undefined) args = [...args, '-lv', logVerbosity]
    const spawned = originalSpawn.call(this, executable, args, options)
    if (basename(String(executable)) === 'llama-server') {
      child = spawned
      children.add(spawned)
      spawned.once('close', () => children.delete(spawned))
      socketPath = args[args.indexOf('--host') + 1]
      metadata.launchArguments = args.filter((value, index) => args[index - 1] !== '-m' && args[index - 1] !== '--host')
      const launch = observed = { pid: spawned.pid, at: new Date().toISOString(), arguments: metadata.launchArguments, backends: [], offload: null, evidence: [] }
      launches.push(launch)
      let lines = ''
      spawned.stderr.on('data', bytes => {
        rawLog.write(bytes)
        stderr = (stderr + bytes.toString('utf8')).slice(-256 * 1024)
        lines += bytes.toString('utf8')
        let newline
        while ((newline = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, newline)
          lines = lines.slice(newline + 1)
          const used = /using device (CUDA|Vulkan|CPU)(\d*)\b/i.exec(line) ?? /\b(CUDA|Vulkan)(\d+)\s+(?:model|KV|compute) buffer/i.exec(line)
          if (used && !launch.backends.includes(used[1].toLowerCase())) launch.backends.push(used[1].toLowerCase())
          const layers = /offloaded (\d+)\/(\d+) layers/i.exec(line)
          if (layers) launch.offload = { layers: Number(layers[1]), total: Number(layers[2]) }
          if (/using device|offload|buffer size|CUDA|Vulkan|out of memory|failed|error/i.test(line) && launch.evidence.length < 256) launch.evidence.push(line.slice(0, 4096))
        }
        lines = lines.slice(-8192)
      })
    }
    return spawned
  }
  syncBuiltinESMExports()
  process.stderr.write = function (chunk, ...args) {
    pending += String(chunk)
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      try { const event = JSON.parse(line); if (event.event?.startsWith('chat.gpu.')) diagnostics.push(event) } catch {}
    }
    return originalWrite.call(this, chunk, ...args)
  }
  const sampleGpu = async () => {
    if (backend === 'cpu') return
    const at = new Date().toISOString(), caseName = activeCase, pid = child?.pid ?? null
    const queries = ['--query-gpu=index,uuid,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu', '--query-compute-apps=gpu_uuid,pid,used_gpu_memory']
    const results = await Promise.allSettled(queries.map(query => execFile('nvidia-smi', [query, '--format=csv,noheader,nounits'], { timeout: 2500, maxBuffer: 64 * 1024 })))
    const values = results.map(result => result.status === 'fulfilled' ? { rows: result.value.stdout.trim().split('\n').filter(Boolean).map(line => line.split(',').map(value => value.trim())) } : { error: result.reason.message })
    gpuSamples.push({ at, case: caseName, pid, devices: values[0], computeProcesses: values[1] })
  }
  const summarizeGpu = samples => {
    const devices = samples.flatMap(sample => sample.devices.rows ?? [])
    const numeric = values => values.map(Number).filter(Number.isFinite)
    const maximum = values => values.length ? Math.max(...values) : null
    const owned = samples.flatMap(sample => (sample.computeProcesses.rows ?? []).filter(row => Number(row[1]) === sample.pid))
    return { samples: samples.length, successfulSamples: samples.filter(sample => sample.devices.rows?.length).length, devicePeakUsedMiB: maximum(numeric(devices.map(row => row[5]))), devicePeakUtilizationPercent: maximum(numeric(devices.map(row => row[7]))), ownedProcessPeakUsedMiB: maximum(numeric(owned.map(row => row[2]))), errors: [...new Set(samples.flatMap(sample => [sample.devices.error, sample.computeProcesses.error].filter(Boolean)))] }
  }
  const sample = () => {
    if (sampling) return sampling
    if (!child?.pid) return Promise.resolve()
    sampling = (async () => {
    try {
      await sampleGpu()
      const [status, memory] = await Promise.all([readFile(`/proc/${child.pid}/status`, 'utf8'), readFile('/proc/meminfo', 'utf8')])
      memorySamples++
      const value = (text, field) => Number(new RegExp(`^${field}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
      peakRssKiB = Math.max(peakRssKiB, value(status, 'VmRSS'))
      peakSwapKiB = Math.max(peakSwapKiB, value(status, 'VmSwap'))
      const available = value(memory, 'MemAvailable')
      minimumAvailableKiB = Math.min(minimumAvailableKiB, available)
      if (available < 1536 * 1024) {
        guardFailure = 'Host available memory fell below 1.5 GiB; acceptance run stopped without changing context size'
        activeController?.abort(new Error(guardFailure))
        for (const process of children) process.kill('SIGKILL')
      }
    } catch {} finally { sampling = false }
    })()
    return sampling
  }
  const timer = setInterval(() => { void sample() }, 1000)
  const stop = () => { terminated = true; activeController?.abort(); for (const process of children) process.kill('SIGKILL') }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const save = async () => {
    metadata.memorySamples = memorySamples
    metadata.memorySamplingIntervalMs = 1000
    metadata.sampledPeakRssMiB = memorySamples ? peakRssKiB / 1024 : null
    metadata.sampledPeakSwapMiB = memorySamples ? peakSwapKiB / 1024 : null
    metadata.minimumAvailableMiB = Number.isFinite(minimumAvailableKiB) ? minimumAvailableKiB / 1024 : null
    metadata.guardFailure = guardFailure ?? null
    metadata.rawLogError = logError ?? null
    metadata.gpuBaseline = gpuSamples[0] ?? null
    metadata.gpuSampling = { source: 'nvidia-smi (NVML)', intervalMs: 1000, ...summarizeGpu(gpuSamples), note: 'Device utilization includes unrelated desktop activity; PID memory and engine offload logs provide attribution. All layers offloaded does not prove all operations run on GPU.' }
    metadata.observedBackend = observed?.backends ?? []
    metadata.observedOffload = observed?.offload ?? null
    metadata.execution = observed?.offload ? observed.offload.layers === 0 ? 'cpu-or-fallback' : observed.offload.layers < observed.offload.total ? 'mixed-cpu-gpu-layers' : 'all-model-layers-offloaded-cpu-operations-possible' : 'unconfirmed'
    await writeFile(join(output, 'gpu-samples.jsonl'), gpuSamples.map(sample => JSON.stringify(sample)).join('\n') + '\n')
    await writeFile(join(output, 'results.json'), JSON.stringify(metadata, null, 2) + '\n')
    await writeFile(join(output, 'diagnostics.jsonl'), diagnostics.map(event => JSON.stringify(event)).join('\n') + '\n')
    await writeFile(join(output, 'engine-stderr-tail.log'), stderr)
  }
  const close = async () => {
    clearInterval(timer)
    try { await runtime?.dispose() } finally {
      stop()
      if (sampling) await sampling
      rawLog.end()
      await finished(rawLog).catch(error => { logError = error.message })
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
      process.stderr.write = originalWrite
      metadata.finishedAt = new Date().toISOString()
      await save()
    }
  }
  const http = (path, input) => new Promise((resolve, reject) => {
    if (terminated || guardFailure) return reject(Error(guardFailure ?? 'Acceptance run was terminated'))
    const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input))
    const req = request({ socketPath, path, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : {} }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', bytes => { text += bytes; if (text.length > 16 * 1024 * 1024) req.destroy(Error('Tokenizer response exceeds bounded size')) })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw Error(`Engine metadata ${path}: ${response.statusCode} ${text.slice(0, 300)}`)
          resolve(JSON.parse(text))
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(30000, () => req.destroy(Error('Engine metadata request timed out')))
    req.on('error', reject)
    req.end(body)
  })
  try {
    const start = performance.now()
    await sampleGpu()
    runtime = await initialize({ resources: { engine, model: engine }, resourceFiles: { model: { 'model.gguf': model } }, configuration: { engineBackend: backend, acceleration, engineVersion: process.env.LEXORA_CHAT_TEST_ENGINE_VERSION, contextWindow, threads, files: { model: 'model.gguf' }, chatReasoning: true } })
    metadata.initializeMs = performance.now() - start
    const props = await http('/props')
    await writeFile(join(output, 'engine-props.json'), JSON.stringify(props, null, 2) + '\n')
    metadata.actualContextWindow = props.default_generation_settings?.n_ctx
    const models = await http('/v1/models')
    metadata.model = models.data?.[0]?.meta ?? null
    assert.equal(metadata.actualContextWindow, contextWindow, 'Engine must actually allocate 64K, not silently reduce context')
    assert.ok(metadata.model?.n_ctx_train >= contextWindow, 'The model must declare native support for at least 64K')
    await sample()
    await save()
  } catch (error) {
    metadata.startupError = guardFailure ?? error.message
    await close()
    throw error
  }
  const tokenize = async text => (await http('/tokenize', { content: text, add_special: false })).tokens.length
  const calibrate = async (builder, targetTokens = 56000) => {
    let units = 100, task, tokens
    for (let attempt = 0; attempt < 8; attempt++) {
      task = builder(units)
      tokens = await tokenize(task.messages.map(message => message.text).join('\n'))
      if (tokens >= targetTokens - 600 && tokens <= targetTokens + 600) return { ...task, calibratedTokens: tokens, units }
      units = Math.max(8, Math.round(units * targetTokens / tokens))
    }
    throw Error(`Unable to calibrate task near ${targetTokens} actual tokens (got ${tokens}, units ${units})`)
  }
  const invoke = async (name, messages, { tools = [], maxTokens = 768, cancelAfterCharacters, cancelAfterMs, temperature = 0.1, requestTimeoutMs = timeoutMs } = {}) => {
    if (terminated) throw Error('Acceptance run was terminated; no further engine may start')
    if (guardFailure) throw Error(guardFailure)
    activeCase = name
    const startedAt = new Date().toISOString()
    const started = performance.now(), offset = diagnostics.length, gpuOffset = gpuSamples.length
    const controller = activeController = new AbortController()
    const events = []
    let firstTextMs = null, firstEventMs = null, previousTextAt, maximumTextGapMs = 0, text = '', cancelledAt, deadline = false
    const deadlineTimer = setTimeout(() => { deadline = true; controller.abort() }, requestTimeoutMs)
    const cancel = () => { if (!controller.signal.aborted) { cancelledAt = performance.now(); controller.abort() } }
    const cancellationTimer = cancelAfterMs ? setTimeout(cancel, cancelAfterMs) : undefined
    let error
    try {
      const session = runtime.start('chat', {}, { signal: controller.signal, emit(event) {
        const now = performance.now()
        events.push(event)
        if (firstEventMs === null && ['text', 'thinking', 'tool'].includes(event.type)) firstEventMs = now - started
        if (event.type === 'text' && event.text) {
          if (firstTextMs === null) firstTextMs = now - started
          if (previousTextAt !== undefined) maximumTextGapMs = Math.max(maximumTextGapMs, now - previousTextAt)
          previousTextAt = now
          text += event.text
          if (cancelAfterCharacters && text.length >= cancelAfterCharacters) cancel()
        }
        return true
      } })
      session.write(Buffer.from(JSON.stringify({ messages, tools, maxTokens, temperature, reasoning: 'off' })))
      await session.finish()
    } catch (failure) { error = guardFailure ?? (deadline ? `Request exceeded ${requestTimeoutMs} ms deadline` : failure.message) }
    finally { clearTimeout(deadlineTimer); clearTimeout(cancellationTimer); activeController = undefined; await sample() }
    error = guardFailure ?? error
    const done = events.findLast(event => event.type === 'done')
    const relevant = diagnostics.slice(offset)
    const timings = relevant.findLast(event => event.event === 'chat.gpu.timings')
    const result = { name, startedAt, requestedBackend: backend, observedBackend: [...(observed?.backends ?? [])], observedOffload: observed?.offload ?? null, gpuSampleRange: [gpuOffset, gpuSamples.length], gpu: summarizeGpu(gpuSamples.slice(gpuOffset)), wallMs: performance.now() - started, firstTextMs, firstEventMs, maximumTextGapMs, usage: done?.usage ?? null, totalPromptTokens: done ? done.usage.input + done.usage.cacheRead : null, reason: done?.reason ?? null, doneEvents: events.filter(event => event.type === 'done').length, thinkingLeak: events.some(event => event.type === 'thinking') || /<\/?think>/.test(text), timings: timings ? { prompt: timings.prompt, decode: timings.decode } : null, timedOut: deadline, ownedProcessesAlive: children.size, cancelled: cancelledAt !== undefined, cancellationMs: cancelledAt === undefined ? null : performance.now() - cancelledAt, error: error ?? null, text, toolCalls: events.filter(event => event.type === 'tool').map(event => event.call) }
    metadata.cases.push(result)
    await save()
    activeCase = 'idle'
    console.log(JSON.stringify({ acceptance: name, profile, backend, wallMs: Math.round(result.wallMs), promptTokens: result.totalPromptTokens, outputTokens: result.usage?.output, firstTextMs: result.firstTextMs, reason: result.reason, error: result.error }))
    return result
  }
  return { metadata, calibrate, invoke, close, save, tokenize }
}
