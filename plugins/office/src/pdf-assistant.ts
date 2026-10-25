import { quadToRect } from '../vendor/genoffice/apps/pdf/src/renderer/annotations'
import { AGENT_TOOLS, countOccurrences, locateOccurrence } from '../vendor/genoffice/apps/pdf/src/renderer/ai/tools'
import type { PdfOfficeBridge } from '../vendor/genoffice/apps/pdf/src/renderer/office-bridge'
import type { OfficeEditorAssistant, OfficeEditorQuery, OfficeEditorReference } from './office-editor-types'
import { assertOfficeReference, officeReference, officeReplacement, officeVersion, officeTextDigest, sameOfficeReferenceText } from './office-assistant'
import type { Json } from './lexora'

type Rect = [number, number, number, number]

export const PDF_READ_OPERATIONS = new Set(['read_pages', 'search_text', 'read_annotations', 'list_inserted_text', 'list_form_fields', 'list_page_images', 'get_outline'])
export const PDF_WRITE_OPERATIONS = new Set(['edit_text', 'edit_block', 'insert_text', 'markup_text', 'add_note', 'reply_note', 'edit_note', 'delete_note', 'delete_markup', 'add_form_mark', 'edit_inserted_text', 'move_inserted_text', 'delete_inserted_text', 'insert_blank_page', 'apply_ops', 'set_watermark', 'set_header_footer'])

function boundedInput(input: Record<string, Json>): void {
  if (JSON.stringify(input).length > 64000) throw new Error('PDF 操作参数过长，请拆成较小批次。')
  for (const key of ['text', 'new_text', 'old_text', 'paragraph_text', 'query']) {
    const value = input[key]
    if (value !== undefined && (typeof value !== 'string' || value.length > 24000)) throw new Error(`${key} 必须是长度不超过 24,000 字符的文本。`)
  }
}

function pageNumber(value: Json | undefined, total: number, fallback = 1): number {
  const page = value ?? fallback
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > total) throw new Error(`page 必须是 1 到 ${total} 的整数。`)
  return page
}


function referencePages(reference: OfficeEditorReference): { page: number; lastPage: number } {
  const { page, lastPage = page } = reference.locator
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || typeof lastPage !== 'number' || !Number.isInteger(lastPage) || lastPage < page) throw new Error('PDF 引用位置无效。')
  return { page, lastPage }
}

function referenceRects(reference: OfficeEditorReference): Rect[] {
  const value = reference.locator.rects
  if (!Array.isArray(value) || !value.length || value.length > 256) throw new Error('PDF 引用缺少有效选区坐标，请重新引用。')
  return value.map(rect => {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(item => typeof item === 'number' && Number.isFinite(item))) throw new Error('PDF 引用坐标无效。')
    const result = rect as Rect
    if (result[2] <= result[0] || result[3] <= result[1]) throw new Error('PDF 引用坐标无效。')
    return result
  })
}

function overlap(rect: Rect, target: Rect): number {
  return Math.max(0, Math.min(rect[2], target[2]) - Math.max(rect[0], target[0])) * Math.max(0, Math.min(rect[3], target[3]) - Math.max(rect[1], target[1]))
}

export async function pdfReferenceOccurrence(bridge: PdfOfficeBridge, reference: OfficeEditorReference): Promise<number> {
  const { page, lastPage } = referencePages(reference)
  if (page !== lastPage) throw new Error('跨页选区可以引用和阅读；修改文字请在同一页内重新选择。')
  if (bridge.deps.isDeleted(page - 1)) throw new Error('引用所在页面已经删除。')
  const index = await bridge.deps.searchIndex()
  const entry = index?.[page - 1]
  const query = reference.text
  if (!entry || !query.trim()) throw new Error('引用文字已变化或此页没有可编辑文字，请重新引用。')
  const rects = referenceRects(reference)
  const matches: number[] = []
  const total = countOccurrences(entry, query)
  if (total > 1000) throw new Error('此段文字出现次数过多，请选择更完整的内容。')
  for (let occurrence = 1; occurrence <= total; occurrence++) {
    const match = locateOccurrence(entry, query, occurrence)
    if (!match || match.oldText !== query) continue
    const area = (match.rect[2] - match.rect[0]) * (match.rect[3] - match.rect[1])
    if (rects.reduce((sum, rect) => sum + overlap(match.rect, rect), 0) / area > 0.4) matches.push(occurrence)
  }
  if (matches.length !== 1) throw new Error('无法唯一定位引用文字，请重新选择更明确的内容。')
  return matches[0]!
}

