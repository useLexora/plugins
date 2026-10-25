# Local modifications

Based on GenOffice revision `8ab58a51433577a1317af4206137cee425b86606`.

These files are modified for the Lexora plugin. Original copyright and Apache-2.0 terms remain applicable.

Documents: embedded UI, resource loading, mail merge, save acknowledgement and session-bound host clipboard actions.

- `apps/docs/src/renderer/App.tsx`
- `apps/docs/src/renderer/doc-bytes.ts`
- `apps/docs/src/renderer/parse-off-thread.ts`
- `apps/docs/src/renderer/components/MailMergePanel.tsx`
- `apps/docs/src/renderer/components/Ribbon.tsx`
- `apps/docs/src/renderer/components/ContextMenu.tsx`
- `apps/docs/src/renderer/components/PasteSpecialDialog.tsx`
- `apps/docs/src/renderer/editor/paste-actions.ts`
- `apps/docs/src/shared/ipc.ts`
- `apps/docs/src/renderer/components/ribbon-mailings-tab.tsx`
- `apps/docs/src/renderer/i18n/ribbon/zh.ts`
- `packages/docx-engine/src/index.ts`

Sheets: browser-compatible Univer imports and shared types, including worksheet protection types extracted from the original `apps/sheets/src/renderer/sheet-protection.ts` at the revision above.

- `apps/sheets/src/renderer/app-constants.ts`
- `apps/sheets/src/renderer/edit-journal.ts`
- `apps/sheets/src/renderer/shared-formula-journal.ts`
- `apps/sheets/src/renderer/sheet-protection.ts`
- `apps/sheets/src/shared/sheet-protection-types.ts` (extracted types)

Presentations: embedded UI and in-page playback, unavailable native controls, browser-safe UUID generation, transaction errors and IPC types.

- `apps/slides/src/main/slides-main.ts`
- `apps/slides/src/renderer/App.tsx`
- `apps/slides/src/renderer/components/Ribbon.tsx`
- `apps/slides/src/renderer/components/RibbonHomeTab.tsx`
- `apps/slides/src/renderer/components/RibbonInsertTab.tsx`
- `apps/slides/src/renderer/components/SlideShowView.tsx`
- `apps/slides/src/shared/ipc.ts`
- `packages/pptx-engine/src/index.ts`
- `packages/pptx-engine/src/xml-utils.ts`

PDF: browser WASM and image handling, embedded UI, save lifecycle, and guarded deterministic document operations.

- `apps/pdf/src/main/image-edit.ts`
- `apps/pdf/src/main/wasm-path.ts`
- `apps/pdf/src/renderer/App.tsx`
- `apps/pdf/src/renderer/office-bridge.ts`
- `apps/pdf/src/renderer/ai/tools.ts`
- `apps/pdf/src/renderer/view-config.ts`

Product naming: editor titles, user-facing messages and default PDF annotation attribution use Lexora Office. Existing document metadata keys, font names and author values remain unchanged.

- `apps/docs/src/renderer/App.tsx`
- `apps/docs/src/renderer/components/ribbon-tabs.tsx`
- `apps/docs/src/renderer/i18n/strings-zotero.ts`
- `apps/pdf/src/renderer/NoteMargin.tsx`
- `apps/pdf/src/main/save-pdf.ts`
