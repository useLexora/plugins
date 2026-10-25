import { flushSync } from 'react-dom'
import type { RenderSlide } from '../vendor/genoffice/packages/pptx-render/src'
import type { ActionCtx } from '../vendor/genoffice/apps/slides/src/renderer/action-context'
import { flushActiveEdit } from '../vendor/genoffice/apps/slides/src/renderer/file-actions'
import { formatSlideDump } from '../vendor/genoffice/apps/slides/src/renderer/ai/slides-skill'
import { runLayoutScript } from '../vendor/genoffice/apps/slides/src/renderer/ai/layout-script'
import { OP_DOCS, opGuide, OP_GROUPS } from '../vendor/genoffice/packages/pptx-ops/src/op-docs'
import { auditSlideLayout } from '../vendor/genoffice/packages/pipelines/src/slides/layout-audit'
import { renderSlidesToPngBase64 } from '../vendor/genoffice/apps/slides/src/renderer/export-render'
import { redactGuardFor } from '../vendor/genoffice/apps/slides/src/renderer/ai/redact-guard'
import type { Json } from './lexora'
import { textForModel, redactLabelsOf } from '../vendor/genoffice/apps/slides/src/renderer/ai/redact-view'
import { assertOfficeReference, assertOfficeReferenceText, officeReference, officeReplacement, OFFICE_REFERENCE_MAX_CHARS } from './office-assistant'
import type { OfficeEditorAssistant, OfficeEditorExecutionGuard, OfficeEditorReference } from './office-editor-types'

interface Snapshot { revision: number; slides: RenderSlide[]; detail?: { applied?: boolean; dryRun?: boolean; records?: Json[]; plan?: string[] } }
const readOperations = ['get_presentation_context', 'read_slide', 'check_layout', 'load_guide']
const writeOperations = ['replace_text', 'apply_ops', 'undo']
const callableOps = () => Object.fromEntries(Object.entries(OP_DOCS).filter(([, doc]) => doc.aiCallable !== false && !doc.pending))
const audit = (slide: RenderSlide) => redactLabelsOf(slide).length ? ['此页含隐私标记，省略带文字片段的布局诊断。'] : auditSlideLayout(slide)
const schemas = {
  get_presentation_context: { type: 'object', properties: {}, additionalProperties: false },
  replace_text: { type: 'object', properties: { text: { type: 'string', maxLength: 24000 } }, required: ['text'], additionalProperties: false },
  undo: { type: 'object', properties: {}, additionalProperties: false },
  render: { type: 'object', properties: { slideIndexes: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'integer', minimum: 0 } } }, additionalProperties: false },
  read_slide: { type: 'object', properties: { slideIndex: { type: 'integer', minimum: 0 } }, required: ['slideIndex'], additionalProperties: false },
  check_layout: { type: 'object', properties: { slideIndex: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  load_guide: { type: 'object', properties: { group: { type: 'string', enum: [...OP_GROUPS] } }, required: ['group'], additionalProperties: false },
  apply_ops: { type: 'object', properties: { ops: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } }, dryRun: { type: 'boolean' } }, required: ['ops'], additionalProperties: false },
}


