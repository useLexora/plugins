function unavailable(): never { throw new Error('此文档操作需要文件访问权限。') }
export { unavailable as open, unavailable as readFile, unavailable as writeFile, unavailable as createWriteStream, unavailable as pipeline, unavailable as mkdir, unavailable as rename, unavailable as stat }
export { closeSync, fsyncSync, openSync, readFileSync, writeFileSync, rm } from './fs'
