/**
 * engine/print3d/slicer.ts — slice an STL for the owner's printer with Bambu
 * Studio's own command line and presets, and read back how long it prints and
 * how much filament it takes.
 *
 * The presets are Bambu Studio's system presets (`resources/profiles/BBL`),
 * flattened through their `inherits` chain and written unchanged apart from
 * the few settings the call asks for (supports, brim, walls, infill) and the
 * build plate, which Bambu Studio keeps in the project rather than in a
 * preset — left out, the command line assumes a Cool Plate (the approach of
 * bambu-studio-ai, MIT, credited in CREDITS.md). The start, end and
 * filament-change G-code in them are what the printer needs and are never
 * edited. The output is a Bambu Studio project with the plate's G-code: the
 * owner opens it in Bambu Studio and presses Print. Nothing here talks to the
 * printer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import type { Plate } from './mesh.js'
import type { Runner } from './run.js'

/** The owner's printer (2026-11-27: a Bambu Lab P2S Combo with the 0.4 mm nozzle it ships with). */
export const PRINTER = {
  name: 'Bambu Lab P2S',
  machine: 'Bambu Lab P2S 0.4 nozzle',
  /** Used when Bambu Studio is not installed to read the build volume from its preset (read from it on 2026-11-27). */
  plate: { name: 'Bambu Lab P2S', x: 256, y: 256, z: 256 } as Plate,
  /** The plate the P2S ships with (`default_bed_type` of the "Bambu Lab P2S" machine model). */
  bed: 'Textured PEI Plate',
} as const

export const QUALITIES = ['draft', 'standard', 'fine'] as const
export type Quality = (typeof QUALITIES)[number]
const PROCESS: Record<Quality, string> = {
  draft: '0.24mm Standard @BBL P2S',
  standard: '0.20mm Standard @BBL P2S',
  fine: '0.16mm Standard @BBL P2S',
}

/**
 * A material name → the generic Bambu preset for it on the P2S. Generic, not
 * Bambu's own brand: the owner's spools are third-party (OVERTURE PLA+,
 * Polymaker ASA and TPU). An exact preset name can be asked for instead.
 */
export const MATERIALS: Record<string, string> = {
  PLA: 'Generic PLA @BBL P2S',
  'PLA-CF': 'Generic PLA-CF @BBL P2S',
  PETG: 'Generic PETG @BBL P2S',
  'PETG-CF': 'Generic PETG-CF @BBL P2S',
  ABS: 'Generic ABS @BBL P2S',
  ASA: 'Generic ASA @BBL P2S',
  PC: 'Generic PC @BBL P2S',
  PA: 'Generic PA @BBL P2S',
  TPU: 'Generic TPU @BBL P2S',
}

/** A slice of an ordinary part takes seconds; a large detailed one under a minute. */
export const SLICE_CAP_MS = 300_000

export const BAMBU_MISSING = 'Bambu Studio is not installed on this PC (looked in Program Files and /Applications); slicing needs it — the design is built and checked without it'

/** Bambu Studio's program and its BBL preset folder, or null. */
export function findBambuStudio(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): { program: string; profiles: string } | null {
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!root) continue
      const dir = join(root, 'Bambu Studio')
      const program = join(dir, 'bambu-studio.exe'), profiles = join(dir, 'resources', 'profiles', 'BBL')
      if (exists(program) && exists(profiles)) return { program, profiles }
    }
    return null
  }
  if (platform === 'darwin') {
    const app = '/Applications/BambuStudio.app/Contents'
    const program = `${app}/MacOS/BambuStudio`, profiles = `${app}/Resources/profiles/BBL`
    return exists(program) && exists(profiles) ? { program, profiles } : null
  }
  return null
}

type Preset = Record<string, unknown>
type Library = { machine: Map<string, Preset>; process: Map<string, Preset>; filament: Map<string, Preset> }

/** Presets by name, read once per folder and again when the folder changes (a Bambu Studio update). */
const libraries = new Map<string, { stamp: number; lib: Library }>()

