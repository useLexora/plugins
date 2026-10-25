import { sha256 } from '@noble/hashes/sha2.js'
import type { Json } from './lexora'
import type { OfficeEditorReference } from './office-editor-types'

export const OFFICE_REFERENCE_MAX_CHARS = 24_000
export const OFFICE_CAPTURE_MAX_CHARS = 262_144

export function officeTextDigest(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function compactOfficeReference(reference: OfficeEditorReference): OfficeEditorReference {
  return { ...reference, text: reference.locator.kind === 'text' && (reference.textLength ?? reference.text.length) <= OFFICE_REFERENCE_MAX_CHARS ? reference.text : '', textDigest: reference.textDigest ?? officeTextDigest(reference.text), textLength: reference.textLength ?? reference.text.length }
}

export function sameOfficeReferenceText(expected: OfficeEditorReference, actual: OfficeEditorReference): boolean {
  return expected.textDigest !== undefined
    ? expected.textLength === (actual.textLength ?? actual.text.length) && expected.textDigest === (actual.textDigest ?? officeTextDigest(actual.text))
    : expected.text === actual.text
}

export function officeVersion(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function officeReference(label: string, text: string, locator: Record<string, Json>, state: unknown): OfficeEditorReference {
  if (text.length > OFFICE_CAPTURE_MAX_CHARS) throw new Error('所选内容超过 262,144 字符，请缩小选区后再引用。')
  return { label, text, locator, version: officeVersion(state) }
}

export function assertOfficeReferenceText(expected: OfficeEditorReference, actual: OfficeEditorReference): void {
  if (!sameOfficeReferenceText(expected, actual) || JSON.stringify(expected.locator) !== JSON.stringify(actual.locator)) throw new Error('引用原文或位置已经变化，无法准确定位当前对象；历史快照仍可阅读。请检查当前文档后重新选择。')
}

export function assertOfficeReference(expected: OfficeEditorReference, actual: OfficeEditorReference): void {
  if (expected.version !== actual.version || !sameOfficeReferenceText(expected, actual) || JSON.stringify(expected.locator) !== JSON.stringify(actual.locator)) throw new Error('引用内容已经变化，请重新读取当前内容后再修改。')
}

export function officeReplacement(input?: Record<string, Json>): string {
  if (typeof input?.text !== 'string' || input.text.length > OFFICE_REFERENCE_MAX_CHARS) throw new Error('text 必须是长度不超过 24,000 字符的文本。')
  return input.text
}
