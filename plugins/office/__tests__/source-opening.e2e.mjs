import { repository, pluginPackage } from './paths.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { editorAction } from './library-locators.mjs'

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

test('同一任务产物的新授权复用已编辑文档，同名不同来源保持独立', async ({ buddy }, testInfo) => {
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
  }, async ({ app, page, outputs, directory, instance }) => {
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

    await outputs.nth(0).getByRole('button', { name: filename, exact: true }).click()
    let frame = await visibleEditor(page, '来源1的原始内容')
    const stateFiles = []
    for await (const file of fs.glob(`**/extensions/data/${manifest.id}/state.json`, { cwd: instance.home })) stateFiles.push(path.join(instance.home, file))
    expect(stateFiles).toHaveLength(1)
    const library = async () => JSON.parse(await fs.readFile(stateFiles[0], 'utf8')).value
    await expect.poll(async () => (await library()).documents.length).toBe(1)
    const initial = (await library()).documents[0]
    expect(initial.sourceId).toBe(firstGrant.resource.sourceId)
    await frame.locator('.tiptap[contenteditable="true"]').first().fill('在文档库中保存的编辑，不应被源文件覆盖。')
    await expect(frame.locator('.office-save-state')).toHaveText('已保存', { timeout: 30000 })
    const saved = (await library()).documents[0]
    expect(saved.revision).toBeGreaterThan(initial.revision)
    await closeEditor(page, frame)

    for (let index = 0; index < 2; index++) {
      await outputs.nth(0).getByRole('button', { name: filename, exact: true }).click()
      frame = await visibleEditor(page, '在文档库中保存的编辑，不应被源文件覆盖。')
      const current = (await library()).documents
      expect(current).toHaveLength(1)
      expect(current[0].id).toBe(saved.id)
      expect(current[0].versions[0].id).toBe(saved.versions[0].id)
      await closeEditor(page, frame)
    }

    await outputs.nth(1).getByRole('button', { name: filename, exact: true }).click()
    frame = await visibleEditor(page, '来源2的原始内容')
    const independent = (await library()).documents
    expect(independent).toHaveLength(2)
    expect(new Set(independent.map(item => item.id)).size).toBe(2)
    expect(new Set(independent.map(item => item.sourceId)).size).toBe(2)
    expect(independent.map(item => item.name)).toEqual([filename, filename])
    await closeEditor(page, frame)
    await outputs.nth(0).getByRole('button', { name: filename, exact: true }).click()
    frame = await visibleEditor(page, '在文档库中保存的编辑，不应被源文件覆盖。')
    const exported = testInfo.outputPath('saved-library-copy.docx')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
    await editorAction(frame, '导出')
    await expect.poll(async () => (await fs.stat(exported).catch(() => null))?.size ?? 0).toBeGreaterThan(1000)
    const exportedDocx = await JSZip.loadAsync(await fs.readFile(exported))
    expect(await exportedDocx.file('word/document.xml').async('string')).toContain('在文档库中保存的编辑，不应被源文件覆盖。')
    for (const [index, folder] of ['first', 'second'].entries()) expect(digest(await fs.readFile(path.join(directory, folder, filename)))).toBe(originalHashes[index])
    await page.screenshot({ path: testInfo.outputPath('source-opening-edited-copy.png') })

    const referenceDocument = independent.find(item => item.sourceId === otherGrant.resource.sourceId)
    const originalViewUrl = frame.url()
    await frame.getByRole('button', { name: '文档库', exact: true }).click()
    await frame.locator(`tr[data-row-key="${referenceDocument.id}"]`).getByRole('button', { name: '打开', exact: true }).click()
    frame = await visibleEditor(page, '来源2的原始内容')
    expect(frame.url()).toBe(originalViewUrl)
    const body = frame.locator('.tiptap[contenteditable="true"]').first()
    await body.click()
    await body.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element.querySelector('p'))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await frame.getByLabel('文档操作', { exact: true }).getByRole('button', { name: '引用', exact: true }).click()
    const chooseTarget = page.locator('.reference-target-picker')
    await expect(chooseTarget).toBeVisible()
    await chooseTarget.getByRole('button', { name: / · Present the prepared files\.$/ }).click()
    await expect(page.getByText(/^已引用到「/)).toBeVisible()
    const persistedQuotes = () => {
      const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        return database.prepare('SELECT content_json FROM composer_drafts').all()
          .flatMap(row => JSON.parse(row.content_json).resourceQuotes ?? [])
          .filter(quote => quote.text === '来源2的原始内容')
      } finally { database.close() }
    }
    await expect.poll(() => persistedQuotes().length).toBe(1)
    const [quote] = persistedQuotes()
    expect(quote.source).toMatchObject({ kind: 'view', provider: `extension:${manifest.id}`, target: { extensionId: manifest.id, source: null } })
    expect(quote.locator.data.documentId).toBe(referenceDocument.id)
    expect(quote.locator.data.documentId).not.toBe(saved.id)
    await closeEditor(page, frame)
    await page.locator(`[data-resource-quote-id="${quote.id}"] .chat-reference-card__link`).click()
    await expect(page.locator('.resource-quote-preview:visible pre')).toHaveText('来源2的原始内容')
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    frame = await visibleEditor(page, '来源2的原始内容')
    await expect.poll(() => frame.evaluate(() => window.getSelection()?.toString())).toBe('来源2的原始内容')
    expect((await library()).documents).toHaveLength(2)
    await page.screenshot({ path: testInfo.outputPath('source-opening-reference-revealed.png') })
    await fs.writeFile(testInfo.outputPath('source-opening-proof.json'), JSON.stringify({ grants: [firstGrant.resource, secondGrant.resource, otherGrant.resource], library: await library(), originalHashes, quote }, null, 2))
    expect(errors).toEqual([])
  })
})
