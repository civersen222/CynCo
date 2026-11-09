/**
 * engine/vision/imageSize.ts — a picture's pixel size from its header alone.
 *
 * The zoom (tiles.ts, F192) must decide whether a picture is larger than what
 * the image box keeps (~4 MP) before paying to decode it; this reads the four
 * formats the project accepts (engine/projects/extract/index.ts IMAGE_EXTS)
 * and answers null for anything else or anything truncated — never a throw.
 */
export type Dimensions = { width: number; height: number }

export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  try {
    return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes)
  } catch {
    return null
  }
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

function png(b: Uint8Array): Dimensions | null {
  if (b.length < 24 || b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG' || ascii(b, 12, 4) !== 'IHDR') return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function jpeg(b: Uint8Array): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }
    // SOF0–SOF15 carry the frame size, except the DHT/JPG/DAC markers in the same range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any frame header
    i += 2 + u16be(b, i + 2)
  }
  return null
}

function gif(b: Uint8Array): Dimensions | null {
  if (b.length < 10 || ascii(b, 0, 4) !== 'GIF8') return null
  return { width: u16le(b, 6), height: u16le(b, 8) }
}

function webp(b: Uint8Array): Dimensions | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  if (chunk === 'VP8L') {
    const w = 1 + (b[21] | ((b[22] & 0x3f) << 8))
    const h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10))
    return { width: w, height: h }
  }
  return null
}
