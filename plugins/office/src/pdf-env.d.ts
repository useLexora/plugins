import type { PdfApi } from '../vendor/genoffice/apps/pdf/src/shared/ipc'
declare global {
  interface Window { pdfApi: PdfApi }
}
