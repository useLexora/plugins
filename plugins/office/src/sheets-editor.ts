import { installSheetsReferenceMenu } from './sheets-reference-menu'
import type { OfficeEditorOptions } from './office-editor-types'
import { createSheetsAssistant } from './sheets-assistant'
import { SheetsSelectionsService } from '@univerjs/sheets'
import type { OfficeEditorAssistant } from './office-editor-types'
import { IUniverInstanceService, LifecycleService, LifecycleStages, LocaleType, mergeLocales, UniverInstanceType, type ICellData, type IRange, type IWorkbookData } from '@univerjs/core'
import { DocSelectionManagerService } from '@univerjs/docs'
import { IClipboardInterfaceService } from '@univerjs/ui'
import { UniverSheetsCorePreset, CalculationMode } from '@univerjs/preset-sheets-core'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import { UniverSheetsNotePreset, SheetsNotePopupService } from '@univerjs/preset-sheets-note'
import noteZh from '@univerjs/preset-sheets-note/locales/zh-CN'
import '@univerjs/preset-sheets-note/lib/index.css'
import coreZh from '@univerjs/preset-sheets-core/locales/zh-CN'
import filterZh from '@univerjs/preset-sheets-filter/locales/zh-CN'
import sortZh from '@univerjs/preset-sheets-sort/locales/zh-CN'
import findZh from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import { parseRange } from '../vendor/genoffice/packages/xlsx-gateway/src/domain/cell-address'
import { shiftCellArea } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-structure'
import { sharedFormulaResolverFor } from '../vendor/genoffice/apps/sheets/src/renderer/shared-formula-journal'
import { createUniver } from './create-univer'
import { createSheetsClipboard } from './sheets-clipboard'
import '@univerjs/preset-sheets-core/lib/index.css'
import { toUniver } from './workbook-projection'
import type { ViewContext } from './lexora'
import type { SavedWorkbook, WorkbookModel } from './engine'
import type { SheetSaveRequest } from './sheets-engine'
import {
  createEditJournal, recordSetRangeValues, recordSetNumfmt, recordRemoveNumfmt,
  recordStructuralOp, recordSheetInsert, recordSheetRemove, recordSheetDuplicate,
  recordSheetRename, recordSheetHidden, recordSheetTabColor, recordPageSetup,
  recordNoteChange, recordFilterChange, toSaveEdits, resolveDuplicateSource, type EditJournal,
} from '../vendor/genoffice/apps/sheets/src/renderer/edit-journal'
import {
  ROW_COLUMN_MUTATIONS, MERGE_MUTATIONS, AXIS_ATTR_MUTATIONS, FILTER_MUTATIONS,
  SHEET_LIFECYCLE_MUTATIONS, SET_RANGE_VALUES_MUTATION, SET_NUMFMT_MUTATION,
  REMOVE_NUMFMT_MUTATION, SET_FROZEN_MUTATION, TOGGLE_GRIDLINES_MUTATION,
  REORDER_RANGE_MUTATION, COPY_SHEET_COMMAND, pixelsToCharacterWidth, NOTE_MUTATIONS,
} from '../vendor/genoffice/apps/sheets/src/renderer/app-constants'

export type SheetsMountOptions = OfficeEditorOptions
export interface SheetsEditorHandle {
  assistant?: OfficeEditorAssistant
  save: () => Promise<Uint8Array>
  markSaved: (bytes?: Uint8Array) => void
  dispose: () => void
}
interface MutationParams {
  unitId?: string
  subUnitId?: string
  sheetId?: string
  xSplit?: number
  ySplit?: number
  rightToLeft?: number
  zoomRatio?: number
  row?: number
  col?: number
  note?: { note?: string }
  cellValue?: unknown
  range?: IRange
  ranges?: IRange[]
  sheet?: { id?: string; name?: string }
  name?: string
  hidden?: number | boolean
  color?: unknown
  rowHeight?: number | Record<number, number>
  colWidth?: number | Record<number, number>
  autoHeightInfo?: number | Record<number, number>
  frozen?: { xSplit: number; ySplit: number }
  showGridlines?: number
}

