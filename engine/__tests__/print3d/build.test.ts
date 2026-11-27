/**
 * engine/print3d/build.ts and tool.ts: one MakeModel call in a real project
 * folder, with stand-in OpenSCAD and Bambu Studio programs — where every
 * file lands, what is committed, what the model is told, and every refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createProject, readJournal } from '../../projects/layout.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { makeModel, outputFolder, type MakeDeps } from '../../print3d/build.js'
import { makeModelTool, parseAsk, setMakeModelDeps } from '../../print3d/tool.js'
import type { RunEnd, Runner } from '../../print3d/run.js'
import { binaryStl, box, fakeProfiles } from './fixtures.js'

let home: string, slug: string, dir: string, profiles: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-model-'))
  slug = createProject(home, { name: 'Zoo' }).slug
  dir = join(home, slug)
  profiles = fakeProfiles(join(home, 'BBL'))
  mkdirSync(join(dir, 'models'), { recursive: true })
})
afterEach(() => { setProjectToolContext(null); setMakeModelDeps(null); rmSync(home, { recursive: true, force: true }) })

const ended = (o: Partial<RunEnd>): RunEnd => ({ code: 0, stdout: '', stderr: '', timedOut: false, stopped: false, refused: null, ms: 400, ...o })

/** Stand-ins: OpenSCAD writes `tris` as the STL; Bambu Studio writes an estimate and a project. */
function deps(o: { tris?: number[]; scadErr?: string; bambu?: boolean; calls?: string[][] } = {}): MakeDeps {
  const run: Runner = async (file, args, opts) => {
    o.calls?.push([file, ...args])
    if (file === 'openscad.exe') {
      if (args[0] === '--version') return ended({ stderr: 'OpenSCAD version 2026.11.27\n' })
      if (o.scadErr) return ended({ code: 1, stderr: o.scadErr })
      writeFileSync(args[1], binaryStl(o.tris ?? box(0, 0, 0, 60, 30, 45)))
      return ended({ stderr: 'ECHO: "arm", 40\n' })
    }
    writeFileSync(join(opts.cwd, 'result.json'), JSON.stringify({ return_code: 0, sliced_plates: [{ total_predication: 2400, filaments: [{ total_used_g: 21.4 }] }] }))
    writeFileSync(join(opts.cwd, 'sliced.3mf'), zipSync({ 'Metadata/slice_info.config': new TextEncoder().encode('key="X-BBL-Client-Version" value="02.09.02.62"') }))
    return ended({ ms: 1200 })
  }
  return {
    run,
    openscad: () => 'openscad.exe',
    bambu: () => (o.bambu === false ? null : { program: 'bambu-studio.exe', profiles }),
    now: () => new Date('2026-11-27T20:00:00Z'),
  }
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

describe('outputFolder', () => {
  it('builds models/<path> into models/<path>/, anything else into models/<its name>/, every name a slug', () => {
    expect(outputFolder('models/wall-hook.scad')).toBe('models/wall-hook')
    expect(outputFolder('models/robot/Chassis V2.scad')).toBe('models/robot/chassis-v2')
    expect(outputFolder('knowledge/Air Deflector.stl')).toBe('models/air-deflector')
  })
})

describe('makeModel', () => {
  it('builds a design: mesh, four views, report and ignore file under models/<name>/, the design and report committed', async () => {
    writeFileSync(join(dir, 'models', 'wall-hook.scad'), 'arm = 40; // 04-robot-hardware.md\ncube([60, 30, 45]);\n')
    const r = await makeModel(dir, { file: 'models/wall-hook.scad' }, deps())
    expect(r.ok).toBe(true)
    const out = join(dir, 'models', 'wall-hook')
    expect(readFileSync(join(out, 'wall-hook.stl')).length).toBe(84 + 12 * 50)
    const png = PNG.sync.read(readFileSync(join(out, 'wall-hook.png')))
    expect([png.width, png.height]).toEqual([960, 960])
    expect(existsSync(join(out, 'wall-hook.3mf'))).toBe(false)
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ schema: 1, source: 'models/wall-hook.scad', builtAt: '2026-11-27T20:00:00.000Z', openscad: '2026.11.27', plate: { name: 'Bambu Lab P2S', x: 256, y: 256, z: 256 }, files: { stl: 'models/wall-hook/wall-hook.stl', png: 'models/wall-hook/wall-hook.png', threeMf: null }, slice: null, sliceError: null })
    expect(report.mesh).toMatchObject({ size: [60, 30, 45], volume: 81000, watertight: true, shells: 1, fitsPlate: true })
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.text).toBe([
      'Built models/wall-hook.scad with OpenSCAD 2026.11.27 in 0.4 s.',
      'Size 60.0 × 30.0 × 45.0 mm (X × Y × Z) · volume 81.0 cm³ · 12 triangles · fits the Bambu Lab P2S (256 × 256 × 256 mm).',
      'Checks: closed, one piece, plate contact 18.0 cm², no overhang past 45°.',
      'Files: models/wall-hook/wall-hook.png (four views), models/wall-hook/wall-hook.stl (mesh).',
      'OpenSCAD said:\n  ECHO: "arm", 40',
      'Show it with RenderUI: an Image with src "models/wall-hook/wall-hook.png" and a Model3D with src "models/wall-hook/wall-hook.stl". You never start a print: the owner does, from Bambu Studio.',
    ].join('\n'))
    // History: the design and the report, never the built files.
    expect(git('log', '-1', '--format=%s').trim()).toBe('model: build models/wall-hook.scad')
    const tracked = git('ls-files', 'models').trim().split('\n').sort()
    expect(tracked).toEqual(['models/wall-hook.scad', 'models/wall-hook/.gitignore', 'models/wall-hook/report.json'])
    expect(readJournal(dir).some(l => l.event === 'model.built' && l.detail === 'models/wall-hook.scad → models/wall-hook/ (60.0 × 30.0 × 45.0 mm)')).toBe(true)
  })

  it('slices for the P2S when asked: a print-ready .3mf, time and grams; a rebuild without a slice removes the old print-ready file', async () => {
    writeFileSync(join(dir, 'models', 'clip.scad'), 'cube([20, 10, 8]);\n')
    const r = await makeModel(dir, { file: 'models/clip.scad', slice: true, material: 'ASA', brim: true, walls: 3 }, deps({ tris: box(0, 0, 0, 20, 10, 8) }))
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'models', 'clip', 'clip.3mf'))).toBe(true)
    expect(r.text).toContain('Sliced for the Bambu Lab P2S 0.4 nozzle with Generic ASA @BBL P2S, 0.20mm Standard @BBL P2S, Textured PEI Plate, supports as the preset (off), brim 8 mm, 3 walls: about 40 min and 21.4 g of ASA (Bambu Studio 02.09.02.62).')
    expect(r.text).toContain('models/clip/clip.3mf (print-ready: the owner opens it in Bambu Studio and presses Print)')
    expect(r.text).toContain('a Model3D with src "models/clip/clip.stl" and download "models/clip/clip.3mf"')
    expect(r.report!.slice).toMatchObject({ material: 'ASA', seconds: 2400, grams: 21.4, slicer: '02.09.02.62', brim: true, walls: 3, supports: null, quality: 'standard' })
    expect(git('ls-files', 'models/clip').trim().split('\n').sort()).toEqual(['models/clip/.gitignore', 'models/clip/report.json'])

    writeFileSync(join(dir, 'models', 'clip.scad'), 'cube([22, 10, 8]);\n')
    const again = await makeModel(dir, { file: 'models/clip.scad' }, deps({ tris: box(0, 0, 0, 22, 10, 8) }))
    expect(existsSync(join(dir, 'models', 'clip', 'clip.3mf'))).toBe(false)
    expect(again.text).toContain('The print-ready models/clip/clip.3mf from an earlier version was removed: it no longer matches the design (slice again with slice true).')
  })

  it('checks a mesh already in the project without OpenSCAD, and says how to change it', async () => {
    writeFileSync(join(dir, 'knowledge', 'Air Deflector.stl'), binaryStl(box(0, 0, 0, 100, 5, 30)))
    const calls: string[][] = []
    const r = await makeModel(dir, { file: 'knowledge/Air Deflector.stl' }, deps({ calls }))
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
    expect(r.text.split('\n')[0]).toBe('Read knowledge/Air Deflector.stl (a mesh; to change it, write a .scad that imports it and build that).')
    expect(existsSync(join(dir, 'models', 'air-deflector', 'air-deflector.png'))).toBe(true)
    expect(git('ls-files', 'models').trim().split('\n').sort()).toEqual(['models/air-deflector/.gitignore', 'models/air-deflector/report.json'])
  })

  it('hands OpenSCAD\'s errors back and builds nothing', async () => {
    writeFileSync(join(dir, 'models', 'bad.scad'), 'cube([1,1,1);\n')
    const r = await makeModel(dir, { file: 'models/bad.scad' }, deps({ scadErr: 'ERROR: Parser error: syntax error in file bad.scad, line 1\n' }))
    expect(r).toEqual({ ok: false, text: 'MakeModel: models/bad.scad was not built: OpenSCAD could not build the design\nOpenSCAD said:\n  ERROR: Parser error: syntax error in file bad.scad, line 1' })
    expect(existsSync(join(dir, 'models', 'bad', 'bad.stl'))).toBe(false)
  })

  it('builds and reports, but says it was not sliced, when the part does not fit or Bambu Studio is missing', async () => {
    writeFileSync(join(dir, 'models', 'big.scad'), 'cube([300, 10, 10]);\n')
    const big = await makeModel(dir, { file: 'models/big.scad', slice: true }, deps({ tris: box(0, 0, 0, 300, 10, 10) }))
    expect(big.ok).toBe(false)
    expect(big.text.startsWith('MakeModel: the model was built but not sliced.\n')).toBe(true)
    expect(big.text).toContain('NOT SLICED: it does not fit the Bambu Lab P2S build volume')
    expect(big.text).toContain('does NOT fit the Bambu Lab P2S')
    writeFileSync(join(dir, 'models', 'small.scad'), 'cube(5);\n')
    const none = await makeModel(dir, { file: 'models/small.scad', slice: true }, deps({ tris: box(0, 0, 0, 5, 5, 5), bambu: false }))
    expect(none.text).toContain('NOT SLICED: Bambu Studio is not installed on this PC')
    expect(existsSync(join(dir, 'models', 'small', 'small.png'))).toBe(true)
  })

  it('refuses a missing file, another kind of file, a path out of the project, a design that reads outside it, and no OpenSCAD', async () => {
    const r = (ask: { file: string }, d = deps()) => makeModel(dir, ask, d).then(x => x.text)
    expect(await r({ file: '' })).toBe('MakeModel: file is required: the project path of an OpenSCAD design (models/<name>.scad) or a mesh (.stl)')
    expect(await r({ file: 'models/nothing.scad' })).toBe('MakeModel: models/nothing.scad is not in this project — write the design first')
    expect(await r({ file: 'notes.md' })).toBe('MakeModel: notes.md is not a design or a mesh: give a .scad file (write the design under models/ first) or an .stl')
    expect(await r({ file: '../elsewhere.scad' })).toBe('MakeModel: ../elsewhere.scad is outside this project')
    writeFileSync(join(dir, 'models', 'peek.scad'), 'include <../../../../.ssh/config>\n')
    expect(await r({ file: 'models/peek.scad' })).toBe('MakeModel: the design was not built: models/peek.scad line 1: include <../../../../.ssh/config> climbs out with ".." to a file that is not in this project')
    writeFileSync(join(dir, 'models', 'ok.scad'), 'cube(1);\n')
    expect(await r({ file: 'models/ok.scad' }, { ...deps(), openscad: () => null })).toBe('MakeModel: OpenSCAD is not installed on this PC (looked in Program Files and on PATH). The owner installs it with: winget install --id OpenSCAD.OpenSCAD.Nightly')
  })

  it('never writes through a link planted where the output folder goes', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cynco-elsewhere-'))
    try {
      try { symlinkSync(elsewhere, join(dir, 'models', 'trap'), 'junction') } catch { return } // a host that cannot make one has nothing to test
      writeFileSync(join(dir, 'models', 'trap.scad'), 'cube(1);\n')
      const r = await makeModel(dir, { file: 'models/trap.scad' }, deps())
      expect(r).toEqual({ ok: false, text: 'MakeModel: models/trap/ in the project is a link; models are written only into real folders inside it — refused' })
      expect(existsSync(join(elsewhere, 'trap.stl'))).toBe(false)
    } finally { rmSync(elsewhere, { recursive: true, force: true }) }
  })
})

