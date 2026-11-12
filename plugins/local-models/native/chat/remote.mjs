import { classifyEngineFailure } from './errors.mjs'
import { createReasoningStream } from './reasoning.mjs'
import { safeTimings } from './diagnostics.mjs'
import { createToolArguments } from './tool-arguments.mjs'

const maxRequestBytes = 32 * 1024 * 1024
const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const base64 = /^[A-Za-z0-9+/]*={0,2}$/

function messageContent(message) {
  if (Object.hasOwn(message, 'text') === Object.hasOwn(message, 'content')) throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
  if (Object.hasOwn(message, 'text')) {
    if (typeof message.text !== 'string') throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
    return message.isError ? JSON.stringify({ isError: true, text: message.text }) : message.text
  }
  if (!Array.isArray(message.content) || !message.content.length) throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
  const content = message.content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part?.type === 'image' && imageMimeTypes.has(part.mimeType) && typeof part.data === 'string' && part.data.length > 0 && part.data.length % 4 === 0 && base64.test(part.data)) return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
    throw Error('EXTENSION_INFERENCE_INPUT_INVALID')
  })
  return message.isError ? [{ type: 'text', text: JSON.stringify({ isError: true }) }, ...content] : content
}

function remoteMessage(message, toolArguments) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: messageContent(message) }
  if (message.role === 'user') return { role: 'user', content: messageContent(message) }
  if (message.role === 'assistant') return { role: 'assistant', content: message.text, ...message.toolCalls.length ? { tool_calls: message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(toolArguments.encode(tool.name, tool.arguments)) } })) } : {} }
  return { role: message.role, content: message.text }
}

async function rejectResponse(response) {
  let text = ''
  if (response.body) {
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString('utf8')
      if (text.length > 65536) throw Error('EXTENSION_INFERENCE_REQUEST_REJECTED')
    }
  }
  let error
  try { error = JSON.parse(text).error } catch {}
  if (response.status === 413 || error?.type === 'exceed_context_size_error' || error?.code === 'context_length_exceeded' || /(?:exceeds?|exceeded|too (?:large|long)|maximum).{0,80}context|context.{0,80}(?:exceeds?|exceeded|too (?:large|long)|maximum)/i.test(error?.message ?? ''))
    throw Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
  throw Error(classifyEngineFailure(error?.message ?? '', 'EXTENSION_INFERENCE_REQUEST_REJECTED'))
}

export async function initialize({ configuration }) {
  return {
    start(_capability, _input, call) {
      const chunks = []
      let bytes = 0
      return {
        write(chunk) {
          call.signal.throwIfAborted()
          bytes += chunk.length
          if (bytes > maxRequestBytes) throw Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
          chunks.push(Buffer.from(chunk))
        },
        async finish() {
          call.signal.throwIfAborted()
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const toolArguments = createToolArguments(request.tools, configuration.chatToolSchemaEnvelope === true)
          const payload = {
            model: configuration.model,
            messages: request.messages.map(message => remoteMessage(message, toolArguments)),
            max_tokens: request.maxTokens,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(configuration.chatTemplateReasoning && request.reasoning !== undefined ? { chat_template_kwargs: { enable_thinking: request.reasoning !== 'off' } } : {}),
            ...request.tools.length ? { tools: toolArguments.tools.map(tool => ({ type: 'function', function: tool })) } : {},
          }
          const body = Buffer.from(JSON.stringify(payload))
          if (body.length > maxRequestBytes) throw Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
          const response = await call.network.post('chat', body)
          call.signal.throwIfAborted()
          if (!response.ok) await rejectResponse(response)
          if (!response.body) throw Error('EXTENSION_INFERENCE_OUTPUT_INCOMPLETE')
          const decoder = new TextDecoder()
          let pending = '', reason, usage, ended = false
          const calls = new Map()
          const reasoning = createReasoningStream({ emit: call.emit, tagged: configuration.chatTemplateReasoning === true, recoverUnopenedThinking: configuration.recoverUnopenedThinking === true, enabled: configuration.chatReasoning === true && request.reasoning !== undefined && request.reasoning !== 'off' })
          for await (const bytes of response.body) {
            call.signal.throwIfAborted()
            pending += decoder.decode(bytes, { stream: true })
            let split
            while ((split = pending.indexOf('\n')) >= 0) {
              if (split > 262144) throw Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
              const line = pending.slice(0, split).trim()
              pending = pending.slice(split + 1)
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data === '[DONE]') { ended = true; continue }
              const item = JSON.parse(data), choice = item.choices?.[0]
              if (item.usage) {
                const input = item.usage.prompt_tokens, output = item.usage.completion_tokens, cacheRead = item.usage.prompt_tokens_details?.cached_tokens ?? 0
                if (![input, output, cacheRead].every(value => Number.isSafeInteger(value) && value >= 0) || cacheRead > input) throw Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
                usage = { input: input - cacheRead, output, cacheRead }
              }
              if (item.error) throw Error(classifyEngineFailure(item.error.message ?? '', 'EXTENSION_INFERENCE_REQUEST_REJECTED'))
              if (item.timings) call.diagnostics?.(safeTimings(item.timings))
              reasoning.push(choice?.delta)
              for (const tool of choice?.delta?.tool_calls ?? []) {
                const current = calls.get(tool.index) ?? { id: '', name: '', arguments: '' }
                current.id += tool.id ?? ''
                current.name += tool.function?.name ?? ''
                current.arguments += tool.function?.arguments ?? ''
                calls.set(tool.index, current)
              }
              if (choice?.finish_reason) reason = choice.finish_reason
            }
            if (pending.length > 262144) throw Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
          }
          call.signal.throwIfAborted()
          if (!ended || !usage || !['stop', 'length', 'tool_calls'].includes(reason)) throw Error('EXTENSION_INFERENCE_OUTPUT_INCOMPLETE')
          reasoning.finish()
          for (const tool of calls.values()) if (!call.emit({ type: 'tool', call: { ...tool, arguments: toolArguments.decode(tool.name, JSON.parse(tool.arguments)) } })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
          if (!call.emit({ type: 'done', reason: reason === 'tool_calls' ? 'toolUse' : reason, usage })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
        },
      }
    },
  }
}
