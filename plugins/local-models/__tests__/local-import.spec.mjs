import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createLocalImport } from '../localImport.js'

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const string = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)])
const hash = data => createHash('sha256').update(data).digest('hex')
function gguf({ architecture = 'qwen3', split = false, projector = false, type = 'model' } = {}) {
  const metadata = {
    'general.architecture': projector ? 'clip' : architecture,
    'general.type': type,
    'general.name': 'Tiny structured model',
    ...(projector ? { 'clip.projector_type': architecture, 'clip.has_vision_encoder': true } : { [`${architecture}.block_count`]: 1, [`${architecture}.embedding_length`]: 4, 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': ['a', 'b'] }),
    ...(split ? { 'split.count': 2 } : {}),
  }
  const pairs = Object.entries(metadata).map(([key, val]) => Buffer.concat([string(key), typeof val === 'string' ? Buffer.concat([u32(8), string(val)]) : typeof val === 'boolean' ? Buffer.concat([u32(7), Buffer.from([Number(val)])]) : Array.isArray(val) ? Buffer.concat([u32(9), u32(8), u64(val.length), ...val.map(string)]) : Buffer.concat([u32(4), u32(val)])]))
  const tensors = projector ? [['v.patch_embd.weight', [4, 4]], ['mm.0.weight', [4, 4]]] : [
    ['token_embd.weight', [4, 2]], ['output_norm.weight', [4]],
    ...['attn_norm', 'attn_output', 'ffn_norm', 'ffn_up', 'ffn_down', 'attn_q', 'attn_k', 'attn_v'].map(key => [`blk.0.${key}.weight`, [4, 4]]),
  ]
  let offset = 0
  const directory = tensors.map(([name, shape]) => {
    const entry = Buffer.concat([string(name), u32(shape.length), ...shape.map(u64), u32(0), u64(offset)])
    offset += Math.ceil(shape.reduce((a, b) => a * b, 4) / 32) * 32
    return entry
  })
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(pairs.length), ...pairs, ...directory])
  return Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 32) * 32 - header.length), Buffer.alloc(offset)])
}
const varint = n => {
  const out = []
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}
const p = (id, value) => typeof value === 'number' ? Buffer.concat([varint(id * 8), varint(value)]) : Buffer.concat([varint(id * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)])
const msg = (...parts) => Buffer.concat(parts)
const valueInfo = ([name, type, shape]) => msg(p(1, name), p(2, p(1, msg(p(1, type), p(2, msg(...shape.map(dim => p(1, dim === null ? p(2, 'N') : p(1, dim)))))))))
function onnx({ role = 'model', family = 'kokoro', metadata: overrides = {}, external = false, arbitrary = false } = {}) {
  let metadata, inputs, outputs
  if (family === 'kokoro') {
    metadata = { model_type: 'kokoro', sample_rate: '24000', n_speakers: '1', style_dim: '2,1,256', has_espeak: '1' }
    inputs = [['tokens', 7, [1, null]], ['style', 1, [1, 256]], ['speed', 1, [1]]]
    outputs = [['audio', 1, [1, null]]]
  } else if (role === 'encoder') {
    metadata = { model_type: family, T: '39', decode_chunk_len: '32', encoder_dims: '4', attention_dims: '4', num_encoder_layers: '1', cnn_module_kernels: '3', left_context_len: '16' }
    const states = ['cached_len', 'cached_avg', 'cached_key', 'cached_val', 'cached_val2', 'cached_conv1', 'cached_conv2'].map((name, i) => [`${name}_0`, i === 0 ? 7 : 1, [1, 1]])
    inputs = [['x', 1, [1, 39, 80]], ...states]
    outputs = [['encoder_out', 1, [1, null, 4]], ...states.map(([name, type, shape]) => [`new_${name}`, type, shape])]
  } else if (role === 'decoder') {
    metadata = { vocab_size: '2', context_size: '2' }
    inputs = [['y', 7, [1, 2]]]; outputs = [['decoder_out', 1, [1, 4]]]
  } else {
    metadata = { joiner_dim: '4' }
    inputs = [['encoder_out', 1, [1, 4]], ['decoder_out', 1, [1, 4]]]; outputs = [['logit', 1, [1, 2]]]
  }
  metadata = arbitrary ? {} : { ...metadata, ...overrides }
  const node = msg(p(1, inputs[0][0]), p(2, outputs[0][0]), p(4, 'Identity'))
  const initializer = msg(p(1, 1), p(2, 1), p(8, 'weight'), p(9, Buffer.alloc(4)), ...(external ? [p(13, msg(p(1, 'location'), p(2, '../weights.bin'))), p(14, 1)] : []))
  return msg(p(1, 9), p(8, msg(p(1, ''), p(2, 17))), p(7, msg(p(1, node), p(5, initializer), ...inputs.map(i => p(11, valueInfo(i))), ...outputs.map(i => p(12, valueInfo(i))))), ...Object.entries(metadata).map(([k, v]) => p(14, msg(p(1, k), p(2, String(v))))))
}
function traineddata() {
  const count = 24, head = 4 + count * 8
  const offsets = Array(count).fill(-1)
  offsets[17] = head; offsets[21] = head + 8; offsets[22] = head + 16; offsets[23] = head + 24
  return msg(u32(count), ...offsets.map(u64), Buffer.alloc(32))
}
function checkpoint(architecture = 'sd1', omit = '', overrides = {}) {
  const shapes = {}, put = (key, shape = [1]) => { if (key !== omit) shapes[key] = shape }
  const sd1 = architecture === 'sd1', unet = 'model.diffusion_model.', blocks = sd1 ? 12 : 9
  put(`${unet}input_blocks.0.0.weight`, [320, 4, 3, 3]); put(`${unet}out.2.weight`, [4, 320, 3, 3])
  for (const key of ['time_embed.0.weight', 'time_embed.2.weight', 'middle_block.0.in_layers.2.weight', 'middle_block.2.in_layers.2.weight', 'middle_block.1.proj_in.weight']) put(unet + key)
  for (let i = 1; i < blocks; i++) put(`${unet}input_blocks.${i}.0.${(sd1 ? [3, 6, 9] : [3, 6]).includes(i) ? 'op' : 'in_layers.2'}.weight`)
  for (let i = 0; i < blocks; i++) for (const suffix of ['in_layers.2', 'out_layers.3']) put(`${unet}output_blocks.${i}.0.${suffix}.weight`)
  for (const key of ['encoder.conv_in', 'encoder.conv_out', 'decoder.conv_in', 'decoder.conv_out', 'quant_conv', 'post_quant_conv']) put(`first_stage_model.${key}.weight`)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) for (const c of ['conv1', 'conv2']) put(`first_stage_model.encoder.down.${i}.block.${j}.${c}.weight`)
    for (let j = 0; j < 3; j++) for (const c of ['conv1', 'conv2']) put(`first_stage_model.decoder.up.${i}.block.${j}.${c}.weight`)
  }
  for (const side of ['encoder', 'decoder']) for (const suffix of ['block_1.conv1', 'block_1.conv2', 'block_2.conv1', 'block_2.conv2', 'attn_1.q', 'attn_1.k', 'attn_1.v', 'attn_1.proj_out']) put(`first_stage_model.${side}.mid.${suffix}.weight`)
  const clip = sd1 ? 'cond_stage_model.transformer.text_model' : 'conditioner.embedders.0.transformer.text_model'
  put(`${clip}.embeddings.token_embedding.weight`, [49408, 768]); put(`${clip}.embeddings.position_embedding.weight`); put(`${clip}.final_layer_norm.weight`)
  for (let i = 0; i < 12; i++) for (const key of ['self_attn.k_proj.weight', 'self_attn.v_proj.weight', 'self_attn.q_proj.weight', 'self_attn.out_proj.weight', 'mlp.fc1.weight', 'mlp.fc2.weight']) put(`${clip}.encoder.layers.${i}.${key}`)
  if (!sd1) {
    put(`${unet}label_emb.0.0.weight`); put('conditioner.embedders.1.model.token_embedding.weight', [49408, 1280]); put('conditioner.embedders.1.model.positional_embedding'); put('conditioner.embedders.1.model.ln_final.weight')
    for (let i = 0; i < 32; i++) for (const key of ['attn.in_proj_weight', 'attn.out_proj.weight', 'mlp.c_fc.weight', 'mlp.c_proj.weight']) put(`conditioner.embedders.1.model.transformer.resblocks.${i}.${key}`)
  }
  const attentionGroups = sd1
    ? [['input_blocks', [1, 2], 320, 1], ['input_blocks', [4, 5], 640, 1], ['input_blocks', [7, 8], 1280, 1], ['output_blocks', [3, 4, 5], 1280, 1], ['output_blocks', [6, 7, 8], 640, 1], ['output_blocks', [9, 10, 11], 320, 1]]
    : [['input_blocks', [4, 5], 640, 2], ['input_blocks', [7, 8], 1280, 10], ['output_blocks', [0, 1, 2], 1280, 10], ['output_blocks', [3, 4, 5], 640, 2]]
  const attention = [['middle_block.1', 1280, sd1 ? 1 : 10], ...attentionGroups.flatMap(([side, indices, channels, depth]) => indices.map(index => [`${side}.${index}.1`, channels, depth]))]
  for (const [path, channels, depth] of attention) {
    for (const key of ['norm.weight', 'norm.bias', 'proj_in.bias', 'proj_out.bias']) put(`${unet}${path}.${key}`, [channels])
    for (const key of ['proj_in.weight', 'proj_out.weight']) put(`${unet}${path}.${key}`, sd1 ? [channels, channels, 1, 1] : [channels, channels])
    for (let layer = 0; layer < depth; layer++) {
      const prefix = `${unet}${path}.transformer_blocks.${layer}`
      for (const norm of ['norm1', 'norm2', 'norm3']) for (const key of ['weight', 'bias']) put(`${prefix}.${norm}.${key}`, [channels])
      for (const kind of ['attn1', 'attn2']) {
        put(`${prefix}.${kind}.to_q.weight`, [channels, channels])
        for (const key of ['to_k.weight', 'to_v.weight']) put(`${prefix}.${kind}.${key}`, [channels, kind === 'attn1' ? channels : sd1 ? 768 : 2048])
        put(`${prefix}.${kind}.to_out.0.weight`, [channels, channels]); put(`${prefix}.${kind}.to_out.0.bias`, [channels])
      }
      put(`${prefix}.ff.net.0.proj.weight`, [8 * channels, channels]); put(`${prefix}.ff.net.0.proj.bias`, [8 * channels])
      put(`${prefix}.ff.net.2.weight`, [channels, 4 * channels]); put(`${prefix}.ff.net.2.bias`, [channels])
    }
  }
  for (const [key, shape] of Object.entries(shapes)) {
    if (shape.length !== 1 || shape[0] !== 1) continue
    if (/time_embed\.0\.weight$/.test(key)) shapes[key] = [1280, 320]
    else if (/time_embed\.2\.weight$/.test(key)) shapes[key] = [1280, 1280]
    else if (key === 'first_stage_model.encoder.conv_in.weight') shapes[key] = [128, 3, 3, 3]
    else if (key === 'first_stage_model.encoder.conv_out.weight') shapes[key] = [8, 512, 3, 3]
    else if (key === 'first_stage_model.decoder.conv_in.weight') shapes[key] = [512, 4, 3, 3]
    else if (key === 'first_stage_model.decoder.conv_out.weight') shapes[key] = [3, 128, 3, 3]
    else if (key === 'first_stage_model.quant_conv.weight') shapes[key] = [8, 8, 1, 1]
    else if (key === 'first_stage_model.post_quant_conv.weight') shapes[key] = [4, 4, 1, 1]
    else if (key.endsWith('.position_embedding.weight')) shapes[key] = [77, 768]
    else if (key.endsWith('.final_layer_norm.weight')) shapes[key] = [768]
    else if (key.includes('.self_attn.')) shapes[key] = [768, 768]
    else if (key.endsWith('.mlp.fc1.weight')) shapes[key] = [3072, 768]
    else if (key.endsWith('.mlp.fc2.weight')) shapes[key] = [768, 3072]
    else if (key.endsWith('.positional_embedding')) shapes[key] = [77, 1280]
    else if (key.endsWith('.ln_final.weight')) shapes[key] = [1280]
    else if (key.endsWith('.attn.in_proj_weight')) shapes[key] = [3840, 1280]
    else if (key.endsWith('.attn.out_proj.weight')) shapes[key] = [1280, 1280]
    else if (key.endsWith('.mlp.c_fc.weight')) shapes[key] = [5120, 1280]
    else if (key.endsWith('.mlp.c_proj.weight')) shapes[key] = [1280, 5120]
    else shapes[key] = [320, 320, 3, 3]
  }
  Object.assign(shapes, overrides)
  let end = 0
  const header = Object.fromEntries(Object.entries(shapes).map(([key, shape]) => {
    const start = end; end += shape.reduce((a, b) => a * b, 2)
    return [key, { dtype: 'F16', shape, data_offsets: [start, end] }]
  }))
  const json = Buffer.from(JSON.stringify(header)), bytes = msg(u64(json.length), json)
  return { bytes, size: bytes.length + end }
}
function fixture(entries) {
  const records = new Map(entries.map(([path, content], i) => {
    const data = Buffer.isBuffer(content) ? { bytes: content, size: content.length } : content
    return [`handle-${i}`, { id: `handle-${i}`, name: path.split('/').at(-1), relativePath: path, ...data }]
  }))
  const reads = [], hashes = []
  const controller = new AbortController()
  const context = {
    signal: controller.signal,
    resources: {
      async listFiles() { return [...records.values()].map(({ id, name, relativePath, size }) => ({ id, name, relativePath, size })) },
      async readBytes({ id }, { offset, length }) {
        const record = records.get(id); assert.ok(record, 'must only read authorized IDs')
        assert.ok(length <= 128 * 1024)
        reads.push({ id, offset, length })
        const data = Buffer.alloc(Math.min(length, record.size - offset))
        record.bytes.copy(data, 0, offset, Math.min(offset + data.length, record.bytes.length))
        return { data, size: record.size, eof: offset + data.length === record.size }
      },
      async hash({ id }, { signal }) {
        signal?.throwIfAborted(); hashes.push(id)
        const r = records.get(id)
        assert.equal(r.bytes.length, r.size, 'tests do not hash virtual large weights')
        return { sha256: hash(r.bytes), size: r.size }
      },
    },
  }
  const importer = createLocalImport(context)
  return { context, importer, records, reads, hashes, controller, ids: [...records.keys()] }
}
async function select(f, recipe) {
  const inspection = await f.importer.inspect({ resourceIds: f.ids })
  const candidate = inspection.candidates.find(item => item.recipe === recipe)
  assert.ok(candidate, recipe)
  const selection = Object.fromEntries(candidate.roles.filter(role => role.choices.length).map(role => [role.id, role.choices[0].id]))
  return { token: inspection.token, recipe, selection }
}

