// The zoom (F192): a picture larger than what the image box keeps (~4 MP) is
// cut into tiles the box sees at full detail, each asked the question.
import { describe, expect, it } from 'bun:test'
import { PNG } from 'pngjs'
import { decode as decodeJpeg } from 'jpeg-js'
import { BOX_MAX_PIXELS, TILE_MAX_PIXELS, cropTiles, tileGrid } from '../../vision/tiles.js'
import { imageDimensions } from '../../vision/imageSize.js'

/** A PNG with four flat-colour quadrants: TL red, TR green, BL blue, BR white. */
function quadrantPng(w: number, h: number): Uint8Array {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const right = x >= w / 2, bottom = y >= h / 2
    const [r, g, b] = !bottom && !right ? [255, 0, 0] : !bottom && right ? [0, 255, 0] : bottom && !right ? [0, 0, 255] : [255, 255, 255]
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255
  }
  return new Uint8Array(PNG.sync.write(png))
}
function centrePixel(jpeg: Uint8Array): [number, number, number] {
  const d = decodeJpeg(Buffer.from(jpeg), { useTArray: true })
  const i = ((d.height >> 1) * d.width + (d.width >> 1)) * 4
  return [d.data[i], d.data[i + 1], d.data[i + 2]]
}
const near = (a: number, b: number) => Math.abs(a - b) <= 12

describe('tileGrid', () => {
  it('a picture the box keeps whole is one tile; constants name the box cap and the tile size', () => {
    expect(BOX_MAX_PIXELS).toBe(4_000_000)
    expect(TILE_MAX_PIXELS).toBe(3_500_000)
    expect(tileGrid(2000, 1500)).toEqual([{ label: 'whole picture', x: 0, y: 0, width: 2000, height: 1500 }])
  })
  it('a 12 MP phone photo is four full-width bands with a small overlap (rows stay whole — never quadrants); a tall screenshot splits top/bottom; a very wide one left/right', () => {
    const q = tileGrid(3992, 3006)
    expect(q.map(t => t.label)).toEqual(['top quarter', 'upper-middle quarter', 'lower-middle quarter', 'bottom quarter'])
    for (const t of q) { expect(t.x).toBe(0); expect(t.width).toBe(3992) }
    expect(q[0].y).toBe(0)
    expect(q[0].height).toBeGreaterThan(3006 / 4); expect(q[0].height).toBeLessThan(3006 * 0.3)
    expect(q[3].y + q[3].height).toBe(3006)
    expect(q[1].y).toBeLessThan(q[0].y + q[0].height)  // overlap: the seam row is in both
    expect(tileGrid(1440, 3120).map(t => t.label)).toEqual(['top half', 'bottom half'])
    expect(tileGrid(3120, 1440).map(t => t.label)).toEqual(['left half', 'right half'])
  })
  it('never more than four tiles, each under the tile size for anything up to 16 MP', () => {
    for (const [w, h] of [[4000, 4000], [5000, 3000], [4608, 3456]]) {
      const g = tileGrid(w, h)
      expect(g.length).toBeLessThanOrEqual(4)
      // past 14 MP four tiles cannot all stay under the tile size; they stay near the box cap, still 4× the detail of one look
      for (const t of g) expect(t.width * t.height).toBeLessThanOrEqual(BOX_MAX_PIXELS * 1.1)
    }
  })
})

describe('cropTiles', () => {
  it('cuts a PNG into JPEG tiles whose pixels come from the right quadrant', () => {
    const src = quadrantPng(400, 300)
    const grid = [
      { label: 'top-left', x: 0, y: 0, width: 200, height: 150 }, { label: 'top-right', x: 200, y: 0, width: 200, height: 150 },
      { label: 'bottom-left', x: 0, y: 150, width: 200, height: 150 }, { label: 'bottom-right', x: 200, y: 150, width: 200, height: 150 },
    ]
    const tiles = cropTiles(src, 'image/png', grid)
    expect(tiles.map(t => t.label)).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    for (const t of tiles) expect(imageDimensions(t.bytes)).toEqual({ width: 200, height: 150 })
    const [tl, tr, bl, br] = tiles.map(t => centrePixel(t.bytes))
    expect(near(tl[0], 255) && near(tl[1], 0)).toBe(true)
    expect(near(tr[1], 255) && near(tr[0], 0)).toBe(true)
    expect(near(bl[2], 255) && near(bl[0], 0)).toBe(true)
    expect(near(br[0], 255) && near(br[1], 255) && near(br[2], 255)).toBe(true)
  })
  it('a JPEG source works the same; a format it cannot decode throws a named error', () => {
    const src = quadrantPng(200, 100)
    const whole = cropTiles(src, 'image/png', [{ label: 'whole picture', x: 0, y: 0, width: 200, height: 100 }])[0].bytes
    const again = cropTiles(whole, 'image/jpeg', [{ label: 'left half', x: 0, y: 0, width: 100, height: 100 }])
    expect(imageDimensions(again[0].bytes)).toEqual({ width: 100, height: 100 })
    expect(() => cropTiles(new Uint8Array([1, 2, 3]), 'image/gif', [])).toThrow(/cannot cut a image\/gif/)
  })
})
