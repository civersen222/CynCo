/**
 * engine/tools/shellPaths.ts: the paths a shell command names, each with what the command does to it
 * (F242, layer 2: protected paths).
 *
 * `scanShellText` reads a command the Bash tool would run (PowerShell 5.1 on Windows, with cmd and
 * POSIX spellings arriving through it, and the Python and JavaScript of an inline program) and names
 * every path in it with an operation: read, list, write, delete, move, link, exec, cd, mention or
 * unclassified. `scanArgv` does the same for an argv that reaches its program with no shell between
 * (the Git tool). Both are pure: no file system, no environment, no process; the home folders and the
 * platform are parameters, and a relative word is resolved against the given base, never against this
 * process's own working folder. Neither throws: a caught error or a hard limit is a sentence in
 * `faults`.
 *
 * This is a tripwire, not a parser: it approximates four languages, and where two shells read a text
 * differently both readings are emitted. What it cannot read is reported as an unresolved mutation or a
 * self-building marker, never guessed as harmless. `protectedPaths.ts` is the policy that judges what is
 * found here; `toolPaths.ts` feeds it.
 *
 * The environment spellings below (`$env:NAME`, `%NAME%`, `process.env.NAME`, ...) are table data
 * matched in the command text; this module reads no environment variable of its own.
 */
import * as nodePath from 'node:path'
import { bashEffect } from './bashEffect.js'

// ─── Types ─────────────────────────────────────────────────────────────────────────────────────

export type HomeMap = { home: string; appData: string; localAppData: string; temp: string; scratch: string | null; user: string }
export type PathOp = 'read' | 'list' | 'write' | 'delete' | 'move' | 'link' | 'exec' | 'cd' | 'mention' | 'unclassified'
export type Anchor = 'home' | 'appdata' | 'localappdata' | 'temp' | 'scratch' | 'cwd'
  | 'systemdrive' | 'onedrive' | 'public' | 'programdata' | null
export type ShellPath = {
  raw: string                 // the word as written
  path: string | null         // absolute and lexical, or null when the word could not be read
  op: PathOp
  recursive: boolean; children: boolean; inherited: boolean
  anchor: Anchor; device: boolean   // anchor: the table entry the word was resolved through (engine log, tests)
  linkTarget?: string | null  // for op 'link': the target, or null when it could not be read
  verb: string                // the verb or call that classified it
  via: string                 // 'shell', 'shell>cmd /c', 'shell>python -c', 'shell>encoded', 'shell>heredoc', 'argv'
}
export type ShellScan = {
  paths: ShellPath[]
  texts: string[]             // texts[0] is the input; every unwrapped payload and every here-document body is appended
  unresolvedMutation: { op: 'write' | 'delete' | 'move' | 'link'; verb: string; recursive: boolean } | null
  parentClimb: number         // parent-climb tokens seen in a text that has an unresolved mutation
  selfBuilding: string | null // the marker that was found
  gitDestructive: boolean
  gitConfigWrite: string | null   // the first setting, other than user.name and user.email, a writing `git config` names
  truncated: string | null    // which limit cut the scan short
  sawWrite: boolean           // a write-class verb, a redirect or a mutating code call was seen anywhere
  faults: string[]            // caught errors and hard limits
}
export type ScanOpts = { platform?: 'win32' | 'posix' }

type Platform = 'win32' | 'posix'
type MutOp = 'write' | 'delete' | 'move' | 'link'

// ─── Limits and markers ────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 1024 * 1024
const MAX_DEPTH = 4
const MAX_PATHS = 512

/** Sentinels in a substituted text: S0 <index> S1 names an entry of the scan's table. */
const S0 = '\u0002'
const S1 = '\u0003'
/** In an expanded word: a piece that cannot be read before the command runs. */
const UNREAD = '\u0004'
/** In an expanded word: the pipeline's current item (`$_`, `$PSItem`, `{}`). */
const PIPE = '\u0005'

const WILDCARD = /[*?[]/

// ─── The scan's shared state ───────────────────────────────────────────────────────────────────

type Binding = { pos: number; value: string | null; here: number | null }
type Entry =
  | { k: 'anchor'; anchor: Exclude<Anchor, null>; tail: string; orig: string }
  | { k: 'text'; text: string; orig: string }
  | { k: 'bound'; b: Binding; orig: string }
  | { k: 'u'; orig: string; unset?: true }   // unset: a name nothing assigned and no table knows (empty when the command runs)
  | { k: 'p'; orig: string }
  | { k: 'here'; body: number; orig: string }
  | { k: 'doc'; body: number; orig: string }

type Body = { text: string; use: 'code' | 'data' | null }

interface Run {
  homes: HomeMap
  platform: Platform
  table: Entry[]
  bodies: Body[]
  out: ShellScan
}

function emptyScan(): ShellScan {
  return {
    paths: [], texts: [], unresolvedMutation: null, parentClimb: 0, selfBuilding: null,
    gitDestructive: false, gitConfigWrite: null, truncated: null, sawWrite: false, faults: [],
  }
}

function sentinel(run: Run, e: Entry): string {
  run.table.push(e)
  return `${S0}${run.table.length - 1}${S1}`
}

function entryAt(run: Run, s: string, i: number): { e: Entry | null; end: number } {
  const j = s.indexOf(S1, i)
  if (j < 0) return { e: null, end: s.length }
  const idx = Number(s.slice(i + 1, j))
  return { e: Number.isInteger(idx) ? (run.table[idx] ?? null) : null, end: j + 1 }
}

/** The text with every sentinel turned back into what was written. */
function renderOrig(run: Run, s: string, dropBodies = false): string {
  if (!s.includes(S0)) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== S0) { out += s[i]; continue }
    const { e, end } = entryAt(run, s, i)
    out += !e || (dropBodies && (e.k === 'here' || e.k === 'doc')) ? '' : e.orig
    i = end - 1
  }
  return out
}

function emit(run: Run, p: ShellPath): void {
  if (run.out.paths.length >= MAX_PATHS) {
    if (run.out.truncated === null) run.out.truncated = `more than ${MAX_PATHS} paths in one command`
    return
  }
  run.out.paths.push(p)
}

const MUT_RANK: Record<MutOp, number> = { write: 1, link: 2, move: 3, delete: 4 }

function unresolved(run: Run, op: MutOp, verb: string, recursive: boolean, text: string): void {
  const cur = run.out.unresolvedMutation
  if (cur === null || MUT_RANK[op] > MUT_RANK[cur.op]) run.out.unresolvedMutation = { op, verb, recursive }
  else if (cur.op === op && recursive && !cur.recursive) run.out.unresolvedMutation = { ...cur, recursive: true }
  run.out.parentClimb = Math.max(run.out.parentClimb, countClimbs(text))
}

