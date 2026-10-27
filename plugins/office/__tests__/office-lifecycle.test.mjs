import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { PDFDocument } from 'pdf-lib'
import { buildPdf } from '../build-pdf.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium, expect } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
const out = path.join(root, 'artifacts/office-lifecycle')

async function harness({ empty = false, rejectMount = false } = {}) {
  await fs.mkdir(out, { recursive: true })
  await buildPdf(path.join(root, 'artifacts/pdf-build'))
  await build({
    absWorkingDir: root, entryPoints: {
      controller: 'src/office-controller.ts', library: 'src/office-library.ts',
      guard: path.join(repository, 'apps/buddy/electron/main/extensions/runtime/ExtensionCloseGuard.ts'),
    }, outdir: out, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
    plugins: [{ name: 'test-editor-boundary', setup(api) {
      api.onResolve({ filter: /^\.\/(docx|sheets|slides|pdf)-editor$/ }, args => ({ path: `${args.path}.js`, external: true }))
    } }],
  })
  const blank = await PDFDocument.create()
  blank.addPage([595, 842])
  const initial = await blank.save()
  const wrapper = `export {createBlankPdf} from '/pdf-real.js'; import {mountPdfEditor as realMount} from '/pdf-real.js'; export async function mountPdfEditor(options) { window.mountAttempts = (window.mountAttempts ?? 0) + 1; ${rejectMount ? "throw new Error('编辑器加载失败')" : 'const editor = await realMount(options); window.mountReady = true; await window.mountGate; return editor'} }`
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/view.css"><style>html,body,#app{width:100%;height:100%;margin:0}</style></head><body><div id="app" class="office-app"></div></body></html>'); return }
    if (url.pathname === '/fixture.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(initial); return }
    if (url.pathname === '/pdf-editor.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(wrapper); return }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = ['controller.js', 'library.js', 'guard.js'].includes(url.pathname.slice(1))
      ? path.join(out, url.pathname)
      : url.pathname === '/view.css' ? path.join(root, 'src/office.css') : path.join(root, 'artifacts/pdf-build', url.pathname === '/pdf-real.js' ? 'pdf-editor.js' : url.pathname)
    try { response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); response.end(await fs.readFile(file)) }
    catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  async function open() {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async empty => {
      const [{ startOffice }, { OfficeLibraryService }, { ExtensionCloseGuard }] = await Promise.all([import('/controller.js'), import('/library.js'), import('/guard.js')])
      window.mountGate = new Promise(resolve => { window.finishMount = resolve })
      window.viewAbort = new AbortController()
      window.closeReplies = []
      window.closeGuard = new ExtensionCloseGuard((id, allowed) => window.closeReplies.push({ id, allowed }))
      window.saveCount = 0; window.openedCount = 0
      const file = { id: 'initial', name: '生命周期.pdf', size: 1000, mimeType: 'application/pdf' }
      let library = { schema: 1, documents: [{ id: 'document', name: file.name, kind: 'pdf', revision: 1, createdAt: 1, updatedAt: 1, openedAt: 1, favorite: false, trashedAt: null, versions: [{ id: 'version', file, createdAt: 1, label: '创建' }] }] }
      if (empty) library.documents = []
      window.librarySnapshot = () => structuredClone(library)
      window.addCount = 0
      const files = [file]
      const service = new OfficeLibraryService({ get: async () => structuredClone(library), set: async value => { library = structuredClone(value) }, files: async () => files, release: async () => {}, publish: async () => {} })
      const context = {
        signal: window.viewAbort.signal, state: empty ? {} : { documentId: 'document' }, resource: null,
        environment: { colorScheme: 'light' }, onEnvironmentChange: () => ({ dispose() {} }),
        onBeforeClose: handler => window.closeGuard.register(handler),
        references: { onReveal: handler => { window.revealOfficeReference = handler; return { dispose() {} } } },
        onMessage: () => ({ dispose() {} }), setState: async () => {}, setDocumentInfo: async info => { window.documentInfo = info },
        workers: { create: async (url, options) => new Worker(url, options) },
        documents: { list: async () => [] },
        resources: {
          getUrl: async () => '/fixture.pdf', saveFile: async () => true, release: async () => {},
          createFile: async input => { window.lastSavedBytes = [...input.data]; const file = { id: crypto.randomUUID(), name: input.name, size: input.data.length, mimeType: input.mimeType }; files.push(file); return file },
        },
        commands: { execute: async (_command, input) => {
          if (_command.endsWith('.editor-bridge')) return { ok: true }
          try { const value = await service.execute(input.action, input); if (input.action === 'add') window.addCount++; if (input.action === 'save') window.saveCount++; if (input.action === 'opened') window.openedCount++; return { ok: true, value } }
          catch (error) { return { ok: false, error: error.message } }
        } },
      }
      window.starting = startOffice(context, document.getElementById('app'))
      window.starting.catch(error => { window.openError = error.message })
    }, empty)
    if (empty) { await expect(page.getByRole('heading', { name: '从一份文件开始', exact: true })).toBeVisible() }
    else await page.waitForFunction(() => window.mountReady === true, null, { timeout: 10000 })
  }
  return { page, open, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) } }
}

