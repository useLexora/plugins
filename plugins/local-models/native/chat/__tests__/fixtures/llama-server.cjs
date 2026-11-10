#!/usr/bin/env node
const { createServer } = require('node:http')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
const record = event => appendFileSync(join(__dirname, 'observations.jsonl'), JSON.stringify({ ...event, pid: process.pid }) + '\n')
const event = (response, data) => response.write(`data: ${JSON.stringify(data)}\n\n`)
record({ type: 'start', args })
const model = args[args.indexOf('-m') + 1]
const failures = { architecture: 'unknown model architecture: future', quantization: 'unsupported tensor type: 999', memory: 'CUDA out of memory', driver: 'CUDA driver version is insufficient for CUDA runtime version', backend: 'failed to initialize Vulkan' }
for (const [name, detail] of Object.entries(failures)) {
  if (model.endsWith(`failure-${name}.gguf`)) { process.stderr.write(`${detail}: /private/model.gguf token=secret\n`); process.exit(1) }
}
if (model.endsWith('diagnostics.gguf')) {
  process.stderr.write('llama_model_load: using device Vulkan0 (private GPU label)\nload_tensors: offloaded 12/24 layers to GPU\nprompt: secret prompt /private/model.gguf Bearer secret\n')
}
const server = createServer(async (request, response) => {
  if (request.url === '/health') { response.end('{}'); return }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks).toString())
  record({ type: 'request', payload })
  const text = JSON.stringify(payload.messages)
  if (text.includes('__oom__')) { response.writeHead(500).end(JSON.stringify({ error: { message: 'failed to allocate buffer /private/path' } })); return }
  if (text.includes('__tagged__')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const content of ['<th', 'ink>分析', '</thi', 'nk>answer <think>literal</think>']) event(response, { choices: [{ delta: { content } }] })
    event(response, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 }, timings: { prompt_n: 3, prompt_ms: 51, predicted_n: 4, predicted_ms: 12, prompt: 'secret prompt', path: '/private/model.gguf' } })
    response.end('data: [DONE]\n\n')
    return
  }
  if (text.includes('__context__')) {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'context_length_exceeded' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (text.includes('__reasoning__')) event(response, { choices: [{ delta: { reasoning_content: 'fixture thinking' }, finish_reason: null }] })
  event(response, { choices: [{ delta: { content: 'fixture reply' }, finish_reason: null }] })
  if (text.includes('__wait__')) return
  event(response, { choices: [{ delta: {}, finish_reason: text.includes('__length__') ? 'length' : 'stop' }] })
  event(response, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } })
  response.end('data: [DONE]\n\n')
})
server.listen(args[args.indexOf('--host') + 1])
