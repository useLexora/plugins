import { repository } from './paths.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { before, after, test } from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { genofficeResolver } from '../build-genoffice.mjs'
import { univerClipboardPatch } from '../build-univer-clipboard.mjs'
import { univerContextMenuPatch } from '../build-univer-contextmenu.mjs'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'artifacts/assistant-browser')

const { chromium } = await import(pathToFileURL(path.join(repository, 'node_modules/@playwright/test/index.mjs')).href)
let browser, server, base
before(async () => {
  await fs.mkdir(out, { recursive: true })
  const shared = {
    absWorkingDir: root, outdir: out, bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', jsx: 'automatic', logLevel: 'error',
    plugins: [genofficeResolver()], inject: ['src/shims/buffer.ts'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'process.env': '{}', 'process.platform': '"browser"' },
    alias: { 'node:crypto': path.join(root, 'src/shims/crypto.ts'), 'node:fs': path.join(root, 'src/shims/docx-fs.ts'), 'node:fs/promises': path.join(root, 'src/shims/docx-fs.ts'), 'node:stream/promises': path.join(root, 'src/shims/docx-fs.ts'), 'node:zlib': path.join(root, 'src/shims/docx-zlib.ts'), 'node:path': path.join(root, 'src/shims/slides-path.ts') },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' },
  }
  await build({ ...shared, entryPoints: { 'slides-worker': 'src/slides-worker.ts', 'sheets-editor': 'src/sheets-editor.ts', 'engine-worker': 'src/worker.ts', 'docx-editor': 'src/docx-editor.ts', 'docx-worker': 'vendor/genoffice/apps/docs/src/renderer/parse-worker.ts' }, plugins: [genofficeResolver(), univerClipboardPatch(), univerContextMenuPatch()] })
  await build({ ...shared, stdin: { resolveDir: root, sourcefile: 'assistant-fixture.ts', contents: `
    import { Editor } from '@tiptap/core';
    import { compactOfficeReference, officeTextDigest } from './src/office-assistant';
    window.officeTextDigest = officeTextDigest;
    window.compactReference = compactOfficeReference;
    import { editorExtensions } from './vendor/genoffice/apps/docs/src/renderer/editor/extensions';
    import { createDocxAssistant } from './src/docx-assistant';
    import { createSlidesAssistant } from './src/slides-assistant';
    import { createBlankPptx } from './vendor/genoffice/packages/pptx-engine/src/blank';
    window.makeDoc = content => {
      window.doc?.destroy(); document.querySelector('#app').replaceChildren();
      window.doc = new Editor({ element: document.querySelector('#app'), extensions: editorExtensions, content });
      window.assistant = createDocxAssistant(() => window.doc, '引用.docx', () => {});
    };
    window.makeSlides = async bytes => {
      const worker = new Worker('/slides-worker.js', {type:'module'}); let id=0; const pending = new Map();
      worker.onmessage = ({data}) => {const p=pending.get(data.id); if(!p)return; pending.delete(data.id); data.error?p.reject(new Error(data.error)):p.resolve(data.value)};
      const rpc=(method,...args)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});worker.postMessage({id:key,method,args})});
      window.rpc=rpc; window.worker=worker;
      const opened=await rpc('open', bytes ?? await createBlankPptx(), '引用.pptx', 1280);
      const ctx={slides:opened.slides,current:0,selectedIds:[],editingActiveRef:{current:false},editingCell:null,applyDeck:slides=>{ctx.slides=slides},setCurrent:value=>{ctx.current=value},setSelectedIds:value=>{ctx.selectedIds=value}};
      window.slideCtx=ctx;
      window.assistant=createSlidesAssistant(()=>ctx,async(method,...args)=>{
        if(method==='assistant-command'&&window.delayCommand){window.commandWaiting=true;await new Promise(resolve=>{window.releaseCommand=resolve})}
        if(method==='assistant-command'&&window.race){window.race=false;await rpc('slides:add-element',{slideIndex:0,fitWidthPx:1280,kind:'textBox',xPx:20,yPx:300,wPx:300,hPx:50,text:'并发编辑'})}
        return rpc(method,...args)
      },()=>{},'引用.pptx');
      window.addText=async text=>{const result=await rpc('slides:add-element',{slideIndex:0,fitWidthPx:1280,kind:'textBox',xPx:20,yPx:40,wPx:450,hPx:100,text});ctx.slides[0]=result.slide;return result.sourceId};
    };
    window.ready=true;
  ` }, entryNames: 'fixture' })
  await fs.copyFile(path.join(root, 'fixtures/empty.xlsx'), path.join(out, 'blank.xlsx'))
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/sheets-editor.css"><style>html,body,#app{margin:0;width:100%;height:100%}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'); return }
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return }
      const file = path.resolve(out, `.${url.pathname}`)
      if (!file.startsWith(`${out}/`)) { res.writeHead(403).end(); return }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      res.end(await fs.readFile(file))
    } catch { res.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(error.stack ?? error.message))
  t.after(async () => { await page.close(); assert.deepEqual(errors, []) })
  await page.goto(base); await page.waitForFunction(() => window.ready)
  return page
}

