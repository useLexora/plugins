import { Buffer } from 'buffer'
import { fontCoversText } from '../vendor/genoffice/apps/pdf/src/main/font-cmap'

const files = new Map<string, Buffer>()
const families = ['Sans', 'Serif', 'Mono']
const styles = ['Regular', 'Bold', 'Italic', 'BoldItalic']

export async function preparePdfRuntime(signal: AbortSignal): Promise<void> {
  const names = ['pdfium.wasm', 'hb-subset.wasm', 'NotoSansCJKsc-Regular-subset.otf', ...families.flatMap(family => styles.map(style => `Liberation${family}-${style}.ttf`))]
  await Promise.all(names.map(async name => {
    if (files.has(name)) return
    const response = await fetch(new URL(`./pdf-runtime/${name}`, import.meta.url), { signal })
    if (!response.ok) throw new Error(`PDF 组件加载失败：${name}`)
    files.set(name, Buffer.from(await response.arrayBuffer()))
  }))
}

export function readFileSync(path: string): Buffer {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const bytes = files.get(name)
  if (!bytes) throw new Error(`PDF 内置资源不存在：${name}`)
  return bytes
}

export const pdfiumWasmPath = () => 'pdfium.wasm'
export const hbSubsetWasmPath = () => 'hb-subset.wasm'
export const isTruetype = (bytes: Buffer) => bytes.length >= 4 && bytes.readUInt32BE(0) !== 0x4F54544F
export function findSystemFont(psName: string, family: string): Buffer | null {
  const key = `${psName} ${family}`.toLowerCase()
  if (/noto|yahei|simsun|pingfang|hiragino|gothic|malgun/.test(key)) return files.get('NotoSansCJKsc-Regular-subset.otf') ?? null
  const face = /times|serif/.test(key) ? 'Serif' : /courier|mono/.test(key) ? 'Mono' : 'Sans'
  const bold = /bold/.test(key)
  const italic = /italic|oblique/.test(key)
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular'
  return files.get(`Liberation${face}-${style}.ttf`) ?? null
}
export function findFontCovering(text: string): Buffer | null {
  for (const name of ['LiberationSans-Regular.ttf', 'NotoSansCJKsc-Regular-subset.otf']) {
    const bytes = files.get(name)
    if (bytes && fontCoversText(bytes, text)) return bytes
  }
  return null
}

export async function decodeImage(b64: string): Promise<{ width: number; height: number; bgra: Buffer }> {
  const bytes = Buffer.from(b64, 'base64')
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('图片绘制不可用。')
    ctx.drawImage(bitmap, 0, 0)
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const bgra = Buffer.alloc(rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
      bgra[i] = rgba[i + 2]!
      bgra[i + 1] = rgba[i + 1]!
      bgra[i + 2] = rgba[i]!
      bgra[i + 3] = rgba[i + 3]!
    }
    return { width: bitmap.width, height: bitmap.height, bgra }
  } finally { bitmap.close() }
}

export const nativeImage = {
  createFromBitmap(bytes: Uint8Array, { width, height }: { width: number; height: number }) {
    return {
      toPNG(): Buffer {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('图片绘制不可用。')
        const image = ctx.createImageData(width, height)
        for (let i = 0; i < bytes.length; i += 4) {
          const alpha = bytes[i + 3]!
          const factor = alpha > 0 && alpha < 255 ? 255 / alpha : 1
          image.data[i] = Math.min(255, Math.round(bytes[i + 2]! * factor))
          image.data[i + 1] = Math.min(255, Math.round(bytes[i + 1]! * factor))
          image.data[i + 2] = Math.min(255, Math.round(bytes[i]! * factor))
          image.data[i + 3] = alpha
        }
        ctx.putImageData(image, 0, 0)
        return Buffer.from(canvas.toDataURL('image/png').split(',')[1]!, 'base64')
      },
    }
  },
}

export async function readFile(): Promise<never> { throw new Error('PDF 只能读取已授权的 Office 文档。') }
export async function writePdfAtomically(): Promise<never> { throw new Error('请通过 Office 保存文档。') }
