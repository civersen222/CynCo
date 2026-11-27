/**
 * engine/print3d/render.ts — a picture of a mesh from four sides, drawn in software.
 *
 * One PNG sheet, 2 × 2 tiles: ISO (front-right, from above), FRONT, RIGHT and
 * TOP, each fitted to its tile, with a 10 mm grid on the plate under the part
 * and the part's size written on the sheet. Faces are flat-shaded with a
 * light from the viewer; a face seen from behind (a hole in the mesh, or
 * faces pointing inward) is drawn red, so a broken mesh shows. Edges are
 * found from jumps in depth and darkened. No GPU, no OpenGL context and no
 * program: the engine may run where OpenSCAD's own PNG export has no screen
 * to draw on. Pure apart from the PNG encoder (pngjs).
 */
import { PNG } from 'pngjs'
import { bounds, fmt, type Mesh } from './mesh.js'

type Vec = [number, number, number]
type View = { label: string; eye: Vec; up: Vec }

/** Z is up, -Y is the front, +X is the right: the slicer's own convention. */
const VIEWS: View[] = [
  { label: 'ISO', eye: [1, -1, 0.9], up: [0, 0, 1] },
  { label: 'FRONT', eye: [0, -1, 0], up: [0, 0, 1] },
  { label: 'RIGHT', eye: [1, 0, 0], up: [0, 0, 1] },
  { label: 'TOP', eye: [0, 0, 1], up: [0, 1, 0] },
]

const BACKGROUND: Vec = [246, 247, 249]
const GRID: Vec = [205, 210, 218]
const BODY: Vec = [74, 134, 204]
const BACKFACE: Vec = [214, 69, 65]
const INK: Vec = [40, 44, 52]
/** Grid spacing in mm. */
const GRID_MM = 10

export const DEFAULT_TILE_PX = 480

function norm(v: Vec): Vec { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
function cross(a: Vec, b: Vec): Vec { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
function dot(a: Vec, b: Vec): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }

/** The four-view sheet as PNG bytes. `title` is written under the size (ASCII; anything else is dropped). */
export function renderSheet(mesh: Mesh, opts: { tilePx?: number; title?: string } = {}): Uint8Array {
  const tile = Math.max(160, Math.min(1024, Math.round(opts.tilePx ?? DEFAULT_TILE_PX)))
  const W = tile * 2, H = tile * 2
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = BACKGROUND[0]; rgba[i * 4 + 1] = BACKGROUND[1]; rgba[i * 4 + 2] = BACKGROUND[2]; rgba[i * 4 + 3] = 255 }
  const box = bounds(mesh)
  VIEWS.forEach((view, i) => drawView(mesh, box, view, rgba, W, (i % 2) * tile, Math.floor(i / 2) * tile, tile))
  // Tile borders.
  for (let x = 0; x < W; x++) { setPx(rgba, W, x, tile, GRID); }
  for (let y = 0; y < H; y++) { setPx(rgba, W, tile, y, GRID) }
  const size = `${fmt(box.max[0] - box.min[0])} X ${fmt(box.max[1] - box.min[1])} X ${fmt(box.max[2] - box.min[2])} MM`
  const scale = tile >= 400 ? 2 : 1
  drawText(rgba, W, H, 10, tile - 7 * scale - 10 - (opts.title ? 9 * scale : 0), size, scale)
  if (opts.title) drawText(rgba, W, H, 10, tile - 7 * scale - 8, opts.title, scale)
  drawText(rgba, W, H, tile + 10, tile - 7 * scale - 8, `GRID ${GRID_MM} MM`, scale)
  const png = new PNG({ width: W, height: H })
  rgba.copy(png.data)
  return new Uint8Array(PNG.sync.write(png, { colorType: 2 }))
}

function setPx(rgba: Buffer, W: number, x: number, y: number, c: Vec): void {
  const o = (y * W + x) * 4
  rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]
}