test('DOCX 引用不随光标移动，段内替换保持邻文和格式，可撤销且拒绝陈旧选区', async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    makeDoc('<p>保留前缀<strong>目标片段</strong>保留后缀</p><p>另一个段落</p>')
    doc.commands.setTextSelection({from:5,to:9}); const ref=await assistant.reference()
    doc.commands.setTextSelection(doc.state.doc.content.size-1)
    const read=await assistant.read(ref)
    await assistant.execute({operation:'replace_text',reference:read.reference,input:{text:'精确修改'}})
    const after=doc.getJSON(); const text=doc.getText()
    await assistant.execute({operation:'undo'})
    const undone=doc.getText()
    const old=await assistant.reference(); doc.commands.insertContentAt(1,'新增')
    let rejected=false; try {await assistant.execute({operation:'replace_text',reference:old,input:{text:'错误'}})} catch {rejected=true}
    doc.commands.setTextSelection({from:7,to:11})
    const rebound=await assistant.read({...await assistant.reference(),version:'older-session'})
    return {ref,text,after,undone,rejected,rebound:rebound.reference.version!=='older-session'}
  })
  assert.equal(result.ref.text, '目标片段')
  assert.match(result.text, /保留前缀精确修改保留后缀/)
  assert.ok(result.after.content[0].content.find(node => node.text === '精确修改').marks.some(mark => mark.type === 'bold'))
  assert.match(result.undone, /保留前缀目标片段保留后缀/)
  assert.equal(result.rejected, true); assert.equal(result.rebound, true)
})

test('PPTX 元素引用固定目标，原子修改保存真实XML；worker拒绝排队期间的旧版本', {timeout:90000}, async t => {
  const page=await fixture(t)
  const result=await page.evaluate(async()=>{
    await makeSlides(); const first=await addText('第一处原文'); const second=await addText('第二处原文')
    slideCtx.selectedIds=[first]; const ref=await assistant.reference(); slideCtx.selectedIds=[second]
    const read=await assistant.read(ref)
    await assistant.execute({operation:'replace_text',reference:read.reference,input:{text:'精准目标替换'}})
    const bytes=Array.from((await rpc('save')).bytes)
    await assistant.execute({operation:'undo'})
    const restored=(await assistant.read(ref)).text
    const fresh=(await assistant.read(ref)).reference
    window.race=true; let rejected=false
    try{await assistant.execute({operation:'replace_text',reference:fresh,input:{text:'不应写入'}})}catch{rejected=true}
    const finalBytes=Array.from((await rpc('save')).bytes)
    worker.terminate()
    return {bytes,restored,rejected,finalBytes}
  })
  const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes)); const xml=await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(xml,/精准目标替换/);assert.match(xml,/第二处原文/);assert.doesNotMatch(xml,/第一处原文/)
  assert.match(result.restored,/第一处原文/);assert.equal(result.rejected,true)
  const finalZip=await JSZip.loadAsync(Uint8Array.from(result.finalBytes));assert.doesNotMatch(await finalZip.file('ppt/slides/slide1.xml').async('string'),/不应写入/)
})

