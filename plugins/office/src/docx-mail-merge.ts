import JSZip from 'jszip'
import { mergeDataFromRows } from '../vendor/genoffice/packages/docx-engine/src/mail-merge'
import { decodeCsvBuffer, parseCsv } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/csv-import'
import { readSheetRows } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-gateway'
import type { MergeDataSourceResponse, MergeOutputRequest, MergeOutputResponse } from '../vendor/genoffice/apps/docs/src/shared/ipc'
import type { ViewContext } from './lexora'
import { readOfficeResource } from './office-resource-bytes'

function namedHeaders(rows: readonly (readonly string[])[]): readonly (readonly string[])[] {
  if (!rows.length) return []
  const seen = new Set<string>()
  const header = rows[0].map((raw, index) => {
    const base = raw.trim() || `Column${index + 1}`
    let name = base
    for (let suffix = 2; seen.has(name); suffix++) name = `${base}${suffix}`
    seen.add(name)
    return name
  })
  return [header, ...rows.slice(1)]
}

export async function pickMergeDataSource(context: ViewContext): Promise<MergeDataSourceResponse> {
  const [file] = await context.resources.pickFiles({ filters: [{ name: 'Excel 或 CSV', extensions: ['xlsx', 'csv'] }] })
  if (!file) return null
  try {
    const bytes = await readOfficeResource(context, file, 16 * 1024 * 1024)
    const extension = file.name.split('.').pop()?.toLowerCase()
    const rows = extension === 'csv' ? parseCsv(decodeCsvBuffer(Buffer.from(bytes))) : extension === 'xlsx' ? await readSheetRows(Buffer.from(bytes)) : null
    if (!rows) throw new Error('请选择 XLSX 或 CSV 收件人列表。')
    const data = mergeDataFromRows(namedHeaders(rows))
    return { ok: true, source: { path: file.id, name: file.name, fields: [...data.fields], records: [...data.records] } }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

const outputName = (name: string) => {
  const base = name.split(/[\\/]/).pop()?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '文档'
  const safe = base === '.' || base === '..' ? '文档' : base
  return safe.toLowerCase().endsWith('.docx') ? safe : `${safe}.docx`
}

export async function writeMergeOutput(context: ViewContext, documentName: string, request: MergeOutputRequest): Promise<MergeOutputResponse> {
  try {
    if (!request.files.length) throw new Error('没有可导出的合并文档。')
    context.signal.throwIfAborted()
    if (request.mode === 'single') {
      const file = request.files[0]
      const name = outputName(file.name)
      const saved = await context.resources.saveFile({ name, data: file.data })
      return saved ? { ok: true, path: name, count: 1 } : { ok: false, canceled: true }
    }
    const zip = new JSZip()
    const names = new Set<string>()
    for (const file of request.files) {
      context.signal.throwIfAborted()
      const initial = outputName(file.name)
      let name = initial
      for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix++) name = `${initial.slice(0, -5)}-${suffix}.docx`
      names.add(name.toLocaleLowerCase())
      zip.file(name, file.data)
    }
    const name = `${outputName(documentName).slice(0, -5)}-邮件合并.zip`
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    context.signal.throwIfAborted()
    const saved = await context.resources.saveFile({ name, data })
    return saved ? { ok: true, folder: name, count: request.files.length } : { ok: false, canceled: true }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}