function readLibrary(profiles: string): Library {
  let stamp = 0
  for (const kind of ['machine', 'process', 'filament']) {
    // A missing folder reads as empty below, where its listing fails with the reason logged.
    if (existsSync(join(profiles, kind))) stamp = Math.max(stamp, statSync(join(profiles, kind)).mtimeMs)
  }
  const cached = libraries.get(profiles)
  if (cached && cached.stamp === stamp) return cached.lib
  const lib: Library = { machine: new Map(), process: new Map(), filament: new Map() }
  for (const kind of ['machine', 'process', 'filament'] as const) {
    let names: string[] = []
    try { names = readdirSync(join(profiles, kind)) } catch (e) { console.log(`[print3d] reading ${kind} presets failed: ${(e as Error).message}`) }
    for (const f of names) {
      if (!f.endsWith('.json')) continue
      try {
        const p = JSON.parse(readFileSync(join(profiles, kind, f), 'utf8')) as Preset
        if (typeof p.name === 'string') lib[kind].set(p.name, p)
      } catch (e) {
        console.log(`[print3d] preset ${kind}/${f} unreadable: ${(e as Error).message}`)
      }
    }
  }
  libraries.set(profiles, { stamp, lib })
  return lib
}

/** A preset's identity: Bambu Studio reads these from the preset's own file only, so a parent's or a template's never leak into it. */
const LEAF_ONLY_KEYS = new Set(['name', 'setting_id', 'instantiation', 'from', 'type'])
/** The links flattening resolves. */
const LINK_KEYS = new Set(['inherits', 'include'])
/** A filament's id comes from the preset or its parent, never from an included template. */
const NOT_FROM_INCLUDES = new Set([...LEAF_ONLY_KEYS, ...LINK_KEYS, 'filament_id'])

/**
 * A preset as one full config, in the order Bambu Studio loads system presets:
 * the parent chain (`inherits`), then the templates it pulls in (`include` —
 * the P2S machine's start, end and filament-change G-code live there), then
 * its own keys. The command line resolves neither link: a bare leaf falls
 * back to built-in defaults, G-code included. Null when a link is missing or
 * the chain loops.
 */
export function flatten(presets: Map<string, Preset>, name: string, chain: readonly string[] = []): Preset | null {
  if (chain.includes(name) || chain.length > 20) return null
  const own = presets.get(name)
  if (!own) return null
  const next = [...chain, name]
  const out: Preset = {}
  if (typeof own.inherits === 'string' && own.inherits) {
    const parent = flatten(presets, own.inherits, next)
    if (parent === null) return null
    for (const [k, v] of Object.entries(parent)) if (!LEAF_ONLY_KEYS.has(k)) out[k] = v
  }
  const includes = Array.isArray(own.include) ? own.include : typeof own.include === 'string' ? [own.include] : []
  for (const inc of includes) {
    if (typeof inc !== 'string') continue
    const t = flatten(presets, inc, next)
    if (t === null) return null
    for (const [k, v] of Object.entries(t)) if (!NOT_FROM_INCLUDES.has(k)) out[k] = v
  }
  for (const [k, v] of Object.entries(own)) if (!LINK_KEYS.has(k)) out[k] = v
  return out
}

/** The build volume the machine preset gives (`printable_area` corners, `printable_height`), or the fixed one. */
export function plateOf(profiles: string | null): Plate {
  if (!profiles) return PRINTER.plate
  const m = flatten(readLibrary(profiles).machine, PRINTER.machine)
  if (!m) return PRINTER.plate
  const corners = Array.isArray(m.printable_area) ? (m.printable_area as unknown[]).map(c => String(c).split('x').map(Number)) : []
  const xs = corners.map(c => c[0]).filter(Number.isFinite), ys = corners.map(c => c[1]).filter(Number.isFinite)
  const z = Number(m.printable_height)
  if (xs.length < 3 || ys.length < 3 || !Number.isFinite(z) || z <= 0) return PRINTER.plate
  return { name: PRINTER.name, x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys), z }
}

export type SliceAsk = { material?: string; filament?: string; quality?: Quality; supports?: boolean; brim?: boolean; walls?: number; infill?: number }

export type SliceChoice = { machine: string; process: string; filament: string; material: string; bed: string; machinePreset: Preset; processPreset: Preset; filamentPreset: Preset }

