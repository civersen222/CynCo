/**
 * engine/print3d/mesh.ts — read an STL and say what a printer will make of it.
 *
 * `readStl` takes binary or ASCII STL (OpenSCAD writes binary; a file from a
 * model site may be either) into one flat array of triangle corners.
 * `analyzeMesh` measures it the way a slicer would care: its size against the
 * plate, its volume, whether it is closed (every edge shared by exactly two
 * triangles), how many separate pieces it is, how much of it hangs over air
 * steeper than 45°, and how much of it sits on the plate. Pure: no files, no
 * clock. Every number is in the file's units, which for a print are mm.
 */

/** Triangle corners, nine floats per triangle (x y z of three corners). */
export type Mesh = { tris: Float32Array; count: number }

/** The printer's build volume in mm. */
export type Plate = { name: string; x: number; y: number; z: number }

export type MeshReport = {
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  /** mm³; negative input orientation is reported as `insideOut`, the volume is its magnitude. */
  volume: number
  /** mm² */
  area: number
  /** Every edge shared by exactly two triangles. */
  watertight: boolean
  /** Edges used by one triangle (holes) and by more than two (non-manifold). */
  openEdges: number
  nonManifoldEdges: number
  /** Separate connected pieces. */
  shells: number
  /** The triangles' winding points inward: a slicer reads such a solid as empty. */
  insideOut: boolean
  /** mm² of downward faces steeper than 45° that are not on the plate: where supports would go. */
  overhangArea: number
  /** mm² of flat downward faces at the lowest Z: what holds the part on the plate. */
  contactArea: number
  fitsPlate: boolean
  /** Triangles with no area (repeated corners). */
  degenerate: number
}

/** The largest STL the engine reads: 128 MiB is about 2.7 million triangles. */
export const STL_MAX_BYTES = 128 * 1024 * 1024
/** A face is an overhang when its normal points this far down (cos 45°). */
const OVERHANG_COS = Math.cos(Math.PI / 4)
/** A face lies on the plate when it is this flat and this close to the lowest Z (mm). */
const CONTACT_COS = 0.999
const CONTACT_MM = 0.05
/** A face this close above the lowest Z is a first layer, not an overhang (mm). */
const FIRST_LAYER_MM = 0.25

export type ReadResult = { ok: true; mesh: Mesh } | { ok: false; reason: string }

/** Binary when the size matches the triangle count the header gives; ASCII when it reads as "solid … facet". */
export function readStl(bytes: Uint8Array): ReadResult {
  if (bytes.length > STL_MAX_BYTES) return { ok: false, reason: `the STL is larger than ${STL_MAX_BYTES / 1024 / 1024} MiB` }
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint32(80, true)
    if (84 + count * 50 === bytes.length) {
      if (count === 0) return { ok: false, reason: 'the STL has no triangles' }
      const tris = new Float32Array(count * 9)
      for (let i = 0; i < count; i++) {
        const at = 84 + i * 50 + 12 // skip the stored normal: it is recomputed from the corners
        for (let k = 0; k < 9; k++) tris[i * 9 + k] = view.getFloat32(at + k * 4, true)
      }
      return finite({ tris, count })
    }
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase()
  if (!head.startsWith('solid')) return { ok: false, reason: 'not an STL file (neither a binary STL of the size its header gives nor ASCII "solid")' }
  const text = new TextDecoder('latin1').decode(bytes)
  const nums: number[] = []
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (nums.length === 0 || nums.length % 9 !== 0) return { ok: false, reason: 'the ASCII STL has no complete triangles' }
  return finite({ tris: Float32Array.from(nums), count: nums.length / 9 })
}

function finite(mesh: Mesh): ReadResult {
  for (let i = 0; i < mesh.tris.length; i++) if (!Number.isFinite(mesh.tris[i])) return { ok: false, reason: 'the STL has a corner that is not a number' }
  return { ok: true, mesh }
}

