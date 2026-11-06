export interface DownloadListItem { modelName: string; percent: number }
export function activeDownloadForModel(items: DownloadListItem[], name: string) { return items.find(item => item.modelName === name) }
