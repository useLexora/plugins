import { CanceledError } from '@univerjs/core'
import type { IClipboardInterfaceService } from '@univerjs/ui'
import type { ViewContext } from './lexora'

export type OfficeClipboard = ViewContext['clipboard']

export function createSheetsClipboard(
  clipboard: OfficeClipboard,
  signal: AbortSignal,
  captureTarget: () => () => void,
  reportError: (error: unknown) => void,
): IClipboardInterfaceService {
  async function run<T>(action: () => Promise<T>): Promise<T> {
    try {
      signal.throwIfAborted()
      const validateTarget = captureTarget()
      const result = await action()
      signal.throwIfAborted()
      validateTarget()
      return result
    }
    catch (error) {
      if (!signal.aborted) reportError(error)
      throw new CanceledError()
    }
  }

  return {
    supportClipboard: true,
    writeText: text => run(() => clipboard.write({ text })),
    write: (text, html) => run(() => clipboard.write({ text, html })),
    readText: () => run(async () => (await clipboard.read()).text ?? ''),
    read: () => run(async () => {
      const content = await clipboard.read()
      const formats = new Map<string, Blob>()
      if (content.text) formats.set('text/plain', new Blob([content.text], { type: 'text/plain' }))
      if (content.html) formats.set('text/html', new Blob([content.html], { type: 'text/html' }))
      if (!formats.size) throw new Error('剪贴板中没有可粘贴的文本或表格。')
      return [{
        types: [...formats.keys()],
        presentationStyle: 'unspecified' as const,
        getType: async (type: string) => {
          const blob = formats.get(type)
          if (!blob) throw new DOMException(`不支持的剪贴板格式：${type}`, 'NotFoundError')
          return blob
        },
      }]
    }),
  }
}
