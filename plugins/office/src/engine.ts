import JSZip from 'jszip'
import { Buffer } from 'buffer'
import * as numfmt from 'numfmt'
import { assertZipInflatesWithinLimits } from '../vendor/genoffice/packages/zip-gate/src/index'
import {
  createBufferEntrySource,
  isGridCellAddress,
  planCellEditsToXlsx,
  readBasicWorkbook,
  toA1Address,
  type CellEdit,
} from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { parseSheetElements, parseRelationships } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-sheets'
import { resolveRelTarget, relsPathFor } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-drawing-add'
import { inferWorksheetAddresses, translateSharedFormula } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-structure'
import { decodeXlsxEscapes } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-escapes'
import { parseAddress, parseRange } from '../vendor/genoffice/packages/xlsx-gateway/src/domain/cell-address'
import { parseLegacyComments } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-threaded-comments'
import type { SheetNote } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-notes'
import type { SheetFilterState } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-filter'

export type CellValue = string | number | boolean | null
export interface CellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  background?: string
  fontSize?: number
  fontFamily?: string
  numberFormat?: string
  horizontalAlign?: 'left' | 'center' | 'right' | 'justify' | 'distributed'
  textRotation?: number
  indent?: number
  baseline?: 'superscript' | 'subscript'
  wrapText?: boolean
  strikethrough?: boolean
  verticalAlign?: 'top' | 'center' | 'bottom'
  borders?: Record<string, { style: string; color?: string }>
}
export interface CellModel {
  value: CellValue
  formula?: string
  formatted?: string
  style?: CellStyle
  error?: boolean
}
export interface SheetModel {
  id: string
  name: string
  cells: Record<string, CellModel>
  merges: string[]
  rowCount: number
  columnCount: number
  hidden: boolean
  protected: boolean
  rowHeights: Record<string, number>
  columnWidths: Record<string, number>
  readOnlyRanges: string[]
  path: string
  hiddenRows?: number[]
  hiddenColumns?: number[]
  filter?: SheetFilterState['filter']
  filterReadOnly?: boolean
  notes?: SheetNote[]
  notesReadOnly?: boolean
  showGridlines?: boolean
  rightToLeft?: boolean
  zoomRatio?: number
  tabColor?: string
  freeze?: { rows: number; columns: number; topLeftCell?: string }
}
export interface WorkbookModel {
  sheets: SheetModel[]
  formulaCount: number
  warnings: string[]
  readOnlyReason?: string
  date1904: boolean
  structureProtected?: boolean
}
export interface WorkbookEdit {
  sheetName: string
  row: number
  column: number
  value: CellValue
  formula?: string
}
export interface SavedWorkbook {
  bytes: Uint8Array
  touchedEntries: string[]
  removedEntries: readonly string[]
  addedEntries: readonly string[]
  formulasNeedRecalculation: boolean
}

