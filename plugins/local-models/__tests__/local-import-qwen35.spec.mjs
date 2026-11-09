import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { parseFile } from '../localImportFormats.js'
import { createLocalImport } from '../localImport.js'

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const string = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
function fixture({ metadata: overrides = {}, omit = '', wrongShape = '', schedule = [true, true, true, false], fused = false, mutateDirectory, truncate = 0 } = {}) {
  // Scaled dense qwen35 layout from llama.cpp load_arch_tensors, not the
  // conventional ffn_norm/attn_output-on-every-layer fixture.
  const width = 4, ff = 8, heads = 2, kvHeads = 1, key = 2, state = 2, rank = 2, groups = 1, inner = 4, conv = 4
  const metadata = {
    'general.architecture': 'qwen35', 'general.type': 'model', 'general.name': 'Hybrid test',
    'qwen35.block_count': 4, 'qwen35.embedding_length': width, 'qwen35.feed_forward_length': ff,
    'qwen35.attention.head_count': heads, 'qwen35.attention.head_count_kv': kvHeads,
    'qwen35.attention.key_length': key, 'qwen35.attention.value_length': key,
    'qwen35.ssm.conv_kernel': conv, 'qwen35.ssm.state_size': state,
    'qwen35.ssm.group_count': groups, 'qwen35.ssm.time_step_rank': rank, 'qwen35.ssm.inner_size': inner,
    'qwen35.full_attention_interval': 4,
    'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': ['a', 'b'], ...overrides,
  }
  const pairs = Object.entries(metadata).filter(([, v]) => v !== undefined).map(([k, v]) => {
    const data = typeof v === 'string' ? [u32(8), string(v)] : typeof v === 'boolean' ? [u32(7), Buffer.from([+v])] : Array.isArray(v) ? [u32(9), u32(typeof v[0] === 'boolean' ? 7 : typeof v[0] === 'number' ? 4 : 8), u64(v.length), ...v.map(x => typeof x === 'boolean' ? Buffer.from([+x]) : typeof x === 'number' ? u32(x) : string(x))] : [u32(4), u32(v)]
    return Buffer.concat([string(k), ...data])
  })
  const tensors = [['token_embd.weight', [width, 2]], ['output_norm.weight', [width]]]
  for (let i = 0; i < 4; i++) {
    const put = (name, shape) => tensors.push([`blk.${i}.${name}`, shape])
    put('attn_norm.weight', [width]); put('post_attention_norm.weight', [width])
    put('ffn_up.weight', [width, ff]); put('ffn_gate.weight', [width, ff]); put('ffn_down.weight', [ff, width])
    if (schedule[i]) {
      put('attn_qkv.weight', [width, 2 * state * groups + inner]); put('attn_gate.weight', [width, inner])
      put('ssm_conv1d.weight', [conv, 2 * state * groups + inner]); put('ssm_dt.bias', [rank]); put('ssm_a', [rank])
      put('ssm_alpha.weight', [width, rank]); put('ssm_beta.weight', [width, rank])
      put('ssm_norm.weight', [state]); put('ssm_out.weight', [inner, width])
    } else {
      if (fused) put('attn_qkv.weight', [width, 2 * key * (heads + kvHeads)])
      else { put('attn_q.weight', [width, 2 * key * heads]); put('attn_k.weight', [width, key * kvHeads]); put('attn_v.weight', [width, key * kvHeads]) }
      put('attn_output.weight', [key * heads, width]); put('attn_q_norm.weight', [key]); put('attn_k_norm.weight', [key])
    }
  }
  const selected = tensors.filter(([name]) => name !== omit).map(([name, shape]) => [name, name === wrongShape ? shape.map(n => n * 2) : shape])
  let end = 0
  const directory = selected.map(([name, shape], index) => {
    const offset = end
    end += Math.ceil(shape.reduce((a, b) => a * b, 4) / 32) * 32
    return Buffer.concat([string(name), u32(shape.length), ...shape.map(u64), u32(0), u64(mutateDirectory ? mutateDirectory(index, offset) : offset)])
  })
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(selected.length), u64(pairs.length), ...pairs, ...directory])
  const bytes = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 32) * 32 - header.length), Buffer.alloc(end)])
  return bytes.subarray(0, bytes.length - truncate)
}
function contextFor(data) {
  const file = { id: 'authorized', name: 'renamed.gguf', path: 'renamed.gguf', bytes: data.length }
  const calls = [], controller = new AbortController()
  const context = { signal: controller.signal, resources: {
    async listFiles() { return [{ id: file.id, name: file.name, size: file.bytes }] },
    async readBytes({ id }, { offset, length }) { assert.equal(id, file.id); calls.push({ offset, length }); return { data: data.subarray(offset, offset + length), size: data.length, eof: offset + length === data.length } },
    async hash({ id }, { signal }) { assert.equal(id, file.id); signal.throwIfAborted(); return { sha256: createHash('sha256').update(data).digest('hex'), size: data.length } },
  } }
  return { context, file, calls }
}
const parse = options => { const f = contextFor(fixture(options)); return parseFile(f.context, f.file, f.context.signal) }

