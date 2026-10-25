import { inflateSync, zlibSync } from 'fflate'
export function inflateRawSync(data: Uint8Array): Uint8Array { return inflateSync(data) }
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

export const deflateSync = zlibSync
