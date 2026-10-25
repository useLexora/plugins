import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { univerClipboardPatch } from '../build-univer-clipboard.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
let output, server, browser, base
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), 'office-clipboard-'))
  await build({
    absWorkingDir: root, stdin: { resolveDir: root, sourcefile: 'clipboard-fixture.ts', contents: `
      import { IUniverInstanceService, LocaleType, UniverInstanceType } from '@univerjs/core';
      import { IClipboardInterfaceService } from '@univerjs/ui';
      import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
      import zh from '@univerjs/preset-sheets-core/locales/zh-CN';
      import '@univerjs/preset-sheets-core/lib/index.css';
      import { createUniver } from './src/create-univer';
      import { createSheetsClipboard } from './src/sheets-clipboard';
      window.content = {}; window.failures = []; window.writes = 0; window.reads = 0;
      window.controller = new AbortController(); window.revision = 0;
      const service = createSheetsClipboard({
        read: async () => { window.reads++; if (window.denyRead) throw new Error('读取剪贴板未获授权'); return window.content; },
        write: async content => { window.writes++; if (window.denyWrite) throw new Error('写入剪贴板未获授权'); if (window.deferWrite) await new Promise(resolve => window.finishWrite = resolve); window.content = content; },
      }, window.controller.signal, () => { const rev = window.revision; return () => { if (rev !== window.revision) throw new Error('编辑位置已改变'); }; }, error => window.failures.push(error.message));
      window.runtime = createUniver({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: zh }, override: [[IClipboardInterfaceService, { useValue: service }]], presets: [UniverSheetsCorePreset({ container: document.querySelector('#app'), disableAutoFocus: true })] });
      window.api = window.runtime.univerAPI;
      window.book = window.api.createWorkbook({ id: 'clipboard-test', name: '剪贴板', appVersion: '0.25.1', locale: LocaleType.ZH_CN, styles: {}, sheetOrder: ['sheet-1'], sheets: { 'sheet-1': { id: 'sheet-1', name: '工作表', rowCount: 30, columnCount: 12, cellData: { 0: { 0: { v: '保留中文', t: 1, s: { bl: 1, bg: { rgb: '#ffcc00' } } }, 1: { v: 3, t: 2 }, 2: { f: '=B1+1', v: 4 } } } } } });
      window.value = address => window.book.getActiveSheet().getRange(address).getValue();
      window.editingText = () => window.runtime.univer.__getInjector().get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)?.getBody()?.dataStream;
      window.ready = window.runtime.univer.__getInjector().get(IClipboardInterfaceService) === service;
    ` }, outfile: path.join(output, 'fixture.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', jsx: 'automatic', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [univerClipboardPatch()], logLevel: 'error',
  })
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'); return }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    if (!['/fixture.js', '/fixture.css'].includes(url.pathname)) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css')
    response.end(await fs.readFile(path.join(output, url.pathname)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); if (output) await fs.rm(output, { recursive: true, force: true }) })

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { get: () => undefined }) })
  await page.goto(base)
  await page.waitForFunction(() => window.ready)
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 100 && canvas.height > 100 && canvas.getContext('2d')?.getImageData(0, 0, 100, 100).data.some((value, index) => index % 4 === 3 && value > 0)))
  const select = async range => { const box = page.locator('input.univer-appearance-none'); await box.fill(range); await box.press('Enter'); await page.waitForFunction(() => document.activeElement?.getAttribute('contenteditable') === 'true') }
  return { page, select, errors }
}

test('菜单复制粘贴保留 HTML 标记、样式和公式，不使用浏览器 Clipboard API', async () => {
  const { page, select, errors } = await fixture()
  try {
    await select('A1:C1')
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.copy')), true)
    const content = await page.evaluate(() => window.content)
    assert.match(content.html, /data-copy-id=/)
    assert.match(content.html, /保留中文/)
    assert.match(content.text, /保留中文/)
    await select('A3')
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.paste', { value: 'default-paste' })), true)
    assert.equal(await page.evaluate(() => window.value('A3')), '保留中文')
    const cells = await page.evaluate(() => { const snapshot = window.book.save(); return Object.fromEntries(Object.entries(snapshot.sheets['sheet-1'].cellData[2]).map(([key, cell]) => [key, { ...cell, s: typeof cell.s === 'string' ? snapshot.styles[cell.s] : cell.s }])) })
    assert.equal(cells[0].s.bl, 1)
    assert.equal(await page.evaluate(() => window.book.getActiveSheet().getRange('C3').getFormula()), '=B3+1')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('空剪贴板和拒绝读取不会粘贴旧缓存，拒绝写入不会报告复制成功', async () => {
  const { page, select, errors } = await fixture()
  try {
    await select('A1')
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.copy')), true)
    await select('A3')
    await page.evaluate(() => { window.content = {} })
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.paste', { value: 'default-paste' })), false)
    assert.equal(await page.evaluate(() => window.value('A3')), null)
    await page.evaluate(() => { window.denyRead = true })
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.paste', { value: 'default-paste' })), false)
    assert.equal(await page.evaluate(() => window.value('A3')), null)
    await page.evaluate(() => { window.denyWrite = true })
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.copy')), false)
    assert.deepEqual(await page.evaluate(() => window.failures), ['剪贴板中没有可粘贴的文本或表格。', '读取剪贴板未获授权', '写入剪贴板未获授权'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('编辑单元格剪切在写入完成前保留文字，拒绝或目标改变时不删除', async () => {
  const { page, select, errors } = await fixture()
  try {
    await select('A1')
    await page.keyboard.press('F2')
    await page.keyboard.press('Control+a')
    const original = await page.evaluate(() => window.editingText())
    assert.match(original, /保留中文/)
    await page.evaluate(() => { window.denyWrite = true })
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.cut')), false)
    assert.equal(await page.evaluate(() => window.editingText()), original)
    await page.evaluate(() => { window.denyWrite = false; window.deferWrite = true; window.cutResult = undefined; window.api.executeCommand('univer.command.cut').then(result => window.cutResult = result) })
    await page.waitForFunction(() => !!window.finishWrite)
    assert.equal(await page.evaluate(() => window.editingText()), original)
    await page.evaluate(() => { window.revision++; window.finishWrite() })
    await page.waitForFunction(() => window.cutResult !== undefined)
    assert.equal(await page.evaluate(() => window.cutResult), false)
    assert.equal(await page.evaluate(() => window.editingText()), original)
    await page.evaluate(() => { window.deferWrite = false })
    assert.equal(await page.evaluate(() => window.api.executeCommand('univer.command.cut')), true)
    assert.doesNotMatch(await page.evaluate(() => window.editingText()), /保留中文/)
    assert.match(await page.evaluate(() => window.content.html), /data-copy-id=/)
    assert.match(await page.evaluate(() => window.content.html), /doc-fragment|data-doc/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('键盘 paste 事件使用传入内容，不再主动读取宿主剪贴板', async () => {
  const { page, select, errors } = await fixture()
  try {
    await select('A3')
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', '外部中文\t42')
      data.setData('text/html', '<table><tr><td>外部中文</td><td>42</td></tr></table>')
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForFunction(() => window.value('A3') === '外部中文')
    assert.equal(await page.evaluate(() => window.value('B3')), 42)
    assert.equal(await page.evaluate(() => window.reads), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
