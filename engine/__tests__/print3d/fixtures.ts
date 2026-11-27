/**
 * Fixtures for engine/print3d's tests: boxes with outward faces
 * (counter-clockwise seen from outside) as binary or ASCII STL, and the P2S
 * presets as Bambu Studio ships them, cut to the keys that matter.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The 12 triangles of a box, nine numbers each. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const quads: number[][][] = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], // bottom, -Z
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // top, +Z
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // front, -Y
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // back, +Y
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // left, -X
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], // right, +X
  ]
  const out: number[] = []
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d)
  return out
}

/** The same triangles wound the other way: faces pointing inward. */
export function inward(tris: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < tris.length; i += 9) out.push(...tris.slice(i, i + 3), ...tris.slice(i + 6, i + 9), ...tris.slice(i + 3, i + 6))
  return out
}

export function binaryStl(tris: number[]): Uint8Array {
  const count = tris.length / 9
  const buf = new ArrayBuffer(84 + count * 50)
  const view = new DataView(buf)
  view.setUint32(80, count, true)
  for (let i = 0; i < count; i++) for (let k = 0; k < 9; k++) view.setFloat32(84 + i * 50 + 12 + k * 4, tris[i * 9 + k], true)
  return new Uint8Array(buf)
}

export function asciiStl(tris: number[]): Uint8Array {
  let s = 'solid test\n'
  for (let i = 0; i < tris.length; i += 9) {
    s += 'facet normal 0 0 0\nouter loop\n'
    for (let c = 0; c < 3; c++) s += `vertex ${tris[i + c * 3]} ${tris[i + c * 3 + 1]} ${tris[i + c * 3 + 2]}\n`
    s += 'endloop\nendfacet\n'
  }
  return new TextEncoder().encode(s + 'endsolid test\n')
}

/** The P2S presets as Bambu Studio ships them, cut to the keys that matter here. */
export function fakeProfiles(dir: string): string {
  const put = (kind: string, file: string, preset: Record<string, unknown>) => {
    mkdirSync(join(dir, kind), { recursive: true })
    writeFileSync(join(dir, kind, file), JSON.stringify(preset))
  }
  put('machine', 'fdm_machine_common.json', { name: 'fdm_machine_common', type: 'machine', from: 'system', instantiation: 'false', setting_id: 'COMMON', printable_area: ['0x0', '200x0', '200x200', '0x200'], printable_height: '200', machine_start_gcode: 'GENERIC START' })
  put('machine', 'Bambu Lab P2S 0.4 nozzle.json', { name: 'Bambu Lab P2S 0.4 nozzle', type: 'machine', inherits: 'fdm_machine_common', include: ['Bambu Lab P2S 0.4 nozzle template machine_start_gcode'], from: 'system', instantiation: 'true', printer_model: 'Bambu Lab P2S', printable_area: ['0x0', '256x0', '256x256', '0x256'], printable_height: '256' })
  put('machine', 'Bambu Lab P2S 0.4 nozzle template machine_start_gcode.json', { name: 'Bambu Lab P2S 0.4 nozzle template machine_start_gcode', instantiation: 'false', setting_id: 'TEMPLATE', machine_start_gcode: 'P2S START' })
  put('machine', 'Bambu Lab P2S.json', { name: 'Bambu Lab P2S', type: 'machine_model', default_bed_type: 'Textured PEI Plate' })
  put('process', 'fdm_process_common.json', { name: 'fdm_process_common', type: 'process', instantiation: 'false', wall_loops: '2', sparse_infill_density: '15%', enable_support: '0' })
  for (const [n, lh] of [['0.24mm Standard @BBL P2S', '0.24'], ['0.20mm Standard @BBL P2S', '0.2'], ['0.16mm Standard @BBL P2S', '0.16']]) {
    put('process', `${n}.json`, { name: n, type: 'process', inherits: 'fdm_process_common', instantiation: 'true', layer_height: lh, compatible_printers: ['Bambu Lab P2S 0.4 nozzle'] })
  }
  put('filament', 'fdm_filament_template.json', { name: 'fdm_filament_template', instantiation: 'false', filament_id: 'TEMPLATE-ID', nozzle_temperature: ['220'] })
  put('filament', 'Generic ASA @base.json', { name: 'Generic ASA @base', type: 'filament', instantiation: 'false', filament_id: 'GFB98', filament_type: ['ASA'] })
  put('filament', 'Generic ASA @BBL P2S.json', { name: 'Generic ASA @BBL P2S', type: 'filament', inherits: 'Generic ASA @base', include: ['fdm_filament_template'], instantiation: 'true', compatible_printers: ['Bambu Lab P2S 0.4 nozzle'] })
  put('filament', 'Generic PLA @BBL P2S.json', { name: 'Generic PLA @BBL P2S', type: 'filament', instantiation: 'true', filament_type: ['PLA'], compatible_printers: ['Bambu Lab P2S 0.4 nozzle'] })
  put('filament', 'Generic PETG @BBL X1C.json', { name: 'Generic PETG @BBL P2S', type: 'filament', instantiation: 'true', filament_type: ['PETG'], compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] })
  return dir
}
