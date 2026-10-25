import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import JSZip from 'jszip'

const root = path.resolve(import.meta.dirname, '..')
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
await build({
  absWorkingDir: root, entryPoints: ['src/sheets-engine.ts', 'src/sheets-import.ts', 'src/engine.ts'], outdir: 'artifacts/office-tests', outExtension: { '.js': '.mjs' },
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', inject: ['src/shims/buffer.ts'], logLevel: 'error', alias: {
    '@genoffice/zip-gate': path.join(root, 'vendor/genoffice/packages/zip-gate/src/index.ts'),
    'node:crypto': path.join(root, 'src/shims/crypto.ts'), 'node:fs': path.join(root, 'src/shims/fs.ts'),
    'node:fs/promises': path.join(root, 'src/shims/fs.ts'), 'node:path': path.join(root, 'src/shims/path.ts'),
  },
})
const { saveSheetChanges } = await import('../artifacts/office-tests/sheets-engine.mjs')
const { importCsv } = await import('../artifacts/office-tests/sheets-import.mjs')
const { openWorkbook } = await import('../artifacts/office-tests/engine.mjs')
const fixture = name => fs.readFile(path.join(root, 'fixtures', name))
const request = overrides => ({ edits: [], structuralOps: [], filterStates: [], pageSetupStates: [], ...overrides })
const cell = (sheetName, row, column, value, style) => ({ sheetName, row, column, writeValue: true, cell: { value }, ...(style ? { style } : {}) })

test('格式、合并、行列尺寸、隐藏、冻结与筛选保存后重新读取', async () => {
  const bytes = await fixture('empty.xlsx')
  const name = (await openWorkbook(bytes)).sheets[0].name
  const saved = await saveSheetChanges(bytes, request({
    edits: [cell(name, 0, 0, '产品', { bold: true, fontColor: '#123456', fillColor: '#FFFF00', fontSize: 18, strikethrough: true, verticalAlignment: 'center', borderBottom: { style: 'double', color: '#FF0000' } }), cell(name, 1, 0, '桌子'), cell(name, 1, 1, 12.5, { numberFormat: '0.00' })],
    structuralOps: [{ sheetName: name, ops: [
      { kind: 'merge-cells', range: { startRow: 3, endRow: 3, startColumn: 0, endColumn: 2 } },
      { kind: 'set-row-size', start: 0, end: 0, size: 30 }, { kind: 'set-col-size', start: 0, end: 0, size: 24 },
      { kind: 'set-cols-hidden', start: 3, end: 3, hidden: true },
    ] }],
    filterStates: [{ sheetName: name, filter: { range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }, columns: [{ colId: 0, values: ['桌子'] }] }, hiddenRows: [2], visibilityRange: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 } }],
    pageSetupStates: [{ sheetName: name, frozenRows: 1, frozenColumns: 1, showGridlines: false }],
  }))
  const sheet = (await openWorkbook(saved.bytes)).sheets[0]
  assert.equal(sheet.cells.A1.style.bold, true)
  assert.equal(sheet.cells.A1.style.strikethrough, true)
  assert.equal(sheet.cells.A1.style.verticalAlign, 'center')
  assert.equal(sheet.cells.A1.style.color, '#123456')
  assert.equal(sheet.cells.A1.style.background, '#FFFF00')
  assert.equal(sheet.cells.A1.style.borders.bottom.style, 'double')
  assert.equal(sheet.cells.B2.style.numberFormat, '0.00')
  assert.deepEqual(sheet.merges, ['A4:C4'])
  assert.equal(sheet.rowHeights['0'], 40)
  assert.ok(sheet.columnWidths['0'] >= 168)
  assert.deepEqual(sheet.hiddenColumns, [3])
  assert.ok(sheet.hiddenRows.includes(2))
  assert.equal(sheet.freeze.rows, 1)
  assert.equal(sheet.freeze.columns, 1)
  assert.deepEqual(sheet.filter.columns[0].values, ['桌子'])
})

test('行列增删和工作表新建、重命名、删除、重排真实持久化', async () => {
  const bytes = await fixture('empty.xlsx')
  const name = (await openWorkbook(bytes)).sheets[0].name
  const seeded = await saveSheetChanges(bytes, request({ edits: [cell(name, 0, 0, '保留'), cell(name, 2, 2, '下移')] }))
  const saved = await saveSheetChanges(seeded.bytes, request({
    edits: [cell('预算', 0, 0, 250)],
    structuralOps: [{ sheetName: name, ops: [{ kind: 'insert-rows', index: 1, count: 2 }, { kind: 'remove-cols', index: 1, count: 1 }] }],
    sheetPlan: { additions: [{ name: '预算' }], renames: [{ sheetName: name, newName: '明细' }], removals: [], hiddenChanges: [], order: ['预算', '明细'], orderChanged: true },
  }))
  const book = await openWorkbook(saved.bytes)
  assert.deepEqual(book.sheets.map(sheet => sheet.name), ['预算', '明细'])
  assert.equal(book.sheets[0].cells.A1.value, 250)
  assert.equal(book.sheets[1].cells.A1.value, '保留')
  assert.equal(book.sheets[1].cells.B5.value, '下移')
  const removed = await saveSheetChanges(saved.bytes, request({ sheetPlan: { additions: [], renames: [], removals: ['明细'], hiddenChanges: [], order: ['预算'], orderChanged: true } }))
  assert.deepEqual((await openWorkbook(removed.bytes)).sheets.map(sheet => sheet.name), ['预算'])
})

