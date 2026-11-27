/**
 * engine/print3d/openscad.ts: the design may read only files of its own
 * project (`referenceFault`), OpenSCAD's lines reach the model sorted, the
 * console build is found, and a run that fails says why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStl, codeView, designReferences, findOpenScad, parseMessages, referenceFault } from '../../print3d/openscad.js'
import type { RunEnd, Runner } from '../../print3d/run.js'

let root: string, project: string, outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cynco-scad-'))
  project = join(root, 'project')
  outside = join(root, 'outside')
  mkdirSync(join(project, 'models', 'parts'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.scad'), 'secret = 1;\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function design(rel: string, text: string): string {
  const p = join(project, rel)
  writeFileSync(p, text)
  return p
}

describe('codeView and designReferences', () => {
  it('blanks comments, and string contents in the bare view, keeping every index', () => {
    const src = 'a = "x // not a comment"; // gone\n/* gone\ntoo */ b = 2;'
    const { code, bare } = codeView(src)
    expect(code.length).toBe(src.length)
    expect(bare.length).toBe(src.length)
    expect(code).toContain('"x // not a comment"')
    expect(code).not.toContain('gone')
    expect(bare).not.toContain('not a comment')
    expect(code.split('\n').length).toBe(3)
  })

  it('names every include, use, import and surface with its line; a computed name is null; mentions in strings and comments are not references', () => {
    const src = [
      'include <parts/common.scad>',
      'use <MCAD/boxes.scad>',
      '// import("C:/Users/x/secret.stl")',
      'echo("import(\\"no\\")");',
      'import("parts/bracket.stl", convexity = 3);',
      'surface(file = "height.png");',
      'import(str("parts/", name, ".stl"));',
    ].join('\n')
    expect(designReferences(src)).toEqual([
      { kind: 'include', path: 'parts/common.scad', line: 1 },
      { kind: 'use', path: 'MCAD/boxes.scad', line: 2 },
      { kind: 'import', path: 'parts/bracket.stl', line: 5 },
      { kind: 'surface', path: 'height.png', line: 6 },
      { kind: 'import', path: null, line: 7 },
    ])
  })
})

describe('referenceFault', () => {
  it('passes a design that reads only project files and OpenSCAD libraries', () => {
    design('models/parts/common.scad', 'wall = 2;\n')
    writeFileSync(join(project, 'models', 'parts', 'bracket.stl'), 'solid x\nendsolid x\n')
    const p = design('models/hook.scad', 'include <parts/common.scad>\nuse <MCAD/boxes.scad>\nimport("parts/bracket.stl");\ncube(wall);\n')
    expect(referenceFault(p, project)).toBeNull()
  })

  it('refuses an absolute path, a climb out of the project, a library name that climbs, and a computed file name', () => {
    expect(referenceFault(design('models/a.scad', `import("${join(outside, 'secret.scad').replace(/\\/g, '/')}");\n`), project)).toMatch(/^models\/a\.scad line 1: import ".*" is an absolute path — a design reads only files of this project/)
    expect(referenceFault(design('models/b.scad', 'include <../../outside/secret.scad>\n'), project)).toMatch(/^models\/b\.scad line 1: include "\.\.\/\.\.\/outside\/secret\.scad" is outside this project/)
    expect(referenceFault(design('models/c.scad', 'use <../../../nowhere/lib.scad>\n'), project)).toBe('models/c.scad line 1: use <../../../nowhere/lib.scad> climbs out with ".." to a file that is not in this project')
    expect(referenceFault(design('models/d.scad', 'f = "x.stl";\nimport(f);\n'), project)).toBe('models/d.scad line 2: import() must name its file as a plain "string" — a file name computed at run time cannot be checked')
    expect(referenceFault(design('models/e.scad', 'import("~/.ssh/id_rsa");\n'), project)).toMatch(/is an absolute path/)
  })

  it('follows a project file it includes, so a nested include cannot reach out either', () => {
    design('models/parts/inner.scad', 'include <../../../outside/secret.scad>\n')
    const p = design('models/outer.scad', 'include <parts/inner.scad>\n')
    expect(referenceFault(p, project)).toMatch(/^models\/parts\/inner\.scad line 1: include .* is outside this project/)
  })

  it('refuses a link inside the project that leads out', () => {
    try { symlinkSync(outside, join(project, 'models', 'linked'), 'junction') } catch { return } // a host that cannot make one has nothing to test
    expect(referenceFault(design('models/f.scad', 'include <linked/secret.scad>\n'), project)).toMatch(/^models\/f\.scad line 1: include "linked\/secret\.scad" is outside this project/)
  })
})

