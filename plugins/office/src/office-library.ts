import type { Json, LocalFile } from './lexora'

export const PLUGIN_ID = 'pa99d3189286f4fa191b597bd1a1f227d.genoffice-xlsx'
export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface OfficeVersion { id: string; file: LocalFile; createdAt: number; label: string }
export interface OfficeDocument {
  id: string
  sourceId?: string
  sourceHash?: string
  name: string
  kind: OfficeKind
  revision: number
  createdAt: number
  updatedAt: number
  openedAt: number
  favorite: boolean
  trashedAt: number | null
  versions: OfficeVersion[]
}
export interface OfficeLibrary { schema: 1; documents: OfficeDocument[]; preferences?: Record<string, Json> }
export const KIND_LABEL: Record<OfficeKind, string> = { docx: '文档', xlsx: '表格', pptx: '演示文稿', pdf: 'PDF' }
export const MIME: Record<OfficeKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
}
export function kindOf(name: string): OfficeKind {
  const suffix = name.split('.').pop()?.toLowerCase()
  if (suffix === 'docx' || suffix === 'xlsx' || suffix === 'pptx' || suffix === 'pdf') return suffix
  if (suffix === 'csv') return 'xlsx'
  throw new Error('请选择 DOCX、XLSX、CSV、PPTX 或 PDF 文件。')
}
export function fileName(name: unknown, kind: OfficeKind) {
  if (typeof name !== 'string') throw new Error('请输入文件名称。')
  const value = name.trim().replace(new RegExp(`\\.${kind}$`, 'i'), '')
  if (!value || value.length > 100 || /[\\/:*?"<>|\x00-\x1f]/.test(value) || /[. ]$/.test(value)) throw new Error('名称应为 1–100 个字符，不能包含路径或特殊字符。')
  return `${value}.${kind}`
}
export function readLibrary(value: Json): OfficeLibrary {
  if (value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) return { schema: 1, documents: [] }
  if (typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || !Array.isArray(value.documents)) throw new Error('Office 文档库格式无法识别。原数据已保留，请恢复兼容版本。')
  const library = value as unknown as OfficeLibrary
  const ids = new Set<string>()
  for (const doc of library.documents) {
    if (!doc || typeof doc.id !== 'string' || ids.has(doc.id) || typeof doc.name !== 'string' || !['docx', 'xlsx', 'pptx', 'pdf'].includes(doc.kind) || !Number.isSafeInteger(doc.revision) || !Array.isArray(doc.versions) || !doc.versions.length || doc.versions.some(v => !v || typeof v.id !== 'string' || !v.file || typeof v.file.id !== 'string')) throw new Error('Office 文档库已损坏。原数据已保留。')
    ids.add(doc.id)
  }
  return structuredClone(library)
}
export interface LibraryPorts {
  get(): Promise<Json>
  set(value: Json): Promise<void>
  files(): Promise<LocalFile[]>
  release(file: LocalFile): Promise<void>
  publish(): Promise<void>
}
export class OfficeLibraryService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private ports: LibraryPorts) {}
  execute(action: string, input: Record<string, Json> = {}): Promise<Json> {
    const task = this.queue.then(() => this.apply(action, input))
    this.queue = task.catch(() => {})
    return task
  }
  private async apply(action: string, input: Record<string, Json>): Promise<Json> {
    const library = readLibrary(await this.ports.get())
    if (action === 'list') return library as unknown as Json
    if (action.startsWith('preferences.')) {
      if (input.key !== 'pdfSignatures') throw new Error('不支持的设置项。')
      if (action === 'preferences.get') return library.preferences?.pdfSignatures ?? null
      if (action !== 'preferences.set' || !('value' in input)) throw new Error('设置参数无效。')
      if (new TextEncoder().encode(JSON.stringify(input.value)).length > 64 * 1024) throw new Error('签名收藏超过 64 KB，请删除不再需要的签名。')
      library.preferences = { ...library.preferences, pdfSignatures: input.value }
      if (new TextEncoder().encode(JSON.stringify(library)).length > 240 * 1024) throw new Error('文档库索引已满。')
      await this.ports.set(library as unknown as Json)
      return input.value
    }
    const now = Date.now()
    const stale: LocalFile[] = []
    let result: OfficeDocument | null = null
    if (action === 'add') {
      if (input.sourceId !== undefined && (typeof input.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceId))) throw new Error('文件来源标识无效。')
      if (input.sourceHash !== undefined && (typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash))) throw new Error('文件来源校验无效。')
      const existing = input.sourceId && library.documents.find(doc => doc.sourceId === input.sourceId)
      if (existing) {
        if (existing.trashedAt !== null) throw new Error('此文件的文档库副本在回收站中，请先恢复。')
        if (typeof input.resourceId === 'string' && !library.documents.some(doc => doc.versions.some(version => version.file.id === input.resourceId))) {
          const unused = (await this.ports.files()).find(file => file.id === input.resourceId)
          if (unused) await this.ports.release(unused).catch(() => {})
        }
        return existing as unknown as Json
      }
      if (library.documents.length >= 240) throw new Error('文档库已达到 240 个文件，请先导出并整理回收站。')
      const file = (await this.ports.files()).find(item => item.id === input.resourceId)
      if (!file) throw new Error('文件授权已失效，请重新导入。')
      const kind = kindOf(file.name)
      result = { id: crypto.randomUUID(), name: fileName(input.name ?? file.name, kind), kind, revision: 1, createdAt: now, updatedAt: now, openedAt: now, favorite: false, trashedAt: null, versions: [{ id: crypto.randomUUID(), file, createdAt: now, label: '初始版本' }] }
      if (typeof input.sourceId === 'string') result.sourceId = input.sourceId
      if (typeof input.sourceHash === 'string') result.sourceHash = input.sourceHash
      library.documents.unshift(result)
    } else {
      const doc = library.documents.find(item => item.id === input.id)
      if (!doc) throw new Error('文档已不存在，请刷新文档库。')
      result = doc
      if (input.revision !== undefined || action === 'save' || action === 'restoreVersion' || action === 'delete') {
        if (doc.revision !== input.revision) throw new Error('文档已在其他页面修改。请重新打开最新版本，或将当前内容另存为。')
      }
      if (doc.trashedAt !== null && !['restore', 'delete'].includes(action)) throw new Error('文档已移入回收站，请先恢复。')
      switch (action) {
        case 'opened': doc.openedAt = now; break
        case 'rename': doc.name = fileName(input.name, doc.kind); break
        case 'favorite': doc.favorite = input.value === true; break
        case 'trash': doc.trashedAt = now; doc.revision++; break
        case 'restore': doc.trashedAt = null; doc.revision++; break
        case 'save': {
          const file = (await this.ports.files()).find(item => item.id === input.resourceId)
          if (!file) throw new Error('保存的文件已失效，当前编辑内容仍保留。')
          if (kindOf(file.name) !== doc.kind) throw new Error('保存内容的文件类型与文档不一致。')
          doc.versions.unshift({ id: crypto.randomUUID(), file, createdAt: now, label: typeof input.label === 'string' ? input.label.slice(0,40) : '自动保存' })
          stale.push(...doc.versions.splice(12).map(v => v.file))
          doc.revision++
          doc.updatedAt = now
          break
        }
        case 'restoreVersion': {
          const version = doc.versions.find(v => v.id === input.versionId)
          if (!version) throw new Error('此版本已不存在。')
          doc.versions.unshift({ ...version, id: crypto.randomUUID(), createdAt: now, label: '恢复历史版本' })
          stale.push(...doc.versions.splice(12).map(v => v.file))
          doc.revision++
          doc.updatedAt = now
          break
        }
        case 'duplicate': {
          if (library.documents.length >= 240) throw new Error('文档库已达到 240 个文件。')
          result = { ...structuredClone(doc), id: crypto.randomUUID(), name: fileName(input.name ?? `${doc.name.replace(/\.[^.]+$/, '')} 副本`, doc.kind), revision: 1, createdAt: now, updatedAt: now, openedAt: now, favorite: false, versions: [{ ...doc.versions[0], id: crypto.randomUUID(), createdAt: now, label: '复制文档' }] }
          delete result.sourceId
          delete result.sourceHash
          library.documents.unshift(result)
          break
        }
        case 'delete': {
          if (doc.trashedAt === null) throw new Error('请先将文档移入回收站。')
          library.documents = library.documents.filter(item => item.id !== doc.id)
          stale.push(...doc.versions.map(v => v.file))
          result = null
          break
        }
        default: throw new Error('不支持的文档操作。')
      }
    }
    const json = library as unknown as Json
    if (new TextEncoder().encode(JSON.stringify(json)).length > 240 * 1024) throw new Error('文档库索引已满，请导出并整理不再需要的文件。')
    await this.ports.set(json)
    const referenced = new Set(library.documents.flatMap(doc => doc.versions.map(v => v.file.id)))
    for (const file of stale) if (!referenced.has(file.id)) await this.ports.release(file).catch(() => {})
    await this.ports.publish().catch(() => {})
    return result as unknown as Json
  }
}
