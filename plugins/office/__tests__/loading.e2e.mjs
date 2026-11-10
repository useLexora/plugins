import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { project, repository } from './paths.mjs'

const { test, expect } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)

test('Office loading can leave for settings or cancel to the library without losing documents', async ({ buddy }, info) => {
  const instance = await buddy.createInstance('office-loading')
  const directory = path.join(instance.home, 'fixtures', 'office')
  await fs.cp(path.join(project, 'dist'), directory, { recursive: true })
  await fs.rename(path.join(directory, 'docx-editor.js'), path.join(directory, 'docx-original.js'))
  await fs.writeFile(path.join(directory, 'docx-editor.js'), `
export * from './docx-original.js'
import { mountDocxEditor as mount } from './docx-original.js'
export async function mountDocxEditor(options) {
  globalThis.officeLoadSignal = options.context.signal
  await new Promise(resolve => { globalThis.releaseOfficeLoad = resolve })
  options.context.signal.throwIfAborted()
  return mount(options)
}
`)
  const { app, page } = await instance.launch()
  const navigate = name => page.locator('.desktop-app-sidebar').getByRole('button', { name, exact: true }).click()
  await navigate('插件')
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, directory)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-development').click()
  await page.getByTestId('extension-confirm-install').click()
  await navigate('Office')
  const officeFrame = async () => {
    let frame
    await expect.poll(async () => {
      frame = page.frames().find(candidate => candidate.url().startsWith('lexora-extension:'))
      return frame && await frame.getByRole('button', { name: '打开本地文件', exact: true }).isVisible()
    }).toBe(true)
    return frame
  }
  let frame = await officeFrame()
  await frame.getByRole('button', { name: '新建文档', exact: true }).click()
  await frame.getByRole('dialog').getByLabel('文件名称', { exact: true }).fill('Loading navigation')
  await frame.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  const loading = async () => {
    await expect(frame.locator('.office-save-state')).toHaveText('正在打开')
    await expect.poll(() => frame.evaluate(() => typeof globalThis.releaseOfficeLoad)).toBe('function')
  }
  await loading()
  await page.screenshot({ path: info.outputPath('01-loading.png') })
  await navigate('设置')
  await expect(page.locator('[data-extension-page]')).toHaveCount(0, { timeout: 3000 })
  await expect.poll(() => frame.isDetached(), { timeout: 3000 }).toBe(true)
  await navigate('任务')
  await navigate('Office')
  frame = await officeFrame()
  const document = () => frame.getByRole('button', { name: 'Loading navigation.docx', exact: true })
  await expect(document()).toHaveCount(1)
  await document().click()
  await loading()
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  await expect(document()).toBeVisible({ timeout: 3000 })
  expect(await frame.evaluate(() => globalThis.officeLoadSignal.aborted)).toBe(true)
  await frame.evaluate(() => globalThis.releaseOfficeLoad())
  await expect(document()).toHaveCount(1)
  await document().click()
  await loading()
  await frame.evaluate(() => globalThis.releaseOfficeLoad())
  const editor = () => frame.locator('.tiptap[contenteditable=true]').first()
  await expect(editor()).toBeVisible({ timeout: 60000 })
  await editor().fill('Navigation preserves document edits')
  await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
  await expect(document()).toBeVisible()
  await document().click()
  await loading()
  await frame.evaluate(() => globalThis.releaseOfficeLoad())
  await expect(editor()).toContainText('Navigation preserves document edits', { timeout: 60000 })
  await page.screenshot({ path: info.outputPath('02-restored-document.png') })
})
