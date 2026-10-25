import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { documentAction } from './library-locators.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium, expect } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
const output = path.join(root, 'artifacts/library-ui')
await fs.mkdir(output, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['src/library-view.tsx'], outfile: path.join(output, 'library.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })

async function launch() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/office.css"></head><body><div class="office-app"><div id="library" class="office-library-host"></div></div></body></html>')
      return
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = url.pathname === '/library.js' ? path.join(output, 'library.js') : url.pathname === '/office.css' ? path.join(root, 'src/office.css') : undefined
    if (!file) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css')
    response.end(await fs.readFile(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: process.env.UI_REDUCED_MOTION === 'no-preference' ? 'no-preference' : 'reduce', colorScheme: 'light' })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(async () => {
    const { mountLibrary } = await import('/library.js')
    window.focusLog = []
    for (const type of ['focusin', 'focusout', 'keydown']) document.addEventListener(type, event => window.focusLog.push({ type, key: event.key, target: event.target.tagName + '.' + event.target.className, time:performance.now() }), true)
    const makeDoc = (id, name, kind = 'docx', favorite = true, trashedAt = null) => ({
      id, name, kind, revision: 2, createdAt: 1792700000000, updatedAt: 1792700000000 + Number(id.split('-').at(-1)) * 1000,
      openedAt: 1792700000000, favorite, trashedAt,
      versions: [0, 1].map(index => ({ id: `${id}-v${index}`, file: { id: `${id}-file${index}`, name, size: 1024 + Number(id.split('-').at(-1)) * 200 }, createdAt: 1792700000000 - index * 1000, label: index ? '较早版本' : '当前版本' })),
    })
    window.documents = [
      ...Array.from({ length: 34 }, (_, i) => makeDoc(`doc-${i}`, `预算 ${String(i).padStart(2, '0')}.docx`)),
      makeDoc('slides-43', '项目提案.pptx', 'pptx'),
      makeDoc('sheet-40', '预算统计.xlsx', 'xlsx'), makeDoc('pdf-41', '合同.pdf', 'pdf', false),
      makeDoc('trash-42', '历史资料.docx', 'docx', false, 1792700000000),
    ]
    window.actionsLog = []
    const host = document.getElementById('library')
    const refresh = () => window.library.update(structuredClone(window.documents))
    const actions = {
      open: async doc => { window.openedId = doc.id; host.hidden = true },
      create: async (kind, name) => { window.actionsLog.push({ action: 'create', kind, name }); window.documents.push(makeDoc('new-50', `${name}.${kind}`, kind)); refresh() },
      import: async () => {}, export: async (doc, versionId) => { window.actionsLog.push({ action: 'export', id: doc.id, versionId }) },
      mutate: async (action, doc, extra) => {
        window.actionsLog.push({ action, id: doc.id, extra })
        if (window.failMutations?.[action]?.includes(doc.id)) throw new Error('模拟保存失败')
        if (window.failRename && action === 'rename') throw new Error('名称保存失败，请重试。')
        window.documents = window.documents.flatMap(item => {
          if (item.id !== doc.id) return [item]
          if (action === 'delete') return []
          if (action === 'duplicate') return [item, { ...item, id: `${item.id}-copy`, name: `${item.name.split('.')[0]} 副本.${item.kind}` }]
          if (action === 'rename') return [{ ...item, name: `${extra.name}.${item.kind}`, revision: item.revision + 1 }]
          if (action === 'favorite') return [{ ...item, favorite: extra.value }]
          if (action === 'trash') return [{ ...item, trashedAt: Date.now() }]
          if (action === 'restore') return [{ ...item, trashedAt: null }]
          return [item]
        })
        refresh()
      },
      run: action => { void action() },
    }
    window.library = mountLibrary(host, actions)
    refresh()
    window.refreshLibrary = refresh
    window.returnToLibrary = () => { host.hidden = false; refresh() }
  })
  await expect(page.locator('[data-document-id]')).toHaveCount(37)
  return { page, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) } }
}

async function captureFailure(run) {
  const stem = path.join(output, `failure-${Date.now()}`)
  await run.page.screenshot({ path: `${stem}.png` }).catch(() => {})
  const details = await run.page.evaluate(() => ({
    activeElement: document.activeElement?.outerHTML, focusLog: window.focusLog,
    popups: [...document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]')].map(node => ({ text: node.textContent, box: node.getBoundingClientRect().toJSON(), parent: node.parentElement.outerHTML.slice(0, 1000) })),
  })).catch(() => ({}))
  await fs.writeFile(`${stem}.json`, JSON.stringify({ errors: run.errors, ...details }, null, 2))
}

