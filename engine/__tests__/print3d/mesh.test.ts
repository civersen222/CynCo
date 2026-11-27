/**
 * engine/print3d/mesh.ts: reading an STL and measuring it the way a slicer
 * would care — size, volume, closed or not, pieces, faces pointing inward,
 * overhangs, plate contact and the fit on the P2S's build volume.
 */
import { describe, expect, it } from 'bun:test'
import { analyzeMesh, meshWarnings, readStl, STL_MAX_BYTES } from '../../print3d/mesh.js'
import { asciiStl, binaryStl, box, inward } from './fixtures.js'

const P2S = { name: 'Bambu Lab P2S', x: 256, y: 256, z: 256 }

function read(bytes: Uint8Array) {
  const r = readStl(bytes)
  if (!r.ok) throw new Error(r.reason)
  return r.mesh
}

describe('readStl', () => {
  it('reads a binary STL by the size its header gives, and an ASCII one by "solid … vertex"', () => {
    const cube = box(0, 0, 0, 20, 20, 20)
    expect(read(binaryStl(cube)).count).toBe(12)
    expect(Array.from(read(binaryStl(cube)).tris)).toEqual(cube)
    expect(read(asciiStl(cube)).count).toBe(12)
    expect(Array.from(read(asciiStl(cube)).tris)).toEqual(cube)
  })

  it('refuses what is not an STL, an empty one, a cut ASCII one and a corner that is not a number', () => {
    expect(readStl(new TextEncoder().encode('PK\x03\x04 not a mesh'))).toEqual({ ok: false, reason: 'not an STL file (neither a binary STL of the size its header gives nor ASCII "solid")' })
    expect(readStl(binaryStl([]))).toEqual({ ok: false, reason: 'the STL has no triangles' })
    expect(readStl(new TextEncoder().encode('solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n'))).toEqual({ ok: false, reason: 'the ASCII STL has no complete triangles' })
    const bad = binaryStl(box(0, 0, 0, 1, 1, 1))
    new DataView(bad.buffer).setFloat32(84 + 12, NaN, true)
    expect(readStl(bad)).toEqual({ ok: false, reason: 'the STL has a corner that is not a number' })
  })

  it('refuses a file past the cap before reading it', () => {
    const r = readStl({ length: STL_MAX_BYTES + 1 } as Uint8Array)
    expect(r.ok).toBe(false)
  })
})

describe('analyzeMesh', () => {
  it('a 20 mm cube on the plate: closed, one piece, 8 cm³, 4 cm² on the plate, no overhang, fits', () => {
    const r = analyzeMesh(read(binaryStl(box(0, 0, 0, 20, 20, 20))), P2S)
    expect(r.triangles).toBe(12)
    expect(r.size).toEqual([20, 20, 20])
    expect(r.volume).toBeCloseTo(8000, 3)
    expect(r.area).toBeCloseTo(2400, 3)
    expect(r.watertight).toBe(true)
    expect(r.openEdges).toBe(0)
    expect(r.nonManifoldEdges).toBe(0)
    expect(r.shells).toBe(1)
    expect(r.insideOut).toBe(false)
    expect(r.contactArea).toBeCloseTo(400, 3)
    expect(r.overhangArea).toBe(0)
    expect(r.fitsPlate).toBe(true)
    expect(meshWarnings(r, P2S)).toEqual([])
  })

  it('a missing face is open edges; two boxes apart are two pieces; inward faces are said', () => {
    const open = box(0, 0, 0, 10, 10, 10).slice(0, 11 * 9)
    const o = analyzeMesh(read(binaryStl(open)), P2S)
    expect(o.watertight).toBe(false)
    expect(o.openEdges).toBe(3)
    expect(meshWarnings(o, P2S)[0]).toMatch(/^it is not closed \(3 open edges, 0 edges shared by more than two faces\)/)

    const two = analyzeMesh(read(binaryStl([...box(0, 0, 0, 10, 10, 10), ...box(30, 0, 0, 40, 10, 10)])), P2S)
    expect(two.shells).toBe(2)
    expect(two.watertight).toBe(true)
    expect(meshWarnings(two, P2S)).toContain('it is 2 separate pieces: each prints on its own; join them (union, overlap them by 0.01 mm or more) if they should be one part')

    const inside = analyzeMesh(read(binaryStl(inward(box(0, 0, 0, 10, 10, 10)))), P2S)
    expect(inside.insideOut).toBe(true)
    expect(inside.volume).toBeCloseTo(1000, 3)
    expect(meshWarnings(inside, P2S)).toContain('its faces point inward: a slicer reads it as empty — reverse the outline order (or the polyhedron faces)')
  })

  it('an overhang is the downward face over air; the base on the plate is contact, not overhang', () => {
    // A 10 mm post with a 30 × 10 mm slab on top, as two boxes (not unioned): the slab's whole underside faces down.
    const r = analyzeMesh(read(binaryStl([...box(0, 0, 0, 10, 10, 10), ...box(0, 0, 10, 30, 10, 12)])), P2S)
    expect(r.contactArea).toBeCloseTo(100, 3)
    expect(r.overhangArea).toBeCloseTo(300, 3)
    expect(meshWarnings(r, P2S).some(w => w.startsWith('3.0 cm² hangs over air steeper than 45°'))).toBe(true)
  })

  it('too big for the plate is the first warning, with the size; little plate contact is said', () => {
    const big = analyzeMesh(read(binaryStl(box(0, 0, 0, 300, 20, 20))), P2S)
    expect(big.fitsPlate).toBe(false)
    expect(meshWarnings(big, P2S)[0]).toBe('it does not fit the Bambu Lab P2S build volume (256 × 256 × 256 mm): it is 300 × 20.0 × 20.0 mm — scale it down or split it into parts')
    const thin = analyzeMesh(read(binaryStl(box(0, 0, 0, 3, 3, 40))), P2S)
    expect(meshWarnings(thin, P2S)).toContain('only 9.0 mm² of it touches the plate: it may tip or come loose — give it a flat base, or slice with a brim')
  })
})