test('Sheets 引用范围固定、类型和公式保存真实XLSX，旧版本拒绝且undo恢复', {timeout:90000}, async t=>{
  const page=await fixture(t)
  await page.evaluate(async()=>{
    const {mountSheets}=await import('/sheets-editor.js');
    window.sheetEditor=await mountSheets({context:{signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}},container:document.querySelector('#app'),bytes:new Uint8Array(await(await fetch('/blank.xlsx')).arrayBuffer()),name:'引用.xlsx',onDirty:()=>{}});
    window.assistant=sheetEditor.assistant;
  })
  const nameBox=page.locator('input.univer-appearance-none')
  await nameBox.fill('A1:B2');await nameBox.press('Enter')
  await page.evaluate(async()=>{window.ref=await assistant.reference()})
  await nameBox.fill('C3');await nameBox.press('Enter')
  const result=await page.evaluate(async()=>{
    const read=await assistant.read(ref)
    await assistant.execute({operation:'set_cells',reference:read.reference,input:{values:[['=原样文本',12],[true,{formula:'=B1+1'}]]}})
    const bytes=Array.from(await sheetEditor.save()); let rejected=false
    try{await assistant.execute({operation:'set_cells',reference:read.reference,input:{values:[[0,0],[0,0]]}})}catch{rejected=true}
    await assistant.execute({operation:'undo'})
    const undo=Array.from(await sheetEditor.save());sheetEditor.dispose();return{bytes,rejected,undo}
  })
  const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes));const xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(xml,/B1\+1/);assert.match(xml,/原样文本/);assert.doesNotMatch(xml,/<c[^>]+r="C3"[^>]*>[^<]*<v>12/);assert.equal(result.rejected,true)
  const undone=await JSZip.loadAsync(Uint8Array.from(result.undo));assert.doesNotMatch(await undone.file('xl/worksheets/sheet1.xml').async('string'),/B1\+1|原样文本/)
})


test('PPTX 已取消的排队写入不会在稍后恢复时落盘', {timeout:90000}, async t=>{
  const page=await fixture(t)
  await page.evaluate(async()=>{
    await makeSlides(); const id=await addText('取消保护原文');slideCtx.selectedIds=[id];const reference=await assistant.reference();
    window.editAbort=new AbortController();window.delayCommand=true;
    window.pendingEdit=assistant.execute({operation:'replace_text',reference,input:{text:'不能落盘'}},{signal:editAbort.signal,assertCurrent(){}}).then(()=>false,()=>true);
  })
  await page.waitForFunction(()=>window.commandWaiting)
  const result=await page.evaluate(async()=>{editAbort.abort();await rpc('assistant-snapshot');releaseCommand();const rejected=await pendingEdit;const bytes=Array.from((await rpc('save')).bytes);worker.terminate();return{rejected,bytes}})
  assert.equal(result.rejected,true)
  const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes));const xml=await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(xml,/取消保护原文/);assert.doesNotMatch(xml,/不能落盘/)
})


test('DOCX 空白创作、正文/表格格式事务与失败原子性', async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    makeDoc('<p></p>')
    const initial = await assistant.read()
    await assistant.execute({operation:'insert_content',input:{afterBlockIndex:-1,html:'<h1>季度报告</h1><p>准确数据。</p><table><tr><td>项目</td><td>金额</td></tr><tr><td>收入</td><td>12</td></tr></table>'}})
    const read = await assistant.read(undefined,{operation:'read_blocks',input:{startBlockIndex:0,endBlockIndex:2}})
    const before = JSON.stringify(doc.getJSON()); let rejected=false
    try { await assistant.execute({operation:'apply_ops',input:{ops:[{op:'setFont',target:{blockIndexes:[0]},color:'#224466'},{op:'setFont',target:{blockIndexes:[1]},fontSize:-7}]}}) } catch { rejected=true }
    const unchanged = before === JSON.stringify(doc.getJSON())
    const ops=[{op:'setFont',target:{blockIndexes:[0]},color:'#224466',bold:true},{op:'setParagraphFormat',target:{blockIndexes:[1]},align:'center'}]
    const dry=await assistant.execute({operation:'apply_ops',input:{ops,dryRun:true}})
    const afterDry=JSON.stringify(doc.getJSON()) === before
    await assistant.execute({operation:'apply_ops',input:{ops}})
    const formatted=doc.getJSON(); await assistant.execute({operation:'undo'})
    const undone=JSON.stringify(doc.getJSON())===before
    return {initial, read,rejected,unchanged,dry,afterDry,formatted,undone}
  })
  assert.equal(result.initial.reference,undefined);assert.match(result.read.text,/季度报告|金额/)
  assert.equal(result.rejected,true);assert.equal(result.unchanged,true);assert.equal(result.dry.mutated,false);assert.equal(result.afterDry,true);assert.equal(result.undone,true)
  assert.match(JSON.stringify(result.formatted),/224466/)
})

