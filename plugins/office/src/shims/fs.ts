function unavailable(): never {
  throw new Error('Direct file system access is unavailable in this plugin')
}
export { unavailable as closeSync, unavailable as fsyncSync, unavailable as openSync, unavailable as readFileSync, unavailable as writeFileSync, unavailable as rename, unavailable as rm }