/** Parent-climb tokens of a text: a `..` segment, `.parent`, `dirname(`, `Split-Path -Parent`, `GetDirectoryName(`. */
function countClimbs(text: string): number {
  let n = 0
  n += (text.match(/(?:^|[\\/'"`\s(,=])\.\.(?=[\\/'"`\s),]|$)/gm) ?? []).length
  n += (text.match(/\.parent\b/g) ?? []).length
  n += (text.match(/\bdirname\s*\(/g) ?? []).length
  n += (text.match(/\bSplit-Path\b[^;|\n]*-Parent\b/gi) ?? []).length
  n += (text.match(/\bGetDirectoryName\s*\(/g) ?? []).length
  return n
}

// ─── (a) Home spellings ────────────────────────────────────────────────────────────────────────

const ANCHOR_NAMES: Record<string, Exclude<Anchor, null>> = {
  USERPROFILE: 'home', HOME: 'home', HOMEPATH: 'home', PROFILE: 'home',
  APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
  TEMP: 'temp', TMP: 'temp', TMPDIR: 'temp',
  CYNCO_SCRATCH: 'scratch',
  PWD: 'cwd', CD: 'cwd',
  // Windows folders derived from the real home (review 2026-11-23): an unknown name is unreadable, and a
  // delete through one would otherwise only be escalated. On posix they are unreadable.
  SYSTEMDRIVE: 'systemdrive',
  ONEDRIVE: 'onedrive', ONEDRIVECONSUMER: 'onedrive', ONEDRIVECOMMERCIAL: 'onedrive',
  PUBLIC: 'public',
  PROGRAMDATA: 'programdata', ALLUSERSPROFILE: 'programdata',
}
const USER_NAMES = new Set(['USERNAME', 'USER', 'LOGNAME'])

const OS_MOD = String.raw`(?:(?:require\(\s*['"](?:node:)?os['"]\s*\)|\bos)\.)?`
const NOT_ASSIGN = String.raw`(?!\s*[-+*/]?=(?!=))`

/**
 * Every spelling the substitution pass replaces, in the order they are tried. Each alternative has
 * its own named groups; the callback below reads which one matched.
 */
const SUBST = new RegExp([
  String.raw`(?<hd>(?:\$env:HOMEDRIVE|\$\{env:HOMEDRIVE\}|%HOMEDRIVE%)(?:\$env:HOMEPATH|\$\{env:HOMEPATH\}|%HOMEPATH%))`,
  String.raw`(?<gfp>(?:\[(?:System\.)?Environment\]::)?GetFolderPath\s*\((?<gfpArg>[^()]*(?:\([^()]*\)[^()]*)*)\))`,
  String.raw`(?<gev>(?:\[(?:System\.)?Environment\]::)?GetEnvironmentVariable\s*\(\s*['"](?<gevN>\w+)['"][^()]*\))`,
  String.raw`(?<tmpp>(?:\[(?:System\.)?IO\.Path\]::)?GetTempPath\s*\(\s*\))`,
  String.raw`(?<rp>\(\s*Resolve-Path\s+~\s*\)(?:\.Path)?)`,
  String.raw`(?<gl>\(\s*Get-Location\s*\)(?:\.Path)?)`,
  String.raw`(?<pwds>\$\(\s*pwd\s*\))`,
  String.raw`(?<envi>(?:\bos\.)?\benviron(?:\[\s*(?<eq1>['"])(?<en1>\w+)\k<eq1>\s*\]${NOT_ASSIGN}|\.get\(\s*(?<eq2>['"])(?<en2>\w+)\k<eq2>\s*(?:,[^()]*)?\)))`,
  String.raw`(?<penv>\bprocess\.env(?:\.(?<pe1>\w+)|\[\s*['"](?<pe2>\w+)['"]\s*\])${NOT_ASSIGN})`,
  String.raw`(?<benv>\bBun\.env\.(?<be>\w+))`,
  String.raw`(?<genv>(?:\bos\.)?\bgetenv\(\s*['"](?<ge>\w+)['"]\s*(?:,[^()]*)?\))`,
  String.raw`(?<plenv>\$ENV\{(?<pl>\w+)\})`,
  String.raw`(?<rbenv>\bENV\[\s*['"](?<rb>\w+)['"]\s*\])`,
  String.raw`(?<denv>\$\{env:(?<de>\w+)\}${NOT_ASSIGN})`,
  String.raw`(?<psenv>\$env:(?<pse>\w+)${NOT_ASSIGN})`,
  String.raw`(?<psdrv>(?<![\w$:])Env:\\?(?<pd>\w+))`,
  String.raw`(?<brace>\$\{(?<br>\w+)\})`,
  String.raw`(?<item>\$(?:_|PSItem)(?!\w))`,
  String.raw`(?<keep>\$(?:null|true|false)(?!\w))`,
  String.raw`(?<dvar>\$(?<dv>[A-Za-z_]\w*)${NOT_ASSIGN})`,
  String.raw`(?<dpos>\$(?:\d|[@*#?$!]))`,
  String.raw`(?<pct>%(?<pc>[A-Za-z_]\w*)%)`,
  // A cmd `for` variable (`%d`, `%%d` in a batch): a value the scan cannot read.
  String.raw`(?<forv>%%?[A-Za-z](?![\w%]))`,
  String.raw`(?<bang>!(?<bg>[A-Za-z_]\w*)!)`,
  String.raw`(?<phome>(?:\bpathlib\.)?\bPath\.home\(\s*\))`,
  String.raw`(?<pcwd>(?:\bpathlib\.)?\bPath\.cwd\(\s*\))`,
  String.raw`(?<expu>(?:\bos\.path\.)?\bexpanduser\(\s*(?:(?<exq>['"])(?<ext>[^'"]*)\k<exq>|(?<exa>[^()'"\s][^()'"]*))\s*\))`,
  String.raw`(?<uinfo>${OS_MOD}\buserInfo\(\s*\)\.homedir)`,
  String.raw`(?<hdir>${OS_MOD}\bhomedir\(\s*\))`,
  String.raw`(?<pwuid>(?:\bpwd\.)?\bgetpwuid\([^()]*(?:\([^()]*\))?[^()]*\)(?:\.pw_dir|\[\s*5\s*\])?)`,
  String.raw`(?<dhome>\bDir\.home\b)`,
  String.raw`(?<otmp>${OS_MOD}\btmpdir\(\s*\))`,
  String.raw`(?<gtmp>(?:\btempfile\.)?\bgettempdir\(\s*\))`,
  String.raw`(?<mktmp>(?:\btempfile\.)?\bmk[sd]temp\([^()]*\))`,
  String.raw`(?<gcwd>\bos\.getcwd\(\s*\)|\bprocess\.cwd\(\s*\))`,
  String.raw`(?<guser>\bgetpass\.getuser\(\s*\)|\bos\.getlogin\(\s*\))`,
].join('|'), 'gi')

type Bindings = Map<string, Binding[]>

/** The binding of `keys` that holds at `pos`: undefined when none was assigned before it, null when unreadable. */
function bindingAt(bindings: Bindings, keys: string[], pos: number): Binding | null | undefined {
  for (const key of keys) {
    const list = bindings.get(key)
    if (!list) continue
    const before = list.filter(b => b.pos <= pos)
    if (before.length === 0) continue
    if (list.length > 1) return null
    return before[0]
  }
  return undefined
}

function anchorEntry(run: Run, anchor: Exclude<Anchor, null>, orig: string, tail = ''): string {
  return sentinel(run, { k: 'anchor', anchor, tail, orig })
}

/** One env-style name read at `pos`: the propagation table first, then the anchor table. */
function envName(run: Run, bindings: Bindings, name: string, pos: number, orig: string, keyOrder: 'env' | 'var', unknown: 'u' | 'keep'): string {
  const lower = name.toLowerCase()
  const keys = keyOrder === 'env' ? [`env:${lower}`, lower] : [lower, `env:${lower}`]
  const b = bindingAt(bindings, keys, pos)
  if (b === null) return sentinel(run, { k: 'u', orig })
  if (b !== undefined) return sentinel(run, { k: 'bound', b, orig })
  const upper = name.toUpperCase()
  const anchor = ANCHOR_NAMES[upper]
  if (anchor) return anchorEntry(run, anchor, orig)
  if (USER_NAMES.has(upper)) return sentinel(run, { k: 'text', text: run.homes.user, orig })
  return unknown === 'u' ? sentinel(run, { k: 'u', orig, unset: true }) : orig
}

function substitute(run: Run, text: string, bindings: Bindings, offset = 0): string {
  return text.replace(SUBST, (m: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>
    const pos = offset + (rest[rest.length - 3] as number)
    const g = (k: string) => groups[k]
    if (g('hd') !== undefined) return anchorEntry(run, 'home', m)
    if (g('gfp') !== undefined) {
      const arg = g('gfpArg') ?? ''
      if (/LocalApplicationData/i.test(arg)) return anchorEntry(run, 'localappdata', m)
      if (/ApplicationData/i.test(arg)) return anchorEntry(run, 'appdata', m)
      return anchorEntry(run, 'home', m)
    }
    if (g('gev') !== undefined) return envName(run, bindings, g('gevN') ?? '', pos, m, 'env', 'u')
    if (g('tmpp') !== undefined || g('otmp') !== undefined || g('gtmp') !== undefined || g('mktmp') !== undefined) return anchorEntry(run, 'temp', m)
    if (g('rp') !== undefined || g('phome') !== undefined || g('uinfo') !== undefined || g('hdir') !== undefined
      || g('pwuid') !== undefined || g('dhome') !== undefined) return anchorEntry(run, 'home', m)
    if (g('gl') !== undefined || g('pwds') !== undefined || g('pcwd') !== undefined || g('gcwd') !== undefined) return anchorEntry(run, 'cwd', m)
    if (g('envi') !== undefined) return envName(run, bindings, g('en1') ?? g('en2') ?? '', pos, m, 'env', 'u')
    if (g('penv') !== undefined) return envName(run, bindings, g('pe1') ?? g('pe2') ?? '', pos, m, 'env', 'u')
    if (g('benv') !== undefined) return envName(run, bindings, g('be') ?? '', pos, m, 'env', 'u')
    if (g('genv') !== undefined) return envName(run, bindings, g('ge') ?? '', pos, m, 'env', 'u')
    if (g('plenv') !== undefined) return envName(run, bindings, g('pl') ?? '', pos, m, 'env', 'u')
    if (g('rbenv') !== undefined) return envName(run, bindings, g('rb') ?? '', pos, m, 'env', 'u')
    if (g('denv') !== undefined) return envName(run, bindings, g('de') ?? '', pos, m, 'env', 'u')
    if (g('psenv') !== undefined) return envName(run, bindings, g('pse') ?? '', pos, m, 'env', 'u')
    if (g('psdrv') !== undefined) return envName(run, bindings, g('pd') ?? '', pos, m, 'env', 'u')
    if (g('brace') !== undefined) return envName(run, bindings, g('br') ?? '', pos, m, 'var', 'u')
    if (g('item') !== undefined) return sentinel(run, { k: 'p', orig: m })
    if (g('keep') !== undefined) return m
    if (g('dvar') !== undefined) return envName(run, bindings, g('dv') ?? '', pos, m, 'var', 'u')
    if (g('dpos') !== undefined) return sentinel(run, { k: 'u', orig: m })
    if (g('pct') !== undefined) return envName(run, bindings, g('pc') ?? '', pos, m, 'env', 'u')
    if (g('forv') !== undefined) return sentinel(run, { k: 'u', orig: m })
    if (g('bang') !== undefined) return envName(run, bindings, g('bg') ?? '', pos, m, 'env', 'keep')
    if (g('expu') !== undefined) {
      const lit = g('ext')
      if (lit === undefined) return anchorEntry(run, 'home', m)
      if (/^~(?:[\\/]|$)/.test(lit)) return anchorEntry(run, 'home', m, lit.slice(1))
      return sentinel(run, { k: 'text', text: lit, orig: m })
    }
    if (g('guser') !== undefined) return sentinel(run, { k: 'text', text: run.homes.user, orig: m })
    return m
  })
}

// ─── (c2) Single-assignment constant propagation ──────────────────────────────────────────────

/** The end of the statement that starts at `i`: the first `;`, newline, `|`, `}` or `)` outside quotes and brackets. */
function statementEnd(s: string, i: number, stopAtSpace: boolean): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === "'" || c === '"' || c === '`') {
      const k = closingQuote(s, j)
      j = k
      continue
    }
    if (c === S0) { const k = s.indexOf(S1, j); j = k < 0 ? s.length : k; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; continue }
    if ((c === ')' || c === ']' || c === '}') && depth > 0) { depth--; continue }
    if (depth > 0) continue
    if (c === ';' || c === '\n' || c === '|' || c === ')' || c === '}' || (c === '&' && s[j + 1] === '&')) return j
    if (stopAtSpace && (c === ' ' || c === '\t')) return j
  }
  return s.length
}

function closingQuote(s: string, j: number): number {
  const q = s[j]
  for (let k = j + 1; k < s.length; k++) {
    if (q !== "'" && (s[k] === '\\' || s[k] === '`')) { k++; continue }
    if (s[k] === q) {
      if (q === "'" && s[k + 1] === "'") { k++; continue }
      return k
    }
  }
  return s.length
}

const PS_ASSIGN = /(^|[\s;{(|&])\$(env:)?([A-Za-z_]\w*)\s*([-+*/]?)=(?!=)/g
const POSIX_ASSIGN = /(^|[\s;&|(\n])(export\s+)?([A-Za-z_]\w*)=/g
const CODE_ENV_ASSIGN = /(?:\bos\.environ\[\s*['"](\w+)['"]\s*\]|\bprocess\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\]))\s*=(?!=)/g
const PS_PARAM = /\bparam\s*\(([^)]*)\)/gi
const LOOP_VARS = [
  /\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b/gi,
  /(?:^|[\s;&|(\n])for\s+([A-Za-z_]\w*)\s+in\b/g,
  /-(?:PipelineVariable|pv|OutVariable|ov)\s+([A-Za-z_]\w*)/gi,
  PS_PARAM,
]

/** Reads every shell assignment of a text once (finding 2.M1 part 1). */
function findShellAssignments(run: Run, text: string): Bindings {
  const found: Array<{ key: string; pos: number; rhs: string; rhsAt: number; dialect: 'ps' | 'posix' | 'code' }> = []
  for (const m of text.matchAll(PS_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, false)
    const key = `${m[2] ? 'env:' : ''}${m[3].toLowerCase()}`
    found.push({ key, pos: (m.index ?? 0) + m[1].length, rhs: m[4] ? '\u0000' : text.slice(start, end), rhsAt: start, dialect: 'ps' })
  }
  for (const m of text.matchAll(POSIX_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, true)
    const key = m[3].toLowerCase()
    found.push({ key, pos: (m.index ?? 0) + m[1].length, rhs: text.slice(start, end), rhsAt: start, dialect: 'posix' })
  }
  for (const m of text.matchAll(CODE_ENV_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, false)
    const key = `env:${(m[1] ?? m[2] ?? m[3] ?? '').toLowerCase()}`
    found.push({ key, pos: m.index ?? 0, rhs: text.slice(start, end), rhsAt: start, dialect: 'code' })
  }
  // Loop and parameter variables hold a value the scan cannot read, but they are not empty: bound,
  // unreadable (a leading unset name is read as empty, review 2026-11-23).
  for (const re of LOOP_VARS) {
    for (const m of text.matchAll(re)) {
      const names = re === PS_PARAM ? [...m[1].matchAll(/\$([A-Za-z_]\w*)/g)].map(x => x[1]) : [m[1]]
      for (const n of names) found.push({ key: n.toLowerCase(), pos: m.index ?? 0, rhs: '\u0000', rhsAt: 0, dialect: 'ps' })
    }
  }
  found.sort((a, b) => a.pos - b.pos)
  const bindings: Bindings = new Map()
  for (const f of found) {
    const b: Binding = { pos: f.pos, value: null, here: null }
    const list = bindings.get(f.key) ?? []
    list.push(b)
    bindings.set(f.key, list)
    if (f.rhs === '\u0000') continue
    const lead = f.rhs.length - f.rhs.trimStart().length
    const rhsSub = substitute(run, f.rhs.trim(), bindingsBefore(bindings, f.pos), f.rhsAt + lead)
    const v = f.dialect === 'code' ? evalExpr(run, rhsSub, new Map()) : shellRhsValue(run, rhsSub, f.dialect)
    if (v && typeof v === 'object') { b.here = v.here; b.value = null }
    else b.value = v
  }
  return bindings
}

function bindingsBefore(bindings: Bindings, pos: number): Bindings {
  const out: Bindings = new Map()
  for (const [k, list] of bindings) {
    const before = list.filter(b => b.pos < pos)
    if (before.length) out.set(k, before)
  }
  return out
}

/** The value a shell right-hand side binds, or null when it is unreadable. */
function shellRhsValue(run: Run, rhs: string, dialect: 'ps' | 'posix'): string | null | { here: number } {
  if (rhs === '') return dialect === 'posix' ? '' : null
  const toks = tokenize(rhs)
  if (toks.length !== 1 || toks[0].kind !== 'w') return null
  const w = toks[0]
  const value = w.pieces.map(p => p.t).join('')
  if (w.subs.length) return null
  const only = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  if (only) {
    const e = run.table[Number(only[1])]
    if (e?.k === 'here') return { here: e.body }
  }
  // An unquoted PowerShell right-hand side that is not a variable is a command, not a value.
  if (dialect === 'ps' && w.pieces[0].q === 'n' && !w.pieces[0].t.startsWith(S0)) return null
  if (hasUnreadableSentinel(run, value)) return null
  return value
}

function hasUnreadableSentinel(run: Run, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== S0) continue
    const { e, end } = entryAt(run, s, i)
    if (!e || e.k === 'u' || e.k === 'p' || e.k === 'doc') return true
    if (e.k === 'bound' && e.b.value === null && e.b.here === null) return true
    i = end - 1
  }
  return false
}

// ─── (b) Tokenizer ─────────────────────────────────────────────────────────────────────────────

type Piece = { t: string; q: 'n' | 's' | 'd' }
interface WordTok { kind: 'w'; pieces: Piece[]; start: number; end: number; subs: string[] }
interface OpTok { kind: 'op'; op: string; start: number; end: number }
type Tok = WordTok | OpTok

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let k = open; k < s.length; k++) {
    const c = s[k]
    if (c === "'" || c === '"') { k = closingQuote(s, k); continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return k }
  }
  return s.length
}

const CARET_ESCAPABLE = new Set(['&', '|', '<', '>', '(', ')', '^', '%', '!', '"'])

function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  let pieces: Piece[] = []
  let subs: string[] = []
  let wStart = -1
  const unq = (t: string, at: number) => {
    if (wStart < 0) wStart = at
    const last = pieces[pieces.length - 1]
    if (last && last.q === 'n') last.t += t
    else pieces.push({ t, q: 'n' })
  }
  const quoted = (t: string, q: 's' | 'd', at: number) => {
    if (wStart < 0) wStart = at
    pieces.push({ t, q })
  }
  const endWord = (at: number) => {
    if (wStart >= 0) toks.push({ kind: 'w', pieces, start: wStart, end: at, subs })
    pieces = []; subs = []; wStart = -1
  }
  const op = (o: string, a: number, b: number) => { endWord(a); toks.push({ kind: 'op', op: o, start: a, end: b }) }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\r') { endWord(i); i++; continue }
    if (c === '\n') { op('\n', i, i + 1); i++; continue }
    if (c === S0) {
      const j = s.indexOf(S1, i)
      const end = j < 0 ? s.length : j + 1
      unq(s.slice(i, end), i); i = end; continue
    }
    if (c === '#' && wStart < 0) { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue }
    if (c === '<' && s[i + 1] === '#') { endWord(i); const j = s.indexOf('#>', i + 2); i = j < 0 ? s.length : j + 2; continue }
    if (c === "'") {
      let j = i + 1; let t = ''
      while (j < s.length) {
        if (s[j] === "'") { if (s[j + 1] === "'") { t += "'"; j += 2; continue } break }
        t += s[j]; j++
      }
      quoted(t, 's', i); i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1; let t = ''
      while (j < s.length && s[j] !== '"') {
        const d = s[j]
        if (d === '`' && j + 1 < s.length) { t += s[j + 1]; j += 2; continue }
        if (d === '\\' && (s[j + 1] === '"' || s[j + 1] === '$' || s[j + 1] === '`')) { t += s[j + 1]; j += 2; continue }
        if (d === '$' && s[j + 1] === '(') {
          const k = matchParen(s, j + 1)
          subs.push(s.slice(j + 2, k))
          t += UNREAD; j = k + 1; continue
        }
        if (d === S0) { const k = s.indexOf(S1, j); const e = k < 0 ? s.length : k + 1; t += s.slice(j, e); j = e; continue }
        t += d; j++
      }
      quoted(t, 'd', i); i = j + 1; continue
    }
    if (c === '`') {
      if (i + 1 < s.length) { if (s[i + 1] !== '\n') unq(s[i + 1], i); i += 2 } else i++
      continue
    }
    if (c === '^' && i + 1 < s.length && CARET_ESCAPABLE.has(s[i + 1])) { unq(s[i + 1], i); i += 2; continue }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue }
    if (c === ';') { op(';', i, i + 1); i++; continue }
    if (c === '|') { if (s[i + 1] === '|') { op('||', i, i + 2); i += 2 } else { op('|', i, i + 1); i++ } continue }
    if (c === '&') { if (s[i + 1] === '&') { op('&&', i, i + 2); i += 2 } else { op('&', i, i + 1); i++ } continue }
    const redirStart = c === '>' || (wStart < 0 && (c === '*' || /\d/.test(c)) && s[i + 1] === '>')
    if (redirStart) {
      let j = i
      if (c !== '>') j++
      j++
      let o = '>'
      if (s[j] === '>') { o = '>>'; j++ }
      if (s[j] === '|') j++
      op(o, i, j)
      let k = j
      while (s[k] === ' ' || s[k] === '\t') k++
      if (s[k] === '&' && /\d/.test(s[k + 1] ?? '')) {
        toks.push({ kind: 'w', pieces: [{ t: `&${s[k + 1]}`, q: 'n' }], start: k, end: k + 2, subs: [] })
        j = k + 2
      }
      i = j; continue
    }
    if (c === '<') { op('<', i, i + 1); i++; while (s[i] === '<') i++; continue }
    if (c === '$' && s[i + 1] === '(') { op('$(', i, i + 2); i += 2; continue }
    if (c === '@' && (s[i + 1] === '(' || s[i + 1] === '{')) { op(s[i + 1] === '(' ? '@(' : '{', i, i + 2); i += 2; continue }
    if (c === '{' && s[i + 1] === '}') { unq('{}', i); i += 2; continue }
    if (c === '(' || c === ')' || c === '{' || c === '}') { op(c, i, i + 1); i++; continue }
    unq(c, i); i++
  }
  endWord(s.length)
  return toks
}

// ─── Here-documents and here-strings ──────────────────────────────────────────────────────────

const HERE_STRING = /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n\1@/g
const HERE_DOC = /(^|[\s(;|&])<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\3(?=[\s;|&)]|$)/g

/** Lifts every here-string and here-document body out of a text; the text keeps a sentinel word in its place. */
function liftBodies(run: Run, text: string): string {
  let out = text.replace(HERE_STRING, (m: string, _q: string, body: string) => {
    run.bodies.push({ text: body, use: null })
    return ` ${sentinel(run, { k: 'here', body: run.bodies.length - 1, orig: m })} `
  })
  for (let guard = 0; guard < 64; guard++) {
    HERE_DOC.lastIndex = 0
    let m: RegExpExecArray | null = null
    let found: { m: RegExpExecArray; bodyStart: number; bodyEnd: number; after: number } | null = null
    while ((m = HERE_DOC.exec(out)) !== null) {
      const lineEnd = out.indexOf('\n', m.index + m[0].length)
      if (lineEnd < 0) break
      const tag = m[4]
      const strip = m[2] === '-'
      let k = lineEnd + 1
      let bodyEnd = -1; let after = -1
      while (k <= out.length) {
        const e = out.indexOf('\n', k)
        const line = out.slice(k, e < 0 ? out.length : e).replace(/\r$/, '')
        if ((strip ? line.replace(/^\t+/, '') : line) === tag) { bodyEnd = k; after = e < 0 ? out.length : e; break }
        if (e < 0) break
        k = e + 1
      }
      if (bodyEnd < 0) continue
      found = { m, bodyStart: lineEnd + 1, bodyEnd, after }
      break
    }
    if (!found) break
    const { m: hm, bodyStart, bodyEnd, after } = found
    run.bodies.push({ text: out.slice(bodyStart, Math.max(bodyStart, bodyEnd - 1)), use: null })
    const marker = sentinel(run, { k: 'doc', body: run.bodies.length - 1, orig: hm[0].slice(hm[1].length) })
    const markerAt = hm.index + hm[1].length
    out = out.slice(0, markerAt) + ` ${marker} ` + out.slice(hm.index + hm[0].length, bodyStart - 1) + out.slice(after)
  }
  return out
}

// ─── (j) Self-building markers ─────────────────────────────────────────────────────────────────

const MARKERS: Array<[RegExp, string]> = [
  [/\bInvoke-Expression\b/i, 'Invoke-Expression'],
  [/(?<![\w.-])iex(?![\w.-])/i, 'iex'],
  [/\[(?:System\.)?Convert\]::FromBase64String/i, '[Convert]::FromBase64String'],
  [/\[scriptblock\]::Create/i, '[scriptblock]::Create'],
  [/(?:^|[;&|(\n{]|&&|\|\|)\s*eval\b(?!\s*\()/, 'eval'],
  [/\bbase64(?:\.exe)?\s+(?:-d|--decode|-D)\b[^|\n]*\|\s*(?:\S*[\\/])?(?:sh|bash|zsh|dash|python3?|py|node|bun|perl|ruby|pwsh|powershell|cmd)\b/i, 'base64 -d piped to an interpreter'],
  [/\bcertutil(?:\.exe)?\s+[-/]decode/i, 'certutil -decode'],
  [/&\s*\([^)]*(?:\+|\s-f\b)/i, 'a call operator applied to a built name'],
  // Review 2026-11-23: a call operator or dot-source at the start of a statement applied to a group or a
  // subexpression (`&(gcm Remove-It*) ...`) runs a command the text does not name.
  [/(?:^|[;|{(\n]|&&|\|\|)\s*[&.]\s*\$?\(/, 'a call operator applied to a computed command'],
  [/\.InvokeScript\s*\(|\.InvokeCommand\.|\bNewScriptBlock\s*\(/i, 'a script run through the engine API'],
  [/\b(?:Invoke-Command|icm|Start-Job|sajb|Start-ThreadJob)\b[^\n]*\s-Arg\w*/i, 'a script block handed its arguments'],
]

function findMarker(text: string): string | null {
  for (const [re, name] of MARKERS) if (re.test(text)) return name
  if (/\b(?:exec|eval)\s*\(/.test(text) && /\b(?:b64decode|b32decode|a85decode|fromhex|codecs\.decode|unhexlify)\b|\bchr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(/.test(text)) return 'exec or eval of decoded text'
  if (/\b(?:eval|Function)\s*\(/.test(text) && (/\batob\s*\(/.test(text) || /Buffer\.from\([^)]*['"]base64['"]/.test(text))) return 'eval of decoded text'
  return null
}

function markSelfBuilding(run: Run, marker: string | null): void {
  if (marker !== null && run.out.selfBuilding === null) run.out.selfBuilding = marker
}

// ─── (f) Path candidates ───────────────────────────────────────────────────────────────────────

type Expanded = { text: string; anchor: Anchor; pipe: boolean; here: number | null; doc: number | null; leadUnset: boolean }

function anchorPath(run: Run, a: Exclude<Anchor, null>, base: string): string | null {
  switch (a) {
    case 'home': return run.homes.home
    case 'appdata': return run.homes.appData
    case 'localappdata': return run.homes.localAppData
    case 'temp': return run.homes.temp
    case 'scratch': return run.homes.scratch
    case 'cwd': return base
    case 'systemdrive': return winDrive(run)
    case 'onedrive': return run.platform === 'win32' ? nodePath.win32.join(run.homes.home, 'OneDrive') : null
    case 'public': return run.platform === 'win32' ? nodePath.win32.join(nodePath.win32.dirname(run.homes.home), 'Public') : null
    case 'programdata': { const d = winDrive(run); return d === null ? null : nodePath.win32.join(`${d}\\`, 'ProgramData') }
  }
}

/** The drive of the real home (`C:`), or null off Windows or for a home that has none. */
function winDrive(run: Run): string | null {
  if (run.platform !== 'win32') return null
  const m = run.homes.home.match(/^([A-Za-z]):/)
  return m ? `${m[1].toUpperCase()}:` : null
}

function expand(run: Run, value: string, base: string, tilde: boolean, depth = 0): Expanded {
  let text = ''
  let anchor: Anchor = null
  let pipe = false
  let here: number | null = null
  let doc: number | null = null
  let leadUnset = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c !== S0) { text += c; continue }
    const { e, end } = entryAt(run, value, i)
    i = end - 1
    if (!e) { text += UNREAD; continue }
    switch (e.k) {
      case 'anchor': {
        const p = anchorPath(run, e.anchor, base)
        if (p === null) { text += UNREAD; break }
        if (text === '' && anchor === null) anchor = e.anchor
        text += p + e.tail
        break
      }
      case 'text': text += e.text; break
      case 'bound': {
        if (e.b.here !== null) { if (text === '') here = e.b.here; text += UNREAD; break }
        if (e.b.value === null || depth > 8) { text += UNREAD; break }
        const inner = expand(run, e.b.value, base, true, depth + 1)
        if (text === '' && anchor === null) anchor = inner.anchor
        text += inner.text
        break
      }
      case 'u': if (text === '' && e.unset) leadUnset = true; text += UNREAD; break
      case 'p': pipe = true; text += PIPE; break
      case 'here': if (text === '') here = e.body; break
      case 'doc': if (text === '') doc = e.body; break
    }
  }
  if (tilde && /^~(?:[\\/]|$)/.test(text)) { text = run.homes.home + text.slice(1); anchor = 'home' }
  if (text.includes(PIPE)) pipe = true
  return { text, anchor, pipe, here, doc, leadUnset }
}

type Cand = { path: string; children: boolean; device: boolean; relative: boolean } | 'unreadable' | null

const DRIVE_ABS = /^[A-Za-z]:(?:[\\/]|$)/
const DRIVE_REL = /^[A-Za-z]:(?![\\/])/
const UNC = /^[\\/]{2}[^\\/?.]/

/** Whether a word is a path, and which (finding 2.M4: `\` and `/` are both separators on every platform). */
function toPath(run: Run, text0: string, relAllowed: boolean, base: string, anchored: boolean): Cand {
  let s = text0
  if (s === '' || s.includes(PIPE)) return null
  s = s.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '')
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(?:localhost)?/i, '')
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1)
  }
  let device = false
  const dev = s.match(/^[\\/]{2}[?.][\\/](.*)$/)
  if (dev) {
    const rest = dev[1]
    if (/^UNC[\\/]/i.test(rest)) s = '\\\\' + rest.slice(4)
    else if (DRIVE_ABS.test(rest)) s = rest
    else { device = true }
  }
  let children = false
  const uIdx = s.indexOf(UNREAD)
  const wIdx = device ? -1 : s.search(WILDCARD)
  const cut = uIdx < 0 ? wIdx : wIdx < 0 ? uIdx : Math.min(uIdx, wIdx)
  if (cut >= 0) {
    const prefix = s.slice(0, cut)
    const lastSep = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'))
    const byUnread = cut === uIdx
    if (lastSep < 0) {
      if (byUnread) return 'unreadable'
      if (!relAllowed) return null
      s = '.'
    } else {
      s = prefix.slice(0, lastSep + 1)
      if (byUnread && s.replace(/[\\/]/g, '') === '' && !anchored) return 'unreadable'
    }
    children = true
  }
  if (device) return { path: s, children, device: true, relative: false }
  const isDriveAbs = DRIVE_ABS.test(s)
  const isDriveRel = DRIVE_REL.test(s) && !isDriveAbs
  const isUnc = UNC.test(s)
  const isPosixAbs = !isUnc && /^[\\/]/.test(s)
  const hasDotDot = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)
  const relative = !isDriveAbs && !isDriveRel && !isUnc && !isPosixAbs && !anchored
  if (relative && !hasDotDot && !relAllowed) return null
  return { path: resolveFor(run.platform, base, s, { isDriveAbs, isDriveRel, isUnc, isPosixAbs }), children, device: false, relative }
}

function resolveFor(platform: Platform, base: string, s: string,
  k: { isDriveAbs: boolean; isDriveRel: boolean; isUnc: boolean; isPosixAbs: boolean }): string {
  if (platform === 'posix') {
    if (k.isDriveAbs || k.isUnc || k.isDriveRel) return s
    return nodePath.posix.resolve(base.replace(/\\/g, '/'), s.replace(/\\/g, '/'))
  }
  let w = s.replace(/\//g, '\\')
  if (k.isPosixAbs && !k.isUnc) {
    const msys = w.match(/^\\([A-Za-z])\\(.*\S.*)$/)
    if (msys && msys[2].replace(/\\/g, '') !== '') w = `${msys[1].toUpperCase()}:\\${msys[2]}`
  }
  // A bare drive word (`D:`) is that drive's current folder: the base on the base's own drive, the drive's
  // root on any other, read lexically. It is never handed to win32.resolve, which answers the process's own
  // folder for it under Bun and the drive root under Node (review 2026-11-23).
  if (/^[A-Za-z]:$/.test(w)) return sameDrive(base, w) ? base : `${w.toUpperCase()}\\`
  if (k.isDriveRel) {
    const drive = w.slice(0, 2)
    const rest = w.slice(2)
    if (sameDrive(base, drive)) return nodePath.win32.resolve(base, rest)
    return nodePath.win32.resolve(`${drive.toUpperCase()}\\`, rest)
  }
  return nodePath.win32.resolve(base, w)
}

function sameDrive(base: string, drive: string): boolean {
  return /^[A-Za-z]:/.test(base) && base.slice(0, 2).toLowerCase() === drive.slice(0, 2).toLowerCase()
}

// ─── Segments ──────────────────────────────────────────────────────────────────────────────────

interface Seg {
  id: number
  words: WordTok[]
  redirects: Array<{ op: string; target: WordTok | null }>
  pipeline: number
  pipeIndex: number
  parentPipeline: number | null
  parentPipeIndex: number
  subexpr: boolean
  start: number; end: number
  /** The groups `( )`, `$( )`, `@( )` and `{ }` written inside this command and not merged into a word. */
  groups: Array<{ start: number; end: number; opener: string }>
  /** The command was written after PowerShell's call operator (`& "C:\x\tool.exe" ...`). */
  call?: boolean
}

function segment(toks: Tok[]): Seg[] {
  const segs: Seg[] = []
  let nextId = 0
  let nextPipe = 0
  const mk = (pipeline: number, pipeIndex: number, parentPipeline: number | null, parentPipeIndex: number): Seg =>
    ({ id: nextId++, words: [], redirects: [], pipeline, pipeIndex, parentPipeline, parentPipeIndex, subexpr: false, start: Infinity, end: 0, groups: [] })
  let cur = mk(nextPipe++, 0, null, 0)
  const stack: Array<{ seg: Seg; opener: string; hadWords: boolean; at: number }> = []
  let pending: string | null = null
  const close = (s: Seg) => { if ((s.words.length || s.redirects.length) && !segs.includes(s)) segs.push(s) }
  const touch = (s: Seg, a: number, b: number) => { s.start = Math.min(s.start, a); s.end = Math.max(s.end, b) }
  for (const t of toks) {
    if (t.kind === 'w') {
      if (pending !== null) { cur.redirects.push({ op: pending, target: t }); pending = null }
      else cur.words.push(t)
      touch(cur, t.start, t.end)
      continue
    }
    if (pending !== null) { cur.redirects.push({ op: pending, target: null }); pending = null }
    switch (t.op) {
      case '>': case '>>': case '<':
        pending = t.op; touch(cur, t.start, t.end); break
      case '|':
        close(cur); cur = mk(cur.pipeline, cur.pipeIndex + 1, cur.parentPipeline, cur.parentPipeIndex); break
      case '&':
        if (cur.words.length === 0) { cur.call = true; break }
        close(cur); cur = mk(nextPipe++, 0, cur.parentPipeline, cur.parentPipeIndex); break
      case ';': case '\n': case '&&': case '||':
        close(cur); cur = mk(nextPipe++, 0, cur.parentPipeline, cur.parentPipeIndex); break
      case '(': case '$(': case '@(': case '{': {
        touch(cur, t.start, t.end)
        stack.push({ seg: cur, opener: t.op, hadWords: cur.words.length > 0, at: t.start })
        cur = mk(nextPipe++, 0, cur.pipeline, cur.pipeIndex)
        break
      }
      case ')': case '}': {
        const top = stack.pop()
        const group = top ? { start: top.at, end: t.end, opener: top.opener } : null
        if (top && top.opener !== '{' && top.hadWords) {
          // An expression group handed to a path verb (`Remove-Item ($env:USERPROFILE + '\.x')`) is
          // one of its operands; any other group is a subexpression whose value cannot be read.
          const merged = top.seg.words.length > 0 && isPathVerb(top.seg.words[0]) ? expressionWord(cur) : null
          if (merged) { top.seg.words.push(merged); touch(top.seg, merged.start, merged.end) }
          else { top.seg.subexpr = true; close(cur); if (group) top.seg.groups.push(group) }
        } else { close(cur); if (top && group) top.seg.groups.push(group) }
        cur = top?.seg ?? mk(nextPipe++, 0, null, 0)
        break
      }
    }
  }
  if (pending !== null) cur.redirects.push({ op: pending, target: null })
  close(cur)
  while (stack.length) close((stack.pop() as { seg: Seg }).seg)
  return segs.sort((a, b) => a.start - b.start)
}

function isPathVerb(w: WordTok): boolean {
  const v = verbName(w.pieces.map(p => p.t).join(''))
  return DELETE_VERBS.has(v) || MOVE_VERBS.has(v) || WRITE_TARGET_FIRST.has(v) || WRITE_ALL.has(v) || NEW_ITEM.has(v)
    || COPY_VERBS.has(v) || ARCHIVE_VERBS.has(v) || READ_VERBS.has(v) || LIST_VERBS.has(v) || NOTHING_VERBS.has(v)
    || CD_VERBS.has(v) || v === 'robocopy' || v === 'mklink' || v === 'ln'
}

/** A group that is a value (a variable, an anchor, a quoted string, or such pieces joined by `+`), as one word. */
function expressionWord(inner: Seg): WordTok | null {
  const ws = inner.words
  if (ws.length === 0 || inner.redirects.length) return null
  const first = ws[0].pieces[0]
  if (!first || !(first.q !== 'n' || first.t.startsWith(S0) || first.t.startsWith('$'))) return null
  if (ws.length % 2 === 0) return null
  for (let k = 1; k < ws.length; k += 2) if (ws[k].pieces.map(p => p.t).join('') !== '+') return null
  const pieces: Piece[] = []
  for (let k = 0; k < ws.length; k += 2) pieces.push(...ws[k].pieces)
  return { kind: 'w', pieces, start: ws[0].start, end: ws[ws.length - 1].end, subs: ws.flatMap(w => w.subs) }
}

// ─── (e) The verb table ────────────────────────────────────────────────────────────────────────

const DELETE_VERBS = new Set(['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase', 'clear-content', 'clc', 'clear-item', 'unlink', 'shred', 'rimraf'])
const MOVE_VERBS = new Set(['move-item', 'mi', 'mv', 'move', 'rename-item', 'rni', 'ren', 'rename'])
const WRITE_TARGET_FIRST = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'start-transcript', 'set-itemproperty', 'set-acl', 'truncate'])
const WRITE_ALL = new Set(['tee-object', 'tee', 'mkdir', 'md', 'touch', 'icacls', 'attrib', 'takeown', 'chmod', 'chown'])
const NEW_ITEM = new Set(['new-item', 'ni'])
const COPY_VERBS = new Set(['copy-item', 'cpi', 'cp', 'copy', 'xcopy'])
const ARCHIVE_VERBS = new Set(['expand-archive', 'compress-archive'])
const READ_VERBS = new Set(['get-content', 'gc', 'cat', 'type', 'more', 'less', 'head', 'tail', 'get-item', 'gi', 'test-path',
  'resolve-path', 'convert-path', 'split-path', 'join-path', 'select-string', 'sls', 'grep', 'rg', 'findstr', 'wc', 'sort',
  'uniq', 'diff', 'fc', 'comp', 'compare-object', 'get-filehash', 'certutil', 'stat', 'file', 'du', 'measure-object',
  'where', 'which', 'get-command', 'pytest', 'import-csv', 'get-itemproperty'])
const LIST_VERBS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'tree'])
/** Read verbs whose output down a pipeline is the content of what they read, not the item. */
const CONTENT_VERBS = new Set(['get-content', 'gc', 'cat', 'type', 'more', 'less', 'head', 'tail', 'import-csv', 'sort', 'uniq',
  'findstr', 'grep', 'rg', 'wc'])
/** `ForEach-Object <member>` names that change the item each pipeline element is. */
const MEMBER_MUTATIONS: Record<string, MutOp> = { delete: 'delete', moveto: 'move', replace: 'move', encrypt: 'write', decrypt: 'write' }
const NOTHING_VERBS = new Set(['echo', 'write-host', 'write-output', 'write-verbose', 'printf', 'print'])
const CD_VERBS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'])
const POP_VERBS = new Set(['popd', 'pop-location'])
const INTERPRETERS = new Set(['python', 'python3', 'py', 'pythonw', 'node', 'bun', 'deno', 'ruby', 'perl', 'php',
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl'])
const SCRIPT_EXT = /\.(?:py|js|mjs|cjs|ts|ps1|bat|cmd|sh|rb|pl|php)$/i
const CMD_FAMILY = new Set(['rd', 'rmdir', 'del', 'erase', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'mklink', 'type',
  'dir', 'attrib', 'icacls', 'takeown', 'findstr', 'fc', 'comp', 'tree', 'more', 'where', 'start', 'md', 'mkdir', 'fsutil',
  'certutil', 'find', 'cmd'])
const CMD_SWITCH = /^\/[A-Za-z?]{1,8}(?::.*)?$/
const PS_PATH_PARAMS = new Set(['path', 'literalpath', 'lp', 'pspath', 'destination', 'dest', 'filepath', 'outfile', 'target', 'value', 'destinationpath'])
const PS_VALUE_PARAMS = new Set(['filter', 'include', 'exclude', 'itemtype', 'type', 'encoding', 'name', 'newname', 'depth', 'pattern',
  'argumentlist', 'args', 'workingdirectory', 'erroraction', 'ea', 'warningaction', 'wa', 'credential', 'stream', 'delimiter',
  'first', 'last', 'skip', 'tail', 'totalcount', 'head', 'inputobject', 'property', 'windowstyle', 'verb', 'redirectstandardoutput',
  'redirectstandarderror', 'redirectstandardinput', 'aclobject', 'executionpolicy', 'ep', 'file', 'version', 'outputformat',
  'inputformat', 'configurationname', 'command', 'c', 'encodedcommand', 'width', 'outvariable', 'ov', 'errorvariable', 'ev',
  'membername', 'pipelinevariable', 'pv'])
const RECURSIVE_FLAGS = new Set(['-recurse', '-r', '-rf', '-fr', '--recursive', '/s', '/mir', '-rec'])
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'env', 'xargs', 'start-process', 'saps', 'start', 'exec', 'command', 'nice', 'timeout'])

function verbName(w: string): string {
  // `@rd` in cmd is `rd` with its echo turned off.
  const base = w.replace(/^.*[\\/]/, '').replace(/^@(?=[A-Za-z])/, '').toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/** One word of a segment, read for classification. */
interface Word {
  tok: WordTok
  value: string          // pieces joined, sentinels intact
  text: string           // expanded for flags and names
  raw: string
  quotedFirst: string | null
}

interface Ctx {
  run: Run
  textSub: string        // the substituted text the tokens index
  base: string
  baseUnreadable: boolean
  dirStack: Array<{ base: string; unreadable: boolean }>
  via: string
  depth: number
  tilde: boolean
  segPaths: Map<number, ShellPath[]>
  segs: Seg[]
  origText: string
}

function wordOf(ctx: Ctx, tok: WordTok): Word {
  const value = tok.pieces.map(p => p.t).join('')
  const text = expand(ctx.run, value, ctx.base, ctx.tilde).text
  const quotedFirst = tok.pieces.length > 1 && tok.pieces[0].q !== 'n' && tok.pieces[1].q === 'n' ? tok.pieces[0].t : null
  return { tok, value, text, raw: renderOrig(ctx.run, ctx.textSub.slice(tok.start, tok.end)), quotedFirst }
}

function literalWord(s: string): Word {
  const tok: WordTok = { kind: 'w', pieces: [{ t: s, q: 'n' }], start: 0, end: s.length, subs: [] }
  return { tok, value: s, text: s, raw: s, quotedFirst: null }
}

type Emitted = 'ok' | 'unreadable' | 'pipe' | 'none'

interface EmitOpts { relAllowed: boolean; recursive?: boolean; verb: string; inherited?: boolean; linkTarget?: string | null; children?: boolean }

/** Splits an unquoted comma list (`Remove-Item a,b`) into its words. */
function commaParts(w: Word): Word[] {
  if (!w.tok.pieces.some(p => p.q === 'n' && p.t.includes(','))) return [w]
  if (w.tok.pieces.length === 1) {
    return w.value.split(',').filter(p => p !== '').map(p => ({ ...w, value: p, text: p, raw: p, quotedFirst: null,
      tok: { ...w.tok, pieces: [{ t: p, q: 'n' as const }] } }))
  }
  // A list of quoted items (`'C:\a','C:\b'`): split at the unquoted commas (review 2026-11-23).
  const groups: Piece[][] = [[]]
  for (const p of w.tok.pieces) {
    if (p.q !== 'n') { groups[groups.length - 1].push(p); continue }
    const parts = p.t.split(',')
    parts.forEach((t, k) => {
      if (k > 0) groups.push([])
      if (t !== '') groups[groups.length - 1].push({ t, q: 'n' })
    })
  }
  return groups.filter(g => g.length).map(g => {
    const value = g.map(p => p.t).join('')
    return { ...w, value, text: value, quotedFirst: null, tok: { ...w.tok, pieces: g } }
  })
}

function emitWord(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  let status: Emitted = 'none'
  for (const part of commaParts(w)) {
    const r = emitOne(ctx, seg, part, op, o)
    if (r === 'ok') status = 'ok'
    else if (r !== 'none' && status === 'none') status = r
  }
  return status
}

function emitOne(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  const values = w.quotedFirst !== null ? [w.quotedFirst, w.value] : [w.value]
  let status: Emitted = 'none'
  for (const v of values) {
    const x = expand(ctx.run, v, ctx.base, ctx.tilde)
    if (x.here !== null || x.doc !== null) continue
    if (x.pipe) { if (status === 'none') status = 'pipe'; continue }
    const c = toPath(ctx.run, x.text, o.relAllowed, ctx.base, x.anchor !== null)
    if (c === null) continue
    // A recursive delete or move through a word that starts with a name nothing set, followed by a
    // separator (`"$EMPTY"/*`, `"$env:UNSET\.cache"`): the name is empty when the command runs, and the
    // word is the root of the current drive (entry 4.M3's incident shape; review 2026-11-23).
    if (c === 'unreadable' && x.leadUnset && (op === 'delete' || op === 'move') && o.recursive && /^\u0004+[\\/]/.test(x.text)) {
      const root = ctx.run.platform === 'posix' ? '/' : /^[A-Za-z]:/.test(ctx.base) ? `${ctx.base.slice(0, 2).toUpperCase()}\\` : null
      if (root !== null) {
        const p: ShellPath = { raw: w.raw, path: root, op, recursive: true, children: true, inherited: false, anchor: null, device: false, verb: o.verb, via: ctx.via }
        emit(ctx.run, p)
        if (seg) { const list = ctx.segPaths.get(seg.id) ?? []; list.push(p); ctx.segPaths.set(seg.id, list) }
        status = 'ok'
        continue
      }
    }
    if (c === 'unreadable') { if (status !== 'ok') status = 'unreadable'; continue }
    if (c.relative && ctx.baseUnreadable && isMut(op)) { if (status !== 'ok') status = 'unreadable'; continue }
    const p: ShellPath = {
      raw: w.raw, path: c.path, op, recursive: o.recursive === true, children: c.children || o.children === true,
      inherited: o.inherited === true, anchor: x.anchor, device: c.device, verb: o.verb, via: ctx.via,
    }
    if (op === 'link') p.linkTarget = o.linkTarget ?? null
    emit(ctx.run, p)
    if (seg) {
      const list = ctx.segPaths.get(seg.id) ?? []
      list.push(p)
      ctx.segPaths.set(seg.id, list)
    }
    status = 'ok'
  }
  return status
}

function isMut(op: PathOp): op is MutOp {
  return op === 'write' || op === 'delete' || op === 'move' || op === 'link'
}

/** The resolved path of a word, for link targets and cd; null when it cannot be read. */
function pathOfWord(ctx: Ctx, w: Word): string | null {
  const x = expand(ctx.run, w.value, ctx.base, ctx.tilde)
  if (x.pipe || x.here !== null) return null
  const c = toPath(ctx.run, x.text, true, ctx.base, x.anchor !== null)
  if (c === null || c === 'unreadable' || c.children) return null
  return c.path
}

/** Parsed operands of a command: positional words, named parameters and switches. */
interface Parsed {
  positional: Word[]
  named: Map<string, Word[]>
  flags: string[]        // every flag word, lower-case
  recursive: boolean
}

/** A word that is a PowerShell parameter name, never a parameter's value. */
function looksLikeParam(w: Word | undefined): boolean {
  return w !== undefined && w.tok.pieces[0]?.q === 'n' && /^-[A-Za-z][\w-]*(?::.*)?$/.test(w.text)
}

/** A word standing for a value that cannot be read: a group or a subexpression bound to a parameter. */
function unreadableWord(raw: string): Word {
  return { ...literalWord(UNREAD), raw }
}

function parseArgs(words: Word[], verb: string, valueFlags: Set<string> = new Set(), groups: Seg['groups'] = []): Parsed {
  const positional: Word[] = []
  const named = new Map<string, Word[]>()
  const flags: string[] = []
  const cmdFamily = CMD_FAMILY.has(verb)
  let afterDashDash = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const t = w.text
    const unquoted = w.tok.pieces[0]?.q === 'n'
    if (afterDashDash || !unquoted) { positional.push(w); continue }
    if (t === '--') { afterDashDash = true; flags.push('--'); continue }
    if (cmdFamily && CMD_SWITCH.test(t)) { flags.push(t.toLowerCase()); continue }
    const ps = t.match(/^-([A-Za-z][\w-]*?)(?::(.+))?$/)
    if (ps && t.length > 1) {
      const name = ps[1].toLowerCase()
      flags.push(t.toLowerCase())
      if (ps[2] !== undefined) {
        const list = named.get(name) ?? []
        list.push({ ...w, value: ps[2], text: ps[2], raw: ps[2], quotedFirst: null, tok: { ...w.tok, pieces: [{ t: ps[2], q: 'n' }] } })
        named.set(name, list)
        continue
      }
      if (PS_PATH_PARAMS.has(name) || PS_VALUE_PARAMS.has(name) || valueFlags.has(`-${name}`)) {
        // A group or a subexpression written right after the parameter is its value, and it cannot be
        // read (`-Path (Join-Path 'D:\' 'Video')`); the next word is never taken in its place, and a word
        // that is itself a parameter is never a value (review 2026-11-23).
        const next = words[i + 1]
        const g = groups.find(x => x.opener !== '{' && x.start >= w.tok.end && (next === undefined || x.end <= next.tok.start))
        const list = named.get(name) ?? []
        if (g) list.push(unreadableWord('(...)'))
        else if (next !== undefined && !looksLikeParam(next)) list.push(words[++i])
        if (list.length) named.set(name, list)
      }
      continue
    }
    if (/^--[\w-]+=/.test(t)) {
      const eq = t.indexOf('=')
      const name = t.slice(2, eq).toLowerCase()
      flags.push(t.slice(0, eq).toLowerCase())
      const v = w.value.slice(w.value.indexOf('=') + 1)
      const list = named.get(name) ?? []
      list.push({ ...w, value: v, text: v, raw: v, quotedFirst: null, tok: { ...w.tok, pieces: [{ t: v, q: 'n' }] } })
      named.set(name, list)
      continue
    }
    if (/^--?[\w-]/.test(t)) {
      flags.push(t.toLowerCase())
      if (valueFlags.has(t.toLowerCase()) && i + 1 < words.length) {
        const list = named.get(t.toLowerCase()) ?? []
        list.push(words[++i])
        named.set(t.toLowerCase(), list)
      }
      continue
    }
    positional.push(w)
  }
  const recursive = flags.some(f => RECURSIVE_FLAGS.has(f) || /^-[rRfivd]*[rR][rRfivd]*$/.test(f) && f.length <= 5 || /^-recu/.test(f))
  return { positional, named, flags, recursive }
}

function namedPaths(p: Parsed, ...names: string[]): Word[] {
  const out: Word[] = []
  for (const n of names) out.push(...(p.named.get(n) ?? []))
  return out
}

// ─── Segment classification ────────────────────────────────────────────────────────────────────

function classifySegments(ctx: Ctx): void {
  for (const seg of ctx.segs) {
    try {
      classifySegment(ctx, seg)
    } catch (e) {
      ctx.run.out.faults.push(`a segment could not be read: ${(e as Error)?.message ?? String(e)}`)
    }
  }
}

function inheritedSources(ctx: Ctx, seg: Seg, pipeItem: boolean): ShellPath[] {
  const out: ShellPath[] = []
  for (const other of ctx.segs) {
    if (other.pipeline === seg.pipeline && other.pipeIndex < seg.pipeIndex) out.push(...(ctx.segPaths.get(other.id) ?? []))
    // A group written in an earlier element of this pipeline (`@('D:\x') | Remove-Item`,
    // `(Get-ChildItem D:\x) | Remove-Item`): its paths flow down the pipeline too.
    else if (other.parentPipeline === seg.pipeline && other.parentPipeIndex < seg.pipeIndex) out.push(...(ctx.segPaths.get(other.id) ?? []))
  }
  if ((pipeItem || out.length === 0) && seg.parentPipeline !== null) {
    for (const other of ctx.segs) {
      if (other.pipeline === seg.parentPipeline && other.pipeIndex < seg.parentPipeIndex) out.push(...(ctx.segPaths.get(other.id) ?? []))
    }
  }
  return out
}

function hasEarlier(ctx: Ctx, seg: Seg): boolean {
  return seg.pipeIndex > 0 || (seg.parentPipeline !== null && seg.parentPipeIndex > 0)
}

/**
 * Emits the targets of a mutating verb: its own operands, or, with none (or only `$_`), the paths of the
 * earlier segments of its pipeline (g); an operand that cannot be read is an unresolved mutation (h).
 */
function mutate(ctx: Ctx, seg: Seg, targets: Word[], op: MutOp, verb: string, recursive: boolean, relAllowed = true): void {
  ctx.run.out.sawWrite = true
  let emitted = false
  let unreadable = false
  let pipe = targets.length === 0
  for (const w of targets) {
    const r = emitWord(ctx, seg, w, op, { relAllowed, recursive, verb })
    if (r === 'ok') emitted = true
    else if (r === 'unreadable') unreadable = true
    else if (r === 'pipe') pipe = true
  }
  if (pipe && !emitted) {
    const all = hasEarlier(ctx, seg) ? inheritedSources(ctx, seg, true) : []
    // What a content reader sends down the pipeline is the file's lines, not the file: the targets come
    // from text the scan cannot read (review 2026-11-23).
    const sources = all.filter(s => !CONTENT_VERBS.has(s.verb))
    if (sources.length < all.length) unreadable = true
    for (const s of sources) {
      if (s.path === null) continue
      const p: ShellPath = { ...s, op, recursive, inherited: true, verb, via: ctx.via }
      delete p.linkTarget
      emit(ctx.run, p)
      const list = ctx.segPaths.get(seg.id) ?? []
      list.push(p)
      ctx.segPaths.set(seg.id, list)
    }
    if (sources.length === 0) unreadable = true
  }
  if (unreadable || (seg.subexpr && !emitted)) unresolved(ctx.run, op, verb, recursive, ctx.origText)
}

function classifySegment(ctx: Ctx, seg: Seg): void {
  let words = seg.words.map(t => wordOf(ctx, t))
  // Redirects: a write on every target except the null devices (any verb, after `echo` too).
  for (const r of seg.redirects) {
    if (r.op === '<') { if (r.target) emitWord(ctx, seg, wordOf(ctx, r.target), 'read', { relAllowed: true, verb: '<' }); continue }
    ctx.run.out.sawWrite = true
    if (!r.target) { unresolved(ctx.run, 'write', r.op, false, ctx.origText); continue }
    const tw = wordOf(ctx, r.target)
    if (/^(?:\$null|nul|\/dev\/null|&\d)$/i.test(tw.text)) continue
    const st = emitWord(ctx, seg, tw, 'write', { relAllowed: true, verb: r.op })
    if (st === 'unreadable' || st === 'pipe') unresolved(ctx.run, 'write', r.op, false, ctx.origText)
    if (st === 'none') {
      const x = expand(ctx.run, tw.value, ctx.base, ctx.tilde)
      if (x.here === null && x.doc === null) unresolved(ctx.run, 'write', r.op, false, ctx.origText)
    }
  }
  // Here-documents in this segment: their consumer decides code or data (finding 2.M2).
  const docWords = words.filter(w => expand(ctx.run, w.value, ctx.base, false).doc !== null)
  if (docWords.length) words = words.filter(w => !docWords.includes(w))
  // Assignments.
  if (words.length >= 2 && words[1].text === '=' && words[1].tok.pieces[0]?.q === 'n') return assignment(ctx, seg, words.slice(2))
  if (words.length >= 3 && /^(?:const|let|var|local|readonly|declare|typeset)$/.test(words[0].text) && words[2].text === '=') return assignment(ctx, seg, words.slice(3))
  let i = 0
  while (i < words.length && /^(?:export\s+)?\$?(?:env:)?[A-Za-z_]\w*=/.test(words[i].value) && words[i].tok.pieces[0].q === 'n') {
    const v = words[i].value.slice(words[i].value.indexOf('=') + 1)
    if (v) emitWord(ctx, seg, { ...words[i], value: v, text: v, quotedFirst: null }, 'mention', { relAllowed: false, verb: '=' })
    i++
  }
  if (words[i]?.text === 'export') { for (const w of words.slice(i + 1)) emitMentionAssign(ctx, seg, w); return }
  words = words.slice(i)
  if (words.length === 0) { consumeDocs(ctx, seg, docWords, null); return }
  // A value written where a command would stand (`'D:\x' | Remove-Item`, `'a','b' | ...`,
  // `$env:USERPROFILE | ...`, the inside of `@('D:\x')`): what it names flows down the pipeline, so it is
  // a mention a later verb inherits (review 2026-11-23). The words are still classified below, in case the
  // head is a quoted program.
  if (!seg.call && isValueWord(words[0])) {
    for (const w of words) if (isValueWord(w)) emitWord(ctx, seg, w, 'mention', { relAllowed: true, verb: 'value' })
  }
  // Wrappers.
  for (let guard = 0; guard < 16 && words.length; guard++) {
    const v = verbName(words[0].text)
    if (words[0].text === '.' || words[0].text === '&') { words = words.slice(1); continue }
    if (!WRAPPERS.has(v) && !(v === 'wsl' && !words.slice(1).some(w => /^-(?:l?c)$/i.test(w.text)))) break
    words = unwrapWrapper(v, words.slice(1))
  }
  if (words.length === 0) { consumeDocs(ctx, seg, docWords, null); return }
  const program = words[0]
  const verb = verbName(program.text)
  const operands = words.slice(1)
  consumeDocs(ctx, seg, docWords, verb)
  // `D:` alone switches the current drive, in PowerShell and in cmd (review 2026-11-23).
  if (operands.length === 0 && program.tok.pieces.length === 1 && program.tok.pieces[0].q === 'n' && /^[A-Za-z]:\\?$/.test(program.text)) {
    return driveSwitch(ctx, program.text)
  }
  if (verb === 'for' && isCmdFor(operands)) return cmdFor(ctx, seg, operands)
  // A program-position script is run (exec); a program-position .exe or extensionless word is not a target.
  if (SCRIPT_EXT.test(program.text.replace(/[\\/]+$/, ''))) emitWord(ctx, seg, program, 'exec', { relAllowed: true, verb: 'run' })
  // A here-string piped into this segment.
  heresPipedInto(ctx, seg, verb)
  if (verb === 'git') return classifyGit(ctx, seg, operands, renderOrig(ctx.run, ctx.textSub.slice(seg.start, seg.end)))
  if (INTERPRETERS.has(verb)) return interpreter(ctx, seg, verb, operands)
  if (verb === 'find') return findVerb(ctx, seg, operands)
  if (CD_VERBS.has(verb)) return cdVerb(ctx, seg, verb, operands)
  if (POP_VERBS.has(verb)) {
    const top = ctx.dirStack.pop()
    if (top) { ctx.base = top.base; ctx.baseUnreadable = top.unreadable } else ctx.baseUnreadable = true
    return
  }
  const p = parseArgs(operands, verb, new Set(), seg.groups)
  if (verb === 'foreach-object' || verb === '%' || verb === 'foreach') {
    // `% Delete`, `ForEach-Object -MemberName MoveTo -ArgumentList ...`: a method of each pipeline item.
    const member = (namedPaths(p, 'membername')[0] ?? p.positional[0])
    const mop = member && member.tok.pieces[0]?.q === 'n' ? MEMBER_MUTATIONS[member.text.toLowerCase()] : undefined
    if (mop) {
      mutate(ctx, seg, [], mop, `ForEach-Object ${member.text}`, true)
      if (mop === 'move') mutate(ctx, seg, namedPaths(p, 'argumentlist', 'args').length ? namedPaths(p, 'argumentlist', 'args') : p.positional.slice(1), 'write', `ForEach-Object ${member.text}`, true)
      return
    }
  }
  if (NOTHING_VERBS.has(verb)) { for (const w of [...p.positional, ...namedPaths(p, 'inputobject')]) emitWord(ctx, seg, w, 'mention', { relAllowed: true, verb }); return }
  if (DELETE_VERBS.has(verb)) {
    const recursive = p.recursive || verb === 'rimraf'
    return mutate(ctx, seg, [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'lp', 'pspath')], 'delete', verb, recursive)
  }
  if (MOVE_VERBS.has(verb)) return moveVerb(ctx, seg, verb, p)
  if (COPY_VERBS.has(verb)) return copyVerb(ctx, seg, verb, p)
  if (verb === 'robocopy') return robocopy(ctx, seg, p)
  if (NEW_ITEM.has(verb)) return newItem(ctx, seg, verb, p)
  if (WRITE_TARGET_FIRST.has(verb)) {
    const named = namedPaths(p, 'path', 'literalpath', 'lp', 'pspath', 'filepath')
    const targets = named.length ? named : p.positional.slice(verb === 'truncate' ? -1 : 0, verb === 'truncate' ? undefined : 1)
    const rest = named.length ? p.positional : p.positional.slice(1)
    for (const w of [...rest, ...namedPaths(p, 'value')]) emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb })
    return mutate(ctx, seg, targets, 'write', verb, p.recursive)
  }
  if (WRITE_ALL.has(verb)) {
    let targets = [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'filepath')]
    if ((verb === 'chmod' || verb === 'chown') && targets.length > 1) targets = targets.slice(1)
    if (verb === 'attrib') targets = targets.filter(w => !/^[+-][a-z]$/i.test(w.text))
    if (verb === 'icacls' && targets.length > 1) targets = targets.slice(0, 1)
    if (verb === 'takeown') targets = namedPaths(p, 'f').length ? namedPaths(p, 'f') : targets
    return mutate(ctx, seg, targets, 'write', verb, p.recursive)
  }
  if (ARCHIVE_VERBS.has(verb)) {
    const dest = namedPaths(p, 'destinationpath', 'destination')
    const targets = dest.length ? dest : p.positional.slice(1, 2)
    for (const w of [...namedPaths(p, 'path', 'literalpath'), ...(dest.length ? p.positional : p.positional.slice(0, 1))]) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb })
    return mutate(ctx, seg, targets.length ? targets : [literalWord('.')], 'write', verb, true)
  }
  if (verb === 'tar' || verb === 'unzip' || verb === '7z' || verb === '7za') return archive(ctx, seg, verb, operands)
  if (verb === 'sed' || verb === 'dd' || verb === 'perl') return inPlace(ctx, seg, verb, operands)
  if (verb === 'mklink') return mklink(ctx, seg, p)
  if (verb === 'ln') return lnVerb(ctx, seg, p)
  if (verb === 'fsutil') {
    const pos = p.positional.map(w => w.text.toLowerCase())
    if (pos[0] === 'hardlink' && pos[1] === 'create' && p.positional.length >= 4) return link(ctx, seg, p.positional[2], p.positional[3], 'fsutil hardlink')
    for (const w of p.positional) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
    return
  }
  if (READ_VERBS.has(verb) || LIST_VERBS.has(verb)) {
    const op: PathOp = LIST_VERBS.has(verb) ? 'list' : 'read'
    if (verb === 'certutil' && p.flags.some(f => f === '-decode' || f === '/decode')) markSelfBuilding(ctx.run, 'certutil -decode')
    for (const w of [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'lp', 'pspath', 'filepath')]) emitWord(ctx, seg, w, op, { relAllowed: true, verb })
    return
  }
  // Everything else: operands are unclassified; -OutFile, -Destination and -DestinationPath are writes.
  const writes = namedPaths(p, 'outfile', 'destination', 'dest', 'destinationpath')
  if (writes.length) mutate(ctx, seg, writes, 'write', verb, false)
  for (const w of [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'filepath', 'target')]) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
  for (const [name, list] of p.named) {
    if (PS_PATH_PARAMS.has(name) || PS_VALUE_PARAMS.has(name)) continue
    for (const w of list) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
  }
}

