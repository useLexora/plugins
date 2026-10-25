import { repository, pluginPackage } from './paths.mjs'
import { documentAction } from './library-locators.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PDFDocument } from 'pdf-lib'
const project = path.resolve(import.meta.dirname, '..')

const { test, expect } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)
const manifest = JSON.parse(await fs.readFile(path.join(project, 'dist/extension.json'), 'utf8'))
const archive = pluginPackage(manifest.version)

async function selectFiles(app, files) { await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: !files.length, filePaths: files }) }, files) }
async function install(app, page) {
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
  let frame
  await expect.poll(async () => {
    for (const item of page.frames()) {
      if (item.url().startsWith('lexora-extension:') && await item.locator('[data-office]').isVisible().catch(() => false)) { frame = item; return true }
    }
    return false
  }, { timeout: 40000 }).toBe(true)
  await expect(frame.getByRole('button', { name: '全部文件', exact: true })).toHaveAttribute('aria-current', 'page')
  return frame
}
async function create(frame, kind, name) {
  await frame.getByRole('button', { name: `新建${kind}`, exact: true }).click()
  const form = frame.getByRole('dialog')
  await form.getByLabel('文件名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '创建', exact: true }).click()
}

test('PDF 在隔离插件中编辑中文、批注、页面并跨重启恢复', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-pdf')
  let { app, page } = await instance.launch()
  const errors = []
  app.context().on('weberror', event => errors.push(String(event.error())))
  await install(app, page)
  let frame = await office(page)
  await create(frame, 'PDF', 'PDF 办公验收')
  await expect(frame.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 60000 })
  expect(await frame.evaluate(() => ({ origin, node: typeof process, desktop: typeof window.lexoraDesktop }))).toEqual({ origin: 'null', node: 'undefined', desktop: 'undefined' })
  await frame.getByRole('button', { name: '编辑', exact: true }).click()
  await frame.getByRole('button', { name: '插入文字', exact: true }).click()
  await frame.locator('.pdf-modal textarea').fill('Office PDF 中文办公验收')
  await frame.locator('.pdf-modal').getByRole('button', { name: '确定', exact: true }).click()
  await frame.locator('.pdf-page').first().click({ position: { x: 150, y: 180 } })
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await expect(frame.locator('.pdf-page .textLayer').first()).toContainText('Office PDF 中文办公验收', { timeout: 30000 })
  await frame.getByRole('button', { name: '页面', exact: true }).click()
  await frame.getByRole('button', { name: '插入空白页', exact: true }).click()
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await expect(frame.locator('.pdf-thumb')).toHaveCount(2)
  const incoming = await PDFDocument.create()
  incoming.addPage([595, 842]).drawText('Imported PDF page')
  const importedPath = testInfo.outputPath('secondary.pdf')
  await fs.writeFile(importedPath, await incoming.save())
  await selectFiles(app, [importedPath])
  await frame.getByRole('button', { name: '导入页面', exact: true }).click()
  await expect(frame.locator('.pdf-thumb')).toHaveCount(3)
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
  await page.screenshot({ path: testInfo.outputPath('01-pdf-edited.png') })
  await frame.getByRole('button', { name: '文档库', exact: true }).click()
  let row = frame.getByRole('row').filter({ hasText: 'PDF 办公验收.pdf' })
  await expect(row).toBeVisible()
  const output = testInfo.outputPath('office.pdf')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await documentAction(frame, row, '导出')
  await expect.poll(async () => (await fs.stat(output).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  expect((await PDFDocument.load(await fs.readFile(output))).getPageCount()).toBe(3)
  const extracted = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' })
  expect(extracted).toContain('Office PDF 中文办公验收')
  expect(extracted).toContain('Imported PDF page')
  await instance.stop()
  ;({ app, page } = await instance.launch())
  frame = await office(page)
  row = frame.getByRole('row').filter({ hasText: 'PDF 办公验收.pdf' })
  await row.getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.pdf-page .textLayer').first()).toContainText('Office PDF 中文办公验收', { timeout: 60000 })
  await expect(frame.locator('.pdf-thumb')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('02-pdf-reopened.png') })
  expect(errors).toEqual([])
})
