import { CellValueType, HorizontalAlign, VerticalAlign, WrapStrategy, type ICellData, type IRange, type IStyleData } from '@univerjs/core'
import { z } from 'zod'
import { parseRange } from '../vendor/genoffice/packages/xlsx-gateway/src/domain/cell-address'
import type { Json } from './lexora'
import type { createUniver } from './create-univer'
import type { WorkbookModel } from './engine'
import type { OfficeEditorAssistant, OfficeEditorReference } from './office-editor-types'
import { assertOfficeReference, assertOfficeReferenceText, officeReference, officeReplacement, OFFICE_REFERENCE_MAX_CHARS } from './office-assistant'

type Runtime = ReturnType<typeof createUniver>
type Workbook = NonNullable<ReturnType<Runtime['univerAPI']['getActiveWorkbook']>>
const color = z.string().regex(/^#[\da-f]{6}$/i)
const address = z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}(:[A-Z]{1,3}[1-9]\d{0,6})?$/)
const location = { sheetId: z.string().min(1), range: address }
const scalar = z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()])
const cell = z.union([scalar, z.object({ value: scalar.optional(), formula: z.string().startsWith('=').min(2).max(8192).optional() }).strict()])
const format = z.object({
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
  fontSize: z.number().min(1).max(409).optional(), fontFamily: z.string().min(1).max(128).optional(),
  color: color.optional(), background: color.optional(), numberFormat: z.string().min(1).max(255).optional(),
  horizontalAlign: z.enum(['left', 'center', 'right', 'justify']).optional(), verticalAlign: z.enum(['top', 'center', 'bottom']).optional(), wrap: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'format 至少包含一个字段')
const cellsInput = z.object({ ...location, values: z.array(z.array(cell).min(1)).min(1) }).strict()
const formatInput = z.object({ ...location, format }).strict()
const name = z.string().min(1).max(31).regex(/^[^:\\/?*[\]]+$/)
const axisInput = z.object({ sheetId: location.sheetId, axis: z.enum(['row', 'column']), index: z.number().int().min(0), count: z.number().int().min(1).max(1000) }).strict()
const writeSchemas = {
  set_cells: cellsInput,
  format_range: formatInput,
  batch: z.object({ operations: z.array(z.discriminatedUnion('operation', [z.object({ operation: z.literal('set_cells'), input: cellsInput }).strict(), z.object({ operation: z.literal('format_range'), input: formatInput }).strict()])).min(1).max(50), dryRun: z.boolean().optional() }).strict(),
  add_sheet: z.object({ name, rows: z.number().int().min(1).max(10000).default(200), columns: z.number().int().min(1).max(256).default(26) }).strict(),
  rename_sheet: z.object({ sheetId: location.sheetId, name }).strict(),
  delete_sheet: z.object({ sheetId: location.sheetId }).strict(),
  insert_axis: axisInput,
  delete_axis: axisInput,
  resize_axis: axisInput.extend({ pixels: z.number().min(1).max(2000) }).strict(),
  merge_cells: z.object(location).strict(), unmerge_cells: z.object(location).strict(),
  freeze: z.object({ sheetId: location.sheetId, rows: z.number().int().min(0), columns: z.number().int().min(0) }).strict(),
  sort_range: z.object({ ...location, column: z.number().int().min(0), ascending: z.boolean().default(true) }).strict(),
}
const readSchemas = {
  get_workbook_context: z.object({}).strict(), read_range: z.object(location).strict(), read_formats: z.object(location).strict(),
  check_workbook: z.object({}).strict(),
  aggregate_range: z.object(location).strict(),
  find_cells: z.object({ sheetId: location.sheetId, text: z.string().min(1).max(256), matchCase: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(50) }).strict(),
}
const parse = (schema: z.ZodType, input: unknown) => { const parsed = schema.safeParse(input); if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')); return parsed.data as Record<string, Json> }
const stylePatch = (input: Record<string, Json>): IStyleData => ({
  ...(input.bold === undefined ? {} : { bl: input.bold ? 1 : 0 }), ...(input.italic === undefined ? {} : { it: input.italic ? 1 : 0 }), ...(input.underline === undefined ? {} : { ul: { s: input.underline ? 1 : 0 } }),
  ...(input.fontSize === undefined ? {} : { fs: Number(input.fontSize) }), ...(input.fontFamily === undefined ? {} : { ff: String(input.fontFamily) }),
  ...(input.color === undefined ? {} : { cl: { rgb: String(input.color) } }), ...(input.background === undefined ? {} : { bg: { rgb: String(input.background) } }),
  ...(input.numberFormat === undefined ? {} : { n: { pattern: String(input.numberFormat) } }),
  ...(input.horizontalAlign === undefined ? {} : { ht: ({ left: HorizontalAlign.LEFT, center: HorizontalAlign.CENTER, right: HorizontalAlign.RIGHT, justify: HorizontalAlign.JUSTIFIED })[input.horizontalAlign as 'left'] }),
  ...(input.verticalAlign === undefined ? {} : { vt: ({ top: VerticalAlign.TOP, center: VerticalAlign.MIDDLE, bottom: VerticalAlign.BOTTOM })[input.verticalAlign as 'top'] }),
  ...(input.wrap === undefined ? {} : { tb: input.wrap ? WrapStrategy.WRAP : WrapStrategy.OVERFLOW }),
})
export function assistantCell(value: Json): ICellData {
  let scalar = value
  let formula: string | null = null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).some(key => key !== 'value' && key !== 'formula')) throw new Error('单元格只接受 value 和 formula 字段。')
    scalar = value.value ?? null
    if (value.formula !== undefined) {
      if (typeof value.formula !== 'string' || !value.formula.startsWith('=') || value.formula.length < 2 || value.formula.length > 8192) throw new Error('公式必须以 = 开头且不超过 8,192 字符。')
      formula = value.formula
    }
  }
  if (scalar !== null && !['string', 'number', 'boolean'].includes(typeof scalar)) throw new Error('单元格值必须是文本、有限数字、布尔值或 null。')
  if (typeof scalar === 'number' && !Number.isFinite(scalar)) throw new Error('单元格数值必须为有限数字。')
  if (typeof scalar === 'string' && scalar.length > 32767) throw new Error('单元格文本超过 32,767 字符。')
  return { v: formula ? null : scalar as string | number | boolean | null, f: formula, p: null, si: null, t: typeof scalar === 'number' ? CellValueType.NUMBER : typeof scalar === 'boolean' ? CellValueType.BOOLEAN : CellValueType.STRING }
}


