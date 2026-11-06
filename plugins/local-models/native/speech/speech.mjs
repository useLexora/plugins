import { createRequire } from 'node:module'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { resourceDirectory, resourceFile } from '../resources.mjs'

export async function initialize(input) {
  const { configuration } = input
  const sherpa = createRequire(path.join(resourceDirectory(input, 'engine'), 'package.json'))('sherpa-onnx-node')
  const root = configuration.bundle ? resourceDirectory(input, 'model') : input.resources.model
  const entries = configuration.bundle ? await readdir(root) : []
  const bundleFiles = configuration.bundle ? { model: entries.find(name => /^model.*int8.*\.onnx$/.test(name)) ?? entries.find(name => /^model.*\.onnx$/.test(name)), voices: 'voices.bin', tokens: 'tokens.txt' } : undefined
  if (configuration.bundle && !bundleFiles.model) throw Error('EXTENSION_INFERENCE_MODEL_UNSUPPORTED')
  const modelFile = role => resourceFile(input, 'model', role)
  const file = (role, fallback) => modelFile(configuration.files?.[role] ?? bundleFiles?.[role] ?? fallback)
  if (configuration.kind === 'asr') {
    const recognizer = new sherpa.OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: file('encoder', 'encoder-epoch-99-avg-1.int8.onnx'), decoder: file('decoder', 'decoder-epoch-99-avg-1.onnx'), joiner: file('joiner', 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: file('tokens', 'tokens.txt'), numThreads: configuration.threads, provider: 'cpu', debug: false }, decodingMethod: 'greedy_search', enableEndpoint: false })
    return { start(_capability, input, call) {
      if (input.sampleRate !== 16000 || input.channels !== 1 || input.sampleFormat !== 'f32le') throw Error('EXTENSION_INFERENCE_FORMAT_UNSUPPORTED')
      const stream = recognizer.createStream()
      let revision = 0
      function result(final) {
        while (recognizer.isReady(stream)) recognizer.decode(stream)
        call.signal.throwIfAborted()
        if (!call.emit({ type: 'transcript', segmentId: 'main', revision: revision++, text: recognizer.getResult(stream).text, final })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
      }
      return { write(bytes) {
        call.signal.throwIfAborted()
        if (!bytes.length || bytes.length % 4) throw Error('EXTENSION_INFERENCE_FORMAT_UNSUPPORTED')
        const samples = new Float32Array(bytes.length / 4); new Uint8Array(samples.buffer).set(bytes)
        stream.acceptWaveform({ sampleRate: 16000, samples }); result(false)
      }, finish() {
        if (!call.signal.aborted) { stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(4800) }); stream.inputFinished(); result(true) }
      } }
    } }
  }
  const tts = await sherpa.OfflineTts.createAsync({ model: { kokoro: { model: file('model', 'model.onnx'), voices: file('voices', 'voices.bin'), tokens: file('tokens', 'tokens.txt'), dataDir: resourceDirectory(input, 'model', configuration.phonemes ?? 'espeak-ng-data'), lexicon: configuration.bundle ? entries.filter(name => /^lexicon.*\.txt$/.test(name)).map(modelFile).join(',') : configuration.files ? (configuration.files.lexicon ? file('lexicon', '') : '') : `${modelFile('lexicon-us-en.txt')},${modelFile('lexicon-zh.txt')}` }, numThreads: configuration.threads, provider: 'cpu', debug: false }, maxNumSentences: 1 })
  return { start(_capability, input, call) {
    let sequence = 0
    return { async finish() {
      if (call.signal.aborted) return
      await tts.generateAsync({ text: input.text, enableExternalBuffer: false, generationConfig: { sid: configuration.speaker, speed: configuration.speed }, onProgress({ samples }) {
        if (call.signal.aborted) return 0
        for (let start = 0; start < samples.length; start += 32768) {
          const chunk = samples.subarray(start, start + 32768)
          if (!call.emit({ type: 'audio', sequence: sequence++, sampleFormat: 'f32le', channels: 1, sampleRate: tts.sampleRate }, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return 0
        }
        return 1
      } })
    } }
  } }
}
