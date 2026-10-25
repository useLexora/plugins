function unavailable(): never {
  throw new Error('Host path access is unavailable in this plugin')
}
export { unavailable as dirname, unavailable as join }
