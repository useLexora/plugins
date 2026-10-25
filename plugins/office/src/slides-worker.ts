import { openPptx, savePptx, commitSaved, type OpenedPptx } from '../vendor/genoffice/packages/pptx-engine/src'
import { OpentypeMetrics, HeuristicMetrics, type RunStyle, type FontMetricsProvider } from '../vendor/genoffice/packages/pptx-render/src'
import { parse } from 'opentype.js'
import UTIF from 'utif2'
import { zlibSync } from 'fflate'
import { crc32 } from './shims/docx-zlib'
import { registerSlidesKernel } from '../generated/slides-kernel.mjs'
import regular from '../vendor/genoffice/packages/ui/src/fonts/Carlito-Regular.ttf?bytes'
import bold from '../vendor/genoffice/packages/ui/src/fonts/Carlito-Bold.ttf?bytes'
import italic from '../vendor/genoffice/packages/ui/src/fonts/Carlito-Italic.ttf?bytes'
import boldItalic from '../vendor/genoffice/packages/ui/src/fonts/Carlito-BoldItalic.ttf?bytes'
interface Session { path: string; opened: OpenedPptx; fitWidthPx: number; undoStack: unknown[]; redoStack: unknown[]; metaDirty?: boolean }

type Handler = (event: { sender: typeof sender }, ...args: unknown[]) => unknown
const sessions = new Map<number, Session>()
const handlers = new Map<string, Handler>()
const bridgeRequests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
const selectedFiles = new Map<string, Uint8Array>()
let bridgeId = 0
let revision = 0
let saveToken = 0
let latestSave: { token: number; revision: number } | undefined
let queue = Promise.resolve()
const cancelledAssistantCommands = new Set<string>()
const sender = { id: 1, send: (channel: string, ...args: unknown[]) => postMessage({ event: channel, args }), isDestroyed: () => false }
const event = { sender }
const remote = (channel: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
  const id = ++bridgeId
  bridgeRequests.set(id, { resolve, reject })
  postMessage({ bridge: id, channel, args })
})
const faces = [regular, bold, italic, boldItalic].map(bytes => parse(bytes.slice().buffer))
const fallback = new HeuristicMetrics()
const metrics: FontMetricsProvider = new OpentypeMetrics(style => faces[Number(style.bold) + Number(style.italic) * 2], fallback)
metrics.displayFamily = (style: RunStyle, text?: string) => /[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]/u.test(text ?? '') ? style.fontFamily : 'Carlito GO'
const measureLatin = metrics.measure.bind(metrics)
metrics.measure = (text: string, style: RunStyle) => /[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]/u.test(text) ? fallback.measure(text, style) : measureLatin(text, style)
const clipboardData = new Map<string, Uint8Array>()
const clipboard = {
  writeBuffer: (format: string, bytes: Uint8Array) => { clipboardData.clear(); clipboardData.set(format, bytes) },
  readBuffer: (format: string) => Buffer.from(clipboardData.get(format) ?? []),
  readImage: () => ({ isEmpty: () => true }), readText: () => '', readHTML: () => '',
  availableFormats: () => [...clipboardData.keys()],
}
const ELEMENT_CLIPBOARD_FORMAT = 'io.genoffice.slides.elements'
const matchesToken = (token: string) => clipboard.readBuffer(ELEMENT_CLIPBOARD_FORMAT).toString() === token
const pngChunk = (name: string, bytes: Uint8Array) => {
  const result = new Uint8Array(12 + bytes.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, bytes.length)
  result.set(new TextEncoder().encode(name), 4)
  result.set(bytes, 8)
  view.setUint32(8 + bytes.length, crc32(result.subarray(4, 8 + bytes.length)))
  return result
}
const tiffToPng = (bytes: Uint8Array) => {
  try {
    const input = bytes.slice().buffer
    const frames = UTIF.decode(input) as Array<ReturnType<typeof UTIF.decode>[number] & { t256: number[]; t257: number[] }>
    const frame = frames.filter((item) => item.t256?.[0] > 0 && item.t257?.[0] > 0 && item.t256[0] * item.t257[0] <= 32 * 1024 * 1024).sort((a, b) => b.t256[0] * b.t257[0] - a.t256[0] * a.t257[0])[0]
    if (!frame) return null
    UTIF.decodeImage(input, frame)
    const rgba = UTIF.toRGBA8(frame)
    const row = frame.width * 4
    const pixels = new Uint8Array((row + 1) * frame.height)
    for (let y = 0; y < frame.height; y++) pixels.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
    const header = new Uint8Array(13)
    new DataView(header.buffer).setUint32(0, frame.width)
    new DataView(header.buffer).setUint32(4, frame.height)
    header[8] = 8; header[9] = 6
    const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlibSync(pixels)), pngChunk('IEND', new Uint8Array())]
    const png = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length }
    return { png, width: frame.width, height: frame.height }
  } catch { return null }
}
const kernel = registerSlidesKernel({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, sessions,
  webContents: { fromId: () => sender, getAllWebContents: () => [sender] },
  getFontMetrics: () => metrics, setImmediate: queueMicrotask,
  refineComplexWidths: async () => false, shapedMetricsReady: Promise.resolve(), tiffToPng,
  clipboard, ELEMENT_CLIPBOARD_FORMAT, elementClipboardMarkerMatches: matchesToken,
  isElementClipboardToken: (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256,
  canWriteElementClipboardImage: () => false, writeElementClipboardImage: () => false,
  dialogParent: () => null,
  dialog: { showMessageBox: async (...args: unknown[]) => remote('confirm', args.at(-1)) },
  showOpenDialogWithMemory: async (_dialog: unknown, _parent: unknown, options: unknown) => {
    const files = await remote('pick-files', options) as Array<{ path: string; bytes: Uint8Array }>
    selectedFiles.clear()
    for (const file of files) selectedFiles.set(file.path, file.bytes)
    return { canceled: !files.length, filePaths: files.map(file => file.path) }
  },
  readFile: async (path: string) => { const bytes = selectedFiles.get(path); if (!bytes) throw new Error('文件授权已过期。'); return Buffer.from(bytes) },
  safeExternalUrl: (value: string, options?: { allowedProtocols: string[] }) => {
    try { const url = new URL(value); return (options?.allowedProtocols ?? ['https:', 'http:', 'mailto:']).includes(url.protocol) ? url.href : null } catch { return null }
  },
  configuredAuthorName: () => 'Lexora', commentAuthorName: () => 'Lexora', videoPoster: async () => undefined,
})
const current = () => { const session = sessions.get(1); if (!session) throw new Error('演示文稿尚未打开。'); return session }
const dirty = () => !!handlers.get('slides:is-dirty')?.(event)
const invoke = async (channel: string, args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`此操作尚未接入：${channel}`)
  const value = await handler(event, ...args)
  if (!/^slides:(?:get-|is-|has-|clipboard-|copy-|chart-color-|master-enter$|master-open$|master-close$|media-data$|model3d-data$|pick-)/.test(channel)) {
    revision++
    postMessage({ dirty: dirty() })
  }
  return value
}
async function dispatch(method: string, args: unknown[]) {
  if (method === 'open') {
    const [bytes, name, fitWidthPx] = args as [Uint8Array, string, number]
    const opened: OpenedPptx = await openPptx(bytes)
    if (!opened.deck.slides.length) throw new Error('演示文稿中没有可打开的幻灯片。')
    sessions.set(1, { path: name, opened, fitWidthPx, undoStack: [], redoStack: [] })
    return { path: name, slides: kernel.buildAllRenderSlides(opened, fitWidthPx), size: { ...opened.deck.size }, defaultFont: kernel.deckDefaultFont(opened) }
  }
  if (method === 'assistant-snapshot') {
    const session = current()
    return { revision, slides: kernel.buildAllRenderSlides(session.opened, session.fitWidthPx) }
  }
  if (method === 'assistant-command') {
    const [expected, channel, input, token] = args as [number, string, unknown, string]
    if (cancelledAssistantCommands.delete(token)) throw new Error('助手操作已取消。')
    if (expected !== revision) throw new Error('演示文稿已经变化，请重新读取引用后再修改。')
    if (!['slides:apply-edit-script', 'slides:apply-txn', 'slides:undo'].includes(channel)) throw new Error('不支持此助手操作。')
    const result = channel === 'slides:apply-txn' ? handlers.get(channel)!(event, input) : await invoke(channel, channel === 'slides:undo' ? [] : [input])
    if (channel === 'slides:apply-txn' && result && typeof result === 'object') {
      const txn = result as { applied?: boolean; failures?: { error: string }[] }
      if (txn.failures?.length) throw new Error(txn.failures.map(item => item.error).join('\n'))
      if (txn.applied) { revision++; postMessage({ dirty: dirty() }) }
    }
    if (!result || typeof result === 'object' && 'error' in result) throw new Error(typeof result === 'object' && result && 'error' in result ? String(result.error) : '没有可应用的修改。')
    const session = current()
    const detail = result && typeof result === 'object' && 'slides' in result ? { ...result, slides: undefined } : result
    return { revision, slides: kernel.buildAllRenderSlides(session.opened, session.fitWidthPx), detail }
  }
  if (method === 'save') {
    const session = current()
    const bytes = await savePptx(session.opened)
    latestSave = { token: ++saveToken, revision }
    return { bytes, token: saveToken }
  }
  if (method === 'saved') {
    if (latestSave && latestSave.token === args[0] && latestSave.revision === revision) {
      const session = current()
      commitSaved(session.opened)
      session.metaDirty = false
      latestSave = undefined
      sender.send('slides:renamed', session.path)
    }
    postMessage({ dirty: dirty() })
    return undefined
  }
  return invoke(method, args)
}
self.onmessage = ({ data }) => {
  if (data.method === 'assistant-cancel') {
    const token = data.args?.[0]
    if (typeof token === 'string') cancelledAssistantCommands.add(token)
    while (cancelledAssistantCommands.size > 128) cancelledAssistantCommands.delete(cancelledAssistantCommands.values().next().value!)
    postMessage({ id: data.id, value: undefined })
    return
  }
  if (data.bridgeResult) {
    const pending = bridgeRequests.get(data.bridgeResult)
    bridgeRequests.delete(data.bridgeResult)
    if (data.error) pending?.reject(new Error(data.error))
    else pending?.resolve(data.value)
    return
  }
  queue = queue.then(async () => {
    try { postMessage({ id: data.id, value: await dispatch(data.method, data.args ?? []) }) }
    catch (error) { postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }) }
  })
}
