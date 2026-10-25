export function createSlidesApi(ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeListener(channel: string, listener: (...args: unknown[]) => void): void
}, webUtils: {getPathForFile(file: File): string}): import('../vendor/genoffice/apps/slides/src/shared/ipc').SlidesApi