test('PPTX 空白页创建文字/表格/图表，事务回滚、PNG渲染、保存重开', {timeout:90000}, async t => {
  const page=await fixture(t)
  const result=await page.evaluate(async()=>{
    await makeSlides(); const initial=await assistant.read()
    const ops=[
      {op:'addElement',target:{slide:0},kind:'textbox',offset:{x:400000,y:300000,cx:7000000,cy:800000},paragraphs:[{runs:[{text:'季度报告',bold:true,fontSize:28}]}]},
      {op:'addTable',target:{slide:0},rows:2,cols:2,offset:{x:400000,y:1500000,cx:3500000,cy:1800000}},
      {op:'addChart',target:{slide:0},kind:'bar',title:'真实收入',categories:['Q1','Q2'],series:[{name:'收入',values:[12,18]}],offset:{x:4500000,y:1500000,cx:4000000,cy:3000000}}
    ]
    const dry=await assistant.execute({operation:'apply_ops',input:{ops,dryRun:true}})
    const created=await assistant.execute({operation:'apply_ops',input:{ops}})
    const snapshot=await rpc('assistant-snapshot'); const table=snapshot.slides[0].nodes.find(node=>node.type==='table')
    await assistant.execute({operation:'apply_ops',input:{ops:[{op:'setTableCell',target:{slide:0,el:table.sourceId},row:0,col:0,paragraphs:[{runs:[{text:'客户'}]}]}]}})
    const before=await assistant.read(undefined,{operation:'read_slide',input:{slideIndex:0}});let rejected=false
    try{await assistant.execute({operation:'apply_ops',input:{ops:[{op:'addBlankSlide',target:{slide:0}},{op:'deleteElement',target:{slide:0,el:'does-not-exist'}}]}})}catch{rejected=true}
    const state=await rpc('assistant-snapshot')
    await assistant.execute({operation:'apply_ops',input:{ops:[{op:'addBlankSlide',target:{slide:0}}]}}); const twoPages=(await rpc('assistant-snapshot')).slides.length; await assistant.execute({operation:'undo'}); if(twoPages!==2)throw new Error('blank page was not inserted');
    const images=await assistant.render({slideIndexes:[0]}); const signature=Array.from(images[0].data.slice(0,8))
    const bytes=Array.from((await rpc('save')).bytes);worker.terminate();await makeSlides(new Uint8Array(bytes))
    const reopened=await assistant.read(undefined,{operation:'read_slide',input:{slideIndex:0}});worker.terminate()
    return {initial,dry,created,before,rejected,pages:state.slides.length,bytes,signature,reopened}
  })
  assert.equal(result.initial.reference,undefined);assert.equal(result.dry.mutated,false);assert.equal(result.created.mutated,true);assert.equal(result.rejected,true);assert.equal(result.pages,1)
  assert.deepEqual(result.signature,[137,80,78,71,13,10,26,10]);assert.match(result.reopened.text,/季度报告|客户/)
  const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes));const xml=await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(xml,/季度报告/);assert.match(xml,/客户/);assert.match(xml,/<a:tbl>/);assert.ok(Object.keys(zip.files).some(file=>/^ppt\/charts\/chart.*xml$/.test(file)))
})

