/**
 * engine/print3d/render.ts: the four-view sheet is a real PNG of the asked
 * size, the part is drawn in each tile, a face seen from behind is red, and
 * text in any characters never throws.
 */
import { describe, expect, it } from 'bun:test'
import { PNG } from 'pngjs'
import { readStl } from '../../print3d/mesh.js'
import { drawText, renderSheet } from '../../print3d/render.js'
import { binaryStl, box, inward } from './fixtures.js'

function mesh(tris: number[]) {
  const r = readStl(binaryStl(tris))
  if (!r.ok) throw new Error(r.reason)
  return r.mesh
}

/** How many pixels of a tile are the part's blue (any shade) or its back-face red. */
function count(png: PNG, tileX: number, tileY: number, tile: number, want: 'blue' | 'red'): number {
  let n = 0
  for (let y = tileY * tile; y < (tileY + 1) * tile; y++) {
    for (let x = tileX * tile; x < (tileX + 1) * tile; x++) {
      const o = (y * png.width + x) * 4
      const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2]
      if (want === 'blue' && b > r + 40 && b > g) n++
      if (want === 'red' && r > 150 && g < 110 && b < 110) n++
    }
  }
  return n
}

describe('renderSheet', () => {
  it('is a PNG of two by two tiles, with the part drawn in each of ISO, FRONT, RIGHT and TOP', () => {
    const bytes = renderSheet(mesh(box(0, 0, 0, 40, 20, 10)), { tilePx: 200, title: 'test part' })
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const png = PNG.sync.read(Buffer.from(bytes))
    expect([png.width, png.height]).toEqual([400, 400])
    for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(count(png, tx, ty, 200, 'blue'), `tile ${tx},${ty}`).toBeGreaterThan(500)
      expect(count(png, tx, ty, 200, 'red'), `tile ${tx},${ty}`).toBe(0)
    }
  })

  it('draws faces seen from behind red, so a part turned inside out shows', () => {
    const png = PNG.sync.read(Buffer.from(renderSheet(mesh(inward(box(0, 0, 0, 20, 20, 20))), { tilePx: 160 })))
    expect(count(png, 0, 0, 160, 'red')).toBeGreaterThan(500)
  })

  it('clamps the tile size and writes text with characters the font lacks skipped', () => {
    const png = PNG.sync.read(Buffer.from(renderSheet(mesh(box(0, 0, 0, 5, 5, 5)), { tilePx: 10, title: 'Ünïcode — π ✓' })))
    expect(png.width).toBe(320)
    const buf = Buffer.alloc(20 * 20 * 4)
    expect(() => drawText(buf, 20, 20, -5, -5, 'AB/9.-?', 3)).not.toThrow()
  })
})
