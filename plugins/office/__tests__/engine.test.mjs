import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import JSZip from 'jszip'

const root = path.resolve(import.meta.dirname, '..')
const artifact = path.join(root, 'artifacts')
await fs.mkdir(artifact, { recursive: true })
await build({
  absWorkingDir: root, entryPoints: ['src/engine.ts'], outfile: 'artifacts/engine-test.mjs',
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome130',
  inject: ['src/shims/buffer.ts'], logLevel: 'error', alias: {
    '@genoffice/zip-gate': path.join(root, 'vendor/genoffice/packages/zip-gate/src/index.ts'),
    'node:crypto': path.join(root, 'src/shims/crypto.ts'),
    'node:fs': path.join(root, 'src/shims/fs.ts'),
    'node:fs/promises': path.join(root, 'src/shims/fs.ts'),
    'node:path': path.join(root, 'src/shims/path.ts'),
  },
})
const { openWorkbook, saveWorkbook } = await import('../artifacts/engine-test.mjs')
const fixture = name => fs.readFile(path.join(root, 'fixtures', name))
const business = await fixture('business.xlsx')

async function patchSheet(xml) {
  const zip = await JSZip.loadAsync(await fixture('empty.xlsx'))
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${xml}</worksheet>`)
  return zip.generateAsync({ type: 'uint8array' })
}

test('真实业务工作簿读取中文、日期、公式缓存、格式、隐藏表和冻结', async () => {
  const book = await openWorkbook(business)
  assert.deepEqual(book.sheets.map(sheet => sheet.name), ['销售明细', '汇总', '参数'])
  assert.equal(book.sheets[0].cells.B4.value, '晨光钢笔')
  assert.equal(book.sheets[0].cells.E4.formula, '=C4*D4')
  assert.equal(book.sheets[0].cells.E4.value, 258)
  assert.equal(book.sheets[0].cells.F4.formatted, '2026-10-14')
  assert.equal(book.sheets[0].cells.B4.style.color, '#0000FF')
  assert.equal(book.sheets[2].hidden, true)
  assert.deepEqual(book.sheets[0].freeze, { rows: 3, columns: 2, topLeftCell: 'C4' })
  assert.equal(book.formulaCount, 12)
})

test('值及公式修改写回真实 XLSX，其他 OOXML 部件逐字节保留', async () => {
  const edits = [
    { sheetName: '销售明细', row: 3, column: 1, value: '晨光钢笔（已修改）' },
    { sheetName: '销售明细', row: 3, column: 2, value: 4 },
    { sheetName: '销售明细', row: 4, column: 7, value: '中文 café 😀 < & >' },
    { sheetName: '汇总', row: 7, column: 0, value: true },
    { sheetName: '汇总', row: 7, column: 1, value: null, formula: '=SUM(B4:B6)' },
  ]
  const saved = await saveWorkbook(business, edits)
  await fs.writeFile(path.join(artifact, 'engine-roundtrip.xlsx'), saved.bytes)
  const book = await openWorkbook(saved.bytes)
  assert.equal(book.sheets[0].cells.B4.value, edits[0].value)
  assert.equal(book.sheets[0].cells.C4.value, 4)
  assert.equal(book.sheets[0].cells.H5.value, edits[2].value)
  assert.equal(book.sheets[1].cells.A8.value, true)
  assert.equal(book.sheets[1].cells.B8.formula, '=SUM(B4:B6)')
  assert.equal(book.sheets[0].cells.E4.value, null)
  assert.equal(saved.formulasNeedRecalculation, true)
  const original = await JSZip.loadAsync(business)
  const output = await JSZip.loadAsync(saved.bytes)
  const touched = new Set(saved.touchedEntries)
  for (const [name, entry] of Object.entries(original.files)) {
    if (entry.dir || touched.has(name)) continue
    assert.deepEqual(await output.file(name).async('uint8array'), await entry.async('uint8array'), `Unexpected mutation: ${name}`)
  }
  assert.match(await output.file('xl/workbook.xml').async('text'), /calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/)
})

test('无编辑导出保持输入文件完全一致；清空单元格保留原有样式', async () => {
  const untouched = await saveWorkbook(business, [])
  assert.deepEqual(untouched.bytes, business)
  const saved = await saveWorkbook(business, [{ sheetName: '销售明细', row: 3, column: 2, value: null }])
  const book = await openWorkbook(saved.bytes)
  assert.equal(book.sheets[0].cells.C4.value, null)
  assert.equal(book.sheets[0].cells.C4.style.background, '#FFF2CC')
})

test('空表和高行稀疏表可读取、编辑并重新打开', async () => {
  const empty = await fixture('empty.xlsx')
  const book = await openWorkbook(empty)
  const saved = await saveWorkbook(empty, [{ sheetName: book.sheets[0].name, row: 0, column: 0, value: '空表首项' }])
  assert.equal((await openWorkbook(saved.bytes)).sheets[0].cells.A1.value, '空表首项')
  const sparse = await openWorkbook(await fixture('sparse.xlsx'))
  assert.ok(sparse.sheets[0].rowCount >= 100000)
  assert.ok(Object.keys(sparse.sheets[0].cells).length < 10)
})

test('保护表、合并区域非锚、表头和越界编辑拒绝写入', async () => {
  const protectedBytes = await fixture('protected.xlsx')
  const protectedBook = await openWorkbook(protectedBytes)
  await assert.rejects(saveWorkbook(protectedBytes, [{ sheetName: protectedBook.sheets[0].name, row: 0, column: 0, value: '破坏' }]), /保护/)
  await assert.rejects(saveWorkbook(business, [{ sheetName: '销售明细', row: 0, column: 1, value: '破坏' }]), /合并区域/)
  await assert.rejects(saveWorkbook(business, [{ sheetName: '销售明细', row: 2, column: 0, value: '破坏' }]), /标题区域/)
  await assert.rejects(saveWorkbook(business, [{ sheetName: '销售明细', row: 1048576, column: 0, value: 2 }]), /坐标/)
})

test('共享公式正确投影，数组公式区域拒绝局部写入', async () => {
  const bytes = await patchSheet('<sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><f t="shared" si="0" ref="B1:B2">A1*2</f><v>6</v></c><c r="C1"><f t="array" ref="C1:D2">A1:B2*2</f><v>6</v></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><f t="shared" si="0"/><v>10</v></c></row></sheetData>')
  const book = await openWorkbook(bytes)
  assert.equal(book.sheets[0].cells.B2.formula, '=A2*2')
  assert.equal(book.sheets[0].cells.B2.value, 10)
  await assert.rejects(saveWorkbook(bytes, [{ sheetName: book.sheets[0].name, row: 1, column: 3, value: 1 }]), /数组公式/)
  const saved = await saveWorkbook(bytes, [{ sheetName: book.sheets[0].name, row: 1, column: 1, value: 11 }])
  assert.equal((await openWorkbook(saved.bytes)).sheets[0].cells.B2.value, 11)
})

test('破损和超出预算的输入不会被当成空白工作簿', async () => {
  await assert.rejects(openWorkbook(await fixture('invalid.xlsx')), /zip/i)
  await assert.rejects(openWorkbook(new Uint8Array(33 * 1024 * 1024)), /32 MiB/)
  const zip = new JSZip()
  zip.file('oversized.xml', new Uint8Array(33 * 1024 * 1024))
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  await assert.rejects(openWorkbook(bytes), /limit/)
})

test('1904 日期系统真实文件明确拒绝，避免视图产生 1462 天日期漂移', async () => {
  const bytes = await fixture('date1904.xlsx')
  await assert.rejects(openWorkbook(bytes), /1904 日期系统/)
  await assert.rejects(saveWorkbook(bytes, [{ sheetName: '销售明细', row: 3, column: 1, value: '不应写入' }]), /1904 日期系统/)
  const original = await JSZip.loadAsync(bytes)
  assert.match(await original.file('xl/worksheets/sheet1.xml').async('text'), /<v>44847<\/v>/)
})

test('带 SpreadsheetML 前缀的真实 XLSX 仍能读写，未编辑部件保留原前缀', async () => {
  const bytes = await fixture('prefixed-namespace.xlsx')
  const zip = await JSZip.loadAsync(bytes)
  const model = await openWorkbook(bytes)
  assert.equal(model.sheets[0].cells.B4.value, '晨光钢笔')
  assert.equal(model.sheets[0].cells.E4.formula, '=C4*D4')
  const saved = await saveWorkbook(bytes, [{ sheetName: '销售明细', row: 3, column: 1, value: '前缀格式编辑成功' }])
  assert.equal((await openWorkbook(saved.bytes)).sheets[0].cells.B4.value, '前缀格式编辑成功')
  const reopened = await JSZip.loadAsync(saved.bytes)
  for (const name of ['xl/styles.xml', 'xl/worksheets/sheet3.xml']) assert.equal(await reopened.file(name).async('text'), await zip.file(name).async('text'))
})
