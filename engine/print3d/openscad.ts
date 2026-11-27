/**
 * engine/print3d/openscad.ts — turn an OpenSCAD design into an STL.
 *
 * The design is the model's own file in the project. OpenSCAD's language
 * cannot run programs or write files, but it reads them: `include <…>`,
 * `use <…>`, `import("…")` and `surface("…")`. `referenceFault` reads the
 * design (and every project file it includes) before anything runs and
 * refuses a path that lands outside the project, or a file name computed at
 * run time that it cannot read: a project chat's file tools are fenced to the
 * project folder (`gradeProjectCall`), and a design must not be the way
 * around that fence. A bare library name that is not a project file is left
 * to OpenSCAD's own library folders; OPENSCADPATH is not passed on.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { realInside } from '../realPath.js'
import type { Runner } from './run.js'

/** Where the OpenSCAD installers put it; the Nightly first (the Manifold backend, seconds instead of minutes). */
const WINDOWS_CANDIDATES = ['OpenSCAD (Nightly)', 'OpenSCAD']
const POSIX_CANDIDATES = ['/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD', '/usr/local/bin/openscad', '/usr/bin/openscad', '/snap/bin/openscad']

/** How long one design may take to render (minkowski and high $fn can be slow). */
export const OPENSCAD_CAP_MS = 180_000
/** At most this many lines of each kind go back to the model. */
const MESSAGE_LINES = 20
const INCLUDE_DEPTH = 8
const INCLUDE_FILES = 64

export const OPENSCAD_MISSING = 'OpenSCAD is not installed on this PC (looked in Program Files and on PATH). The owner installs it with: winget install --id OpenSCAD.OpenSCAD.Nightly'

/**
 * The OpenSCAD program to run, or null. On Windows `openscad.exe`, never the
 * console wrapper `openscad.com` beside it: Bun 1.3.13 does not start a .com
 * program named by a path with backslashes (ENOENT, "not found in $PATH"),
 * and openscad.exe run with -o writes the same lines (to stderr) and exits
 * with the same codes (both measured 2026-11-27 on OpenSCAD 2026.11.27).
 */
export function findOpenScad(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined]) {
      if (!root) continue
      for (const name of WINDOWS_CANDIDATES) {
        const p = join(root, name, 'openscad.exe')
        if (exists(p)) return p
      }
    }
    // The platform's own PATH separator, not the host's: the platform is a parameter (a test on Linux asks about Windows).
    for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
      if (dir && exists(join(dir, 'openscad.exe'))) return join(dir, 'openscad.exe')
    }
    return null
  }
  for (const p of POSIX_CANDIDATES) if (exists(p)) return p
  for (const dir of (env.PATH ?? '').split(':')) if (dir && exists(join(dir, 'openscad'))) return join(dir, 'openscad')
  return null
}

/**
 * The source with comments blanked (`code`) and, in `bare`, string contents
 * blanked too — both the same length as the source, so an index found in
 * one reads the same place in the other.
 */
export function codeView(source: string): { code: string; bare: string } {
  const code = source.split('')
  const bare = source.split('')
  let i = 0
  while (i < source.length) {
    const c = source[i], n = source[i + 1]
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') { code[i] = ' '; bare[i] = ' '; i++ }
    } else if (c === '/' && n === '*') {
      code[i] = bare[i] = ' '; code[i + 1] = bare[i + 1] = ' '; i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] !== '\n') { code[i] = ' '; bare[i] = ' ' } i++ }
      if (i < source.length) { code[i] = bare[i] = ' '; code[i + 1] = bare[i + 1] = ' '; i += 2 }
    } else if (c === '"') {
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) { bare[i] = ' '; bare[i + 1] = ' '; i += 2; continue }
        if (source[i] !== '\n') bare[i] = ' '
        i++
      }
      i++
    } else {
      i++
    }
  }
  return { code: code.join(''), bare: bare.join('') }
}

type Ref = { kind: 'include' | 'use' | 'import' | 'surface'; path: string | null; line: number }

/** Every file a design names, in order; a computed name has `path: null`. */
export function designReferences(source: string): Ref[] {
  const { code, bare } = codeView(source)
  const lineAt = (i: number) => source.slice(0, i).split('\n').length
  const out: Ref[] = []
  for (const m of bare.matchAll(/\b(include|use)\s*<([^>\n]*)>/g)) {
    // `include <…>` holds no string, so `bare` and `code` agree on it.
    out.push({ kind: m[1] as 'include' | 'use', path: code.slice(m.index! + m[0].indexOf('<') + 1, m.index! + m[0].length - 1).trim(), line: lineAt(m.index!) })
  }
  for (const m of bare.matchAll(/\b(import|surface)\s*\(/g)) {
    const after = code.slice(m.index! + m[0].length)
    const lit = /^\s*(?:file\s*=\s*)?"((?:[^"\\\n]|\\.)*)"\s*[,)]/.exec(after)
    out.push({ kind: m[1] as 'import' | 'surface', path: lit ? lit[1].replace(/\\(.)/g, '$1') : null, line: lineAt(m.index!) })
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Why this design may not be built, or null. Follows every include/use that
 * is a project file (depth and count bounded), so a nested file cannot reach
 * out either.
 */