export function createSlidesAssistant(getContext: () => ActionCtx, request: (method: string, ...args: unknown[]) => Promise<unknown>, ensureActive: () => void, name: string): OfficeEditorAssistant {
  let commandId = 0
  const command = async (revision: number, channel: string, input: unknown, guard?: OfficeEditorExecutionGuard): Promise<Snapshot> => {
    guard?.signal?.throwIfAborted(); guard?.assertCurrent()
    const token = String(++commandId)
    const cancel = () => { void request('assistant-cancel', token).catch(() => {}) }
    guard?.signal?.addEventListener('abort', cancel, { once: true })
    try { return await request('assistant-command', revision, channel, input, token) as Snapshot }
    finally { guard?.signal?.removeEventListener('abort', cancel) }
  }
  const snapshot = async () => { ensureActive(); return await request('assistant-snapshot') as Snapshot }
  const locate = (state: Snapshot, reference?: OfficeEditorReference) => {
    const ctx = getContext()
    if (reference && (reference.locator.kind !== 'pptx' || typeof reference.locator.slidePath !== 'string' || !Array.isArray(reference.locator.sourceIds))) throw new Error('演示文稿引用位置无效。')
    const index = reference ? state.slides.findIndex(slide => slide.partPath === reference.locator.slidePath) : ctx.current
    const slide = state.slides[index]
    if (!slide) throw new Error('引用的幻灯片已不存在。')
    const sourceIds = reference ? reference.locator.sourceIds as string[] : [...ctx.selectedIds]
    if (!sourceIds.every(id => typeof id === 'string')) throw new Error('引用元素无效。')
    const nodes = sourceIds.map(id => slide.nodes.find(node => (node.durableId ?? node.sourceId) === id || node.sourceId === id))
    if (nodes.some(node => !node)) throw new Error('所选元素已变化或位于组合内部，请重新引用独立文本框。')
    const present = nodes.filter(node => !!node)
    const ids = present.map(node => node.durableId ?? node.sourceId)
    const text = present.length ? present.map(node => textForModel(node)).join('\n\n') : formatSlideDump(slide)
    const captured = officeReference(`${name} · 第 ${index + 1} 页${present.length ? ` · ${present.length} 个元素` : ''}`, text, { kind: 'pptx', slidePath: slide.partPath ?? '', sourceIds: ids }, { revision: state.revision, slide: slide.partPath, nodes: present.length ? present : slide.nodes })
    return { captured, slide, index, nodes: present }
  }
  const slideAt = (state: Snapshot, value: unknown) => {
    if (!Number.isInteger(value) || Number(value) < 0 || !state.slides[Number(value)]) throw new Error('slideIndex 必须是现有页面的 0-based 索引。')
    return state.slides[Number(value)]
  }
  const read: OfficeEditorAssistant['read'] = async (reference, query) => {
    const state = await snapshot()
    ensureActive()
    const target = reference ? locate(state, reference) : undefined
    if (reference && target) assertOfficeReferenceText(reference, target.captured)
    const operation = query?.operation ?? (target ? 'read_slide' : 'get_presentation_context')
    const input = query?.input ?? {}
    const allowed = operation === 'load_guide' ? ['group'] : ['read_slide', 'check_layout'].includes(operation) ? ['slideIndex'] : []
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('读取输入包含不支持的字段。')
    let text: string
    if (operation === 'get_presentation_context') text = JSON.stringify({ pages: state.slides.map((slide, index) => ({ slideIndex: index, slidePath: slide.partPath, hidden: !!slide.hidden, widthPx: slide.widthPx, heightPx: slide.heightPx, emuPerPixel: 9525 / slide.scale, elements: slide.nodes.length, preview: slide.nodes.map(node => textForModel(node)).join(' ').slice(0, 500) })) })
    else if (operation === 'load_guide') { text = typeof input.group === 'string' ? opGuide(input.group) ?? '' : ''; if (!text) throw new Error('请指定有效的操作指南 group。') }
    else if (operation === 'read_slide') { const slide = slideAt(state, input.slideIndex ?? target?.index); text = `EMU / px: ${9525 / slide.scale}\n${formatSlideDump(slide)}` }
    else if (operation === 'check_layout') { const selected = input.slideIndex === undefined ? state.slides : [slideAt(state, input.slideIndex)]; if (selected.length > 50) throw new Error('请使用 slideIndex 分页检查，每次最多 50 页。'); text = JSON.stringify(selected.map(slide => ({ slideIndex: state.slides.indexOf(slide), findings: audit(slide) }))) }
    else throw new Error('演示文稿不支持此读取操作。')
    return { text: text.slice(0, OFFICE_REFERENCE_MAX_CHARS), operations: writeOperations, ...(target ? { reference: target.captured } : {}) }
  }
  return {
    resolveReference: async reference => { const target = locate(await snapshot(), reference); assertOfficeReferenceText(reference, target.captured); return target.captured },
    capabilities: () => ({ readOperations, writeOperations, schemas: schemas as unknown as Json, batchOperations: Object.fromEntries(Object.entries(callableOps()).map(([name, doc]) => [name, { signature: doc.sig, group: doc.group }])) as Json, limits: { batch: 50, renderPages: 4, operationCharacters: 128000 }, render: 'png', notes: ['apply_ops 使用原子事务；dryRun 不改变内容或撤销栈。', 'target.slide 使用 0-based 索引；几何使用 EMU，read_slide 返回换算比例。', 'PNG 复用编辑器渲染，含隐私标记的页面不能交给模型。'] }),
    render: async (input, guard) => {
      ensureActive(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      if (getContext().editingActiveRef.current || getContext().editingCell) throw new Error('请先完成当前编辑。')
      const state = await snapshot()
      if (Object.keys(input ?? {}).some(key => key !== 'slideIndexes')) throw new Error('render 只接受 slideIndexes。')
      const indexes = input?.slideIndexes ?? [0]
      if (!Array.isArray(indexes) || !indexes.length || indexes.length > 4) throw new Error('slideIndexes 每次需指定 1–4 页。')
      const slides = indexes.map(index => slideAt(state, index))
      if (slides.some(slide => redactLabelsOf(slide).length)) throw new Error('页面含隐私标记，不能渲染为供模型读取的图片。')
      const pngs = await renderSlidesToPngBase64(slides, getContext().images ?? new Map(), 1)
      ensureActive(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      if ((await snapshot()).revision !== state.revision) throw new Error('渲染过程中演示文稿已改变，请重试。')
      return pngs.map((png, index) => ({ name: `slide-${Number(indexes[index]) + 1}.png`, mimeType: 'image/png' as const, data: Uint8Array.from(atob(png), char => char.charCodeAt(0)) }))
    },
    reference: async () => {
      ensureActive()
      const ctx = getContext()
      const page = ctx.slides[ctx.current]
      if (!page) return null
      const sourceIds = [...ctx.selectedIds]
      await flushActiveEdit(ctx)
      ensureActive()
      if (getContext().editingActiveRef.current) throw new Error('请先完成当前文本编辑后再引用。')
      const state = await snapshot()
      return locate(state, { label: '', text: '', version: '', locator: { kind: 'pptx', slidePath: page.partPath ?? '', sourceIds } }).captured
    },
    read,
    execute: async ({ operation, input, reference }, guard) => {
      ensureActive(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      if (getContext().editingActiveRef.current || getContext().editingCell) throw new Error('请先完成当前文本或表格编辑后再使用助手修改。')
      const state = await snapshot()
      ensureActive(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      let result: Snapshot
      if (operation === 'undo') {
        result = await command(state.revision, 'slides:undo', undefined, guard)
      } else if (operation === 'apply_ops') {
        if (reference) assertOfficeReference(reference, locate(state, reference).captured)
        if (Object.keys(input ?? {}).some(key => !['ops', 'dryRun'].includes(key))) throw new Error('apply_ops 只接受 ops 与 dryRun。')
        if (input?.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun 必须为 boolean。')
        if (!Array.isArray(input?.ops) || input.ops.length < 1 || input.ops.length > 50 || JSON.stringify(input).length > 128000) throw new Error('apply_ops 需要 1–50 项，输入上限 128,000 字符。')
        if (state.slides.some(slide => redactLabelsOf(slide).length)) throw new Error('演示文稿含隐私标记，暂不支持批量改写；请使用精确的非隐藏文本引用。')
        for (const raw of input.ops) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.op !== 'string' || !callableOps()[raw.op]) throw new Error('不支持的 PPTX 操作，请读取 capabilities 和 load_guide。')
          const denied = redactGuardFor(raw, state.slides)
          if (denied) throw new Error(denied.reason)
        }
        result = await command(state.revision, 'slides:apply-txn', { ops: input.ops, dryRun: input.dryRun === true, isolation: 'atomic' }, guard)
      } else {
        if (operation !== 'replace_text') throw new Error('演示文稿不支持此操作。')
        if (!reference) throw new Error('请先引用一个独立文本框。')
        const target = locate(state, reference)
        assertOfficeReference(reference, target.captured)
        const node = target.nodes[0]
        if (target.nodes.length !== 1 || !node || !['shape', 'text'].includes(node.type) || node.decoration) throw new Error('首期仅支持替换一个独立文本框；组合、表格和图表仅供读取。')
        if ((node.type === 'shape' || node.type === 'text') && node.text?.lines.some(line => line.runs.some(run => run.redact))) throw new Error('所选文本框含有已隐藏于模型的内容，不能整体替换。')
        const text = officeReplacement(input)
        if (text === textForModel(node)) return { text: '文本未发生变化。', mutated: false }
        const id = node.durableId ?? node.sourceId
        const edits = runLayoutScript(`setText(${JSON.stringify(id)}, ${JSON.stringify(text)});`, [{ id, type: node.type, text: textForModel(node), ...node.box, rotation: node.box.rotationDeg }], { w: target.slide.widthPx, h: target.slide.heightPx })
        if (edits.error) throw new Error(edits.error)
        guard?.signal?.throwIfAborted(); guard?.assertCurrent()
        result = await command(state.revision, 'slides:apply-edit-script', { slideIndex: target.index, fitWidthPx: target.slide.widthPx, boxes: edits.ops, edits: edits.edits }, guard)
      }
      ensureActive()
      flushSync(() => getContext().applyDeck(result.slides))
      return { text: operation === 'apply_ops' ? JSON.stringify({ ...result.detail, audit: result.slides.slice(0, 50).map((slide, slideIndex) => ({ slideIndex, findings: audit(slide) })).filter(item => item.findings.length) }) : operation === 'undo' ? '已撤销上一次演示文稿修改。' : '已替换引用文本框的文字。', mutated: result.revision !== state.revision }
    },
    reveal: async reference => {
      const target = locate(await snapshot(), reference)
      assertOfficeReferenceText(reference, target.captured)
      flushSync(() => { const ctx = getContext(); ctx.setCurrent(target.index); ctx.setSelectedIds(target.nodes.map(node => node.sourceId)) })
      return true
    },
  }
}
