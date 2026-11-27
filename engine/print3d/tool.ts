/**
 * engine/print3d/tool.ts — MakeModel, the project-chat tool that builds a
 * 3D-printable model from an OpenSCAD design in the project (or checks a mesh
 * already there) and, when asked, slices it for the owner's printer.
 *
 * The model writes and edits the design with the ordinary file tools; this
 * tool only builds what is in the file, so every change to a model is an
 * edit of its design, kept in the project history. It never talks to the
 * printer: the owner starts every print from Bambu Studio.
 */
import type { ToolImpl } from '../tools/types.js'
import { getProjectToolContext } from '../projects/tools.js'
import { projectDir } from '../projects/layout.js'
import { defaultDeps, makeModel, type MakeAsk, type MakeDeps } from './build.js'
import { MATERIALS, QUALITIES, type Quality } from './slicer.js'

let deps: MakeDeps = defaultDeps
/** Test seam: stand-in programs (OpenSCAD, Bambu Studio). `null` puts the real ones back. */
export function setMakeModelDeps(d: MakeDeps | null): void { deps = d ?? defaultDeps }

/** The asked-for settings, checked; or why the call is refused. */
export function parseAsk(input: Record<string, unknown>): { ok: true; ask: MakeAsk } | { ok: false; reason: string } {
  const ask: MakeAsk = { file: typeof input.file === 'string' ? input.file : '' }
  const bool = (k: string): boolean | undefined | 'bad' => input[k] === undefined || input[k] === null ? undefined : typeof input[k] === 'boolean' ? input[k] as boolean : input[k] === 'true' ? true : input[k] === 'false' ? false : 'bad'
  for (const k of ['slice', 'supports', 'brim'] as const) {
    const v = bool(k)
    if (v === 'bad') return { ok: false, reason: `${k} must be true or false` }
    if (v !== undefined) ask[k] = v
  }
  if (input.material !== undefined && input.material !== null && input.material !== '') ask.material = String(input.material)
  if (input.filament !== undefined && input.filament !== null && input.filament !== '') ask.filament = String(input.filament)
  if (input.quality !== undefined && input.quality !== null && input.quality !== '') {
    const q = String(input.quality).toLowerCase()
    if (!(QUALITIES as readonly string[]).includes(q)) return { ok: false, reason: `quality must be one of ${QUALITIES.join(', ')}` }
    ask.quality = q as Quality
  }
  if (input.walls !== undefined && input.walls !== null && input.walls !== '') {
    const n = Number(input.walls)
    if (!Number.isInteger(n) || n < 1 || n > 20) return { ok: false, reason: 'walls must be a whole number from 1 to 20' }
    ask.walls = n
  }
  if (input.infill !== undefined && input.infill !== null && input.infill !== '') {
    const n = Number(input.infill)
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, reason: 'infill must be a percentage from 0 to 100' }
    ask.infill = n
  }
  const slicing = ['material', 'filament', 'quality', 'supports', 'brim', 'walls', 'infill'].filter(k => (ask as Record<string, unknown>)[k] !== undefined)
  if (!ask.slice && slicing.length) return { ok: false, reason: `${slicing.join(', ')} ${slicing.length === 1 ? 'is a slice setting' : 'are slice settings'}: add slice true, or leave ${slicing.length === 1 ? 'it' : 'them'} out` }
  return { ok: true, ask }
}

export const makeModelTool: ToolImpl = {
  name: 'MakeModel',
  description: 'Build a 3D-printable model in this project. Write the design as an OpenSCAD file under models/ first (millimetres; Z is up; the part rests on Z=0 in the orientation it prints in; the dimensions that matter as named variables at the top), then call MakeModel with its path: the engine renders it, checks it (size, closed, one piece, overhangs, plate contact, fits the Bambu Lab P2S) and draws it from four sides into models/<name>/<name>.png. With slice true it also slices it with Bambu Studio\'s P2S presets for the material you name and leaves a print-ready models/<name>/<name>.3mf with the print time and grams. An .stl in the project can be given instead of a design. To change a model, edit its .scad and call MakeModel again. You never start a print: the owner prints from Bambu Studio.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The design\'s project path, e.g. models/wall-hook.scad (or a mesh, e.g. knowledge/part.stl)' },
      slice: { type: 'boolean', description: 'Also slice it for the printer: print time, grams, and a print-ready .3mf (default false)' },
      material: { type: 'string', enum: Object.keys(MATERIALS), description: 'The filament, when slicing (default PLA)' },
      filament: { type: 'string', description: 'An exact Bambu Studio filament preset name instead of material, e.g. "Bambu PLA Basic @BBL P2S"' },
      quality: { type: 'string', enum: [...QUALITIES], description: 'Layer height when slicing: draft 0.24 mm, standard 0.20 mm (default), fine 0.16 mm' },
      supports: { type: 'boolean', description: 'Tree supports on (true) or off (false); default the preset\'s (off)' },
      brim: { type: 'boolean', description: 'An 8 mm brim against lifting corners (ABS/ASA, small contact); default the preset\'s' },
      walls: { type: 'number', description: 'Wall loops (the preset has 2)' },
      infill: { type: 'number', description: 'Sparse infill percentage (the preset has 15)' },
    },
    required: ['file'],
  },
  tier: 'auto', core: false,
  execute: async (input, _cwd, signal) => {
    const ctx = getProjectToolContext()
    if (!ctx) return { output: 'MakeModel is only available inside a project chat.', isError: true }
    const parsed = parseAsk(input)
    if (!parsed.ok) return { output: `MakeModel: ${parsed.reason}`, isError: true }
    const r = await makeModel(projectDir(ctx.home, ctx.slug), parsed.ask, deps, signal)
    return { output: r.text, isError: !r.ok }
  },
}
