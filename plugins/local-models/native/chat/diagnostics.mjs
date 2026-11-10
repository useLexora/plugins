import { StringDecoder } from 'node:string_decoder'
import { classifyEngineFailure } from './errors.mjs'

const backends = new Set(['cpu', 'vulkan', 'cuda', 'metal'])
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

export function safeTimings(value) {
  const timings = {}
  for (const [name, count, ms, rate] of [['prompt', 'prompt_n', 'prompt_ms', 'prompt_per_second'], ['decode', 'predicted_n', 'predicted_ms', 'predicted_per_second']]) {
    const phase = {}
    for (const [key, source] of [['tokens', count], ['ms', ms], ['tokensPerSecond', rate]]) if (number(value?.[source])) phase[key] = value[source]
    if (Object.keys(phase).length) timings[name] = phase
  }
  return timings
}

export function createEngineDiagnostics(configuration) {
  const engine = { name: 'llama.cpp' }
  if (/^b\d{1,12}$/.test(configuration.engineVersion ?? '')) engine.version = configuration.engineVersion
  const backend = { requested: backends.has(configuration.engineBackend) ? configuration.engineBackend : 'unknown', observed: [] }
  const devices = [], streams = new Map(), context = {}
  const contextCount = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647
  if (contextCount(configuration.contextWindow)) context.requested = configuration.contextWindow
  let offload, error, timings = {}, architecture
  if (/^[a-z][a-z0-9_.-]{0,63}$/.test(configuration.architecture ?? '')) architecture = configuration.architecture
  const requestedCpu = configuration.acceleration === 'cpu' || configuration.engineBackend === 'cpu'
  function line(text) {
    const code = classifyEngineFailure(text, null)
    if (code) error ??= code
    const used = /using device (CUDA|Vulkan|Metal|CPU)(\d*)\b/i.exec(text)
    if (used) {
      const name = used[1].toLowerCase()
      if (!backend.observed.includes(name)) backend.observed.push(name)
      const index = Number(used[2] || 0)
      if (number(index) && devices.length < 16 && !devices.some(device => device.backend === name && device.index === index)) devices.push({ backend: name, index })
    }
    const layers = /offloaded (\d+)\/(\d+) layers/i.exec(text)
    if (layers && number(Number(layers[1])) && number(Number(layers[2]))) {
      offload = { layers: Number(layers[1]), total: Number(layers[2]) }
      if (!offload.layers && !backend.observed.includes('cpu')) backend.observed.push('cpu')
    }
    const contextValue = /\b(llama_context|print_info):\s+(n_ctx|n_ctx_train)\s*=\s*(\d+)\s*$/.exec(text)
    if (contextValue && contextCount(Number(contextValue[3]))) {
      if (contextValue[1] === 'llama_context' && contextValue[2] === 'n_ctx') context.actual = Number(contextValue[3])
      if (contextValue[1] === 'print_info' && contextValue[2] === 'n_ctx_train') context.train = Number(contextValue[3])
    }
    const timing = /\b(prompt eval|eval) time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) (?:tokens|runs)(?:\s*\([^)]*?,\s*([\d.]+) tokens per second)?/i.exec(text)
    if (timing && number(Number(timing[2])) && number(Number(timing[3]))) {
      const phase = { ms: Number(timing[2]), tokens: Number(timing[3]) }
      if (timing[4] && number(Number(timing[4]))) phase.tokensPerSecond = Number(timing[4])
      timings[timing[1].toLowerCase() === 'eval' ? 'decode' : 'prompt'] = phase
    }
  }
  return {
    observe(bytes, channel = 'stderr') {
      let stream = streams.get(channel)
      if (!stream) { stream = { decoder: new StringDecoder('utf8'), pending: '', truncated: false }; streams.set(channel, stream) }
      const text = stream.decoder.write(bytes)
      let start = 0
      for (;;) {
        const end = text.indexOf('\n', start)
        const part = text.slice(start, end < 0 ? undefined : end)
        if (stream.pending.length + part.length > 4096) stream.truncated = true
        stream.pending = (stream.pending + part).slice(-4096)
        if (end < 0) break
        if (!stream.truncated) line(stream.pending)
        stream.pending = ''
        stream.truncated = false
        start = end + 1
      }
    },
    flush() {
      for (const stream of streams.values()) {
        stream.pending += stream.decoder.end()
        if (!stream.truncated) line(stream.pending)
        stream.pending = ''
      }
    },
    beginRequest() { timings = {}; error = undefined },

    failure(fallback = 'EXTENSION_INFERENCE_LOAD_FAILED') { return error ?? fallback },
    snapshot() {
      return {
        engine: { ...engine }, backend: { ...backend, observed: [...backend.observed] }, device: devices.map(device => ({ ...device })),
        ...(architecture ? { architecture } : {}), ...(offload ? { offload: { ...offload }, degraded: !requestedCpu && backend.requested !== 'cpu' && offload.layers === 0 } : {}),
        ...(Object.keys(context).length ? { context: { ...context } } : {}),
        timings: structuredClone(timings), ...(error ? { error } : {}),
      }
    },
  }
}
