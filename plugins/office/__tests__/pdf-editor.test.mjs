import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import { buildPdf } from '../build-pdf.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
const output = path.join(root, 'artifacts/pdf-build')

test('PDF edits serialize without persisting, save failure retains edits, and acknowledged revisions preserve later edits', { timeout: 120000 }, async () => {
  await buildPdf(output)
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;width:100%}#editor{height:100vh;width:100vw}</style></head><body><div id="editor"></div></body></html>')
      return
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = path.resolve(output, `.${url.pathname}`)
    if (!file.startsWith(`${output}/`)) { response.writeHead(403).end(); return }
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
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()) })
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async () => {
      const module = await import('/pdf-editor.js')
      window.pdfModule = module
      const secondary = await module.createBlankPdf()
      window.pdfSecondary = new Uint8Array(secondary.length + 150000).fill(32)
      window.pdfSecondary.set(secondary)
      window.pdfReads = []
      window.pdfPersisted = []
      window.preferences = {}
      window.pdfContext = {
        signal: new AbortController().signal,
        workers: { create: async (url, options) => new Worker(url, options) },
        environment: { colorScheme: 'light' },
        onEnvironmentChange: () => ({ dispose() {} }),
        resources: {
          saveFile: async () => true,
          pickFiles: async () => [{ id: 'secondary', name: '导入.pdf', size: window.pdfSecondary.length }],
          readBytes: async (file, { offset, length }) => {
            if (file.id !== 'secondary' || length > 128 * 1024 || length < 1) throw new Error('EXTENSION_INVALID_ARGUMENT')
            window.pdfReads.push({ offset, length })
            const data = window.pdfSecondary.slice(offset, offset + length)
            return { data, size: window.pdfSecondary.length, eof: offset + data.length === window.pdfSecondary.length }
          },
        },
        commands: { execute: async (_command, request) => {
          if (request.action === 'preferences.set') window.preferences[request.key] = request.value
          return { ok: true, value: window.preferences[request.key] ?? null }
        } },
      }
      window.officeEditor = await module.mountPdfEditor({
        context: window.pdfContext, container: document.getElementById('editor'), bytes: await module.createBlankPdf(), name: '验收.pdf',
        onDirty: dirty => { window.pdfDirty = dirty },
        onSaveRequest: async () => {
          const bytes = await window.officeEditor.save()
          if (window.failPdfSave) throw new Error('模拟保存失败')
          window.pdfPersisted.push([...bytes])
          window.officeEditor.markSaved(bytes)
        },
      })
    })
    await page.locator('.pdf-page canvas').first().waitFor({ timeout: 15000 })
    await page.screenshot({ path: path.join(output, 'initial.png') })
    await page.getByRole('button', { name: '页面', exact: true }).click()
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    await page.waitForFunction(() => window.pdfDirty === true)
    const rotated = await page.evaluate(async () => {
      window.pdfSnapshot = await window.officeEditor.save()
      return [...window.pdfSnapshot]
    })
    assert.equal((await PDFDocument.load(new Uint8Array(rotated))).getPage(0).getRotation().angle, 90)
    assert.equal(await page.evaluate(() => window.pdfPersisted.length), 0)
    assert.equal(await page.evaluate(() => window.pdfDirty), true)
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    await page.evaluate(() => window.officeEditor.markSaved(window.pdfSnapshot))
    assert.equal(await page.evaluate(() => window.pdfDirty), true)
    await page.evaluate(() => { window.failPdfSave = true })
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => document.body.innerText.includes('模拟保存失败'))
    assert.equal(await page.evaluate(() => window.pdfDirty), true)
    await page.evaluate(() => { window.failPdfSave = false })
    const final = await page.evaluate(async () => {
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      return [...bytes]
    })
    assert.equal((await PDFDocument.load(new Uint8Array(final))).getPage(0).getRotation().angle, 180)
    await page.waitForFunction(() => window.pdfDirty === false)
    const fontChecks = await page.evaluate(async () => ({ latin: await window.pdfApi.canDrawText('Office'), chinese: await window.pdfApi.canDrawText('办公文档'), fonts: await window.pdfApi.listEditFonts() }))
    assert.equal(fontChecks.latin, true)
    assert.equal(fontChecks.chinese, true)
    assert.ok(fontChecks.fonts.includes('arial'))
    await page.locator('.pdf-toast-notice button').click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('button', { name: '插入文字', exact: true }).click({ timeout: 3000 })
    await page.locator('.pdf-modal textarea').fill('Office 办公文档')
    await page.locator('.pdf-modal').getByRole('button', { name: '确定', exact: true }).click()
    await page.locator('.pdf-page').first().click({ position: { x: 150, y: 180 } })
    await page.waitForFunction(() => window.pdfDirty === true)
    const textBytes = await page.evaluate(async () => {
      const bytes = await window.officeEditor.save()
      window.officeEditor.markSaved(bytes)
      return [...bytes]
    })
    await fs.writeFile(path.join(output, 'text.pdf'), new Uint8Array(textBytes))
    assert.match(execFileSync('pdftotext', [path.join(output, 'text.pdf'), '-'], { encoding: 'utf8' }), /Office 办公文档/)
    assert.deepEqual(await page.evaluate(async () => window.pdfApi.listPageImages(await window.pdfApi.consumePending())), [])
    await page.getByRole('button', { name: '页面', exact: true }).click()
    await page.getByRole('button', { name: '插入空白页', exact: true }).click()
    const withPage = await page.evaluate(async () => [...await window.officeEditor.save()])
    assert.equal((await PDFDocument.load(new Uint8Array(withPage))).getPageCount(), 2)
    await page.getByRole('button', { name: '导入页面', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.pdf-thumb').length === 3)
    const reads = await page.evaluate(() => window.pdfReads)
    assert.ok(reads.length >= 3)
    assert.ok(reads.every((item, index) => item.length <= 128 * 1024 && item.offset === index * 64 * 1024))
    await page.screenshot({ path: path.join(output, 'edited.png') })
    await fs.writeFile(path.join(output, 'saved.pdf'), new Uint8Array(final))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})
