const prefix = 'EXTENSION_INFERENCE_'

export function classifyEngineFailure(text, fallback = `${prefix}LOAD_FAILED`) {
  const detail = String(text).slice(-65536)
  if (/bad_alloc|cannot allocate memory|failed to allocate|out of (?:device |host )?memory|ErrorOutOf(?:Device|Host)Memory|VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|CUDA_ERROR_OUT_OF_MEMORY/i.test(detail)) return `${prefix}RESOURCE_EXHAUSTED`
  if (/(?:unknown|unsupported|unrecognized|not supported).{0,50}(?:model architecture|architecture)|(?:model architecture|architecture).{0,50}(?:unknown|unsupported|not supported)/i.test(detail)) return `${prefix}MODEL_ARCHITECTURE_UNSUPPORTED`
  if (/(?:unknown|unsupported|unrecognized|not supported|invalid).{0,50}(?:quantization|quantisation|tensor type|ggml type)|(?:quantization|quantisation|tensor type|ggml type).{0,50}(?:unknown|unsupported|not supported)/i.test(detail)) return `${prefix}MODEL_QUANTIZATION_UNSUPPORTED`
  if (/CUDA driver version is insufficient|driver.{0,60}(?:incompatible|too old|mismatch)|no kernel image|unsupported (?:PTX|toolchain)|CUDA_ERROR_(?:SYSTEM_DRIVER_MISMATCH|INSUFFICIENT_DRIVER|UNSUPPORTED_PTX_VERSION)|VK_ERROR_INCOMPATIBLE_DRIVER|illegal instruction/i.test(detail)) return `${prefix}DRIVER_INCOMPATIBLE`
  if (/(?:failed|unable) to (?:initialize|initialise|load).{0,60}(?:CUDA|Vulkan|Metal|GPU)|no (?:CUDA|Vulkan|Metal|GPU).{0,30}devices?|(?:libcuda|libvulkan|cudart|cublas|ggml-cuda|ggml-vulkan).{0,100}(?:not found|cannot open|could not|missing)|VK_ERROR_INITIALIZATION_FAILED/i.test(detail)) return `${prefix}BACKEND_UNAVAILABLE`
  return fallback
}

export function checkEngineVersion(configuration) {
  const current = /^b(\d+)$/.exec(configuration.engineVersion ?? '')
  const minimum = /^b(\d+)$/.exec(configuration.minimumEngineVersion ?? '')
  if (current && minimum && BigInt(current[1]) < BigInt(minimum[1])) throw Error(`${prefix}ENGINE_TOO_OLD`)
}
