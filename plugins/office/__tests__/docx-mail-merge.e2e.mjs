import { repository, pluginPackage } from './paths.mjs'
import { documentAction } from './library-locators.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
const project = path.resolve(import.meta.dirname, '..')

const { test, expect } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)
const manifest = JSON.parse(await fs.readFile(path.join(project, 'dist/extension.json'), 'utf8'))
const archive = pluginPackage(manifest.version)

async function selectFiles(app, files) { await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: !files.length, filePaths: files }) }, files) }
async function install(app, page) {
  await expect(page.locator('.desktop-app-sidebar')).toBeVisible()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible()))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(1600, 1050))
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await expect(page.getByTestId('feature-discovery-reminder')).toBeHidden()
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await selectFiles(app, [archive])
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
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await frame.getByRole('button', { name: '文档库', exact: true }).isVisible().catch(() => false)) return true
    }
    return false
  }).toBe(true)
  let frame
  await expect.poll(async () => {
    for (const item of page.frames()) {
      if (item.url().startsWith('lexora-extension:') && await item.locator('[data-office]').isVisible().catch(() => false)) { frame = item; return true }
    }
    return false
  }, { timeout: 40000 }).toBe(true)
  await expect(frame.getByRole('button', { name: '文档库', exact: true })).toHaveAttribute('aria-current', 'page')
  return frame
}
async function create(frame, kind, name) {
  await frame.getByRole('button', { name: `新建${kind}`, exact: true }).click()
  const form = frame.getByRole('dialog')
  await form.getByLabel('文件名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '创建', exact: true }).click()
}

test('邮件合并读取收件人并导出独立DOCX，保留库中模板', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-mail-merge')
  const { app, page } = await instance.launch()
  const errors = []
  app.context().on('weberror', event => errors.push(String(event.error())))
  await install(app, page)
  const frame = await office(page)
  await create(frame, '文档', '邀请函模板')
  const editor = frame.locator('.tiptap[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 45000 })
  await editor.fill('邀请函：')
  await editor.press('Control+End')
  const source = testInfo.outputPath('recipients.csv')
  await fs.writeFile(source, '\uFEFF姓名,公司\n"张三","甲,公司"\n"张三","乙公司"', 'utf8')
  await selectFiles(app, [source])
  await frame.getByRole('button', { name: '邮件', exact: true }).click()
  await frame.getByRole('button', { name: '开始邮件合并', exact: true }).click()
  const panel = frame.locator('.modal-mailmerge')
  await panel.getByRole('button', { name: '选择收件人列表…', exact: true }).click()
  await expect(panel.locator('.mailmerge-source-name')).toHaveText('recipients.csv')
  await expect(panel.locator('.modal-error')).toHaveCount(0)
  await panel.getByRole('button', { name: '姓名', exact: true }).click()
  await panel.getByRole('button', { name: '公司', exact: true }).click()
  const archivePath = testInfo.outputPath('merged-letters.zip')
  await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, archivePath)
  await panel.getByRole('button', { name: '完成并合并', exact: true }).click()
  await expect(panel.locator('.mailmerge-done')).toHaveText('已合并 2 个文档')
  const archive = await JSZip.loadAsync(await fs.readFile(archivePath))
  expect(Object.keys(archive.files).sort()).toEqual(['张三-2.docx', '张三.docx'])
  for (const [name, company] of [['张三.docx', '甲,公司'], ['张三-2.docx', '乙公司']]) {
    const doc = await JSZip.loadAsync(await archive.file(name).async('uint8array'))
    const xml = await doc.file('word/document.xml').async('string')
    expect(xml).toContain('张三')
    expect(xml).toContain(company)
    expect(xml).not.toContain('MERGEFIELD')
  }
  const combinedPath = testInfo.outputPath('merged-all.docx')
  await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, combinedPath)
  await panel.getByLabel('所有记录合并为一个文档').check()
  await panel.getByRole('button', { name: '完成并合并', exact: true }).click()
  await expect(panel.locator('.mailmerge-done')).toHaveText('已合并 1 个文档')
  const combined = await JSZip.loadAsync(await fs.readFile(combinedPath))
  const combinedXml = await combined.file('word/document.xml').async('string')
  expect(combinedXml).toContain('甲,公司')
  expect(combinedXml).toContain('乙公司')
  await page.screenshot({ path: testInfo.outputPath('01-mail-merge.png') })
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true }).click()
  await expect(frame.locator('.office-save-state')).toHaveText('已保存')
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  const templatePath = testInfo.outputPath('template.docx')
  await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, templatePath)
  await documentAction(frame, frame.getByRole('row').filter({ hasText: '邀请函模板.docx' }), '导出')
  await expect.poll(async () => (await fs.stat(templatePath).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  const template = await JSZip.loadAsync(await fs.readFile(templatePath))
  const templateXml = await template.file('word/document.xml').async('string')
  expect(templateXml).toContain('MERGEFIELD')
  expect(templateXml).not.toContain('甲,公司')
  expect(templateXml).not.toContain('乙公司')
  expect(errors).toEqual([])
})
