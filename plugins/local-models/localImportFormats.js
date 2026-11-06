import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const MiB = 1024 ** 2
const decoder = new TextDecoder('utf-8', { fatal: true })
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
const fail = message => { throw Error(message) }
export const safePath = value => typeof value === 'string' && value.length <= 1024 && value.split('/').length <= 16 && value.split('/').every(part => part && !['.', '..'].includes(part) && !/[\\<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part))
export const checkAbort = signal => signal?.throwIfAborted()

class Reader {
  constructor(context, file, signal, budget) {
    this.context = context
    this.file = file
    this.signal = signal
    this.budget = budget
    this.offset = 0
    this.used = 0
    this.start = -1
    this.cache = new Uint8Array()
    this.proof = sha256.create()
    this.fields = 0
  }
  async bytes(length) {
    checkAbort(this.signal)
    const offset = this.offset
    if (!integer(length, 16 * MiB) || !integer(offset) || offset + length > this.file.bytes) fail('文件结构越界或已截断')
    this.offset += length
    if (!length) return new Uint8Array()
    if (offset >= this.start && offset + length <= this.start + this.cache.length) return this.cache.subarray(offset - this.start, offset - this.start + length)
    const result = new Uint8Array(length)
    for (let done = 0; done < length;) {
      checkAbort(this.signal)
      const position = offset + done
      const size = Math.min(Math.max(length - done, 1024), 128 * 1024, this.file.bytes - position)
      this.used += size; this.budget.bytes += size
      if (this.used > 16 * MiB || this.budget.bytes > 64 * MiB) fail('格式元数据超过解析上限，请缩小选择范围')
      const chunk = await this.context.resources.readBytes({ id: this.file.id }, { offset: position, length: size })
      checkAbort(this.signal)
      if (!(chunk.data instanceof Uint8Array) || chunk.data.length !== size || chunk.size !== this.file.bytes) fail('文件内容或大小已变化，请重新选择')
      this.start = position; this.cache = chunk.data
      this.proof.update(new TextEncoder().encode(`${position}:${size}:`)); this.proof.update(chunk.data)
      const take = Math.min(size, length - done)
      result.set(chunk.data.subarray(0, take), done); done += take
    }
    return result
  }
  skip(length) {
    if (!integer(length) || this.offset + length > this.file.bytes) fail('文件结构越界或已截断')
    this.offset += length
  }
  async number(length, signed = false) {
    const b = await this.bytes(length), v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const result = length === 8 ? Number(signed ? v.getBigInt64(0, true) : v.getBigUint64(0, true)) : length === 4 ? (signed ? v.getInt32(0, true) : v.getUint32(0, true)) : length === 2 ? (signed ? v.getInt16(0, true) : v.getUint16(0, true)) : (signed ? v.getInt8(0) : v.getUint8(0))
    if (!Number.isSafeInteger(result)) fail('文件数值超过安全范围')
    return result
  }
  async text(length, max = MiB) {
    if (!integer(length, max)) fail('格式字符串超过解析上限')
    return decoder.decode(await this.bytes(length))
  }
  async string() { return this.text(await this.number(8)) }
  async varint() {
    let value = 0, scale = 1
    for (let i = 0; i < 10; i++) {
      const byte = await this.number(1)
      value += (byte & 127) * scale
      if (!Number.isSafeInteger(value)) fail('Protobuf 数值越界')
      if (!(byte & 128)) return value
      scale *= 128
    }
    fail('无效 Protobuf varint')
  }
  async field(end) {
    if (++this.fields > 200000) fail('ONNX 结构超过解析上限')
    const tag = await this.varint(), id = Math.floor(tag / 8), wire = tag % 8
    if (!id || ![0, 1, 2, 5].includes(wire)) fail('无效 ONNX Protobuf 字段')
    const value = wire === 0 ? await this.varint() : undefined
    const length = wire === 2 ? await this.varint() : wire === 1 ? 8 : wire === 5 ? 4 : 0
    const stop = this.offset + length
    if (stop > end || this.offset > end) fail('ONNX 字段越界')
    return { id, wire, value, length, stop }
  }
  fingerprint() { return bytesToHex(this.proof.digest()) }
}

