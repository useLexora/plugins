import type { Json, ReferenceCapture, ViewContext } from './lexora'

export interface OfficeEditorReference {
  label: string
  text: string
  textDigest?: string
  textLength?: number
  locator: Record<string, Json>
  version: string
}

export interface OfficeEditorReadResult {
  text: string
  operations: string[]
  reference?: OfficeEditorReference
  data?: Json
}

export interface OfficeEditorQuery {
  operation?: string
  input?: Record<string, Json>
}

export interface OfficeEditorRender {
  name: string
  mimeType: 'image/png'
  data: Uint8Array
}

export interface OfficeEditorToolRequest {
  operation: string
  input?: Record<string, Json>
  reference?: OfficeEditorReference
}

export interface OfficeEditorToolResult {
  text: string
  mutated: boolean
}

export interface OfficeEditorExecutionGuard {
  signal?: AbortSignal
  assertCurrent: () => void
}

export interface OfficeEditorAssistant {
  capabilities?: () => Json | Promise<Json>
  reference: () => Promise<OfficeEditorReference | null>
  resolveReference?: (reference: OfficeEditorReference) => Promise<OfficeEditorReference>
  read: (reference?: OfficeEditorReference, query?: OfficeEditorQuery) => Promise<OfficeEditorReadResult>
  execute: (request: OfficeEditorToolRequest, guard?: OfficeEditorExecutionGuard) => Promise<OfficeEditorToolResult>
  render?: (input?: Record<string, Json>, guard?: OfficeEditorExecutionGuard) => Promise<OfficeEditorRender[]>
  reveal?: (reference: OfficeEditorReference) => Promise<boolean>
}

export interface OfficeEditorOptions {
  context: ViewContext
  container: HTMLElement
  bytes: Uint8Array
  name: string
  onDirty: (dirty: boolean) => void
  onSaveRequest?: () => Promise<void>
  onSave?: (bytes: Uint8Array) => Promise<void>
  captureReference?: (reference: OfficeEditorReference) => Promise<ReferenceCapture | null>
}

export interface OfficeEditor {
  assistant?: OfficeEditorAssistant
  save: () => Promise<Uint8Array>
  markSaved?: (bytes?: Uint8Array) => void | Promise<void>
  dispose: () => void
}