/** The three presets for an ask, or why there are none (naming what there is). */
export function choosePresets(profiles: string, ask: SliceAsk): { ok: true; choice: SliceChoice } | { ok: false; reason: string } {
  const lib = readLibrary(profiles)
  const machinePreset = flatten(lib.machine, PRINTER.machine)
  if (!machinePreset) return { ok: false, reason: `Bambu Studio has no "${PRINTER.machine}" preset — update Bambu Studio` }
  const quality = ask.quality ?? 'standard'
  const processName = PROCESS[quality]
  const processPreset = flatten(lib.process, processName)
  if (!processPreset) return { ok: false, reason: `Bambu Studio has no "${processName}" preset — update Bambu Studio` }
  let filamentName: string
  if (ask.filament) {
    filamentName = ask.filament
  } else {
    const material = (ask.material ?? 'PLA').trim().toUpperCase()
    const named = MATERIALS[material]
    if (!named) return { ok: false, reason: `no material "${ask.material}" — one of ${Object.keys(MATERIALS).join(', ')}, or an exact Bambu Studio filament preset name in "filament"` }
    filamentName = named
  }
  const filamentPreset = flatten(lib.filament, filamentName)
  if (!filamentPreset) {
    const close = [...lib.filament.keys()].filter(n => n.endsWith('@BBL P2S') && n.toLowerCase().includes(filamentName.split(' @')[0].toLowerCase().split(' ').pop() ?? '')).slice(0, 8)
    return { ok: false, reason: `Bambu Studio has no filament preset "${filamentName}"${close.length ? ` — for the P2S there are: ${close.join('; ')}` : ''}` }
  }
  const compatible = Array.isArray(filamentPreset.compatible_printers) ? (filamentPreset.compatible_printers as unknown[]).map(String) : []
  if (compatible.length > 0 && !compatible.includes(PRINTER.machine)) return { ok: false, reason: `the filament preset "${filamentName}" is not for the ${PRINTER.machine}` }
  const type = Array.isArray(filamentPreset.filament_type) ? String((filamentPreset.filament_type as unknown[])[0]) : String(filamentPreset.filament_type ?? '')
  const model = lib.machine.get(PRINTER.name)
  const bed = typeof model?.default_bed_type === 'string' && model.default_bed_type ? model.default_bed_type : PRINTER.bed
  return { ok: true, choice: { machine: PRINTER.machine, process: processName, filament: filamentName, material: type || filamentName, bed, machinePreset, processPreset, filamentPreset } }
}

/** The process preset with the asked-for settings applied, as Bambu Studio spells them. */
export function processSettings(choice: SliceChoice, ask: SliceAsk): Preset {
  const p: Preset = { ...choice.processPreset, curr_bed_type: choice.bed }
  if (ask.supports !== undefined) { p.enable_support = ask.supports ? '1' : '0'; if (ask.supports) p.support_type = 'tree(auto)' }
  if (ask.brim !== undefined) { p.brim_type = ask.brim ? 'outer_only' : 'no_brim'; if (ask.brim) p.brim_width = '8' }
  if (ask.walls !== undefined) p.wall_loops = String(ask.walls)
  if (ask.infill !== undefined) p.sparse_infill_density = `${ask.infill}%`
  return p
}

export type Estimate = { seconds: number; grams: number; warning: string; version: string }

/** Read the estimate out of the command line's result.json (Bambu Studio 02.07 and later). */
export function readEstimate(json: unknown): { ok: true; estimate: Omit<Estimate, 'version'> } | { ok: false; reason: string } {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'result.json is not an object' }
  const r = json as Record<string, unknown>
  if (typeof r.return_code === 'number' && r.return_code !== 0) return { ok: false, reason: `Bambu Studio: ${String(r.error_string ?? 'failed')} (code ${r.return_code})` }
  const plates = Array.isArray(r.sliced_plates) ? r.sliced_plates as Array<Record<string, unknown>> : []
  if (plates.length === 0) return { ok: false, reason: 'Bambu Studio sliced no plate' }
  let seconds = 0, grams = 0
  const warnings: string[] = []
  for (const p of plates) {
    const t = Number(p.total_predication ?? p.main_predication)
    if (Number.isFinite(t)) seconds += t
    for (const f of Array.isArray(p.filaments) ? p.filaments as Array<Record<string, unknown>> : []) {
      const g = Number(f.total_used_g ?? f.main_used_g)
      if (Number.isFinite(g)) grams += g
    }
    if (typeof p.warning_message === 'string' && p.warning_message.trim()) warnings.push(p.warning_message.trim())
  }
  return { ok: true, estimate: { seconds, grams, warning: warnings.join(' ') } }
}

