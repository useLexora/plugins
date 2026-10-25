import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { replaceInlineRange, findNumId, type SelectionScope } from '../vendor/genoffice/apps/docs/src/renderer/ai/protocol'
import { AGENT_TOOLS, executeTool, markDocSeen } from '../vendor/genoffice/apps/docs/src/renderer/ai/tools'
import { opCatalog } from '../vendor/genoffice/apps/docs/src/renderer/ai/ops'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '../vendor/genoffice/packages/docx-engine/src/blank'
import type { FileActionContext } from '../vendor/genoffice/apps/docs/src/renderer/file-actions'
import type { Json } from './lexora'
import { redactTextBetween } from '../vendor/genoffice/apps/docs/src/renderer/ai/redact-view'
import { assertOfficeReference, assertOfficeReferenceText, officeReference, officeReplacement, OFFICE_REFERENCE_MAX_CHARS } from './office-assistant'
import type { OfficeEditorAssistant, OfficeEditorReference } from './office-editor-types'

const reads = ['get_document_context', 'read_blocks', 'read_revisions']
const writes = ['insert_content', 'replace_blocks', 'replace_selection', 'apply_ops', 'insert_chart', 'edit_chart', 'accept_changes', 'reject_changes']
const catalog = () => opCatalog().filter(op => op.name !== 'applyStyle')
const tools = AGENT_TOOLS.filter(tool => [...reads, ...writes].includes(tool.name)).map(tool => ({
  ...tool,
  inputSchema: { ...tool.inputSchema, additionalProperties: false, ...(['insert_content', 'insert_chart'].includes(tool.name) ? { required: [...((tool.inputSchema.required as string[]) ?? []), 'afterBlockIndex'] } : {}) },
}))
const schemas = () => ({
  ...Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema])),
  replace_text: { type: 'object', properties: { text: { type: 'string', maxLength: 24000 } }, required: ['text'], additionalProperties: false },
  undo: { type: 'object', properties: {}, additionalProperties: false },
})
const wholeScope = (editor: Editor): SelectionScope => ({ startIndex: 0, endIndex: Math.max(0, editor.state.doc.childCount - 1), isRange: false })