export function sheetPlanFromSnapshot(model: WorkbookModel, snapshot: IWorkbookData, journal: EditJournal): SheetSaveRequest['sheetPlan'] {
  const originalIds = new Set(model.sheets.map(sheet => sheet.id))
  const renames = model.sheets.flatMap(sheet => {
    const current = snapshot.sheets[sheet.id]
    return current && current.name !== sheet.name ? [{ sheetName: sheet.name, newName: current.name! }] : []
  })
  const additions = snapshot.sheetOrder.filter(id => !originalIds.has(id)).map(id => {
    const source = resolveDuplicateSource(journal, id)
    const sourceName = model.sheets.find(sheet => sheet.id === source)?.name
    return { name: snapshot.sheets[id].name!, ...(sourceName ? { sourceSheetName: sourceName } : {}) }
  })
  const removals = model.sheets.filter(sheet => !snapshot.sheets[sheet.id]).map(sheet => sheet.name)
  const hiddenChanges = model.sheets.flatMap(sheet => {
    const current = snapshot.sheets[sheet.id]
    return current && (current.hidden === 1) !== sheet.hidden ? [{ sheetName: sheet.name, hidden: current.hidden === 1 }] : []
  })
  const orderChanged = JSON.stringify(model.sheets.map(sheet => sheet.id)) !== JSON.stringify(snapshot.sheetOrder)
  if (!renames.length && !additions.length && !removals.length && !hiddenChanges.length && !orderChanged) return undefined
  return { renames, additions, removals, hiddenChanges, order: snapshot.sheetOrder.map(id => snapshot.sheets[id].name!), orderChanged }
}