async function gguf(r) {
  if (await r.text(4) !== 'GGUF' || ![2, 3].includes(await r.number(4))) fail('不支持的 GGUF 版本')
  const count = await r.number(8), entries = await r.number(8)
  if (!count || count > 100000 || entries > 100000) fail('GGUF 张量或元数据数量不合法')
  const metadata = Object.create(null)
  async function value(type, depth = 0, retain = true) {
    if (depth > 1) fail('不支持的 GGUF 嵌套数组')
    if (type === 8) { const v = await r.string(); return retain ? v : undefined }
    if (type === 9) {
      const subtype = await r.number(4), size = await r.number(8)
      if (size > 1000000 || subtype === 9) fail('GGUF 数组超过解析上限')
      for (let i = 0; i < size; i++) await value(subtype, depth + 1, false)
      return { length: size }
    }
    const size = ({ 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 })[type]
    if (!size) fail('未知 GGUF 元数据类型')
    if (type === 6 || type === 12) { const b = await r.bytes(size); const v = new DataView(b.buffer, b.byteOffset, size); return size === 4 ? v.getFloat32(0, true) : v.getFloat64(0, true) }
    const v = await r.number(size, [1, 3, 5, 11].includes(type))
    if (type === 7 && v > 1) fail('无效 GGUF 布尔值')
    return type === 7 ? !!v : v
  }
  for (let i = 0; i < entries; i++) {
    const key = await r.string()
    if (Object.hasOwn(metadata, key)) fail('GGUF 元数据重复')
    metadata[key] = await value(await r.number(4))
  }
  if ((metadata['split.count'] ?? 1) !== 1 || (metadata['split.no'] ?? 0) !== 0 || metadata['general.type'] === 'adapter' || Object.keys(metadata).some(key => key.startsWith('adapter.'))) fail('不支持 GGUF 分片或适配器，请选择完整模型')
  const alignment = metadata['general.alignment'] ?? 32
  if (!integer(alignment, 4096) || !alignment || (alignment & (alignment - 1))) fail('GGUF 对齐参数不合法')
  const tensors = new Map(), spans = []
  const types = { 0: [1, 4], 1: [1, 2], 2: [32, 18], 3: [32, 20], 6: [32, 22], 7: [32, 24], 8: [32, 34], 9: [32, 40], 10: [256, 84], 11: [256, 110], 12: [256, 144], 13: [256, 176], 14: [256, 210], 15: [256, 292], 30: [1, 2] }
  for (let i = 0; i < count; i++) {
    const name = await r.string(), rank = await r.number(4)
    if (!rank || rank > 4 || tensors.has(name)) fail('GGUF 张量目录不合法')
    const shape = []
    for (let j = 0; j < rank; j++) shape.push(await r.number(8))
    const type = await r.number(4), offset = await r.number(8), encoding = types[type]
    if (!encoding) fail('暂不支持此 GGUF 量化编码，请选择 F16/BF16/Q4/Q5/Q6/Q8 或 K-quants')
    const elements = shape.reduce((a, b) => a * b, 1)
    if (!shape.every(n => n > 0) || !integer(elements) || shape[0] % encoding[0] || offset % alignment) fail('GGUF 张量形状或偏移不合法')
    tensors.set(name, shape); spans.push([offset, offset + elements / encoding[0] * encoding[1]])
  }
  const start = Math.ceil(r.offset / alignment) * alignment
  spans.sort((a, b) => a[0] - b[0])
  if (spans.some(([a, b], i) => !integer(b) || start + b > r.file.bytes || (i && a < spans[i - 1][1]))) fail('GGUF 张量越界或重叠')
  const architecture = metadata['general.architecture']
  if (architecture === 'clip') {
    const family = metadata['clip.projector_type']
    if (metadata['clip.has_vision_encoder'] !== true || !['qwen2vl', 'qwen3vl'].includes(family) || ![...tensors.keys()].some(k => k.startsWith('v.')) || ![...tensors.keys()].some(k => k.startsWith('mm.'))) fail('暂不支持此 GGUF 视觉投影架构')
    return { format: 'gguf', role: 'projector', family }
  }
  const supported = ['llama', 'qwen2', 'qwen3', 'qwen2vl', 'qwen3vl', 'gemma2', 'gemma3', 'phi3']
  if (!supported.includes(architecture) || (metadata['general.type'] && metadata['general.type'] !== 'model')) fail('暂不支持此 GGUF 模型架构或类型')
  const blocks = metadata[`${architecture}.block_count`], width = metadata[`${architecture}.embedding_length`]
  if (!integer(blocks, 256) || !blocks || !integer(width) || !width || !metadata['tokenizer.ggml.tokens']?.length || !metadata['tokenizer.ggml.model'] || tensors.get('token_embd.weight')?.[0] !== width || !tensors.has('output_norm.weight')) fail('GGUF 缺少完整语言模型结构或 tokenizer')
  if (tensors.get('token_embd.weight')?.[1] !== metadata['tokenizer.ggml.tokens'].length) fail('GGUF tokenizer 与 embedding 词表大小不匹配')
  for (let i = 0; i < blocks; i++) {
    const prefix = `blk.${i}.`
    const required = ['attn_norm.weight', 'attn_output.weight', 'ffn_norm.weight', 'ffn_up.weight', 'ffn_down.weight']
    if (required.some(key => !tensors.has(prefix + key)) || (!tensors.has(`${prefix}attn_qkv.weight`) && ['attn_q.weight', 'attn_k.weight', 'attn_v.weight'].some(key => !tensors.has(prefix + key)))) fail('GGUF 缺少完整模型层，可能是组件或分片')
  }
  return { format: 'gguf', role: 'model', architecture, vision: ['qwen2vl', 'qwen3vl'].includes(architecture), title: typeof metadata['general.name'] === 'string' ? metadata['general.name'].slice(0, 160) : undefined }
}

