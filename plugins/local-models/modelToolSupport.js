import { declaredModelMetadata } from './native/chat/model-metadata.mjs'
export { declaredModelMetadata, ggufModelMetadata, templateModelMetadata } from './native/chat/model-metadata.mjs'

const repository = value => typeof value === 'string' && value.length <= 256 && /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/.test(value)

export function huggingFaceBaseModels(data) {
  const card = data.cardData?.base_model
  const declared = Array.isArray(card) ? card : typeof card === 'string' ? [card] : []
  const tags = Array.isArray(data.tags) ? data.tags : []
  const tagged = tags.flatMap(tag => typeof tag === 'string' && tag.startsWith('base_model:') ? [tag.slice('base_model:'.length).replace(/^quantized:/, '')] : [])
  return [...new Set([...declared, ...tagged].filter(repository))].slice(0, 9)
}

export function modelIdentityReferences(model) {
  if (model.origin?.source !== 'huggingface' || !/^[a-f0-9]{40}$/.test(model.origin.revision ?? '')) return []
  const sources = [...new Set([
    ...(Array.isArray(model.metadata?.baseModels) ? model.metadata.baseModels.filter(repository) : []),
    ...huggingFaceBaseModels({ tags: model.metadata?.tags }),
  ])]
  if (!sources.length && repository(model.origin.repository)) sources.push(model.origin.repository)
  return sources.length <= 8 ? sources.map(modelId => ({ providerId: 'huggingface', modelId })) : []
}

export function modelCatalogReferences(model) {
  const origin = model.origin
  if (origin?.source !== 'huggingface' || !/^[a-f0-9]{40}$/.test(origin.revision ?? '')) return []
  const quantized = model.metadata?.baseModelRelation === 'quantized'
  const sources = [...new Set([
    ...(repository(origin.repository) ? [origin.repository] : []),
    ...(quantized && Array.isArray(model.metadata?.baseModels) ? model.metadata.baseModels.filter(repository) : []),
    ...huggingFaceBaseModels({ tags: Array.isArray(model.metadata?.tags) ? model.metadata.tags.filter(tag => typeof tag === 'string' && tag.startsWith('base_model:quantized:')) : [] }),
  ])]
  return sources.length <= 8 ? sources.map(modelId => ({ providerId: 'huggingface', modelId })) : []
}

export function modelToolBinding(model, automatic, chatReasoning = false, chatModelMetadata = false) {
  const metadata = declaredModelMetadata(model.metadata?.capabilities)
  if (metadata.input) metadata.input = metadata.input.filter(type => type === 'text' || (type === 'image' && model.runtime === 'vision'))
  if (metadata.input?.length === 0) delete metadata.input
  return {
    tools: typeof metadata.toolCall === 'boolean' ? metadata.toolCall : automatic ? 'auto' : false,
    ...(chatReasoning ? { reasoning: metadata.reasoningOptions ? metadata.reasoningOptions.some(level => level !== 'off') : 'auto' } : {}),
    ...(automatic || chatReasoning ? { catalogModels: chatModelMetadata ? modelCatalogReferences(model) : modelIdentityReferences(model) } : {}),
    ...(chatModelMetadata && Object.keys(metadata).length ? { metadata } : {}),
  }
}
