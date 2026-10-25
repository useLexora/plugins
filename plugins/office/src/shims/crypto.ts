import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error('Only SHA-256 is available in the workbook sandbox')
  const hash = sha256.create()
  return {
    update(value: string | Uint8Array) {
      hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value)
      return this
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported digest encoding')
      return bytesToHex(hash.digest())
    },
  }
}

export function randomUUID() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