async function protobuf(r, end, visitor) {
  while (r.offset < end) {
    const f = await r.field(end)
    await visitor(f)
    if (r.offset > f.stop) fail('ONNX 消息结构越界')
    r.offset = f.stop
  }
}
async function valueInfo(r, end) {
  const info = { name: '', type: 0, shape: [] }
  await protobuf(r, end, async f => {
    if (f.id === 1 && f.wire === 2) info.name = await r.text(f.length, 4096)
    if (f.id === 2 && f.wire === 2) await protobuf(r, f.stop, async t => {
      if (t.id === 1 && t.wire === 2) await protobuf(r, t.stop, async v => {
        if (v.id === 1) info.type = v.value
        if (v.id === 2 && v.wire === 2) await protobuf(r, v.stop, async s => {
          if (s.id !== 1 || s.wire !== 2 || info.shape.length >= 8) fail('ONNX tensor shape 不支持')
          let dim = null
          await protobuf(r, s.stop, async d => { if (d.id === 1) dim = d.value })
          info.shape.push(dim)
        })
      })
    })
  })
  return info
}
async function onnx(r) {
  const metadata = Object.create(null), inputs = [], outputs = [], opsets = new Map()
  let ir = 0, graph = false, nodes = 0
  await protobuf(r, r.file.bytes, async f => {
    if (f.id === 1) ir = f.value
    if (f.id === 8 && f.wire === 2) {
      let domain = '', version = 0
      await protobuf(r, f.stop, async o => {
        if (o.id === 1) domain = await r.text(o.length, 256)
        if (o.id === 2) version = o.value
      })
      if (opsets.has(domain) || !version || version > ({ '': 21, 'ai.onnx': 21, 'ai.onnx.ml': 3, 'com.microsoft': 1 }[domain] ?? 0)) fail('ONNX opset 或自定义算子域不受当前适配支持')
      opsets.set(domain, version)
    }
    if (f.id === 14 && f.wire === 2) {
      let key = '', val = null
      await protobuf(r, f.stop, async m => {
        if (m.id === 1) key = await r.text(m.length, 4096)
        if (m.id === 2) val = await r.text(m.length, 65536)
      })
      if (!key || typeof val !== 'string' || Object.hasOwn(metadata, key) || Object.keys(metadata).length >= 256) fail('ONNX 元数据不合法')
      metadata[key] = val
    }
    if (f.id === 7 && f.wire === 2) {
      if (graph) fail('ONNX 重复 graph')
      graph = true
      await protobuf(r, f.stop, async g => {
        if (g.id === 1) { if (g.wire !== 2 || !g.length) fail('ONNX 节点为空'); nodes++ }
        if ([11, 12].includes(g.id) && g.wire === 2) {
          if (g.length > 65536 || inputs.length + outputs.length >= 1024) fail('ONNX 接口超过解析上限')
          ;(g.id === 11 ? inputs : outputs).push(await valueInfo(r, g.stop))
        }
        if (g.id === 15) fail('暂不支持 ONNX 稀疏权重')
        if (g.id === 5 && g.wire === 2) await protobuf(r, g.stop, async t => {
          if (t.id === 13 || (t.id === 14 && t.value === 1)) fail('不支持 ONNX external_data 分片，请使用内嵌权重模型')
        })
      })
    }
  })
  if (!ir || ir > 10 || !(opsets.get('') ?? opsets.get('ai.onnx')) || !graph || !nodes || !inputs.length || !outputs.length) fail('ONNX 缺少有效图结构或版本不受支持')
  const positive = key => /^\d+$/.test(metadata[key] ?? '') && Number(metadata[key]) > 0 && Number(metadata[key]) <= 1000000
  const vector = key => /^\d+(,\d+)*$/.test(metadata[key] ?? '') && metadata[key].split(',').every(n => Number(n) > 0 && Number(n) <= 1000000)
  const names = inputs.map(i => i.name).join(',')
  if (metadata.model_type === 'kokoro') {
    const style = (metadata.style_dim ?? '').split(',').map(Number)
    if (!positive('sample_rate') || !positive('n_speakers') || !['0', '1'].includes(metadata.has_espeak) || style.length !== 3 || style[0] < 2 || style[0] > 8192 || style[1] !== 1 || style[2] !== 256 || inputs.length !== 3 || inputs[0].type !== 7 || inputs[0].shape.length !== 2 || inputs[1].type !== 1 || inputs[1].shape.at(-1) !== 256 || inputs[2].type !== 1 || outputs.length !== 1 || outputs[0].type !== 1) fail('Kokoro 元数据或图接口与当前 sherpa 适配不匹配')
    return { format: 'onnx', family: 'kokoro', role: 'model', voicesBytes: style[0] * style[2] * Number(metadata.n_speakers) * 4, espeak: metadata.has_espeak === '1' }
  }
  if (names.startsWith('x,') && outputs[0].name === 'encoder_out') {
    const family = metadata.model_type
    const vectors = family === 'zipformer' ? ['encoder_dims', 'attention_dims', 'num_encoder_layers', 'cnn_module_kernels', 'left_context_len'] : ['encoder_dims', 'query_head_dims', 'value_head_dims', 'num_heads', 'num_encoder_layers', 'cnn_module_kernels', 'left_context_len']
    if (!['zipformer', 'zipformer2'].includes(family) || !positive('T') || !positive('decode_chunk_len') || !vectors.every(vector) || inputs[0].type !== 1 || inputs[0].shape.at(-1) !== 80 || outputs[0].type !== 1 || (metadata.feature && metadata.feature !== 'fbank')) fail('仅支持带流式元数据、80 维 fbank 的 Zipformer/Zipformer2')
    const count = metadata.encoder_dims.split(',').length, layers = metadata.num_encoder_layers.split(',').map(Number)
    const stateCount = family === 'zipformer' ? count * 7 : layers.reduce((a, b) => a + b, 0) * 6 + 2
    if (vectors.some(key => metadata[key].split(',').length !== count) || inputs.length !== stateCount + 1 || outputs.length !== inputs.length || inputs[0].shape.length !== 3 || outputs[0].shape.length !== 3 || !outputs[0].shape.at(-1) || inputs.slice(1).some((input, i) => outputs[i + 1].name !== `new_${input.name}` || outputs[i + 1].type !== input.type)) fail('Zipformer 流式缓存接口或元数据维度不完整')
    return { format: 'onnx', family, role: 'encoder', width: outputs[0].shape.at(-1) }
  }
  if (names === 'y' && outputs.length === 1 && outputs[0].name === 'decoder_out' && inputs[0].type === 7 && inputs[0].shape.length === 2 && inputs[0].shape[1] === Number(metadata.context_size) && outputs[0].type === 1 && outputs[0].shape.length === 2 && outputs[0].shape[1] > 0 && positive('vocab_size') && positive('context_size')) return { format: 'onnx', family: 'transducer', role: 'decoder', vocab: Number(metadata.vocab_size), width: outputs[0].shape.at(-1) }
  if (names === 'encoder_out,decoder_out' && positive('joiner_dim') && outputs.length === 1 && outputs[0].name === 'logit' && inputs.every(i => i.type === 1 && i.shape.length === 2 && i.shape[1] === Number(metadata.joiner_dim)) && outputs[0].type === 1 && outputs[0].shape.length === 2 && outputs[0].shape[1] > 0) return { format: 'onnx', family: 'transducer', role: 'joiner', widths: inputs.map(i => i.shape.at(-1)), vocab: outputs[0].shape.at(-1) }
  fail('ONNX 不是当前适配的流式 Zipformer 或 sherpa Kokoro；不能按文件名推断架构')
}