test('XLSX 空白数据/公式/格式原子batch及结构操作保存重开', {timeout:90000}, async t=>{
  const page=await fixture(t)
  const result=await page.evaluate(async()=>{
    const {mountSheets}=await import('/sheets-editor.js')
    const options={context:{signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}},container:document.querySelector('#app'),name:'创作.xlsx',onDirty:()=>{}}
    const editor=await mountSheets({...options,bytes:new Uint8Array(await(await fetch('/blank.xlsx')).arrayBuffer())});const a=editor.assistant
    const initial=await a.read();const sheetId=JSON.parse(initial.text).sheets[0].sheetId
    const operations=[{operation:'set_cells',input:{sheetId,range:'A1:B3',values:[['项目','金额'],['收入',12],['合计',{formula:'=SUM(B2:B2)'}]]}},{operation:'format_range',input:{sheetId,range:'A1:B1',format:{bold:true,background:'#E8F0FE'}}}]
    const dry=await a.execute({operation:'batch',input:{operations,dryRun:true}})
    await a.execute({operation:'batch',input:{operations}})
    const formatted=await a.read(undefined,{operation:'read_formats',input:{sheetId,range:'A1:B1'}})
    await a.execute({operation:'undo'})
    const undo=await a.read(undefined,{operation:'read_range',input:{sheetId,range:'A1:B3'}})
    await a.execute({operation:'batch',input:{operations}})
    const before=(await a.read(undefined,{operation:'read_range',input:{sheetId,range:'A1:B3'}})).text;let rejected=false
    try{await a.execute({operation:'batch',input:{operations:[{operation:'set_cells',input:{sheetId,range:'A1',values:[['不应写入']]}},{operation:'format_range',input:{sheetId,range:'B1',format:{fontSize:-1}}}]}})}catch{rejected=true}
    const unchanged=(await a.read(undefined,{operation:'read_range',input:{sheetId,range:'A1:B3'}})).text===before
    await a.execute({operation:'freeze',input:{sheetId,rows:1,columns:0}})
    await a.execute({operation:'insert_axis',input:{sheetId,axis:'row',index:3,count:1}})
    await a.execute({operation:'resize_axis',input:{sheetId,axis:'column',index:0,count:1,pixels:180}})
    await a.execute({operation:'add_sheet',input:{name:'附录'}})
    const bytes=Array.from(await editor.save());await editor.markSaved(new Uint8Array(bytes));editor.dispose()
    const reopened=await mountSheets({...options,bytes:new Uint8Array(bytes)});const context=await reopened.assistant.read();const second=JSON.parse(context.text).sheets[0].sheetId
    const after=await reopened.assistant.read(undefined,{operation:'read_range',input:{sheetId:second,range:'A1:B3'}});reopened.dispose()
    return {initial,dry,formatted,undo,rejected,unchanged,bytes,context,after}
  })
  assert.equal(result.initial.reference,undefined);assert.equal(result.dry.mutated,false);assert.match(result.formatted.text,/E8F0FE/);assert.doesNotMatch(result.undo.text,/收入|SUM/);assert.equal(result.rejected,true);assert.equal(result.unchanged,true)
  assert.match(result.after.text,/SUM|收入/);assert.match(result.context.text,/附录/)
  const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes));const xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(xml,/SUM/);assert.match(xml,/frozen/);assert.match(await zip.file('xl/styles.xml').async('string'),/E8F0FE/)
})