test('编辑后未涉及的 OOXML 部件逐字节保留，原文件未改变', async () => {
  const bytes = await fixture('business.xlsx')
  const originalBytes = bytes.slice()
  const saved = await saveSheetChanges(bytes, request({ edits: [cell('销售明细', 3, 1, '新产品', { bold: true })] }))
  assert.deepEqual(bytes, originalBytes)
  const source = await JSZip.loadAsync(bytes)
  const result = await JSZip.loadAsync(saved.bytes)
  const touched = new Set([...saved.touchedEntries, ...saved.removedEntries])
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir || touched.has(name)) continue
    assert.deepEqual(await result.file(name).async('uint8array'), await entry.async('uint8array'), name)
  }
  assert.equal((await openWorkbook(saved.bytes)).sheets[0].cells.B4.value, '新产品')
  assert.equal((await openWorkbook(saved.bytes)).sheets[0].cells.E4.value, null)
  assert.equal(saved.formulasNeedRecalculation, true)
  assert.deepEqual((await saveSheetChanges(bytes, request({}))).bytes, bytes)
})

test('保护、隐私标记和数组/表格标题区域拒绝破坏性保存', async () => {
  const protectedBytes = await fixture('protected.xlsx')
  const name = (await openWorkbook(protectedBytes)).sheets[0].name
  await assert.rejects(saveSheetChanges(protectedBytes, request({ edits: [cell(name, 0, 0, '破坏')] })), /保护/)
  await assert.rejects(saveSheetChanges(await fixture('business.xlsx'), request({ edits: [cell('销售明细', 2, 0, '破坏')] })), /标题区域/)
  const zip = await JSZip.loadAsync(await fixture('empty.xlsx'))
  zip.file('xl/gxRedactions.json', '{"version":1,"sheets":[]}')
  const redacted = await zip.generateAsync({ type: 'uint8array' })
  const redactedModel = await openWorkbook(redacted)
  assert.match(redactedModel.readOnlyReason, /隐私/)
  await assert.rejects(saveSheetChanges(redacted, request({ edits: [cell(redactedModel.sheets[0].name, 0, 0, '破坏')] })), /隐私/)
  assert.deepEqual((await saveSheetChanges(redacted, request({}))).bytes, redacted)
})

test('CSV/TSV 使用 GenOffice 转换为 XLSX，保留引号、逗号、换行、UTF8 和 BOM', async () => {
  const csv = '\ufeff名称,备注,数量\r\n"咖啡,茶","双""引号\n第二行",12\r\n'
  const bytes = await importCsv(new TextEncoder().encode(csv), '清单.csv')
  assert.equal(bytes[0], 0x50)
  assert.equal(bytes[1], 0x4b)
  const book = await openWorkbook(bytes)
  assert.equal(book.sheets[0].name, '清单')
  assert.equal(book.sheets[0].cells.A2.value, '咖啡,茶')
  assert.equal(book.sheets[0].cells.B2.value, '双"引号\n第二行')
  assert.equal(book.sheets[0].cells.C2.value, 12)
  const tsv = await openWorkbook(await importCsv(new TextEncoder().encode('项目\t数量\n纸\t3'), '明细.tsv'))
  assert.equal(tsv.sheets[0].cells.B2.value, 3)
})


test('单元格批注创建、编辑、删除保存并重开，保留作者与多行文本', async () => {
  const bytes = await fixture('empty.xlsx')
  const name = (await openWorkbook(bytes)).sheets[0].name
  const notes = [{ row: 0, column: 0, author: '作者', text: '第一行\n第二行' }]
  const saved = await saveSheetChanges(bytes, request({ noteStates: [{ sheetName: name, notes }] }))
  assert.deepEqual((await openWorkbook(saved.bytes)).sheets[0].notes, notes)
  const shifted = await saveSheetChanges(saved.bytes, request({ structuralOps: [{ sheetName: name, ops: [{ kind: 'insert-rows', index: 0, count: 2 }] }] }))
  assert.deepEqual((await openWorkbook(shifted.bytes)).sheets[0].notes, [{ ...notes[0], row: 2 }])
  const changed = await saveSheetChanges(saved.bytes, request({ noteStates: [{ sheetName: name, notes: [{ ...notes[0], text: '更新' }] }] }))
  assert.equal((await openWorkbook(changed.bytes)).sheets[0].notes[0].text, '更新')
  const removed = await saveSheetChanges(changed.bytes, request({ noteStates: [{ sheetName: name, notes: [] }] }))
  assert.equal((await openWorkbook(removed.bytes)).sheets[0].notes?.length ?? 0, 0)
})