test('筛选、排序、选择和滚动在数据刷新及隐藏返回后保持连续', { timeout: 30000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    await page.getByRole('button', { name: '我的收藏', exact: true }).click()
    await page.getByRole('group', { name: '文件类型' }).getByRole('button', { name: '文档', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('预算')
    await page.getByRole('combobox', { name: '排序方式', exact: true }).click()
    await page.getByRole('combobox', { name: '排序方式', exact: true }).press('Home')
    await page.getByRole('combobox', { name: '排序方式', exact: true }).press('ArrowDown')
    await page.getByRole('combobox', { name: '排序方式', exact: true }).press('ArrowDown')
    await page.getByRole('combobox', { name: '排序方式', exact: true }).press('Enter')
    await page.getByRole('checkbox', { name: '选择 预算 00.docx', exact: true }).check()
    await expect(page.getByText('已选择 1 个文件', { exact: true })).toBeVisible()
    const scroller = page.locator('.office-table-area')
    await scroller.evaluate(node => { node.scrollTop = 450 })
    const scrollBefore = await scroller.evaluate(node => node.scrollTop)
    assert.ok(scrollBefore > 0)
    await page.evaluate(() => { window.documents = [...window.documents]; window.refreshLibrary() })
    await expect(page.getByRole('textbox', { name: '搜索文件' })).toHaveValue('预算')
    await expect(page.getByRole('checkbox', { name: '选择 预算 00.docx', exact: true })).toBeChecked()
    await page.locator('[data-document-id="doc-8"]').getByRole('button', { name: '预算 08.docx', exact: true }).click()
    await expect(page.locator('#library')).toBeHidden()
    await page.evaluate(() => window.returnToLibrary())
    await expect(page.getByRole('button', { name: '我的收藏', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('textbox', { name: '搜索文件' })).toHaveValue('预算')
    await expect(page.getByRole('group', { name: '文件类型' }).getByRole('button', { name: '文档', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('checkbox', { name: '选择 预算 00.docx', exact: true })).toBeChecked()
    await expect(page.locator('.office-sort')).toContainText('名称')
    assert.equal(await scroller.evaluate(node => node.scrollTop), scrollBefore)
    await page.screenshot({ path: path.join(output, 'library-return-state.png') })
    assert.deepEqual(run.errors, [])
  } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
})

test('重命名失败保留弹窗与输入，成功重试更新原文件', { timeout: 30000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    const row = page.locator('[data-document-id="doc-33"]')
    await documentAction(page, row, '重命名')
    const dialog = page.getByRole('dialog', { name: '重命名', exact: true })
    const input = dialog.getByLabel('文件名称', { exact: true })
    await input.fill('重命名后仍保留的预算')
    await page.evaluate(() => { window.failRename = true })
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click()
    await expect(dialog.getByText('名称保存失败，请重试。', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('重命名后仍保留的预算')
    await expect(input).toBeEnabled()
    await expect(row.getByRole('button', { name: '预算 33.docx', exact: true })).toBeVisible()
    await page.evaluate(() => { window.failRename = false })
    await input.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(row.getByRole('button', { name: '重命名后仍保留的预算.docx', exact: true })).toBeVisible()
    assert.equal(await page.locator('[data-document-id="doc-33"]').count(), 1)
    assert.deepEqual(run.errors, [])
  } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
})

test('新建卡片支持Enter打开与提交，行菜单支持键盘与Escape返回焦点', { timeout: 30000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    for (const name of ['新建文档', '新建演示文稿', '新建PDF']) {
      const card = page.getByRole('button', { name, exact: true })
      await card.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name, exact: true })
      await expect(dialog.getByLabel('文件名称', { exact: true })).toBeVisible()
      await dialog.getByLabel('文件名称', { exact: true }).focus()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(card).toBeFocused()
    }
    const create = page.getByRole('button', { name: '新建表格', exact: true })
    await create.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '新建表格', exact: true })
    await dialog.getByLabel('文件名称', { exact: true }).fill('键盘创建')
    await dialog.getByLabel('文件名称', { exact: true }).press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: '键盘创建.xlsx', exact: true })).toBeVisible()
    const more = page.locator('[data-document-id="doc-33"]').getByRole('button', { name: '更多操作', exact: true })
    await more.focus()
    await more.press('Enter')
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible()
    await expect.poll(() => page.getByRole('menu').evaluate(node => node.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeHidden()
    await expect(more).toBeFocused()
    assert.deepEqual(run.errors, [])
  } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
})

