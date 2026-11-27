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
 * Pure apart from `real()`, which asks the injected resolver (default `realPathOf`, quiet; the path check passes
 * `realPathChecked`, which throws for a link whose target cannot be resolved) once per path,
 * and never for a UNC path, a path on a drive the run has no folder on, or a path inside a lexical root:
 * a sleeping share or a disconnected drive must never block a tool call. It reads no environment
 * variable and starts no process. It must not import `registry.js`, `executor.js`, `sealedPaths.js`,
 * `secretPaths.js` or `protectedPaths.js` (the Bash tool imports the policy, which imports this file).
 */
import { realpathSync } from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { listEntries, realPathOf, type EntryKind } from '../realPath.js'
import { runContainment, type RunContainment } from '../containment.js'
import { ADMIN_SHARE_HOST, scanArgv, scanShellText, type Anchor, type HomeMap, type PathOp, type ShellScan } from './shellPaths.js'
import { buildArgv, tokenizeArgs } from './gitArgv.js'

export type NamedPath = {
  raw: string; path: string; real(): string
  op: PathOp; source: 'field' | 'shell'; via: string
  recursive: boolean; children: boolean; inherited: boolean
  anchor: Anchor; device: boolean; linkTarget?: string | null
  verb?: string
  unsetName?: string   // the shell word started with this name, which nothing in the command set
  staleBase?: true     // a working-folder spelling read after a folder change the scan could not follow
  startedIn?: true     // the folder a program, a script, an interpreter or git is started in
  deviceOp?: string    // a volume, disk, partition, shadow-copy or backup operation that names no path
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
  // The local administrative share is the local drive (`\\localhost\C$\x`, `\\127.0.0.1\C$\x`; wave 15b, as the
  // shell scan reads it since wave 15): judged as a share, a write in the mission folder through it was refused
  // and a read of the audit folder through it was allowed. Since wave 15c (N10) also the loopback spellings
  // `ADMIN_SHARE_HOST` lists (`shellPaths.ts`): `localhost`, a decimal 127 address in two to four parts (`127.1`,
  // `127.0.1`), each with a trailing dot, `[::1]` and `0--1.ipv6-literal.net`. Any spelling it does not list (decimal,
  // hex or octal forms, a longer IPv6 literal name, this machine's own name) stays a share here (wave 19, C7); the
  // path check refuses the audit and guard folders through an administrative share of any host (`judgePath`).
  const admin = s.match(new RegExp(`^[\\\\/]{2}${ADMIN_SHARE_HOST}[\\\\/]([A-Za-z])\\$(?=[\\\\/]|$)(.*)$`, 'i'))
  if (admin) s = `${admin[1]}:${admin[2] === '' ? '\\' : admin[2]}`
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
  MakeModel: { fields: [{ key: 'file', op: 'read' }] },
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
  // The default never throws: the sealed, immutable and secret checks read `real()` in every mode. The path check
  // passes its own resolver, `realPathChecked` (`protectedPaths.ts`).
  return { platform, real: opts?.real ?? (p => realPathOf(p, { quiet: true })), drives: drives.map(d => d.toUpperCase()), lexicalRoots }
}

/** A path that goes through a link whose real path cannot be resolved (`realPathChecked`). */
export class UnresolvedLinkError extends Error {
  constructor(readonly link: string, readonly why: string, private readonly text?: string) {
    super(`${link} is a link whose target cannot be resolved (${why})`)
  }
  /** The refusal's reason. */
  get reason(): string {
    return this.text ?? `this call names a path through ${this.link}, a link whose target cannot be resolved (${this.why}); such a link leads wherever its target is made again, and an unattended run does not run what it cannot read`
  }
}

/** One judgement's folder listings (`realPathChecked`): a folder, as named, to its entries, or null when it cannot be listed. */
export type ListingMemo = Map<string, Array<{ name: string; kind: EntryKind }> | null>

/** The most levels of a path that do not exist yet that `realPathChecked` walks up before it refuses. */
const MAX_MISSING_LEVELS = 256

/**
 * A Windows 8.3 short name (`DANGLI~1`, `AB12F3~2.TXT`): a folder's listing holds only long names, so an entry named
 * by its short name is not found in it. A short name keeps at least the first two characters of its long name once
 * leading dots and spaces are dropped and the characters 8.3 does not take become `_` (letters outside ASCII were
 * dropped, measured; the first six in the usual form, the first two before a hash after many collisions).
 */
const SHORT_NAME = /^([^\s.~"*/\\:<>?|]{1,6})~\d{1,6}(?:\.[^\s."*/\\:<>?|]{1,3})?$/