async function safetensors(r) {
  const length = await r.number(8)
  if (!length || length > 8 * MiB || length + 8 >= r.file.bytes) fail('safetensors header 大小不合法')
  const header = JSON.parse(await r.text(length, 8 * MiB))
  if (!header || Array.isArray(header) || typeof header !== 'object') fail('safetensors header 不合法')
  const tensors = Object.entries(header).filter(([k]) => k !== '__metadata__')
  if (!tensors.length || tensors.length > 20000) fail('safetensors 张量数量不合法')
  if (tensors.some(([key]) => /(?:^|\.)_weight_(?:qdata|scale)(?:\.|$)/.test(key))) fail('TorchAO 量化组件不支持当前完整检查点路径；Z-Image Turbo 需独立的兼容 diffusion、Qwen3 文本编码器与 FLUX VAE 配方，原文件不会被改写')
  if (tensors.some(([k]) => /lora_|\.lora_|lora\.|adapter|control_model\./i.test(k))) fail('不支持 LoRA、适配器或 ControlNet，请选择完整检查点')
  const ranges = []
  for (const [, t] of tensors) {
    const unit = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 }[t?.dtype]
    if (!unit || !Array.isArray(t.shape) || t.shape.length > 8 || !t.shape.every(n => integer(n) && n > 0) || !Array.isArray(t.data_offsets) || t.data_offsets.length !== 2) fail('safetensors tensor 格式不支持')
    const [start, end] = t.data_offsets, bytes = t.shape.reduce((a, b) => a * b, unit)
    if (!integer(bytes) || !integer(start) || !integer(end) || end - start !== bytes || end > r.file.bytes - 8 - length) fail('safetensors tensor 形状、长度或偏移不合法')
    ranges.push([start, end])
  }
  ranges.sort((a, b) => a[0] - b[0])
  if (ranges[0][0] !== 0 || ranges.some(([s], i) => i && s !== ranges[i - 1][1]) || ranges.at(-1)[1] !== r.file.bytes - 8 - length) fail('safetensors 数据不完整、重叠或有未声明内容')
  const has = (key, shape) => header[key] && (!shape || JSON.stringify(header[key].shape) === JSON.stringify(shape))
  const unet = 'model.diffusion_model.'
  const sd1 = has('cond_stage_model.transformer.text_model.embeddings.token_embedding.weight', [49408, 768])
  const sdxl = has('conditioner.embedders.0.transformer.text_model.embeddings.token_embedding.weight', [49408, 768]) && has('conditioner.embedders.1.model.token_embedding.weight', [49408, 1280])
  if (sd1 === sdxl || !has(`${unet}input_blocks.0.0.weight`, [320, 4, 3, 3]) || !has(`${unet}out.2.weight`, [4, 320, 3, 3])) fail('仅支持原始 LDM 命名的 SD1/SDXL base 完整检查点；不支持组件、SD2、refiner、Flux 或分片')
  const context = sd1 ? 768 : 2048, blocks = sd1 ? 12 : 9
  const required = [`${unet}time_embed.0.weight`, `${unet}time_embed.2.weight`, 'first_stage_model.encoder.conv_in.weight', 'first_stage_model.encoder.conv_out.weight', 'first_stage_model.decoder.conv_in.weight', 'first_stage_model.decoder.conv_out.weight', 'first_stage_model.quant_conv.weight', 'first_stage_model.post_quant_conv.weight']
  for (let i = 1; i < blocks; i++) required.push(`${unet}input_blocks.${i}.0.${(sd1 ? [3, 6, 9] : [3, 6]).includes(i) ? 'op' : 'in_layers.2'}.weight`)
  for (let i = 0; i < blocks; i++) required.push(`${unet}output_blocks.${i}.0.in_layers.2.weight`, `${unet}output_blocks.${i}.0.out_layers.3.weight`)
  required.push(`${unet}middle_block.0.in_layers.2.weight`, `${unet}middle_block.2.in_layers.2.weight`)
  const clip = sd1 ? 'cond_stage_model.transformer.text_model' : 'conditioner.embedders.0.transformer.text_model'
  required.push(`${clip}.embeddings.position_embedding.weight`, `${clip}.final_layer_norm.weight`)
  for (let i = 0; i < 12; i++) for (const suffix of ['self_attn.k_proj.weight', 'self_attn.v_proj.weight', 'self_attn.q_proj.weight', 'self_attn.out_proj.weight', 'mlp.fc1.weight', 'mlp.fc2.weight']) required.push(`${clip}.encoder.layers.${i}.${suffix}`)
  if (sdxl) {
    required.push(`${unet}label_emb.0.0.weight`, 'conditioner.embedders.1.model.positional_embedding', 'conditioner.embedders.1.model.ln_final.weight')
    for (let i = 0; i < 32; i++) for (const suffix of ['attn.in_proj_weight', 'attn.out_proj.weight', 'mlp.c_fc.weight', 'mlp.c_proj.weight']) required.push(`conditioner.embedders.1.model.transformer.resblocks.${i}.${suffix}`)
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) for (const c of ['conv1', 'conv2']) required.push(`first_stage_model.encoder.down.${i}.block.${j}.${c}.weight`)
    for (let j = 0; j < 3; j++) for (const c of ['conv1', 'conv2']) required.push(`first_stage_model.decoder.up.${i}.block.${j}.${c}.weight`)
  }
  for (const side of ['encoder', 'decoder']) for (const suffix of ['block_1.conv1', 'block_1.conv2', 'block_2.conv1', 'block_2.conv2', 'attn_1.q', 'attn_1.k', 'attn_1.v', 'attn_1.proj_out']) required.push(`first_stage_model.${side}.mid.${suffix}.weight`)
  const expected = {
    [`${unet}time_embed.0.weight`]: [1280, 320], [`${unet}time_embed.2.weight`]: [1280, 1280],
    'first_stage_model.encoder.conv_in.weight': [128, 3, 3, 3], 'first_stage_model.encoder.conv_out.weight': [8, 512, 3, 3],
    'first_stage_model.decoder.conv_in.weight': [512, 4, 3, 3], 'first_stage_model.decoder.conv_out.weight': [3, 128, 3, 3],
    'first_stage_model.quant_conv.weight': [8, 8, 1, 1], 'first_stage_model.post_quant_conv.weight': [4, 4, 1, 1],
    [`${clip}.embeddings.position_embedding.weight`]: [77, 768], [`${clip}.final_layer_norm.weight`]: [768],
  }
  for (let i = 0; i < 12; i++) for (const [key, shape] of Object.entries({ 'self_attn.k_proj.weight': [768, 768], 'self_attn.v_proj.weight': [768, 768], 'self_attn.q_proj.weight': [768, 768], 'self_attn.out_proj.weight': [768, 768], 'mlp.fc1.weight': [3072, 768], 'mlp.fc2.weight': [768, 3072] })) expected[`${clip}.encoder.layers.${i}.${key}`] = shape
  if (sdxl) {
    expected['conditioner.embedders.1.model.positional_embedding'] = [77, 1280]
    expected['conditioner.embedders.1.model.ln_final.weight'] = [1280]
    for (let i = 0; i < 32; i++) for (const [key, shape] of Object.entries({ 'attn.in_proj_weight': [3840, 1280], 'attn.out_proj.weight': [1280, 1280], 'mlp.c_fc.weight': [5120, 1280], 'mlp.c_proj.weight': [1280, 5120] })) expected[`conditioner.embedders.1.model.transformer.resblocks.${i}.${key}`] = shape
  }
  const stages = sd1 ? [[320, 1], [640, 1], [1280, 1], [1280, 0]] : [[320, 0], [640, 2], [1280, 10]]
  /** @type {Array<[string, number, number]>} */
  const attention = [['middle_block.1', 1280, sd1 ? 1 : 10]]
  for (const [stage, [channels, depth]] of stages.entries()) {
    if (!depth) continue
    for (let block = 0; block < 2; block++) attention.push([`input_blocks.${stage * 3 + block + 1}.1`, channels, depth])
    for (let block = 0; block < 3; block++) attention.push([`output_blocks.${(stages.length - stage - 1) * 3 + block}.1`, channels, depth])
  }
  const requireShape = (key, shape) => { required.push(unet + key); expected[unet + key] = shape }
  for (const [path, channels, depth] of attention) {
    for (const key of ['norm.weight', 'norm.bias', 'proj_in.bias', 'proj_out.bias']) requireShape(`${path}.${key}`, [channels])
    for (const key of ['proj_in.weight', 'proj_out.weight']) requireShape(`${path}.${key}`, sd1 ? [channels, channels, 1, 1] : [channels, channels])
    for (let layer = 0; layer < depth; layer++) {
      const prefix = `${path}.transformer_blocks.${layer}`
      for (const norm of ['norm1', 'norm2', 'norm3']) for (const suffix of ['weight', 'bias']) requireShape(`${prefix}.${norm}.${suffix}`, [channels])
      for (const kind of ['attn1', 'attn2']) {
        requireShape(`${prefix}.${kind}.to_q.weight`, [channels, channels])
        for (const key of ['to_k.weight', 'to_v.weight']) requireShape(`${prefix}.${kind}.${key}`, [channels, kind === 'attn2' ? context : channels])
        requireShape(`${prefix}.${kind}.to_out.0.weight`, [channels, channels])
        requireShape(`${prefix}.${kind}.to_out.0.bias`, [channels])
      }
      requireShape(`${prefix}.ff.net.0.proj.weight`, [channels * 8, channels])
      requireShape(`${prefix}.ff.net.0.proj.bias`, [channels * 8])
      requireShape(`${prefix}.ff.net.2.weight`, [channels, channels * 4])
      requireShape(`${prefix}.ff.net.2.bias`, [channels])
    }
  }
  if (required.some(k => !has(k))) fail('检查点缺少 UNet、VAE 或 text encoder 的必要张量；组件/分片不能独立运行')
  if (Object.entries(expected).some(([key, shape]) => !has(key, shape)) || required.some(key => !['F16', 'BF16', 'F32'].includes(header[key].dtype))) fail('检查点必要张量形状或精度与 SD1/SDXL 不匹配')
  for (const key of required.filter(key => /(?:in_layers\.2|out_layers\.3|\.op|\.conv[12])\.weight$/.test(key))) {
    const shape = header[key].shape
    if (shape.length !== 4 || shape[2] !== 3 || shape[3] !== 3) fail('检查点卷积张量结构不完整')
  }
  return { format: 'safetensors', role: 'model', architecture: sd1 ? 'sd1' : 'sdxl' }
}

