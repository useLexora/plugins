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

async function install(app, page) {
  await expect(page.locator('.desktop-app-sidebar')).toBeVisible()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible()))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(1600, 1050))
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await expect(page.getByTestId('feature-discovery-reminder')).toBeHidden()
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
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

async function insertTab(frame) {
  await frame.getByRole('button', { name: '开始', exact: true }).click()
  await frame.getByRole('button', { name: '插入', exact: true }).click()
}

async function save(frame) {
  await frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true }).click()
  await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
}

async function exportFromLibrary(app, frame, fileName, output) {
  const row = frame.getByRole('row').filter({ hasText: fileName })
  await expect(row).toBeVisible()
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await documentAction(frame, row, '导出')
  await expect.poll(async () => (await fs.stat(output).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
  return JSZip.loadAsync(await fs.readFile(output))
}

async function expectPresentation(zip, note) {
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  expect(slide).toContain('季度汇报：中文与图表可靠保存')
  expect(slide).toMatch(/<a:tbl>/)
  expect(slide).toMatch(/<c:chart\b/)
  const charts = Object.values(zip.files).filter(file => /^ppt\/charts\/chart\d+\.xml$/.test(file.name))
  expect(charts).toHaveLength(1)
  expect(await charts[0].async('string')).toMatch(/<c:barChart\b/)
  const notes = Object.values(zip.files).filter(file => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(file.name))
  expect(notes).toHaveLength(1)
  expect(await notes[0].async('string')).toContain(note)
}

test('PPTX 在隔离插件中编辑中文、表格、图表并跨重启恢复', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('office-slides')
  let { app, page } = await instance.launch()
  const errors = []
  const observeErrors = app => app.context().on('weberror', event => errors.push(String(event.error())))
  observeErrors(app)
  await install(app, page)
  let frame = await office(page)
  const fileName = '季度演示验收.pptx'
  await frame.getByRole('button', { name: '新建演示文稿', exact: true }).click()
  const create = frame.getByRole('dialog')
  await create.getByLabel('文件名称', { exact: true }).fill('季度演示验收')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await expect(frame.locator('.stage-rel')).toBeVisible({ timeout: 60000 })
  expect(await frame.evaluate(() => ({ origin, node: typeof process, desktop: typeof window.lexoraDesktop }))).toEqual({ origin: 'null', node: 'undefined', desktop: 'undefined' })

  await insertTab(frame)
  await expect(frame.getByRole('button', { name: '屏幕录制', exact: true })).toBeDisabled()
  await expect(frame.getByLabel('录制屏幕：当前不支持屏幕录制。', { exact: true })).toBeVisible()
  await frame.getByRole('button', { name: '文本框', exact: true }).click()
  await frame.locator('.stage-rel').click({ position: { x: 160, y: 100 } })
  const textEditor = frame.locator('[contenteditable="true"]').first()
  await expect(textEditor).toBeVisible()
  await textEditor.fill('季度汇报：中文与图表可靠保存')

  await insertTab(frame)
  await frame.getByRole('button', { name: '表格', exact: true }).click()
  await frame.locator('.rb-table-cell').nth(11).click()
  await expect(frame.getByRole('button', { name: '表格设计', exact: true })).toBeVisible()
  await insertTab(frame)
  await frame.getByRole('button', { name: '图表', exact: true }).click()
  await frame.locator('.rb-menu').getByRole('button', { name: '簇状柱形图', exact: true }).click()
  await expect(frame.getByRole('button', { name: '图表设计', exact: true })).toBeVisible()
  await frame.locator('.notes-pane textarea').fill('已完成第一季度汇报。')
  await save(frame)
  await page.screenshot({ path: testInfo.outputPath('01-slides-edited.png') })
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  await expectPresentation(await exportFromLibrary(app, frame, fileName, testInfo.outputPath('slides-edited.pptx')), '已完成第一季度汇报。')

  await frame.getByRole('row').filter({ hasText: fileName }).getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.notes-pane textarea')).toHaveValue('已完成第一季度汇报。', { timeout: 60000 })
  await frame.locator('.notes-pane textarea').fill('重启前保存的中文演讲备注。')
  await save(frame)
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  await instance.stop()

  ;({ app, page } = await instance.launch())
  observeErrors(app)
  frame = await office(page)
  await frame.getByRole('row').filter({ hasText: fileName }).getByRole('button', { name: '打开', exact: true }).click()
  await expect(frame.locator('.stage-rel')).toBeVisible({ timeout: 60000 })
  await expect(frame.locator('.notes-pane textarea')).toHaveValue('重启前保存的中文演讲备注。')
  await expect(frame.locator('.office-save-state')).toHaveText('已保存')
  await page.screenshot({ path: testInfo.outputPath('02-slides-reopened.png') })
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  await expectPresentation(await exportFromLibrary(app, frame, fileName, testInfo.outputPath('slides-reopened.pptx')), '重启前保存的中文演讲备注。')
  expect(errors).toEqual([])
})
