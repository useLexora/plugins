import { csvToXlsxBufferForOpen, decodeCsvBuffer } from '../vendor/genoffice/packages/xlsx-gateway/src/gateway/csv-import'

export async function importCsv(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('CSV 文件超过 32 MiB 上限。')
  const title = name.replace(/\.(?:csv|tsv)$/i, '').replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet1'
  const result = await csvToXlsxBufferForOpen(decodeCsvBuffer(bytes), title, /\.tsv$/i.test(name) ? '\t' : undefined)
  return new Uint8Array(result.buffer)
}
