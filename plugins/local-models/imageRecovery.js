import { modelIdentityReferences } from './modelToolSupport.js'
import { imageModelWarning } from './native/image/recipes.mjs'

const zImageTurboModels = new Set([
  'Tongyi-MAI/Z-Image-Turbo',
  'unsloth/Z-Image-Turbo-FP8',
  'leejet/Z-Image-Turbo-GGUF',
  'Comfy-Org/Z-Image-Turbo',
])

export function compatibleImageModel(source, models, specifications, resources, activeId) {
  const recipe = compatibleImageRecipe(source)
  if (!recipe) return undefined
  const candidates = models.filter(model => model.runtime === 'image' && model.imageArchitecture === recipe && !imageModelWarning(model, specifications.find(spec => spec.id === model.resources[1])))
  return candidates.find(model => model.id === activeId) ?? candidates.find(model => resources.some(resource => resource.id === model.resources[1] && resource.authorized)) ?? candidates[0]
}

export function compatibleImageRecipe(model) {
  if (model?.runtime !== 'image' || model.imageArchitecture !== 'checkpoint') return undefined
  if (model.origin?.source === 'huggingface' && model.origin.repository === 'unsloth/Z-Image-Turbo-FP8') return 'z-image-turbo'
  return modelIdentityReferences(model).some(reference => reference.providerId === 'huggingface' && zImageTurboModels.has(reference.modelId)) ? 'z-image-turbo' : undefined
}
