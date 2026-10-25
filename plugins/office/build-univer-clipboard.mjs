import fs from 'node:fs/promises'
import path from 'node:path'

export function univerClipboardPatch() {
  return {
    name: 'univer-clipboard-transaction',
    setup(api) {
      api.onLoad({ filter: /[/\\]@univerjs[/\\]docs-ui[/\\]lib[/\\]es[/\\]index\.js$/ }, async ({ path: file }) => {
        const manifest = JSON.parse(await fs.readFile(path.resolve(path.dirname(file), '../../package.json'), 'utf8'))
        if (manifest.version !== '0.25.1') throw new Error(`Review Univer clipboard patch for docs-ui ${manifest.version}`)
        let contents = await fs.readFile(file, 'utf8')
        const replacements = [
          ['this._setClipboardData(newSnapshotList, !isCopyInHeaderFooter && needCache);', 'await this._setClipboardData(newSnapshotList, !isCopyInHeaderFooter && needCache);'],
          ['this.copy(SliceBodyType.cut, ranges);', 'if (!(await this.copy(SliceBodyType.cut, ranges))) return false;'],
          ['this._logService.error("[DocClipboardService] copy failed", e);', 'if (e?.name === "CanceledError") throw e; this._logService.error("[DocClipboardService] copy failed", e);'],
        ]
        for (const [before, after] of replacements) {
          if (contents.split(before).length !== 2) throw new Error(`Univer clipboard patch expected one match: ${before}`)
          contents = contents.replace(before, after)
        }
        return { contents, loader: 'js' }
      })
    },
  }
}
