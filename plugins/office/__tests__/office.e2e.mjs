import { repository, pluginPackage } from './paths.mjs'
import { documentAction, editorAction } from './library-locators.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
const project = path.resolve(import.meta.dirname, '..')

const { test, expect, useSyntheticCredentialStorage } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)
let setupRealModel
if (process.env.OFFICE_REAL_MODEL === '1' || process.env.OFFICE_SUITE_REAL_MODEL === '1') {
  if (!process.env.OFFICE_REAL_MODEL_SETUP) throw new Error('Set OFFICE_REAL_MODEL_SETUP to a module exporting setupRealModel({ instance, app, page, scenario }).')
  ;({ setupRealModel } = await import(pathToFileURL(path.resolve(process.env.OFFICE_REAL_MODEL_SETUP)).href))
  if (typeof setupRealModel !== 'function') throw new Error('OFFICE_REAL_MODEL_SETUP must export setupRealModel.')
}
const manifest = JSON.parse(await fs.readFile(path.join(project, 'dist/extension.json'), 'utf8'))
const archive = pluginPackage(manifest.version)

async function selectFiles(app, files) { await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: !files.length, filePaths: files }) }, files) }
async function install(app, page, packagePath = archive) {
  await expect(page.locator('.desktop-app-sidebar')).toBeVisible()
  const { version } = await page.evaluate(() => window.lexoraDesktop.app.getInfo())
  test.info().annotations.push({ type: 'host-version', description: version })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible()))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(1600, 1050))
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await expect(page.getByTestId('feature-discovery-reminder')).toBeHidden()
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await selectFiles(app, [packagePath])
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id && item.enabled), manifest.id)).toBe(true)
}
async function office(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: 'Office', exact: true }).click()
  let frame
  await expect.poll(async () => {
    for (const item of page.frames()) {
      if (item.url().startsWith('lexora-extension:') && await (await item.frameElement()).isVisible().catch(() => false) && await item.getByRole('button', { name: '全部文件', exact: true }).isVisible().catch(() => false)) { frame = item; return true }
    }
    return false
  }, { timeout: 40000 }).toBe(true)
  await expect(frame.getByRole('button', { name: '全部文件', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator(`[data-extension-page="${manifest.id}"] > header`)).toHaveCount(0)
  return frame
}
async function create(frame, kind, name) {
  await frame.getByRole('button', { name: `新建${kind}`, exact: true }).click()
  const form = frame.getByRole('dialog')
  await form.getByLabel('文件名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '创建', exact: true }).click()
}

test('独立 Office 管理页保存真实 DOCX、版本恢复、回收站与跨重启恢复', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-library')
  let { app, page } = await instance.launch()
  const errors = []
  app.context().on('weberror', event => errors.push(String(event.error())))
  await install(app, page)
  let frame = await office(page)
  await expect(frame.getByRole('heading', { name: '从一份文件开始', exact: true })).toBeVisible()
  await expect(frame.locator('.office-file-table .ant-spin-spinning')).toHaveCount(0)
  await expect(frame.locator('.office-file-table .ant-spin-container')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('01-library-empty.png') })
  await create(frame, '文档', '季度办公计划')
  const editor = frame.locator('.tiptap[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 45000 })
  expect(await frame.evaluate(() => ({ origin, node: typeof process, desktop: typeof window.lexoraDesktop }))).toEqual({ origin: 'null', node: 'undefined', desktop: 'undefined' })
  await editor.fill('季度办公计划\n中文、格式与版本都需要可靠保存。')
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await frame.getByRole('button', { name: '文档库', exact: true }).click()
  let row = frame.getByRole('row').filter({ hasText: '季度办公计划.docx' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible()
  await documentAction(frame, row, '重命名')
  await frame.getByRole('dialog').getByLabel('文件名称').fill('季度计划')
  await frame.getByRole('dialog').getByRole('button', { name: '保存名称' }).click()
  row = frame.getByRole('row').filter({ hasText: '季度计划.docx' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '打开', exact: true }).click()
  await expect(editor).toContainText('季度办公计划')
  await editor.fill('第二个版本\n保留先前版本供恢复。')
  await frame.getByRole('button', { name: '文档库', exact: true }).click()
  await documentAction(frame, row, '版本')
  const history = frame.getByRole('dialog', { name: '版本历史', exact: true })
  await expect(history.locator('.office-version-row')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('02-version-history.png') })
  await history.locator('.office-version-row').nth(1).getByRole('button', { name: '恢复', exact: true }).click()
  await frame.getByRole('dialog').filter({ hasText: '恢复此版本？' }).getByRole('button', { name: '恢复版本', exact: true }).click()
  await expect(history.locator('.office-version-row')).toHaveCount(4)
  await history.getByRole('button', { name: /close|关闭/i }).click()
  await expect(history).toBeHidden()
  const output = testInfo.outputPath('exported.docx')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await documentAction(frame, row, '导出')
  await expect.poll(async () => (await fs.stat(output).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  const zip = await JSZip.loadAsync(await fs.readFile(output))
  expect(await zip.file('word/document.xml').async('string')).toContain('季度办公计划')
  await documentAction(frame, row, '复制')
  await expect(frame.getByRole('row').filter({ hasText: '季度计划 副本.docx' })).toBeVisible()
  await documentAction(frame, row, '移入回收站')
  await frame.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click()
  await frame.getByRole('button', { name: '回收站', exact: true }).click()
  await row.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(frame.getByText('已恢复文件', { exact: true })).toBeVisible()
  await frame.getByRole('button', { name: '全部文件', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(frame.locator('.ant-message-notice')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('02-library-files.png') })
  await frame.getByRole('button', { name: '我的收藏', exact: true }).click()
  await frame.getByRole('group', { name: '文件类型' }).getByRole('button', { name: '文档', exact: true }).click()
  await frame.getByRole('textbox', { name: '搜索文件', exact: true }).fill('季度计划')
  await frame.getByRole('combobox', { name: '排序方式', exact: true }).click()
  await frame.getByRole('combobox', { name: '排序方式', exact: true }).press('Home')
  await frame.getByRole('combobox', { name: '排序方式', exact: true }).press('ArrowDown')
  await frame.getByRole('combobox', { name: '排序方式', exact: true }).press('ArrowDown')
  await frame.getByRole('combobox', { name: '排序方式', exact: true }).press('Enter')
  await frame.getByRole('checkbox', { name: '选择 季度计划.docx', exact: true }).check()
  await row.getByRole('button', { name: '季度计划.docx', exact: true }).click()
  await expect(editor).toContainText('季度办公计划')
  await frame.getByRole('button', { name: '文档库', exact: true }).click()
  await expect(frame.getByRole('button', { name: '我的收藏', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(frame.getByRole('textbox', { name: '搜索文件', exact: true })).toHaveValue('季度计划')
  await expect(frame.getByRole('group', { name: '文件类型' }).getByRole('button', { name: '文档', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(frame.locator('.office-sort')).toContainText('名称')
  await expect(frame.getByRole('checkbox', { name: '选择 季度计划.docx', exact: true })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('02-library-return-state.png') })
  await row.getByRole('button', { name: '打开', exact: true }).click()
  await expect(editor).toContainText('季度办公计划')
  await editor.fill('页面切换前最后一次编辑')
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.locator('[data-extension-page]')).toHaveCount(0)
  await instance.stop()
  ;({ app, page } = await instance.launch())
  frame = await office(page)
  await frame.getByRole('row').filter({ hasText: '季度计划.docx' }).getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.tiptap').first()).toContainText('页面切换前最后一次编辑', { timeout: 45000 })
  await page.screenshot({ path: testInfo.outputPath('03-docx-reopened.png') })
  expect(errors).toEqual([])
})

test('导入副本、批量管理和删除保护本机原文件', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-import')
  const { app, page } = await instance.launch()
  await install(app, page)
  const frame = await office(page)
  const source = path.join(project, 'fixtures/business.xlsx')
  const sourceHash = createHash('sha256').update(await fs.readFile(source)).digest('hex')
  await selectFiles(app, [source])
  await frame.getByRole('button', { name: '导入文件', exact: true }).first().click()
  const row = frame.getByRole('row').filter({ hasText: 'business.xlsx' })
  await expect(row).toBeVisible()
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.classic-dark' } } }))
  await expect.poll(() => frame.locator('.office-app').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await page.screenshot({ path: testInfo.outputPath('05-library-dark.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(1000, 800))
  await expect(frame.getByRole('button', { name: '新建文档', exact: true })).toBeVisible()
  await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('06-library-narrow.png') })
  await documentAction(frame, row, '移入回收站')
  await frame.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click()
  await frame.getByRole('button', { name: '回收站', exact: true }).click()
  await documentAction(frame, row, '彻底删除')
  await frame.getByRole('dialog').getByRole('button', { name: '彻底删除', exact: true }).click()
  await expect(frame.getByText('回收站是空的')).toBeVisible()
  expect(createHash('sha256').update(await fs.readFile(source)).digest('hex')).toBe(sourceHash)
  await page.screenshot({ path: testInfo.outputPath('04-trash-empty.png') })
})


test('文档工具栏粘贴系统富文本并保存，紧凑文件菜单可用', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-docx-clipboard')
  const { app, page } = await instance.launch()
  await install(app, page)
  const frame = await office(page)
  await create(frame, '文档', '剪贴板文档')
  const editor = frame.locator('.tiptap[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 45000 })
  await editor.click()
  await app.evaluate(({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({
    'text/plain': '来自系统剪贴板的中文段落',
    'text/html': '<p><strong>来自系统剪贴板的中文段落</strong></p>',
  })]))
  await frame.getByRole('button', { name: '粘贴', exact: true }).first().click()
  await expect(editor).toContainText('来自系统剪贴板的中文段落')
  await frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true }).click()
  await expect(frame.locator('.office-save-state')).toHaveText('已保存')
  await expect.poll(() => frame.locator('.office-document-bar').evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(42)
  await expect(frame.locator('.office-pdf-capabilities')).toHaveCount(0)
  const output = testInfo.outputPath('clipboard.docx')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await editorAction(frame, '导出')
  await expect.poll(async () => (await fs.stat(output).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  const zip = await JSZip.loadAsync(await fs.readFile(output))
  const document = await zip.file('word/document.xml').async('string')
  expect(document).toContain('来自系统剪贴板的中文段落')
  expect(document).toMatch(/<w:b(?:\s|\/|>)/)
  await expect(frame.locator('.office-notice')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('01-document-compact-header.png') })
  const menu = frame.getByRole('button', { name: '文件菜单', exact: true })
  await menu.focus()
  await menu.press('ArrowDown')
  await expect.poll(() => frame.getByRole('menuitem', { name: '导出', exact: true }).evaluate(node => ({ focused: document.activeElement === node, active: document.activeElement?.outerHTML, documentFocused: document.hasFocus() }))).toMatchObject({ focused: true, documentFocused: true })
  await page.keyboard.press('ArrowDown')
  await expect(frame.getByRole('menuitem', { name: '另存副本', exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('02-document-file-menu.png') })
  await page.keyboard.press('Escape')
  await expect(frame.getByRole('menu')).toBeHidden()
  await expect(menu).toBeFocused()
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { theme: { id: 'lexora.themes.classic-dark' } } }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(900, 800))
  await expect.poll(() => frame.locator('.office-app').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await expect(frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true })).toBeVisible()
  await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('03-document-dark-compact-header.png') })
})

test('Office 独立页引用经真实剪贴板进入任务，主 Agent 工具恢复原文档并保存写回', async ({ buddy }, testInfo) => {
  test.setTimeout(240000)
  const longReference = process.env.OFFICE_LONG_REFERENCE === '1'
  const quoteText = '请把这句改好。' + (longReference ? '长中文引用甲乙丙丁。'.repeat(12000) : '')
  const toolNames = Object.fromEntries(['references', 'read', 'edit'].map(name => [name, `lexora_plugin_${createHash('sha256').update(`${manifest.id}.${name}`).digest('hex').slice(0, 16)}`]))
  if (longReference) Object.assign(toolNames, { snapshotList: 'lexora_reference_list', snapshotRead: 'lexora_reference_read' })
  const requests = [], results = [], snapshotPages = []
  let snapshotIdentity, saved = false
  const snapshotTailOffset = () => quoteText.length - (snapshotPages[0]?.text.length ?? 16000)
  let selected, target, finished = false, sequence = 0
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const last = body.messages.at(-1)
    const send = (delta, finish = 'stop') => {
      const common = { id: `office-${++sequence}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    const call = (name, input) => send({ tool_calls: [{ index: 0, id: `tool-${sequence + 1}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls')
    if (!body.tools?.length) { send({ content: 'Office 引用写回' }); return }
    if (!Object.values(toolNames).every(name => body.tools.some(tool => tool.function.name === name))) { call('lexora_tool_search', { toolNames: Object.values(toolNames) }); return }
    if (last.role === 'tool') {
      try {
        const result = JSON.parse(typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join(''))
        results.push(result)
        if (result.items?.[0]?.kind) snapshotIdentity = result.items[0]
        else if (result.items) selected = result.items[0]
        if (typeof result.offset === 'number' && typeof result.totalLength === 'number') snapshotPages.push(result)
        if (result.targetId) target = result
        if (result.saved !== undefined) saved = true
        finished = saved && (!longReference || snapshotPages.length === 3)
        if (result.ok === false) { finished = true; send({ content: `工具失败：${result.error}` }); return }
      } catch {}
    }
    if (finished) { send({ content: '已通过 Office 工具修改并保存到文档库。' }); return }
    if (!selected) call(toolNames.references, {})
    else if (longReference && !snapshotIdentity) call(toolNames.snapshotList, {})
    else if (longReference && snapshotPages.length < 2) call(toolNames.snapshotRead, { sourceMessageId: snapshotIdentity.sourceMessageId, kind: snapshotIdentity.kind, referenceId: snapshotIdentity.referenceId, offset: snapshotPages.length === 0 ? 0 : snapshotTailOffset(), limit: 16000 })
    else if (longReference && saved) call(toolNames.snapshotRead, { sourceMessageId: snapshotIdentity.sourceMessageId, kind: snapshotIdentity.kind, referenceId: snapshotIdentity.referenceId, offset: snapshotTailOffset(), limit: 16000 })
    else if (!target) call(toolNames.read, { referenceId: selected.referenceId, sourceMessageId: selected.sourceMessageId })
    else call(toolNames.edit, { referenceId: selected.referenceId, targetId: target.targetId, expectedRevision: target.revision, operation: 'replace_text', input: JSON.stringify({ text: '已通过 Office 工具写回。' }) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const instance = await buddy.createInstance('office-reference')
  const real = process.env.OFFICE_REAL_MODEL === '1'
  if (real) test.setTimeout(360000)
  const query = (sql, ...args) => { const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true }); try { return db.prepare(sql).all(...args) } finally { db.close() } }
  let { app, page } = await instance.launch()
  try {
    await install(app, page)
    if (!real) {
    await useSyntheticCredentialStorage({ app, page })
    await page.evaluate(async baseUrl => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'office-fixture', displayName: 'Office fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'office', name: 'office', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 2048 }] })
      const stop = providers.onAuthChallenge(event => { if (event.providerId === 'office-fixture' && event.type === 'secret') void providers.respondToAuth(event.challengeId, 'offline-fixture-key') })
      try { await providers.login('office-fixture', 'api_key') } finally { stop() }
      await providers.setDefaultModel({ providerId: 'office-fixture', modelId: 'office', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    } else {
      await setupRealModel({ instance, app, page, scenario: 'reference' })
    }
    let frame = await office(page)
    await create(frame, '文档', '引用写回验收')
    const body = frame.locator('.tiptap[contenteditable=true]').first()
    await expect(body).toBeVisible({ timeout: 45000 })
    await body.fill(quoteText)
    await body.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element.querySelector('p'))
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await expect.poll(() => frame.evaluate(() => window.getSelection()?.toString())).toBe(quoteText)
    await expect(frame.getByRole('button', { name: 'AI 修改', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('docx-selection-reference.png') })
    await frame.getByLabel('文档操作', { exact: true }).getByRole('button', { name: '引用', exact: true }).click()
    await page.locator('.reference-target-picker').getByRole('button', { name: '复制引用', exact: true }).click()
    await expect(page.getByText('已复制引用', { exact: true })).toBeVisible({ timeout: 30000 })
    const clipboard = await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read(); let text = '', html = ''
      for (const item of items) { if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text(); if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text() }
      return { text, html }
    })
    expect(clipboard.text).toContain(quoteText); expect(clipboard.html).toContain('data-lexora-reference')
    expect(clipboard.html).not.toContain('documentId')
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
    await expect(composer).toBeVisible()
    await composer.click(); await page.keyboard.press('Control+v')
    await expect(composer.locator('[data-type=chat-quote-reference]')).toHaveCount(1)
    await page.keyboard.type(' 请使用 Office 技能和工具，把引用中的文字替换为：已通过 Office 工具写回。保存到原文档库记录，不创建副本。')
    await page.screenshot({ path: testInfo.outputPath('01-reference-in-task.png') })
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    if (real) {
      await expect.poll(() => query("SELECT status FROM runs WHERE purpose='chat' AND execution_kind='root' ORDER BY rowid DESC LIMIT 1")[0]?.status, { timeout: 180000 }).toBe('completed')
      const run = query("SELECT id,model,provider,pi_session_file FROM runs WHERE purpose='chat' AND execution_kind='root' ORDER BY rowid DESC LIMIT 1")[0]
      const journal = (await fs.readFile(run.pi_session_file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const entry of journal) if (entry.message?.role === 'toolResult' && Object.values(toolNames).includes(entry.message.toolName)) {
        try { results.push(JSON.parse(entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))) } catch {}
      }
      const usage = query('SELECT model,purpose,total_tokens FROM usage_records WHERE run_id=?', run.id)
      await fs.writeFile(testInfo.outputPath('real-model-evidence.json'), JSON.stringify({ model: run.model, provider: run.provider, usage, results }, null, 2))
      expect(query('SELECT id FROM runs WHERE parent_run_id IS NOT NULL')).toHaveLength(0)
    } else await expect.poll(() => finished, { timeout: 90000 }).toBe(true)
    if (longReference) {
      expect(Buffer.byteLength(quoteText)).toBeGreaterThan(256 * 1024)
      expect(snapshotPages).toHaveLength(3)
      const firstPage = snapshotPages[0]
      expect(firstPage.text.length).toBeGreaterThan(0)
      expect(firstPage.text.length).toBeLessThanOrEqual(16000)
      expect(firstPage).toMatchObject({ offset: 0, totalLength: quoteText.length, nextOffset: firstPage.text.length })
      const digest = text => createHash('sha256').update(text).digest('hex')
      expect(digest(firstPage.text)).toBe(digest(quoteText.slice(0, firstPage.nextOffset)))
      for (const value of snapshotPages.slice(1)) {
        expect(value).toMatchObject({ offset: snapshotTailOffset(), totalLength: quoteText.length, nextOffset: null })
        expect(digest(value.text)).toBe(digest(quoteText.slice(snapshotTailOffset())))
      }
    }
    expect(results.find(result => result.saved !== undefined)).toMatchObject({ ok: true, mutated: true, saved: true })
    const current = results.find(result => result.targetId && result.contentState === 'current')
    expect(current).toMatchObject({ ok: true, contentState: 'current', sourceChangedSinceReference: false })
    expect(current.sourceMessageId).toEqual(expect.any(String))
    expect(current.documentVersion).toBe(current.referenceDocumentVersion)
    const inputs = requests.filter(body => body.tools?.length).map(body => body.messages.filter(message => message.role === 'user'))
    expect(JSON.stringify(inputs)).not.toContain('documentId')
    expect(JSON.stringify(inputs)).not.toContain('locator')
    await page.screenshot({ path: testInfo.outputPath('02-office-tool-writeback.png') })
    frame = await office(page)
    const row = frame.getByRole('row').filter({ hasText: '引用写回验收.docx' })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '打开', exact: true }).click()
    await expect(frame.locator('.tiptap').first()).toContainText('已通过 Office 工具写回。')
    await expect(frame.locator('.office-save-state')).toHaveText('已保存')
    await instance.stop(); ({ app, page } = await instance.launch())
    frame = await office(page)
    await frame.getByRole('row').filter({ hasText: '引用写回验收.docx' }).getByRole('button', { name: '打开', exact: true }).click()
    await expect(frame.locator('.tiptap').first()).toContainText('已通过 Office 工具写回。')
    await page.screenshot({ path: testInfo.outputPath('03-office-reopened.png') })
  } finally {
    await fs.writeFile(testInfo.outputPath('office-tool-results.json'), JSON.stringify({ results, requestCount: requests.length, longReference, quoteTextLength: quoteText.length, quoteTextSha256: createHash('sha256').update(quoteText).digest('hex') }, null, 2))
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})

test('Office 套件由主 Agent 新建 PDF、连续编辑、查看原生图片并交付真实任务产物', async ({ buddy }, testInfo) => {
  const toolNames = Object.fromEntries(['create', 'capabilities', 'edit', 'read', 'render', 'export', 'documents'].map(name => [name, `lexora_plugin_${createHash('sha256').update(`${manifest.id}.${name}`).digest('hex').slice(0, 16)}`]))
  const requests = [], results = []
  let sequence = 0, step = 0, target, finished = false
  const plan = [
    () => ['create', { kind: 'pdf', name: 'Office suite acceptance' }],
    () => ['capabilities', { targetId: target.targetId }],
    () => ['edit', { targetId: target.targetId, expectedRevision: target.revision, operation: 'insert_text', input: JSON.stringify({ page: 1, x: 72, y: 72, text: 'Office suite report', font_size: 24, font: 'arial', max_width: 450 }) }],
    () => ['read', { targetId: target.targetId, query: { operation: 'read_pages', input: '{"start":1,"end":1}' } }],
    () => ['edit', { targetId: target.targetId, expectedRevision: target.revision, operation: 'insert_text', input: JSON.stringify({ page: 1, x: 72, y: 130, text: 'Continuous editing verified.', font_size: 16, font: 'arial', max_width: 450 }) }],
    () => ['read', { targetId: target.targetId, query: { operation: 'read_pages', input: '{"start":1,"end":1}' } }],
    () => ['render', { targetId: target.targetId, input: '{"page":1}' }],
    () => ['export', { targetId: target.targetId, expectedRevision: target.revision }],
    () => ['documents', { query: 'Office suite acceptance' }],
  ]
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const send = (delta, finish = 'stop') => {
      const common = { id: `suite-${++sequence}`, model: body.model, object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    const call = (name, input) => send({ tool_calls: [{ index: 0, id: `suite-tool-${sequence + 1}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls')
    if (!body.tools?.length) { send({ content: 'Office suite' }); return }
    if (sequence > 50) { finished = true; send({ content: '测试请求超过预期次数。' }); return }
    const missing = Object.values(toolNames).filter(name => !body.tools.some(tool => tool.function.name === name))
    if (missing.length) { call('lexora_tool_search', { toolNames: missing.slice(0, 5) }); return }
    const last = body.messages.findLast(message => message.role === 'tool')
    if (last) {
      try {
        const result = JSON.parse(typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join(''))
        if (!results.some(item => item.callId === last.tool_call_id)) results.push({ callId: last.tool_call_id, ...result })
        if (result.targetId) target = { ...target, ...result }
        if (result.ok === false) { finished = true; send({ content: `工具失败：${result.error}` }); return }
      } catch {}
    }
    if (step >= plan.length) { finished = true; send({ content: '已创建、检查并交付 PDF。' }); return }
    const [name, input] = plan[step++](); call(toolNames[name], input)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const instance = await buddy.createInstance('office-suite')
  const real = process.env.OFFICE_SUITE_REAL_MODEL === '1'
  if (real) test.setTimeout(420000)
  const query = (sql, ...args) => { const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true }); try { return db.prepare(sql).all(...args) } finally { db.close() } }
  const { app, page } = await instance.launch()
  try {
    await install(app, page)
    if (!real) {
    await useSyntheticCredentialStorage({ app, page })
    await page.evaluate(async baseUrl => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'office-suite', displayName: 'Office suite', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'office', name: 'office', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 2048 }] })
      const stop = providers.onAuthChallenge(event => { if (event.providerId === 'office-suite' && event.type === 'secret') void providers.respondToAuth(event.challengeId, 'offline-fixture-key') })
      try { await providers.login('office-suite', 'api_key') } finally { stop() }
      await providers.setDefaultModel({ providerId: 'office-suite', modelId: 'office', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    } else {
      await setupRealModel({ instance, app, page, scenario: 'suite' })
    }
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
    await composer.fill('请使用 Office 套件的 office/pdf 技能与工具，新建 Office suite acceptance.pdf。先添加标题 Office suite report 并保存，再对同一文档继续添加正文 Continuous editing verified. 并保存（分两次修改以验证连续编辑）。读取正文确认，查看第1页渲染图并核对排版，最后导出为任务产物。不创建第二份文档。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    let imageVerified = false
    if (real) {
      await expect.poll(() => query("SELECT status FROM runs WHERE purpose='chat' AND execution_kind='root' ORDER BY rowid DESC LIMIT 1")[0]?.status, { timeout: 300000 }).toBe('completed')
      const run = query("SELECT id,model,provider,pi_session_file FROM runs WHERE purpose='chat' AND execution_kind='root' ORDER BY rowid DESC LIMIT 1")[0]
      const journal = (await fs.readFile(run.pi_session_file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const entry of journal) if (entry.message?.role === 'toolResult' && Object.values(toolNames).includes(entry.message.toolName)) {
        if (entry.message.content.some(block => block.type === 'image')) imageVerified = true
        try { results.push(JSON.parse(entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))) } catch {}
      }
      const usage = query('SELECT model,purpose,total_tokens FROM usage_records WHERE run_id=?', run.id)
      await fs.writeFile(testInfo.outputPath('real-suite-evidence.json'), JSON.stringify({ model: run.model, provider: run.provider, usage, results, imageVerified }, null, 2))
      expect(query('SELECT id FROM runs WHERE parent_run_id IS NOT NULL')).toHaveLength(0)
    } else {
      await expect.poll(() => finished, { timeout: 150000 }).toBe(true)
      expect(results.filter(item => item.ok === false)).toEqual([])
    }
    expect(results.filter(item => item.mutated === true && item.saved === true).length).toBeGreaterThanOrEqual(2)
    expect(results.some(item => item.text?.includes('Continuous editing verified.'))).toBe(true)
    const delivered = results.find(item => item.artifact)?.artifact
    expect(delivered?.name).toBe('Office suite acceptance.pdf')
    const artifact = query('SELECT * FROM artifacts WHERE id=?', delivered.id)[0]
    expect(artifact).toBeTruthy()
    const bytes = await fs.readFile(artifact.current_path)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    await fs.writeFile(testInfo.outputPath('delivered.pdf'), bytes)
    const { execFileSync } = await import('node:child_process')
    const text = execFileSync('pdftotext', [artifact.current_path, '-'], { encoding: 'utf8' })
    expect(text).toContain('Office suite report'); expect(text).toContain('Continuous editing verified.')
    expect(real ? imageVerified : requests.some(body => body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')))).toBe(true)
    if (!real) expect(results.find(item => item.documents)?.documents).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('suite-delivered.png') })
  } finally {
    await fs.writeFile(testInfo.outputPath('suite-evidence.json'), JSON.stringify({ results, requestCount: requests.length }, null, 2))
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})

test('保留数据卸载旧包后安装当前包，文档、收藏、版本与继续保存保持完整', async ({ buddy }, testInfo) => {
  test.skip(!process.env.OFFICE_PREVIOUS_PACKAGE, 'Set OFFICE_PREVIOUS_PACKAGE to an existing previous GenOffice package.')
  const instance = await buddy.createInstance('office-retained-data')
  let { app, page } = await instance.launch()
  await install(app, page, path.resolve(process.env.OFFICE_PREVIOUS_PACKAGE))
  const previousManifest = await page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id).manifest, manifest.id)
  expect(previousManifest.version !== manifest.version || previousManifest.name !== manifest.name).toBe(true)
  let frame = await office(page)
  await create(frame, '文档', '迁移保留文档')
  let editor = frame.locator('.tiptap[contenteditable=true]').first()
  await expect(editor).toBeVisible({ timeout: 45000 })
  await editor.fill('迁移前第一版内容')
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await editor.fill('迁移前最新内容')
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await frame.getByRole('button', { name: '文档库', exact: true }).click()
  let row = frame.getByRole('row').filter({ hasText: '迁移保留文档.docx' })
  await row.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible()
  await documentAction(frame, row, '版本')
  let history = frame.getByRole('dialog', { name: '版本历史', exact: true })
  await expect(history.locator('.office-version-row')).toHaveCount(3)
  await history.getByRole('button', { name: /close|关闭/i }).click()
  const beforeFile = testInfo.outputPath('before-reinstall.docx')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, beforeFile)
  await documentAction(frame, row, '导出')
  await expect.poll(async () => (await fs.stat(beforeFile).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.locator('[data-extension-page]')).toHaveCount(0)
  await page.evaluate(id => window.lexoraDesktop.extensions.uninstall(id, { clearData: false }), manifest.id)
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id), manifest.id)).toBe(false)
  await install(app, page)
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.manifest.version, manifest.id)).toBe(manifest.version)
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.manifest.name, manifest.id)).toBe(manifest.name)
  frame = await office(page)
  row = frame.getByRole('row').filter({ hasText: '迁移保留文档.docx' })
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible()
  await documentAction(frame, row, '版本')
  history = frame.getByRole('dialog', { name: '版本历史', exact: true })
  await expect(history.locator('.office-version-row')).toHaveCount(3)
  await history.getByRole('button', { name: /close|关闭/i }).click()
  const afterFile = testInfo.outputPath('after-reinstall.docx')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, afterFile)
  await documentAction(frame, row, '导出')
  await expect.poll(async () => (await fs.stat(afterFile).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  expect(await fs.readFile(afterFile)).toEqual(await fs.readFile(beforeFile))
  await row.getByRole('button', { name: '打开', exact: true }).click()
  editor = frame.locator('.tiptap[contenteditable=true]').first()
  await expect(editor).toContainText('迁移前最新内容', { timeout: 45000 })
  await editor.fill('迁移后继续保存的内容')
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await instance.stop()
  ;({ app, page } = await instance.launch())
  frame = await office(page)
  await frame.getByRole('row').filter({ hasText: '迁移保留文档.docx' }).getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.tiptap').first()).toContainText('迁移后继续保存的内容', { timeout: 45000 })
  await page.screenshot({ path: testInfo.outputPath('retained-library-reopened.png') })
})