test('主题跟随宿主且窄屏操作与弹层可见、不横向溢出', { timeout: 30000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    const cards = ['新建文档', '新建表格', '新建演示文稿', '新建PDF', '导入文件']
    const more = page.locator('[data-document-id="doc-33"]').getByRole('button', { name: '更多操作', exact: true })
    await page.screenshot({ path: path.join(output, 'library-light.png') })
    for (const width of [2048, 768, 375]) {
      await page.setViewportSize({ width, height: 850 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const name of cards) {
        const card = page.getByRole('button', { name, exact: true })
        await expect(card).toBeVisible()
        await expect(card).toBeEnabled()
      }
      await page.locator('.office-table-area').evaluate(node => { node.scrollTop = 0 })
      await page.screenshot({ path: path.join(output, `library-${width}.png`) })
      if (width === 2048) continue
      await more.click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      await expect.poll(() => menu.evaluate(node => getComputedStyle(node.parentElement).opacity)).toBe('1')
      await expect.poll(() => menu.evaluate(node => node.parentElement.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0)
      const box = await menu.boundingBox()
      assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= 851)
      await page.screenshot({ path: path.join(output, `library-${width}-menu.png`) })
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator('.office-table-area').evaluate(node => { node.scrollTop = 0 })
    await page.mouse.move(4, 4)
    await page.evaluate(() => {
      const style = document.documentElement.style
      for (const [key, value] of Object.entries({ '--lexora-background': '#171c24', '--lexora-subtle': '#202731', '--lexora-text': '#e7ebf2', '--lexora-muted': '#9aa8bb', '--lexora-border': '#394455', '--lexora-accent-solid': '#73c7b0' })) style.setProperty(key, value)
    })
    await expect.poll(() => page.locator('.ant-table-thead th').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(23, 28, 36)')
    await expect.poll(() => page.locator('.office-search').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(23, 28, 36)')
    await expect.poll(() => page.locator('[data-document-id="doc-33"]').getByRole('button', { name: '打开', exact: true }).evaluate(node => getComputedStyle(node).color)).toBe('rgb(231, 235, 242)')
    await page.screenshot({ path: path.join(output, 'library-dark.png') })
    assert.deepEqual(run.errors, [])
  } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
})

for (const action of ['trash', 'delete']) {
  test(`${action === 'trash' ? '批量回收' : '批量彻底删除'}逐项继续，部分失败后重试仅处理失败文件`, { timeout: 30000 }, async () => {
    const run = await launch()
    try {
      const { page } = run
      if (action === 'delete') {
        await page.evaluate(() => {
          window.documents = window.documents.map(doc => ['doc-33', 'doc-32'].includes(doc.id) ? { ...doc, trashedAt: Date.now() } : doc)
          window.refreshLibrary()
        })
        await page.getByRole('button', { name: '回收站', exact: true }).click()
      }
      await page.getByRole('checkbox', { name: '选择 预算 33.docx', exact: true }).check()
      await page.getByRole('checkbox', { name: '选择 预算 32.docx', exact: true }).check()
      await page.evaluate(action => { window.failMutations = { [action]: ['doc-33'] } }, action)
      const label = action === 'delete' ? '彻底删除' : '移入回收站'
      await page.getByRole('button', { name: label, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `${action === 'delete' ? '彻底删除文件' : label}？`, exact: true })
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await expect(dialog.getByText(/已完成 1 个，1 个未完成/)).toBeVisible()
      await expect(dialog.getByText(/重试只处理未完成的文件/)).toBeVisible()
      await expect(page.locator('[data-document-id="doc-32"]')).toHaveCount(0)
      await expect(page.getByRole('checkbox', { name: '选择 预算 33.docx', exact: true })).toBeChecked()
      await page.evaluate(() => { window.failMutations = {} })
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(page.locator('[data-document-id="doc-33"]')).toHaveCount(0)
      const result = await page.evaluate(action => ({
        remaining: window.documents.filter(doc => ['doc-33', 'doc-32'].includes(doc.id)),
        attempts: window.actionsLog.filter(item => item.action === action).map(item => item.id),
      }), action)
      if (action === 'delete') assert.deepEqual(result.remaining, [])
      else assert.ok(result.remaining.length === 2 && result.remaining.every(doc => doc.trashedAt !== null))
      assert.equal(result.attempts.filter(id => id === 'doc-32').length, 1)
      assert.equal(result.attempts.filter(id => id === 'doc-33').length, 2)
      assert.deepEqual(run.errors, [])
    } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
  })
}

test('版本抽屉目标外部删除后关闭，Ctrl+F恢复搜索焦点', { timeout: 30000 }, async () => {
  const run = await launch()
  try {
    const { page } = run
    const row = page.locator('[data-document-id="doc-33"]')
    await row.getByRole('button', { name: '更多操作', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '版本', exact: true })).toBeVisible()
    await expect.poll(() => page.getByRole('menu').evaluate(node => getComputedStyle(node.parentElement).opacity)).toBe('1')
    await expect.poll(() => page.getByRole('menu').evaluate(node => node.parentElement.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0)
    await page.screenshot({ path: path.join(output, 'library-menu.png') })
    await page.getByRole('menuitem', { name: '版本', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '版本历史', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.office-version-row')).toHaveCount(2)
    await expect.poll(() => drawer.evaluate(node => node.closest('.ant-drawer-content-wrapper').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0)
    await expect.poll(() => drawer.evaluate(node => Math.round(node.closest('.ant-drawer-content-wrapper').getBoundingClientRect().right))).toBe(page.viewportSize().width)
    await page.screenshot({ path: path.join(output, 'library-drawer.png') })
    await page.evaluate(() => { window.documents = window.documents.filter(doc => doc.id !== 'doc-33'); window.refreshLibrary() })
    await expect(drawer).toBeHidden()
    await page.getByRole('button', { name: '全部文件', exact: true }).focus()
    await page.keyboard.press('Control+f')
    await expect(page.getByRole('textbox', { name: '搜索文件', exact: true })).toBeFocused()
    assert.deepEqual(run.errors, [])
  } catch (error) { await captureFailure(run); throw error } finally { await run.close() }
})
