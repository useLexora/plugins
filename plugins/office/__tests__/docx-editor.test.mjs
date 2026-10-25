import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import JSZip from 'jszip'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const buildDir = process.env.DOCX_BUILD_DIR ?? 'dist'

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)

async function launch() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html><head><style>html,body{margin:0;height:100%;width:100%}#editor{height:100vh;width:100vw}</style></head><body><div id="editor"></div></body></html>')
      return
    }
    const file = path.resolve(root, buildDir, url.pathname.replace(/^\/dist\//, ''))
    if (!url.pathname.startsWith('/dist/') || !file.startsWith(path.resolve(root, buildDir))) { response.writeHead(403).end(); return }
    try {
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      response.end(await fs.readFile(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  return { page, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) } }
}

test('GenOffice Docs keeps text, formatting and tables across DOCX save and reopen', { timeout: 120000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    await page.evaluate(async () => {
      const module = await import('/dist/docx-editor.js')
      const controller = new AbortController()
      window.docxModule = module
      window.docxContext = {
        signal: controller.signal,
        workers: { create: async (url, options) => new Worker(url, options) },
        environment: { colorScheme: 'light' },
        onEnvironmentChange: () => ({ dispose() {} }),
        resources: { saveFile: async () => true },
      }
      window.docxSaved = []
      window.officeEditor = await module.mountDocxEditor({
        context: window.docxContext,
        container: document.getElementById('editor'),
        bytes: await module.createBlankDocx(), name: '文档验收.docx',
        onDirty: dirty => { window.docxDirty = dirty },
        onSave: async bytes => { window.docxSaved.push(Array.from(bytes)) },
      })
    })
    const editor = page.locator('.tiptap[contenteditable="true"]').first()
    await editor.waitFor({ timeout: 30000 })
    await editor.fill('季度办公计划\n保留中文、样式与表格。')
    await page.waitForFunction(() => window.docxDirty === true)
    assert.match(await editor.innerText(), /季度办公计划/)
    await editor.press('Control+a')
    await page.locator('.ribbon button[data-tip^="加粗"]').first().click()
    await editor.evaluate(el => { const selection = window.getSelection(); selection.selectAllChildren(el); selection.collapseToEnd() })
    assert.match(await editor.innerText(), /季度办公计划/)
    await page.keyboard.press('Enter')
    assert.match(await editor.innerText(), /季度办公计划/)
    await page.getByRole('button', { name: '插入', exact: true }).click()
    await page.getByRole('button', { name: '表格', exact: true }).click()
    await page.locator('.table-picker-grid .table-cell').nth(11).click()
    await page.waitForFunction(() => window.docxDirty === true)
    await page.evaluate(async () => {
      let saves = 0
      while (window.docxDirty) {
        if (++saves > 3) throw new Error('dirty acknowledgement did not settle')
        const bytes = await window.officeEditor.save()
        window.savedBytes = Array.from(bytes)
        await window.officeEditor.markSaved(bytes)
      }
      window.savePasses = saves
    })
    await page.waitForFunction(() => window.docxDirty === false)
    assert.equal(await page.evaluate(() => window.savePasses), 1, 'flush must not persist the same document twice')
    assert.ok(await page.evaluate(() => window.savedBytes.length > 1000))
    const zip = await JSZip.loadAsync(new Uint8Array(await page.evaluate(() => window.savedBytes)))
    const documentXml = await zip.file('word/document.xml').async('string')
    assert.match(documentXml, /<w:b(?:\s|\/|>)/)
    assert.match(documentXml, /<w:tbl>/)
    await page.evaluate(async () => {
      window.officeEditor.dispose()
      window.officeEditor = await window.docxModule.mountDocxEditor({ context: window.docxContext, container: document.getElementById('editor'), bytes: new Uint8Array(window.savedBytes), name: '文档验收.docx', onDirty: dirty => { window.docxDirty = dirty } })
    })
    await editor.waitFor({ timeout: 30000 })
    assert.match(await editor.innerText(), /季度办公计划/)
    assert.match(await editor.innerText(), /保留中文、样式与表格/)
    assert.equal(await page.evaluate(() => window.docxDirty), false)
    await fs.mkdir(path.join(root, 'artifacts/docx-editor'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'artifacts/docx-editor/editor.png') })
    assert.deepEqual(run.errors, [])
  } finally { await run.close() }
})