const MAX_BYTES = 32 * 1024 * 1024
const LIMITS = { maxParts: 5000, maxPartBytes: 32 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024 }
const MAX_CELLS = 250_000
const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
}
const DEFAULT_THEME = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#0563C1', '#954F72']

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity[0] !== '#') return named[entity] ?? match
    const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
  })
}
function attr(xml: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(xml)
  return found?.[2] === undefined ? undefined : decodeXml(found[2])
}
function section(xml: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? ''
}
function tags(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*?\\/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))].map(match => match[0])
}
function rgb(xml: string, theme: string[]): string | undefined {
  const explicit = attr(xml, 'rgb')
  let color = explicit && /^(?:[A-Fa-f\d]{6}|[A-Fa-f\d]{8})$/.test(explicit) ? `#${explicit.slice(-6)}` : undefined
  const themeIndex = attr(xml, 'theme')
  if (!color && themeIndex !== undefined) color = theme[Number(themeIndex)]
  const tint = Number(attr(xml, 'tint') ?? 0)
  if (color && Number.isFinite(tint) && tint !== 0) {
    color = `#${[1, 3, 5].map(index => {
      const channel = Number.parseInt(color!.slice(index, index + 2), 16)
      return Math.round(Math.min(255, Math.max(0, tint < 0 ? channel * (1 + tint) : channel * (1 - tint) + 255 * tint))).toString(16).padStart(2, '0')
    }).join('')}`
  }
  return color
}
function readStyles(xml: string, themeXml: string): CellStyle[] {
  const theme = [...DEFAULT_THEME]
  const scheme = /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/.exec(themeXml)?.[1] ?? ''
  const themeTags = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
  themeTags.forEach((tag, i) => {
    const part = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`).exec(scheme)?.[1] ?? ''
    const value = /<(?:\w+:)?srgbClr\b[^>]*\bval="([\da-fA-F]{6})"/.exec(part)?.[1] ?? /\blastClr="([\da-fA-F]{6})"/.exec(part)?.[1]
    if (value) theme[i] = `#${value}`
  })
  const formats = { ...BUILTIN_FORMATS }
  for (const item of tags(section(xml, 'numFmts'), 'numFmt')) {
    formats[Number(attr(item, 'numFmtId'))] = attr(item, 'formatCode') ?? 'General'
  }
  const fonts = tags(section(xml, 'fonts'), 'font')
  const fills = tags(section(xml, 'fills'), 'fill')
  const borders = tags(section(xml, 'borders'), 'border')
  return tags(section(xml, 'cellXfs'), 'xf').map(xf => {
    const font = fonts[Number(attr(xf, 'fontId') ?? 0)] ?? ''
    const fill = fills[Number(attr(xf, 'fillId') ?? 0)] ?? ''
    const alignment = /<alignment\b[^>]*\/>/.exec(xf)?.[0] ?? ''
    const align = attr(alignment, 'horizontal')
    const vertical = attr(alignment, 'vertical')
    const border = borders[Number(attr(xf, 'borderId') ?? 0)] ?? ''
    return {
      bold: /<b(?:\s[^>]*)?\s*\/>/.test(font) && !/<b\b[^>]*val="0"/.test(font),
      italic: /<i(?:\s[^>]*)?\s*\/>/.test(font) && !/<i\b[^>]*val="0"/.test(font),
      underline: /<u\b/.test(font),
      color: rgb(/<color\b[^>]*\/>/.exec(font)?.[0] ?? '', theme),
      background: /patternType="solid"/.test(fill) ? rgb(/<fgColor\b[^>]*\/>/.exec(fill)?.[0] ?? '', theme) : undefined,
      fontSize: Number(attr(/<sz\b[^>]*\/>/.exec(font)?.[0] ?? '', 'val')) || undefined,
      fontFamily: attr(/<name\b[^>]*\/>/.exec(font)?.[0] ?? '', 'val'),
      numberFormat: formats[Number(attr(xf, 'numFmtId') ?? 0)] ?? 'General',
      horizontalAlign: align === 'left' || align === 'center' || align === 'right' || align === 'justify' || align === 'distributed' ? align : undefined,
      textRotation: Number(attr(alignment, 'textRotation')) || undefined,
      indent: Number(attr(alignment, 'indent')) || undefined,
      baseline: attr(tags(font, 'vertAlign')[0] ?? '', 'val') === 'superscript' ? 'superscript' : attr(tags(font, 'vertAlign')[0] ?? '', 'val') === 'subscript' ? 'subscript' : undefined,
      wrapText: attr(alignment, 'wrapText') === '1',
      strikethrough: /<strike\b/.test(font) && !/<strike\b[^>]*val="0"/.test(font),
      verticalAlign: vertical === 'top' || vertical === 'center' || vertical === 'bottom' ? vertical : undefined,
      borders: Object.fromEntries(['top', 'bottom', 'left', 'right'].flatMap(edge => {
        const item = tags(border, edge)[0]
        const style = item && attr(item, 'style')
        return style ? [[edge, { style, color: rgb(/<color\b[^>]*\/>/.exec(item)?.[0] ?? '', theme) }]] : []
      })),
    }
  })
}
function formatValue(value: CellValue, style: CellStyle | undefined, date1904: boolean): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'number' || !style?.numberFormat || style.numberFormat === 'General') return String(value)
  try {
    const info = numfmt.getFormatDateInfo(style.numberFormat)
    const serial = date1904 && (info.day || info.month || info.year) ? value + 1462 : value
    return numfmt.format(style.numberFormat, serial)
  }
  catch { return String(value) }
}
function parseCachedValue(xml: string, type: string | undefined): CellValue {
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(xml)?.[1]
  if (raw === undefined || raw === '') return null
  if (type === 'b') return raw === '1'
  if (type === 'str' || type === 'e') return decodeXlsxEscapes(decodeXml(raw))
  const value = Number(raw)
  return Number.isFinite(value) ? value : decodeXml(raw)
}
export async function safeSource(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('工作簿为空或超过 32 MiB 上限。')
  await assertZipInflatesWithinLimits(bytes, LIMITS)
  const zip = await JSZip.loadAsync(bytes)
  for (const [path, file] of Object.entries(zip.files)) {
    const original = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? path
    if (original !== path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('工作簿包含非规范 ZIP 路径，无法安全保存。')
    }
  }
  return createBufferEntrySource(Buffer.from(bytes))
}

