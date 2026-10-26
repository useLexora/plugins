import fs from 'node:fs/promises'
import path from 'node:path'

export function univerContextMenuPatch() {
  return {
    name: 'univer-context-menu-reentry',
    setup(api) {
      api.onLoad({ filter: /[/\\]@univerjs[/\\]ui[/\\]lib[/\\]es[/\\]index\.js$/ }, async ({ path: file }) => {
        const manifest = JSON.parse(await fs.readFile(path.resolve(path.dirname(file), '../../package.json'), 'utf8'))
        if (manifest.version !== '0.25.1') throw new Error(`Review Univer context menu patch for ui ${manifest.version}`)
        let contents = await fs.readFile(file, 'utf8')
        const pattern = /setSubmenuPositionReady\(false\);(\s+)setSubmenuVisible\(true\);/g
        if ([...contents.matchAll(pattern)].length !== 2) throw new Error('Univer context menu patch expected two submenu opening paths')
        contents = contents.replace(pattern, 'if (!submenuVisible) setSubmenuPositionReady(false);$1setSubmenuVisible(true);')
        const panel = 'children: menuType && /* @__PURE__ */ jsx(ContextMenuPanel,'
        if (contents.split(panel).length !== 2) throw new Error('Univer context menu patch expected one panel lifecycle boundary')
        contents = contents.replace(panel, 'children: visible && menuType && /* @__PURE__ */ jsx(ContextMenuPanel,')
        return { contents, loader: 'js' }
      })
    },
  }
}
