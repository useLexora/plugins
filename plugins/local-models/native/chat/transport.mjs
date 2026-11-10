import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

export function createTransport(socketPath, platform = process.platform) {
  const loopback = platform === 'win32' || platform === 'darwin'
  const key = loopback ? randomBytes(32).toString('hex') : undefined
  let port, output = ''
  return {
    args: loopback ? ['--host', '127.0.0.1', '--port', '0'] : ['--host', socketPath],
    environment: loopback ? { LLAMA_API_KEY: key } : {},
    observe(bytes) {
      if (!loopback || port) return
      output = (output + bytes).slice(-16384)
      for (const match of output.matchAll(/\blistening on http:\/\/127\.0\.0\.1:(\d{1,5})(?:\r?\n|\s)/g)) {
        if (Number(match[1]) > 0 && Number(match[1]) <= 65535) { port = Number(match[1]); break }
      }
    },
    request(path, body, signal) {
      if (loopback && !port) return Promise.reject(Error('EXTENSION_INFERENCE_STARTING'))
      return new Promise((resolve, reject) => {
        const req = httpRequest({ ...(loopback ? { host: '127.0.0.1', port } : { socketPath }), path, method: body ? 'POST' : 'GET', signal, headers: { ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) } }, response => resolve({ ok: response.statusCode === 200, status: response.statusCode, body: response }))
        req.once('error', reject)
        if (path === '/health') req.setTimeout(2000, () => req.destroy(Error('EXTENSION_INFERENCE_REQUEST_TIMEOUT')))
        else req.setTimeout(0)
        req.end(body)
      })
    },
  }
}
