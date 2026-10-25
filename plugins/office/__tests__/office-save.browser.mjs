import { repository as repo } from './paths.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import JSZip from 'jszip'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { genofficeResolver } from '../build-genoffice.mjs'
const root = path.resolve(import.meta.dirname, '..')

const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/@playwright/test/index.mjs')))
const out = path.join(root, 'artifacts/office-save-browser')
await fs.mkdir(out, { recursive: true })
const editors = { name: 'editor-boundary', setup(api) { api.onResolve({ filter: /^\.\/(?:docx|slides|pdf)-editor$/ }, args => ({ path: args.path + '.js', external: true })) } }
await build({ entryPoints: ['src/office-controller.ts', 'src/office-library.ts', 'src/worker.ts', 'src/engine.ts'], absWorkingDir: root, outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', jsx: 'automatic', plugins: [editors, genofficeResolver()], inject: ['src/shims/buffer.ts'], alias: { 'node:crypto': path.join(root, 'src/shims/crypto.ts'), 'node:fs/promises': path.join(root, 'src/shims/fs.ts'), 'node:fs': path.join(root, 'src/shims/fs.ts'), 'node:path': path.join(root, 'src/shims/path.ts') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })
await fs.rename(path.join(out, 'worker.js'), path.join(out, 'engine-worker.js'))
await fs.copyFile(path.join(root, 'fixtures/empty.xlsx'), path.join(out, 'blank.xlsx'))
await fs.copyFile(path.join(root, 'src/office.css'), path.join(out, 'office.css'))
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/office.css"><link rel="stylesheet" href="/office-controller.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module">
import {startOffice} from '/office-controller.js'; import {OfficeLibraryService} from '/office-library.js';
window.store={schema:1,documents:[]};const files=new Map();window.creates=0;window.failSave=false;window.holdSave=false;
const makeFile=async ({name,data,mimeType})=>{window.creates++;const captured=new Uint8Array(data).slice();if(window.failSave)throw new Error('测试存储空间不足');if(window.holdSave){window.holdSave=false;await new Promise(resolve=>{window.releaseSave=resolve;window.gateEntered=true})}const id=crypto.randomUUID();const file={kind:'local-file',id,name,size:captured.byteLength,mimeType};files.set(id,{file,bytes:captured});return file};
const service=new OfficeLibraryService({get:async()=>structuredClone(window.store),set:async v=>{window.store=structuredClone(v)},files:async()=>[...files.values()].map(v=>v.file),release:async f=>{files.delete(f.id)},publish:async()=>{}});
const isDocx=location.search.includes('docx');const bytes=isDocx?await (await import('/docx-editor.js')).createBlankDocx():new Uint8Array(await (await fetch('/blank.xlsx')).arrayBuffer());const first=await makeFile({name:isDocx?'保存竞态.docx':'保存竞态.xlsx',data:bytes,mimeType:isDocx?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const doc=await service.execute('add',{resourceId:first.id});window.initialBytes=[...bytes];
window.latestBytes=()=>[...files.get(window.store.documents[0].versions[0].file.id).bytes];window.sourceBytes=()=>[...files.get(first.id).bytes];
const context={signal:new AbortController().signal,state:{documentId:doc.id},environment:{colorScheme:'light'},setState:async()=>{},setDocumentInfo:async info=>{window.documentInfo=info},onBeforeClose:handler=>{window.closeGuard=handler;return{dispose(){}}},onMessage:()=>({dispose(){}}),onEnvironmentChange:()=>({dispose(){}}),workers:{create:async url=>new Worker(url,{type:'module'})},commands:{execute:async(_,args)=>{try{return{ok:true,value:await service.execute(args.action,args)}}catch(e){return{ok:false,error:e.message}}}},resources:{createFile:makeFile,release:async f=>files.delete(f.id),getUrl:async f=>URL.createObjectURL(new Blob([files.get(f.id).bytes])),saveFile:async()=>false}};
await startOffice(context,document.querySelector('#app'));window.ready=true;
</script></body></html>`
const server = http.createServer(async (req,res) => { try { const url=new URL(req.url,'http://localhost'); if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return} if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}const file=path.join(out,url.pathname);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file).catch(()=>fs.readFile(path.join(root,'dist',url.pathname))))}catch{res.statusCode=404;res.end()} })
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const {openWorkbook}=await import(pathToFileURL(path.join(out,'engine.js')))
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const address=page.locator('input.univer-appearance-none');await address.waitFor();await page.waitForFunction(()=>document.querySelector('input.univer-appearance-none')?.value==='A1')
 const typeCell=async(ref,text,commit=true)=>{await address.fill(ref);await address.press('Enter');await page.keyboard.type(text);if(commit)await page.keyboard.press('Enter')}
 await typeCell('A1','first snapshot')
 await page.evaluate(()=>{window.holdSave=true;window.gateEntered=false})
 await page.locator('.office-document-bar').getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.gateEntered)
 await typeCell('B1','latest while saving',false)
 await page.keyboard.press('Control+s');await page.keyboard.press('Control+s')
 assert.equal(await page.evaluate(()=>window.creates),2)
 await page.evaluate(()=>window.releaseSave())
 await page.evaluate(()=>{window.closeResult=undefined;window.closeGuard(new AbortController().signal).then(value=>window.closeResult=value)})
 await page.waitForFunction(()=>window.closeResult===true)
 const saved=await openWorkbook(new Uint8Array(await page.evaluate(()=>window.latestBytes())))
 assert.equal(saved.sheets[0].cells.A1.value,'first snapshot');assert.equal(saved.sheets[0].cells.B1.value,'latest while saving')
 assert.deepEqual(await page.evaluate(()=>window.sourceBytes()),await page.evaluate(()=>window.initialBytes))
 assert.equal(await page.locator('.office-save-state').getAttribute('data-dirty'),'false')
 await typeCell('C1','unsaved on disk failure',false)
 await page.evaluate(()=>{window.failSave=true;window.closeResult=undefined;window.closeGuard(new AbortController().signal).then(value=>window.closeResult=value)})
 await page.getByRole('button',{name:'继续编辑',exact:true}).click();await page.waitForFunction(()=>window.closeResult===false)
 assert.equal(await page.locator('.office-save-state').getAttribute('data-dirty'),'true')
 await page.evaluate(()=>{window.closeResult=undefined;window.closeGuard(new AbortController().signal).then(value=>window.closeResult=value)})
 await page.getByRole('button',{name:'导出后离开',exact:true}).click();await page.waitForFunction(()=>window.closeResult===false)
 assert.equal(await page.locator('.office-save-state').getAttribute('data-dirty'),'true')
 await page.evaluate(()=>{window.failSave=false;window.closeResult=undefined;window.closeGuard(new AbortController().signal).then(value=>window.closeResult=value)})
 await page.waitForFunction(()=>window.closeResult===true)
 assert.equal((await openWorkbook(new Uint8Array(await page.evaluate(()=>window.latestBytes())))).sheets[0].cells.C1.value,'unsaved on disk failure')
 await page.screenshot({path:path.join(out,'saved-concurrency.png')})
 assert.deepEqual(errors,[])
 console.log('Office Sheets save single-flight, concurrent edits, failure close cancellation and failed export passed')
 await page.goto(`http://127.0.0.1:${server.address().port}/?kind=docx`);await page.waitForFunction(()=>window.ready)
 const docEditor=page.locator('.tiptap[contenteditable=true]').first();await docEditor.waitFor()
 await docEditor.fill('文档第一次保存')
 await page.evaluate(()=>{window.holdSave=true;window.gateEntered=false})
 await page.locator('.office-document-bar').getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.gateEntered)
 await page.waitForTimeout(2200)
 await page.evaluate(()=>window.releaseSave())
 await page.waitForFunction(()=>document.querySelector('.office-save-state')?.dataset.dirty==='false',undefined,{timeout:10000}).catch(async error=>{console.error(await page.evaluate(()=>({creates:window.creates,revision:window.store.documents[0].revision,state:document.querySelector('.office-save-state')?.textContent,body:document.body.innerText.slice(-1800)})));throw error})
 await docEditor.fill('文档保存中编辑前的内容')
 await page.evaluate(()=>{window.holdSave=true;window.gateEntered=false})
 await page.locator('.office-document-bar').getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.gateEntered)
 await docEditor.fill('文档保存中继续编辑的最新内容')
 await page.keyboard.press('Control+s');await page.keyboard.press('Control+s')
 await page.evaluate(()=>window.releaseSave())
 await page.evaluate(()=>{window.closeResult=undefined;window.closeGuard(new AbortController().signal).then(value=>window.closeResult=value)})
 await page.waitForFunction(()=>window.closeResult===true)
 const docx=await JSZip.loadAsync(new Uint8Array(await page.evaluate(()=>window.latestBytes())))
 assert.match(await docx.file('word/document.xml').async('text'),/文档保存中继续编辑的最新内容/)
 assert.equal(await page.locator('.office-save-state').getAttribute('data-dirty'),'false')
 await page.screenshot({path:path.join(out,'docs-save-concurrency.png')})
 assert.deepEqual(errors,[])
 console.log('Office Docs delayed persistence and concurrent editing passed')
} finally {await browser.close();server.close()}