export function createSheetsAssistant(api: Runtime['univerAPI'], book: Workbook, model: WorkbookModel, signature: () => string, ensureActive: () => void, selectionCount: () => number, checkRange?: (sheetId: string, range: IRange) => void): OfficeEditorAssistant {
  const ensure = () => { ensureActive(); if (model.readOnlyReason?.includes('隐私标记')) throw new Error('此工作簿含有隐私标记，暂不向助手提供内容。') }
  const sheetFor = (id: unknown) => { if (typeof id !== 'string') throw new Error('请明确指定 sheetId。'); const sheet = book.getSheetBySheetId(id); if (!sheet) throw new Error('工作表不存在。'); return sheet }
  const rangeFor = (sheetId: unknown, candidate: unknown, limit = 2000) => {
    const sheet = sheetFor(sheetId)
    const raw = typeof candidate === 'string' ? parseRange(candidate) : candidate
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请明确指定单元格区域。')
    const bounds = raw as Record<string, unknown>
    const range: IRange = { startRow: Number(bounds.startRow), endRow: Number(bounds.endRow), startColumn: Number(bounds.startColumn), endColumn: Number(bounds.endColumn) }
    if (!Object.values(range).every(Number.isInteger) || range.startRow < 0 || range.startColumn < 0 || range.endRow < range.startRow || range.endColumn < range.startColumn || range.endRow >= sheet.getMaxRows() || range.endColumn >= sheet.getMaxColumns()) throw new Error('区域超出当前工作表；请先插入行列扩展。')
    const rows = range.endRow - range.startRow + 1; const columns = range.endColumn - range.startColumn + 1
    if (rows * columns > limit) throw new Error(`此操作每次最多 ${limit} 个单元格。`)
    const selected = sheet.getRange(range.startRow, range.startColumn, rows, columns)
    return { sheet, sheetId: sheet.getSheetId(), range, rows, columns, selected }
  }
  const capture = (reference?: OfficeEditorReference) => {
    ensure()
    if (book.isCellEditing()) throw new Error('请先确认当前单元格的编辑。')
    if (!reference && selectionCount() > 1) throw new Error('请只选择一个连续区域后再引用。')
    if (reference && reference.locator.kind !== 'xlsx') throw new Error('工作表引用无效。')
    const target = rangeFor(reference?.locator.sheetId ?? book.getActiveSheet()?.getSheetId(), reference?.locator.range ?? book.getActiveRange()?.getRange(), 400)
    const text = JSON.stringify({ sheet: target.sheet.getSheetName(), range: target.selected.getA1Notation(), values: target.selected.getValues(), formulas: target.selected.getFormulas() })
    const { startRow, endRow, startColumn, endColumn } = target.range
    return { ...target, captured: officeReference(`${target.sheet.getSheetName()}!${target.selected.getA1Notation()}`, text, { kind: 'xlsx', sheetId: target.sheetId, range: { startRow, endRow, startColumn, endColumn } }, [signature(), target.sheetId, target.selected.getCellDataGrid()]) }
  }
  const operations = () => model.readOnlyReason ? [] : [...Object.keys(writeSchemas), 'replace_text', 'undo']
  const writable = (sheetId: string, range?: IRange) => {
    if (model.readOnlyReason) throw new Error(model.readOnlyReason)
    if (model.sheets.find(sheet => sheet.id === sheetId)?.protected) throw new Error('工作表受保护。')
    if (range) checkRange?.(sheetId, range)
  }
  const noMerge = (target: ReturnType<typeof rangeFor>) => { if (target.sheet.getMergeData().some(merged => { const r = merged.getRange(); return r.startRow <= target.range.endRow && r.endRow >= target.range.startRow && r.startColumn <= target.range.endColumn && r.endColumn >= target.range.startColumn })) throw new Error('此操作不支持包含合并单元格的区域，请先取消合并。') }
  const read: OfficeEditorAssistant['read'] = async (reference, query) => {
    ensure()
    const referenced = reference ? capture(reference) : undefined
    if (reference && referenced) assertOfficeReferenceText(reference, referenced.captured)
    const operation = query?.operation ?? (referenced ? 'read_range' : 'get_workbook_context')
    const schema = readSchemas[operation as keyof typeof readSchemas]
    if (!schema) throw new Error('工作簿不支持此读取操作。')
    const input = parse(schema, query?.input ?? (referenced ? { sheetId: referenced.sheetId, range: referenced.selected.getA1Notation() } : {}))
    const snapshot = book.save()
    let data: Json
    if (operation === 'get_workbook_context' || operation === 'check_workbook') {
      data = { sheets: snapshot.sheetOrder.map(id => { const sheet = sheetFor(id); const cells = Object.values(snapshot.sheets[id].cellData ?? {}).flatMap(row => Object.values(row) as ICellData[]); return { sheetId: id, name: sheet.getSheetName(), rows: sheet.getMaxRows(), columns: sheet.getMaxColumns(), populatedCells: cells.filter(cell => cell && (cell.v != null || cell.f)).length, formulas: cells.filter(cell => cell?.f).length, cachedErrors: cells.filter(cell => typeof cell?.v === 'string' && /^#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|SPILL!|CALC!)/.test(cell.v)).length, mergedRanges: sheet.getMergeData().map(range => range.getA1Notation()), frozenRows: sheet.getFrozenRows(), frozenColumns: sheet.getFrozenColumns(), protected: !!model.sheets.find(item => item.id === id)?.protected } }), warnings: model.warnings, readOnly: model.readOnlyReason ?? null, formulaCalculation: 'cached-only; Excel/LibreOffice must recalculate', structureProtected: !!model.structureProtected }
    } else if (operation === 'find_cells') {
      const sheet = sheetFor(input.sheetId); const found: Json[] = []; const wanted = String(input.text); let truncated = false
      for (const [r, row] of Object.entries(snapshot.sheets[sheet.getSheetId()].cellData ?? {})) for (const [c, cell] of Object.entries(row) as Array<[string, ICellData]>) {
        const text = String(cell?.v ?? '') + String(cell?.f ?? '')
        if (!(input.matchCase ? text.includes(wanted) : text.toLowerCase().includes(wanted.toLowerCase()))) continue
        if (found.length >= Number(input.limit)) { truncated = true; continue }
        found.push({ row: +r, column: +c, value: cell?.v as Json ?? null, formula: cell?.f ?? null })
      }
      data = { sheetId: sheet.getSheetId(), matches: found, truncated }
    } else {
      const target = rangeFor(input.sheetId, input.range)
      if (operation === 'read_formats') data = { sheetId: target.sheetId, range: target.selected.getA1Notation(), cells: target.selected.getCellDataGrid().map(row => row.map(cell => typeof cell?.s === 'string' ? snapshot.styles?.[cell.s] ?? null : cell?.s ?? null)) } as Json
      else if (operation === 'aggregate_range') { const values = target.selected.getValues().flat(); const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)); data = { cells: values.length, numericCount: numbers.length, sum: numbers.reduce((sum, value) => sum + value, 0), average: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null, min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null, formulaValues: 'cached-only' } }
      else data = { sheetId: target.sheetId, range: target.selected.getA1Notation(), values: target.selected.getValues() as Json, formulas: target.selected.getFormulas() as Json }
    }
    const text = JSON.stringify(data)
    return { text: text.slice(0, OFFICE_REFERENCE_MAX_CHARS) + (text.length > OFFICE_REFERENCE_MAX_CHARS ? '\n结果截断，请缩小读取范围。' : ''), operations: operations(), ...(referenced ? { reference: referenced.captured } : {}) }
  }
  return {
    capabilities: () => ({ readOperations: Object.keys(readSchemas), writeOperations: operations(), schemas: Object.fromEntries(Object.entries({ ...readSchemas, ...writeSchemas }).map(([key, schema]) => [key, z.toJSONSchema(schema)])) as Json, limits: { rangeCells: 2000, batchOperations: 50, batchCells: 10000 }, render: 'none', notes: ['batch 仅允许同一工作表上的 set_cells 与 format_range，全部验证后以一个命令提交，一次 undo 撤销。', 'range 使用 A1 地址，axis.index 与 sort_range.column 为 0-based。', '公式使用显式 {formula:"=..."}；普通 = 字符串保持文本。公式只保留文件缓存，不在插件内重算。', '图表、数据透视表和条件格式保持原文件，但此工具接口不创建或修改它们。'] }),
    reference: async () => capture().captured,
    resolveReference: async reference => { const target = capture(reference); assertOfficeReferenceText(reference, target.captured); return target.captured },
    read,
    execute: async ({ operation, input, reference }, guard) => {
      ensure(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      if (model.readOnlyReason) throw new Error(model.readOnlyReason)
      if (book.isCellEditing()) throw new Error('请先确认当前单元格编辑。')
      if (operation === 'undo') { const changed = await api.undo(); return { text: changed ? '已撤销上一次表格修改。' : '没有可撤销的修改。', mutated: changed } }
      const target = reference ? capture(reference) : undefined
      if (reference && target) assertOfficeReference(reference, target.captured)
      if (operation === 'replace_text') {
        if (!target || target.rows * target.columns !== 1) throw new Error('replace_text 需要一个单元格引用。')
        input = { sheetId: target.sheetId, range: target.selected.getA1Notation(), values: [[officeReplacement(input)]] }; operation = 'set_cells'
      } else if (operation === 'set_cells' && target && input?.sheetId === undefined && input?.range === undefined) input = { ...input, sheetId: target.sheetId, range: target.selected.getA1Notation() }
      const schema = writeSchemas[operation as keyof typeof writeSchemas]
      if (!schema) throw new Error('工作簿不支持此操作。')
      if (JSON.stringify(input).length > 256000) throw new Error('单次操作输入不能超过 256,000 字符。')
      const data = parse(schema, input ?? {})
      const before = signature()
      if (['set_cells', 'format_range', 'batch'].includes(operation)) {
        const entries = operation === 'batch' ? data.operations as Array<{ operation: string; input: Record<string, Json> }> : [{ operation, input: data }]
        const snapshot = book.save(); let sheetId = ''; let count = 0
        const matrix: Record<number, Record<number, ICellData>> = {}
        for (const entry of entries) {
          const range = rangeFor(entry.input.sheetId, entry.input.range); writable(range.sheetId, range.range)
          if (sheetId && sheetId !== range.sheetId) throw new Error('原子 batch 必须只修改同一工作表。')
          sheetId = range.sheetId; count += range.rows * range.columns
          if (count > 10000) throw new Error('batch 最多涉及 10,000 个单元格。')
          const values = entry.input.values as Json[][] | undefined
          if (entry.operation === 'set_cells') { noMerge(range); if (values?.length !== range.rows || values.some(row => row.length !== range.columns)) throw new Error('values 必须与 range 的行列数完全相同。') }
          const patch = entry.operation === 'format_range' ? stylePatch(entry.input.format as Record<string, Json>) : null
          for (let row = range.range.startRow; row <= range.range.endRow; row++) for (let column = range.range.startColumn; column <= range.range.endColumn; column++) {
            const old = matrix[row]?.[column] ?? snapshot.sheets[sheetId].cellData?.[row]?.[column] ?? {}
            const style = typeof old.s === 'string' ? snapshot.styles?.[old.s] : old.s
            ;(matrix[row] ??= {})[column] = patch ? { ...old, s: { ...style, ...patch } } : { ...old, ...assistantCell(values![row - range.range.startRow][column - range.range.startColumn]) }
          }
        }
        if (data.dryRun) return { text: `验证通过：${entries.length} 项，${count} 个单元格；未修改。`, mutated: false }
        guard?.signal?.throwIfAborted(); guard?.assertCurrent()
        if (!api.syncExecuteCommand('sheet.command.set-range-values', { unitId: book.getId(), subUnitId: sheetId, value: matrix })) throw new Error('单元格事务未应用，请检查保护或公式区域限制。')
      } else {
        if (operation === 'add_sheet') { if (model.structureProtected) throw new Error('工作簿结构受保护。'); if (book.getSheets().some(sheet => sheet.getSheetName() === data.name)) throw new Error('工作表名称已存在。'); book.create(String(data.name), Number(data.rows), Number(data.columns)) }
        else {
          const sheet = sheetFor(data.sheetId); const id = sheet.getSheetId(); writable(id)
          if (['rename_sheet', 'delete_sheet'].includes(operation) && model.structureProtected) throw new Error('工作簿结构受保护。')
          if (operation === 'rename_sheet') { if (book.getSheets().some(other => other.getSheetId() !== id && other.getSheetName() === data.name)) throw new Error('工作表名称已存在。'); sheet.setName(String(data.name)) }
          else if (operation === 'delete_sheet') { if (book.getSheets().length <= 1) throw new Error('不能删除最后一张工作表。'); if (!book.deleteSheet(id)) throw new Error('工作表删除失败。') }
          else if (operation === 'freeze') { const rows = Number(data.rows); const columns = Number(data.columns); if (rows >= sheet.getMaxRows() || columns >= sheet.getMaxColumns()) throw new Error('冻结数量超过工作表。'); if (!api.syncExecuteCommand('sheet.command.set-frozen', { unitId: book.getId(), subUnitId: id, startRow: rows || -1, startColumn: columns || -1, ySplit: rows, xSplit: columns })) throw new Error('冻结设置未应用。') }
          else if (['insert_axis', 'delete_axis', 'resize_axis'].includes(operation)) {
            const index = Number(data.index); const count = Number(data.count); const row = data.axis === 'row'; const size = row ? sheet.getMaxRows() : sheet.getMaxColumns()
            if (index >= size || (operation !== 'insert_axis' && index + count > size) || (operation === 'delete_axis' && count >= size) || (operation === 'insert_axis' && size + count > (row ? 1048576 : 16384))) throw new Error('行列范围超出工作表。')
            const original = model.sheets.find(item => item.id === id)
            if (operation !== 'resize_axis' && (original?.notesReadOnly || original?.readOnlyRanges.length)) throw new Error('此表含有受保护的公式/表格或特殊批注区域，不支持助手调整行列结构。')
            if (operation === 'insert_axis') { if (row) sheet.insertRows(index, count); else sheet.insertColumns(index, count) }
            if (operation === 'delete_axis') { if (row) sheet.deleteRows(index, count); else sheet.deleteColumns(index, count) }
            if (operation === 'resize_axis') { if (row) sheet.setRowHeights(index, count, Number(data.pixels)); else sheet.setColumnWidths(index, count, Number(data.pixels)) }
          } else {
            const range = rangeFor(id, data.range); writable(id, range.range)
            if (operation === 'merge_cells') { noMerge(range); const values = range.selected.getValues(); if (values.flat().slice(1).some(value => value !== null && value !== '') || range.selected.getFormulas().flat().slice(1).some(Boolean)) throw new Error('合并会丢失非首个单元格的数据，请先整理内容。'); range.selected.merge() }
            if (operation === 'unmerge_cells') range.selected.breakApart()
            if (operation === 'sort_range') { noMerge(range); if (Number(data.column) < range.range.startColumn || Number(data.column) > range.range.endColumn) throw new Error('排序列必须位于目标范围内。'); range.selected.sort({ column: Number(data.column), ascending: !!data.ascending }) }
          }
        }
      }
      return { text: `${operation} 已执行；公式缓存需在 Excel 或 LibreOffice 重算。`, mutated: signature() !== before }
    },
    reveal: async reference => { const target = capture(reference); assertOfficeReferenceText(reference, target.captured); book.setActiveSheet(target.sheet); book.setActiveRange(target.selected); return true },
  }
}