async function pageIds(bridge: PdfOfficeBridge, pages: number[]): Promise<string[]> {
  if (!pages.length || pages.length > 32) throw new Error('引用页数过多，请缩小选区。')
  const document = bridge.deps.doc()
  if (!document) throw new Error('PDF 尚未准备就绪。')
  return Promise.all(pages.map(async page => {
    if (page < 1 || page > document.numPages || bridge.deps.isDeleted(page - 1)) throw new Error('此页尚未保存或已经删除，请保存后重新引用。')
    const { ref } = await document.getPage(page)
    if (!ref) throw new Error('无法确认 PDF 页面身份，请保存后重新引用。')
    return `${ref.num}:${ref.gen}`
  }))
}

async function resolvePages(bridge: PdfOfficeBridge, reference: OfficeEditorReference): Promise<OfficeEditorReference> {
  const ids = reference.locator.pageIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 32 || !ids.every(id => typeof id === 'string' && /^\d+:\d+$/.test(id))) throw new Error('PDF 引用缺少稳定页面身份，请重新引用。')
  const document = bridge.deps.doc()
  if (!document) throw new Error('PDF 尚未准备就绪。')
  const initial = referencePages(reference)
  if (ids.length === 1 && initial.page <= document.numPages && !bridge.deps.isDeleted(initial.page - 1)) {
    const { ref } = await document.getPage(initial.page)
    if (ref && ids[0] === `${ref.num}:${ref.gen}`) return reference
  }
  const pages: number[] = []
  for (let page = 1; page <= document.numPages; page++) {
    const { ref } = await document.getPage(page)
    if (ref && ids.includes(`${ref.num}:${ref.gen}`) && !bridge.deps.isDeleted(page - 1)) pages.push(page)
  }
  if (pages.length !== ids.length) throw new Error('引用页面已被删除或重新生成，请重新引用。')
  return { ...reference, locator: { ...reference.locator, page: Math.min(...pages), lastPage: Math.max(...pages) } }
}

