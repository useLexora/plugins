import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
const root = import.meta.dirname
const generated = path.join(root, 'generated')
fs.mkdirSync(generated, { recursive: true })
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
const base = path.join(root, 'vendor/genoffice/apps/slides/src/main')
const mainPath = path.join(base, 'slides-main.ts')
const sessionPath = path.join(base, 'session-state.ts')
const units = [mainPath, sessionPath].map(p => ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true))
const declarations = new Map()
const imports = new Map()
const provided = new Set(['ipcMain', 'sessions', 'webContents', 'getFontMetrics', 'setImmediate', 'refineComplexWidths', 'shapedMetricsReady', 'tiffToPng', 'clipboard', 'ELEMENT_CLIPBOARD_FORMAT', 'elementClipboardMarkerMatches', 'isElementClipboardToken', 'canWriteElementClipboardImage', 'writeElementClipboardImage', 'dialogParent', 'dialog', 'showOpenDialogWithMemory', 'readFile', 'safeExternalUrl', 'configuredAuthorName', 'commentAuthorName', 'videoPoster'])
const modules = new Set(['@genoffice/pptx-engine', '@genoffice/pptx-ops', '@genoffice/pptx-render', '@genoffice/pptx-engine/identity', '@genoffice/i18n', 'node:crypto', 'node:path'])
const relative = new Set(['./picture-frame', './paste-cascade', './media-mime', './jpeg-orientation', './cfb-sniff', '../shared/base-name', './i18n-main', '../shared/slide-selection', '../shared/run-link', '../shared/media-kinds', './mp4-audio-sniff', './video-size'])
function declarationNames(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return [node.name.text]
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : [])
  return []
}
for (const unit of units) {
  for (const node of unit.statements) {
    for (const name of declarationNames(node)) if (!declarations.has(name)) declarations.set(name, { node, unit })
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.text
      if (node.importClause?.isTypeOnly) continue
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const item of node.importClause.namedBindings.elements) if (!item.isTypeOnly && !imports.has(item.name.text)) imports.set(item.name.text, { imported: item.propertyName?.text ?? item.name.text, module: spec, unit })
      }
    }
  }
}
const register = units[0].statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'registerSlidesIpc')
for (const node of register.body.statements) for (const name of declarationNames(node)) declarations.set(name, { node, unit: units[0] })
function references(node) {
  const result = new Set()
  const visit = n => {
    if (ts.isTypeNode(n)) return
    if (ts.isIdentifier(n)) {
      if ((ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n && !ts.isShorthandPropertyAssignment(n.parent))) return
      result.add(n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return result
}
function collect(node, selected = new Set(), names = new Set(), seen = new Set()) {
  for (const name of references(node)) {
    if (provided.has(name) || seen.has(name)) continue
    seen.add(name)
    const decl = declarations.get(name)
    if (decl) { selected.add(name); collect(decl.node, selected, names, seen); continue }
    const imp = imports.get(name)
    if (!imp) continue
    if (imp.module === './session-state') continue
    if (!modules.has(imp.module) && !relative.has(imp.module)) throw new Error(`${name} from ${imp.module}`)
    names.add(name)
  }
  return { selected, names }
}
const handlers = []
const declined = []
const selected = new Set()
const names = new Set()
for (const node of register.body.statements) {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
  const call = node.expression
  if (call.expression.getText() !== 'ipcMain.handle' || !ts.isStringLiteral(call.arguments[0])) continue
  const channel = call.arguments[0].text
  if (!channel.startsWith('slides:') || /^(?:slides:(?:open(?:-|$)|consume-|save(?:-|$)|print$|export-|pick-export-|font-|private-font-|capture|presenter-|audience-|screen-|recording-|native-|ai-|new-blank$|local-page-|land-generated-))/.test(channel)) continue
  try {
    const deps = collect(call.arguments[1])
    handlers.push({ channel, text: node.getText() })
    deps.selected.forEach(n => selected.add(n)); deps.names.forEach(n => names.add(n))
  } catch (error) { declined.push({ channel, reason: error.message }) }
}
for (const name of ['buildAllRenderSlides', 'makeMediaResolver', 'deckDefaultFont']) {
  selected.add(name)
  const deps = collect(declarations.get(name).node)
  deps.selected.forEach(n => selected.add(n)); deps.names.forEach(n => names.add(n))
}
const header = [...names].sort().map(name => {
  const imp = imports.get(name)
  const module = imp.module.startsWith('.') ? path.relative(generated, path.resolve(path.dirname(imp.unit.fileName), imp.module)).replaceAll('\\','/') : imp.module
  return `import { ${imp.imported}${imp.imported !== name ? ` as ${name}` : ''} } from ${JSON.stringify(module.startsWith('.') ? module : imp.module.startsWith('.') ? './'+module : module)};`
}).join('\n')
const definitions = [...new Set([...selected].map(n => declarations.get(n).node))].map(node => node.getText().replace(/^export\s+/, '')).join('\n')
const source = `${header}\nexport function registerSlidesKernel(kernel) {\nconst {${[...provided].join(',')}} = kernel;\n${definitions}\n${handlers.map(x=>x.text).join('\n')}\nreturn {buildAllRenderSlides,makeMediaResolver,deckDefaultFont};\n}\nexport const supportedSlidesChannels = ${JSON.stringify(handlers.map(x=>x.channel))};\n`
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText
fs.writeFileSync(path.join(generated, 'slides-kernel.mjs'), js)
fs.writeFileSync(path.join(root, 'artifacts/slides-kernel-capabilities.json'), JSON.stringify({ supported: handlers.map(x=>x.channel), declined },null,2))
console.log(`Slides kernel: ${handlers.length} handlers; ${declined.length} native-only`)
const preload = ts.createSourceFile('preload.ts', fs.readFileSync(path.join(base,'../preload/index.ts'),'utf8'), ts.ScriptTarget.Latest,true)
const api = preload.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText() === 'api'))
fs.writeFileSync(path.join(generated,'slides-api.mjs'),ts.transpileModule(`export function createSlidesApi(ipcRenderer, webUtils) { ${api.getText()} return api }`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,removeComments:true}}).outputText)
for (const name of ['slides-kernel', 'slides-api']) fs.copyFileSync(path.join(root, 'src', `${name}.d.mts`), path.join(generated, `${name}.d.mts`))