test('关闭请求在真实PDF的延迟mount期间可取消，已取消请求不能迟到关闭或丢失修改', { timeout: 90000 }, async () => {
  const run = await harness()
  try {
    await run.open()
    const { page } = run
    await page.getByRole('button', { name: '页面', exact: true }).click()
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.office-save-state')?.dataset.dirty === 'true')
    await page.evaluate(() => { void window.closeGuard.request('pending-close') })
    await page.waitForTimeout(50)
    assert.deepEqual(await page.evaluate(() => window.closeReplies), [])
    assert.equal(await page.evaluate(() => window.saveCount), 0)
    await page.evaluate(() => window.closeGuard.cancel('pending-close'))
    assert.deepEqual(await page.evaluate(() => window.closeReplies), [{ id: 'pending-close', allowed: false }])
    await page.evaluate(() => { void window.closeGuard.request('resumed-close'); window.finishMount() })
    await page.waitForFunction(() => document.querySelector('.office-save-state')?.textContent === '已保存')
    assert.equal(await page.evaluate(() => window.saveCount), 1)
    const savedBytes = new Uint8Array(await page.evaluate(() => window.lastSavedBytes))
    assert.equal((await PDFDocument.load(savedBytes)).getPage(0).getRotation().angle, 90)
    assert.deepEqual(await page.evaluate(() => window.closeReplies), [{ id: 'pending-close', allowed: false }, { id: 'resumed-close', allowed: true }])
    assert.equal(await page.locator('.pdf-page').count(), 1)
    await page.evaluate(() => { void window.closeGuard.request('ready-close') })
    await page.waitForFunction(() => window.closeReplies.length === 3)
    assert.deepEqual(await page.evaluate(() => window.closeReplies[2]), { id: 'ready-close', allowed: true })
    assert.deepEqual(run.errors, [])
  } finally { await run.close() }
})

test('视图销毁后的迟到mount释放编辑器，不登记打开记录或保存内容', { timeout: 90000 }, async () => {
  const run = await harness()
  try {
    await run.open()
    await run.page.evaluate(() => { window.viewAbort.abort(); window.finishMount() })
    await run.page.evaluate(() => window.starting)
    assert.equal(await run.page.locator('.pdf-page').count(), 0)
    assert.equal(await run.page.evaluate(() => window.saveCount), 0)
    assert.equal(await run.page.evaluate(() => window.openedCount), 0)
    assert.equal(await run.page.evaluate(() => window.openError), undefined)
    assert.deepEqual(run.errors, [])
  } finally { await run.close() }
})


test('创建已落库但编辑器挂载失败时返回列表，重试打开不重复创建', { timeout: 90000 }, async () => {
  const run = await harness({ empty: true, rejectMount: true })
  try {
    await run.open()
    const { page } = run
    await page.getByRole('button', { name: '新建PDF', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建PDF', exact: true })
    await dialog.getByLabel('文件名称', { exact: true }).fill('创建后打开失败')
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('文件已创建，但暂时无法打开：编辑器加载失败 请从文档库重新打开。', { exact: true })).toBeVisible()
    const row = page.locator('[data-document-id]')
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('button', { name: '创建后打开失败.pdf', exact: true })).toBeVisible()
    const initial = await page.evaluate(() => window.librarySnapshot())
    assert.equal(initial.documents.length, 1)
    assert.equal(initial.documents[0].versions.length, 1)
    assert.equal((await PDFDocument.load(new Uint8Array(await page.evaluate(() => window.lastSavedBytes)))).getPageCount(), 1)
    await row.getByRole('button', { name: '打开', exact: true }).click()
    await page.waitForFunction(() => window.mountAttempts === 2)
    await expect(row.getByRole('button', { name: '打开', exact: true })).toBeEnabled()
    await expect(row).toHaveCount(1)
    assert.deepEqual(await page.evaluate(() => window.librarySnapshot()), initial)
    assert.equal(await page.evaluate(() => window.addCount), 1)
    assert.equal(await page.evaluate(() => window.openedCount), 0)
    assert.equal(await page.evaluate(() => window.saveCount), 0)
    assert.deepEqual(run.errors, [])
  } finally { await run.close() }
})