test('GGUF offline definition has content-stable identity, authorized resource IDs and no invented upstream', async () => {
  const f = fixture([['renamed.gguf', gguf()]])
  const input = await select(f, 'chat'), progress = []
  const resolved = await f.importer.resolve({ ...input, title: 'Local title' }, { onProgress: value => progress.push(value) })
  assert.deepEqual(resolved.files, { model: 'renamed.gguf' })
  assert.deepEqual(resolved.origin, { source: 'local' })
  assert.deepEqual(resolved.metadata, { source: 'local', tags: ['gguf'] })
  assert.deepEqual(resolved.specification.files, [{ path: 'renamed.gguf', source: 'renamed.gguf', resourceId: f.ids[0], sha256: hash(gguf()) }])
  assert.equal(resolved.specification.bytes, gguf().length)
  assert.equal(progress.at(-1).completedBytes, gguf().length)
  const renamed = fixture([['another.gguf', gguf()]])
  assert.equal((await renamed.importer.resolve(await select(renamed, 'chat'))).id, resolved.id)
  const changed = gguf(); changed[changed.length - 1] = 1
  const different = fixture([['renamed.gguf', changed]])
  assert.notEqual((await different.importer.resolve(await select(different, 'chat'))).id, resolved.id)
})

test('GGUF metadata distinguishes vision pairing, shards, adapters and unknown architecture', async () => {
  const f = fixture([['weights.gguf', gguf({ architecture: 'qwen3vl' })], ['projector-without-mmproj-name.gguf', gguf({ architecture: 'qwen3vl', projector: true })]])
  const inspection = await f.importer.inspect({ resourceIds: f.ids })
  assert.deepEqual(inspection.candidates.map(c => c.recipe), ['vision'])
  assert.equal((await f.importer.resolve(await select(f, 'vision'))).recipe, 'vision')
  for (const options of [{ split: true }, { architecture: 'unsupported' }, { type: 'adapter' }]) {
    const bad = fixture([['normal.gguf', gguf(options)]])
    await assert.rejects(bad.importer.inspect({ resourceIds: bad.ids }), /分片|架构|适配器/)
  }
  const missing = fixture([['model.gguf', gguf({ architecture: 'qwen3vl' })]])
  const m = await select(missing, 'vision')
  await assert.rejects(missing.importer.resolve(m), /缺少/)
  const mismatch = fixture([['model.gguf', gguf({ architecture: 'qwen3vl' })], ['projector.gguf', gguf({ architecture: 'qwen2vl', projector: true })]])
  await assert.rejects(mismatch.importer.resolve(await select(mismatch, 'vision')), /架构不匹配/)
})