/**
 * Is the entry at `p` a link, by its folder's listing (`isLinkEntry`, `realPath.ts`, with the listing taken once per
 * folder for one judgement)? `null` when that cannot be told: the folder cannot be listed, or holds no such name.
 * On Windows a name with a short name's shape that the listing does not hold counts as a link when some link of the
 * folder could carry it (its long name starts with the short name's first two letters): a junction named by its
 * short name is otherwise not found (C19-1, wave 19b).
 */
function linkEntryOf(p: string, memo: ListingMemo): boolean | null {
  const full = nodePath.resolve(p)
  const parent = nodePath.dirname(full)
  if (parent === full) return false
  const win = process.platform === 'win32'
  const fold = (s: string) => (win ? s.toLowerCase() : s)
  let entries = memo.get(fold(parent))
  if (entries === undefined) {
    try {
      entries = listEntries(parent)
    } catch (e) {
      void e
      entries = null
    }
    memo.set(fold(parent), entries)
  }
  if (entries === null) return null
  const name = fold(nodePath.basename(full))
  const hit = entries.find(e => fold(e.name) === name)
  if (hit !== undefined) return hit.kind === 'link'
  const short = win ? SHORT_NAME.exec(nodePath.basename(full)) : null
  if (short !== null) {
    const head = short[1].slice(0, 2).toUpperCase()
    // The long name as its short name begins (C19b-2, measured with `dir /x` on 2026-11-25): upper case, spaces and
    // dots dropped, `+ , ; = [ ]` as `_`; a letter outside ASCII was dropped on this PC (`\u00e9tudes` TUDES~1) and
    // may be `_` under another code page, so both readings count.
    const upperLong = (s: string) => s.toUpperCase().replace(/[\s.]/g, '').replace(/[+,;=[\]]/g, '_')
    const longForms = (s: string) => [upperLong(s).replace(/[^\x21-\x7e]/g, ''), upperLong(s).replace(/[^\x21-\x7e]/g, '_')]
    if (entries.some(e => e.kind === 'link' && hasShortName(e.name) && longForms(e.name).some(l => l.startsWith(head)))) return true
  }
  return null
}

/**
 * Whether Windows gives `name` a short name of its own: a name that is not already a valid 8.3 name (a name that
 * starts with a dot, a letter outside ASCII, a base over eight characters, an extension over three, more than one
 * dot, a space or a character 8.3 names do not take; `.bun` has BUN~1, measured with `dir /x`, C19b-2). So a
 * revision such as `HEAD~1` beside a link named `helpers` is not read as that link's short name.
 */
function hasShortName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  const base = dot < 0 ? name : name.slice(0, dot)
  const ext = dot < 0 ? '' : name.slice(dot + 1)
  return dot === 0 || /[^\x21-\x7e]/.test(name) || base.length > 8 || ext.length > 3 || base.includes('.') || /[\s+,;=[\]]/.test(name)
}

/**
 * Where `p` really lands, after a walk of the path up to its first ancestor the OS resolves
 * (`realpathSync.native`), the levels that do not exist yet joined back onto that ancestor's real path. An entry the
 * folder's own listing calls a link (`linkEntryOf`) whose native real path cannot be resolved throws
 * `UnresolvedLinkError` (wave 19, from the box core builder): a junction a low-integrity process made, whose target
 * is gone, was judged where its own path lies (inside the mission folder) while it leads wherever its target is made
 * again; the sandbox's establish rule refuses such a link the same way. A path with more than `MAX_MISSING_LEVELS`
 * levels that do not exist throws too, never falls back to its lexical path (C19-2, wave 19b: `realPathOf` gave up
 * after 64 and judged a path 65 levels below a live link to the home inside the mission folder). A path that exists
 * costs no listing; a new file, one listing of its folder, taken once per judgement when `memo` is given (C19-3).
 */
