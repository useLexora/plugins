const repository = value => typeof value === 'string' && value.length <= 256 && /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/.test(value)

export function huggingFaceBaseModels(data) {
  const card = data.cardData?.base_model
  const declared = Array.isArray(card) ? card : typeof card === 'string' ? [card] : []
  const tags = Array.isArray(data.tags) ? data.tags : []
  const tagged = tags.flatMap(tag => typeof tag === 'string' && tag.startsWith('base_model:') ? [tag.slice('base_model:'.length).replace(/^quantized:/, '')] : [])
  return [...new Set([...declared, ...tagged].filter(repository))].slice(0, 9)
}

export function modelCatalogReferences(model) {
  if (model.origin?.source !== 'huggingface' || !/^[a-f0-9]{40}$/.test(model.origin?.revision ?? '')) return []
  const sources = [...new Set([
    ...(Array.isArray(model.metadata?.baseModels) ? model.metadata.baseModels.filter(repository) : []),
    ...huggingFaceBaseModels({ tags: model.metadata?.tags }),
  ])]
  if (!sources.length && repository(model.origin.repository)) sources.push(model.origin.repository)
  return sources.length <= 8 ? sources.map(modelId => ({ providerId: 'huggingface', modelId })) : []
}

export function modelToolBinding(model, automatic, chatReasoning = false) {
  return {
    tools: automatic ? 'auto' : false,
    ...(chatReasoning ? { reasoning: 'auto' } : {}),
    ...(automatic || chatReasoning ? { catalogModels: modelCatalogReferences(model) } : {}),
  }
}
