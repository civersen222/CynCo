/**
 * engine/tools/toolPaths.ts: every path one tool call touches, for every tool in the registry (F242,
 * layer 2: protected paths).
 *
 * `namePaths(toolName, input, cwd)` answers with the paths a call names, each with the operation the
 * tool performs on it: a file tool's target is a field and is exact; the Bash tool's command is read by
 * `scanShellText` and the Git tool's argv by `scanArgv` (`shellPaths.ts`), which is a tripwire. The
 * sealed, immutable and secret checks read their nested keys from here, and `protectedPaths.ts` judges
 * what is named. `TOOL_PATH_TABLE` has one row for every tool of `ALL_TOOLS`
 * (`engine/tools/registry.ts`); a test fails when a tool arrives without one.
 *
 * Pure apart from `real()`, which asks the injected resolver (default `realPathOf`, quiet) once per path,
 * and never for a UNC path, a path on a drive the run has no folder on, or a path inside a lexical root:
 * a sleeping share or a disconnected drive must never block a tool call. It reads no environment
 * variable and starts no process. It must not import `registry.js`, `executor.js`, `sealedPaths.js`,
 * `secretPaths.js` or `protectedPaths.js` (the Bash tool imports the policy, which imports this file).
 */
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { realPathOf } from '../realPath.js'
import { runContainment, type RunContainment } from '../containment.js'
import { scanArgv, scanShellText, type Anchor, type HomeMap, type PathOp, type ShellScan } from './shellPaths.js'
import { buildArgv, tokenizeArgs } from './gitArgv.js'

export type NamedPath = {
  raw: string; path: string; real(): string
  op: PathOp; source: 'field' | 'shell'; via: string
  recursive: boolean; children: boolean; inherited: boolean
  anchor: Anchor; device: boolean; linkTarget?: string | null
  verb?: string
  unsetName?: string   // the shell word started with this name, which nothing in the command set
}
export type NamedCall = { paths: NamedPath[]; spellings: string[]; texts: string[]; scan: ShellScan | null; faults: string[] }
export type NameOpts = {
  platform?: 'win32' | 'posix'       // default: the host
  real?: (p: string) => string       // default: p => realPathOf(p, { quiet: true })
  drives?: string[]                  // win32: upper-case drive letters whose file system may be asked
  lexicalRoots?: string[]            // folders below which the file system is never asked
}

type Platform = 'win32' | 'posix'

function hostPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

// ─── Homes ─────────────────────────────────────────────────────────────────────────────────────

const homesByContext = new WeakMap<RunContainment, HomeMap>()
let homesNoContext: HomeMap | null = null

function looksWin32(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) || (p.includes('\\') && !p.startsWith('/'))
}

function homesFor(home: string, temp: string, scratch: string | null): HomeMap {
  const p = looksWin32(home) ? nodePath.win32 : nodePath.posix
  return {
    home,
    appData: p.join(home, 'AppData', 'Roaming'),
    localAppData: p.join(home, 'AppData', 'Local'),
    temp,
    scratch,
    user: p.basename(home),
  }
}

/**
 * The home map every check of one call uses. With a run context the home is the REAL home whatever
 * the run's environment says (integration directive 10), and temp and scratch are the sandbox's. One
 * cached object per context, and one for "no context", so the scan memo below can hit.
 */
export function currentHomes(ctx?: RunContainment | null): HomeMap {
  const c = ctx === undefined ? runContainment() : ctx
  if (c) {
    const hit = homesByContext.get(c)
    if (hit) return hit
    const made = homesFor(c.home, c.sandbox.tmp, c.sandbox.scratch)
    homesByContext.set(c, made)
    return made
  }
  if (homesNoContext === null) homesNoContext = homesFor(os.homedir(), os.tmpdir(), null)
  return homesNoContext
}

// ─── Lexical path helpers ─────────────────────────────────────────────────────────────────────

/**
 * The canonical spelling of an absolute path. On win32: the `\\?\` and `\\.\X:` prefixes stripped,
 * `/` turned into `\`, trailing dots and spaces cut from every segment (PowerShell and cmd reach
 * `C:\Windows` through `C:\Windows.`), an alternate-data-stream suffix cut, then resolved. On posix:
 * resolved, except a drive-absolute or UNC word, which is kept as written. No case folding.
 */