export function referenceFault(sourceAbs: string, projectDir: string, seen: Set<string> = new Set(), depth = 0): string | null {
  if (depth > INCLUDE_DEPTH) return `includes nest deeper than ${INCLUDE_DEPTH} files`
  if (seen.size >= INCLUDE_FILES) return `the design includes more than ${INCLUDE_FILES} files`
  seen.add(sourceAbs)
  let source: string
  try { source = readFileSync(sourceAbs, 'utf8') } catch (e) { return `${sourceAbs} could not be read (${(e as Error).message})` }
  const here = dirname(sourceAbs)
  const name = relName(projectDir, sourceAbs)
  for (const ref of designReferences(source)) {
    const at = `${name} line ${ref.line}`
    if (ref.path === null) return `${at}: ${ref.kind}() must name its file as a plain "string" — a file name computed at run time cannot be checked`
    const p = ref.path
    if (p === '' || p.includes('\0')) return `${at}: ${ref.kind} names no file`
    if (isAbsolute(p) || /^[A-Za-z]:|^[\\/]|^~/.test(p)) return `${at}: ${ref.kind} "${p}" is an absolute path — a design reads only files of this project, by a path relative to the design`
    const target = resolve(here, p)
    const found = existsSync(target)
    if (!found) {
      // Not a project file: an include/use may still be a library OpenSCAD ships with; nothing else may climb.
      if ((ref.kind === 'include' || ref.kind === 'use') && !p.split(/[\\/]+/).includes('..')) continue
      if (ref.kind === 'include' || ref.kind === 'use') return `${at}: ${ref.kind} <${p}> climbs out with ".." to a file that is not in this project`
      return `${at}: ${ref.kind} "${p}" is not a file in this project`
    }
    const r = realInside(projectDir, target)
    if (!r.inside) return `${at}: ${ref.kind} "${p}" is outside this project (${r.real})`
    if ((ref.kind === 'include' || ref.kind === 'use') && !seen.has(target)) {
      try { if (!statSync(target).isFile()) return `${at}: ${ref.kind} <${p}> is not a file` } catch (e) { return `${at}: ${ref.kind} <${p}> could not be checked (${(e as Error).message})` }
      const inner = referenceFault(target, projectDir, seen, depth + 1)
      if (inner) return inner
    }
  }
  return null
}

function relName(projectDir: string, abs: string): string {
  const rel = abs.startsWith(projectDir) ? abs.slice(projectDir.length).replace(/^[\\/]+/, '') : abs
  return rel.replace(/\\/g, '/')
}

export type ScadMessages = { errors: string[]; warnings: string[]; echoes: string[] }

/** OpenSCAD's own lines that matter to whoever fixes the design; render statistics are left out. */
export function parseMessages(output: string): ScadMessages {
  const m: ScadMessages = { errors: [], warnings: [], echoes: [] }
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cut = line.length > 300 ? line.slice(0, 300) + '…' : line
    if (/^ERROR:/.test(line) || /^Can't parse file/.test(line) || /^Current top level object is (empty|not a 3D object)/.test(line) || /^EXPORT-ERROR:/.test(line)) push(m.errors, cut)
    else if (/^(WARNING|DEPRECATED):/.test(line)) push(m.warnings, cut)
    else if (/^(ECHO|TRACE):/.test(line)) push(m.echoes, cut)
  }
  return m
}

function push(list: string[], line: string): void {
  if (list.length < MESSAGE_LINES) list.push(line)
  else if (list.length === MESSAGE_LINES) list.push('… (more not shown)')
}

/** OpenSCAD's version line, asked once per program path. */
const versions = new Map<string, string>()
export async function openScadVersion(openscad: string, run: Runner): Promise<string> {
  const known = versions.get(openscad)
  if (known !== undefined) return known
  const r = await run(openscad, ['--version'], { cwd: dirname(openscad), capMs: 20_000 })
  const v = /OpenSCAD version (\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? 'unknown'
  if (r.refused === null) versions.set(openscad, v)
  return v
}

export type StlBuild =
  | { ok: true; messages: ScadMessages; ms: number }
  | { ok: false; reason: string; messages: ScadMessages; ms: number }

/** Render `sourceAbs` to a binary STL at `outStl` (a fresh path the engine owns). */
export async function buildStl(o: { openscad: string; sourceAbs: string; outStl: string; run: Runner; signal?: AbortSignal; capMs?: number }): Promise<StlBuild> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.OPENSCADPATH
  const r = await o.run(o.openscad, ['-o', o.outStl, '--export-format', 'binstl', o.sourceAbs], {
    cwd: dirname(o.sourceAbs), capMs: o.capMs ?? OPENSCAD_CAP_MS, env, ...(o.signal ? { signal: o.signal } : {}),
  })
  const messages = parseMessages(`${r.stderr}\n${r.stdout}`)
  if (r.refused !== null) return { ok: false, reason: `OpenSCAD did not run: ${r.refused}`, messages, ms: r.ms }
  if (r.stopped) return { ok: false, reason: 'stopped before OpenSCAD finished', messages, ms: r.ms }
  if (r.timedOut) return { ok: false, reason: `OpenSCAD did not finish within ${Math.round((o.capMs ?? OPENSCAD_CAP_MS) / 1000)} s — simplify the design (lower $fn, fewer minkowski/hull steps)`, messages, ms: r.ms }
  if (r.code !== 0) return { ok: false, reason: messages.errors.length ? 'OpenSCAD could not build the design' : `OpenSCAD exited with code ${r.code}`, messages, ms: r.ms }
  if (!existsSync(o.outStl)) return { ok: false, reason: 'OpenSCAD finished but wrote no STL', messages, ms: r.ms }
  return { ok: true, messages, ms: r.ms }
}