export function createDocxAssistant(getEditor: () => Editor, name: string, ensureActive: () => void, getFileContext?: () => FileActionContext): OfficeEditorAssistant {
  const numIds = () => {
    const doc = getFileContext?.().doc
    return { bullet: doc ? findNumId(doc.parsed.blocks, 'bullet') ?? (doc.isBlank ? BLANK_BULLET_NUM_ID : null) : BLANK_BULLET_NUM_ID, ordered: doc ? findNumId(doc.parsed.blocks, 'ordered') ?? (doc.isBlank ? BLANK_ORDERED_NUM_ID : null) : BLANK_ORDERED_NUM_ID }
  }
  const supportedWrites = () => getEditor().isEditable ? ['replace_text', ...writes, 'undo'] : []
  const scopeFor = (reference?: OfficeEditorReference): SelectionScope => reference ? { startIndex: getEditor().state.doc.resolve(Number(reference.locator.from)).index(0), endIndex: getEditor().state.doc.resolve(Number(reference.locator.to)).index(0), isRange: true, from: Number(reference.locator.from), to: Number(reference.locator.to) } : wholeScope(getEditor())
  const validate = (operation: string, input: Record<string, Json>) => {
    const tool = tools.find(item => item.name === operation)
    if (!tool) throw new Error('文档不支持此操作。')
    const schema = tool.inputSchema as { properties?: Record<string, { type?: string | string[] }>; required?: string[] }
    for (const key of schema.required ?? []) if (!(key in input)) throw new Error(`缺少必填字段：${key}`)
    for (const [key, value] of Object.entries(input)) {
      const field = schema.properties?.[key]
      if (!field) throw new Error(`不支持的字段：${key}`)
      const kinds = Array.isArray(field.type) ? field.type : [field.type]
      if (field.type && !kinds.some(kind => kind === 'integer' ? Number.isInteger(value) : kind === 'array' ? Array.isArray(value) : kind === 'null' ? value === null : typeof value === kind)) throw new Error(`${key} 类型不正确。`)
    }
    if (JSON.stringify(input).length > 128000) throw new Error('单次文档操作数据不能超过 128,000 字符。')
    if (operation === 'apply_ops' && (!Array.isArray(input.ops) || input.ops.length < 1 || input.ops.length > 50)) throw new Error('apply_ops 需要 1–50 个操作。')
  }
  const capture = (target?: OfficeEditorReference): OfficeEditorReference | null => {
    ensureActive()
    const editor = getEditor()
    let { from, to } = editor.state.selection
    if (target) {
      if (target.locator.kind !== 'docx' || !Number.isInteger(target.locator.from) || !Number.isInteger(target.locator.to)) throw new Error('文档引用位置无效。')
      from = Number(target.locator.from); to = Number(target.locator.to)
    } else if (from === to) {
      const pos = editor.state.doc.resolve(from)
      if (pos.depth !== 1 || !pos.parent.isTextblock) return null
      from = pos.start(); to = pos.end()
    }
    if (from < 1 || to <= from || to > editor.state.doc.content.size) return null
    const text = redactTextBetween(editor.getJSON(), from, to, '\n')
    const block = editor.state.doc.resolve(from).index(0)
    return officeReference(`${name} · 第 ${block + 1} 段`, text, { kind: 'docx', from, to }, editor.getJSON())
  }
  const required = (reference?: OfficeEditorReference, strict = true) => {
    if (!reference) throw new Error('请先引用要修改的文档选区。')
    const current = capture(reference)
    if (!current) throw new Error('引用选区已不存在，请重新选择。')
    if (strict) assertOfficeReference(reference, current)
    else assertOfficeReferenceText(reference, current)
    return current
  }
  const read: OfficeEditorAssistant['read'] = async (reference, query) => {
    ensureActive()
    const current = reference ? required(reference, false) : undefined
    const editor = getEditor()
    const operation = query?.operation ?? 'get_document_context'
    const input = query?.input ?? {}
    if (operation === 'capabilities') return { text: JSON.stringify(catalog()), operations: supportedWrites() }
    if (!reads.includes(operation)) throw new Error('文档不支持此读取操作。')
    validate(operation, input)
    const result = executeTool(editor, { id: 'office-read', name: operation, input }, numIds(), undefined, undefined, { scope: scopeFor(current), doc: editor.state.doc })
    if (result instanceof Promise) throw new Error('读取操作必须同步完成。')
    if (result.isError) throw new Error(result.output)
    return { text: result.output.slice(0, OFFICE_REFERENCE_MAX_CHARS), operations: supportedWrites(), ...(current ? { reference: current } : {}), data: { blockCount: editor.state.doc.childCount, undoScope: '正文、表格和图表；不包含外部元数据' } }
  }
  return {
    capabilities: () => ({ readOperations: reads, writeOperations: supportedWrites(), schemas: schemas() as unknown as Json, batchOperations: catalog() as unknown as Json, limits: { batch: 50, inputCharacters: 128000 }, render: 'none', notes: ['必须使用明确块索引或 target；无引用时绝不按当前光标写入。', 'apply_ops 为单次原子事务，支持 dryRun 与 undo；列表使用文档现有编号定义或空白模板编号。', 'render 不提供 PNG；通过 read_blocks 检查受限 HTML，并在编辑器中检查分页；只有存在独立渲染工具时才使用该工具。'] }),
    reference: async () => capture(),
    resolveReference: async reference => required(reference, false),
    read,
    execute: async ({ operation, input, reference }, guard) => {
      ensureActive(); guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      const editor = getEditor()
      if (!editor.isEditable) throw new Error('文档当前为只读或尚未加载完成。')
      if (operation === 'undo') { const changed = editor.commands.undo(); return { text: changed ? '已撤销上一次文档修改。' : '没有可撤销的修改。', mutated: changed } }
      if (operation !== 'replace_text') {
        const data = input ?? {}
        if (!writes.includes(operation)) throw new Error('当前文档不支持此操作。')
        validate(operation, data)
        const current = reference ? required(reference) : undefined
        if (['insert_content', 'insert_chart'].includes(operation) && !Number.isInteger(data.afterBlockIndex)) throw new Error('请明确指定 afterBlockIndex（-1 表示文档开头），不会使用当前光标。')
        if (operation === 'replace_selection' && !current) throw new Error('replace_selection 必须提供精确引用。')
        if (operation === 'apply_ops') for (const raw of data.ops as Json[]) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('每个操作必须是对象。')
          if (!catalog().some(op => op.name === raw.op)) throw new Error('不支持此格式或结构操作。请读取 capabilities 中的 batchOperations。')
          const target = raw.target
          if (target && typeof target === 'object' && !Array.isArray(target) && target.scope === 'selection' && !current) throw new Error('selection 目标需要精确引用。')
        }
        guard?.signal?.throwIfAborted(); guard?.assertCurrent()
        markDocSeen(editor)
        editor.view.dispatch(closeHistory(editor.state.tr))
        const storage = editor.storage.trackChanges as { enabled?: boolean; author?: string } | undefined
        const result = executeTool(editor, { id: 'office-edit', name: operation, input: data }, numIds(), storage?.enabled ? { author: storage.author ?? 'Lexora' } : undefined, guard?.signal, { scope: scopeFor(current), doc: editor.state.doc })
        if (result instanceof Promise) throw new Error('此操作需要尚未授权的异步能力。')
        editor.view.dispatch(closeHistory(editor.state.tr))
        if (result.isError) throw new Error(result.output)
        return { text: result.output, mutated: result.mutated }
      }
      const current = required(reference)
      const from = Number(current.locator.from); const to = Number(current.locator.to)
      const start = editor.state.doc.resolve(from); const end = editor.state.doc.resolve(to)
      if (start.depth !== 1 || !start.sameParent(end) || !start.parent.isTextblock) throw new Error('首期仅支持替换单个正文段落内的文本；请缩小选区。')
      let withheld = false
      let embedded = false
      editor.state.doc.nodesBetween(from, to, node => { if (node.marks.some(mark => mark.type.name === 'redaction')) withheld = true; if (node.isAtom && !node.isText && node.type.name !== 'hardBreak') embedded = true })
      if (embedded) throw new Error('引用中包含图片、域或其他内嵌对象，请仅选择普通文本。')
      if (withheld) throw new Error('引用包含已隐藏于模型的内容，不能通过助手替换。')
      const text = officeReplacement(input)
      if (text === editor.state.doc.textBetween(from, to, '\n')) return { text: '文本未发生变化。', mutated: false }
      const marks = (start.parent.childAfter(start.parentOffset).node?.marks ?? []).filter(mark => !['ins', 'del'].includes(mark.type.name))
      const nodes = text.split('\n').flatMap((part, index) => [...(index ? [editor.schema.nodes.hardBreak.create()] : []), ...(part ? [editor.schema.text(part, marks)] : [])])
      guard?.signal?.throwIfAborted(); guard?.assertCurrent()
      editor.view.dispatch(closeHistory(editor.state.tr))
      replaceInlineRange(editor, from, to, nodes)
      editor.view.dispatch(closeHistory(editor.state.tr))
      return { text: `已替换 ${current.label} 的引用文本。`, mutated: true }
    },
    reveal: async (reference) => {
      const current = required(reference, false)
      const editor = getEditor()
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, Number(current.locator.from), Number(current.locator.to))).scrollIntoView())
      editor.view.focus()
      return true
    },
  }
}