export function canonPath(p: string, platform: Platform): string {
  if (platform === 'posix') {
    if (/^[A-Za-z]:(?:[\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p)) return p
    return nodePath.posix.resolve(p)
  }
  let s = p
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(s)) s = '\\\\' + s.slice(8)
  else if (/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(s)) s = s.slice(4)
  s = s.replace(/\//g, '\\')
  const unc = s.startsWith('\\\\')
  const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : ''
  let rest = unc ? s.slice(2) : s.slice(drive.length)
  // An alternate data stream: the first `:` after the drive colon.
  const colon = rest.indexOf(':')
  if (colon >= 0) rest = rest.slice(0, colon)
  const lead = unc ? '\\\\' : drive
  const segs = rest.split('\\').map(seg => {
    if (seg === '.' || seg === '..') return seg
    const cut = seg.replace(/[. ]+$/, '')
    return cut === '' ? seg : cut
  })
  let joined = lead + segs.join('\\')
  if (drive && joined === drive) joined = drive + '\\'
  return nodePath.win32.resolve(joined)
}

/**
 * Is `candidate` the root or inside it? Both are canonical absolute paths. On win32 compared
 * case-folded with `\` as the separator; on posix as written. The policy's own containment test
 * (finding 2.M4): the host-bound `isInside` cannot judge a `C:\Users\u` literal on Linux.
 */
export function insidePath(root: string, candidate: string, platform: Platform): boolean {
  let r = root
  let c = candidate
  if (platform === 'win32') {
    r = r.replace(/\//g, '\\').toLowerCase()
    c = c.replace(/\//g, '\\').toLowerCase()
  }
  const sep = platform === 'win32' ? '\\' : '/'
  if (r.length > 1 && r.endsWith(sep) && !/^[a-z]:\\$/.test(r)) r = r.slice(0, -1)
  if (c.length > 1 && c.endsWith(sep) && !/^[a-z]:\\$/.test(c)) c = c.slice(0, -1)
  if (c === r) return true
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ─── Patches ───────────────────────────────────────────────────────────────────────────────────

function unquoteC(name: string): string {
  const s = name.trim()
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s
  const body = s.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\' || i + 1 >= body.length) { out += c; continue }
    const n = body[++i]
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0] ?? n
      out += String.fromCharCode(parseInt(oct, 8))
      i += oct.length - 1
      continue
    }
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n
  }
  return out
}

/** The name of a `---` / `+++` header line: up to a tab (a timestamp follows it), unquoted. */
function headerName(rest: string): string {
  const r = rest.trimEnd()
  if (r.startsWith('"')) {
    const end = r.indexOf('"', 1)
    let k = 1
    for (; k < r.length; k++) { if (r[k] === '\\') { k++; continue } if (r[k] === '"') break }
    return unquoteC(r.slice(0, (end < 0 ? r.length : k) + 1))
  }
  return r.split('\t')[0]
}

function diffGitNames(rest: string): string[] {
  const names: string[] = []
  let r = rest.trim()
  for (let n = 0; n < 2 && r.length; n++) {
    if (r.startsWith('"')) {
      let k = 1
      for (; k < r.length; k++) { if (r[k] === '\\') { k++; continue } if (r[k] === '"') break }
      names.push(unquoteC(r.slice(0, k + 1)))
      r = r.slice(k + 1).trim()
    } else {
      // `a/x b/y`: split before the ` b/` that starts the second name.
      const m = n === 0 ? r.match(/^(.*?) (?=b\/)/) : null
      const name = m ? m[1] : r.split(' ')[0]
      names.push(name)
      r = r.slice(name.length).trim()
    }
  }
  return names
}

/**
 * Every path a unified diff names: `diff --git a/x b/y`, `--- x`, `+++ y`, `rename from|to`,
 * `copy from|to`. `/dev/null` is ignored; `+++ /dev/null` makes the `---` name a delete. Each name is
 * given as written and with one leading `a/` or `b/` component removed.
 */
export type PatchPath = { raw: string; op: 'write' | 'delete' | 'link'; via: string; linkTarget?: string | null }

export function patchPaths(patch: string): PatchPath[] {
  const out: PatchPath[] = []
  const seen = new Map<string, number>()
  // A file the patch makes a symbolic link (mode 120000): its one added line is where the link points,
  // and it is judged as a link (rule R6), not as a write (review 2026-11-23).
  let fileAt = 0
  let linkMode = false
  let linkTarget: string | null = null
  const settle = () => {
    if (linkMode) for (let k = fileAt; k < out.length; k++) if (out[k].op !== 'delete') { out[k].op = 'link'; out[k].linkTarget = linkTarget }
  }
  const add = (name: string, op: 'write' | 'delete', via: string) => {
    if (!name || name === '/dev/null') return
    const forms = [name]
    const stripped = name.replace(/^[ab]\//, '')
    if (stripped !== name && stripped !== '') forms.push(stripped)
    for (const f of forms) {
      const key = `${f}\u0000${via}`
      const at = seen.get(key)
      if (at !== undefined) { if (op === 'delete') out[at].op = 'delete'; continue }
      seen.set(key, out.length)
      out.push({ raw: f, op, via })
    }
  }
  if (typeof patch !== 'string') return out
  let lastMinus: string | null = null
  for (const line0 of patch.split('\n')) {
    const line = line0.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      settle()
      fileAt = out.length; linkMode = false; linkTarget = null
      for (const n of diffGitNames(line.slice(11))) add(n, 'write', 'patch:diff')
      continue
    }
    if (/^(?:new file mode|new mode) 120000\s*$/.test(line)) { linkMode = true; continue }
    if (linkMode && linkTarget === null && line.startsWith('+') && !line.startsWith('+++')) { linkTarget = line.slice(1); continue }
    if (line.startsWith('--- ')) { lastMinus = headerName(line.slice(4)); add(lastMinus, 'write', 'patch:---'); continue }
    if (line.startsWith('+++ ')) {
      const name = headerName(line.slice(4))
      if (name === '/dev/null') { if (lastMinus) add(lastMinus, 'delete', 'patch:---') }
      else add(name, 'write', 'patch:+++')
      lastMinus = null
      continue
    }
    const ren = line.match(/^rename (from|to) (.+)$/)
    if (ren) { add(unquoteC(ren[2]), ren[1] === 'from' ? 'delete' : 'write', 'patch:rename'); continue }
    const cp = line.match(/^copy (from|to) (.+)$/)
    if (cp) { add(unquoteC(cp[2]), 'write', 'patch:copy'); continue }
    if (line.startsWith('deleted file mode') && lastMinus === null) continue
  }
  settle()
  return out
}

// ─── The table ─────────────────────────────────────────────────────────────────────────────────

export type ToolPathRow = {
  /** Top-level keys holding a path, with the operation the tool performs on it. */
  fields?: Array<{ key: string; op: PathOp }>
  /** Top-level keys holding a spelling that is not a path the tool resolves (a pattern, a name). */
  spellings?: string[]
  /** A tool whose paths are not top-level keys. */
  special?: 'multiEdit' | 'applyPatch' | 'glob' | 'bash' | 'git'
}

/** One explicit row for every tool of `ALL_TOOLS`; a test enforces it. */
export const TOOL_PATH_TABLE: Record<string, ToolPathRow> = {
  Read: { fields: [{ key: 'file_path', op: 'read' }] },
  ImageView: { fields: [{ key: 'file_path', op: 'read' }] },
  IndexResearch: { fields: [{ key: 'file_path', op: 'read' }] },
  Ls: { fields: [{ key: 'path', op: 'list' }] },
  Glob: { fields: [{ key: 'path', op: 'list' }], spellings: ['pattern'], special: 'glob' },
  Grep: { fields: [{ key: 'path', op: 'read' }], spellings: ['pattern', 'glob'] },
  Write: { fields: [{ key: 'file_path', op: 'write' }] },
  Edit: { fields: [{ key: 'file_path', op: 'write' }] },
  ReplaceFunction: { fields: [{ key: 'file_path', op: 'write' }] },
  NotebookEdit: { fields: [{ key: 'notebook_path', op: 'write' }] },
  MultiEdit: { special: 'multiEdit' },
  ApplyPatch: { special: 'applyPatch' },
  AddToKnowledge: { fields: [{ key: 'path', op: 'read' }] },
  LookAt: { spellings: ['file'] },
  Bash: { special: 'bash' },
  Git: { special: 'git' },
  WebFetch: {}, WebSearch: {}, CodeIndex: {}, SaveLearning: {}, SubAgent: {}, CollectAgent: {}, Mfl: {},
  load_tools: {}, run_skill: {}, list_skills: {}, AskUser: {},
  ContractCreate: {}, ContractAssertPass: {}, ContractAssertFail: {}, ContractStatus: {},
  ProjectSearch: {}, SaveArtifact: {}, RenderUI: {},
}

const GENERIC_KEYS = ['file_path', 'path', 'notebook_path', 'filePath']
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit'])

// ─── Naming ────────────────────────────────────────────────────────────────────────────────────

function driveOf(p: string): string | null {
  const m = p.match(/^([A-Za-z]):/)
  return m ? m[1].toUpperCase() : null
}

interface Resolver { platform: Platform; real: (p: string) => string; drives: string[]; lexicalRoots: string[] }

function resolverOf(cwd: string, homes: HomeMap, opts: NameOpts | undefined): Resolver {
  const platform = opts?.platform ?? hostPlatform()
  const drives = opts?.drives ?? [homes.home, homes.temp, cwd].map(driveOf).filter((d): d is string => d !== null)
  const lexicalRoots = (opts?.lexicalRoots ?? []).map(r => canonPath(r, platform))
  return { platform, real: opts?.real ?? (p => realPathOf(p, { quiet: true })), drives: drives.map(d => d.toUpperCase()), lexicalRoots }
}

function isLexical(c: string, r: Resolver): boolean {
  if (/^[\\/]{2}/.test(c)) return true
  if (r.platform === 'win32') {
    const d = driveOf(c)
    if (d === null || !r.drives.includes(d)) return true
  } else if (/^[A-Za-z]:/.test(c)) return true
  return r.lexicalRoots.some(root => insidePath(root, c, r.platform))
}

function realFn(path: string, r: Resolver): () => string {
  let memo: string | null = null
  return () => {
    if (memo !== null) return memo
    const c = canonPath(path, r.platform)
    memo = isLexical(c, r) ? c : canonPath(r.real(c), r.platform)
    return memo
  }
}

function resolveField(cwd: string, raw: string, platform: Platform): string {
  return platform === 'win32' ? nodePath.win32.resolve(cwd, raw) : nodePath.posix.resolve(cwd, raw)
}

function fieldPath(raw: string, op: PathOp, via: string, cwd: string, r: Resolver, children = false): NamedPath {
  const path = resolveField(cwd, raw, r.platform)
  return { raw, path, real: realFn(path, r), op, source: 'field', via, recursive: false, children, inherited: false, anchor: null, device: false }
}

/** The fixed prefix of a glob pattern (before its first wildcard, cut at the last separator). */
function globPrefix(pattern: string): string {
  const w = pattern.search(/[*?[{]/)
  const head = w < 0 ? pattern : pattern.slice(0, w)
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return w < 0 ? pattern : cut < 0 ? '.' : head.slice(0, cut + 1)
}

/**
 * The table and the generic rule, without any shell scan: `Bash` and `Git` answer nothing here.
 * Field paths resolve as each tool resolves them (`resolve(cwd, raw)`), with no `~` expansion.
 */
export function fieldPaths(toolName: string, input: Record<string, unknown>, cwd: string, opts?: NameOpts)
  : { paths: NamedPath[]; spellings: string[] } {
  const homes = currentHomes()
  return fieldPathsWith(toolName, input, cwd, resolverOf(cwd, homes, opts))
}

function fieldPathsWith(toolName: string, input0: Record<string, unknown>, cwd: string, r: Resolver)
  : { paths: NamedPath[]; spellings: string[] } {
  const input = input0 && typeof input0 === 'object' ? input0 : {}
  const paths: NamedPath[] = []
  const spellings: string[] = []
  const namedKeys = new Set<string>()
  const spelledKeys = new Set<string>()
  const row = TOOL_PATH_TABLE[toolName]
  const str = (k: string): string | null => typeof input[k] === 'string' && (input[k] as string) !== '' ? input[k] as string : null
  for (const f of row?.fields ?? []) {
    namedKeys.add(f.key)
    const v = str(f.key)
    if (v !== null) paths.push(fieldPath(v, f.op, f.key, cwd, r))
  }
  for (const k of row?.spellings ?? []) {
    spelledKeys.add(k)
    const v = str(k)
    if (v !== null) spellings.push(v)
  }
  if (row?.special === 'glob') {
    const pattern = str('pattern')
    if (pattern !== null && (/^(?:[A-Za-z]:)?[\\/]/.test(pattern) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(pattern))) {
      const base = str('path') ?? '.'
      const baseAbs = resolveField(cwd, base, r.platform)
      paths.push(fieldPath(globPrefix(pattern), 'list', 'pattern', baseAbs, r, true))
    }
  }
  if (row?.special === 'multiEdit') {
    const edits = input.edits
    if (Array.isArray(edits)) {
      edits.forEach((e: unknown, i: number) => {
        if (!e || typeof e !== 'object') return
        const fp = (e as Record<string, unknown>).file_path
        if (typeof fp === 'string' && fp !== '') paths.push(fieldPath(fp, 'write', `edits[${i}].file_path`, cwd, r))
      })
    }
  }
  if (row?.special === 'applyPatch') {
    const patch = input.patch
    if (typeof patch === 'string') {
      for (const p of patchPaths(patch)) {
        const n = fieldPath(p.raw, p.op, p.via, cwd, r)
        if (p.op === 'link') {
          const P = r.platform === 'win32' ? nodePath.win32 : nodePath.posix
          n.linkTarget = p.linkTarget ? P.resolve(P.dirname(n.path), p.linkTarget) : null
        }
        paths.push(n)
      }
    }
  }
  // The generic rule: nothing the three old checks read is lost.
  for (const k of GENERIC_KEYS) {
    if (namedKeys.has(k)) continue
    const v = str(k)
    if (v !== null) paths.push(fieldPath(v, WRITE_TOOLS.has(toolName) ? 'write' : 'read', k, cwd, r))
  }
  if (!spelledKeys.has('pattern')) {
    const v = str('pattern')
    if (v !== null) spellings.push(v)
  }
  return { paths, spellings }
}

// ─── The scan memo (Bash and Git only) ────────────────────────────────────────────────────────

type MemoEntry = { tool: string; cwd: string; homes: HomeMap; platform: Platform; keys: string[]; scan: ShellScan; texts: string[] }
const memo = new WeakMap<object, MemoEntry[]>()
const MEMO_PER_INPUT = 4

function shellScanOf(toolName: 'Bash' | 'Git', input: Record<string, unknown>, cwd: string, homes: HomeMap, platform: Platform)
  : { scan: ShellScan; texts: string[] } {
  const keys = toolName === 'Bash'
    ? [String(input.command ?? '')]
    : [String(input.subcommand ?? ''), String(input.args ?? '')]
  const list = memo.get(input) ?? []
  const hit = list.find(e => e.tool === toolName && e.cwd === cwd && e.homes === homes && e.platform === platform
    && e.keys.length === keys.length && e.keys.every((k, i) => k === keys[i]))
  if (hit) return { scan: hit.scan, texts: hit.texts }
  let made: { scan: ShellScan; texts: string[] }
  if (toolName === 'Bash') {
    const scan = scanShellText(keys[0], cwd, homes, { platform })
    made = { scan, texts: scan.texts }
  } else {
    // The argv the Git tool itself builds, in its own order (engine/tools/impl/git.ts, `execute`).
    const rawSub = keys[0]
    const args = keys[1]
    const subTokens = tokenizeArgs(rawSub)
    const sub = subTokens[0] ?? rawSub
    const argTokens = [...subTokens.slice(1), ...tokenizeArgs(args)]
    const scan = scanArgv(['git', ...buildArgv(sub, argTokens)], cwd, homes, { platform })
    made = { scan, texts: [`git ${rawSub} ${args}`.trim()] }
  }
  list.unshift({ tool: toolName, cwd, homes, platform, keys, ...made })
  if (list.length > MEMO_PER_INPUT) list.length = MEMO_PER_INPUT
  memo.set(input, list)
  return made
}

/**
 * Every path one tool call names. Never throws (a caught error is a `faults` entry), never spawns,
 * reads no environment.
 */
export function namePaths(toolName: string, input: Record<string, unknown>, cwd: string, homes?: HomeMap, opts?: NameOpts): NamedCall {
  const faults: string[] = []
  const paths: NamedPath[] = []
  const spellings: string[] = []
  let texts: string[] = []
  let scan: ShellScan | null = null
  try {
    const h = homes ?? currentHomes()
    const r = resolverOf(cwd, h, opts)
    const fp = fieldPathsWith(toolName, input, cwd, r)
    paths.push(...fp.paths)
    spellings.push(...fp.spellings)
    const special = TOOL_PATH_TABLE[toolName]?.special
    if ((special === 'bash' || special === 'git') && input && typeof input === 'object') {
      const made = shellScanOf(special === 'bash' ? 'Bash' : 'Git', input, cwd, h, r.platform)
      scan = made.scan
      texts = made.texts
      faults.push(...scan.faults)
      for (const s of scan.paths) {
        if (s.path === null) continue
        const n: NamedPath = {
          raw: s.raw, path: s.path, real: realFn(s.path, r), op: s.op, source: 'shell', via: s.via,
          recursive: s.recursive, children: s.children, inherited: s.inherited, anchor: s.anchor, device: s.device, verb: s.verb,
        }
        if (s.linkTarget !== undefined) n.linkTarget = s.linkTarget
        if (s.unsetName) n.unsetName = s.unsetName
        paths.push(n)
      }
    }
  } catch (e) {
    faults.push(`the call could not be named: ${(e as Error)?.message ?? String(e)}`)
  }
  return { paths, spellings, texts, scan, faults }
}
