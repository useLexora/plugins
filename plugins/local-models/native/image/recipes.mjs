export const zImageTurbo = {
  architecture: 'z-image-turbo',
  repository: 'leejet/Z-Image-Turbo-GGUF',
  revision: 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085',
  files: [
    { role: 'diffusion', title: 'Z-Image Turbo · Q4_K', path: 'z_image_turbo-Q4_K.gguf', repository: 'leejet/Z-Image-Turbo-GGUF', revision: 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085', sourcePath: 'z_image_turbo-Q4_K.gguf', sha256: '14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd', bytes: 3864250304 },
    { role: 'llm', title: 'Qwen3-4B Instruct 2507 · Q4_K_M', path: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', repository: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: 'a06e946bb6b655725eafa393f4a9745d460374c9', sourcePath: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597', bytes: 2497281120 },
    { role: 'vae', title: 'FLUX Autoencoder · ae', path: 'ae.safetensors', repository: 'Comfy-Org/Z-Image-Turbo', revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', sourcePath: 'split_files/vae/ae.safetensors', sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38', bytes: 335304388 },
  ],
}

export const zImageTurboFiles = zImageTurbo.files.map(file => ({ ...file, url: `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.sourcePath}` }))

export function checkpointValidationValid(validation) {
  return validation?.version === 1 && validation.kind === 'ldm-header' && ['sd1', 'sdxl'].includes(validation.architecture) && /^[a-f0-9]{64}$/.test(validation.sha256 ?? '')
}

export function imageModelWarning(model, specification) {
  if (model.runtime !== 'image') return ''
  if (model.imageArchitecture === 'checkpoint') {
    const validation = model.imageValidation
    const file = specification?.files?.find(file => file.path === model.files?.model)
    return checkpointValidationValid(validation) && file?.sha256 === validation.sha256 ? '' : '此检查点记录尚无完整结构验证，需重新导入原文件验证；原模型身份、文件、选择和参数均已保留。单独 diffusion 或 TorchAO FP8 权重不能按完整检查点加载。'
  }
  if (model.imageArchitecture === zImageTurbo.architecture) {
    return zImageTurboFiles.every(expected => specification?.files?.some(file => file.path === model.files?.[expected.role] && file.sha256 === expected.sha256 && (file.bytes ?? file.size) === expected.bytes)) ? '' : 'Z-Image Turbo 三组件配方尚未完整验证；请使用指定版本的 diffusion、Qwen3 文本编码器和 FLUX VAE，原文件和配置已保留。'
  }
  return model.id === 'qwen-image' && model.resources[1] === 'qwen-image-model' ? '' : '此图像模型记录尚无已验证的架构与组件配方，文件和配置已保留。'
}