async function traineddata(r) {
  const count = await r.number(4)
  if (count < 24 || count > 64 || 4 + 8 * count >= r.file.bytes) fail('traineddata 组件表不合法或不是 LSTM 数据')
  const offsets = []
  let previous = 4 + 8 * count - 1
  for (let i = 0; i < count; i++) {
    const offset = await r.number(8, true)
    if (offset !== -1 && (offset <= previous || offset >= r.file.bytes)) fail('traineddata 组件偏移越界、倒序或重叠')
    offsets.push(offset)
    if (offset !== -1) previous = offset
  }
  if ([17, 21, 22].some(i => offsets[i] === -1)) fail('traineddata 缺少 LSTM、字符集或编码组件，当前 OCR 引擎不支持')
  return { format: 'traineddata', role: 'language' }
}

export async function parseFile(context, file, signal, budget = { bytes: 0 }) {
  const r = new Reader(context, file, signal, budget)
  let info
  if (/\.gguf$/i.test(file.path)) info = await gguf(r)
  else if (/\.onnx$/i.test(file.path)) info = await onnx(r)
  else if (/\.safetensors$/i.test(file.path)) info = await safetensors(r)
  else if (/\.traineddata$/i.test(file.path)) info = await traineddata(r)
  else if (/(?:^|\/)(?:tokens|lexicon[^/]*)\.txt$/.test(file.path)) {
    if (file.bytes > MiB || !file.bytes) fail('词表或词典大小超过 1 MiB 解析上限')
    const text = await r.text(file.bytes), lines = text.trimEnd().split(/\r?\n/)
    if (text.includes('\0') || lines.length > 100000) fail('词表或词典内容不合法')
    if (file.name === 'tokens.txt') {
      const ids = new Set()
      for (const line of lines) {
        const match = /^(.+?)\s+(\d+)$/.exec(line)
        if (!match || ids.has(Number(match[2])) || Number(match[2]) > 1000000) fail('词表必须为唯一 token 与数字 ID 的逐行格式')
        ids.add(Number(match[2]))
      }
      if (!ids.has(0)) fail('词表缺少 ID 0')
      info = { format: 'tokens', role: 'tokens', vocab: ids.size, maxId: [...ids].reduce((max, id) => Math.max(max, id), 0) }
    } else {
      if (!lines.every(line => /^\S+\s+\S/.test(line))) fail('发音词典格式不合法')
      info = { format: 'lexicon', role: 'lexicon' }
    }
  } else if (/\.bin$/i.test(file.path) && /voices/i.test(file.name)) {
    if (!file.bytes || file.bytes % 4) fail('Kokoro 音色数据长度不合法')
    const sample = await r.bytes(Math.min(file.bytes, 1024)), view = new DataView(sample.buffer, sample.byteOffset, sample.length)
    for (let i = 0; i < sample.length; i += 4) if (!Number.isFinite(view.getFloat32(i, true))) fail('Kokoro 音色数据包含非有限数值')
    info = { format: 'voices', role: 'voices' }
  } else if (/(?:^|\/)espeak-ng-data\//.test(file.path)) {
    if (!file.bytes || file.bytes > 32 * MiB) fail('espeak 配套文件大小不合法')
    await r.bytes(Math.min(64, file.bytes))
    info = { format: 'espeak', role: 'companion' }
  } else fail('不支持此格式；不接受 ckpt、LoRA、归档或拆分组件')
  return { ...info, fingerprint: r.fingerprint() }
}
