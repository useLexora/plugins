import { repository, pluginPackage } from './paths.mjs'
import { editorAction } from './library-locators.mjs'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const project = path.resolve(import.meta.dirname, '..')

const { test, expect } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)

test('Office 表格真实编辑、自动保存、导出与从文档库重开', async ({ buddy }, testInfo) => {
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'dist/extension.json'), 'utf8'))
  const archive = pluginPackage(manifest.version)
  const source = path.join(project, 'fixtures/business.xlsx')
  const before = createHash('sha256').update(await fs.readFile(source)).digest('hex')
  const output = testInfo.outputPath('office-sheets-export.xlsx')
  const instance = await buddy.createInstance('office-sheets')
  const { app, page, diagnostics } = await instance.launch()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setContentSize(1440, 1000))
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.enabled, manifest.id)).toBe(true)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: 'Office', exact: true }).click()
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await frame.getByRole('button', { name: '文档库', exact: true }).isVisible().catch(() => false)) return true
    }
    return false
  }).toBe(true)
  let frame
  await expect.poll(async () => {
    frame = page.frames().find(candidate => candidate.url().startsWith('lexora-extension:') && !candidate.isDetached())
    return frame && await frame.getByRole('button', { name: '文档库', exact: true }).getAttribute('aria-current') === 'page'
  }, { timeout: 30000 }).toBe(true)
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, source)
  await frame.getByRole('button', { name: '导入文件', exact: true }).first().click()
  const row = frame.getByRole('row').filter({ hasText: 'business.xlsx' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.office-document-title')).toContainText('business.xlsx')
  const nameBox = frame.locator('input.univer-appearance-none')
  await expect(nameBox).toHaveValue(/^A1(?::H1)?$/, { timeout: 60000 })
  await nameBox.fill('B4'); await nameBox.press('Enter')
  await frame.locator('[data-u-comp=workbench-layout]').focus()
  await page.keyboard.press('F2'); await page.keyboard.press('Control+A'); await page.keyboard.insertText('界面验收修改'); await page.keyboard.press('Enter')
  await nameBox.fill('B4'); await nameBox.press('Enter'); await page.keyboard.press('Control+b')
  await frame.locator('[data-u-comp=workbench-layout]').focus()
  await page.keyboard.press('Control+c')
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('界面验收修改')
  const copiedHtml = await app.evaluate(async ({ clipboard }) => { const [item] = await clipboard.read(); return (await item.getType('text/html')).text() })
  expect(copiedHtml).toContain('界面验收修改')
  expect(copiedHtml).toContain('data-copy-id')
  await nameBox.fill('B5'); await nameBox.press('Enter')
  await frame.locator('[data-u-comp=workbench-layout]').focus()
  await page.keyboard.press('Control+v')
  await frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true }).click()
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await editorAction(frame, '导出')
  await expect.poll(async () => (await fs.stat(output).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  const zip = await JSZip.loadAsync(await fs.readFile(output))
  const worksheet = await zip.file('xl/worksheets/sheet1.xml').async('text')
  expect(worksheet.match(/<c\b[^>]*r="B4"[^>]*>[\s\S]*?<\/c>/)?.[0]).toContain('界面验收修改')
  expect(worksheet.match(/<c\b[^>]*r="B5"[^>]*>[\s\S]*?<\/c>/)?.[0]).toContain('界面验收修改')
  expect(createHash('sha256').update(await fs.readFile(source)).digest('hex')).toBe(before)
  await page.screenshot({ path: testInfo.outputPath('office-sheets-edited.png'), animations: 'disabled' })
  await frame.locator('.office-document-bar').getByRole('button', { name: 'Office 首页', exact: true }).click()
  await row.getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.office-document-title')).toContainText('business.xlsx')
  await expect(nameBox).toHaveValue(/^A1(?::H1)?$/, { timeout: 60000 })
  await nameBox.fill('B4'); await nameBox.press('Enter')
  const reopenedOutput = testInfo.outputPath('office-sheets-reopened.xlsx')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, reopenedOutput)
  await editorAction(frame, '导出')
  await expect.poll(async () => (await fs.stat(reopenedOutput).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  const reopened = await JSZip.loadAsync(await fs.readFile(reopenedOutput))
  expect(await reopened.file('xl/worksheets/sheet1.xml').async('text')).toContain('界面验收修改')
  await page.screenshot({ path: testInfo.outputPath('office-sheets-reopened.png'), animations: 'disabled' })
  expect(diagnostics.console.filter(entry => entry.type === 'pageerror')).toEqual([])
  await testInfo.attach('office-sheets-proof', { body: JSON.stringify({ archive, sourceUnchanged: true, exportedBytes: (await fs.stat(output)).size, nativeEditing: true, libraryReopened: true }), contentType: 'application/json' })
})
