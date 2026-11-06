import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resourceFile } from '../resources.mjs'
import { parentPort, workerData } from 'node:worker_threads'

const { image, languages = 'chi_sim+eng' } = workerData
const createCore = createRequire(import.meta.url)(resourceFile(workerData, 'engine', 'tesseract-core-lstm.wasm.js'))
const core = await createCore({ locateFile: name => resourceFile(workerData, 'engine', name) })
for (const language of languages.split('+'))
  core.FS.writeFile(`/${language}.traineddata`, await readFile(resourceFile(workerData, 'model', `${language}.traineddata`)))
const api = new core.TessBaseAPI()
try {
  core.FS.writeFile('/config', 'tessedit_pageseg_mode 6\n')
  if (api.Init('/', languages, 1, '/config') !== 0) throw Error('OCR model initialization failed')
  api.SetPageSegMode(6)
  core.FS.writeFile('/input', image)
  if (api.SetImageFile(1, 0) !== 0) throw Error('OCR image could not be read')
  if (api.Recognize(null) !== 0) throw Error('OCR recognition failed')
  const text = api.GetUTF8Text().trim()
  if (text.length > 128 * 1024) throw Error('OCR output too large')
  parentPort.postMessage(text)
}
finally {
  api.End()
  api.delete()
}