test('dense Qwen3.5 hybrid is recognized by structure, routed to chat, and resolves with stable fingerprints', async () => {
  const f = contextFor(fixture())
  const first = await parseFile(f.context, f.file)
  assert.equal(first.architecture, 'qwen35'); assert.equal(first.vision, false)
  assert.deepEqual(await parseFile(f.context, f.file), first)
  const importer = createLocalImport(f.context)
  const result = await importer.inspect({ resourceIds: [f.file.id] })
  assert.equal(result.defaultRecipe, 'chat')
  assert.deepEqual(result.candidates.map(c => c.recipe), ['chat', 'vision', 'asr', 'tts', 'image', 'ocr'])
  assert.deepEqual(result.candidates.find(c => c.recipe === 'vision').missing, ['视觉投影'])
  const resolved = await importer.resolve({ token: result.token, recipe: 'chat', selection: { model: f.file.id } })
  assert.equal(resolved.recipe, 'chat'); assert.equal(resolved.specification.files[0].resourceId, f.file.id)
})

test('default interval, explicit boolean schedule and fused attention match llama.cpp layouts', async () => {
  assert.equal((await parse({ metadata: { 'qwen35.full_attention_interval': undefined } })).architecture, 'qwen35')
  assert.equal((await parse({ fused: true })).architecture, 'qwen35')
  const schedule = [false, true, false, true]
  assert.equal((await parse({ schedule, metadata: { 'qwen35.attention.recurrent_layers': schedule, 'qwen35.full_attention_interval': 0 } })).architecture, 'qwen35')
  assert.equal((await parse({ schedule: [false, false, false, false], metadata: { 'qwen35.attention.recurrent_layers': false } })).architecture, 'qwen35')
})

const required = ['attn_norm.weight', 'post_attention_norm.weight', 'ffn_up.weight', 'ffn_gate.weight', 'ffn_down.weight', 'attn_qkv.weight', 'attn_gate.weight', 'ssm_conv1d.weight', 'ssm_dt.bias', 'ssm_a', 'ssm_alpha.weight', 'ssm_beta.weight', 'ssm_norm.weight', 'ssm_out.weight'].map(k => `blk.0.${k}`)
required.push(...['attn_q.weight', 'attn_k.weight', 'attn_v.weight', 'attn_output.weight', 'attn_q_norm.weight', 'attn_k_norm.weight'].map(k => `blk.3.${k}`))
for (const name of required) test(`Qwen3.5 missing/wrong-shape ${name} is rejected`, async () => {
  await assert.rejects(parse({ omit: name }), /Qwen3.5 GGUF 结构不匹配/)
  await assert.rejects(parse({ wrongShape: name }), /Qwen3.5 GGUF 结构不匹配/)
})

for (const [key, value] of [
  ['qwen35.full_attention_interval', 0], ['qwen35.ssm.inner_size', 6], ['qwen35.ssm.group_count', 3],
  ['qwen35.attention.head_count_kv', 3], ['qwen35.attention.key_length', 3],
  ['qwen35.attention.recurrent_layers', [true]], ['qwen35.attention.recurrent_layers', [1, 1, 1, 0]],
  ['qwen35.attention.recurrent_layers', [false, false, false, true]], ['qwen35.nextn_predict_layers', 1],
]) test(`Qwen3.5 inconsistent/unsupported metadata ${key}=${JSON.stringify(value)} fails closed`, async () => {
  await assert.rejects(parse({ metadata: { [key]: value } }), /Qwen3.5/)
})

test('unclassified GGUF architectures retain common structural checks without an architecture allowlist', async () => {
  for (const architecture of ['qwen35moe', 'invented']) {
    const result = await parse({ metadata: { 'general.architecture': architecture, [`${architecture}.block_count`]: 4, [`${architecture}.embedding_length`]: 4 } })
    assert.equal(result.architecture, architecture)
    await assert.rejects(parse({ metadata: { 'general.architecture': architecture } }), /缺少完整语言模型结构/)
  }
  await assert.rejects(parse({ metadata: { 'general.architecture': undefined } }), /缺少模型架构/)
})

test('hybrid support retains tokenizer, split, adapter, span and truncation checks', async () => {
  await assert.rejects(parse({ metadata: { 'tokenizer.ggml.tokens': ['a'] } }), /词表大小不匹配/)
  await assert.rejects(parse({ metadata: { 'split.count': 2 } }), /分片/)
  await assert.rejects(parse({ metadata: { 'general.type': 'adapter' } }), /适配器/)
  await assert.rejects(parse({ mutateDirectory: () => 0 }), /重叠/)
  await assert.rejects(parse({ truncate: 64 }), /越界|截断/)
})