test('Zipformer is identified from metadata and graph interfaces rather than filenames', async () => {
  const f = fixture([['a.onnx', onnx({ family: 'zipformer', role: 'encoder' })], ['b.onnx', onnx({ family: 'zipformer', role: 'decoder' })], ['c.onnx', onnx({ family: 'zipformer', role: 'joiner' })], ['tokens.txt', Buffer.from('<blk> 0\na 1\n')]])
  const result = await f.importer.resolve(await select(f, 'asr'))
  assert.deepEqual(result.files, { encoder: 'a.onnx', decoder: 'b.onnx', joiner: 'c.onnx', tokens: 'tokens.txt' })
  assert.equal(result.specification.files.length, 4)
  for (const bytes of [onnx({ arbitrary: true }), onnx({ external: true }), Buffer.from('not onnx')]) {
    const bad = fixture([['kokoro.onnx', bytes]])
    await assert.rejects(bad.importer.inspect({ resourceIds: bad.ids }), /未识别/)
  }
  f.records.get(f.ids[3]).bytes = Buffer.from('<blk> 0\na 9\n')
  f.records.get(f.ids[3]).size = f.records.get(f.ids[3]).bytes.length
  await assert.rejects(f.importer.resolve(await select(f, 'asr')), /词表不匹配/)
})

