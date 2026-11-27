/**
 * engine/print3d/build.ts — one MakeModel call: a design (or a mesh) in a
 * project becomes a checked mesh, a picture from four sides and, when asked,
 * a print-ready Bambu Studio project, all under `models/` beside a report.
 *
 * Where things land: a source `models/<path>.scad` (or `.stl`) builds into
 * `models/<path>/`; a mesh anywhere else in the project into
 * `models/<its name>/`. Every name in the output path is a slug, so the
 * picture and the mesh can always be shown by the chat (the file route's
 * path rule). In the output folder: `<name>.stl`, `<name>.png`,
 * `<name>.3mf` (only after a slice), `report.json` and a `.gitignore` that
 * keeps the built files out of the project history — they are made again
 * from the design, which is committed with the report on every build, so
 * the history of a model is the history of its design.
 *
 * The model can write anywhere in the project, links included
 * (`gradeProjectCall`), so the engine never writes through anything planted:
 * every folder on the way is a real folder inside the project, OpenSCAD and
 * Bambu Studio write into a fresh folder under `.cynco/tmp/`, and each output
 * is renamed into place (a link at the target is replaced, never followed).
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appendJournal, isInside, realInside, slugify, writeBytesAtomic, writeJsonAtomic } from '../projects/layout.js'
import { commitHistory, ensureHistory } from '../projects/history.js'
import { analyzeMesh, fmt, meshWarnings, readStl, STL_MAX_BYTES, type MeshReport, type Plate } from './mesh.js'
import { buildStl, findOpenScad, OPENSCAD_MISSING, openScadVersion, referenceFault, type ScadMessages } from './openscad.js'
import { renderSheet } from './render.js'
import { runProgram, type Runner } from './run.js'
import { BAMBU_MISSING, choosePresets, duration, findBambuStudio, plateOf, PRINTER, slice, type Quality, type SliceAsk } from './slicer.js'

export type MakeAsk = { file: string; slice?: boolean } & SliceAsk

export type MakeDeps = {
  run: Runner
  openscad: () => string | null
  bambu: () => { program: string; profiles: string } | null
  now: () => Date
}

export const defaultDeps: MakeDeps = {
  run: runProgram,
  openscad: () => findOpenScad(),
  bambu: () => findBambuStudio(),
  now: () => new Date(),
}

export type ModelReport = {
  schema: 1
  source: string
  sourceSha256: string
  builtAt: string
  openscad: string | null
  plate: Plate
  files: { stl: string; png: string; threeMf: string | null }
  mesh: Omit<MeshReport, 'min' | 'max'> & { min: number[]; max: number[] }
  warnings: string[]
  slice: null | {
    printer: string; machine: string; process: string; filament: string; material: string; bed: string
    quality: Quality; supports: boolean | null; brim: boolean | null; walls: number | null; infill: number | null
    seconds: number; grams: number; slicer: string; warning: string
  }
  sliceError: string | null
}

export type MakeResult = { ok: boolean; text: string; report?: ModelReport }

const SOURCE_EXTS = ['.scad', '.stl']
const GITIGNORE = '# Written by CynCo (MakeModel): the built files are made again from the design; the report is history.\n*\n!.gitignore\n!report.json\n'

/** The project-relative output folder for a source path ("models/a/Hook.scad" → "models/a/hook"). */
export function outputFolder(sourceRel: string): string {
  const noExt = sourceRel.replace(/\.[^./]+$/, '')
  const segs = noExt.split('/').filter(Boolean)
  const kept = segs[0] === 'models' && segs.length > 1 ? segs.slice(1) : [segs[segs.length - 1] ?? 'model']
  return ['models', ...kept.map(s => slugify(s))].join('/')
}