/** A word that is a value rather than a command name: quoted, a variable or home spelling, or a list. */
function isValueWord(w: Word): boolean {
  const first = w.tok.pieces[0]
  if (!first) return false
  if (first.q !== 'n') return true
  if (first.t.startsWith(S0)) return true
  return w.tok.pieces.length > 1 && w.tok.pieces.some(p => p.q === 'n' && p.t.includes(','))
}

/** `D:` alone: the current folder of that drive, which the scan reads as its root (review 2026-11-23). */
function driveSwitch(ctx: Ctx, word: string): void {
  if (ctx.run.platform !== 'win32') return
  const d = word.slice(0, 2).toUpperCase()
  if (sameDrive(ctx.base, d) && word.length === 2) return
  ctx.base = `${d}\\`
  ctx.baseUnreadable = false
}

/** `for /d %d in (...) do ...`, `for %%f in (...) do ...`: cmd's loop, not a POSIX `for x in`. */
function isCmdFor(operands: Word[]): boolean {
  const first = operands[0]
  if (!first) return false
  if (/^\/[dDrRfFlL]$/.test(first.text) && first.tok.pieces[0]?.q === 'n') return true
  return /^%%?[A-Za-z]$/.test(first.raw)
}

/**
 * cmd's `for [/d | /r [dir] | /f [opts] | /l] %v in (LIST) do COMMAND` (review 2026-11-23): every word of
 * LIST (and the `/r` folder) is a mention, so a delete through the loop variable beside a home or D:
 * list is refused under R5.5; COMMAND is classified as a command of its own, in which `%v` cannot be read.
 */
