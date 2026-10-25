import type { ViewContext } from './lexora'
export async function readOfficeResource(context: ViewContext, resource: { id: string }, maxBytes: number): Promise<Uint8Array> {
  let offset = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    context.signal.throwIfAborted()
    const result = await context.resources.readBytes(resource, { offset, length: Math.min(64 * 1024, maxBytes - offset + 1) })
    if (result.size > maxBytes || offset + result.data.length > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 限制。`)
    const data = new Uint8Array(result.data)
    chunks.push(data); offset += data.length
    if (result.eof) break
    if (!data.length) throw new Error('文件读取提前结束，请重新选择。')
  }
  const bytes = new Uint8Array(offset)
  offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