export async function mountSheets(options: SheetsMountOptions): Promise<SheetsEditorHandle> {
  const { context, container, bytes, name, onDirty, onSave, onSaveRequest } = options
  context.signal.throwIfAborted()
  container.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;position:relative'
  const notice = document.createElement('div')
  notice.style.cssText = 'flex:none;padding:6px 12px;font-size:12px;color:var(--muted,#667085);background:var(--surface,#fff);border-bottom:1px solid var(--border,#e5e7eb)'
  notice.setAttribute('role', 'status')
  notice.textContent = '正在打开工作簿…'
  const grid = document.createElement('div')
  grid.style.cssText = 'flex:1;min-height:0;position:relative;overflow:hidden'
  container.replaceChildren(notice, grid)
  const fail = (error: unknown) => { notice.hidden = false; notice.textContent = error instanceof Error ? error.message : String(error); notice.setAttribute('role', 'alert') }
  const worker = await context.workers.create(new URL('./engine-worker.js', import.meta.url), { type: 'module' })
  if (context.signal.aborted) { worker.terminate(); context.signal.throwIfAborted() }
  const css = document.createElement('link')
  css.rel = 'stylesheet'; css.href = new URL('./sheets-editor.css', import.meta.url).href
  document.head.append(css)
  let serial = 0
  let disposed = false
  const cleanup: (() => void)[] = []
  let suppressed = true
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const rpc = <T>(method: string, data: object = {}) => new Promise<T>((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { calls.delete(id); reject(new Error('工作簿处理超时，请保留当前文档并重试。')) }, 120000)
    calls.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    worker.postMessage({ id, method, ...data })
  })
  const rejectAll = (error: Error) => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error) }; calls.clear() }
  worker.addEventListener('message', event => {
    const call = calls.get(event.data.id)
    if (!call) return
    calls.delete(event.data.id); clearTimeout(call.timer)
    if (event.data.error) call.reject(new Error(event.data.error)); else call.resolve(event.data.result)
  })
  worker.addEventListener('error', event => { const error = new Error(event.message || '表格引擎运行失败'); rejectAll(error); fail(error) })
  let runtime: ReturnType<typeof createUniver> | undefined = undefined
  let stopReferenceMenu = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopReferenceMenu()
    cleanup.splice(0).forEach(fn => fn())
    rejectAll(new Error('文档已关闭'))
    worker.terminate()
    runtime?.univer.dispose()
    css.remove()
    context.signal.removeEventListener('abort', dispose)
    container.removeEventListener('keydown', keydown)
  }
  let savingFromKeyboard = false
  const keydown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      if ((onSaveRequest || onSave) && !savingFromKeyboard) {
        savingFromKeyboard = true
        const task = onSaveRequest ? onSaveRequest() : save().then(async bytes => { await onSave!(bytes); markSaved(bytes) })
        void task.catch(fail).finally(() => { savingFromKeyboard = false })
      }
    }
  }
  context.signal.addEventListener('abort', dispose, { once: true })
  let model: WorkbookModel
  try { model = await rpc<WorkbookModel>('open', { bytes }) }
  catch (error) { dispose(); throw error }
  if (disposed || context.signal.aborted) { dispose(); throw new Error('文档已关闭') }
  const journal = createEditJournal()
  let editingDirty = false
  const pendingNotes = new Map<string, { sheetId: string; row: number; col: number; text: string }>()
  let savedSignature = ''
  let serializedSignature = ''
  const serialized = new WeakMap<Uint8Array, string>()
  let copySource: string | undefined
  let clipboardRevision = 0
  const clipboardTarget = () => {
    const injector = runtime!.univer.__getInjector()
    const doc = injector.get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)
    const selection = injector.get(DocSelectionManagerService)
    return JSON.stringify([clipboardRevision, book.getActiveSheet()?.getSheetId(), book.getActiveRange()?.getRange(), book.isCellEditing(), doc?.getUnitId(), selection.getTextRanges(), selection.getRectRanges()])
  }
  const clipboard = createSheetsClipboard(context.clipboard, context.signal, () => {
    const target = clipboardTarget()
    return () => {
      if (disposed) throw new Error('文档已关闭')
      if (target !== clipboardTarget()) throw new Error('编辑位置已改变，请重新复制或粘贴。')
    }
  }, fail)
  runtime = createUniver({
    override: [[IClipboardInterfaceService, { useValue: clipboard }]],
    locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: mergeLocales(coreZh, filterZh, sortZh, findZh, noteZh) },
    presets: [
      UniverSheetsCorePreset({ container: grid, header: true, toolbar: true, formulaBar: true, menu: Object.fromEntries([
        'sheet.command.add-range-protection-from-toolbar', 'sheet.command.add-range-protection-from-context-menu',
        'sheet.command.view-sheet-permission-from-context-menu', 'sheet.command.add-range-protection-from-sheet-bar',
        'sheet.command.view-sheet-permission-from-sheet-bar', 'sheet.command.delete-range-protection-from-context-menu',
        'sheet.command.set-range-protection-from-context-menu', 'sheet.command.delete-worksheet-protection-from-sheet-bar',
        'sheet.command.change-sheet-protection-from-sheet-bar', 'sidebar.operation.defined-name',
      ].map(id => [id, { hidden: true }])) , footer: { sheetBar: true, statisticBar: true, menus: true, zoomSlider: true }, contextMenu: true, disableAutoFocus: true, formula: { initialFormulaComputing: CalculationMode.NO_CALCULATION } }),
      UniverSheetsFilterPreset(), UniverSheetsSortPreset(), UniverSheetsFindReplacePreset(), UniverSheetsNotePreset(),
    ],
  })
  const api = runtime.univerAPI
  const book = api.createWorkbook(toUniver(model, name))
  const nameFor = (id: string) => model.sheets.find(sheet => sheet.id === id)?.name ?? book.getSheetBySheetId(id)?.getSheetName() ?? ''
  for (const sheet of model.sheets) {
    if (!sheet.notesReadOnly) for (const note of sheet.notes ?? []) book.getSheetBySheetId(sheet.id)?.getRange(note.row, note.column).createOrUpdateNote({ id: `note-${sheet.id}-${note.row}-${note.column}`, row: note.row, col: note.column, width: 220, height: 90, note: note.author ? `${note.author}:\n${note.text}` : note.text })
    if (!sheet.filter || sheet.filterReadOnly) continue
    await api.executeCommand('sheet.mutation.set-filter-range', { unitId: book.getId(), subUnitId: sheet.id, range: sheet.filter.range })
    for (const column of sheet.filter.columns) {
      await api.executeCommand('sheet.mutation.set-filter-criteria', { unitId: book.getId(), subUnitId: sheet.id, col: sheet.filter.range.startColumn + column.colId, criteria: { colId: column.colId, ...(column.values?.length || column.blank ? { filters: { filters: column.values ?? [], blank: column.blank } } : {}), ...(column.customs ? { customFilters: { and: column.customs.and, customFilters: column.customs.filters } } : {}) } })
    }
  }
  const signature = () => JSON.stringify({
    editingDirty, pendingNotes: [...pendingNotes], cells: toSaveEdits(journal), structural: [...journal.structuralOps], sheetPlan: sheetPlanFromSnapshot(model, book.save(), journal),
    filters: [...journal.filterDirty].map(id => book.getSheetBySheetId(id)?.getFilter()?.getFilteredOutRows()),
    notes: [...journal.noteDirty].map(id => [id, book.getSheetBySheetId(id)?.getNotes()]), page: [...journal.pageSetup], colors: [...journal.sheets.tabColor], revision: filterRevision,
  })
  let filterRevision = 0
  let reportedSignature = ''
  let reportedDirty = false
  const dirty = () => {
    if (disposed || suppressed) return
    const current = signature()
    const value = current !== savedSignature
    if (current !== reportedSignature || value !== reportedDirty) {
      reportedSignature = current; reportedDirty = value; onDirty(value)
    }
  }
  const snapshotRange = (sheetId: string, range: IRange) => {
    const snapshot = book.save()
    const sheet = snapshot.sheets[sheetId]
    if (!sheet) return
    if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 250000) throw new Error('一次操作最多处理 250,000 个单元格。')
    const values: Record<number, Record<number, ICellData>> = {}
    for (let row = range.startRow; row <= range.endRow; row++) {
      const cells: Record<number, ICellData> = values[row] = {}
      for (let col = range.startColumn; col <= range.endColumn; col++) {
        const cell = sheet.cellData?.[row]?.[col]
        const style = typeof cell?.s === 'string' ? snapshot.styles?.[cell.s] : cell?.s
        cells[col] = cell ? { ...cell, s: style ?? undefined } : { v: null, f: null, p: null }
      }
    }
    recordSetRangeValues(journal, sheetId, values, sharedFormulaResolverFor(runtime!, sheetId))
  }
  const mutation = (id: string, p: MutationParams) => {
    const sheetId = p.subUnitId ?? p.sheetId
    if (SHEET_LIFECYCLE_MUTATIONS.has(id)) {
      if (id === 'sheet.mutation.insert-sheet' && p.sheet?.id && p.sheet.name) {
        if (copySource) recordSheetDuplicate(journal, p.sheet.id, p.sheet.name, copySource)
        else recordSheetInsert(journal, p.sheet.id, p.sheet.name)
      }
      if (sheetId) {
        if (id === 'sheet.mutation.remove-sheet') recordSheetRemove(journal, sheetId)
        if (id === 'sheet.mutation.set-worksheet-name' && p.name) recordSheetRename(journal, sheetId, p.name, nameFor(sheetId))
        if (id === 'sheet.mutation.set-worksheet-hidden') recordSheetHidden(journal, sheetId, p.hidden === true || p.hidden === 1, model.sheets.find(sheet => sheet.id === sheetId)?.hidden ?? false)
        if (id === 'sheet.mutation.set-tab-color') recordSheetTabColor(journal, sheetId, p.color, model.sheets.find(sheet => sheet.id === sheetId)?.tabColor ?? null)
      }
      return
    }
    if (!sheetId) return
    if (id === SET_RANGE_VALUES_MUTATION) recordSetRangeValues(journal, sheetId, p.cellValue, sharedFormulaResolverFor(runtime!, sheetId))
    if (id === SET_NUMFMT_MUTATION) recordSetNumfmt(journal, sheetId, p)
    if (id === REMOVE_NUMFMT_MUTATION) recordRemoveNumfmt(journal, sheetId, p)
    const rowColumn = ROW_COLUMN_MUTATIONS[id]
    if (rowColumn && p.range) {
      const { range } = p
      recordStructuralOp(journal, sheetId, { kind: rowColumn.kind, index: rowColumn.axis === 'row' ? range.startRow : range.startColumn, count: rowColumn.axis === 'row' ? range.endRow - range.startRow + 1 : range.endColumn - range.startColumn + 1 }, nameFor(sheetId))
    }
    if (MERGE_MUTATIONS[id]) for (const range of p.ranges ?? []) recordStructuralOp(journal, sheetId, { kind: MERGE_MUTATIONS[id], range })
    const axis = AXIS_ATTR_MUTATIONS[id]
    if (axis) for (const range of p.ranges ?? []) {
      const start = axis.axis === 'row' ? range.startRow : range.startColumn
      const end = axis.axis === 'row' ? range.endRow : range.endColumn
      const sizeKind = axis.axis === 'row' ? 'set-row-size' : 'set-col-size'
      if (axis.kind === 'hidden') recordStructuralOp(journal, sheetId, { kind: axis.axis === 'row' ? 'set-rows-hidden' : 'set-cols-hidden', start, end, hidden: axis.hidden === true })
      else if (axis.kind === 'auto-size') {
        if (p.autoHeightInfo === 1) recordStructuralOp(journal, sheetId, { kind: sizeKind, start, end, size: null })
        else if (p.autoHeightInfo && typeof p.autoHeightInfo === 'object') for (let index = start; index <= end; index++) if (p.autoHeightInfo[index] === 1) recordStructuralOp(journal, sheetId, { kind: sizeKind, start: index, end: index, size: null })
      } else {
        const sizes = axis.axis === 'row' ? p.rowHeight : p.colWidth
        const fileSize = (n: number) => axis.axis === 'row' ? n * 0.75 : pixelsToCharacterWidth(n)
        if (typeof sizes === 'number') recordStructuralOp(journal, sheetId, { kind: sizeKind, start, end, size: fileSize(sizes) })
        else if (sizes) for (let index = start; index <= end; index++) if (typeof sizes[index] === 'number') recordStructuralOp(journal, sheetId, { kind: sizeKind, start: index, end: index, size: fileSize(sizes[index]) })
      }
    }
    if (id === REORDER_RANGE_MUTATION && p.range) snapshotRange(sheetId, p.range)
    if (NOTE_MUTATIONS.has(id)) {
      const key = `${sheetId}:${p.row}:${p.col}`
      if (id === 'sheet.mutation.remove-note' || pendingNotes.get(key)?.text === p.note?.note) pendingNotes.delete(key)
      recordNoteChange(journal, sheetId)
    }
    if (FILTER_MUTATIONS.has(id)) { recordFilterChange(journal, sheetId); filterRevision++ }
    if (id === SET_FROZEN_MUTATION) recordPageSetup(journal, sheetId, { frozenRows: Math.max(0, p.ySplit ?? 0), frozenColumns: Math.max(0, p.xSplit ?? 0) })
    if (id === 'sheet.mutation.set-worksheet-right-to-left' && p.rightToLeft !== undefined) recordPageSetup(journal, sheetId, { rightToLeft: p.rightToLeft === 1 })
    if (['sheet.operation.set-zoom-ratio', 'sheet.command.set-zoom-ratio'].includes(id) && p.zoomRatio !== undefined) recordPageSetup(journal, sheetId, { zoomScale: Math.min(400, Math.max(10, Math.round(p.zoomRatio * 100))) })
    if (id === TOGGLE_GRIDLINES_MUTATION) recordPageSetup(journal, sheetId, { showGridlines: p.showGridlines !== 0 })
  }
  const noteInput = (event: Event) => {
    if (!(event.target instanceof HTMLTextAreaElement) || event.target.dataset.uComp !== 'note-textarea') return
    const location = runtime!.univer.__getInjector().get(SheetsNotePopupService).activePopup
    if (!location || location.unitId !== book.getId()) return
    pendingNotes.set(`${location.subUnitId}:${location.row}:${location.col}`, { sheetId: location.subUnitId, row: location.row, col: location.col, text: event.target.value })
    dirty()
  }
  document.addEventListener('input', noteInput, true)
  const listeners = [
    api.addEvent(api.Event.SheetEditChanging, () => { editingDirty = true; dirty() }),
    api.addEvent(api.Event.SheetEditEnded, () => { editingDirty = false; dirty() }),
    api.addEvent(api.Event.BeforeCommandExecute, event => {
      if (suppressed) return
      const p = event.params as MutationParams | undefined
      const sheetId = p?.subUnitId ?? p?.sheetId ?? book.getActiveSheet()?.getSheetId()
      const original = model.sheets.find(sheet => sheet.id === sheetId)
      if (model.structureProtected && /(?:insert-sheet|remove-sheet|set-worksheet-name|set-worksheet-hidden|set-worksheet-order|copy-sheet)/.test(event.id)) { event.cancel = true; fail('工作簿结构已保护，无法更改工作表。') }
      if (event.id === COPY_SHEET_COMMAND) copySource = sheetId
      const mutating = /^(?:sheet|sheets|formula)\.(?:command|mutation)\./.test(event.id) && !/find|search|selection|activate|scroll|zoom|copy|show-formula/.test(event.id)
      if ((model.readOnlyReason || original?.protected) && mutating) { event.cancel = true; fail(model.readOnlyReason ?? '此工作表受保护，仅允许查看。') }
      if (/^sheet\.command\.(?:move-cols|move-rows|move-range|insert-range-move|delete-range-move)/.test(event.id)) { event.cancel = true; fail('移动单元格区域暂不支持保存；请使用复制、粘贴与行列插入。') }
      if (/protection|permission|defined-name/.test(event.id)) { event.cancel = true; fail('当前编辑器保留原有保护和名称定义；请在 Excel 中管理。') }
      if (original?.notesReadOnly && /(?:insert-row|remove-row|insert-col|remove-col)/.test(event.id)) { event.cancel = true; fail('此表包含线程批注，暂不支持行列结构修改。') }
      if (original?.notesReadOnly && /note/.test(event.id)) { event.cancel = true; fail('此表包含线程批注，暂不支持编辑批注；原批注保留在文件中。') }
      if (original?.filterReadOnly && /filter/.test(event.id) && mutating) { event.cancel = true; fail('此表包含特殊筛选条件，保留原件；请在 Excel 中修改此筛选。') }
      if (event.id === SET_RANGE_VALUES_MUTATION && original && p?.cellValue && typeof p.cellValue === 'object') {
        for (const [r, cols] of Object.entries(p.cellValue)) for (const c of Object.keys(cols as object ?? {})) {
          const restricted = original.readOnlyRanges.some(ref => {
            const range = shiftCellArea(parseRange(ref), journal.structuralOps.get(sheetId!) ?? [])
            return range && +r >= range.startRow && +r <= range.endRow && +c >= range.startColumn && +c <= range.endColumn
          })
          if (restricted) { event.cancel = true; fail('数组公式、数据表和表格标题区域暂不支持编辑。') }
        }
      }
    }),
    api.addEvent(api.Event.CommandExecuted, event => {
      if (event.id.includes('.mutation.')) clipboardRevision++
      if (suppressed || (event.options as { fromFormula?: boolean } | undefined)?.fromFormula) return
      if (event.id === COPY_SHEET_COMMAND) { copySource = undefined; return }
      try { mutation(event.id, event.params as MutationParams ?? {}); dirty() } catch (error) { fail(error) }
    }),
  ]
  cleanup.push(() => document.removeEventListener('input', noteInput, true), () => listeners.forEach(item => item.dispose()))
  function collectChanges(): SheetSaveRequest {
    const snapshot = book.save()
    const filterStates: SheetSaveRequest['filterStates'] = []
    for (const id of journal.filterDirty) {
      const sheet = book.getSheetBySheetId(id)
      if (!sheet) continue
      const filter = sheet.getFilter()
      const origin = model.sheets.find(sheet => sheet.id === id)?.filter?.range
      if (!filter) { if (origin) filterStates.push({ sheetName: nameFor(id), filter: null, hiddenRows: [], visibilityRange: origin }); continue }
      const r = filter.getRange()
      const range = { startRow: r.getRow(), startColumn: r.getColumn(), endRow: r.getRow() + r.getHeight() - 1, endColumn: r.getColumn() + r.getWidth() - 1 }
      const columns: NonNullable<SheetSaveRequest['filterStates'][number]['filter']>['columns'][number][] = []
      for (let col = range.startColumn; col <= range.endColumn; col++) {
        const criteria = filter.getColumnFilterCriteria(col)
        if (!criteria) continue
        if (criteria.colorFilters) throw new Error('按颜色筛选暂不支持保存。')
        columns.push({ colId: col - range.startColumn, ...(criteria.filters ? { values: criteria.filters.filters, blank: criteria.filters.blank } : {}), ...(criteria.customFilters ? { customs: { and: criteria.customFilters.and === 1, filters: criteria.customFilters.customFilters } } : {}) })
      }
      filterStates.push({ sheetName: nameFor(id), filter: { range, columns }, hiddenRows: filter.getFilteredOutRows(), visibilityRange: origin ? { startRow: Math.min(range.startRow, origin.startRow), endRow: Math.max(range.endRow, origin.endRow), startColumn: Math.min(range.startColumn, origin.startColumn), endColumn: Math.max(range.endColumn, origin.endColumn) } : range })
    }
    return {
      edits: toSaveEdits(journal).map(({ sheetId, value, formula, ...edit }) => ({ ...edit, sheetName: nameFor(sheetId), cell: { value, ...(formula ? { formula } : {}) } })),
      structuralOps: [...journal.structuralOps].filter(([id]) => !!snapshot.sheets[id]).map(([id, ops]) => ({ sheetName: nameFor(id), ops })),
      sheetPlan: sheetPlanFromSnapshot(model, snapshot, journal), filterStates,
      noteStates: [...journal.noteDirty].filter(id => !!snapshot.sheets[id]).map(id => ({ sheetName: nameFor(id), notes: book.getSheetBySheetId(id)!.getNotes().map(note => {
        const sourceId = resolveDuplicateSource(journal, id) ?? id
        const original = model.sheets.find(sheet => sheet.id === sourceId)?.notes?.find(item => {
          const moved = shiftCellArea({ startRow: item.row, endRow: item.row, startColumn: item.column, endColumn: item.column }, journal.structuralOps.get(id) ?? [])
          return moved?.startRow === note.row && moved.startColumn === note.col
        })
        const author = original?.author && note.note.startsWith(`${original.author}:\n`) ? original.author : ''
        return { row: note.row, column: note.col, author, text: author ? note.note.slice(author.length + 2) : note.note }
      }) })),
      pageSetupStates: [...journal.pageSetup].filter(([id]) => !!snapshot.sheets[id]).map(([id, state]) => ({ sheetName: nameFor(id), ...state })),
      tabColorStates: [...journal.sheets.tabColor].filter(([id]) => !!snapshot.sheets[id]).map(([id, color]) => ({ sheetName: nameFor(id), color })),
    }
  }
  async function save() {
    if (disposed) throw new Error('文档已关闭')
    if (book.isCellEditing() && !(await book.endEditingAsync(true))) throw new Error('当前单元格尚未完成编辑，请确认内容后再保存。')
    for (const [key, note] of [...pendingNotes]) {
      const sheet = book.getSheetBySheetId(note.sheetId)
      if (!sheet) { pendingNotes.delete(key); continue }
      const existing = sheet.getNotes().find(item => item.row === note.row && item.col === note.col)
      sheet.getRange(note.row, note.col).createOrUpdateNote({ id: existing?.id ?? crypto.randomUUID(), row: note.row, col: note.col, width: existing?.width ?? 220, height: existing?.height ?? 90, note: note.text })
      pendingNotes.delete(key)
    }
    const captured = signature()
    const result = await rpc<SavedWorkbook>('save-changes', { changes: collectChanges() })
    serializedSignature = captured
    serialized.set(result.bytes, captured)
    return result.bytes
  }
  function markSaved(bytes?: Uint8Array) {
    const confirmed = bytes ? serialized.get(bytes) : serializedSignature
    if (confirmed !== undefined) savedSignature = confirmed
    dirty()
  }
  suppressed = false
  savedSignature = signature()
  onDirty(false)
  notice.textContent = model.readOnlyReason ?? model.warnings.join(' · ')
  notice.hidden = !notice.textContent
  container.addEventListener('keydown', keydown)
  const assistant = createSheetsAssistant(api, book, model, signature, () => {
    context.signal.throwIfAborted()
    if (disposed) throw new Error('工作簿已关闭。')
  }, () => runtime!.univer.__getInjector().get(SheetsSelectionsService).getCurrentSelections().map(selection => selection.range), (sheetId, ranges) => {
    runtime!.univer.__getInjector().get(SheetsSelectionsService).setSelections(ranges.map(range => ({ range, primary: null, style: null })))
  }, (sheetId, candidate) => {
    const restricted = model.sheets.find(sheet => sheet.id === sheetId)?.readOnlyRanges.some(ref => {
      const range = shiftCellArea(parseRange(ref), journal.structuralOps.get(sheetId) ?? [])
      return range && range.startRow <= candidate.endRow && range.endRow >= candidate.startRow && range.startColumn <= candidate.endColumn && range.endColumn >= candidate.startColumn
    })
    if (restricted) throw new Error('数组公式、数据表和表格标题区域暂不支持助手编辑。')
  })
  try { await runtime.univer.__getInjector().get(LifecycleService).onStage(LifecycleStages.Rendered) }
  catch (error) { dispose(); throw error }
  context.signal.throwIfAborted()
  const injector = runtime.univer.__getInjector()
  stopReferenceMenu = installSheetsReferenceMenu(options, assistant, injector)
  return { assistant, save, markSaved, dispose }
}

export async function createBlankWorkbook(context: ViewContext): Promise<Uint8Array> {
  const response = await fetch(new URL('./blank.xlsx', import.meta.url), { signal: context.signal })
  if (!response.ok) throw new Error('空白工作簿读取失败')
  return new Uint8Array(await response.arrayBuffer())
}