function cmdFor(ctx: Ctx, seg: Seg, operands: Word[]): void {
  const lowerTexts = operands.map(w => (w.tok.pieces[0]?.q === 'n' ? w.text.toLowerCase() : ''))
  const inAt = lowerTexts.indexOf('in')
  const doAt = lowerTexts.indexOf('do')
  const lo = inAt >= 0 ? operands[inAt].tok.end : seg.start
  const hi = doAt >= 0 ? operands[doAt].tok.start : Infinity
  for (const g of seg.groups) {
    if (g.start < lo || g.end > hi) continue
    for (const s of ctx.segs) {
      if (s === seg || s.start < g.start || s.end > g.end) continue
      for (const t of s.words) emitWord(ctx, seg, wordOf(ctx, t), 'mention', { relAllowed: false, verb: 'for' })
    }
  }
  const rAt = lowerTexts.indexOf('/r')
  if (rAt >= 0 && operands[rAt + 1] && !/^%%?[A-Za-z]$/.test(operands[rAt + 1].raw)) {
    emitWord(ctx, seg, operands[rAt + 1], 'mention', { relAllowed: true, verb: 'for /r' })
  }
  if (doAt < 0 || doAt + 1 >= operands.length) return
  const body: Seg = { ...seg, words: operands.slice(doAt + 1).map(w => w.tok), redirects: [], groups: [] }
  classifySegment(ctx, body)
}