export function createPdfAssistant(current: () => PdfOfficeBridge, active: () => void, name: string): OfficeEditorAssistant {
  const version = () => officeVersion(current().state())
  const check = (expected: string) => {
    active()
    if (version() !== expected) throw new Error('PDF 已发生变化，请重新读取后再修改。')
  }
  const capabilities = () => {
    active()
    const bridge = current()
    return {
      format: 'pdf',
      readOnly: bridge.deps.readOnly(),
      read: [{ name: 'inspect', description: '分页检查页面尺寸、旋转、稳定页面身份、字体和文档属性；默认前 32 页。', inputSchema: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } } } }, ...AGENT_TOOLS.filter(tool => PDF_READ_OPERATIONS.has(tool.name))],
      edit: bridge.deps.readOnly() ? [] : AGENT_TOOLS.filter(tool => PDF_WRITE_OPERATIONS.has(tool.name)),
      operations: [...(!bridge.deps.readOnly() ? PDF_WRITE_OPERATIONS : []), ...(bridge.canUndo() ? ['undo'] : [])],
      render: { page: '1-based saved page number', scale: '0.5..2; longest side at most 2048 pixels', mimeType: 'image/png' },
      limits: { readPages: 10, inspectPages: 32, batchOperations: 50, textCharacters: 24000, safeUndoBytes: 64 * 1024 * 1024 },
      notes: ['页码按当前保存版本定位。未保存新页须保存后才能读取或渲染。', '编辑使用文档目标及 expectedRevision；文字有多处匹配时 edit_text 必须显式给出 occurrence。', 'PDF 是固定布局：正文改写不重排其它段落。扫描文件不提供自动 OCR。', 'insert_text 坐标为显示页面左上角起算的点；PDF 点为 1/72 英寸。先检查尺寸，限制文本宽度，再渲染确认。', 'apply_ops 支持原子事务和 dry_run，字段与操作词表见其 inputSchema。', '保存会使临时插入文字、批注 ID 发生变化；保存后重新读取，再针对新的 ID 操作。'],
    } as unknown as Json
  }
  const inspect = async (input: Record<string, Json>, assertCurrent: () => void) => {
    const bridge = current()
    const doc = bridge.deps.doc()
    if (!doc) throw new Error('PDF 尚未准备就绪。')
    const start = pageNumber(input.start, doc.numPages)
    const end = pageNumber(input.end, doc.numPages, Math.min(doc.numPages, start + 31))
    if (end < start || end - start >= 32) throw new Error('inspect 每次最多检查 32 页。')
    const pages = []
    for (let page = start; page <= end; page++) {
      const value = await doc.getPage(page)
      assertCurrent()
      const viewport = value.getViewport({ scale: 1 })
      pages.push({ page, id: value.ref ? `${value.ref.num}:${value.ref.gen}` : null, width: viewport.width, height: viewport.height, rotation: value.rotate, deleted: bridge.deps.isDeleted(page - 1) })
    }
    return { fileName: name, pageCount: bridge.deps.pageCount(), savedPageCount: doc.numPages, pageOrder: bridge.deps.pageOrder().map(page => page + 1), pages, metadata: bridge.deps.metadata(), fonts: bridge.deps.editFonts(), readOnly: bridge.deps.readOnly(), pending: bridge.deps.pendingSummary(), more: end < doc.numPages }
  }
  const resolveReference = async (reference: OfficeEditorReference): Promise<OfficeEditorReference> => {
    active()
    const bridge = current()
    const before = version()
    const resolved = await resolvePages(bridge, reference)
    const { page, lastPage } = referencePages(resolved)
    if (bridge.pendingText().some(edit => edit.page >= page && edit.page <= lastPage)) throw new Error('引用页存在未保存文字修改，请保存后重新读取当前内容。')
    if (resolved.locator.kind === 'text' && page === lastPage && resolved.text && (resolved.textLength ?? resolved.text.length) === resolved.text.length) {
      await pdfReferenceOccurrence(bridge, resolved)
    } else {
      const digests = resolved.locator.pageTextDigests
      const ids = resolved.locator.pageIds as string[]
      if (Array.isArray(digests) && digests.length === ids.length && digests.every(value => typeof value === 'string')) {
        const index = await bridge.deps.searchIndex()
        const doc = bridge.deps.doc()!
        for (let currentPage = page; currentPage <= lastPage; currentPage++) {
          const { ref } = await doc.getPage(currentPage)
          const position = ref ? ids.indexOf(`${ref.num}:${ref.gen}`) : -1
          if (position < 0) continue
          const entry = index?.[currentPage - 1]
          if (!entry || officeTextDigest(entry.text) !== digests[position]) throw new Error('引用页面的原文已变化，无法验证原选区；历史快照仍可阅读，请重新选择当前内容。')
        }
      } else if (resolved.locator.kind === 'page' && lastPage - page < 10) {
        const result = await bridge.execute('read_pages', { start: page, end: lastPage }, () => check(before))
        if (result.isError || !sameOfficeReferenceText(resolved, { ...resolved, text: result.output.slice(0, 24000), textDigest: undefined, textLength: undefined })) throw new Error('引用页面的原文已变化，请重新读取当前内容。')
      } else throw new Error('旧引用缺少可验证的跨页选区信息；历史快照仍可阅读，请重新选择当前内容。')
    }
    check(before)
    return { ...resolved, version: before }
  }
  const pageTextDigests = async (bridge: PdfOfficeBridge, pages: number[]) => {
    const index = await bridge.deps.searchIndex()
    return pages.map(page => {
      const entry = index?.[page - 1]
      if (!entry) throw new Error('无法验证引用页面的文字，请等待页面加载完成。')
      return officeTextDigest(entry.text)
    })
  }
  const read = async (reference?: OfficeEditorReference, query?: OfficeEditorQuery) => {
    active()
    const bridge = current()
    const before = version()
    if (reference) reference = await resolveReference(reference)
    check(before)
    const operation = query?.operation ?? (reference ? 'read_pages' : 'inspect')
    const input = query?.input ?? {}
    boundedInput(input)
    if (operation === 'inspect') {
      const data = await inspect(input, () => check(before))
      check(before)
      return { text: JSON.stringify(data), data: data as unknown as Json, operations: [...(!bridge.deps.readOnly() ? PDF_WRITE_OPERATIONS : []), ...(bridge.canUndo() ? ['undo'] : [])] }
    }
    if (!PDF_READ_OPERATIONS.has(operation)) throw new Error(`不支持的 PDF 读取操作：${operation}`)
    const doc = bridge.deps.doc()
    if (!doc) throw new Error('PDF 尚未准备就绪。')
    const selected = reference ? referencePages(reference) : { page: 1, lastPage: 1 }
    const page = operation === 'read_pages' ? pageNumber(input.start, doc.numPages, selected.page) : selected.page
    const lastPage = operation === 'read_pages' ? pageNumber(input.end, doc.numPages, input.start === undefined ? Math.min(selected.lastPage, page + 9) : page) : selected.lastPage
    if (operation === 'read_pages' && (lastPage < page || lastPage - page >= 10)) throw new Error('read_pages 每次最多读取 10 页。')
    const result = await bridge.execute(operation, operation === 'read_pages' ? { ...input, start: page, end: lastPage } : input, () => check(before))
    check(before)
    if (result.isError) throw new Error(result.output)
    const pending = bridge.deps.pendingSummary()
    const textChanges = bridge.pendingText().filter(edit => edit.page >= page && edit.page <= lastPage)
    const text = `${result.output}${pending ? `\n\n当前未保存的修改：${pending}` : ''}${textChanges.length ? `\n文字改动（已显示在编辑器中，尚未写入文件）：${JSON.stringify(textChanges)}` : ''}`.slice(0, 24000)
    const refreshed = operation !== 'read_pages' ? undefined : reference && input.start === undefined && input.end === undefined ? { ...reference, version: before } : officeReference(`${name} · 第 ${page}${lastPage === page ? '' : `–${lastPage}`} 页`, text, { kind: 'page', page, lastPage, pageIds: await pageIds(bridge, Array.from({ length: lastPage - page + 1 }, (_, index) => page + index)), pageTextDigests: await pageTextDigests(bridge, Array.from({ length: lastPage - page + 1 }, (_, index) => page + index)) }, bridge.state())
    check(before)
    return {
      text,
      operations: [...(!bridge.deps.readOnly() ? PDF_WRITE_OPERATIONS : []), ...(!bridge.deps.readOnly() && !textChanges.length && reference?.locator.kind === 'text' && selected.page === selected.lastPage && (reference.textLength ?? reference.text.length) <= 24000 && reference.text === reference.text.trim() ? ['replace_text'] : []), ...(bridge.canUndo() ? ['undo'] : [])],
      reference: refreshed,
    }
  }
  return {
    capabilities,
    resolveReference,
    async reference() {
      active()
      const bridge = current()
      const selection = bridge.selection()
      if (!selection?.text.trim()) return (await read(undefined, { operation: 'read_pages', input: { start: bridge.deps.currentPage() } })).reference ?? null
      const before = version()
      const ids = await pageIds(bridge, selection.quads.map(value => value.page))
      check(before)
      const digests = await pageTextDigests(bridge, selection.quads.map(value => value.page))
      check(before)
      const rects = selection.quads.flatMap(value => value.quads.map(quadToRect))
      if (rects.length > 256) throw new Error('PDF 选区超过 256 个文字区域，请缩小选区后再引用。')
      return officeReference(`${name} · 第 ${selection.page}${selection.lastPage === selection.page ? '' : `–${selection.lastPage}`} 页`, selection.text, { kind: 'text', page: selection.page, lastPage: selection.lastPage, pageIds: ids, pageTextDigests: digests, rects }, bridge.state())
    },
    read,
    async execute(request, guard) {
      active()
      guard?.signal?.throwIfAborted()
      guard?.assertCurrent()
      const bridge = current()
      const before = version()
      const assertCurrent = () => { check(before); guard?.signal?.throwIfAborted(); guard?.assertCurrent() }
      if (request.operation === 'undo') {
        assertCurrent()
        const mutated = await bridge.undo(assertCurrent)
        if (!mutated) throw new Error('没有可安全撤销的 PDF 修改。')
        return { text: '已撤销上一步 PDF 修改。', mutated }
      }
      if (PDF_WRITE_OPERATIONS.has(request.operation)) {
        if (bridge.deps.readOnly()) throw new Error('此 PDF 为只读，无法修改。')
        const input = request.input ?? {}
        boundedInput(input)
        if (request.operation === 'edit_text') {
          const page = pageNumber(input.page, bridge.deps.pageCount())
          const oldText = typeof input.old_text === 'string' ? input.old_text.trim() : ''
          const entry = (await bridge.deps.searchIndex())?.[page - 1]
          assertCurrent()
          if (!oldText || !entry) throw new Error('请先读取该页，再提供准确的 old_text。')
          const count = countOccurrences(entry, oldText)
          if (count > 1 && input.occurrence === undefined) throw new Error(`该文字在第 ${page} 页出现 ${count} 次，请显式指定 occurrence。`)
          if (input.occurrence !== undefined && (typeof input.occurrence !== 'number' || !Number.isInteger(input.occurrence) || input.occurrence < 1 || input.occurrence > count)) throw new Error('occurrence 超出文字匹配范围。')
        }
        const result = await bridge.execute(request.operation, input, assertCurrent, guard?.signal)
        if (result.isError) throw new Error(result.output)
        return { text: result.output, mutated: !!result.mutated }
      }
      if (request.operation !== 'replace_text' || !request.reference || request.reference.locator.kind !== 'text') throw new Error('不支持的 PDF 操作，或文字替换缺少有效的选区引用。')
      if (bridge.deps.readOnly()) throw new Error('此 PDF 为只读，无法修改。')
      if (request.reference.text !== request.reference.text.trim()) throw new Error('精确替换不支持带首尾空白的 PDF 选区，请重新选择文字。')
      if ((request.reference.textLength ?? request.reference.text.length) > 24000 || !request.reference.text) throw new Error('长选区可引用和阅读；文字替换请在同一页内选择不超过 24,000 字符的原文。')
      const reference = await resolvePages(bridge, request.reference)
      assertCurrent()
      if (JSON.stringify(reference.locator) !== JSON.stringify(request.reference.locator)) throw new Error('PDF 页序已变化，请重新读取后再修改。')
      if (bridge.pendingText().some(edit => edit.page === referencePages(reference).page)) throw new Error('此页文字已有未保存的修改，请保存后重新引用再修改。')
      assertOfficeReference(reference, { ...reference, version: before })
      const occurrence = await pdfReferenceOccurrence(bridge, reference)
      assertCurrent()
      const replacement = officeReplacement(request.input)
      if (replacement === reference.text) return { text: '文字未发生变化。', mutated: false }
      const result = await bridge.execute('edit_text', { page: referencePages(reference).page, old_text: reference.text, new_text: replacement, occurrence }, assertCurrent, guard?.signal)
      if (result.isError) throw new Error(result.output)
      return { text: '已修改引用文字。', mutated: !!result.mutated }
    },
    async render(input = {}, guard) {
      active()
      const bridge = current()
      const before = version()
      const assertCurrent = () => { check(before); guard?.signal?.throwIfAborted(); guard?.assertCurrent() }
      assertCurrent()
      if (bridge.snapshot()) throw new Error('请先保存 PDF，再渲染最终页面。')
      const doc = bridge.deps.doc()
      if (!doc) throw new Error('PDF 尚未准备就绪。')
      const number = pageNumber(input.page, doc.numPages)
      const scale = input.scale ?? 1.5
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new Error('scale 必须在 0.5 到 2 之间。')
      const page = await doc.getPage(number)
      assertCurrent()
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(scale, 2048 / Math.max(base.width, base.height)) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const rendering = page.render({ canvas, viewport })
      const cancel = () => rendering.cancel()
      guard?.signal?.addEventListener('abort', cancel, { once: true })
      try {
        await rendering.promise
        assertCurrent()
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('PDF 页面渲染失败。')
        const data = new Uint8Array(await blob.arrayBuffer())
        assertCurrent()
        return [{ name: `${name.replace(/\.pdf$/i, '')}-page-${number}.png`, mimeType: 'image/png', data }]
      } finally {
        guard?.signal?.removeEventListener('abort', cancel)
        canvas.width = 0
        canvas.height = 0
      }
    },
    async reveal(reference) {
      active()
      const bridge = current()
      return bridge.deps.gotoPage(referencePages(await resolveReference(reference)).page)
    },
  }
}