test('DOCX 连续保存不伪造修改、不清空撤销历史，中文样式表格图表保真', {timeout:90000}, async t=>{
  const page=await fixture(t)
  const result=await page.evaluate(async()=>{
    const mod=await import('/docx-editor.js'); const context={signal:new AbortController().signal,workers:{create:async(url,options)=>new Worker(url,options)},environment:{colorScheme:'light'},onEnvironmentChange:()=>({dispose(){}}),resources:{saveFile:async()=>true}};
    const changes=[];let dirty=false
    const editor=await mod.mountDocxEditor({context,container:document.querySelector('#app'),bytes:await mod.createBlankDocx(),name:'连续保存.docx',onDirty:value=>{changes.push(value);dirty=value}})
    const assistant=editor.assistant
    await assistant.execute({operation:'insert_content',input:{afterBlockIndex:-1,html:'<h1>季度报告</h1><p>保留中文和格式。</p><table><tr><td>客户</td><td>金额</td></tr><tr><td>甲方</td><td>12</td></tr></table>'}})
    await assistant.execute({operation:'apply_ops',input:{ops:[{op:'setFont',target:{blockIndexes:[0]},color:'#224466',bold:true}]}})
    await assistant.execute({operation:'insert_chart',input:{afterBlockIndex:2,kind:'bar',categories:['Q1','Q2'],series:[{name:'收入',values:[12,18]}]}})
    const persist=async()=>{const bytes=await editor.save();const count=changes.filter(Boolean).length;await editor.markSaved(bytes);await new Promise(resolve=>setTimeout(resolve,50));return {bytes:Array.from(bytes),count,afterCount:changes.filter(Boolean).length,dirty}}
    const first=await persist()
    const oldReference=compactReference((await assistant.read({label:'标题',text:'季度报告',locator:{kind:'docx',from:1,to:5},version:'capture'})).reference)
    await assistant.execute({operation:'insert_content',input:{afterBlockIndex:3,html:'<p>第二次新增</p>'}})
    const second=await persist()
    const rebound=(await assistant.read(oldReference)).reference.text
    const undone=await assistant.execute({operation:'undo'});const third=await persist()
    editor.dispose()
    const reopened=await mod.mountDocxEditor({context,container:document.querySelector('#app'),bytes:new Uint8Array(third.bytes),name:'连续保存.docx',onDirty:()=>{}})
    const read=await reopened.assistant.read();const reopenedReference=(await reopened.assistant.read(oldReference)).reference.text;reopened.dispose()
    return {first,second,third,undone,read,rebound,reopenedReference}
  })
  for(const pass of [result.first,result.second,result.third]){assert.equal(pass.dirty,false);assert.equal(pass.afterCount,pass.count,'ack must not report a new edit')}
  assert.equal(result.rebound,'季度报告');assert.equal(result.reopenedReference,'季度报告')
  assert.equal(result.undone.mutated,true);assert.match(result.read.text,/季度报告|甲方/);assert.doesNotMatch(result.read.text,/第二次新增/)
  for(const [index,pass] of [result.first,result.second,result.third].entries()){
    const zip=await JSZip.loadAsync(Uint8Array.from(pass.bytes));const xml=await zip.file('word/document.xml').async('string')
    assert.match(xml,/季度报告/);assert.match(xml,/甲方/);assert.match(xml,/<w:tbl>/);assert.match(xml,/224466/)
    assert.ok(Object.keys(zip.files).some(file=>/^word\/charts\/chart.*xml$/.test(file)))
    if(index===1)assert.match(xml,/第二次新增/);else assert.doesNotMatch(xml,/第二次新增/)
  }
})


test('各格式 capabilities 有真实 schema 且符合 RPC 预算', async t=>{
  const page=await fixture(t)
  const result=await page.evaluate(async()=>{
    makeDoc('<p></p>');const docx=await assistant.capabilities();doc.destroy()
    await makeSlides();const pptx=await assistant.capabilities();worker.terminate()
    const {mountSheets}=await import('/sheets-editor.js');const editor=await mountSheets({context:{signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}},container:document.querySelector('#app'),bytes:new Uint8Array(await(await fetch('/blank.xlsx')).arrayBuffer()),name:'cap.xlsx',onDirty:()=>{}})
    const xlsx=await editor.assistant.capabilities();editor.dispose()
    return {docx,pptx,xlsx}
  })
  const sizes=Object.fromEntries(Object.entries(result).map(([format,capabilities])=>[format,Buffer.byteLength(JSON.stringify(capabilities))]))
  for(const [format,size] of Object.entries(sizes)){assert.ok(size<240000,`${format}: ${size}`);assert.ok(Object.keys(result[format].schemas).length>0)}
  assert.equal(result.pptx.limits.renderPages,4);assert.equal(result.docx.render,'none');assert.equal(result.xlsx.render,'none')
  await fs.writeFile(path.join(root,'artifacts/assistant-capabilities-sizes.json'),JSON.stringify(sizes,null,2))
})