export async function openWorkbook(bytes: Uint8Array): Promise<WorkbookModel> {
  const source = await safeSource(bytes)
  const paths = await source.paths()
  const workbookXml = await source.readText('xl/workbook.xml')
  const date1904 = /<workbookPr\b[^>]*date1904=(["'])(?:1|true)\1/.test(workbookXml)
  if (date1904) throw new Error('此工作簿使用 1904 日期系统。当前表格视图尚不支持该日期系统，请使用 Excel / LibreOffice 打开，以免显示或保存错误日期。')
  const imported = await readBasicWorkbook(Buffer.from(bytes))
  const elements = parseSheetElements(workbookXml)
  const relationships = parseRelationships(await source.readText('xl/_rels/workbook.xml.rels'))
  const stylesXml = await source.has('xl/styles.xml') ? await source.readText('xl/styles.xml') : ''
  const themeXml = await source.has('xl/theme/theme1.xml') ? await source.readText('xl/theme/theme1.xml') : ''
  const styles = readStyles(stylesXml, themeXml)
  const model: WorkbookModel = { sheets: [], formulaCount: 0, warnings: [], date1904, structureProtected: /<workbookProtection\b[^>]*lockStructure=(["'])(?:1|true)\1/.test(workbookXml) }
  if (paths.some(path => path.startsWith('_xmlsignatures/'))) model.readOnlyReason = '此工作簿含数字签名，仅允许查看，以免使签名失效。'
  if (paths.some(path => /vbaProject\.bin$/i.test(path))) model.readOnlyReason = '此文件包含宏；本插件仅编辑无宏的 .xlsx 工作簿。'
  if (paths.includes('xl/gxRedactions.json') || /_gxRedaction_/.test(workbookXml)) model.readOnlyReason = '此工作簿包含隐私标记，仅允许查看并保留原文件。'
  if (paths.some(path => /^xl\/(?:drawings|charts|pivotTables)\//.test(path))) model.warnings.push('图片、图表与透视表保留在文件中，本视图不渲染或编辑这些对象。')
  let cellCount = 0
  for (const original of imported.snapshot.sheets) {
    const meta = elements.find(element => element.name === original.name)
    const relationship = relationships.find(entry => entry.id === meta?.relationshipId)
    if (!relationship || relationship.external) throw new Error(`工作表关系无效：${original.name}`)
    const path = resolveRelTarget('xl/workbook.xml', relationship.target)
    const xml = inferWorksheetAddresses(await source.readText(path))
    const sheet: SheetModel = {
      id: original.id, name: original.name, cells: {}, merges: [], rowCount: 1, columnCount: 1,
      hidden: meta?.hidden ?? false, protected: /<sheetProtection\b/.test(xml),
      rowHeights: {}, columnWidths: {}, readOnlyRanges: [], path,
      hiddenRows: [], hiddenColumns: [],
    }
    const sheetView = /<sheetView\b[^>]*>/.exec(xml)?.[0] ?? ''
    sheet.showGridlines = attr(sheetView, 'showGridLines') !== '0'
    sheet.rightToLeft = attr(sheetView, 'rightToLeft') === '1'
    sheet.zoomRatio = (Number(attr(sheetView, 'zoomScale')) || 100) / 100
    sheet.tabColor = rgb(tags(section(xml, 'sheetPr'), 'tabColor')[0] ?? '', DEFAULT_THEME)
    const pane = /<pane\b[^>]*\/>/.exec(xml)?.[0]
    if (pane && /^frozen/.test(attr(pane, 'state') ?? '')) {
      sheet.freeze = { rows: Number(attr(pane, 'ySplit') ?? 0), columns: Number(attr(pane, 'xSplit') ?? 0), topLeftCell: attr(pane, 'topLeftCell') }
    }
    const shared = new Map<string, { formula: string; row: number; column: number }>()
    const followers: { address: string; si: string }[] = []
    for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const address = attr(match[1] ?? '', 'r')
      if (!address || !isGridCellAddress(address)) continue
      if (++cellCount > MAX_CELLS) throw new Error('工作簿超过 250,000 个已存储单元格上限。')
      const coordinates = parseAddress(address)
      sheet.rowCount = Math.max(sheet.rowCount, coordinates.row + 1)
      sheet.columnCount = Math.max(sheet.columnCount, coordinates.column + 1)
      const body = match[2] ?? ''
      const style = styles[Number(attr(match[1] ?? '', 's') ?? 0)]
      const cell: CellModel = { ...(original.cells[address] ?? { value: null }), style }
      const formula = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body)
      const type = attr(match[1] ?? '', 't')
      if (formula) {
        model.formulaCount += 1
        cell.value = parseCachedValue(body, type)
        if (formula[2]) cell.formula = `=${decodeXml(formula[2])}`
        const formulaType = attr(formula[1] ?? '', 't')
        const si = attr(formula[1] ?? '', 'si')
        if (formulaType === 'shared' && si !== undefined) {
          if (cell.formula) shared.set(si, { formula: cell.formula, ...coordinates })
          else followers.push({ address, si })
        }
        if (formulaType === 'array' || formulaType === 'dataTable') sheet.readOnlyRanges.push(attr(formula[1] ?? '', 'ref') ?? address)
      }
      cell.error = type === 'e'
      cell.formatted = formatValue(cell.value, style, date1904)
      sheet.cells[address] = cell
    }
    for (const { address, si } of followers) {
      const master = shared.get(si)
      if (!master) throw new Error(`共享公式缺少主单元格：${sheet.name}!${address}`)
      const position = parseAddress(address)
      const translated = translateSharedFormula(master.formula, position.row - master.row, position.column - master.column)
      if (translated === null) throw new Error(`共享公式超出工作表范围：${sheet.name}!${address}`)
      sheet.cells[address]!.formula = translated
    }
    sheet.merges = tags(xml, 'mergeCell').map(tag => attr(tag, 'ref')).filter((ref): ref is string => !!ref)
    for (const merge of sheet.merges) {
      const bounds = parseRange(merge)
      sheet.rowCount = Math.max(sheet.rowCount, bounds.endRow + 1)
      sheet.columnCount = Math.max(sheet.columnCount, bounds.endColumn + 1)
    }
    for (const row of xml.matchAll(/<row\b[^>]*>/g)) {
      const index = Number(attr(row[0], 'r')) - 1
      const height = Number(attr(row[0], 'ht'))
      if (index >= 0 && height > 0) sheet.rowHeights[String(index)] = height * 4 / 3
      if (index >= 0 && attr(row[0], 'hidden') === '1') sheet.hiddenRows!.push(index)
    }
    for (const column of tags(section(xml, 'cols'), 'col')) {
      const start = Number(attr(column, 'min')) - 1
      const end = Math.min(Number(attr(column, 'max')) - 1, 16383)
      const width = Number(attr(column, 'width'))
      if (start >= 0 && width > 0) for (let i = start; i <= end; i++) sheet.columnWidths[String(i)] = Math.max(24, width * 7 + 5)
      if (start >= 0 && attr(column, 'hidden') === '1') for (let i = start; i <= end; i++) sheet.hiddenColumns!.push(i)
    }
    const filterTag = tags(xml, 'autoFilter')[0]
    const filterRef = filterTag && attr(filterTag, 'ref')
    if (filterTag && filterRef) {
      sheet.filterReadOnly = /<(?:colorFilter|dynamicFilter|top10|iconFilter|dateGroupItem)\b/.test(filterTag)
      sheet.filter = { range: parseRange(filterRef), columns: tags(filterTag, 'filterColumn').map(column => {
        const custom = tags(column, 'customFilters')[0]
        return { colId: Number(attr(column, 'colId')), values: tags(column, 'filter').map(filter => attr(filter, 'val') ?? ''), blank: attr(tags(column, 'filters')[0] ?? '', 'blank') === '1', ...(custom ? { customs: { and: attr(custom, 'and') === '1', filters: tags(custom, 'customFilter').map(filter => ({ val: attr(filter, 'val') ?? '', operator: attr(filter, 'operator') ?? 'equal' })) } } : {}) }
      }) }
    }
    const relsPath = relsPathFor(path)
    if (await source.has(relsPath)) {
      for (const rel of parseRelationships(await source.readText(relsPath))) {
        if (rel.external) continue
        if (rel.type.endsWith('/comments')) sheet.notes = [...parseLegacyComments(await source.readText(resolveRelTarget(path, rel.target)))].map(([address, note]) => ({ ...parseAddress(address), ...note }))
        if (rel.type.endsWith('/threadedComment')) sheet.notesReadOnly = true
        if (!rel.type.endsWith('/table')) continue
        const tableXml = await source.readText(resolveRelTarget(path, rel.target))
        const tableTag = /<table\b[^>]*>/.exec(tableXml)?.[0] ?? ''
        const ref = attr(tableTag, 'ref')
        if (ref && attr(tableTag, 'headerRowCount') !== '0') {
          const bounds = parseRange(ref)
          sheet.readOnlyRanges.push(`${toA1Address(bounds.startRow, bounds.startColumn)}:${toA1Address(bounds.startRow, bounds.endColumn)}`)
        }
      }
    }
    model.sheets.push(sheet)
  }
  if (model.sheets.length !== elements.length) model.readOnlyReason = '此文件包含无法完整读取的工作表，仅允许查看。'
  if (model.sheets.some(sheet => sheet.protected)) model.warnings.push('受保护工作表仅允许查看。')
  if (model.formulaCount) model.warnings.push('公式显示文件内上次计算结果；修改后的文件由 Excel 或 LibreOffice 重新计算。')
  return model
}

function inside(address: { row: number; column: number }, range: string): boolean {
  const bounds = parseRange(range)
  return address.row >= bounds.startRow && address.row <= bounds.endRow && address.column >= bounds.startColumn && address.column <= bounds.endColumn
}
export async function saveWorkbook(bytes: Uint8Array, edits: readonly WorkbookEdit[]): Promise<SavedWorkbook> {
  if (edits.length > 50_000) throw new Error('一次保存最多修改 50,000 个单元格。')
  if (edits.length === 0) return { bytes: bytes.slice(), touchedEntries: [], addedEntries: [], removedEntries: [], formulasNeedRecalculation: false }
  const model = await openWorkbook(bytes)
  if (model.readOnlyReason) throw new Error(model.readOnlyReason)
  const converted: CellEdit[] = []
  for (const edit of edits) {
    const sheet = model.sheets.find(entry => entry.name === edit.sheetName)
    if (!sheet) throw new Error(`不存在工作表：${edit.sheetName}`)
    if (sheet.protected) throw new Error(`工作表已保护：${edit.sheetName}`)
    if (!Number.isInteger(edit.row) || edit.row < 0 || edit.row > 1_048_575 || !Number.isInteger(edit.column) || edit.column < 0 || edit.column > 16_383) throw new Error('单元格坐标超出 XLSX 范围。')
    if (sheet.readOnlyRanges.some(range => inside(edit, range))) throw new Error('数组公式、数据表及表格标题区域暂不支持编辑。')
    for (const range of sheet.merges) {
      const bounds = parseRange(range)
      if (inside(edit, range) && (edit.row !== bounds.startRow || edit.column !== bounds.startColumn)) throw new Error('合并区域只能编辑左上角单元格。')
    }
    if (typeof edit.value === 'number' && !Number.isFinite(edit.value)) throw new Error('数值必须为有限数字。')
    if (!(edit.value === null || ['string', 'number', 'boolean'].includes(typeof edit.value))) throw new Error('无效单元格值。')
    if (typeof edit.value === 'string' && edit.value.length > 32767) throw new Error('单元格文本超过 Excel 的 32,767 字符上限。')
    if (edit.formula !== undefined && (typeof edit.formula !== 'string' || !edit.formula.startsWith('=') || edit.formula.length < 2 || edit.formula.length > 8192)) throw new Error('公式应以 = 开头，且不超过 8,192 字符。')
    converted.push({ sheetName: edit.sheetName, row: edit.row, column: edit.column, writeValue: true, cell: { value: edit.value, ...(edit.formula ? { formula: edit.formula } : {}) } })
  }
  const source = await safeSource(bytes)
  const plan = await planCellEditsToXlsx(source, converted)
  const replaced = new Map(plan.replaced)
  let hasFormulas = false
  for (const sheet of model.sheets) {
    const xml = replaced.get(sheet.path) ?? await source.readText(sheet.path)
    const updated = xml.replace(/<c\b([^>]*?)>([\s\S]*?)<\/c>/g, (full, attributes: string, content: string) => {
      if (!/<f\b/.test(content)) return full
      hasFormulas = true
      return `<c${attributes.replace(/\s+t=(?:"(?:str|b|e)"|'(?:str|b|e)')/g, '')}>${content.replace(/<v\b[^>]*\/>|<v\b[^>]*>[\s\S]*?<\/v>/g, '')}</c>`
    })
    if (updated !== xml) replaced.set(sheet.path, updated)
  }
  if (hasFormulas) {
    let xml = replaced.get('xl/workbook.xml') ?? await source.readText('xl/workbook.xml')
    const calculation = '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>'
    if (/<calcPr\b/.test(xml)) xml = xml.replace(/<calcPr\b[^>]*\/>|<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/, calculation)
    else {
      const anchor = xml.includes('</definedNames>') ? '</definedNames>' : '</sheets>'
      xml = xml.replace(anchor, `${anchor}${calculation}`)
    }
    replaced.set('xl/workbook.xml', xml)
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  for (const path of plan.removedEntries) zip.remove(path)
  for (const [path, value] of replaced) zip.file(path, value, { createFolders: false })
  for (const [path, value] of plan.added) zip.file(path, value, { createFolders: false })
  for (const [path, value] of plan.addedBinary) zip.file(path, value, { createFolders: false })
  const result = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  await assertZipInflatesWithinLimits(result, LIMITS)
  return { bytes: result, touchedEntries: [...replaced.keys()], removedEntries: plan.removedEntries, addedEntries: plan.addedEntries, formulasNeedRecalculation: hasFormulas }
}