function emitMentionAssign(ctx: Ctx, seg: Seg, w: Word): void {
  const eq = w.value.indexOf('=')
  const v = eq >= 0 ? w.value.slice(eq + 1) : w.value
  if (v) emitWord(ctx, seg, { ...w, value: v, text: v, quotedFirst: null }, 'mention', { relAllowed: false, verb: '=' })
}

/** The right-hand side of an assignment: a mention, unless it is a command (PowerShell `$x = Remove-Item ...`). */
function assignment(ctx: Ctx, seg: Seg, rhs: Word[]): void {
  if (rhs.length === 0) return
  const first = rhs[0]
  const looksLikeCommand = first.tok.pieces[0].q === 'n' && !first.value.startsWith(S0) && /^[A-Za-z][\w.-]*$/.test(first.text)
    && (rhs.length > 1 || /^[A-Za-z]+-[A-Za-z]+$/.test(first.text) || DELETE_VERBS.has(first.text.toLowerCase()))
    && !/^(?:r|b|f|u|rb|br)?$/i.test(first.text)
  if (looksLikeCommand && !/\(/.test(first.value)) {
    const sub: Seg = { ...seg, words: rhs.map(w => w.tok), redirects: [] }
    classifySegment(ctx, sub)
    return
  }
  for (const w of rhs) {
    const x = expand(ctx.run, w.value, ctx.base, ctx.tilde)
    if (x.here !== null) continue
    emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb: '=' })
  }
}

function unwrapWrapper(v: string, rest: Word[]): Word[] {
  let i = 0
  const valueFlags: Record<string, Set<string>> = {
    sudo: new Set(['-u', '-g', '-c']),
    env: new Set(['-u', '-c', '--chdir', '--unset']),
    xargs: new Set(['-i', '-I', '-n', '-p', '-P', '-d', '-L', '-a', '-s', '-E']),
    timeout: new Set(['-s', '-k']),
    nice: new Set(['-n']),
    wsl: new Set(['-d', '-u', '--distribution', '--user', '--cd']),
  }
  const vf = valueFlags[v] ?? new Set<string>()
  if (v === 'start-process' || v === 'saps' || v === 'start') {
    const fp = rest.findIndex(w => /^-filepath$/i.test(w.text))
    if (fp >= 0 && fp + 1 < rest.length) {
      const prog = rest[fp + 1]
      const others = rest.filter((_, k) => k !== fp && k !== fp + 1)
      return [prog, ...others]
    }
    while (i < rest.length && (CMD_SWITCH.test(rest[i].text) || (v === 'start' && rest[i].text === '' && rest[i].tok.pieces[0].q !== 'n'))) i++
    return rest.slice(i)
  }
  while (i < rest.length) {
    const t = rest[i].text
    if (v === 'env' && /^[A-Za-z_]\w*=/.test(t)) { i++; continue }
    if (v === 'timeout' && /^\d/.test(t)) { i++; continue }
    if (/^-/.test(t) && t !== '-') {
      if (t === '--') { i++; break }
      if (vf.has(t) || (v === 'xargs' && /^-I/.test(t) && t.length === 2)) { i += 2; continue }
      i++; continue
    }
    break
  }
  return rest.slice(i)
}

function consumeDocs(ctx: Ctx, seg: Seg, docs: Word[], verb: string | null): void {
  for (const w of docs) {
    const x = expand(ctx.run, w.value, ctx.base, false)
    if (x.doc === null) continue
    const consumer = verb !== null && (INTERPRETERS.has(verb) || verb === 'iex' || verb === 'invoke-expression')
    const piped = laterPipeHasInterpreter(ctx, seg)
    useBody(ctx, x.doc, consumer || piped ? 'code' : 'data', 'shell>heredoc')
  }
}

function laterPipeHasInterpreter(ctx: Ctx, seg: Seg): boolean {
  for (const other of ctx.segs) {
    if (other.pipeline !== seg.pipeline || other.pipeIndex <= seg.pipeIndex || other.words.length === 0) continue
    const first = wordOf(ctx, other.words[0])
    const v = verbName(first.text)
    if (INTERPRETERS.has(v) || v === 'iex' || v === 'invoke-expression') return true
  }
  return false
}

/** Here-strings of the earlier segment of a pipeline that this segment consumes. */
function heresPipedInto(ctx: Ctx, seg: Seg, verb: string): void {
  if (seg.pipeIndex === 0) return
  const code = INTERPRETERS.has(verb) || verb === 'iex' || verb === 'invoke-expression'
  for (const other of ctx.segs) {
    if (other.pipeline !== seg.pipeline || other.pipeIndex !== seg.pipeIndex - 1) continue
    for (const t of other.words) {
      const x = expand(ctx.run, t.pieces.map(p => p.t).join(''), ctx.base, false)
      if (x.here !== null) useBody(ctx, x.here, code ? 'code' : 'data', 'shell>heredoc')
    }
  }
}

/** A body's consumer is known: a code body is scanned as shell text and as code, a data body only joins `texts`. */
function useBody(ctx: Ctx, idx: number, use: 'code' | 'data', via: string): void {
  const body = ctx.run.bodies[idx]
  if (!body || body.use !== null) return
  body.use = use
  ctx.run.out.texts.push(body.text)
  if (use === 'code') scanPayload(ctx.run, body.text, ctx.base, via, ctx.depth + 1, 'both')
}

function cdVerb(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  // cmd's `cd /d X:\dir` and `chdir /d`: the switch is not the target (review 2026-11-23).
  if (verb === 'cd' || verb === 'chdir' || verb === 'pushd') operands = operands.filter(w => !(w.tok.pieces[0]?.q === 'n' && /^\/[A-Za-z?]$/.test(w.text)))
  const p = parseArgs(operands, verb)
  const target = namedPaths(p, 'path', 'literalpath')[0] ?? p.positional[0]
  if (verb === 'pushd' || verb === 'push-location') ctx.dirStack.push({ base: ctx.base, unreadable: ctx.baseUnreadable })
  if (!target) { if (verb === 'cd' || verb === 'chdir') { ctx.base = ctx.run.homes.home; ctx.baseUnreadable = false } return }
  if (target.text === '-') { ctx.baseUnreadable = true; return }
  emitWord(ctx, seg, target, 'cd', { relAllowed: true, verb })
  const next = pathOfWord(ctx, target)
  if (next === null) { ctx.baseUnreadable = true; return }
  ctx.base = next
  ctx.baseUnreadable = false
}

function moveVerb(ctx: Ctx, seg: Seg, verb: string, p: Parsed): void {
  const srcNamed = namedPaths(p, 'path', 'literalpath', 'lp')
  const dstNamed = namedPaths(p, 'destination', 'dest', 'newname')
  let sources: Word[]
  let dests: Word[]
  if (dstNamed.length) { sources = [...srcNamed, ...p.positional]; dests = dstNamed }
  else if (srcNamed.length) { sources = srcNamed; dests = p.positional.slice(-1) }
  else if (p.positional.length >= 2) { sources = p.positional.slice(0, -1); dests = p.positional.slice(-1) }
  else { sources = p.positional; dests = [] }
  mutate(ctx, seg, sources, 'move', verb, true)
  if (dests.length) mutate(ctx, seg, dests, 'write', verb, true)
}

function copyVerb(ctx: Ctx, seg: Seg, verb: string, p: Parsed): void {
  const dstNamed = namedPaths(p, 'destination', 'dest')
  const srcNamed = namedPaths(p, 'path', 'literalpath', 'lp')
  let sources: Word[]
  let dests: Word[]
  if (dstNamed.length) { sources = [...srcNamed, ...p.positional]; dests = dstNamed }
  else if (p.positional.length >= 2 || (srcNamed.length && p.positional.length)) {
    const all = [...srcNamed, ...p.positional]
    sources = all.slice(0, -1); dests = all.slice(-1)
  } else { sources = [...srcNamed, ...p.positional]; dests = [literalWord('.')] }
  for (const w of sources) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb })
  mutate(ctx, seg, dests, 'write', verb, p.recursive)
}

function robocopy(ctx: Ctx, seg: Seg, p: Parsed): void {
  const [src, dst] = p.positional
  const mir = p.flags.some(f => f === '/mir' || f === '/purge')
  const mov = p.flags.some(f => f === '/move' || f === '/mov')
  const recursive = p.flags.some(f => f === '/s' || f === '/e' || f === '/mir')
  if (src) { if (mov) mutate(ctx, seg, [src], 'move', 'robocopy', recursive); else emitWord(ctx, seg, src, 'read', { relAllowed: true, verb: 'robocopy' }) }
  mutate(ctx, seg, dst ? [dst] : [], mir ? 'delete' : 'write', 'robocopy', recursive || mir)
}

function newItem(ctx: Ctx, seg: Seg, verb: string, p: Parsed): void {
  const type = (p.named.get('itemtype') ?? p.named.get('type') ?? [])[0]?.text.toLowerCase() ?? ''
  const paths = [...namedPaths(p, 'path', 'literalpath'), ...p.positional]
  const name = p.named.get('name')?.[0]
  if (/^(?:junction|symboliclink|hardlink)$/.test(type)) {
    const target = namedPaths(p, 'target', 'value')[0] ?? null
    const at = paths[0] ?? name ?? null
    if (!at) { unresolved(ctx.run, 'link', verb, false, ctx.origText); return }
    return link(ctx, seg, at, target, `${verb} -ItemType ${type}`)
  }
  for (const w of namedPaths(p, 'value')) emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb })
  const targets = paths.length ? paths : name ? [name] : []
  if (name && paths.length) {
    const dir = pathOfWord(ctx, paths[0])
    if (dir) targets.push(literalWord(ctx.run.platform === 'win32' ? nodePath.win32.join(dir, name.text) : nodePath.posix.join(dir, name.text)))
  }
  mutate(ctx, seg, targets, 'write', verb, false)
}

