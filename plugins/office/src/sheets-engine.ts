import JSZip from 'jszip'
import { openWorkbook, safeSource, type SavedWorkbook } from './engine'
import { planCellEditsToXlsx, type CellEdit, type SheetStructuralOps, type SheetCfState, type SheetDvState, type SheetNoteState, type SheetTabColorState } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-gateway'
import type { SheetEditPlan } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-sheets'
import type { SheetFilterState } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-filter'
import type { SheetPageSetupState } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-page-setup'
import { parseRange } from '../vendor/genoffice/packages/xlsx-gateway/src/domain/cell-address'
import { shiftCellArea } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-structure'
import { workbookStyleEditSchema } from '../vendor/genoffice/packages/xlsx-gateway/src/shared/edit-schemas'

export interface SheetSaveRequest {
  edits: CellEdit[]
  structuralOps: SheetStructuralOps[]
  sheetPlan?: SheetEditPlan
  filterStates: SheetFilterState[]
  pageSetupStates: SheetPageSetupState[]
  cfStates?: SheetCfState[]
  dvStates?: SheetDvState[]
  noteStates?: SheetNoteState[]
  tabColorStates?: SheetTabColorState[]
}

export async function saveSheetChanges(bytes: Uint8Array, request: SheetSaveRequest): Promise<SavedWorkbook> {
  const { edits, structuralOps, sheetPlan, filterStates, pageSetupStates, cfStates = [], dvStates = [], noteStates = [], tabColorStates = [] } = request
  if (!edits.length && !structuralOps.length && !sheetPlan && !filterStates.length && !pageSetupStates.length && !cfStates.length && !dvStates.length && !noteStates.length && !tabColorStates.length) {
    return { bytes: bytes.slice(), touchedEntries: [], removedEntries: [], addedEntries: [], formulasNeedRecalculation: false }
  }
  const model = await openWorkbook(bytes)
  if (model.readOnlyReason) throw new Error(model.readOnlyReason)
  if (model.structureProtected && sheetPlan) throw new Error('工作簿结构已保护，无法更改工作表。')
  if (edits.length > 250_000) throw new Error('一次保存最多修改 250,000 个单元格。')
  const names = new Set([...model.sheets.map(sheet => sheet.name), ...sheetPlan?.additions.map(sheet => sheet.name) ?? []])
  for (const edit of edits) {
    if (!names.has(edit.sheetName)) throw new Error(`不存在工作表：${edit.sheetName}`)
    if (!Number.isInteger(edit.row) || edit.row < 0 || edit.row >= 1048576 || !Number.isInteger(edit.column) || edit.column < 0 || edit.column >= 16384) throw new Error('单元格坐标超出 XLSX 范围。')
    if (typeof edit.cell.value === 'number' && !Number.isFinite(edit.cell.value)) throw new Error('数值必须为有限数字。')
    if (typeof edit.cell.value === 'string' && edit.cell.value.length > 32767) throw new Error('单元格文本超过 Excel 的 32,767 字符上限。')
    if (edit.cell.formula && (edit.cell.formula.length > 8192 || !edit.cell.formula.startsWith('='))) throw new Error('公式应以 = 开头，且不超过 8,192 字符。')
    if (edit.style) workbookStyleEditSchema.parse(edit.style)
    const sheet = model.sheets.find(item => item.name === edit.sheetName)
    const ops = structuralOps.find(item => item.sheetName === edit.sheetName)?.ops ?? []
    if (edit.writeValue !== false && sheet?.readOnlyRanges.some(ref => {
      const range = shiftCellArea(parseRange(ref), ops)
      return range && edit.row >= range.startRow && edit.row <= range.endRow && edit.column >= range.startColumn && edit.column <= range.endColumn
    })) throw new Error('数组公式、数据表及表格标题区域暂不支持编辑。')
  }
  const adjustedNoteStates = [...noteStates]
  for (const { sheetName, ops } of structuralOps) {
    if (!ops.some(op => 'index' in op)) continue
    const sheet = model.sheets.find(item => item.name === sheetName)
    if (sheet?.notesReadOnly) throw new Error('此表包含线程批注，暂不支持行列结构修改。')
    if (!sheet?.notes?.length || adjustedNoteStates.some(state => state.sheetName === sheetName)) continue
    adjustedNoteStates.push({ sheetName, notes: sheet.notes.flatMap(note => {
      const moved = shiftCellArea({ startRow: note.row, endRow: note.row, startColumn: note.column, endColumn: note.column }, ops)
      return moved ? [{ ...note, row: moved.startRow, column: moved.startColumn }] : []
    }) })
  }
  const affected = new Set([...edits, ...structuralOps, ...filterStates, ...pageSetupStates, ...cfStates, ...dvStates, ...adjustedNoteStates, ...tabColorStates].map(item => item.sheetName))
  for (const sheet of model.sheets) {
    if (sheet.protected && (affected.has(sheet.name) || sheetPlan?.removals.includes(sheet.name) || sheetPlan?.renames.some(item => item.sheetName === sheet.name))) throw new Error(`工作表已保护：${sheet.name}`)
  }
  const source = await safeSource(bytes)
  const plan = await planCellEditsToXlsx(source, edits, structuralOps, [], sheetPlan, filterStates, [], cfStates, dvStates, [], null, [], pageSetupStates, adjustedNoteStates, [], [], [], [], [], [], [], null, null, [], [], tabColorStates)
  const touchedEntries = new Set(plan.replaced.keys())
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  for (const path of plan.removedEntries) zip.remove(path)
  for (const [path, value] of [...plan.replaced, ...plan.added, ...plan.addedBinary]) zip.file(path, value, { createFolders: false })
  let formulasNeedRecalculation = false
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue
    const xml = await entry.async('text')
    const updated = xml.replace(/<c\b([^>]*?)>([\s\S]*?)<\/c>/g, (full, attributes: string, content: string) => {
      if (!/<f\b/.test(content)) return full
      formulasNeedRecalculation = true
      return `<c${attributes.replace(/\s+t=(?:"(?:str|b|e)"|'(?:str|b|e)')/g, '')}>${content.replace(/<v\b[^>]*\/>|<v\b[^>]*>[\s\S]*?<\/v>/g, '')}</c>`
    })
    if (updated !== xml) { zip.file(path, updated); touchedEntries.add(path) }
  }
  const result = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  await safeSource(result)
  return { bytes: result, touchedEntries: [...touchedEntries], removedEntries: plan.removedEntries, addedEntries: plan.addedEntries, formulasNeedRecalculation }
}