describe('parseMessages', () => {
  it('sorts errors, warnings and echoes and leaves the render statistics out', () => {
    const out = [
      'WARNING: Ignoring unknown variable "w" in file hook.scad, line 2',
      'ECHO: "volume", 3000',
      'Geometries in cache: 3',
      'ERROR: Parser error: syntax error in file hook.scad, line 4',
      "Can't parse file 'hook.scad'!",
      'Current top level object is empty.',
    ].join('\r\n')
    expect(parseMessages(out)).toEqual({
      errors: ['ERROR: Parser error: syntax error in file hook.scad, line 4', "Can't parse file 'hook.scad'!", 'Current top level object is empty.'],
      warnings: ['WARNING: Ignoring unknown variable "w" in file hook.scad, line 2'],
      echoes: ['ECHO: "volume", 3000'],
    })
    const many = Array.from({ length: 30 }, (_, i) => `ECHO: ${i}`).join('\n')
    expect(parseMessages(many).echoes).toHaveLength(21)
    expect(parseMessages(many).echoes[20]).toBe('… (more not shown)')
  })
})

describe('findOpenScad', () => {
  it('takes the Nightly build first, then the stable one, then PATH; null when there is none', () => {
    const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\tools;C:\\bin' }
    const has = (...paths: string[]) => (p: string) => paths.includes(p)
    expect(findOpenScad(env, 'win32', has(join('C:\\Program Files', 'OpenSCAD (Nightly)', 'openscad.exe'), join('C:\\Program Files', 'OpenSCAD', 'openscad.exe')))).toBe(join('C:\\Program Files', 'OpenSCAD (Nightly)', 'openscad.exe'))
    expect(findOpenScad(env, 'win32', has(join('C:\\Program Files', 'OpenSCAD', 'openscad.exe')))).toBe(join('C:\\Program Files', 'OpenSCAD', 'openscad.exe'))
    expect(findOpenScad(env, 'win32', has(join('C:\\bin', 'openscad.exe')))).toBe(join('C:\\bin', 'openscad.exe'))
    expect(findOpenScad(env, 'win32', has())).toBeNull()
    expect(findOpenScad({ PATH: '/usr/bin' }, 'linux', has('/usr/bin/openscad'))).toBe('/usr/bin/openscad')
  })
})

describe('buildStl', () => {
  const ended = (o: Partial<RunEnd>): RunEnd => ({ code: 0, stdout: '', stderr: '', timedOut: false, stopped: false, refused: null, ms: 5, ...o })

  it('runs OpenSCAD on the design in its own folder, without OPENSCADPATH, and reports success only when the STL is there', async () => {
    const p = design('models/a.scad', 'cube(1);\n')
    const out = join(root, 'out.stl')
    const calls: Array<{ file: string; args: string[]; cwd: string; env?: Record<string, string | undefined> }> = []
    const run: Runner = async (file, args, o) => {
      calls.push({ file, args, cwd: o.cwd, env: o.env })
      writeFileSync(args[1], 'solid x\nendsolid x\n')
      return ended({ stderr: 'ECHO: "ok"\n' })
    }
    process.env.OPENSCADPATH = 'C:/elsewhere'
    try {
      const r = await buildStl({ openscad: 'openscad.exe', sourceAbs: p, outStl: out, run })
      expect(r).toEqual({ ok: true, messages: { errors: [], warnings: [], echoes: ['ECHO: "ok"'] }, ms: 5 })
    } finally { delete process.env.OPENSCADPATH }
    expect(calls[0].args).toEqual(['-o', out, '--export-format', 'binstl', p])
    expect(calls[0].cwd).toBe(join(project, 'models'))
    expect(calls[0].env && 'OPENSCADPATH' in calls[0].env).toBe(false)
  })

  it('says why when OpenSCAD fails, times out, is stopped, is refused or writes nothing', async () => {
    const p = design('models/a.scad', 'cube(1);\n')
    const out = join(root, 'none.stl')
    const with_ = (e: Partial<RunEnd>): Runner => async () => ended(e)
    expect(await buildStl({ openscad: 'o', sourceAbs: p, outStl: out, run: with_({ code: 1, stderr: 'ERROR: Parser error: syntax error in file a.scad, line 1\n' }) }))
      .toEqual({ ok: false, reason: 'OpenSCAD could not build the design', messages: { errors: ['ERROR: Parser error: syntax error in file a.scad, line 1'], warnings: [], echoes: [] }, ms: 5 })
    expect((await buildStl({ openscad: 'o', sourceAbs: p, outStl: out, run: with_({ code: null, timedOut: true }), capMs: 2000 }) as { reason: string }).reason).toBe('OpenSCAD did not finish within 2 s — simplify the design (lower $fn, fewer minkowski/hull steps)')
    expect((await buildStl({ openscad: 'o', sourceAbs: p, outStl: out, run: with_({ code: null, stopped: true }) }) as { reason: string }).reason).toBe('stopped before OpenSCAD finished')
    expect((await buildStl({ openscad: 'o', sourceAbs: p, outStl: out, run: with_({ code: null, refused: 'Refused [containment]: no launcher' }) }) as { reason: string }).reason).toBe('OpenSCAD did not run: Refused [containment]: no launcher')
    expect((await buildStl({ openscad: 'o', sourceAbs: p, outStl: out, run: with_({}) }) as { reason: string }).reason).toBe('OpenSCAD finished but wrote no STL')
  })
})
