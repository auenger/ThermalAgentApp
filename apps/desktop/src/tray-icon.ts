import { deflateSync } from 'node:zlib'

const SIZE = 32
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function createTrayIconPng(): Buffer {
  const pixels = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const offset = y * (SIZE * 4 + 1) + 1 + x * 4
      const dx = x - 15.5
      const dy = y - 15.5
      const circle = dx * dx + dy * dy <= 15 * 15
      const heat = (x >= 9 && x <= 12 && y >= 13 && y <= 23) ||
        (x >= 15 && x <= 18 && y >= 8 && y <= 23) ||
        (x >= 21 && x <= 24 && y >= 11 && y <= 23)
      if (!circle) continue
      pixels[offset] = heat ? 255 : 28
      pixels[offset + 1] = heat ? 146 : 51
      pixels[offset + 2] = heat ? 62 : 76
      pixels[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // RGBA, eight bits per channel
  header[9] = 6
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const body = Buffer.concat([name, data])
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE(crc32(body), 8 + data.length)
  return result
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
