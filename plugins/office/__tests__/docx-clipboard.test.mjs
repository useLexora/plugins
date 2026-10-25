import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const root = path.resolve(import.meta.dirname, '..')
const buildDir = path.resolve(root, process.env.DOCX_BUILD_DIR ?? 'dist')

const { chromium, expect } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
let browser, server, base

before(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;width:100%}#editor{height:100vh;width:100vw}</style></head><body><div id="editor"></div></body></html>')
      return
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = path.resolve(buildDir, url.pathname.replace(/^\/dist\//, ''))
    if (!url.pathname.startsWith('/dist/') || !file.startsWith(`${buildDir}${path.sep}`)) { response.writeHead(403).end(); return }
    try {
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      response.end(await fs.readFile(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(async () => {
    try {
      assert.deepEqual(errors, [], 'clipboard failures must not escape as unhandled page errors')
      assert.equal(await page.evaluate(() => window.browserClipboardAccess), 0, 'menu actions must use the host bridge')
    } finally { await page.close() }
  })
  await page.addInitScript(() => {
    window.browserClipboardAccess = 0
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get() { window.browserClipboardAccess++; throw new Error('Browser clipboard unavailable in the extension view') } })
  })
  await page.goto(base)
  await page.evaluate(async () => {
    const module = await import('/dist/docx-editor.js')
    window.clipboardControl = { payload: {}, mode: 'value', writes: [], reads: 0 }
    window.docxContext = {
      signal: new AbortController().signal,
      workers: { create: async (url, options) => new Worker(url, options) },
      environment: { colorScheme: 'light' },
      onEnvironmentChange: () => ({ dispose() {} }),
      clipboard: {
        read: async () => {
          window.clipboardControl.reads++
          if (window.clipboardControl.mode === 'deny') throw new Error('EXTENSION_CLIPBOARD_READ_DENIED')
          const payload = structuredClone(window.clipboardControl.payload)
          if (window.clipboardControl.mode === 'delay') await new Promise(resolve => { window.releaseClipboardRead = resolve })
          return payload
        },
        write: async data => {
          if (window.clipboardControl.mode === 'deny') throw new Error('EXTENSION_CLIPBOARD_WRITE_DENIED')
          window.clipboardControl.writes.push(structuredClone(data))
        },
      },
      resources: { saveFile: async () => true },
    }
    window.officeEditor = await module.mountDocxEditor({
      context: window.docxContext, container: document.getElementById('editor'),
      bytes: await module.createBlankDocx(), name: '剪贴板验收.docx', onDirty: dirty => { window.docxDirty = dirty },
    })
  })
  const editor = page.locator('.tiptap[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 30000 })
  await page.waitForFunction(() => window.__aidocs?.editor?.isEditable)
  return { page, editor }
}

async function clipboard(page, payload, mode = 'value') {
  await page.evaluate(({ payload, mode }) => { window.clipboardControl.payload = payload; window.clipboardControl.mode = mode }, { payload, mode })
}
async function pasteMenu(page, item = '保留源格式') {
  await page.getByTestId('ribbon-paste-menu').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}
const documentJson = page => page.evaluate(() => window.__aidocs.editor.getJSON())
const selection = page => page.evaluate(() => ({ from: window.__aidocs.editor.state.selection.from, to: window.__aidocs.editor.state.selection.to }))

test('DOCX 菜单粘贴通过宿主读取 HTML，保存后保留文字、粗斜体与颜色', { timeout: 90000 }, async t => {
  const { page, editor } = await fixture(t)
  await clipboard(page, { text: '加粗内容 斜体内容 彩色内容', html: '<p><strong>加粗内容</strong> <em>斜体内容</em> <span style="color:#c026d3">彩色内容</span></p>' })
  await editor.click()
  await pasteMenu(page)
  await expect(editor).toContainText('加粗内容')
  await expect(editor).toContainText('斜体内容')
  await expect(editor).toContainText('彩色内容')
  const bytes = await page.evaluate(async () => Array.from(await window.officeEditor.save()))
  const zip = await JSZip.loadAsync(Uint8Array.from(bytes))
  const xml = await zip.file('word/document.xml').async('string')
  assert.match(xml, /加粗内容/)
  assert.match(xml, /<w:b(?:\s|\/|>)/)
  assert.match(xml, /<w:i(?:\s|\/|>)/)
  assert.match(xml, /<w:color\b[^>]*w:val="C026D3"/i)
})

test('DOCX 菜单粘贴被拒绝时保留文档并显示可见错误', { timeout: 90000 }, async t => {
  const { page, editor } = await fixture(t)
  await editor.fill('原有内容不得被覆盖')
  const before = await documentJson(page)
  await clipboard(page, { text: '不得插入' }, 'deny')
  await pasteMenu(page)
  await expect(page.locator('.app-toast.error')).toContainText('无法读取剪贴板')
  assert.deepEqual(await documentJson(page), before)
  await expect(editor).not.toContainText('不得插入')
})

for (const change of ['selection', 'document']) {
  test(`DOCX 延迟菜单粘贴在${change === 'selection' ? '选区' : '文档版本'}变化后取消，保留后续状态`, { timeout: 90000 }, async t => {
    const { page, editor } = await fixture(t)
    await editor.fill('待粘贴原文')
    await page.evaluate(() => window.__aidocs.editor.commands.setTextSelection(1))
    const originalSelection = await selection(page)
    await clipboard(page, { text: '迟到内容不得插入' }, 'delay')
    await pasteMenu(page)
    await page.waitForFunction(() => typeof window.releaseClipboardRead === 'function')
    if (change === 'selection') {
      await page.evaluate(() => window.__aidocs.editor.commands.setTextSelection(4))
      assert.notDeepEqual(await selection(page), originalSelection)
    } else {
      await page.evaluate(() => {
        const editor = window.__aidocs.editor
        editor.view.dispatch(editor.state.tr.insertText('后续修改', editor.state.doc.content.size - 1))
      })
      assert.deepEqual(await selection(page), originalSelection, 'document-version protection must work even if the selection stays unchanged')
    }
    const expectedDocument = await documentJson(page)
    const expectedSelection = await selection(page)
    await page.evaluate(() => window.releaseClipboardRead())
    await expect(page.locator('.app-toast.error')).toContainText('文档或选区已变化')
    assert.deepEqual(await documentJson(page), expectedDocument)
    assert.deepEqual(await selection(page), expectedSelection)
    await expect(editor).not.toContainText('迟到内容不得插入')
  })
}

test('DOCX 复制链接被拒绝时显示错误，不报告成功且不修改文档', { timeout: 90000 }, async t => {
  const { page, editor } = await fixture(t)
  await clipboard(page, { text: '测试链接', html: '<p><a href="https://example.test/document">测试链接</a></p>' })
  await editor.click()
  await pasteMenu(page)
  const link = editor.locator('a[href="https://example.test/document"]')
  await expect(link).toBeVisible()
  const before = await documentJson(page)
  await clipboard(page, {}, 'deny')
  await link.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: '复制超链接', exact: true }).click()
  await expect(page.locator('.app-toast.error')).toContainText('未能复制链接')
  await expect(page.locator('.app-toast.success')).toHaveCount(0)
  assert.deepEqual(await page.evaluate(() => window.clipboardControl.writes), [])
  assert.deepEqual(await documentJson(page), before)
})

test('DOCX 选择性粘贴读取被拒绝时显示局部错误并禁止确认', { timeout: 90000 }, async t => {
  const { page, editor } = await fixture(t)
  await editor.fill('选择性粘贴保留内容')
  const before = await documentJson(page)
  await clipboard(page, { text: '不得插入' }, 'deny')
  await pasteMenu(page, '选择性粘贴…')
  const dialog = page.getByRole('dialog', { name: '选择性粘贴', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toContainText('无法读取剪贴板')
  await expect(dialog.getByRole('button', { name: '确定', exact: true })).toBeDisabled()
  assert.deepEqual(await documentJson(page), before)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  assert.deepEqual(await documentJson(page), before)
})