test('DOCX 长引用独立于上下文预算，原文摘要重绑当前版本并拒绝目标变化', async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    const text = '长引用正文'.repeat(50000) + '结尾'.repeat(6072)
    makeDoc('<p>'+text+'</p><p>其它段落</p>')
    doc.commands.setTextSelection({from:1,to:text.length+1})
    const reference = await assistant.reference()
    const transported = compactReference(reference)
    doc.commands.insertContentAt(doc.state.doc.content.size - 1, '无关修改')
    const resolved = await assistant.resolveReference(transported)
    const read = await assistant.read(transported)
    await assistant.reveal(transported)
    doc.commands.insertContentAt(1, '已改变')
    let rejected = false
    try { await assistant.read(transported) } catch { rejected = true }
    makeDoc('<p>'+'字'.repeat(262145)+'</p>')
    doc.commands.setTextSelection({from:1,to:262146})
    let bounded = false
    try { await assistant.reference() } catch { bounded = true }
    return {length:reference.text.length,hash:transported.textDigest,size:JSON.stringify(transported).length,readLength:read.text.length,unchanged:resolved.text===reference.text,rebound:resolved.version!==reference.version,rejected,bounded}
  })
  assert.equal(result.length,262144);assert.ok(result.size<1024);assert.equal(result.hash,createHash('sha256').update('长引用正文'.repeat(50000)+'结尾'.repeat(6072)).digest('hex'))
  assert.ok(result.readLength<=24000);assert.equal(result.unchanged,true);assert.equal(result.rebound,true);assert.equal(result.rejected,true);assert.equal(result.bounded,true)
})

test('PPTX 旧引用在其它元素修改保存重开后可重绑，目标文字改变拒绝', {timeout:90000}, async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    await makeSlides();const id=await addText('引用原文');slideCtx.selectedIds=[id]
    const reference=compactReference(await assistant.reference())
    await addText('其它位置的修改');const saved=(await rpc('save')).bytes;worker.terminate()
    await makeSlides(saved)
    const read=await assistant.read(reference);const reveal=await assistant.reveal(reference)
    await assistant.execute({operation:'replace_text',reference:read.reference,input:{text:'目标已改'}})
    let rejected=false;try{await assistant.read(reference)}catch{rejected=true}
    worker.terminate();return {text:read.reference.text,reveal,rejected}
  })
  assert.equal(result.text,'引用原文');assert.equal(result.reveal,true);assert.equal(result.rejected,true)
})

test('XLSX 旧引用在别处修改保存重开后重绑，选区值变化拒绝', {timeout:90000}, async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    const {mountSheets}=await import('/sheets-editor.js')
    const context={signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}}
    const mount=bytes=>mountSheets({context,container:document.querySelector('#app'),bytes,name:'引用.xlsx',onDirty(){}})
    let editor=await mount(new Uint8Array(await(await fetch('/blank.xlsx')).arrayBuffer()))
    let assistant=editor.assistant
    const info=await assistant.read();const sheetId=JSON.parse(info.text).sheets[0].sheetId
    await assistant.execute({operation:'set_cells',input:{sheetId,range:'A1',values:[['引用原文']]}})
    const reference=compactReference((await assistant.read(undefined,{operation:'read_range',input:{sheetId,range:'A1'}})).reference ?? await assistant.reference())
    await assistant.execute({operation:'set_cells',input:{sheetId,range:'Z20',values:[['其它内容']]}})
    const bytes=await editor.save();await editor.markSaved(bytes);editor.dispose();editor=await mount(bytes);assistant=editor.assistant
    const read=await assistant.read(reference);const reveal=await assistant.reveal(reference)
    await assistant.execute({operation:'set_cells',reference:read.reference,input:{values:[['目标变化']]}})
    let rejected=false;try{await assistant.read(reference)}catch{rejected=true}
    editor.dispose();return {text:read.reference.text,reveal,rejected}
  })
  assert.match(result.text,/引用原文/);assert.equal(result.reveal,true);assert.equal(result.rejected,true)
})


