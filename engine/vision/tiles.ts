/**
 * engine/vision/tiles.ts — the zoom: cut a large picture into tiles the image
 * box sees at full detail (F192).
 *
 * Ollama resizes every picture it is given to about 4 MP before the vision
 * model sees it, so on a 12 MP phone photo of a lineup table the checkboxes,
 * the bold names and the injury marks were read wrong. A tile of ≤ 3.5 MP
 * reaches the model unshrunk; two to four tiles, each asked the question,
 * cost two to four looks. The grid is fixed by the picture's size, never by
 * the question: full-width horizontal bands (a very wide picture gets vertical
 * strips instead), with a 4 % overlap so a row cut by the seam is whole in one
 * tile. Never quadrants: on the lineup photo they put the names in the left
 * tiles and the stats in the right ones, and no tile could relate a row to its
 * marks (live check, 2026-11-09). A row of a table or a line of a screen is the
 * unit the question is about, so a tile keeps rows whole.
 *
 * Decoding is pure JavaScript (jpeg-js, pngjs): the engine has no other
 * image library, and the tiles must not ride the painting queue on the box.
 */
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'

/** What the box keeps of a picture: above this, detail is being thrown away. */
export const BOX_MAX_PIXELS = 4_000_000
/** The most a tile holds, so the box keeps all of it. */
export const TILE_MAX_PIXELS = 3_500_000
const OVERLAP = 0.04
const TILE_JPEG_QUALITY = 92

export type Tile = { label: string; x: number; y: number; width: number; height: number }

const BAND_NAMES: Record<number, string[]> = {
  2: ['top half', 'bottom half'],
  3: ['top third', 'middle third', 'bottom third'],
  4: ['top quarter', 'upper-middle quarter', 'lower-middle quarter', 'bottom quarter'],
}
const STRIP_NAMES: Record<number, string[]> = {
  2: ['left half', 'right half'],
  3: ['left third', 'middle third', 'right third'],
  4: ['left quarter', 'left-middle quarter', 'right-middle quarter', 'right quarter'],
}

/** The tiles for a picture of this size: one, or two to four full-width bands (strips when the picture is more than twice as wide as tall). */
export function tileGrid(width: number, height: number): Tile[] {
  const pixels = width * height
  if (pixels <= TILE_MAX_PIXELS) return [{ label: 'whole picture', x: 0, y: 0, width, height }]
  const n = Math.min(4, Math.ceil(pixels / TILE_MAX_PIXELS))
  const strips = width > 2 * height
  const span = strips ? width : height
  const size = Math.min(span, Math.ceil((span / n) * (1 + OVERLAP)))
  const step = (span - size) / (n - 1)
  const names = strips ? STRIP_NAMES[n] : BAND_NAMES[n]
  return names.map((label, i) => {
    const start = i === n - 1 ? span - size : Math.round(i * step)
    return strips ? { label, x: start, y: 0, width: size, height } : { label, x: 0, y: start, width, height: size }
  })
}

type Raster = { width: number; height: number; data: Uint8Array }

function decode(bytes: Uint8Array, mime: string): Raster {
  if (mime === 'image/png') {
    const p = PNG.sync.read(Buffer.from(bytes))
    return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) }
  }
  if (mime === 'image/jpeg') {
    const j = decodeJpeg(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true })
    return { width: j.width, height: j.height, data: j.data }
  }
  throw new Error(`cannot cut a ${mime} picture into tiles (PNG and JPEG only)`)
}

/** Each tile of the grid as a JPEG, cropped from the decoded picture. Throws for a format it cannot decode. */
export function cropTiles(bytes: Uint8Array, mime: string, grid: Tile[]): Array<{ label: string; bytes: Uint8Array }> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error(`cannot cut a ${mime} picture into tiles (PNG and JPEG only)`)
  const src = decode(bytes, mime)
  return grid.map(t => {
    const x0 = Math.max(0, Math.min(t.x, src.width - 1)), y0 = Math.max(0, Math.min(t.y, src.height - 1))
    const w = Math.min(t.width, src.width - x0), h = Math.min(t.height, src.height - y0)
    const out = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * src.width + x0) * 4
      out.set(src.data.subarray(from, from + w * 4), row * w * 4)
    }
    const jpeg = encodeJpeg({ data: out, width: w, height: h }, TILE_JPEG_QUALITY)
    return { label: t.label, bytes: new Uint8Array(jpeg.data) }
  })
}
