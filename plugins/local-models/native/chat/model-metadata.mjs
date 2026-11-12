/** @typedef {{ toolCall?: boolean, reasoningOptions?: string[], input?: string[], contextWindow?: number, maxTokens?: number }} ModelMetadata */

/** @returns {ModelMetadata} */
export function declaredModelMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const metadata = {}
  if (typeof value.toolCall === 'boolean') metadata.toolCall = value.toolCall
  if (Array.isArray(value.reasoningOptions) && value.reasoningOptions.length <= 16 && value.reasoningOptions.every(level => typeof level === 'string' && /^[a-z0-9_-]{1,32}$/.test(level))) metadata.reasoningOptions = [...new Set(value.reasoningOptions)]
  if (Array.isArray(value.input) && value.input.length > 0 && value.input.every(type => ['text', 'image', 'audio', 'video', 'pdf'].includes(type))) metadata.input = [...new Set(value.input)]
  for (const field of ['contextWindow', 'maxTokens']) if (Number.isSafeInteger(value[field]) && value[field] > 0 && value[field] <= 2147483647) metadata[field] = value[field]
  if (metadata.maxTokens > metadata.contextWindow) delete metadata.maxTokens
  return metadata
}

function renderedVariable(expressions, name) {
  const aliases = new Map([[name, new RegExp(`\\b${name}\\b`)]])
  const reads = expression => [...aliases.values()].some(pattern => pattern.test(expression))
  for (let pass = 0; pass < 8; pass++) {
    const previous = aliases.size
    for (const expression of expressions) {
      const assignment = /^\{%[-+]?\s*(?:set|for)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*(?:=|\bin\b)\s*([\s\S]*)/.exec(expression)
      if (assignment && !/\braise_exception\s*\(/.test(assignment[2]) && reads(assignment[2])) {
        if (aliases.size >= 64) return false
        aliases.set(assignment[1], new RegExp(`\\b${assignment[1].replaceAll('.', '\\.')}\\b`))
      }
    }
    if (aliases.size === previous) break
  }
  return expressions.some(expression => expression.startsWith('{{') && !/\braise_exception\s*\(/.test(expression) && reads(expression))
}

/** @returns {ModelMetadata} */
export function templateModelMetadata(template) {
  if (typeof template !== 'string' || template.length > 256 * 1024) return {}
  const blocks = [...template.replace(/\{#[\s\S]*?#\}/g, '').matchAll(/\{(?:%[\s\S]*?%|\{[\s\S]*?\})\}/g)].map(match => match[0])
  const expressions = blocks.map(block => block.replace(/\[['"]([a-zA-Z_]\w*)['"]\]|\.get\(['"]([a-zA-Z_]\w*)['"]\)/g, (_, bracket, get) => `.${bracket ?? get}`).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'))
  const metadata = {}
  if (renderedVariable(expressions, 'tools') && renderedVariable(expressions, 'tool_calls')) metadata.toolCall = true
  if (/\bif\b[^%}]*\benable_thinking\b/.test(expressions.join('\n')) && blocks.some(block => block.startsWith('{{') && !/\braise_exception\s*\(/.test(block) && /['"][^'"\n]*<think>/.test(block))) metadata.reasoningOptions = ['off', 'medium']
  return metadata
}

/** @returns {ModelMetadata} */
export function ggufModelMetadata(metadata) {
  const architecture = metadata['general.architecture']
  return {
    ...declaredModelMetadata({ contextWindow: metadata[`${architecture}.context_length`] }),
    ...templateModelMetadata(metadata['tokenizer.chat_template']),
  }
}

/** @returns {ModelMetadata} */
export function serverModelMetadata(props, configuration) {
  const metadata = {
    ...templateModelMetadata(props?.chat_template),
    ...templateModelMetadata(props?.chat_template_tool_use),
    ...declaredModelMetadata({ contextWindow: props?.default_generation_settings?.n_ctx }),
  }
  const caps = props?.chat_template_caps
  if (caps?.supports_tools === false || caps?.supports_tool_calls === false) metadata.toolCall = false
  else if (caps?.supports_tools === true && caps?.supports_tool_calls === true) metadata.toolCall = true
  if (typeof props?.modalities?.vision === 'boolean') metadata.input = configuration.backend === 'vision' && props.modalities.vision ? ['text', 'image'] : ['text']
  if (!configuration.chatReasoning) delete metadata.reasoningOptions
  return metadata
}
