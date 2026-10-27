import { repository, pluginPackage } from './paths.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import JSZip from 'jszip'

const project = path.resolve(import.meta.dirname, '..')

const { test, expect } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/electron.mjs')).href)
const { withArtifactPreview } = await import(pathToFileURL(path.join(repository, '.playwright/scripts/fixtures/artifact-preview.mjs')).href)
const manifest = JSON.parse(await fs.readFile(path.join(project, 'dist/extension.json'), 'utf8'))
const archive = pluginPackage(manifest.version)
const filename = '同名报告.docx'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function install(app, page) {
  await expect(page.locator('.desktop-app-sidebar')).toBeVisible()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible()))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible()).setContentSize(1600, 1050))
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  await review.getByTestId('extension-file-associations').getByRole('checkbox', { name: '.docx · 独立打开 · Lexora Office', exact: true }).check()
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id && item.enabled), manifest.id)).toBe(true)
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
}

async function visibleEditor(page, expected) {
  let frame
  await expect.poll(async () => {
    for (const item of page.frames()) {
      if (item.url().startsWith('lexora-extension:') && await item.locator('.tiptap[contenteditable="true"]').first().isVisible().catch(() => false)) {
        frame = item
        return true
      }
    }
    return false
  }, { timeout: 45000 }).toBe(true)
  await expect(frame.locator('.tiptap[contenteditable="true"]').first()).toContainText(expected)
  return frame
}

async function closeEditor(page, frame) {
  const tab = page.locator('.desktop-task-context-panel__tab').filter({ has: page.getByRole('tab', { selected: true }) })
  await tab.locator('.desktop-task-context-panel__tab-close').click()
  await expect.poll(() => page.frames().includes(frame)).toBe(false)
}

test('任务产物直接编辑本地原件，两份同名文件保持独立且打开不入库', async ({ buddy }, testInfo) => {
  const blankModule = testInfo.outputPath('blank-docx.mjs')
  await build({ entryPoints: [path.join(project, 'vendor/genoffice/packages/docx-engine/src/blank.ts')], outfile: blankModule, bundle: true, platform: 'node', format: 'esm' })
  const { buildBlankDocx } = await import(pathToFileURL(blankModule).href)
  const blank = await buildBlankDocx()
  const originalHashes = []
  await withArtifactPreview(buddy, {
    label: 'office-source-opening',
    async prepare(directory) {
      const names = ['first', 'second'].map(folder => `${folder}/${filename}`)
      for (let index = 0; index < names.length; index++) {
        const zip = await JSZip.loadAsync(blank)
        const xml = await zip.file('word/document.xml').async('string')
        zip.file('word/document.xml', xml.replace('<w:p/>', `<w:p><w:r><w:t>来源${index + 1}的原始内容</w:t></w:r></w:p>`))
        const bytes = await zip.generateAsync({ type: 'nodebuffer' })
        const destination = path.join(directory, names[index])
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, bytes)
        originalHashes.push(digest(bytes))
      }
      return names
    },
  }, async ({ app, page, outputs, directory }) => {
    const errors = []
    app.context().on('weberror', event => errors.push(String(event.error())))
    await install(app, page)
    const artifacts = await page.evaluate(async () => {
      const runs = await window.lexoraDesktop.localChat.runs.list({ limit: 10 })
      const timeline = await window.lexoraDesktop.localChat.conversations.listTimeline({ conversationId: runs[0].conversationId, limit: 100 })
      return timeline.outputs.flatMap(output => output.artifacts)
    })
    const sources = ['first', 'second'].map(folder => artifacts.find(item => item.path.endsWith(`${folder}/${filename}`)))
    expect(sources.every(Boolean), JSON.stringify(artifacts)).toBe(true)
    const prepare = artifactId => page.evaluate(({ providerId, artifactId }) => window.lexoraDesktop.extensions.prepareFileOpening({ providerId, location: 'standalone', source: { kind: 'artifact', artifactId } }), { providerId: manifest.contributes.fileHandlers[0].id, artifactId })
    const firstGrant = await prepare(sources[0].artifactId)
    const secondGrant = await prepare(sources[0].artifactId)
    const otherGrant = await prepare(sources[1].artifactId)
    expect(firstGrant.resource.id).not.toBe(secondGrant.resource.id)
    expect(firstGrant.resource.sourceId).toMatch(/^[a-f0-9]{64}$/)
    expect(firstGrant.resource.sourceId).toBe(secondGrant.resource.sourceId)
    expect(firstGrant.resource.sourceId).not.toBe(otherGrant.resource.sourceId)

    for (const [index, text] of ['来源1的原始内容', '来源2的原始内容'].entries()) {
      await outputs.nth(index).getByRole('button', { name: filename, exact: true }).click()
      const frame = await visibleEditor(page, text)
      await expect(frame.getByRole('dialog')).toHaveCount(0)
      const destination = path.join(directory, ['first', 'second'][index], filename)
      await frame.locator('.tiptap[contenteditable="true"]').first().fill(`原件已编辑${index + 1}`)
      await expect(frame.locator('.office-save-state')).toHaveText('未保存')
      expect(digest(await fs.readFile(destination))).toBe(originalHashes[index])
      await frame.locator('.office-document-bar').getByRole('button', { name: '保存', exact: true }).click()
      await expect(frame.locator('.office-save-state')).toHaveText('已保存')
      const zip = await JSZip.loadAsync(await fs.readFile(destination))
      expect(await zip.file('word/document.xml').async('text')).toContain(`原件已编辑${index + 1}`)
      await closeEditor(page, frame)
    }
    for (const [index, folder] of ['first', 'second'].entries()) {
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(directory, folder, filename)))
      expect(await zip.file('word/document.xml').async('text')).toContain(`原件已编辑${index + 1}`)
    }
    await outputs.nth(0).getByRole('button', { name: filename, exact: true }).click()
    const frame = await visibleEditor(page, '原件已编辑1')
    await expect(frame.locator('.tiptap[contenteditable="true"]').first()).not.toContainText('原件已编辑2')
    await page.screenshot({ path: testInfo.outputPath('artifact-original-edit.png') })
    await frame.getByRole('button', { name: 'Office 首页', exact: true }).click()
    await expect(frame.getByRole('heading', { name: '从一份文件开始', exact: true })).toBeVisible()
    await closeEditor(page, frame)
    expect(errors).toEqual([])
  })
})
