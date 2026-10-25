declare module '*.png' { const url: string; export default url }
declare module '*.svg' { const url: string; export default url }
declare module '*?url' { const url: string; export default url }
declare module '*?raw' { const value: string; export default value }
interface ImportMeta { readonly env: { readonly DEV: boolean } }

declare module "*?bytes" { const bytes: Uint8Array<ArrayBuffer>; export default bytes }