/** Why the engine must not write into `rel` (each folder on the way a real folder inside the project), or null. */
function folderFault(dir: string, rel: string): string | null {
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/')
    const p = join(dir, sub)
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) return `${sub}/ in the project is a link; models are written only into real folders inside it — refused`
      if (!st.isDirectory()) return `${sub} in the project is a file, not a folder; rename it — refused`
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null // nothing further down exists either; mkdir makes real folders
      return `${sub}/ in the project could not be checked (${code ?? (e as Error).message}) — refused`
    }
  }
  const r = realInside(dir, join(dir, rel))
  return r.inside ? null : `${rel}/ leads outside the project (${r.real}) — refused`
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** A regular file with one name, really inside the project, read under a cap; or why not. */
function readSourceFile(dir: string, rel: string, cap: number): { ok: true; abs: string; bytes: Uint8Array } | { ok: false; reason: string } {
  const abs = resolve(dir, rel)
  if (!isInside(dir, abs)) return { ok: false, reason: `${rel} is outside this project` }
  const r = realInside(dir, abs)
  if (!r.inside) return { ok: false, reason: `${rel} leads outside this project (${r.real})` }
  let size: number
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { ok: false, reason: `${rel} is not a file` }
    if (st.nlink > 1) return { ok: false, reason: `${rel} has a second name (a hard link): its content may live outside the project — refused` }
    size = st.size
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { ok: false, reason: code === 'ENOENT' ? `${rel} is not in this project — write the design first` : `${rel} could not be read (${code ?? (e as Error).message})` }
  }
  if (size > cap) return { ok: false, reason: `${rel} is larger than ${Math.round(cap / 1024 / 1024)} MiB` }
  return { ok: true, abs, bytes: new Uint8Array(readFileSync(abs)) }
}

