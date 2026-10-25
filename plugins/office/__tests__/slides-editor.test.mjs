import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import JSZip from 'jszip'
import { pathToFileURL } from 'node:url'
const root = path.resolve(import.meta.dirname, '..')
const buildDir = path.resolve(root, process.env.SLIDES_BUILD_DIR ?? 'dist')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
async function launch() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><style>html,body{margin:0;height:100%;width:100%}#editor{height:100vh;width:100vw}</style></head><body><div id="editor"></div></body></html>'); return }
    const file = path.resolve(buildDir, `.${url.pathname}`)
    if (!file.startsWith(`${buildDir}${path.sep}`)) { response.writeHead(403).end(); return }
    try { response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); response.end(await fs.readFile(file)) }
    catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }) }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  return { page, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) } }
}
test('GenOffice Slides edits rich slides and preserves PPTX through save and reopen', { timeout: 120000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    await page.evaluate(async () => {
      const module = await import('/slides-editor.js')
      window.slidesModule = module
      window.slidesContext = {
        signal: new AbortController().signal,
        workers: { create: async url => {
          const source = `Object.defineProperty(crypto, 'randomUUID', { value: undefined });
            const queued = [];
            const buffer = event => { event.stopImmediatePropagation(); queued.push(event.data) };
            self.addEventListener('message', buffer);
            import(${JSON.stringify(url.href)}).then(() => {
              self.removeEventListener('message', buffer);
              for (const data of queued) self.dispatchEvent(new MessageEvent('message', { data }));
            });`
          const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
          const worker = new Worker(blob)
          const terminate = worker.terminate.bind(worker)
          worker.terminate = () => { terminate(); URL.revokeObjectURL(blob) }
          return worker
        } },
        environment: { colorScheme: 'light' },
        onEnvironmentChange: () => ({ dispose() {} }),
        resources: { saveFile: async () => true },
      }
      window.editorOptions = {
        context: window.slidesContext, container: document.getElementById('editor'),
        bytes: await module.createBlankPptx(), name: '演示验收.pptx', onDirty: value => { window.slidesDirty = value },
      }
      window.officeEditor = await module.mountSlidesEditor(window.editorOptions)
    })
    await page.locator('.konvajs-content canvas').first().waitFor()
    await fs.mkdir(path.join(root, 'artifacts/slides-editor'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'artifacts/slides-editor/editor.png') })
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.getByRole('button', { name: '插入', exact: true }).click()
    await page.getByRole('button', { name: '文本框', exact: true }).click()
    await page.locator('.stage-rel').click({ position: { x: 160, y: 100 } })
    const textEditor = page.locator('[contenteditable="true"]').first()
    await textEditor.waitFor({ timeout: 10000 })
    await textEditor.fill('季度办公计划：保留中文和样式')
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.getByRole('button', { name: '插入', exact: true }).click()
    await page.getByRole('button', { name: '表格', exact: true }).click()
    await page.locator('.rb-table-cell').nth(11).click()
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.getByRole('button', { name: '插入', exact: true }).click()
    await page.getByRole('button', { name: '图表', exact: true }).click()
    await page.locator('.rb-menu button').first().click()
    await page.getByRole('button', { name: '图表设计', exact: true }).waitFor()
    await page.waitForFunction(() => window.slidesDirty === true)
    await page.screenshot({ path: path.join(root, 'artifacts/slides-editor/edited.png') })
    const saved = await page.evaluate(async () => { const bytes = await window.officeEditor.save(); await window.officeEditor.markSaved(bytes); return Array.from(bytes) })
    const zip = await JSZip.loadAsync(Uint8Array.from(saved))
    const xml = await zip.file('ppt/slides/slide1.xml').async('string')
    assert.match(xml, /季度办公计划/)
    assert.match(xml, /<a:tbl>/)
    assert.match(xml, /<c:chart/)
    assert.match(xml, /a16:creationId[^>]+id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/)
    assert.equal(await page.evaluate(() => window.slidesDirty), false)
    await page.evaluate(async bytes => { window.officeEditor.dispose(); window.officeEditor = await window.slidesModule.mountSlidesEditor({ ...window.editorOptions, bytes: Uint8Array.from(bytes) }); }, saved)
    const roundtrip = await page.evaluate(async () => Array.from(await window.officeEditor.save()))
    const reopened = await JSZip.loadAsync(Uint8Array.from(roundtrip))
    assert.match(await reopened.file('ppt/slides/slide1.xml').async('string'), /季度办公计划/)
    await page.evaluate(async () => {
      await window.slidesApi.setNotes({ slideIndex: 0, text: '第一版备注' })
      const prior = await window.officeEditor.save()
      await window.slidesApi.setNotes({ slideIndex: 0, text: '保存期间新增的备注' })
      await window.officeEditor.markSaved(prior)
    })
    assert.equal(await page.evaluate(() => window.slidesDirty), true, 'older snapshot cannot clear newer edits')
    const failed = await page.evaluate(() => window.slidesApi.save())
    assert.equal(failed.ok, false, 'missing persistence callback fails explicitly')
    assert.equal(await page.evaluate(() => window.slidesDirty), true, 'failed persistence retains dirty state')
    await page.evaluate(async () => { const bytes = await window.officeEditor.save(); await window.officeEditor.markSaved(bytes) })
    assert.equal(await page.evaluate(() => window.slidesDirty), false)
    await page.evaluate(async () => {
      const reads = []
      window.slidesApi.isDirty = () => new Promise((_, reject) => reads.push(reject))
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      if (!reads.length) throw new Error('saved event did not request dirty state')
      window.officeEditor.dispose()
      for (const reject of reads) reject(new Error('演示文稿已关闭。'))
    })
    await assert.rejects(page.evaluate(async () => {
      await window.slidesModule.mountSlidesEditor({ ...window.editorOptions, bytes: new TextEncoder().encode('invalid presentation') })
    }), /zip|ZIP|central|archive|pptx/i)
    assert.deepEqual(run.errors.filter(error => !error.includes('favicon')), [])
  } catch (error) { console.log(run.errors); await run.page.screenshot({ path: path.join(root, 'artifacts/slides-editor/failed.png') }); throw error } finally { await run.close() }
})
