# Lemonade management crop

Pinned source: `d98e62998768199906e68823e33ae482d61e8bb0` (UI redesign prototype).

- `ModelListPanel`: retain model search, sorting, installed/catalog grouping and keyboard selection; remove unavailable sort choices and secondary metadata glyphs; correct the sub-10 MB size boundary. Allow a host-owned sort control and row status presentation while retaining upstream grouping and sorting.
- `WorkspacePanels`: retain list roving focus, resource rows, detail panels and action primitives; allow an explicit icon for engine/OCR rows.
- Localize visible strings and replace download/API types with the Lexora adapter.
- Retain workspace/list CSS only; map the upstream theme to the host.
- Exclude chat, navigation rail, Tauri, remote discovery, marketplace and server process management.

Run `npm ci && npm run build`. Source files are checked against the lock before patching. Changes belong in `lemonade.patch`; prepared vendor files are immutable build inputs. Apache and bundled dependency notices ship in the plugin.

`react-remove-scroll-bar@2.3.8` declares MIT but omits the full license from its npm package. Its license text is retained in `licenses/react-remove-scroll-bar.LICENSE` from [upstream commit 7301c16](https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE) and included in the bundle notice. Other bundled dependencies use their packaged license files.