test('XLSX 大范围引用不受写操作格数限制，整列裁剪空尾部', {timeout:90000}, async t => {
  const page = await fixture(t)
  await page.evaluate(async () => {
    const {mountSheets} = await import('/sheets-editor.js')
    window.sheetEditor = await mountSheets({context:{signal:new AbortController().signal,workers:{create:async url=>new Worker(url,{type:'module'})}},container:document.querySelector('#app'),bytes:new Uint8Array(await(await fetch('/blank.xlsx')).arrayBuffer()),name:'范围.xlsx',onDirty:()=>{}})
    window.assistant = sheetEditor.assistant
    const initial = JSON.parse((await assistant.read()).text)
    const sheetId = initial.sheets[0].sheetId
    await assistant.execute({operation:'set_cells',input:{sheetId,range:'A1',values:[['第一行']]}})
    await assistant.execute({operation:'set_cells',input:{sheetId,range:'A81',values:[['末行']]}})
  })
  const nameBox = page.locator('input.univer-appearance-none')
  await nameBox.fill('A1:E90'); await nameBox.press('Enter')
  const selected = await page.evaluate(() => assistant.reference())
  assert.match(selected.text, /^第一行/); assert.match(selected.text, /末行/)
  assert.equal(selected.text.split('\n').length, 90)
  await nameBox.fill('A:A'); await nameBox.press('Enter')
  const fullColumn = await page.evaluate(() => assistant.reference())
  assert.equal(fullColumn.locator.clipped, true)
  assert.equal(fullColumn.locator.range.endRow, 80)
  assert.equal(fullColumn.text.split('\n').length, 81)
  const multiple = await page.evaluate(async selected => {
    const ranges = [0,80].map(row => ({startRow:row,endRow:row,startColumn:0,endColumn:0}))
    const sheet = selected.label.split('!')[0]
    const text = `${sheet}!A1\n第一行\n\n${sheet}!A81\n末行`
    const reference = {...selected,text,locator:{kind:'xlsx',sheetId:selected.locator.sheetId,range:ranges[0],contentFormat:'display',ranges}}
    await assistant.reveal(reference)
    const captured = await assistant.reference()
    let guarded = false
    try { await assistant.execute({operation:'replace_text',reference:captured,input:{text:'不能静默只改第一段'}}) } catch { guarded = true }
    return {text:captured.text,ranges:captured.locator.ranges,guarded}
  }, selected)
  assert.equal(multiple.ranges.length,2)
  assert.match(multiple.text,/!A1\n第一行[\s\S]*!A81\n末行/)
  assert.equal(multiple.guarded,true)
  await page.evaluate(() => sheetEditor.dispose())
})


test('PPTX 重复文字引用按对象内偏移替换，保留邻文和原生页面渲染', {timeout:90000}, async t => {
  const page = await fixture(t)
  const result = await page.evaluate(async () => {
    await makeSlides()
    const text = 'Before target middle target after'
    const id = await addText(text)
    slideCtx.selectedIds = [id]
    const full = await assistant.reference()
    const start = text.lastIndexOf('target')
    const selected = {...full, text:'target', locator:{...full.locator,textRange:{start,end:start+6,digest:officeTextDigest(text)}}}
    const current = await assistant.resolveReference(selected)
    await assistant.execute({operation:'replace_text', reference:current, input:{text:'changed'}})
    const after = await assistant.reference()
    const [image] = await assistant.render({slideIndexes:[0]})
    const bytes = [...(await rpc('save')).bytes]
    worker.terminate()
    return {text:after.text,bytes,png:[...image.data.slice(0,8)]}
  })
  assert.equal(result.text,'Before target middle changed after')
  const zip = await JSZip.loadAsync(new Uint8Array(result.bytes))
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /Before target middle changed after/)
  assert.deepEqual(result.png,[137,80,78,71,13,10,26,10])
})
