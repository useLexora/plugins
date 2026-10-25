import { openWorkbook, saveWorkbook, type WorkbookEdit } from './engine'
import { saveSheetChanges, type SheetSaveRequest } from './sheets-engine'

let source: Uint8Array | undefined
let queue = Promise.resolve()

self.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as { id: number; method: string; bytes?: Uint8Array; edits?: WorkbookEdit[]; changes?: SheetSaveRequest }
  queue = queue.then(async () => {
    try {
      if (request.method === 'open') {
        if (!(request.bytes instanceof Uint8Array)) throw new Error('缺少工作簿内容。')
        const model = await openWorkbook(request.bytes)
        source = request.bytes
        self.postMessage({ id: request.id, result: model })
      }
      else if (request.method === 'save-changes') {
        if (!source || !request.changes) throw new Error('缺少工作簿内容。')
        const result = await saveSheetChanges(source, request.changes)
        self.postMessage({ id: request.id, result }, { transfer: [result.bytes.buffer] })
      }
      else if (request.method === 'save') {
        if (!source) throw new Error('请先打开工作簿。')
        if (!Array.isArray(request.edits)) throw new Error('缺少编辑内容。')
        const result = await saveWorkbook(source, request.edits)
        self.postMessage({ id: request.id, result }, { transfer: [result.bytes.buffer] })
      }
      else throw new Error('不支持的工作簿操作。')
    }
    catch (error) {
      self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
