import type { EditableDocument } from './lexora'
import type { OfficeDocument, OfficeKind } from './office-library'
import { kindOf } from './office-library'

export interface OfficeOpenDocument {
  id: string
  name: string
  kind: OfficeKind
  version: string
  size: number
  library?: OfficeDocument
  local?: EditableDocument
}
export function libraryDocument(document: OfficeDocument): OfficeOpenDocument {
  return { id: document.id, name: document.name, kind: document.kind, version: document.versions[0].id, size: document.versions[0].file.size, library: document }
}
export function localDocument(document: EditableDocument): OfficeOpenDocument {
  return { id: `local:${document.id}`, name: document.name, kind: kindOf(document.name), version: document.version ?? `draft:${document.id}`, size: document.size, local: document }
}