/** Build one model. Never throws: every failure is a named reason in the text. */
export async function makeModel(dir: string, ask: MakeAsk, deps: MakeDeps = defaultDeps, signal?: AbortSignal): Promise<MakeResult> {
  const rel = String(ask.file ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
  if (!rel) return fail('file is required: the project path of an OpenSCAD design (models/<name>.scad) or a mesh (.stl)')
  if (!SOURCE_EXTS.includes(ext)) return fail(`${rel} is not a design or a mesh: give a .scad file (write the design under models/ first) or an .stl`)
  const source = readSourceFile(dir, rel, ext === '.stl' ? STL_MAX_BYTES : 4 * 1024 * 1024)
  if (!source.ok) return fail(source.reason)

  const outRel = outputFolder(rel)
  const name = outRel.split('/').pop()!
  for (const f of [folderFault(dir, outRel), folderFault(dir, '.cynco/tmp')]) if (f) return fail(f)
  mkdirSync(join(dir, outRel), { recursive: true })
  mkdirSync(join(dir, '.cynco', 'tmp'), { recursive: true })
  const work = mkdtempSync(join(dir, '.cynco', 'tmp', 'model-'))
  try {
    return await buildIn(dir, rel, ext, source.abs, source.bytes, outRel, name, work, ask, deps, signal)
  } catch (e) {
    console.log(`[print3d] building ${rel} threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    return fail(`building ${rel} failed inside the engine (${e instanceof Error ? e.message : String(e)})`)
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch (e) { console.log(`[print3d] could not remove ${work}: ${(e as Error).message}`) }
  }
}

function fail(reason: string, extra = ''): MakeResult {
  return { ok: false, text: `MakeModel: ${reason}${extra ? `\n${extra}` : ''}` }
}

async function buildIn(dir: string, rel: string, ext: string, abs: string, sourceBytes: Uint8Array, outRel: string, name: string, work: string, ask: MakeAsk, deps: MakeDeps, signal?: AbortSignal): Promise<MakeResult> {
  let stlBytes: Uint8Array
  let messages: ScadMessages = { errors: [], warnings: [], echoes: [] }
  let openscadVersion: string | null = null
  let buildMs = 0
  // The engine's own copy of the mesh, in the work folder: what is measured, drawn and sliced.
  // Named after the model, since the slicer names the object in the print-ready project after its file.
  const workStl = join(work, `${name}.stl`)
  if (ext === '.scad') {
    const fault = referenceFault(abs, dir)
    if (fault) return fail(`the design was not built: ${fault}`)
    const openscad = deps.openscad()
    if (!openscad) return fail(OPENSCAD_MISSING)
    openscadVersion = await openScadVersion(openscad, deps.run)
    const built = await buildStl({ openscad, sourceAbs: abs, outStl: workStl, run: deps.run, ...(signal ? { signal } : {}) })
    messages = built.messages
    buildMs = built.ms
    if (!built.ok) return fail(`${rel} was not built: ${built.reason}`, scadLines(messages))
    stlBytes = new Uint8Array(readFileSync(workStl))
  } else {
    stlBytes = sourceBytes
    writeFileSync(workStl, stlBytes, { flag: 'wx' })
  }

  const read = readStl(stlBytes)
  if (!read.ok) return fail(`${ext === '.scad' ? 'OpenSCAD\'s output' : rel} could not be read as a mesh: ${read.reason}`, scadLines(messages))
  const bambu = deps.bambu()
  const plate = plateOf(bambu?.profiles ?? null)
  const mesh = analyzeMesh(read.mesh, plate)
  const warnings = meshWarnings(mesh, plate)
  const png = renderSheet(read.mesh, { title: name.replace(/-/g, ' ') })

  const files = { stl: `${outRel}/${name}.stl`, png: `${outRel}/${name}.png`, threeMf: null as string | null }
  writeBytesAtomic(join(dir, files.stl), stlBytes)
  writeBytesAtomic(join(dir, files.png), png)
  writeIgnore(join(dir, outRel, '.gitignore'))

  // The slice, when asked; otherwise a print-ready file left from an older version of the design goes.
  const threeMfRel = `${outRel}/${name}.3mf`
  let sliceLine = ''
  let sliceError: string | null = null
  let sliced: ModelReport['slice'] = null
  if (ask.slice) {
    const r = await sliceInto(dir, work, workStl, threeMfRel, mesh.fitsPlate, plate, ask, deps, bambu, signal)
    if (r.ok) { sliced = r.slice; files.threeMf = threeMfRel; sliceLine = r.line } else { sliceError = r.reason; sliceLine = `NOT SLICED: ${r.reason}` }
  }
  if (!files.threeMf && removeStale(join(dir, threeMfRel))) sliceLine += `${sliceLine ? '\n' : ''}The print-ready ${threeMfRel} from an earlier version was removed: it no longer matches the design${ask.slice ? '' : ' (slice again with slice true)'}.`

  const report: ModelReport = {
    schema: 1, source: rel, sourceSha256: sha256(sourceBytes), builtAt: deps.now().toISOString(), openscad: openscadVersion, plate, files,
    mesh: { ...mesh, min: mesh.min.map(round), max: mesh.max.map(round), size: mesh.size.map(round) as [number, number, number], volume: round(mesh.volume), area: round(mesh.area), overhangArea: round(mesh.overhangArea), contactArea: round(mesh.contactArea) },
    warnings, slice: sliced, sliceError,
  }
  writeJsonAtomic(join(dir, outRel, 'report.json'), report)

  appendJournal(dir, 'model.built', `${rel} → ${outRel}/ (${fmt(mesh.size[0])} × ${fmt(mesh.size[1])} × ${fmt(mesh.size[2])} mm${sliced ? `, sliced ${sliced.material} ${duration(sliced.seconds)} ${sliced.grams.toFixed(1)} g` : ''})`)
  await ensureHistory(dir)
  const commitPaths = [`${outRel}/report.json`, `${outRel}/.gitignore`, 'journal.md', ...(ext === '.scad' ? [rel] : [])]
  const committed = await commitHistory(dir, commitPaths, `model: build ${rel}`)

  const text = [
    ext === '.scad' ? `Built ${rel} with OpenSCAD ${openscadVersion} in ${(buildMs / 1000).toFixed(1)} s.` : `Read ${rel} (a mesh; to change it, write a .scad that imports it and build that).`,
    `Size ${fmt(mesh.size[0])} × ${fmt(mesh.size[1])} × ${fmt(mesh.size[2])} mm (X × Y × Z) · volume ${fmt(mesh.volume / 1000)} cm³ · ${mesh.triangles.toLocaleString('en-US')} triangles · ${mesh.fitsPlate ? 'fits' : 'does NOT fit'} the ${plate.name} (${plate.x} × ${plate.y} × ${plate.z} mm).`,
    `Checks: ${mesh.watertight ? 'closed' : 'NOT closed'}, ${mesh.shells === 1 ? 'one piece' : `${mesh.shells} pieces`}, plate contact ${fmt(mesh.contactArea / 100)} cm², ${mesh.overhangArea > 0 ? `${fmt(mesh.overhangArea / 100)} cm² of overhang past 45°` : 'no overhang past 45°'}.`,
    ...(warnings.length ? ['Warnings:', ...warnings.map(w => `- ${w}`)] : []),
    ...(sliceLine ? [sliceLine] : []),
    `Files: ${files.png} (four views), ${files.stl} (mesh)${files.threeMf ? `, ${files.threeMf} (print-ready: the owner opens it in Bambu Studio and presses Print)` : ''}.`,
    ...(scadLines(messages) ? [scadLines(messages)] : []),
    `Show it with RenderUI: an Image with src "${files.png}" and a Model3D with src "${files.stl}"${files.threeMf ? ` and download "${files.threeMf}"` : ''}. You never start a print: the owner does, from Bambu Studio.`,
    ...(committed.ok ? [] : [`(The project history did not record this build: ${committed.reason})`]),
  ].join('\n')
  const ok = sliceError === null
  return { ok, text: ok ? text : `MakeModel: the model was built but not sliced.\n${text}`, report }
}

async function sliceInto(dir: string, work: string, stlAbs: string, threeMfRel: string, fits: boolean, plate: Plate, ask: MakeAsk, deps: MakeDeps, bambu: { program: string; profiles: string } | null, signal?: AbortSignal): Promise<{ ok: true; slice: NonNullable<ModelReport['slice']>; line: string } | { ok: false; reason: string }> {
  if (!fits) return { ok: false, reason: `it does not fit the ${plate.name} build volume` }
  if (!bambu) return { ok: false, reason: BAMBU_MISSING }
  const chosen = choosePresets(bambu.profiles, ask)
  if (!chosen.ok) return { ok: false, reason: chosen.reason }
  const sliceDir = join(work, 'slice')
  mkdirSync(sliceDir)
  const r = await slice({ program: bambu.program, stl: stlAbs, workDir: sliceDir, choice: chosen.choice, ask, run: deps.run, ...(signal ? { signal } : {}), write: (p, t) => writeFileSync(p, t, { encoding: 'utf8', flag: 'wx' }) })
  if (!r.ok) return { ok: false, reason: r.reason }
  renameSync(join(sliceDir, 'sliced.3mf'), join(dir, threeMfRel))
  const c = chosen.choice
  const e = r.estimate
  const s: NonNullable<ModelReport['slice']> = {
    printer: PRINTER.name, machine: c.machine, process: c.process, filament: c.filament, material: c.material, bed: c.bed,
    quality: ask.quality ?? 'standard', supports: ask.supports ?? null, brim: ask.brim ?? null, walls: ask.walls ?? null, infill: ask.infill ?? null,
    seconds: Math.round(e.seconds), grams: round(e.grams), slicer: e.version, warning: e.warning,
  }
  const settings = [
    ask.supports === undefined ? 'supports as the preset (off)' : ask.supports ? 'tree supports' : 'no supports',
    ...(ask.brim === undefined ? [] : [ask.brim ? 'brim 8 mm' : 'no brim']),
    ...(ask.walls === undefined ? [] : [`${ask.walls} walls`]),
    ...(ask.infill === undefined ? [] : [`${ask.infill}% infill`]),
  ]
  const line = `Sliced for the ${c.machine} with ${c.filament}, ${c.process}, ${c.bed}, ${settings.join(', ')}: about ${duration(e.seconds)} and ${e.grams.toFixed(1)} g of ${c.material}${e.version ? ` (Bambu Studio ${e.version})` : ''}.${e.warning ? ` Bambu Studio warns: ${e.warning}` : ''}`
  return { ok: true, slice: s, line }
}

/** Remove a derived file if it is there; a link is removed itself, never followed. True when one went. */
function removeStale(path: string): boolean {
  try {
    const st = lstatSync(path)
    if (st.isDirectory()) return false
    unlinkSync(path)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.log(`[print3d] could not remove ${path}: ${(e as Error).message}`)
    return false
  }
}

function writeIgnore(path: string): void {
  try {
    const st = lstatSync(path)
    if (st.isFile() && readFileSync(path, 'utf8') === GITIGNORE) return
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`[print3d] checking ${path} failed: ${(e as Error).message}`)
  }
  writeBytesAtomic(path, new TextEncoder().encode(GITIGNORE))
}

function scadLines(m: ScadMessages): string {
  const lines = [...m.errors, ...m.warnings, ...m.echoes]
  return lines.length ? `OpenSCAD said:\n${lines.map(l => `  ${l}`).join('\n')}` : ''
}

function round(n: number): number { return Math.round(n * 100) / 100 }