function drawView(mesh: Mesh, box: { min: Vec; max: Vec }, view: View, rgba: Buffer, W: number, ox: number, oy: number, tile: number): void {
  const back = norm(view.eye) // from the part towards the viewer
  const right = norm(cross(view.up, back))
  const up = cross(back, right)
  const t = mesh.tris
  const center: Vec = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]

  // The grid on the plate: every 10 mm across the part's footprint and a margin.
  const gz = box.min[2]
  const gx0 = Math.floor((box.min[0] - GRID_MM) / GRID_MM) * GRID_MM, gx1 = Math.ceil((box.max[0] + GRID_MM) / GRID_MM) * GRID_MM
  const gy0 = Math.floor((box.min[1] - GRID_MM) / GRID_MM) * GRID_MM, gy1 = Math.ceil((box.max[1] + GRID_MM) / GRID_MM) * GRID_MM

  // Fit: the projected extent of the part and its grid, with a margin and room for the label.
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity
  const fitPoint = (p: Vec) => {
    const q: Vec = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
    const x = dot(q, right), y = dot(q, up)
    if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y
  }
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) fitPoint([x, y, z])
  for (const x of [gx0, gx1]) for (const y of [gy0, gy1]) fitPoint([x, y, gz])
  const margin = Math.round(tile * 0.07), labelRoom = Math.round(tile * 0.06)
  const span = Math.max(sx1 - sx0, sy1 - sy0) || 1
  const scale = Math.min((tile - 2 * margin) / Math.max(sx1 - sx0, 1e-9), (tile - 2 * margin - 2 * labelRoom) / Math.max(sy1 - sy0, 1e-9))
  const cx = ox + tile / 2 - ((sx0 + sx1) / 2) * scale
  const cy = oy + tile / 2 + ((sy0 + sy1) / 2) * scale
  const project = (x: number, y: number, z: number): Vec => {
    const q: Vec = [x - center[0], y - center[1], z - center[2]]
    return [cx + dot(q, right) * scale, cy - dot(q, up) * scale, dot(q, back)]
  }

  const depth = new Float32Array(tile * tile).fill(-Infinity)
  const at = (x: number, y: number) => (y - oy) * tile + (x - ox)
  const key = norm([0.4, -0.3, 1])

  for (let i = 0; i < mesh.count; i++) {
    const o = i * 9
    const a = project(t[o], t[o + 1], t[o + 2]), b = project(t[o + 3], t[o + 4], t[o + 5]), c = project(t[o + 6], t[o + 7], t[o + 8])
    const n = norm(cross([t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]], [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]]))
    const facing = dot(n, back)
    let color: Vec
    if (facing < 0) {
      color = BACKFACE
    } else {
      const light = 0.32 + 0.5 * facing + 0.22 * Math.max(0, dot(n, key))
      color = [Math.min(255, BODY[0] * light), Math.min(255, BODY[1] * light), Math.min(255, BODY[2] * light)]
    }
    fillTriangle(a, b, c, color, rgba, W, depth, at, ox, oy, tile)
  }

  // Edges: a pixel whose depth jumps against a neighbour (or that borders empty space) is darkened.
  const jump = span * 0.012
  const shaded = new Uint8Array(tile * tile)
  for (let y = oy; y < oy + tile; y++) {
    for (let x = ox; x < ox + tile; x++) {
      const d = depth[at(x, y)]
      if (d === -Infinity) continue
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        const nd = nx < ox || ny < oy || nx >= ox + tile || ny >= oy + tile ? -Infinity : depth[at(nx, ny)]
        if (nd === -Infinity || d - nd > jump) { shaded[at(x, y)] = 1; break }
      }
    }
  }
  for (let y = oy; y < oy + tile; y++) {
    for (let x = ox; x < ox + tile; x++) {
      if (!shaded[at(x, y)]) continue
      const p = (y * W + x) * 4
      rgba[p] = rgba[p] * 0.45; rgba[p + 1] = rgba[p + 1] * 0.45; rgba[p + 2] = rgba[p + 2] * 0.45
    }
  }

  // The grid, behind the part where the part is nearer.
  for (let gx = gx0; gx <= gx1 + 1e-9; gx += GRID_MM) line(project(gx, gy0, gz), project(gx, gy1, gz), rgba, W, depth, at, ox, oy, tile)
  for (let gy = gy0; gy <= gy1 + 1e-9; gy += GRID_MM) line(project(gx0, gy, gz), project(gx1, gy, gz), rgba, W, depth, at, ox, oy, tile)

  const s = tile >= 400 ? 2 : 1
  drawText(rgba, W, W, ox + 10, oy + 10, view.label, s) // the sheet is square
}

function fillTriangle(a: Vec, b: Vec, c: Vec, color: Vec, rgba: Buffer, W: number, depth: Float32Array, at: (x: number, y: number) => number, ox: number, oy: number, tile: number): void {
  const minX = Math.max(ox, Math.floor(Math.min(a[0], b[0], c[0])))
  const maxX = Math.min(ox + tile - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const minY = Math.max(oy, Math.floor(Math.min(a[1], b[1], c[1])))
  const maxY = Math.min(oy + tile - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  if (minX > maxX || minY > maxY) return
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  if (area === 0) return
  const r = Math.round(color[0]), g = Math.round(color[1]), bl = Math.round(color[2])
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area
      const w2 = 1 - w0 - w1
      if (w0 < 0 || w1 < 0 || w2 < 0) continue
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2]
      const i = at(x, y)
      if (z <= depth[i]) continue
      depth[i] = z
      const o = (y * W + x) * 4
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl
    }
  }
}

function line(a: Vec, b: Vec, rgba: Buffer, W: number, depth: Float32Array, at: (x: number, y: number) => number, ox: number, oy: number, tile: number): void {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1
  if (!Number.isFinite(steps) || steps > tile * 4) return
  for (let s = 0; s <= steps; s++) {
    const f = s / steps
    const x = Math.round(a[0] + (b[0] - a[0]) * f), y = Math.round(a[1] + (b[1] - a[1]) * f)
    if (x < ox || y < oy || x >= ox + tile || y >= oy + tile) continue
    const z = a[2] + (b[2] - a[2]) * f
    // Behind the part: hidden. Allow a small lead so the grid under the part's base still shows at its edge.
    if (depth[at(x, y)] !== -Infinity && depth[at(x, y)] > z + 1e-6) continue
    setPx(rgba, W, x, y, GRID)
  }
}

// ── A 5×7 bitmap font: upper-case letters, digits and . - / ──────────────────
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], '-': [0, 0, 0, 0x1f, 0, 0, 0], '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  ' ': [0, 0, 0, 0, 0, 0, 0],
}

/** Draw upper-cased ASCII text; a character the font lacks is skipped. Clipped to the sheet. */
export function drawText(rgba: Buffer, W: number, H: number, x: number, y: number, text: string, scale = 1): void {
  let cx = x
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch]
    if (!g) continue
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(g[row] & (0x10 >> col))) continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const px = cx + col * scale + sx, py = y + row * scale + sy
          if (px >= 0 && py >= 0 && px < W && py < H) setPx(rgba, W, px, py, INK)
        }
      }
    }
    cx += 6 * scale
  }
}