/** The lowest and highest corner on each axis. */
export function bounds(mesh: Mesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const t = mesh.tris
  for (let i = 0; i < t.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = t[i + a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  return { min, max }
}

/** Measure a mesh against a plate. Corners are welded on their exact coordinates, as OpenSCAD and slicers write them. */
export function analyzeMesh(mesh: Mesh, plate: Plate): MeshReport {
  const t = mesh.tris
  const { min, max } = bounds(mesh)
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]

  // Weld: one id per distinct corner.
  const ids = new Map<string, number>()
  const corner = new Uint32Array(mesh.count * 3)
  for (let c = 0; c < mesh.count * 3; c++) {
    const key = `${t[c * 3]},${t[c * 3 + 1]},${t[c * 3 + 2]}`
    let id = ids.get(key)
    if (id === undefined) { id = ids.size; ids.set(key, id) }
    corner[c] = id
  }
  const vertices = ids.size

  // Union-find over corners: a shell is a set of triangles joined through shared corners.
  const parent = new Uint32Array(vertices)
  for (let i = 0; i < vertices; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  const edges = new Map<number, number>()
  const edgeKey = (a: number, b: number) => (a < b ? a * vertices + b : b * vertices + a)
  let volume6 = 0, area = 0, overhangArea = 0, contactArea = 0, degenerate = 0
  for (let i = 0; i < mesh.count; i++) {
    const a = corner[i * 3], b = corner[i * 3 + 1], c = corner[i * 3 + 2]
    if (a === b || b === c || a === c) { degenerate++; continue }
    join(a, b); join(b, c)
    for (const k of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) edges.set(k, (edges.get(k) ?? 0) + 1)
    const o = i * 9
    const ax = t[o], ay = t[o + 1], az = t[o + 2]
    const bx = t[o + 3], by = t[o + 4], bz = t[o + 5]
    const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8]
    // Signed volume of the tetrahedron to the origin, times six.
    volume6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0) { degenerate++; continue }
    const faceArea = len / 2
    area += faceArea
    const down = nz / len
    const low = Math.min(az, bz, cz)
    if (down <= -CONTACT_COS && Math.max(az, bz, cz) - min[2] <= CONTACT_MM) contactArea += faceArea
    else if (down < -OVERHANG_COS && low - min[2] > FIRST_LAYER_MM) overhangArea += faceArea
  }

  let openEdges = 0, nonManifoldEdges = 0
  for (const n of edges.values()) {
    if (n === 1) openEdges++
    else if (n > 2) nonManifoldEdges++
  }
  const roots = new Set<number>()
  for (let i = 0; i < mesh.count; i++) {
    const a = corner[i * 3], b = corner[i * 3 + 1], c = corner[i * 3 + 2]
    if (a === b || b === c || a === c) continue
    roots.add(find(a))
  }
  const volume = volume6 / 6
  return {
    triangles: mesh.count, min, max, size,
    volume: Math.abs(volume), area,
    watertight: openEdges === 0 && nonManifoldEdges === 0 && edges.size > 0,
    openEdges, nonManifoldEdges,
    shells: roots.size,
    insideOut: volume < 0,
    overhangArea, contactArea,
    fitsPlate: size[0] <= plate.x && size[1] <= plate.y && size[2] <= plate.z,
    degenerate,
  }
}

/**
 * What a printer owner should hear about a report, worst first: each line one
 * problem and what it means for the print. Empty when there is nothing to say.
 */
export function meshWarnings(r: MeshReport, plate: Plate): string[] {
  const out: string[] = []
  if (!r.fitsPlate) out.push(`it does not fit the ${plate.name} build volume (${plate.x} × ${plate.y} × ${plate.z} mm): it is ${fmt(r.size[0])} × ${fmt(r.size[1])} × ${fmt(r.size[2])} mm — scale it down or split it into parts`)
  if (!r.watertight) out.push(`it is not closed (${r.openEdges} open edge${r.openEdges === 1 ? '' : 's'}, ${r.nonManifoldEdges} edge${r.nonManifoldEdges === 1 ? '' : 's'} shared by more than two faces): the slicer may fill or drop parts of it`)
  if (r.insideOut) out.push('its faces point inward: a slicer reads it as empty — reverse the outline order (or the polyhedron faces)')
  if (r.shells > 1) out.push(`it is ${r.shells} separate pieces: each prints on its own; join them (union, overlap them by 0.01 mm or more) if they should be one part`)
  if (r.contactArea < 25 && r.size[2] > 2) out.push(`only ${fmt(r.contactArea)} mm² of it touches the plate: it may tip or come loose — give it a flat base, or slice with a brim`)
  if (r.overhangArea > 0) out.push(`${fmt(r.overhangArea / 100)} cm² hangs over air steeper than 45°: it needs supports there (slice with supports true) unless the design is turned to avoid it`)
  if (r.degenerate > 0) out.push(`${r.degenerate} triangle${r.degenerate === 1 ? ' has' : 's have'} no area (harmless, but a sign the mesh was made carelessly)`)
  return out
}

/** One decimal, no trailing ".0" for whole numbers past 100. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)
}