/** "1 h 12 min", "8 min", "45 s". */
export function duration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/**
 * Slice `stl` in `workDir` (a fresh folder the engine owns): writes the three
 * presets there, runs the command line, and leaves `sliced.3mf` and
 * `result.json` in it. The caller moves the 3MF into place and removes the folder.
 */
export async function slice(o: { program: string; stl: string; workDir: string; choice: SliceChoice; ask: SliceAsk; run: Runner; signal?: AbortSignal; capMs?: number; write: (path: string, text: string) => void }): Promise<{ ok: true; estimate: Estimate; ms: number } | { ok: false; reason: string; ms: number }> {
  o.write(join(o.workDir, 'machine.json'), JSON.stringify(o.choice.machinePreset, null, 2))
  o.write(join(o.workDir, 'process.json'), JSON.stringify(processSettings(o.choice, o.ask), null, 2))
  o.write(join(o.workDir, 'filament.json'), JSON.stringify(o.choice.filamentPreset, null, 2))
  // The export name is relative on purpose: with --outputdir the command line prefixes it with that folder.
  const args = [
    '--load-settings', `${join(o.workDir, 'machine.json')};${join(o.workDir, 'process.json')}`,
    '--load-filaments', join(o.workDir, 'filament.json'),
    '--arrange', '1', '--orient', '0', '--slice', '0',
    '--outputdir', o.workDir, '--export-3mf', 'sliced.3mf', o.stl,
  ]
  const r = await o.run(o.program, args, { cwd: o.workDir, capMs: o.capMs ?? SLICE_CAP_MS, ...(o.signal ? { signal: o.signal } : {}) })
  if (r.refused !== null) return { ok: false, reason: `Bambu Studio did not run: ${r.refused}`, ms: r.ms }
  if (r.stopped) return { ok: false, reason: 'stopped before Bambu Studio finished slicing', ms: r.ms }
  if (r.timedOut) return { ok: false, reason: `Bambu Studio did not finish slicing within ${Math.round((o.capMs ?? SLICE_CAP_MS) / 1000)} s`, ms: r.ms }
  let result: unknown = null
  let unread = ''
  try { result = JSON.parse(readFileSync(join(o.workDir, 'result.json'), 'utf8')) } catch (e) { unread = (e as Error).message }
  if (unread) console.log(`[print3d] result.json not read: ${unread.slice(0, 200)}`)
  const tail = `${r.stderr}\n${r.stdout}`.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 600)
  if (result === null) return { ok: false, reason: `Bambu Studio exited with code ${r.code} and wrote no result.json${tail ? ` (${tail})` : ''}`, ms: r.ms }
  const est = readEstimate(result)
  if (!est.ok) return { ok: false, reason: est.reason, ms: r.ms }
  const sliced = join(o.workDir, 'sliced.3mf')
  if (!existsSync(sliced)) return { ok: false, reason: `Bambu Studio reported success but wrote no sliced 3MF${tail ? ` (${tail})` : ''}`, ms: r.ms }
  return { ok: true, estimate: { ...est.estimate, version: slicerVersion(sliced) }, ms: r.ms }
}

/** The slicer's version as the sliced project records it (`X-BBL-Client-Version` in Metadata/slice_info.config); '' when unreadable. */
export function slicerVersion(threeMf: string): string {
  try {
    const files = unzipSync(new Uint8Array(readFileSync(threeMf)), { filter: f => f.name === 'Metadata/slice_info.config' && f.originalSize < 1_000_000 })
    const xml = files['Metadata/slice_info.config']
    if (!xml) return ''
    return /key="X-BBL-Client-Version"\s+value="([0-9.]{1,40})"/.exec(new TextDecoder().decode(xml))?.[1] ?? ''
  } catch (e) {
    console.log(`[print3d] reading the slicer version from ${threeMf} failed: ${(e as Error).message}`)
    return ''
  }
}
