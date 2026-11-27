/**
 * engine/print3d/slicer.ts: Bambu Studio's presets flattened the way Bambu
 * Studio loads them (parent, then included templates, then the preset's own
 * keys; identity never inherited), the preset choice for a material, the
 * settings a call asks for, and the estimate read back from result.json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { choosePresets, duration, findBambuStudio, flatten, plateOf, PRINTER, processSettings, readEstimate, slice, slicerVersion } from '../../print3d/slicer.js'
import type { RunEnd, Runner } from '../../print3d/run.js'
import { fakeProfiles } from './fixtures.js'

let root: string, profiles: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cynco-slicer-'))
  profiles = fakeProfiles(join(root, 'BBL'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('flatten', () => {
  it('parent, then included templates, then the preset itself; identity and filament_id never come from a template', () => {
    const presets = new Map<string, Record<string, unknown>>()
    const read = (kind: string) => {
      for (const f of ['fdm_machine_common', 'Bambu Lab P2S 0.4 nozzle', 'Bambu Lab P2S 0.4 nozzle template machine_start_gcode']) {
        if (kind === 'machine') presets.set(f, JSON.parse(readFileSync(join(profiles, 'machine', `${f}.json`), 'utf8')))
      }
    }
    read('machine')
    const m = flatten(presets, 'Bambu Lab P2S 0.4 nozzle')!
    expect(m.machine_start_gcode).toBe('P2S START') // the template's G-code, not the generic parent's
    expect(m.printable_area).toEqual(['0x0', '256x0', '256x256', '0x256'])
    expect(m.setting_id).toBeUndefined() // neither the parent's nor the template's
    expect(m.name).toBe('Bambu Lab P2S 0.4 nozzle')
    expect('inherits' in m || 'include' in m).toBe(false)
    expect(flatten(presets, 'nothing')).toBeNull()
    presets.set('loop-a', { name: 'loop-a', inherits: 'loop-b' })
    presets.set('loop-b', { name: 'loop-b', inherits: 'loop-a' })
    expect(flatten(presets, 'loop-a')).toBeNull()
  })
})

describe('choosePresets and processSettings', () => {
  it('a material is the generic P2S preset; the plate is the machine model\'s; the filament keeps its own id', () => {
    const r = choosePresets(profiles, { material: 'asa', quality: 'fine' })
    if (!r.ok) throw new Error(r.reason)
    expect([r.choice.machine, r.choice.process, r.choice.filament, r.choice.material, r.choice.bed]).toEqual(['Bambu Lab P2S 0.4 nozzle', '0.16mm Standard @BBL P2S', 'Generic ASA @BBL P2S', 'ASA', 'Textured PEI Plate'])
    expect(r.choice.filamentPreset.filament_id).toBe('GFB98')
    expect(r.choice.filamentPreset.nozzle_temperature).toEqual(['220'])
  })

  it('refuses an unknown material, a missing preset and a preset for another printer, naming what there is', () => {
    expect(choosePresets(profiles, { material: 'unobtainium' })).toEqual({ ok: false, reason: 'no material "unobtainium" — one of PLA, PLA-CF, PETG, PETG-CF, ABS, ASA, PC, PA, TPU, or an exact Bambu Studio filament preset name in "filament"' })
    const tpu = choosePresets(profiles, { material: 'TPU' })
    expect(tpu.ok).toBe(false)
    expect((tpu as { reason: string }).reason).toMatch(/^Bambu Studio has no filament preset "Generic TPU @BBL P2S"/)
    expect(choosePresets(profiles, { material: 'PETG' })).toEqual({ ok: false, reason: 'the filament preset "Generic PETG @BBL P2S" is not for the Bambu Lab P2S 0.4 nozzle' })
  })

  it('applies only what was asked, in Bambu Studio\'s own spelling, with the plate', () => {
    const r = choosePresets(profiles, {})
    if (!r.ok) throw new Error(r.reason)
    expect(r.choice.filament).toBe('Generic PLA @BBL P2S')
    expect(r.choice.process).toBe('0.20mm Standard @BBL P2S')
    const plain = processSettings(r.choice, {})
    expect([plain.curr_bed_type, plain.enable_support, plain.wall_loops, plain.brim_type]).toEqual(['Textured PEI Plate', '0', '2', undefined])
    const asked = processSettings(r.choice, { supports: true, brim: true, walls: 3, infill: 25 })
    expect([asked.enable_support, asked.support_type, asked.brim_type, asked.brim_width, asked.wall_loops, asked.sparse_infill_density]).toEqual(['1', 'tree(auto)', 'outer_only', '8', '3', '25%'])
    expect(processSettings(r.choice, { brim: false }).brim_type).toBe('no_brim')
  })

  it('reads the build volume from the machine preset, and falls back to the P2S\'s own without Bambu Studio', () => {
    expect(plateOf(profiles)).toEqual({ name: 'Bambu Lab P2S', x: 256, y: 256, z: 256 })
    expect(plateOf(null)).toEqual(PRINTER.plate)
  })
})

describe('readEstimate, duration and slicerVersion', () => {
  it('adds up the plates\' time and grams; a failed slice is its error string', () => {
    const ok = readEstimate({ return_code: 0, sliced_plates: [{ total_predication: 542.3, filaments: [{ total_used_g: 3.75 }], warning_message: '' }] })
    expect(ok).toEqual({ ok: true, estimate: { seconds: 542.3, grams: 3.75, warning: '' } })
    expect(readEstimate({ return_code: -100, error_string: 'Nothing to be sliced' })).toEqual({ ok: false, reason: 'Bambu Studio: Nothing to be sliced (code -100)' })
    expect(readEstimate({ return_code: 0, sliced_plates: [] })).toEqual({ ok: false, reason: 'Bambu Studio sliced no plate' })
    expect(readEstimate('x')).toEqual({ ok: false, reason: 'result.json is not an object' })
  })

  it('says a duration the way a person reads it', () => {
    expect([duration(45), duration(542), duration(4320), duration(3600)]).toEqual(['45 s', '9 min', '1 h 12 min', '1 h 0 min'])
  })

  it('reads the slicer version the sliced project records, and nothing from a file that is not one', () => {
    const file = join(root, 'x.3mf')
    writeFileSync(file, zipSync({ 'Metadata/slice_info.config': new TextEncoder().encode('<header_item key="X-BBL-Client-Version" value="02.09.02.62"/>') }))
    expect(slicerVersion(file)).toBe('02.09.02.62')
    writeFileSync(file, 'not a zip')
    expect(slicerVersion(file)).toBe('')
  })
})

describe('slice', () => {
  const ended = (o: Partial<RunEnd>): RunEnd => ({ code: 0, stdout: '', stderr: '', timedOut: false, stopped: false, refused: null, ms: 900, ...o })

  it('writes the three presets, runs the command line in its folder and reads the estimate', async () => {
    const r = choosePresets(profiles, { material: 'ASA' })
    if (!r.ok) throw new Error(r.reason)
    const work = join(root, 'work'); mkdirSync(work)
    let seen: { args: string[]; cwd: string } | null = null
    const run: Runner = async (_file, args, o) => {
      seen = { args, cwd: o.cwd }
      writeFileSync(join(o.cwd, 'result.json'), JSON.stringify({ return_code: 0, sliced_plates: [{ total_predication: 4320, filaments: [{ total_used_g: 18.25 }] }] }))
      writeFileSync(join(o.cwd, 'sliced.3mf'), zipSync({ 'Metadata/slice_info.config': new TextEncoder().encode('key="X-BBL-Client-Version" value="02.09.02.62"') }))
      return ended({})
    }
    const s = await slice({ program: 'bambu-studio.exe', stl: join(root, 'hook.stl'), workDir: work, choice: r.choice, ask: { material: 'ASA', brim: true }, run, write: (p, t) => writeFileSync(p, t) })
    expect(s).toEqual({ ok: true, estimate: { seconds: 4320, grams: 18.25, warning: '', version: '02.09.02.62' }, ms: 900 })
    expect(seen!.cwd).toBe(work)
    expect(seen!.args).toEqual(['--load-settings', `${join(work, 'machine.json')};${join(work, 'process.json')}`, '--load-filaments', join(work, 'filament.json'),
      '--arrange', '1', '--orient', '0', '--slice', '0', '--outputdir', work, '--export-3mf', 'sliced.3mf', join(root, 'hook.stl')])
    const proc = JSON.parse(readFileSync(join(work, 'process.json'), 'utf8'))
    expect([proc.curr_bed_type, proc.brim_type]).toEqual(['Textured PEI Plate', 'outer_only'])
    expect(JSON.parse(readFileSync(join(work, 'machine.json'), 'utf8')).machine_start_gcode).toBe('P2S START')
  })

  it('says why when Bambu Studio fails, writes no result, or writes no project', async () => {
    const r = choosePresets(profiles, {})
    if (!r.ok) throw new Error(r.reason)
    const go = async (run: Runner) => {
      const work = mkdtempSync(join(root, 'w-'))
      return slice({ program: 'b', stl: 'x.stl', workDir: work, choice: r.choice, ask: {}, run, write: (p, t) => writeFileSync(p, t) })
    }
    expect(await go(async () => ended({ code: 1, stderr: 'boom\nthe end' }))).toEqual({ ok: false, reason: 'Bambu Studio exited with code 1 and wrote no result.json (boom | the end)', ms: 900 })
    expect(await go(async (_f, _a, o) => { writeFileSync(join(o.cwd, 'result.json'), JSON.stringify({ return_code: -51, error_string: 'Some objects are outside the plate' })); return ended({ code: 205 }) }))
      .toEqual({ ok: false, reason: 'Bambu Studio: Some objects are outside the plate (code -51)', ms: 900 })
    expect(await go(async (_f, _a, o) => { writeFileSync(join(o.cwd, 'result.json'), JSON.stringify({ return_code: 0, sliced_plates: [{ total_predication: 1 }] })); return ended({}) }))
      .toEqual({ ok: false, reason: 'Bambu Studio reported success but wrote no sliced 3MF', ms: 900 })
    expect(await go(async () => ended({ code: null, timedOut: true }))).toEqual({ ok: false, reason: 'Bambu Studio did not finish slicing within 300 s', ms: 900 })
  })
})

describe('findBambuStudio', () => {
  it('finds the program with its BBL presets in Program Files, and nothing on Linux', () => {
    const dir = join('C:\\Program Files', 'Bambu Studio')
    const has = (p: string) => [join(dir, 'bambu-studio.exe'), join(dir, 'resources', 'profiles', 'BBL')].includes(p)
    expect(findBambuStudio({ ProgramFiles: 'C:\\Program Files' }, 'win32', has)).toEqual({ program: join(dir, 'bambu-studio.exe'), profiles: join(dir, 'resources', 'profiles', 'BBL') })
    expect(findBambuStudio({ ProgramFiles: 'C:\\Program Files' }, 'win32', () => false)).toBeNull()
    expect(findBambuStudio({}, 'linux', () => true)).toBeNull()
  })
})