function kokoroEntries() {
  return [['tts/model.onnx', onnx()], ['tts/voices.bin', Buffer.alloc(2 * 256 * 4)], ['tts/tokens.txt', Buffer.from('_ 0\na 1\n')], ...['phontab', 'phonindex', 'phondata', 'intonations', 'en_dict', 'lang/en'].map(name => [`tts/espeak-ng-data/${name}`, Buffer.from([1, 2, 3, 4])])]
}
test('Kokoro validates companion data and voices dimensions before local resolution', async () => {
  const f = fixture(kokoroEntries()), result = await f.importer.resolve(await select(f, 'tts'))
  assert.equal(result.phonemes, 'tts/espeak-ng-data')
  assert.equal(result.specification.files.length, 9)
  assert.ok(result.specification.files.every(file => file.path === file.source))
  const missing = fixture(kokoroEntries().filter(([name]) => !name.endsWith('/phondata')))
  await assert.rejects(missing.importer.resolve(await select(missing, 'tts')), /espeak/)
  const wrong = fixture(kokoroEntries().map(([path, bytes]) => [path, path.endsWith('voices.bin') ? Buffer.alloc(4) : bytes]))
  await assert.rejects(wrong.importer.resolve(await select(wrong, 'tts')), /音色文件大小/)
})

