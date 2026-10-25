import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import { buildPdf } from '../build-pdf.mjs'

const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
const output = path.join(root, 'artifacts/pdf-assistant-build')

test('PDF references and suite creation preserve precise targets, atomic edits, saved undo and rendered output', { timeout: 120000 }, async () => {
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
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()) })
  try {
    const fixture = await PDFDocument.create()
    const font = await fixture.embedFont(StandardFonts.Helvetica)
    const pdfPage = fixture.addPage([595, 842])
    pdfPage.drawText('Original contract', { x: 72, y: 700, size: 16, font })
    pdfPage.drawText('Original contract', { x: 72, y: 600, size: 16, font })
    for (const label of ['Second page', 'Third page']) {
      const extra = fixture.addPage([595, 842])
      extra.drawText('Original contract', { x: 72, y: 700, size: 16, font })
      extra.drawText(label, { x: 72, y: 600, size: 16, font })
    }
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async bytes => {
      const module = await import('/pdf-editor.js')
      window.pdfContext = {
        signal: new AbortController().signal,
        workers: { create: async (url, options) => (window.pdfWorker = new Worker(url, options)) },
        environment: { colorScheme: 'light' },
        onEnvironmentChange: () => ({ dispose() {} }),
        resources: { saveFile: async () => true },
        commands: { execute: async () => ({ ok: true, value: null }) },
      }
      window.officeEditor = await module.mountPdfEditor({
        context: window.pdfContext, container: document.getElementById('editor'), bytes: new Uint8Array(bytes), name: '引用验收.pdf',
        onDirty: dirty => { window.pdfDirty = dirty },
        onReference: reference => { window.quoted = reference },
      })
    }, [...await fixture.save()])
    await page.locator('.textLayer span').filter({ hasText: 'Original contract' }).nth(1).waitFor()
    await page.locator('.textLayer span').filter({ hasText: 'Original contract' }).nth(1).evaluate(span => {
      const range = document.createRange()
      range.selectNodeContents(span)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('button', { name: '引用到任务', exact: true }).click()
    await page.waitForFunction(() => !!window.quoted)
    assert.equal(await page.locator('.ai-ask-pop').count(), 0)
    const first = await page.evaluate(async () => {
      const assistant = window.officeEditor.assistant
      const read = await assistant.read(window.quoted)
      window.reference = read.reference
      return read
    })
    assert.ok(first.operations.includes('replace_text'))
    assert.equal(first.reference.text, 'Original contract')
    const cancelled = await page.evaluate(async () => {
      const controller = new AbortController()
      controller.abort()
      try { await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: window.reference, input: { text: 'Cancelled' } }, { signal: controller.signal, assertCurrent() {} }); return false }
      catch { return true }
    })
    assert.equal(cancelled, true)
    await page.evaluate(async () => {
      const validate = window.pdfApi.validateTextEdits
      window.originalValidate = validate
      window.pdfApi.validateTextEdits = async request => {
        window.validationStarted = true
        await new Promise(resolve => { window.finishValidation = resolve })
        return validate(request)
      }
      window.pendingEdit = window.officeEditor.assistant.execute({ operation: 'replace_text', reference: window.reference, input: { text: 'Rejected contract' } }).then(() => 'accepted', error => error.message)
    })
    await page.waitForFunction(() => window.validationStarted)
    await page.getByRole('button', { name: '页面', exact: true }).click()
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    await page.evaluate(() => window.finishValidation())
    assert.match(await page.evaluate(() => window.pendingEdit), /变化/)
    await page.evaluate(async () => {
      await window.officeEditor.assistant.execute({ operation: 'undo' })
      const read = await window.officeEditor.assistant.read(window.quoted)
      window.reference = read.reference
      window.pdfApi.validateTextEdits = window.originalValidate
      await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: window.reference, input: { text: 'Revised contract' } })
    })
    const pending = await page.evaluate(async () => window.officeEditor.assistant.read(undefined, {operation:'read_pages',input:{start:1,end:1}}))
    assert.match(pending.text, /Revised contract/)
    assert.ok(!pending.operations.includes('replace_text'))
    await page.evaluate(async () => {
      const result = await window.officeEditor.assistant.execute({ operation: 'undo' })
      if (!result.mutated) throw new Error('Undo did not report mutation')
      const read = await window.officeEditor.assistant.read(window.quoted)
      window.reference = read.reference
      await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: window.reference, input: { text: 'Revised contract' } })
    })
    const saved = await page.evaluate(async () => {
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      return [...bytes]
    })
    const file = path.join(output, 'reference-edited.pdf')
    await fs.writeFile(file, new Uint8Array(saved))
    const text = execFileSync('pdftotext', ['-f', '1', '-l', '1', file, '-'], { encoding: 'utf8' })
    assert.ok(text.indexOf('Original contract') < text.indexOf('Revised contract'))
    assert.equal(text.match(/Original contract/g)?.length, 1)
    assert.equal(text.match(/Revised contract/g)?.length, 1)
    assert.doesNotMatch(text, /Rejected contract|Cancelled/)
    assert.equal(await page.evaluate(() => window.pdfDirty), false)
    const cancelledRestore = await page.evaluate(async () => {
      const controller = new AbortController()
      const worker = window.pdfWorker
      const original = worker.postMessage
      let interrupted = false
      worker.postMessage = function (request, ...args) {
        if (request?.action === 'GetDocRequest') { interrupted = true; controller.abort() }
        return original.call(this, request, ...args)
      }
      try {
        await window.officeEditor.assistant.execute({ operation: 'undo' }, { signal: controller.signal, assertCurrent() {} })
        return { interrupted, rejected: false }
      } catch { return { interrupted, rejected: true } }
      finally { worker.postMessage = original }
    })
    assert.deepEqual(cancelledRestore, { interrupted: true, rejected: true })
    assert.equal(await page.evaluate(() => window.pdfDirty), false)
    const undone = await page.evaluate(async () => {
      const result = await window.officeEditor.assistant.execute({ operation: 'undo' })
      if (!result.mutated || !window.pdfDirty) throw new Error('Saved PDF undo must mutate and mark dirty')
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      return [...bytes]
    })
    const undoneFile = path.join(output, 'reference-undone-after-save.pdf')
    await fs.writeFile(undoneFile, new Uint8Array(undone))
    const undoneText = execFileSync('pdftotext', ['-f', '1', '-l', '1', undoneFile, '-'], { encoding: 'utf8' })
    assert.equal(undoneText.match(/Original contract/g)?.length, 2)
    assert.doesNotMatch(undoneText, /Revised contract/)
    assert.equal(await page.evaluate(() => window.pdfDirty), false)
    assert.match(await page.evaluate(async () => {
      try { await window.officeEditor.assistant.execute({ operation: 'undo' }); return 'accepted' }
      catch (error) { return error.message }
    }), /没有可安全撤销/)
    await page.evaluate(async () => {
      const read = await window.officeEditor.assistant.read(window.quoted)
      await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: read.reference, input: { text: 'Revised contract' } })
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
    })
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    assert.match(await page.evaluate(async () => {
      try { await window.officeEditor.assistant.execute({ operation: 'undo' }); return 'accepted' }
      catch (error) { return error.message }
    }), /无法安全撤销/)
    const manualSaved = await page.evaluate(async () => {
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      return [...bytes]
    })
    assert.equal((await PDFDocument.load(new Uint8Array(manualSaved))).getPage(0).getRotation().angle, 90)
    assert.match(await page.evaluate(async () => {
      try { await window.officeEditor.assistant.execute({ operation: 'undo' }); return 'accepted' }
      catch (error) { return error.message }
    }), /无法安全撤销/)
    await page.evaluate(() => window.__genofficeControl({ cmd: 'goto', target: { kind: 'page', page: 2 } }))
    const secondText = page.locator('.pdf-page[data-page="1"] .textLayer span').filter({ hasText: 'Original contract' })
    await secondText.scrollIntoViewIfNeeded()
    await secondText.evaluate(span => {
      const range = document.createRange()
      range.selectNodeContents(span)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('button', { name: '引用到任务', exact: true }).click()
    await page.waitForFunction(() => window.quoted?.locator.page === 2, null, { timeout: 10000 })
    await page.evaluate(() => window.__genofficeControl({ cmd: 'goto', target: { kind: 'page', page: 1 } }))
    await page.locator('.pdf-page[data-page="0"]').scrollIntoViewIfNeeded()

    await page.getByRole('button', { name: '删除页面', exact: true }).click()
    await page.waitForFunction(() => window.pdfDirty)
    const remapped = await page.evaluate(async () => {
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      const read = await window.officeEditor.assistant.read(window.quoted)
      window.reopenedBytes = [...bytes]
      return read
    })
    assert.equal(remapped.reference.locator.page, 1)
    assert.match(remapped.text, /Second page/)
    assert.doesNotMatch(remapped.text, /Third page/)
    const reopened = await page.evaluate(async () => {
      window.officeEditor.dispose()
      const module = await import('/pdf-editor.js')
      window.officeEditor = await module.mountPdfEditor({
        context: window.pdfContext, container: document.getElementById('editor'), bytes: new Uint8Array(window.reopenedBytes), name: '引用验收.pdf',
        onDirty: dirty => { window.pdfDirty = dirty },
      })
      const read = await window.officeEditor.assistant.read(window.quoted)
      await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: read.reference, input: { text: 'Reopened contract' } })
      return [...await window.officeEditor.save()]
    })
    const reopenedFile = path.join(output, 'reference-reopened.pdf')
    await fs.writeFile(reopenedFile, new Uint8Array(reopened))
    const reopenedText = execFileSync('pdftotext', [reopenedFile, '-'], { encoding: 'utf8' })
    assert.match(reopenedText.split('\f')[0], /Reopened contract[\s\S]*Second page/)
    assert.match(reopenedText.split('\f')[1], /Original contract[\s\S]*Third page/)
    await page.evaluate(async () => {
      await window.officeEditor.markSaved()
      await window.officeEditor.assistant.execute({ operation: 'undo' })
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
    })
    await page.getByRole('button', { name: '页面', exact: true }).click()
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    const preserved = await page.evaluate(async () => {
      const read = await window.officeEditor.assistant.read(window.quoted)
      await window.officeEditor.assistant.execute({ operation: 'replace_text', reference: read.reference, input: { text: 'Pending preserved' } })
      const edited = await window.officeEditor.save()
      await window.officeEditor.markSaved(edited)
      await window.officeEditor.assistant.execute({ operation: 'undo' })
      const restored = await window.officeEditor.save()
      await window.officeEditor.markSaved(restored)
      return [...restored]
    })
    const preservedFile = path.join(output, 'reference-undo-preserved-manual.pdf')
    await fs.writeFile(preservedFile, new Uint8Array(preserved))
    assert.equal((await PDFDocument.load(new Uint8Array(preserved))).getPage(0).getRotation().angle, 90)
    const preservedText = execFileSync('pdftotext', [preservedFile, '-'], { encoding: 'utf8' })
    assert.match(preservedText.split('\f')[0], /Original contract[\s\S]*Second page/)
    assert.doesNotMatch(preservedText, /Pending preserved|Reopened contract/)
    await page.screenshot({ path: path.join(output, 'reference-edited.png') })
    assert.deepEqual(errors, [])
    await page.evaluate(async () => {
      window.officeEditor.dispose()
      const module = await import('/pdf-editor.js')
      window.officeEditor = await module.mountPdfEditor({
        context: window.pdfContext, container: document.getElementById('editor'), bytes: await module.createBlankPdf(), name: 'Office-suite.pdf',
        onDirty: dirty => { window.pdfDirty = dirty; if (dirty) window.pdfRevision = (window.pdfRevision ?? 0) + 1 },
      })
    })
    const capabilities = await page.evaluate(() => window.officeEditor.assistant.capabilities())
    assert.ok(capabilities.edit.some(tool => tool.name === 'insert_text'))
    assert.ok(capabilities.edit.some(tool => tool.name === 'apply_ops'))
    assert.ok(!capabilities.edit.some(tool => tool.name === 'create_document'))
    const created = await page.evaluate(async () => {
      const assistant = window.officeEditor.assistant
      const initial = await assistant.read()
      if (initial.data.pageCount !== 1) throw new Error('Blank PDF must have one page')
      await assistant.execute({ operation: 'insert_text', input: { page: 1, x: 72, y: 72, text: 'Office suite report', font_size: 24, font: 'arial', bold: true, color: '#174879', max_width: 450 } })
      let blocked = false
      try { await assistant.render({ page: 1 }) } catch { blocked = true }
      if (!blocked) throw new Error('Unsaved rendering should be rejected')
      const revision = window.pdfRevision
      const bytes = await window.officeEditor.save()
      await window.officeEditor.markSaved(bytes)
      if (window.pdfRevision !== revision) throw new Error('Serializing PDF advanced the content revision')
      return { bytes: [...bytes], read: await assistant.read(undefined, { operation: 'read_pages', input: { start: 1 } }) }
    })
    assert.match(created.read.text, /Office suite report/)
    const artifact = path.join(output, 'office-suite.pdf')
    await fs.writeFile(artifact, new Uint8Array(created.bytes))
    assert.match(execFileSync('pdftotext', [artifact, '-'], { encoding: 'utf8' }), /Office suite report/)
    const preview = await page.evaluate(async () => {
      const [image] = await window.officeEditor.assistant.render({ page: 1, scale: 1.5 })
      return { name: image.name, mimeType: image.mimeType, data: [...image.data] }
    })
    assert.equal(preview.mimeType, 'image/png')
    assert.deepEqual(preview.data.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10])
    await fs.writeFile(path.join(output, preview.name), new Uint8Array(preview.data))
    const suite = await page.evaluate(async () => {
      const assistant = window.officeEditor.assistant
      const save = async () => { const revision = window.pdfRevision; const bytes = await window.officeEditor.save(); await window.officeEditor.markSaved(bytes); if (window.pdfRevision !== revision) throw new Error('Saving advanced the content revision'); return bytes }
      const ops = [
        { op: 'setMetadata', metadata: { title: 'Office suite verification', author: 'Lexora' } },
        { op: 'addFormField', field: { name: 'reviewer', kind: 'text', page: 1, x: 72, y: 160, width: 240, height: 24, value: 'Review pending' } },
      ]
      const dryRun = await assistant.execute({ operation: 'apply_ops', input: { ops, dry_run: true } })
      if (dryRun.mutated || window.pdfDirty) throw new Error('Dry-run modified PDF')
      await assistant.execute({ operation: 'apply_ops', input: { ops } })
      await save()
      const form = await assistant.read(undefined, { operation: 'list_form_fields' })
      await assistant.execute({ operation: 'add_note', input: { page: 1, x: 400, y: 150, text: 'Check source figures before publishing' } })
      await save()
      const notes = await assistant.read(undefined, { operation: 'read_annotations', input: { start: 1, end: 1 } })
      await assistant.execute({ operation: 'insert_blank_page', input: { after_page: 1 } })
      await save()
      await assistant.execute({ operation: 'insert_text', input: { page: 2, x: 72, y: 72, text: 'Detailed evidence', max_width: 450, font_size: 18 } })
      await save()
      const inspect = await assistant.read()
      let atomicRejected = false
      try { await assistant.execute({ operation: 'apply_ops', input: { ops: [{ op: 'rotatePages', pages: [1], dir: 90 }, { op: 'deletePage', page: 999 }] } }) } catch { atomicRejected = true }
      if (!atomicRejected || window.pdfDirty) throw new Error('Invalid batch must apply nothing')
      await assistant.execute({ operation: 'apply_ops', input: { ops: [{ op: 'rotatePages', pages: [1], dir: 90 }] } })
      await save()
      const rotated = await assistant.read()
      await assistant.execute({ operation: 'undo' })
      const bytes = await save()
      return { form, notes, inspect, rotated, bytes: [...bytes] }
    })
    assert.match(suite.form.text, /reviewer[\s\S]*Review pending/)
    assert.match(suite.notes.text, /Check source figures/)
    assert.equal(suite.inspect.data.pageCount, 2)
    assert.equal(suite.rotated.data.pages[0].rotation, 90)
    const finished = await PDFDocument.load(new Uint8Array(suite.bytes))
    assert.equal(finished.getPageCount(), 2)
    assert.equal(finished.getPage(0).getRotation().angle, 0)
    assert.equal(finished.getTitle(), 'Office suite verification')
    assert.equal(finished.getForm().getTextField('reviewer').getText(), 'Review pending')
    await fs.writeFile(artifact, new Uint8Array(suite.bytes))
    const deliveredText = execFileSync('pdftotext', [artifact, '-'], { encoding: 'utf8' })
    assert.match(deliveredText, /Office suite report/)
    assert.match(deliveredText, /Detailed evidence/)
    await page.evaluate(async bytes => {
      window.officeEditor.dispose()
      const module = await import('/pdf-editor.js')
      window.officeEditor = await module.mountPdfEditor({
        context: window.pdfContext, container: document.getElementById('editor'), bytes: new Uint8Array(bytes), name: 'Office-suite.pdf',
        onDirty: dirty => { window.pdfDirty = dirty; if (dirty) window.pdfRevision = (window.pdfRevision ?? 0) + 1 },
      })
    }, suite.bytes)
    const reopenedSuite = await page.evaluate(async () => ({
      read: await window.officeEditor.assistant.read(undefined, { operation: 'read_pages', input: { start: 1, end: 2 } }),
      notes: await window.officeEditor.assistant.read(undefined, { operation: 'read_annotations', input: { start: 1, end: 1 } }),
    }))
    assert.match(reopenedSuite.read.text, /Office suite report[\s\S]*Detailed evidence/)
    assert.match(reopenedSuite.notes.text, /Check source figures/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})