describe('MakeModel tool', () => {
  it('refuses outside a project chat, and checks the call before it builds', async () => {
    expect(await makeModelTool.execute({ file: 'models/a.scad' }, dir)).toEqual({ output: 'MakeModel is only available inside a project chat.', isError: true })
    setProjectToolContext({ home, slug, embed: null, embedModel: 'none' })
    expect(await makeModelTool.execute({ file: 'models/a.scad', material: 'ASA' }, dir)).toEqual({ output: 'MakeModel: material is a slice setting: add slice true, or leave it out', isError: true })
    expect(await makeModelTool.execute({ file: 'models/a.scad', slice: true, walls: 0 }, dir)).toEqual({ output: 'MakeModel: walls must be a whole number from 1 to 20', isError: true })
    expect(await makeModelTool.execute({ file: 'models/a.scad', slice: true, quality: 'ultra' }, dir)).toEqual({ output: 'MakeModel: quality must be one of draft, standard, fine', isError: true })
  })

  it('builds in the bound project with the programs it is given', async () => {
    setProjectToolContext({ home, slug, embed: null, embedModel: 'none' })
    setMakeModelDeps(deps())
    writeFileSync(join(dir, 'models', 'hook.scad'), 'cube([60, 30, 45]);\n')
    const r = await makeModelTool.execute({ file: 'models/hook.scad', slice: 'true', material: 'PLA' }, dir)
    expect(r.isError).toBe(false)
    expect(r.output).toContain('of PLA (Bambu Studio 02.09.02.62)')
    expect(existsSync(join(dir, 'models', 'hook', 'hook.3mf'))).toBe(true)
  })

  it('parseAsk takes booleans as words and numbers as text', () => {
    expect(parseAsk({ file: 'm.scad', slice: 'true', supports: false, infill: '20', walls: '3' })).toEqual({ ok: true, ask: { file: 'm.scad', slice: true, supports: false, infill: 20, walls: 3 } })
    expect(parseAsk({ file: 'm.scad', slice: 'yes' })).toEqual({ ok: false, reason: 'slice must be true or false' })
    expect(parseAsk({ file: 'm.scad', slice: true, infill: 101 })).toEqual({ ok: false, reason: 'infill must be a percentage from 0 to 100' })
  })
})