export function realPathChecked(p: string, memo: ListingMemo = new Map()): string {
  let cur = nodePath.resolve(p)
  const tail: string[] = []
  for (let hops = 0; hops < MAX_MISSING_LEVELS; hops++) {
    let real: string | null = null
    try {
      real = realpathSync.native(cur)
    } catch (e) {
      if (linkEntryOf(cur, memo) === true) throw new UnresolvedLinkError(cur, (e as NodeJS.ErrnoException).code ?? (e as Error).message)
      // An entry the system's own resolution cannot answer that is not a link (a substituted drive, say): the
      // JS resolution, as `realPathOf` takes it.
      try {
        real = realpathSync(cur)
      } catch (e2) {
        void e2
      }
    }
    if (real !== null) return tail.length ? nodePath.join(real, ...tail.reverse()) : real
    const parent = nodePath.dirname(cur)
    if (parent === cur) return tail.length ? nodePath.join(cur, ...tail.reverse()) : cur
    tail.push(nodePath.basename(cur))
    cur = parent
  }
  throw new UnresolvedLinkError(p, 'too deep',
    `this call names a path with more than ${MAX_MISSING_LEVELS} levels that do not exist yet, which the check does not walk; an unattended run does not run what it cannot read`)
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

type MemoEntry = { tool: string; cwd: string; homes: HomeMap; platform: Platform; drives: string; keys: string[]; scan: ShellScan; texts: string[] }
const memo = new WeakMap<object, MemoEntry[]>()
const MEMO_PER_INPUT = 4

function shellScanOf(toolName: 'Bash' | 'Git', input: Record<string, unknown>, cwd: string, homes: HomeMap, platform: Platform, drives: string[])
  : { scan: ShellScan; texts: string[] } {
  const driveKey = drives.join(',')
  const keys = toolName === 'Bash'
    ? [String(input.command ?? '')]
    : [String(input.subcommand ?? ''), String(input.args ?? '')]
  const list = memo.get(input) ?? []
  const hit = list.find(e => e.tool === toolName && e.cwd === cwd && e.homes === homes && e.platform === platform && e.drives === driveKey
    && e.keys.length === keys.length && e.keys.every((k, i) => k === keys[i]))
  if (hit) return { scan: hit.scan, texts: hit.texts }
  let made: { scan: ShellScan; texts: string[] }
  if (toolName === 'Bash') {
    const scan = scanShellText(keys[0], cwd, homes, { platform, drives })
    made = { scan, texts: scan.texts }
  } else {
    // The argv the Git tool itself builds, in its own order (engine/tools/impl/git.ts, `execute`).
    const rawSub = keys[0]
    const args = keys[1]
    const subTokens = tokenizeArgs(rawSub)
    const sub = subTokens[0] ?? rawSub
    const argTokens = [...subTokens.slice(1), ...tokenizeArgs(args)]
    const scan = scanArgv(['git', ...buildArgv(sub, argTokens)], cwd, homes, { platform, drives })
    made = { scan, texts: [`git ${rawSub} ${args}`.trim()] }
  }
  list.unshift({ tool: toolName, cwd, homes, platform, drives: driveKey, keys, ...made })
  if (list.length > MEMO_PER_INPUT) list.length = MEMO_PER_INPUT
  memo.set(input, list)
  return made
}

/** The text of one call's input this check reads at most (the Bash command's own limit is the same). */
const MAX_INPUT_TEXT = 1024 * 1024
/** The most field paths one call may name (MultiEdit's edits, a patch's file headers). */
const MAX_FIELD_PATHS = 512

/** Keys whose text the check never reads (a file's new content): a long file written with Write stays allowed. */
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'new_body', 'new_source'])

/**
 * Why an input is too large to read, or null: the length of the strings the check reads (every string but
 * a file's content), counted until the limit is passed.
 */
function inputTooLarge(input: unknown): string | null {
  let total = 0
  const stack: unknown[] = [input]
  let seen = 0
  while (stack.length) {
    const v = stack.pop()
    if (++seen > 1_000_000) return 'an input with more than a million values'
    if (typeof v === 'string') { total += v.length; if (total > MAX_INPUT_TEXT) return 'an input longer than 1 MiB' }
    else if (Array.isArray(v)) { for (const x of v) stack.push(x) }
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!CONTENT_KEYS.has(k)) stack.push(x)
    }
  }
  return null
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
    // An input too large to read in the time a call may take on the event loop is refused unread (review
    // 2026-11-23, fourth: 20 MB of patch headers or 200,000 edits were read for seconds, F225).
    const big = inputTooLarge(input)
    if (big !== null) { faults.push(big); return { paths, spellings, texts, scan, faults } }
    const fp = fieldPathsWith(toolName, input, cwd, r)
    if (fp.paths.length > MAX_FIELD_PATHS) { faults.push(`more than ${MAX_FIELD_PATHS} paths in one call`); return { paths, spellings, texts, scan, faults } }
    paths.push(...fp.paths)
    spellings.push(...fp.spellings)
    const special = TOOL_PATH_TABLE[toolName]?.special
    if ((special === 'bash' || special === 'git') && input && typeof input === 'object') {
      const made = shellScanOf(special === 'bash' ? 'Bash' : 'Git', input, cwd, h, r.platform, r.drives)
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
        if (s.staleBase) n.staleBase = true
        if (s.startedIn) n.startedIn = true
        if (s.deviceOp) n.deviceOp = s.deviceOp
        paths.push(n)
      }
    }
  } catch (e) {
    faults.push(`the call could not be named: ${(e as Error)?.message ?? String(e)}`)
  }
  return { paths, spellings, texts, scan, faults }
}
