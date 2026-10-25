import { LocaleType, BaselineOffset, BooleanNumber, CellValueType, HorizontalAlign, VerticalAlign, BorderStyleTypes, WrapStrategy, type ICellData, type IWorkbookData, type IStyleData } from '@univerjs/core'
import type { CellStyle, WorkbookModel } from './engine'

function position(address: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address.trim().toUpperCase())
  if (!match) throw new Error('请输入有效单元格地址，例如 A1。')
  const column = [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
  const row = Number(match[2]) - 1
  if (column >= 16384 || row >= 1048576) throw new Error('单元格地址超出 Excel 范围。')
  return { row, column }
}
function area(ref: string) {
  const [start, end = start] = ref.split(':')
  const a = position(start.replaceAll('$', ''))
  const b = position(end.replaceAll('$', ''))
  return { startRow: a.row, startColumn: a.column, endRow: b.row, endColumn: b.column }
}
function cellStyle(style?: CellStyle): IStyleData | undefined {
  if (!style) return undefined
  return {
    ff: style.fontFamily, fs: style.fontSize,
    it: style.italic ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    ...(style.underline ? { ul: { s: BooleanNumber.TRUE } } : {}),
    ...(style.strikethrough ? { st: { s: BooleanNumber.TRUE } } : {}),
    bl: style.bold ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    ...(style.baseline ? { va: style.baseline === 'superscript' ? BaselineOffset.SUPERSCRIPT : BaselineOffset.SUBSCRIPT } : {}),
    ...(style.textRotation ? { tr: style.textRotation === 255 ? { a: 0, v: BooleanNumber.TRUE } : { a: style.textRotation > 90 ? 90 - style.textRotation : style.textRotation } } : {}),
    ...(style.indent ? { pd: { l: style.indent * 8 } } : {}),
    vt: style.verticalAlign === 'top' ? VerticalAlign.TOP : style.verticalAlign === 'center' ? VerticalAlign.MIDDLE : VerticalAlign.BOTTOM,
    bd: Object.fromEntries(Object.entries(style.borders ?? {}).map(([edge, item]) => [edge[0], { s: ({ thin: BorderStyleTypes.THIN, medium: BorderStyleTypes.MEDIUM, thick: BorderStyleTypes.THICK, dashed: BorderStyleTypes.DASHED, dotted: BorderStyleTypes.DOTTED, double: BorderStyleTypes.DOUBLE } as Record<string, BorderStyleTypes>)[item.style] ?? BorderStyleTypes.THIN, cl: { rgb: item.color ?? '#000000' } }])),
    ...(style.color ? { cl: { rgb: style.color } } : {}),
    ...(style.background ? { bg: { rgb: style.background } } : {}),
    ...(style.numberFormat ? { n: { pattern: style.numberFormat } } : {}),
    ht: style.horizontalAlign === 'center' ? HorizontalAlign.CENTER : style.horizontalAlign === 'right' ? HorizontalAlign.RIGHT : style.horizontalAlign === 'justify' ? HorizontalAlign.JUSTIFIED : style.horizontalAlign === 'distributed' ? HorizontalAlign.DISTRIBUTED : HorizontalAlign.LEFT,
    tb: style.wrapText ? WrapStrategy.WRAP : WrapStrategy.OVERFLOW,
  }
}
export function toUniver(model: WorkbookModel, name: string): Partial<IWorkbookData> {
  return {
    id: crypto.randomUUID(), name, locale: LocaleType.ZH_CN,
    sheetOrder: model.sheets.map(sheet => sheet.id),
    sheets: Object.fromEntries(model.sheets.map(sheet => {
      const cellData: Record<number, Record<number, ICellData>> = {}
      for (const [ref, cell] of Object.entries(sheet.cells)) {
        const { row, column } = position(ref)
        const t = cell.error ? CellValueType.FORCE_STRING : typeof cell.value === 'number' ? CellValueType.NUMBER : typeof cell.value === 'boolean' ? CellValueType.BOOLEAN : CellValueType.STRING
        ;(cellData[row] ??= {})[column] = { v: cell.value, ...(cell.formula ? { f: cell.formula.startsWith('=') ? cell.formula : `=${cell.formula}` } : {}), t, s: cellStyle(cell.style) }
      }
      return [sheet.id, {
        showGridlines: sheet.showGridlines === false ? BooleanNumber.FALSE : BooleanNumber.TRUE, rightToLeft: sheet.rightToLeft ? BooleanNumber.TRUE : BooleanNumber.FALSE, zoomRatio: sheet.zoomRatio ?? 1, tabColor: sheet.tabColor,
        id: sheet.id, name: sheet.name, hidden: sheet.hidden ? BooleanNumber.TRUE : BooleanNumber.FALSE,
        rowCount: Math.min(1048576, Math.max(200, sheet.rowCount + 50)), columnCount: Math.min(16384, Math.max(26, sheet.columnCount + 5)),
        cellData, mergeData: sheet.merges.map(area), ...(sheet.freeze ? { freeze: { xSplit: sheet.freeze.columns, ySplit: sheet.freeze.rows, startRow: sheet.freeze.rows || -1, startColumn: sheet.freeze.columns || -1 } } : {}), defaultColumnWidth: 110, defaultRowHeight: 26,
        rowData: Object.fromEntries([...new Set([...Object.keys(sheet.rowHeights), ...sheet.hiddenRows?.map(String) ?? []])].map(index => [index, { h: sheet.rowHeights[index], hd: sheet.hiddenRows?.includes(Number(index)) ? BooleanNumber.TRUE : BooleanNumber.FALSE }])),
        columnData: Object.fromEntries([...new Set([...Object.keys(sheet.columnWidths), ...sheet.hiddenColumns?.map(String) ?? []])].map(index => [index, { w: sheet.columnWidths[index], hd: sheet.hiddenColumns?.includes(Number(index)) ? BooleanNumber.TRUE : BooleanNumber.FALSE }])),
      }]
    })),
  }
}
