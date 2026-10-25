import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { genofficeResolver } from '../build-genoffice.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
let output, server, browser, base
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), 'office-theme-loading-'))
  await build({
    absWorkingDir: root, entryPoints: ['src/view.ts', 'src/library-page.ts'], outdir: output,
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', minify: true, jsx: 'automatic', logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, inject: ['src/shims/buffer.ts'],
    plugins: [{ name: 'lazy-editors', setup(api) { api.onResolve({ filter: /^\.\/(?:docx|sheets|slides|pdf)-editor$/ }, args => ({ path: `${args.path}.js`, external: true })) } }, genofficeResolver()],
    alias: { 'node:crypto': path.join(root, 'src/shims/crypto.ts'), 'node:fs/promises': path.join(root, 'src/shims/fs.ts'), 'node:fs': path.join(root, 'src/shims/fs.ts'), 'node:path': path.join(root, 'src/shims/path.ts') },
  })
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html style="color-scheme:light;--lexora-background:#fafaf8;--lexora-text:#414844;--lexora-muted:#666e69;--lexora-accent-solid:#506b90;--lexora-subtle:#2025220a;--lexora-border:#2025221a;--lexora-danger:#b94747"><head></head><body><div id="app"></div></body></html>')
      return
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = path.resolve(output, `.${url.pathname}`)
    if (!file.startsWith(`${output}${path.sep}`)) { response.writeHead(403).end(); return }
    try { response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(await fs.readFile(file)) }
    catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); if (output) await fs.rm(output, { recursive: true, force: true }) })

async function createPage(entry = 'view') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  await page.evaluate(async entry => {
    const module = await import(`/${entry}.js`)
    window.officeAbort = new AbortController()
    window.officeListCalls = 0
    window.officeRenderState = 'idle'
    window.startOfficeTest = () => {
      window.officeRenderState = 'pending'
      window.officeRender = module.render({
      signal: window.officeAbort.signal, state: null, environment: { colorScheme: 'light' },
      setState: async () => {}, onBeforeClose: () => ({ dispose() {} }), onMessage: () => ({ dispose() {} }),
      references: { onReveal: handler => { window.officeReveal = handler; return { dispose() { window.officeReveal = undefined } } } },
      commands: { execute: async () => { window.officeListCalls++; await window.officeListGate; return { ok: true, value: { schema: 1, documents: [] } } } },
      resources: { createFile: async () => {} },
      }, document.querySelector('#app')).then(() => { window.officeRenderState = 'ready' })
      return window.officeRender
    }
  }, entry)
  return { page, errors }
}

async function holdStyles(page) {
  let release, requested
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { requested = resolve })
  await page.route('**/view.css', async route => { requested(); await gate; await route.continue().catch(() => {}) })
  return { release, started }
}

test('Office waits for delayed CSS before deriving Ant Design theme colors', async () => {
  const { page, errors } = await createPage()
  const styles = await holdStyles(page)
  try {
    await page.evaluate(() => { void window.startOfficeTest() })
    await styles.started
    assert.equal(await page.getByRole('status').textContent(), '正在打开 Office…')
    assert.equal(await page.evaluate(() => window.officeListCalls), 0)
    assert.equal(await page.locator('.ant-btn').count(), 0)
    assert.equal(await page.evaluate(() => window.officeRenderState), 'pending')
    assert.equal(await page.evaluate(() => typeof window.officeReveal), 'undefined')
    styles.release()
    await page.evaluate(() => window.officeRender)
    assert.equal(await page.evaluate(() => typeof window.officeReveal), 'function')
    await page.getByRole('textbox', { name: '搜索文件', exact: true }).waitFor()
    await page.getByRole('button', { name: '新建文档', exact: true }).click()
    await page.getByRole('button', { name: '创建', exact: true }).waitFor()
    const colors = await page.evaluate(() => {
      const button = document.querySelector('.ant-modal-footer .ant-btn-primary')
      const input = document.querySelector('.office-search input')
      return { accent: getComputedStyle(button).backgroundColor, placeholder: getComputedStyle(input, '::placeholder').color, placeholderText: input.placeholder }
    })
    assert.equal(colors.accent, 'rgb(80, 107, 144)')
    assert.equal(colors.placeholder, 'rgba(0, 0, 0, 0.25)')
    assert.ok(colors.placeholderText)
    await page.evaluate(() => window.officeAbort.abort())
    assert.equal(await page.locator('[data-office]').count(), 0)
    assert.equal(await page.locator('link[href$="view.css"]').count(), 0)
    assert.deepEqual(errors, [])
  } finally { styles.release(); await page.close() }
})

test('Office reports CSS load failure without starting the library', async () => {
  const { page, errors } = await createPage()
  try {
    await page.route('**/view.css', route => route.fulfill({ status: 500, contentType: 'text/css', body: '' }))
    await page.evaluate(() => { void window.startOfficeTest() })
    const alert = page.getByRole('alert')
    await alert.waitFor()
    assert.match(await alert.textContent(), /Office 样式加载失败/)
    assert.equal(await page.evaluate(() => window.officeListCalls), 0)
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.officeAbort.abort())
    assert.equal(await page.locator('[data-office]').count(), 0)
    assert.equal(await page.locator('link[href$="view.css"]').count(), 0)
  } finally { await page.close() }
})

test('Office aborts pending CSS loading and never mounts after disposal', async () => {
  const { page, errors } = await createPage()
  const styles = await holdStyles(page)
  try {
    await page.evaluate(() => { void window.startOfficeTest() })
    await styles.started
    await page.evaluate(() => window.officeAbort.abort())
    await page.evaluate(() => window.officeRender)
    assert.equal(await page.evaluate(() => window.officeRenderState), 'ready')
    styles.release()
    await page.unrouteAll({ behavior: 'wait' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => window.officeListCalls), 0)
    assert.equal(await page.locator('[data-office]').count(), 0)
    assert.equal(await page.locator('link[href$="view.css"]').count(), 0)
    await page.evaluate(() => { void window.startOfficeTest() })
    assert.equal(await page.locator('[data-office]').count(), 0)
    assert.deepEqual(errors, [])
  } finally { styles.release(); await page.close() }
})

for (const entry of ['view', 'library-page']) {
  test(`${entry} render registers reference reveal before reporting ready without awaiting library I/O`, async () => {
    const { page, errors } = await createPage(entry)
    try {
      await page.evaluate(() => {
        window.officeListGate = new Promise(resolve => { window.releaseOfficeList = resolve })
        void window.startOfficeTest()
      })
      await page.waitForFunction(() => window.officeRenderState === 'ready')
      assert.equal(await page.evaluate(() => window.officeListCalls), 1)
      assert.equal(await page.evaluate(() => typeof window.officeReveal), 'function')
      await page.evaluate(() => window.releaseOfficeList())
      await page.getByRole('textbox', { name: '搜索文件', exact: true }).waitFor()
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.officeAbort.abort())
    } finally { await page.close() }
  })
}