function link(ctx: Ctx, seg: Seg, at: Word, target: Word | null, verb: string): void {
  ctx.run.out.sawWrite = true
  const t = target ? pathOfWord(ctx, target) : null
  const r = emitWord(ctx, seg, at, 'link', { relAllowed: true, verb, linkTarget: t })
  if (r !== 'ok' || t === null) unresolved(ctx.run, 'link', verb, false, ctx.origText)
}

function mklink(ctx: Ctx, seg: Seg, p: Parsed): void {
  const [at, target] = p.positional
  if (!at) { unresolved(ctx.run, 'link', 'mklink', false, ctx.origText); return }
  link(ctx, seg, at, target ?? null, 'mklink')
}

function lnVerb(ctx: Ctx, seg: Seg, p: Parsed): void {
  const pos = p.positional
  if (pos.length === 0) { unresolved(ctx.run, 'link', 'ln', false, ctx.origText); return }
  if (pos.length === 1) {
    const t = pos[0]
    const name = (pathOfWord(ctx, t) ?? t.text).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
    return link(ctx, seg, literalWord(name || '.'), t, 'ln')
  }
  link(ctx, seg, pos[pos.length - 1], pos[0], 'ln')
}

function findVerb(ctx: Ctx, seg: Seg, operands: Word[]): void {
  const paths: Word[] = []
  let k = 0
  while (k < operands.length && !/^[-(!]/.test(operands[k].text)) paths.push(operands[k++])
  const expr = operands.slice(k).map(w => w.text.toLowerCase())
  let del = expr.includes('-delete')
  for (let j = 0; j < expr.length - 1; j++) {
    if ((expr[j] === '-exec' || expr[j] === '-execdir' || expr[j] === '-ok') && /^(?:rm|rmdir|unlink|shred)$/.test(verbName(expr[j + 1]))) del = true
  }
  // cmd's find.exe is a text search: `find "text" file`; its operands are reads.
  if (del) mutate(ctx, seg, paths.length ? paths : [literalWord('.')], 'delete', 'find', true)
  else for (const w of paths) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb: 'find' })
}

function archive(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  const texts = operands.map(w => w.text)
  if (verb === 'tar') {
    const bundle = texts.filter(t => /^-?[A-Za-z]+$/.test(t) && !t.startsWith('--')).join('')
    const extract = /x/.test(bundle) || texts.includes('--extract') || texts.includes('--get')
    const create = /c/.test(bundle.replace(/^-/, '')) || texts.includes('--create')
    let dir: Word | null = null
    let file: Word | null = null
    for (let j = 0; j < operands.length; j++) {
      const t = texts[j]
      if ((t === '-C' || t === '--directory') && operands[j + 1]) dir = operands[j + 1]
      else if (t.startsWith('--directory=')) dir = literalWord(t.slice(12))
      else if (/^-?[A-Za-z]*f$/.test(t) && !t.startsWith('--') && operands[j + 1]) file = operands[j + 1]
      else if (t.startsWith('--file=')) file = literalWord(t.slice(7))
    }
    if (extract) { if (file) emitWord(ctx, seg, file, 'read', { relAllowed: true, verb }); mutate(ctx, seg, [dir ?? literalWord('.')], 'write', verb, true); return }
    if (create && file) { mutate(ctx, seg, [file], 'write', verb, false); return }
    for (const w of operands) if (!/^-/.test(w.text)) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb })
    return
  }
  if (verb === 'unzip') {
    const d = texts.indexOf('-d')
    const dir = d >= 0 ? operands[d + 1] : null
    for (const [j, w] of operands.entries()) if (!/^-/.test(w.text) && (d < 0 || (j !== d + 1))) { emitWord(ctx, seg, w, 'read', { relAllowed: true, verb }); break }
    mutate(ctx, seg, [dir ?? literalWord('.')], 'write', verb, true)
    return
  }
  // 7z x archive -o<dir>; 7z a archive files
  const sub = texts[0]?.toLowerCase()
  const o = texts.find(t => /^-o./i.test(t))
  if (sub === 'x' || sub === 'e') {
    if (operands[1]) emitWord(ctx, seg, operands[1], 'read', { relAllowed: true, verb })
    mutate(ctx, seg, [o ? literalWord(o.slice(2)) : literalWord('.')], 'write', verb, true)
    return
  }
  if (sub === 'a' || sub === 'u') { if (operands[1]) mutate(ctx, seg, [operands[1]], 'write', verb, false); return }
  for (const w of operands.slice(1)) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
}

function inPlace(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  const texts = operands.map(w => w.text)
  if (verb === 'dd') {
    for (const w of operands) {
      const m = w.text.match(/^(if|of)=(.*)$/)
      if (!m) continue
      const v = { ...w, value: w.value.slice(w.value.indexOf('=') + 1), text: m[2], quotedFirst: null }
      if (m[1] === 'of') mutate(ctx, seg, [v], 'write', 'dd', false)
      else emitWord(ctx, seg, v, 'read', { relAllowed: true, verb: 'dd' })
    }
    return
  }
  if (verb === 'perl') return interpreter(ctx, seg, verb, operands)
  // sed: the script is the first operand unless -e or -f gives it.
  const inplace = texts.some(t => /^-i/.test(t) || t === '--in-place' || /^-[a-z]*i/.test(t) && !t.startsWith('--'))
  const scriptGiven = texts.some(t => t === '-e' || t === '-f' || t.startsWith('--expression') || t.startsWith('--file'))
  const files: Word[] = []
  let sawScript = scriptGiven
  for (let j = 0; j < operands.length; j++) {
    const t = texts[j]
    if (t === '-e' || t === '-f') { j++; continue }
    if (/^-/.test(t)) continue
    if (!sawScript) { sawScript = true; continue }
    files.push(operands[j])
  }
  if (inplace) mutate(ctx, seg, files, 'write', 'sed -i', false)
  else for (const w of files) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb: 'sed' })
}

// ─── (d) Interpreters and payload unwrap ──────────────────────────────────────────────────────

const ENCODED_FLAG = /^-e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i
const PS_FLAGS_WITH_VALUE = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-version', '-v', '-outputformat', '-of',
  '-inputformat', '-if', '-configurationname', '-psconsolefile', '-workingdirectory', '-wd', '-settingsfile'])

/** The text of the words from `from` to the end of the segment, one quote level removed when it is one quoted word. */
function payloadOf(ctx: Ctx, words: Word[], from: number): { text: string | null; viaVariable: boolean } {
  const rest = words.slice(from)
  if (rest.length === 0) return { text: null, viaVariable: false }
  if (rest.length === 1) {
    const w = rest[0]
    const value = w.value
    const only = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
    if (only) {
      const e = ctx.run.table[Number(only[1])]
      if (e?.k === 'here') { const b = ctx.run.bodies[e.body]; if (b) b.use = 'code'; return { text: b?.text ?? null, viaVariable: false } }
      if (e?.k === 'bound') {
        if (e.b.here !== null) { const b = ctx.run.bodies[e.b.here]; if (b) b.use = 'code'; return { text: b?.text ?? null, viaVariable: false } }
        if (e.b.value !== null) return { text: e.b.value, viaVariable: false }
        return { text: null, viaVariable: true }
      }
      if (e?.k === 'u' || e?.k === 'p') return { text: null, viaVariable: true }
    }
    if (w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && w.tok.subs.length === 0 && value.startsWith(S0) && hasUnreadableSentinel(ctx.run, value)) return { text: null, viaVariable: true }
    return { text: value, viaVariable: false }
  }
  const a = rest[0].tok.start
  const b = rest[rest.length - 1].tok.end
  return { text: ctx.textSub.slice(a, b), viaVariable: false }
}

function interpreter(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  const texts = operands.map(w => w.text)
  const lower = texts.map(t => t.toLowerCase())
  const selfBuildingVar = () => markSelfBuilding(ctx.run, 'an inline program passed through a variable that cannot be read')
  const runPayload = (from: number, via: string, mode: 'shell' | 'both', encoded = false) => {
    const pl = payloadOf(ctx, operands, from)
    if (pl.viaVariable) { selfBuildingVar(); return }
    if (pl.text === null) return
    if (encoded) {
      const decoded = decodeEncoded(pl.text)
      if (decoded === null) { markSelfBuilding(ctx.run, 'an -EncodedCommand that does not decode to text'); return }
      ctx.run.out.texts.push(decoded)
      scanPayload(ctx.run, decoded, ctx.base, 'shell>encoded', ctx.depth + 1, 'shell')
      return
    }
    ctx.run.out.texts.push(renderOrig(ctx.run, pl.text))
    scanPayload(ctx.run, pl.text, ctx.base, via, ctx.depth + 1, mode)
  }
  if (verb === 'cmd') {
    let k = 0
    while (k < lower.length && /^\/[a-z]$/.test(lower[k]) && lower[k] !== '/c' && lower[k] !== '/k') k++
    if (k < lower.length && (lower[k] === '/c' || lower[k] === '/k')) return runPayload(k + 1, 'shell>cmd /c', 'shell')
    if (k >= lower.length) fromStdin(ctx, seg, verb, 'shell')
    return otherOperands(ctx, seg, verb, operands, 0)
  }
  if (verb === 'powershell' || verb === 'pwsh') {
    for (let k = 0; k < operands.length; k++) {
      // powershell.exe takes `/c`, `/Command`, `/EncodedCommand` as it takes `-c` (measured, review 2026-11-23).
      const t = /^\/[a-z]+$/.test(lower[k]) && operands[k].tok.pieces[0]?.q === 'n' ? `-${lower[k].slice(1)}` : lower[k]
      if (t === '-') return fromStdin(ctx, seg, verb, 'shell')
      if (t === '-command' || t === '-c' || t === '-com' || t === '-comm' || t === '-comma' || t === '-comman') {
        if (texts[k + 1] === '-' && k + 2 >= operands.length) return fromStdin(ctx, seg, verb, 'shell')
        return runPayload(k + 1, `shell>${verb} -Command`, 'shell')
      }
      if (ENCODED_FLAG.test(t)) return runPayload(k + 1, 'shell>encoded', 'shell', true)
      if (t === '-file' || t === '-f') {
        if (operands[k + 1]) emitWord(ctx, seg, operands[k + 1], 'exec', { relAllowed: true, verb })
        for (const w of operands.slice(k + 2)) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
        return
      }
      if (PS_FLAGS_WITH_VALUE.has(t)) { k++; continue }
      if (t.startsWith('-')) continue
      if (SCRIPT_EXT.test(texts[k])) { emitWord(ctx, seg, operands[k], 'exec', { relAllowed: true, verb }); for (const w of operands.slice(k + 1)) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb }); return }
      return runPayload(k, `shell>${verb}`, 'shell')
    }
    // No command and no file: powershell reads its commands from standard input.
    return fromStdin(ctx, seg, verb, 'shell')
  }
  if (verb === 'bash' || verb === 'sh' || verb === 'zsh' || verb === 'wsl') {
    const k = lower.findIndex(t => /^-[a-z]*c$/.test(t) && !t.startsWith('--'))
    if (k >= 0) return runPayload(k + 1, `shell>${verb} -c`, 'shell')
    if (lower.includes('-s') || !lower.some(t => !t.startsWith('-'))) fromStdin(ctx, seg, verb, 'shell')
    return otherOperands(ctx, seg, verb, operands, 0)
  }
  const codeFlag: Record<string, RegExp> = {
    python: /^-c$/, python3: /^-c$/, py: /^-c$/, pythonw: /^-c$/,
    node: /^(?:-e|--eval|-p|--print)$/, bun: /^(?:-e|--eval|-p|--print)$/,
    ruby: /^-e$/, perl: /^-[a-z]*e$/, php: /^-r$/,
  }
  const re = codeFlag[verb]
  if (re) {
    const k = lower.findIndex(t => re.test(t))
    if (k >= 0) {
      if (verb === 'perl' && lower.some(t => /^-[a-z]*i/.test(t))) {
        const files = operands.slice(k + 2).filter(w => !/^-/.test(w.text))
        mutate(ctx, seg, files, 'write', 'perl -i', false)
      }
      return runPayload(k + 1, `shell>${verb} ${operands[k].text}`, 'both')
    }
  }
  if (verb === 'deno' && lower[0] === 'eval') return runPayload(1, 'shell>deno eval', 'both')
  // `-`, or no script at all, reads the program from standard input: a here-document (the consumer
  // rules) or what the earlier element of the pipeline writes (fromStdin).
  const m = lower.indexOf('-m')
  if (lower.includes('-') || (m < 0 && !operands.some(w => !w.text.startsWith('-')))) fromStdin(ctx, seg, verb, 'both')
  return otherOperands(ctx, seg, verb, operands, 0, m)
}

/**
 * An interpreter that reads its program from standard input inside a pipeline (`echo ... | powershell -`,
 * `'...' | python -`): the text written by an `echo` or a value at the head of the pipeline is scanned as
 * the program; anything else feeding it cannot be read and is self-building (review 2026-11-23). A
 * here-string feeding it was scanned by `heresPipedInto`.
 */
function fromStdin(ctx: Ctx, seg: Seg, verb: string, mode: 'shell' | 'both'): void {
  if (seg.pipeIndex === 0) return
  const prev = ctx.segs.find(o => o.pipeline === seg.pipeline && o.pipeIndex === seg.pipeIndex - 1)
  const unread = `a program fed to ${verb} on standard input that cannot be read`
  if (!prev || prev.words.length === 0) { markSelfBuilding(ctx.run, unread); return }
  const words = prev.words.map(t => wordOf(ctx, t))
  if (words.length === 1 && expand(ctx.run, words[0].value, ctx.base, false).here !== null) return
  let from = -1
  if (NOTHING_VERBS.has(verbName(words[0].text)) && words[0].tok.pieces[0]?.q === 'n') from = 1
  else if (words.every(isValueWord)) from = 0
  if (from < 0) { markSelfBuilding(ctx.run, unread); return }
  const pl = payloadOf(ctx, words, from)
  if (pl.viaVariable) { markSelfBuilding(ctx.run, unread); return }
  if (pl.text === null) return
  ctx.run.out.texts.push(renderOrig(ctx.run, pl.text))
  scanPayload(ctx.run, pl.text, ctx.base, `shell>${verb} stdin`, ctx.depth + 1, mode)
}

/** The interpreter's script operand (exec) and the rest (unclassified); `-m module` names nothing. */
function otherOperands(ctx: Ctx, seg: Seg, verb: string, operands: Word[], from: number, moduleAt = -1): void {
  const valueFlags = new Set(['-w', '-x', '-r', '--require', '-i', '--import', '--loader', '--cwd', '--config', '-o', '--outfile'])
  let scriptSeen = moduleAt >= 0
  for (let k = from; k < operands.length; k++) {
    const w = operands[k]
    const t = w.text
    if (k === moduleAt) { k++; continue }
    if (t.startsWith('-') && w.tok.pieces[0]?.q === 'n') { if (valueFlags.has(t.toLowerCase())) k++; continue }
    if (CMD_SWITCH.test(t) && (verb === 'cmd')) continue
    if (!scriptSeen) {
      scriptSeen = true
      if (SCRIPT_EXT.test(t)) { emitWord(ctx, seg, w, 'exec', { relAllowed: true, verb }); continue }
    }
    emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
  }
}

function decodeEncoded(word: string): string | null {
  const b64 = word.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length < 4) return null
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length < 2) return null
  const text = bytes.toString('utf16le')
  if (text.length === 0) return null
  let printable = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffd && !(c >= 0x7f && c < 0xa0))) printable++
  }
  return printable / [...text].length >= 0.8 ? text : null
}

// ─── The git table (also the whole of scanArgv's table for git) ──────────────────────────────

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'grep',
  'cat-file', 'shortlog', 'reflog', 'remote', 'fetch', 'branch', 'tag', 'merge-base', 'for-each-ref'])
const GIT_WORKTREE = new Set(['add', 'commit', 'mv', 'merge', 'rebase', 'cherry-pick', 'revert', 'switch', 'pull', 'push'])
const GIT_VALUE_FLAGS = new Set(['-m', '--message', '-F', '--file', '-b', '-B', '--author', '--date', '-C', '-n', '--depth', '--branch',
  '-X', '-s', '--strategy', '--strategy-option', '--onto', '--grep', '-e', '-S', '-G', '--since', '--until', '--format', '--pretty',
  '--source', '--template', '--reference', '--origin', '-o', '--output', '--type', '--default', '--max-count', '-U', '--unified', '-t'])
const GIT_MESSAGE_SUBS = new Set(['commit', 'merge', 'tag', 'stash', 'notes', 'revert'])
const GIT_CONFIG_READ = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])