test('mail merge imports CSV/XLSX and exports complete DOCX files without changing template save state', { timeout: 120000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    await page.evaluate(async () => {
      const module = await import('/dist/docx-editor.js')
      window.mergeBytes = new TextEncoder().encode('姓名,公司\n"张三","甲,公司"\n"张三","乙公司"')
      window.mergeName = '收件人.csv'
      window.mergeExports = []
      window.mergeReadFailure = true
      const context = {
        signal: new AbortController().signal,
        workers: { create: async (url, options) => new Worker(url, options) },
        environment: { colorScheme: 'light' },
        onEnvironmentChange: () => ({ dispose() {} }),
        resources: {
          pickFiles: async () => [{ id: 'recipients', name: window.mergeName }],
          readBytes: async (_file, options = {}) => {
            if (!Number.isInteger(options.length) || options.length < 1 || options.length > 128 * 1024) throw new Error('EXTENSION_INVALID_ARGUMENT')
            if (window.mergeReadFailure) throw new Error('读取收件人失败')
            const start = options.offset ?? 0
            const end = Math.min(start + 7, window.mergeBytes.length)
            return { data: window.mergeBytes.slice(start, end), size: window.mergeBytes.length, eof: end === window.mergeBytes.length }
          },
          saveFile: async ({ name, data }) => { window.mergeExports.push({ name, bytes: Array.from(new Uint8Array(data)) }); return true },
        },
      }
      window.officeEditor = await module.mountDocxEditor({ context, container: document.getElementById('editor'), bytes: await module.createBlankDocx(), name: '邀请函.docx', onDirty: dirty => { window.mergeDirty = dirty } })
    })
    const editor = page.locator('.tiptap[contenteditable="true"]').first()
    await editor.fill('邀请函：')
    await editor.evaluate(el => { const selection = window.getSelection(); selection.selectAllChildren(el); selection.collapseToEnd() })
    await page.getByRole('button', { name: '邮件', exact: true }).click()
    await page.getByRole('button', { name: '开始邮件合并', exact: true }).click()
    const panel = page.locator('.modal-mailmerge')
    await panel.getByRole('button', { name: '选择收件人列表…', exact: true }).click()
    assert.equal(await panel.locator('.modal-error').innerText(), '读取收件人失败')
    await page.evaluate(() => { window.mergeReadFailure = false })
    await panel.getByRole('button', { name: '选择收件人列表…', exact: true }).click()
    await panel.getByRole('button', { name: '姓名', exact: true }).click()
    await panel.getByRole('button', { name: '公司', exact: true }).click()
    await panel.getByRole('button', { name: '完成并合并', exact: true }).click()
    await page.waitForFunction(() => window.mergeExports.length === 1)
    const first = await page.evaluate(() => window.mergeExports[0])
    assert.equal(first.name, '邀请函-邮件合并.zip')
    const archive = await JSZip.loadAsync(Uint8Array.from(first.bytes))
    assert.deepEqual(Object.keys(archive.files).sort(), ['张三-2.docx', '张三.docx'])
    const firstDoc = await JSZip.loadAsync(await archive.file('张三.docx').async('uint8array'))
    const firstXml = await firstDoc.file('word/document.xml').async('string')
    assert.match(firstXml, /张三/)
    assert.match(firstXml, /甲,公司/)
    const secondDoc = await JSZip.loadAsync(await archive.file('张三-2.docx').async('uint8array'))
    assert.match(await secondDoc.file('word/document.xml').async('string'), /乙公司/)
    assert.equal(await page.evaluate(() => window.mergeDirty), true)
    await panel.getByLabel('所有记录合并为一个文档').check()
    await panel.getByRole('button', { name: '完成并合并', exact: true }).click()
    await page.waitForFunction(() => window.mergeExports.length === 2)
    const second = await page.evaluate(() => window.mergeExports[1])
    assert.match(second.name, /\.docx$/)
    const combined = await JSZip.loadAsync(Uint8Array.from(second.bytes))
    const combinedXml = await combined.file('word/document.xml').async('string')
    assert.match(combinedXml, /甲,公司/)
    assert.match(combinedXml, /乙公司/)
    const template = await JSZip.loadAsync(Uint8Array.from(await page.evaluate(async () => Array.from(await window.officeEditor.save()))))
    const templateXml = await template.file('word/document.xml').async('string')
    assert.match(templateXml, /MERGEFIELD/)
    assert.doesNotMatch(templateXml, /甲,公司|乙公司/)
    const xlsx = Array.from(await fs.readFile(path.join(root, 'fixtures/business.xlsx')))
    const source = await page.evaluate(async bytes => { window.mergeBytes = Uint8Array.from(bytes); window.mergeName = '收件人.xlsx'; return window.desktop.pickMergeDataSource() }, xlsx)
    assert.equal(source.ok, true)
    assert.ok(source.source.fields.length > 0)
    assert.ok(source.source.records.length > 0)
    await fs.mkdir(path.join(root, 'artifacts/docx-editor'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'artifacts/docx-editor/mail-merge.png') })
    assert.deepEqual(run.errors, [])
  } finally { await run.close() }
})