test('same-size structural changes during hashing invalidate the inspected snapshot', async () => {
  const f = fixture([['eng.traineddata', traineddata()]])
  const input = await select(f, 'ocr')
  const originalHash = f.context.resources.hash
  f.context.resources.hash = async (...args) => {
    f.records.get(f.ids[0]).bytes.writeUInt32LE(0, 0)
    return originalHash(...args)
  }
  await assert.rejects(f.importer.resolve(input), /变化|失效|不合法|无效|traineddata|组件/)
})

test('traineddata requires a monotonic in-bounds component table and LSTM components', async () => {
  const f = fixture([['nested/eng.traineddata', traineddata()]])
  const resolved = await f.importer.resolve(await select(f, 'ocr'))
  assert.equal(resolved.languages, 'eng')
  assert.deepEqual(resolved.files, { language: 'eng.traineddata' })
  assert.equal(resolved.specification.files[0].source, 'nested/eng.traineddata')
  for (const offset of [99999, 0, -1]) {
    const badData = traineddata(); badData.writeBigInt64LE(BigInt(offset), 4 + 17 * 8)
    const bad = fixture([['eng.traineddata', badData]])
    await assert.rejects(bad.importer.inspect({ resourceIds: bad.ids }), /组件/)
  }
})

test('SD1 and SDXL inspect only bounded tensor headers, rejecting incomplete checkpoints and unsupported layouts', async () => {
  for (const arch of ['sd1', 'sdxl']) {
    const f = fixture([['anything.safetensors', checkpoint(arch)]])
    const result = await f.importer.inspect({ resourceIds: f.ids })
    assert.deepEqual(result.candidates.map(c => c.recipe), ['image'])
    assert.ok(f.reads.reduce((sum, r) => sum + r.length, 0) < 1024 * 1024)
    assert.equal(f.hashes.length, 0)
    f.context.resources.hash = async () => ({ sha256: 'a'.repeat(64), size: f.records.get(f.ids[0]).size })
    const resolved = await f.importer.resolve(await select(f, 'image'))
    assert.deepEqual(resolved.imageValidation, { version: 1, kind: 'ldm-header', architecture: arch, sha256: 'a'.repeat(64) })
    assert.equal(resolved.specification.files[0].sha256, resolved.imageValidation.sha256)
    const bad = fixture([['model.safetensors', checkpoint(arch, 'first_stage_model.quant_conv.weight')]])
    await assert.rejects(bad.importer.inspect({ resourceIds: bad.ids }), /缺少/)
  }
  const header = Buffer.from(JSON.stringify({ 'lora_unet.weight': { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }))
  const lora = fixture([['full-model.safetensors', msg(u64(header.length), header, Buffer.alloc(4))]])
  await assert.rejects(lora.importer.inspect({ resourceIds: lora.ids }), /LoRA/)
  const torchaoHeader = Buffer.from(JSON.stringify({ 'layers.0.weight._weight_qdata': { dtype: 'U8', shape: [1], data_offsets: [0, 1] }, 'layers.0.weight._weight_scale': { dtype: 'F32', shape: [1], data_offsets: [1, 5] } }))
  const torchao = fixture([['renamed-full-checkpoint.safetensors', msg(u64(torchaoHeader.length), torchaoHeader, Buffer.alloc(5))]])
  await assert.rejects(torchao.importer.inspect({ resourceIds: torchao.ids }), /TorchAO.*diffusion.*Qwen3.*FLUX VAE/)
  const extension = fixture([['full-model.ckpt', Buffer.from('pickle')]])
  await assert.rejects(extension.importer.inspect({ resourceIds: extension.ids }), /不支持/)
})

test('fixed SD UNet attention topology rejects missing QKV, output, norms and FFN tensors before issuing validation', async () => {
  for (const architecture of ['sd1', 'sdxl']) {
    const first = `model.diffusion_model.input_blocks.${architecture === 'sd1' ? 1 : 4}.1.transformer_blocks.0`
    const middle = `model.diffusion_model.middle_block.1.transformer_blocks.${architecture === 'sd1' ? 0 : 9}`
    const last = `model.diffusion_model.output_blocks.${architecture === 'sd1' ? 11 : 5}.1.transformer_blocks.${architecture === 'sd1' ? 0 : 1}`
    for (const key of [`${first}.attn1.to_q.weight`, `${first}.attn1.to_k.weight`, `${first}.attn2.to_v.weight`, `${middle}.attn2.to_out.0.weight`, `${middle}.ff.net.0.proj.weight`, `${last}.ff.net.2.weight`, `${last}.norm3.weight`, `${last}.attn1.to_out.0.bias`]) {
      const f = fixture([['checkpoint.safetensors', checkpoint(architecture, key)]])
      await assert.rejects(f.importer.inspect({ resourceIds: f.ids }), /缺少/, key)
      assert.equal(f.hashes.length, 0)
    }
    for (const key of [`${first}.attn2.to_k.weight`, `${middle}.ff.net.0.proj.weight`, `${last}.ff.net.2.weight`]) {
      const f = fixture([['checkpoint.safetensors', checkpoint(architecture, '', { [key]: [1, 1] })]])
      await assert.rejects(f.importer.inspect({ resourceIds: f.ids }), /形状/, key)
      assert.equal(f.hashes.length, 0)
    }
  }
})

test('resource boundary rejects forged handles, traversal, absolute paths, duplicate paths and excess selection before reads', async () => {
  const f = fixture([['model.gguf', gguf()]])
  await assert.rejects(f.importer.inspect({ resourceIds: ['/etc/passwd'] }), /重新选择/)
  await assert.rejects(f.importer.inspect({ resourceIds: [f.ids[0], f.ids[0]] }), /不重复/)
  await assert.rejects(f.importer.inspect({ resourceIds: Array.from({ length: 4097 }, (_, i) => `${i}`) }), /4096/)
  assert.equal(f.reads.length, 0)
  for (const path of ['../x.gguf', '/tmp/x.gguf', 'C:/x.gguf', 'a/../x.gguf', 'x\\y.gguf', 'a//x.gguf', 'a/./x.gguf']) {
    const bad = fixture([[path, gguf()]])
    await assert.rejects(bad.importer.inspect({ resourceIds: bad.ids }), /路径不合法/)
    assert.equal(bad.reads.length, 0)
  }
  const duplicate = fixture([['model.gguf', gguf()], ['MODEL.gguf', gguf()]])
  await assert.rejects(duplicate.importer.inspect({ resourceIds: duplicate.ids }), /冲突/)
})

test('snapshot cannot be altered by returned JSON, selection paths, forged roles, stale tokens or later resources', async () => {
  const f = fixture([['model.gguf', gguf()]])
  const inspection = await f.importer.inspect({ resourceIds: f.ids })
  inspection.candidates[0].roles[0].choices.push({ id: 'forged', path: 'x.gguf' })
  const input = { token: inspection.token, recipe: 'chat', selection: { model: f.ids[0] } }
  for (const selection of [{ model: 'forged' }, { model: 'model.gguf' }, { model: f.ids[0], extra: f.ids[0] }, { model: [f.ids[0], f.ids[0]] }]) await assert.rejects(f.importer.resolve({ ...input, selection }), /合法|角色/)
  f.records.set('new-file', { ...f.records.get(f.ids[0]), id: 'new-file', relativePath: 'new.gguf', name: 'new.gguf' })
  await assert.rejects(f.importer.resolve({ ...input, selection: { model: 'new-file' } }), /快照内/)
  await assert.rejects(createLocalImport(f.context).resolve(input), /快照已失效/)
  f.records.delete(f.ids[0])
  await assert.rejects(f.importer.resolve(input), /重新选择/)
})

test('resolve rejects changed size, metadata, bad digest and missing host hash without fallback', async () => {
  for (const scenario of ['size', 'metadata', 'digest', 'hash-size', 'missing']) {
    const f = fixture([['model.gguf', gguf()]]), input = await select(f, 'chat')
    if (scenario === 'size') f.records.get(f.ids[0]).size++
    if (scenario === 'metadata') f.records.get(f.ids[0]).bytes[40] ^= 1
    if (scenario === 'digest') f.context.resources.hash = async () => ({ sha256: 'bad', size: gguf().length })
    if (scenario === 'hash-size') f.context.resources.hash = async () => ({ sha256: 'a'.repeat(64), size: 1 })
    if (scenario === 'missing') delete f.context.resources.hash
    await assert.rejects(f.importer.resolve(input), scenario === 'missing' ? /升级 Lexora/ : /变化|校验|GGUF|版本|结构|架构|模型/)
  }
})

test('cancellation before inspection, during read and during hashing never returns a model', async () => {
  const f = fixture([['model.gguf', gguf()]])
  f.controller.abort()
  await assert.rejects(f.importer.inspect({ resourceIds: f.ids }), { name: 'AbortError' })
  assert.equal(f.reads.length, 0)
  const mid = fixture([['model.gguf', gguf()]])
  const read = mid.context.resources.readBytes
  mid.context.resources.readBytes = async (...args) => { const result = await read(...args); mid.controller.abort(); return result }
  await assert.rejects(mid.importer.inspect({ resourceIds: mid.ids }), { name: 'AbortError' })
  const hashing = fixture([['model.gguf', gguf()]]), input = await select(hashing, 'chat')
  hashing.context.resources.hash = async () => { hashing.controller.abort(); return { sha256: hash(gguf()), size: gguf().length } }
  await assert.rejects(hashing.importer.resolve(input), { name: 'AbortError' })
})

test('malformed or oversized binary metadata is rejected with bounded reads', async () => {
  const hugeGguf = msg(Buffer.from('GGUF'), u32(3), u64(1), u64(1), u64(2 ** 24))
  const hugeSafe = msg(u64(9 * 1024 ** 2), Buffer.alloc(8))
  const truncatedOnnx = msg(p(1, 9), varint(7 * 8 + 2), varint(999999))
  for (const [name, content] of [['huge.gguf', hugeGguf], ['huge.safetensors', hugeSafe], ['truncated.onnx', truncatedOnnx], ['fake.gguf', Buffer.alloc(128)]]) {
    const f = fixture([[name, content]])
    await assert.rejects(f.importer.inspect({ resourceIds: f.ids }), /未识别/)
    assert.ok(f.reads.reduce((sum, read) => sum + read.length, 0) <= content.length)
  }
  const original = checkpoint(), length = Number(original.bytes.readBigUInt64LE()), header = JSON.parse(original.bytes.subarray(8, length + 8))
  header['model.diffusion_model.out.2.weight'].shape = [1]
  const text = Buffer.from(JSON.stringify(header)), invalid = fixture([['wrong.safetensors', { bytes: msg(u64(text.length), text), size: original.size - length + text.length }]])
  await assert.rejects(invalid.importer.inspect({ resourceIds: invalid.ids }), /形状|长度/)
})

test('authorization revocation during hashing and cross-directory companions are rejected', async () => {
  const f = fixture([['model.gguf', gguf()]]), input = await select(f, 'chat'), originalHash = f.context.resources.hash
  f.context.resources.hash = async (...args) => { const result = await originalHash(...args); f.records.clear(); return result }
  await assert.rejects(f.importer.resolve(input), /授权已变化/)
  const separate = fixture([['a/model.gguf', gguf({ architecture: 'qwen3vl' })], ['b/projection.gguf', gguf({ architecture: 'qwen3vl', projector: true })]])
  await assert.rejects(separate.importer.resolve(await select(separate, 'vision')), /同一相对目录/)
})