function classifyGit(ctx: Ctx, seg: Seg | null, args: Word[], segText: string): void {
  const out = ctx.run.out
  let i = 0
  const gitVerb = (sub: string) => `git ${sub}`.trim()
  const gwrite = (w: Word, sub: string, rel = true) => {
    out.sawWrite = true
    const r = emitWord(ctx, seg, w, 'write', { relAllowed: rel, verb: gitVerb(sub) })
    if (r === 'unreadable') unresolved(ctx.run, 'write', gitVerb(sub), false, ctx.origText)
  }
  const valueOf = (w: Word, from: number): Word => {
    const v = w.value.slice(w.value.indexOf('=') + 1)
    return { ...w, value: v, text: w.text.slice(from), raw: w.raw.slice(w.raw.indexOf('=') + 1), quotedFirst: null }
  }
  while (i < args.length) {
    const t = args[i].text
    if (t === '-C' && args[i + 1]) {
      gwrite(args[i + 1], '-C')
      const next = pathOfWord(ctx, args[i + 1])
      if (next !== null) ctx.base = next
      i += 2; continue
    }
    if (/^--(?:git-dir|work-tree)=/.test(t)) { gwrite(valueOf(args[i], t.indexOf('=') + 1), t.slice(0, t.indexOf('='))); i++; continue }
    if ((t === '--git-dir' || t === '--work-tree') && args[i + 1]) { gwrite(args[i + 1], t); i += 2; continue }
    if (t === '-c') { i += 2; continue }
    if (t.startsWith('-')) { i++; continue }
    break
  }
  const sub = (args[i]?.text ?? '').toLowerCase()
  const rest = args.slice(i + 1)
  const v = gitVerb(sub)
  const effect = bashEffect(segText)
  if (effect === 'revert' || sub === 'rm' || (sub === 'worktree' && rest[0]?.text.toLowerCase() === 'remove')) out.gitDestructive = true

  // Operands and options, with the values of known value-taking options taken out.
  const operands: Word[] = []
  const afterDash: Word[] = []
  const flags: string[] = []
  let dashed = false
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    const t = w.text
    if (dashed) { afterDash.push(w); continue }
    if (t === '--') { dashed = true; continue }
    if (/^--output=/.test(t)) { gwrite(valueOf(w, 9), sub); continue }
    if ((t === '-o' || t === '--output') && rest[k + 1] && !(sub === 'commit' && t === '-o')) { gwrite(rest[++k], sub); continue }
    if (sub === 'commit' && (t === '-F' || t === '--file') && rest[k + 1]) { emitWord(ctx, seg, rest[++k], 'read', { relAllowed: true, verb: v }); continue }
    if (sub === 'commit' && /^--file=/.test(t)) { emitWord(ctx, seg, valueOf(w, 7), 'read', { relAllowed: true, verb: v }); continue }
    if (sub === 'config' && (t === '-f' || t === '--file') && rest[k + 1]) { gwrite(rest[++k], sub); flags.push('--file'); continue }
    if (sub === 'config' && /^--file=/.test(t)) { gwrite(valueOf(w, 7), sub); flags.push('--file'); continue }
    if (sub === 'config' && (t === '--type' || t === '--default' || t === '--comment') && rest[k + 1]) { flags.push(t); k++; continue }
    if (t.startsWith('-') && t.length > 1 && w.tok.pieces[0]?.q === 'n') {
      flags.push(t)
      // A bundle ending in the message flag (`commit -am "msg"`) takes the message as its value.
      const messageBundle = GIT_MESSAGE_SUBS.has(sub) && /^-[a-zA-Z]+m$/.test(t)
      if ((GIT_VALUE_FLAGS.has(t) || messageBundle) && sub !== 'config' && rest[k + 1]) k++
      continue
    }
    operands.push(w)
  }
  const all = [...operands, ...afterDash]
  const readAbs = (ws: Word[]) => { for (const w of ws) emitWord(ctx, seg, w, 'read', { relAllowed: false, verb: v }) }
  const writeAbs = (ws: Word[]) => { for (const w of ws) gwrite(w, sub, false) }

  if (sub === 'config') {
    if (flags.some(f => GIT_CONFIG_READ.has(f))) return
    out.sawWrite = true
    const key = flags.some(f => f === '--edit' || f === '-e') ? '(edit)' : (operands[0]?.text.toLowerCase() ?? '')
    const system = flags.includes('--system')
    if (out.gitConfigWrite === null && key !== '' && (system || (key !== 'user.name' && key !== 'user.email'))) out.gitConfigWrite = key
    return
  }
  if (sub === 'stash') {
    const s2 = operands[0]?.text.toLowerCase()
    if (s2 === 'list' || s2 === 'show') return
    return
  }
  if (GIT_READ.has(sub)) return readAbs(all)
  if (sub === 'apply' || sub === 'am') { for (const w of all) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb: v }); return }
  if (sub === 'init') { if (operands[0]) gwrite(operands[0], sub); return }
  if (sub === 'clone') { if (operands[0]) readAbs([operands[0]]); if (operands[1]) gwrite(operands[1], sub); return }
  if (sub === 'bundle') { if (operands[0]?.text.toLowerCase() === 'create' && operands[1]) gwrite(operands[1], sub); return }
  if (sub === 'worktree') {
    const action = operands[0]?.text.toLowerCase()
    if (action === 'add' && operands[1]) return gwrite(operands[1], 'worktree add')
    if (action === 'remove' && operands[1]) return mutateGit(ctx, seg, [operands[1]], 'delete', 'git worktree remove', true)
    if (action === 'move' && operands[1]) { mutateGit(ctx, seg, [operands[1]], 'move', 'git worktree move', true); if (operands[2]) gwrite(operands[2], 'worktree move'); return }
    return
  }
  if (sub === 'restore') return mutateGit(ctx, seg, all, 'write', v, false)
  if (sub === 'rm') return mutateGit(ctx, seg, all, 'delete', v, flags.some(f => /^-[a-z]*r/.test(f) && !f.startsWith('--')))
  if (sub === 'clean') {
    const force = flags.some(f => /^-[a-z]*f/.test(f) && !f.startsWith('--')) || flags.includes('--force')
    if (!force) return
    if (all.length) return mutateGit(ctx, seg, all, 'delete', v, true)
    return mutateGit(ctx, seg, [literalWord('.')], 'delete', v, true, true)
  }
  if (sub === 'checkout') {
    if (afterDash.length) mutateGit(ctx, seg, afterDash, 'write', v, false)
    return writeAbs(operands)
  }
  if (GIT_WORKTREE.has(sub)) return writeAbs(all)
  for (const w of all) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb: v })
}

function mutateGit(ctx: Ctx, seg: Seg | null, targets: Word[], op: MutOp, verb: string, recursive: boolean, children = false): void {
  ctx.run.out.sawWrite = true
  for (const w of targets) {
    const r = emitWord(ctx, seg, w, op, { relAllowed: true, verb, recursive, children })
    if (r === 'unreadable' || r === 'pipe') unresolved(ctx.run, op, verb, recursive, ctx.origText)
  }
}

// ─── (i) Code calls ────────────────────────────────────────────────────────────────────────────

const FS_MOD = String.raw`(?:\bfs|\bfsp|\bfsPromises|require\(\s*['"](?:node:)?fs(?:/promises)?['"]\s*\))(?:\.promises)?\.`
const BARE = String.raw`(?<![\w.$])`
const CHILD_PROCESS = String.raw`(?:\bchild_process|require\(\s*['"](?:node:)?child_process['"]\s*\))\.(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(`

