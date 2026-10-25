import { repository as repo } from './paths.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { genofficeResolver } from '../build-genoffice.mjs'
const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/@playwright/test/index.mjs')))
const out = path.join(root, 'artifacts/sheets-browser')
await fs.mkdir(out, { recursive: true })
await build({ entryPoints: [path.join(root, 'src/sheets-editor.ts'), path.join(root, 'src/worker.ts'), path.join(root, 'src/engine.ts'), path.join(root, 'src/sheets-engine.ts')], outdir: out, entryNames: '[name]', bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', jsx: 'automatic', plugins: [genofficeResolver()], inject: [path.join(root, 'src/shims/buffer.ts')], alias: { 'node:crypto': path.join(root, 'src/shims/crypto.ts'), 'node:fs/promises': path.join(root, 'src/shims/fs.ts'), 'node:fs': path.join(root, 'src/shims/fs.ts'), 'node:path': path.join(root, 'src/shims/path.ts') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })
await fs.rename(path.join(out, 'worker.js'), path.join(out, 'engine-worker.js'))
const {openWorkbook}=await import(pathToFileURL(path.join(out,'engine.js')))
const {saveSheetChanges}=await import(pathToFileURL(path.join(out,'sheets-engine.js')))
const empty=await fs.readFile(path.join(root,'fixtures/empty.xlsx'))
const sheetName=(await openWorkbook(empty)).sheets[0].name
const initial=await saveSheetChanges(empty,{edits:[],structuralOps:[],filterStates:[],pageSetupStates:[],noteStates:[{sheetName,notes:[{row:2,column:3,author:'保留作者',text:'原始批注'}]}]})
await fs.writeFile(path.join(out,'blank.xlsx'),initial.bytes)
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/sheets-editor.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><div id="app"></div><script type="module">
import {mountSheets} from '/sheets-editor.js';
window.dirtyEvents=[];
window.editor = await mountSheets({context:{signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}},container:document.querySelector('#app'),bytes:new Uint8Array(await (await fetch('/blank.xlsx')).arrayBuffer()),name:'验收.xlsx',onDirty:value=>{window.dirty=value;window.dirtyEvents.push(value)}});
window.ready=true;
</script></body></html>`
const server = http.createServer(async (req, res) => {
 try { const url = new URL(req.url, 'http://localhost'); if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return} if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(html);return} const file = path.join(out,url.pathname); const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(bytes) } catch {res.statusCode=404;res.end()}
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH})
const page = await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
page.on('console',m=>{if(m.type()==='error') errors.push(m.text())})
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.waitForFunction(()=>window.ready,{timeout:60000})
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(c=>c.width>100&&c.height>100&&c.getContext('2d')?.getImageData(0,0,100,100).data.some((v,i)=>i%4===3&&v>0)))
 await page.screenshot({path:path.join(out,'initial.png')})
 const nameBox=page.locator('input.univer-appearance-none')
 await nameBox.fill('A1')
 await nameBox.press('Enter')
 await page.keyboard.type('Office round trip')
 await page.keyboard.press('Enter')
 await page.waitForFunction(()=>window.dirty===true)
 await nameBox.fill('A1')
 await nameBox.press('Enter')
 await page.keyboard.press('Control+b')
 const data=await page.evaluate(async()=>{const bytes=await window.editor.save();window.savedBytes=bytes;return [...bytes]})
 await fs.writeFile(path.join(out,'ui-saved.xlsx'),new Uint8Array(data))
 const model=await openWorkbook(new Uint8Array(data))
 assert.equal(model.sheets[0].cells.A1.value,'Office round trip')
 assert.equal(model.sheets[0].cells.A1.style.bold,true)
 await nameBox.fill('B1');await nameBox.press('Enter');await page.keyboard.type('unsaved later');await page.keyboard.press('Enter')
 await page.evaluate(()=>window.editor.markSaved(window.savedBytes))
 assert.equal(await page.evaluate(()=>window.dirty),true)
 const second=await page.evaluate(async()=>{const bytes=await window.editor.save();window.editor.markSaved(bytes);return [...bytes]})
 assert.equal((await openWorkbook(new Uint8Array(second))).sheets[0].cells.B1.value,'unsaved later')
 assert.equal(await page.evaluate(()=>window.dirty),false)
 await page.screenshot({path:path.join(out,'edited.png')})
 await page.mouse.click(22,169,{button:'right'})
 await page.getByText('在上方插入',{exact:false}).click({position:{x:28,y:15}})
 await page.keyboard.press('Enter')
 const shifted=await page.evaluate(async()=>[...await window.editor.save()])
 assert.equal((await openWorkbook(new Uint8Array(shifted))).sheets[0].cells.A2?.value,'Office round trip')
 await page.keyboard.press('Escape')
 await page.keyboard.press('Control+z')
 const undone=await page.evaluate(async()=>[...await window.editor.save()])
 assert.equal((await openWorkbook(new Uint8Array(undone))).sheets[0].cells.A1.value,'Office round trip')
 await page.mouse.click(35,982)
 const added=await page.evaluate(async()=>[...await window.editor.save()])
 assert.equal((await openWorkbook(new Uint8Array(added))).sheets.length,2)
 await page.getByText('空白',{exact:true}).click()
 await page.mouse.click(22,169,{button:'right'})
 await page.getByText('在上方插入',{exact:false}).click({position:{x:28,y:15}})
 await page.keyboard.press('Enter');await page.keyboard.press('Escape')
 await nameBox.fill('A1');await nameBox.press('Enter')
 await page.keyboard.press('Escape')
 await page.mouse.click(100,169,{button:'right'})
 await page.getByText('添加批注',{exact:true}).click()
 await page.locator('[data-u-comp=note-textarea]').fill('真实批注\n第二行')
 const noted=await page.evaluate(async()=>[...await window.editor.save()])
 const notes=(await openWorkbook(new Uint8Array(noted))).sheets[0].notes
 assert.equal(notes.find(note=>note.row===0&&note.column===0).text,'真实批注\n第二行')
 assert.deepEqual(notes.find(note=>note.row===3&&note.column===3),{row:3,column:3,author:'保留作者',text:'原始批注'})
 await page.evaluate(()=>window.editor.dispose())
 await page.waitForTimeout(400)
 console.log('Sheets browser edit/format/save/dirty concurrency passed')
 if (errors.length) console.error(errors)
 assert.equal(errors.length,0)
} finally {await browser.close();server.close()}
