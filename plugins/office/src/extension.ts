import type { ExtensionContext, Json } from './lexora'
import { OfficeLibraryService, PLUGIN_ID } from './office-library'
import { registerOfficeAgent } from './office-agent'

export function activate(context: ExtensionContext) {
  const library = new OfficeLibraryService({
    get: () => context.storage.get(),
    set: value => context.storage.set(value),
    files: () => context.resources.listFiles(),
    release: file => context.resources.release(file),
    publish: () => context.views.broadcast({ type: 'office-library-changed' }),
  })
  registerOfficeAgent(context, library)
  context.subscriptions.add(context.commands.register(`${PLUGIN_ID}.manage`, ({ arguments: value }) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') throw new Error('文档操作参数无效。')
    return library.execute(value.action, value as Record<string, Json>).then(value => ({ ok: true, value }), error => ({ ok: false, error: error instanceof Error ? error.message : '文档库操作失败，请重试。' }))
  }))
}
