import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createTransport } from '../transport.mjs'

async function fixture(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const transport = createTransport(undefined, 'win32')
  transport.observe(`listening on http://127.0.0.1:${server.address().port}\n`)
  return { transport, server }
}

test('real prefill may exceed 30 seconds without headers or tokens', { timeout: 40000 }, async t => {
  const { transport } = await fixture(t, (request, response) => {
    request.resume()
    const timer = setTimeout(() => response.end('data: completed\n\n'), 30500)
    response.once('close', () => clearTimeout(timer))
  })
  const response = await transport.request('/v1/chat/completions', Buffer.from('{}'), new AbortController().signal)
  let content = ''
  for await (const chunk of response.body) content += chunk
  assert.equal(content, 'data: completed\n\n')
})

for (const headers of [false, true]) test(`cancellation closes a stalled inference socket ${headers ? 'after' : 'before'} headers`, { timeout: 5000 }, async t => {
  let arrived, closed
  const arrival = new Promise(resolve => { arrived = resolve })
  const closure = new Promise(resolve => { closed = resolve })
  const { transport } = await fixture(t, (request, response) => {
    request.resume()
    response.once('close', closed)
    if (headers) { response.writeHead(200); response.write(': waiting\n\n') }
    arrived()
  })
  const controller = new AbortController()
  const request = transport.request('/v1/chat/completions', Buffer.from('{}'), controller.signal)
  const outcome = (async () => { const response = await request; for await (const _ of response.body) {} })()
  const rejected = assert.rejects(outcome, error => error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'ECONNRESET')
  await arrival
  if (headers) await request
  controller.abort()
  await rejected
  await closure
})

test('health checks still time out and pre-cancelled requests do not wait for readiness', { timeout: 5000 }, async t => {
  const { transport } = await fixture(t, request => request.resume())
  await assert.rejects(transport.request('/health'), /EXTENSION_INFERENCE_REQUEST_TIMEOUT/)
  await assert.rejects(transport.request('/v1/chat/completions', Buffer.from('{}'), AbortSignal.abort()), { name: 'AbortError' })
})