type CallKind = 'delete' | 'move' | 'write' | 'copy' | 'link' | 'cd' | 'open' | 'shell'
const CODE_CALLS: Array<{ re: RegExp; kind: CallKind; recursive?: boolean; style: 'args' | 'receiver' | 'receiver-or-args' }> = [
  { re: /\bshutil\.rmtree\s*\(/g, kind: 'delete', recursive: true, style: 'args' },
  // Bare and aliased forms the alias pass did not rewrite, and Perl's File::Path (review 2026-11-23).
  { re: /(?<![\w.$:])(?:[A-Za-z_]\w*\.|File::Path::)?(?:rmtree|remove_tree)\s*\(/g, kind: 'delete', recursive: true, style: 'args' },
  { re: new RegExp(`${BARE}(?:unlink|rmdir)\\s*\\(`, 'g'), kind: 'delete', style: 'args' },
  { re: /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/g, kind: 'delete', style: 'args' },
  { re: /\bsend2trash(?:\.send2trash)?\s*\(/g, kind: 'delete', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:rm|rmSync)\\s*\\(`, 'g'), kind: 'delete', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:rmdir|rmdirSync|unlink|unlinkSync)\\s*\\(`, 'g'), kind: 'delete', style: 'args' },
  { re: new RegExp(`${BARE}(?:rmSync|rmdirSync|unlinkSync)\\s*\\(`, 'g'), kind: 'delete', style: 'args' },
  { re: /\brimraf(?:\.sync|Sync)?\s*\(/g, kind: 'delete', recursive: true, style: 'args' },
  { re: /\bDeno\.remove\s*\(/g, kind: 'delete', style: 'args' },
  { re: /\bFile\.delete\s*\(/g, kind: 'delete', style: 'args' },
  { re: /\bFileUtils\.rm(?:_rf|_r|_f)?\s*\(/g, kind: 'delete', recursive: true, style: 'args' },
  { re: /\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\s*\(/gi, kind: 'delete', style: 'args' },
  { re: /\bshutil\.move\s*\(/g, kind: 'move', style: 'args' },
  { re: /\bos\.(?:rename|replace|renames)\s*\(/g, kind: 'move', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:rename|renameSync)\\s*\\(`, 'g'), kind: 'move', style: 'args' },
  { re: new RegExp(`${BARE}renameSync\\s*\\(`, 'g'), kind: 'move', style: 'args' },
  { re: /\bshutil\.(?:copy|copy2|copyfile|copytree)\s*\(/g, kind: 'copy', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:cp|cpSync|copyFile|copyFileSync)\\s*\\(`, 'g'), kind: 'copy', style: 'args' },
  { re: new RegExp(`${BARE}(?:cpSync|copyFileSync)\\s*\\(`, 'g'), kind: 'copy', style: 'args' },
  { re: /\bos\.(?:makedirs|mkdir|chmod)\s*\(/g, kind: 'write', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream)\\s*\\(`, 'g'), kind: 'write', style: 'args' },
  { re: new RegExp(`${BARE}(?:writeFileSync|appendFileSync|mkdirSync)\\s*\\(`, 'g'), kind: 'write', style: 'args' },
  { re: /\[(?:System\.)?IO\.File\]::(?:WriteAll\w*|AppendAll\w*|Create)\s*\(/gi, kind: 'write', style: 'args' },
  { re: /\[(?:System\.)?IO\.(?:File|Directory)\]::Move\s*\(/gi, kind: 'move', style: 'args' },
  { re: /\[(?:System\.)?IO\.File\]::Copy\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\.MoveTo\s*\(/g, kind: 'move', style: 'receiver-or-args' },
  { re: /\.CopyTo\s*\(/g, kind: 'copy', style: 'receiver-or-args' },
  { re: /\bBun\.write\s*\(/g, kind: 'write', style: 'args' },
  { re: /(?<=\bBun\.file\s*\([^()]*\)\s*)\.(?:delete|unlink)\s*\(/g, kind: 'delete', style: 'receiver' },
  { re: /(?<=\bBun\.file\s*\([^()]*\)\s*)\.write\s*\(/g, kind: 'write', style: 'receiver' },
  { re: /\bDeno\.(?:writeTextFile|writeFile|mkdir)\s*\(/g, kind: 'write', style: 'args' },
  { re: /\bos\.(?:symlink|link)\s*\(/g, kind: 'link', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:symlink|symlinkSync|link|linkSync)\\s*\\(`, 'g'), kind: 'link', style: 'args' },
  { re: /\bCreateJunction\s*\(/g, kind: 'link', style: 'args' },
  { re: /\b(?:os|process)\.chdir\s*\(/g, kind: 'cd', style: 'args' },
  { re: /(?<![\w.$])(?:io\.|codecs\.)?open\s*\(/g, kind: 'open', style: 'args' },
  { re: /\.(?:write_text|write_bytes|mkdir|touch)\s*\(/g, kind: 'write', style: 'receiver' },
  { re: /\.(?:unlink|rmdir|Delete)\s*\(/g, kind: 'delete', style: 'receiver-or-args' },
  { re: /\.rename\s*\(/g, kind: 'move', style: 'receiver-or-args' },
  // Calls that start a shell or a program (review 2026-11-23): a literal command is scanned as shell text,
  // anything else is self-building.
  { re: /\bos\.(?:system|popen)\s*\(/g, kind: 'shell', style: 'args' },
  { re: /\bsubprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\s*\(/g, kind: 'shell', style: 'args' },
  { re: new RegExp(CHILD_PROCESS, 'g'), kind: 'shell', style: 'args' },
  { re: new RegExp(`${BARE}(?:execSync|spawnSync|execFileSync)\\s*\\(`, 'g'), kind: 'shell', style: 'args' },
  { re: /\bBun\.(?:spawn|spawnSync)\s*\(/g, kind: 'shell', style: 'args' },
  { re: new RegExp(`${BARE}(?:system|shell_exec|passthru)\\s*\\(`, 'g'), kind: 'shell', style: 'args' },
]

/** The PowerShell .NET calls that are read on shell text too (the rest of the table is for code payloads). */
const SHELL_CODE_CALLS: typeof CODE_CALLS = [
  { re: /\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\s*\(/gi, kind: 'delete', style: 'args' },
  { re: /\[(?:System\.)?IO\.File\]::(?:WriteAll\w*|AppendAll\w*|Create)\s*\(/gi, kind: 'write', style: 'args' },
  { re: /\[(?:System\.)?IO\.(?:File|Directory)\]::Move\s*\(/gi, kind: 'move', style: 'args' },
  { re: /\[(?:System\.)?IO\.File\]::Copy\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\.Delete\s*\(/g, kind: 'delete', style: 'receiver-or-args' },
  { re: /\.MoveTo\s*\(/g, kind: 'move', style: 'receiver-or-args' },
  { re: /\.CopyTo\s*\(/g, kind: 'copy', style: 'receiver-or-args' },
]

/** Top-level arguments of the call whose `(` is at `open`. */
function callArgs(s: string, open: number): { args: string[]; end: number } {
  const args: string[] = []
  let depth = 0
  let cur = ''
  for (let k = open; k < s.length; k++) {
    const c = s[k]
    if (c === "'" || c === '"' || c === '`') {
      const e = closingQuote(s, k)
      cur += s.slice(k, e + 1); k = e; continue
    }
    if (c === S0) { const e = s.indexOf(S1, k); const end = e < 0 ? s.length : e + 1; cur += s.slice(k, end); k = end - 1; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; if (depth === 1 && k === open) continue; cur += c; continue }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) { if (cur.trim() !== '' || args.length) args.push(cur.trim()); return { args, end: k } }
      cur += c; continue
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim() !== '') args.push(cur.trim())
  return { args, end: s.length }
}

/** The receiver expression in front of the `.` at `dot`. */
function receiverOf(s: string, dot: number): string {
  let k = dot - 1
  while (k >= 0 && /\s/.test(s[k])) k--
  const end = k + 1
  while (k >= 0) {
    const c = s[k]
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '['
      let depth = 0
      for (; k >= 0; k--) {
        if (s[k] === c) depth++
        else if (s[k] === open) { depth--; if (depth === 0) break }
      }
      k--; continue
    }
    if (c === "'" || c === '"') {
      const j = s.lastIndexOf(c, k - 1)
      k = j < 0 ? -1 : j - 1
      while (k >= 0 && /[rRbBuUfF]/.test(s[k])) k--
      continue
    }
    if (c === S1) { const j = s.lastIndexOf(S0, k); k = j - 1; continue }
    if (/[\w.$]/.test(c)) { k--; continue }
    break
  }
  return s.slice(k + 1, end).trim()
}

function stripParens(e: string): string {
  let s = e.trim()
  for (let guard = 0; guard < 8 && s.startsWith('(') && s.endsWith(')') && matchParen(s, 0) === s.length - 1; guard++) s = s.slice(1, -1).trim()
  return s
}

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" || c === '"' || c === '`') { const e = closingQuote(s, k); cur += s.slice(k, e + 1); k = e; continue }
    if (c === S0) { const e = s.indexOf(S1, k); const end = e < 0 ? s.length : e + 1; cur += s.slice(k, end); k = end - 1; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    if (depth === 0 && c === sep) { parts.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  parts.push(cur.trim())
  return parts
}

const STRING_LIT = /^([rRbBuU]{0,2})(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)$/s

function stringValue(e: string): string | null {
  const m = e.match(STRING_LIT)
  if (!m) return null
  const raw = /r/i.test(m[1])
  const body = m[2] ?? m[3] ?? m[4] ?? ''
  if (raw || m[4] !== undefined) return body
  return body.replace(/\\(\\|'|")/g, '$1')
}

type CodeBindings = Map<string, { value: string | null; count: number }>

/** A code expression's value when it is the whole of one literal form (finding 2.M1 part 3), else null. */
function evalExpr(run: Run, e0: string, codeBindings: CodeBindings): string | null {
  const e = stripParens(e0)
  if (e === '') return null
  const parts = splitTop(e, '/').map(p => stripParens(p))
  if (parts.length > 1 && !stringValue(e)) {
    const head = evalAtom(run, parts[0], codeBindings)
    if (head === null) return null
    const tails: string[] = []
    for (const p of parts.slice(1)) { const v = stringValue(p); if (v === null) return null; tails.push(v) }
    return [head.replace(/[\\/]+$/, ''), ...tails].join('/')
  }
  return evalAtom(run, e, codeBindings)
}

function evalAtom(run: Run, a: string, codeBindings: CodeBindings): string | null {
  const s = stringValue(a)
  if (s !== null) return s
  if (new RegExp(`^${S0}\\d+${S1}$`).test(a)) return hasUnreadableSentinel(run, a) ? null : a
  const path = a.match(/^(?:pathlib\.)?(?:Pure)?(?:Windows|Posix)?Path\(\s*(.*?)\s*\)$/s) ?? a.match(/^Bun\.file\(\s*(.*?)\s*\)$/s)
  if (path) {
    if (path[1] === '') return '.'
    const inner = splitTop(path[1], ',')
    if (inner.length !== 1) return null
    return evalAtom(run, stripParens(inner[0]), codeBindings)
  }
  if (/^[A-Za-z_]\w*$/.test(a)) {
    const b = codeBindings.get(a)
    if (b && b.count === 1) return b.value
  }
  return null
}

const CODE_ASSIGN = /(^|[\s;{(\n])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*([-+*/|]?)=(?!=)/g

function findCodeAssignments(run: Run, code: string): CodeBindings {
  const out: CodeBindings = new Map()
  for (const m of code.matchAll(CODE_ASSIGN)) {
    const name = m[2]
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(code, start, false)
    const prev = out.get(name)
    const value = m[3] ? null : evalExpr(run, code.slice(start, end).trim(), out)
    out.set(name, { value: prev ? null : value, count: (prev?.count ?? 0) + 1 })
  }
  return out
}

function scanCodeCalls(ctx: Ctx, code: string, table: typeof CODE_CALLS, codeBindings: CodeBindings): void {
  const run = ctx.run
  const covered = new Set<number>()
  for (const call of table) {
    call.re.lastIndex = 0
    for (const m of code.matchAll(call.re)) {
      const open = (m.index ?? 0) + m[0].length - 1
      if (covered.has(open)) continue
      covered.add(open)
      try {
        codeCall(ctx, code, call, m.index ?? 0, open, codeBindings)
      } catch (e) {
        run.out.faults.push(`a code call could not be read: ${(e as Error)?.message ?? String(e)}`)
      }
    }
  }
}

function codeCall(ctx: Ctx, code: string, call: (typeof CODE_CALLS)[number], at: number, open: number, cb: CodeBindings): void {
  const run = ctx.run
  const { args } = callArgs(code, open)
  const positional = args.filter(a => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a) && !/^\{/.test(a))
  const verb = code.slice(at, open).replace(/^\./, '').trim()
  const recursive = call.recursive === true || args.some(a => /\brecursive\s*[:=]\s*(?:true|True)/.test(a))
  const target = (expr: string | undefined, op: PathOp): 'ok' | 'unreadable' => {
    if (expr === undefined) return 'unreadable'
    const v = evalExpr(run, expr, cb)
    if (v === null) return 'unreadable'
    const r = emitWord(ctx, null, { ...literalWord(v), raw: renderOrig(run, expr) }, op, { relAllowed: true, verb, recursive })
    return r === 'ok' ? 'ok' : 'unreadable'
  }
  const mut = (expr: string | undefined, op: MutOp) => {
    run.out.sawWrite = true
    if (target(expr, op) !== 'ok') unresolved(run, op, verb, recursive, code)
  }
  const useReceiver = call.style === 'receiver' || (call.style === 'receiver-or-args'
    && (positional.length === 0 || ((call.kind === 'move' || call.kind === 'copy') && positional.length === 1)))
  const recv = useReceiver ? receiverOf(code, at) : undefined
  switch (call.kind) {
    case 'delete': return mut(useReceiver ? recv : positional[0], 'delete')
    case 'write': return mut(useReceiver ? recv : positional[0], 'write')
    case 'move':
      if (useReceiver) { mut(recv, 'move'); return mut(positional[0], 'write') }
      mut(positional[0], 'move'); return mut(positional[1], 'write')
    case 'copy':
      if (useReceiver) { if (recv !== undefined) target(recv, 'read'); return mut(positional[0], 'write') }
      if (positional[0] !== undefined) target(positional[0], 'read')
      return mut(positional[1], 'write')
    case 'shell': return shellCall(ctx, args, positional, verb, cb)
    case 'link': {
      run.out.sawWrite = true
      // os.symlink / os.link / fs.symlink / fs.link take (target, link); CreateJunction takes (link, target).
      const [tExpr, lExpr] = /CreateJunction$/.test(verb) ? [positional[1], positional[0]] : [positional[0], positional[1]]
      const tv = tExpr !== undefined ? evalExpr(run, tExpr, cb) : null
      const tp = tv !== null ? toPath(run, expand(run, tv, ctx.base, true).text, true, ctx.base, false) : null
      const linkTarget = tp && tp !== 'unreadable' ? tp.path : null
      const lv = lExpr !== undefined ? evalExpr(run, lExpr, cb) : null
      if (lv === null) { unresolved(run, 'link', verb, false, code); return }
      emitWord(ctx, null, { ...literalWord(lv), raw: renderOrig(run, lExpr ?? '') }, 'link', { relAllowed: true, verb, linkTarget })
      if (linkTarget === null) unresolved(run, 'link', verb, false, code)
      return
    }
    case 'cd': {
      const v = positional[0] !== undefined ? evalExpr(run, positional[0], cb) : null
      if (v === null) { ctx.baseUnreadable = true; return }
      const c = toPath(run, expand(run, v, ctx.base, true).text, true, ctx.base, false)
      if (c && c !== 'unreadable') { ctx.base = c.path; ctx.baseUnreadable = false } else ctx.baseUnreadable = true
      return
    }
    case 'open': {
      const modeArg = positional[1] ?? args.find(a => /^mode\s*=/.test(a))?.replace(/^mode\s*=\s*/, '')
      const mode = modeArg !== undefined ? stringValue(stripParens(modeArg)) : null
      if (mode !== null && /[wax+]/.test(mode)) return mut(positional[0], 'write')
      if (positional[0] !== undefined) target(positional[0], 'read')
      return
    }
  }
}

/** The elements of an array literal (`['a', 'b', x]`), each a literal or null; null when it is not one. */
function arrayElements(run: Run, e: string, cb: CodeBindings): Array<string | null> | null {
  const s = stripParens(e)
  if (!s.startsWith('[') || !s.endsWith(']')) return null
  const inner = s.slice(1, -1).trim()
  if (inner === '') return []
  return splitTop(inner, ',').filter(x => x !== '').map(x => evalExpr(run, x, cb))
}

/** An argv as one shell text: an element that cannot be read is a word the scan cannot read. */
function argvText(elems: Array<string | null>): string {
  return elems.map(x => x === null ? UNREAD : /[\s"]/.test(x) ? `"${x.replace(/"/g, '')}"` : x).join(' ')
}

/**
 * A code call that starts a shell or a program (`os.system`, `subprocess.run`, `child_process.execSync`,
 * `Bun.spawnSync`, Perl's `system`): a literal command or argv is scanned as shell text, a program and an
 * argv list are joined, and a command the scan cannot read is self-building (review 2026-11-23).
 */
function shellCall(ctx: Ctx, args: string[], positional: string[], verb: string, cb: CodeBindings): void {
  const run = ctx.run
  let text: string | null = null
  const first = positional[0] ?? args.find(a => /^\{/.test(a))
  if (first !== undefined) {
    const obj = first.match(/^\{[\s\S]*?\bcmd\s*:\s*(\[[\s\S]*?\])/)
    const list = arrayElements(run, obj ? obj[1] : first, cb)
    if (list !== null) text = argvText(list)
    else {
      const v = evalExpr(run, first, cb)
      if (v !== null) {
        const rest = positional[1] !== undefined ? arrayElements(run, positional[1], cb) : null
        text = rest ? argvText([v, ...rest]) : v
      }
    }
  }
  if (text === null) { markSelfBuilding(run, `${verb} with a command that cannot be read`); return }
  run.out.texts.push(renderOrig(run, text))
  scanPayload(run, text, ctx.base, `${ctx.via}>${verb}`, ctx.depth + 1, 'shell')
}

/** Absolute and anchored paths in string literals, and every anchor, of a code payload: mentions. */
function codeMentions(ctx: Ctx, code: string): void {
  const run = ctx.run
  const lit = /([rRbBuU]{0,2})('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g
  for (const m of code.matchAll(lit)) {
    const v = stringValue(m[0])
    if (v === null || v === '') continue
    emitWord(ctx, null, { ...literalWord(v), raw: renderOrig(run, m[0]) }, 'mention', { relAllowed: false, verb: 'literal' })
  }
  for (let k = 0; k < code.length; k++) {
    if (code[k] !== S0) continue
    const { e, end } = entryAt(run, code, k)
    if (e?.k === 'anchor') emitWord(ctx, null, { ...literalWord(code.slice(k, end)), raw: e.orig }, 'mention', { relAllowed: false, verb: 'anchor' })
    k = end - 1
  }
}

// ─── Driving the scan ──────────────────────────────────────────────────────────────────────────

function newCtx(run: Run, textSub: string, origText: string, base: string, via: string, depth: number, tilde: boolean): Ctx {
  return { run, textSub, base, baseUnreadable: false, dirStack: [], via, depth, tilde, segPaths: new Map(), segs: [], origText }
}

/** Scans one text: as shell text, as code, or both (an inline program, findings unioned). */
function scanPayload(run: Run, text: string, base: string, via: string, depth: number, mode: 'shell' | 'code' | 'both'): void {
  if (depth > MAX_DEPTH) { run.out.faults.push(`a payload nested deeper than ${MAX_DEPTH}`); return }
  if (mode === 'shell' || mode === 'both') scanShell(run, text, base, via, depth)
  if (mode === 'code' || mode === 'both') scanCode(run, text, base, via, depth)
}

function scanShell(run: Run, text: string, base: string, via: string, depth: number): void {
  try {
    const lifted = liftBodies(run, text)
    const plain = renderOrig(run, lifted, true)
    markSelfBuilding(run, findMarker(plain))
    const bindings = findShellAssignments(run, lifted)
    const sub = substitute(run, lifted, bindings)
    const toks = tokenize(sub)
    const ctx = newCtx(run, sub, plain, base, via, depth, true)
    ctx.segs = segment(toks)
    classifySegments(ctx)
    // `$(...)` inside double quotes: scanned as a nested command.
    for (const t of toks) if (t.kind === 'w') for (const s of t.subs) scanPayload(run, s, ctx.base, via, depth + 1, 'shell')
    scanCodeCalls(ctx, sub, SHELL_CODE_CALLS, new Map())
  } catch (e) {
    run.out.faults.push(`the shell text could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

const JS_MODULES: Record<string, string> = { fs: 'fs', 'fs/promises': 'fs.promises', child_process: 'child_process' }

/**
 * The code with its import aliases spelled out, so one call table reads them all (review 2026-11-23):
 * `import shutil as sh` makes `sh.` read `shutil.`; `from shutil import rmtree` makes `rmtree(` read
 * `shutil.rmtree(`; a module bound to a name by `require(...)` or `import * as f from ...`, and the
 * names destructured from one, the same way. (This module starts no process: these are table data.)
 */
function aliasCode(code: string): string {
  const rewrites: Array<[RegExp, string]> = []
  const bare = (local: string, full: string) => rewrites.push([new RegExp(`(?<![\\w.$])${local.replace(/\$/g, '\\$')}(?=\\s*\\()`, 'g'), full])
  const dotted = (local: string, mod: string) => { if (local !== mod) rewrites.push([new RegExp(`(?<![\\w.$])${local.replace(/\$/g, '\\$')}\\.`, 'g'), `${mod}.`]) }
  for (const m of code.matchAll(/\bimport\s+(os|shutil|subprocess)\s+as\s+([A-Za-z_]\w*)/g)) dotted(m[2], m[1])
  for (const m of code.matchAll(/\bfrom\s+(os|shutil|subprocess)\s+import\s+\(?([\w\s,]+?)\)?\s*(?=$|[;\n])/gm)) {
    for (const part of m[2].split(',')) {
      const pm = part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/)
      if (pm) bare(pm[2] ?? pm[1], `${m[1]}.${pm[1]}`)
    }
  }
  const req = String.raw`require\(\s*['"](?:node:)?(fs\/promises|fs|child_process)['"]\s*\)`
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${req}`, 'g'))) dotted(m[1], JS_MODULES[m[2]])
  for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"](?:node:)?(fs\/promises|fs|child_process)['"]/g)) dotted(m[1], JS_MODULES[m[2]])
  const destructured = [
    ...code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${req}`, 'g')),
    ...code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s+['"](?:node:)?(fs\/promises|fs|child_process)['"]/g),
  ]
  for (const m of destructured) {
    for (const part of m[1].split(',')) {
      const pm = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*(?::|\s+as\s+)\s*([A-Za-z_$][\w$]*))?$/)
      if (pm) bare(pm[2] ?? pm[1], `${JS_MODULES[m[2]]}.${pm[1]}`)
    }
  }
  let out = code
  for (const [re, to] of rewrites) out = out.replace(re, to)
  return out
}

function scanCode(run: Run, text: string, base: string, via: string, depth: number): void {
  try {
    markSelfBuilding(run, findMarker(renderOrig(run, text)))
    const sub = substitute(run, text, findShellAssignments(run, text))
    const ctx = newCtx(run, sub, renderOrig(run, text), base, via, depth, true)
    const code = aliasCode(sub)
    const cb = findCodeAssignments(run, code)
    scanCodeCalls(ctx, code, CODE_CALLS, cb)
    codeMentions(ctx, sub)
  } catch (e) {
    run.out.faults.push(`the inline program could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

function finish(run: Run): ShellScan {
  for (const b of run.bodies) {
    if (b.use !== null) continue
    b.use = 'data'
    run.out.texts.push(b.text)
  }
  return run.out
}

function platformOf(opts?: ScanOpts): Platform {
  return opts?.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
}

/** Names the paths in shell text and in inline-interpreter text. Pure; never throws. */
export function scanShellText(text: string, base: string, homes: HomeMap, opts?: ScanOpts): ShellScan {
  const run: Run = { homes, platform: platformOf(opts), table: [], bodies: [], out: emptyScan() }
  const input = typeof text === 'string' ? text : String(text ?? '')
  run.out.texts.push(input)
  try {
    if (input.length > MAX_TEXT) { run.out.faults.push('a command longer than 1 MiB'); return run.out }
    scanPayload(run, input, base, 'shell', 0, 'shell')
    return finish(run)
  } catch (e) {
    run.out.faults.push(`the command could not be read: ${(e as Error)?.message ?? String(e)}`)
    return run.out
  }
}

/**
 * Names the paths of an argv that reaches its program with no shell between (the Git tool): the verb
 * table and the path-candidate rules on the words exactly as given; no lexing, no comments, no
 * expansion of `$NAME`, `%NAME%` or `~`.
 */
export function scanArgv(words: string[], base: string, homes: HomeMap, opts?: ScanOpts): ShellScan {
  const run: Run = { homes, platform: platformOf(opts), table: [], bodies: [], out: emptyScan() }
  try {
    const list = (Array.isArray(words) ? words : []).map(w => String(w ?? ''))
    if (list.length === 0) return run.out
    if (list.join(' ').length > MAX_TEXT) { run.out.faults.push('a command longer than 1 MiB'); return run.out }
    // The segment text bashEffect reads: each word holding whitespace or a quote is wrapped in double
    // quotes, so a commit message cannot read as a subcommand.
    const segText = list.map(w => /[\s'"]/.test(w) ? `"${w.replace(/"/g, '')}"` : w).join(' ')
    if (verbName(list[0]) === 'git') {
      const ctx = newCtx(run, segText, segText, base, 'argv', 0, false)
      classifyGit(ctx, null, list.slice(1).map(literalWord), segText)
      return run.out
    }
    // Any other program: the verb table on the literal words (no lexing, no expansion).
    const joined = list.join(' ')
    const toks: WordTok[] = []
    let at = 0
    for (const w of list) {
      toks.push({ kind: 'w', pieces: [{ t: w, q: 'n' }], start: at, end: at + w.length, subs: [] })
      at += w.length + 1
    }
    const ctx = newCtx(run, joined, joined, base, 'argv', 0, false)
    const seg: Seg = { id: 0, words: toks, redirects: [], pipeline: 0, pipeIndex: 0, parentPipeline: null, parentPipeIndex: 0, subexpr: false, start: 0, end: joined.length, groups: [] }
    ctx.segs = [seg]
    classifySegment(ctx, seg)
    return run.out
  } catch (e) {
    run.out.faults.push(`the argv could not be read: ${(e as Error)?.message ?? String(e)}`)
    return run.out
  }
}
