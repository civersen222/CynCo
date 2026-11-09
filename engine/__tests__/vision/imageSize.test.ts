// The zoom (F192) needs a picture's pixel size without decoding it: the four
// formats the project accepts, read from their headers.
import { describe, expect, it } from 'bun:test'
import { imageDimensions } from '../../vision/imageSize.js'

function pngHeader(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}
function jpegHeader(w: number, h: number): Uint8Array {
  // SOI, an APP0 segment to skip, then SOF0 with height/width
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46])
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2)
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(7, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]))
}
function gifHeader(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(10); b.write('GIF89a', 0); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8)
  return new Uint8Array(b)
}
function webpVp8xHeader(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16)
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3)
  return new Uint8Array(b)
}

describe('imageDimensions', () => {
  it('reads PNG, JPEG (past a leading APP segment), GIF and WebP VP8X headers', () => {
    expect(imageDimensions(pngHeader(1440, 3120))).toEqual({ width: 1440, height: 3120 })
    expect(imageDimensions(jpegHeader(3992, 3006))).toEqual({ width: 3992, height: 3006 })
    expect(imageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 })
    expect(imageDimensions(webpVp8xHeader(2000, 1500))).toEqual({ width: 2000, height: 1500 })
  })
  it('anything else, or a truncated header, is null — never a throw', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageDimensions(new Uint8Array(0))).toBeNull()
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(imageDimensions(pngHeader(10, 10).slice(0, 20))).toBeNull()
  })
})
