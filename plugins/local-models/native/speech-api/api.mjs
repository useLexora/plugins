import { Buffer } from 'node:buffer'

const invalid = () => new Error('EXTENSION_INFERENCE_FORMAT_UNSUPPORTED')
function emit(call, data, bytes) {
  call.signal.throwIfAborted()
  if (!call.emit(data, bytes)) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
}
async function accepted(response, type) {
  if (!response.ok) {
    await response.body?.cancel()
    throw Error([401, 403].includes(response.status) ? 'EXTENSION_INFERENCE_SERVICE_UNAUTHORIZED' : response.status === 429 ? 'EXTENSION_INFERENCE_SERVICE_BUSY' : 'EXTENSION_INFERENCE_SERVICE_FAILED')
  }
  if (!response.body || !type.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    throw invalid()
  }
  return response
}
function wav(chunks, size) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + size, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(size, 40)
  return Buffer.concat([header, ...chunks], 44 + size)
}

export async function initialize({ configuration }) {
  return {
    start(capability, input, call) {
      if (capability === 'api-transcribe') {
        if (input.sampleRate !== 16000 || input.channels !== 1 || input.sampleFormat !== 'f32le') throw invalid()
        const chunks = []
        let size = 0
        return {
          write(bytes) {
            call.signal.throwIfAborted()
            if (!bytes.length || bytes.length % 4) throw invalid()
            size += bytes.length / 2
            if (size > 16000 * 2 * 600) throw Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE')
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            const pcm = Buffer.alloc(bytes.length / 2)
            for (let i = 0; i < bytes.length / 4; i++) {
              const sample = view.getFloat32(i * 4, true)
              if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw invalid()
              pcm.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), i * 2)
            }
            chunks.push(pcm)
          },
          async finish() {
            call.signal.throwIfAborted()
            if (!size) {
              emit(call, { type: 'transcript', segmentId: 'main', revision: 0, text: '', final: true })
              return
            }
            const form = new FormData()
            form.append('model', configuration.transcribeModel)
            form.append('response_format', 'json')
            form.append('file', new Blob([wav(chunks, size)], { type: 'audio/wav' }), 'recording.wav')
            chunks.length = 0
            const encoded = new Request('http://127.0.0.1/', { method: 'POST', body: form })
            const response = await accepted(await call.network.post('transcribe', new Uint8Array(await encoded.arrayBuffer()), { contentType: encoded.headers.get('content-type') }), /^application\/json(?:;|$)/i)
            const result = await response.json()
            if (typeof result.text !== 'string' || result.text.length > 16000) throw invalid()
            emit(call, { type: 'transcript', segmentId: 'main', revision: 0, text: result.text, final: true })
          },
        }
      }
      if (capability !== 'api-synthesize' || typeof input.text !== 'string' || !input.text.trim()) throw invalid()
      if (input.text.length > 4096) throw Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE')
      return {
        async finish() {
          call.signal.throwIfAborted()
          const body = new TextEncoder().encode(JSON.stringify({ model: configuration.synthesizeModel, input: input.text, voice: configuration.voice, speed: configuration.speed, response_format: 'pcm' }))
          const response = await accepted(await call.network.post('synthesize', body), /^(?:audio\/(?:pcm|raw)|application\/octet-stream)(?:;|$)/i)
          let remainder = Buffer.alloc(0), sequence = 0
          for await (const bytes of response.body) {
            call.signal.throwIfAborted()
            const data = Buffer.concat([remainder, bytes])
            const aligned = data.length - data.length % 2
            remainder = Buffer.from(data.subarray(aligned))
            for (let offset = 0; offset < aligned; offset += 48000) {
              const end = Math.min(aligned, offset + 48000)
              const pcm = Buffer.alloc((end - offset) * 2)
              for (let i = offset; i < end; i += 2) pcm.writeFloatLE(data.readInt16LE(i) / 32768, (i - offset) * 2)
              emit(call, { type: 'audio', sequence: sequence++, sampleFormat: 'f32le', sampleRate: 24000, channels: 1 }, pcm)
            }
          }
          if (remainder.length || !sequence) throw invalid()
        },
      }
    },
  }
}
