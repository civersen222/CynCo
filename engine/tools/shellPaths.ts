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
 * `faults`. The one thing read from outside is the clock: a scan runs on the engine's event loop and
 * stops at `SCAN_BUDGET_MS` with a fault, as it stops at `MAX_SCANNED_TEXT` (review 2026-11-23).
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
  /** The word started with this name, which nothing in the command set: it is empty when the command runs. */
  unsetName?: string
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
/** The longest text read as a command or a program, once here-string and here-document bodies are lifted out. */
export const MAX_SCANNED_TEXT = 128 * 1024
/** The longest one scan may run on the event loop (the dashboard, the phone and Stop are answered from it: F225). */
export const SCAN_BUDGET_MS = 500
const MAX_DEPTH = 4
const MAX_PATHS = 512

/** Sentinels in a substituted text: S0 <index> S1 names an entry of the scan's table. */
const S0 = '\u0002'
const S1 = '\u0003'
/** In an expanded word: a piece that cannot be read before the command runs. */
const UNREAD = '\u0004'
/** In an expanded word: the pipeline's current item (`$_`, `$PSItem`, `{}`). */
const PIPE = '\u0005'
/** In a token: a subexpression that is empty when the command runs (`"$()"`, `"$($null)"`, `"$(echo)"`). */
const EMPTY_SUB = '\u0006'

const WILDCARD = /[*?[]/

// ─── The scan's shared state ───────────────────────────────────────────────────────────────────

/** unset: the right-hand side was only a name nothing set, so the name is empty too. */
/** cmdSet: made by cmd's `set X=...`, which a `%X%` on the same line does not see (cmd expands the line first). */
type Binding = { pos: number; value: string | null; here: number | null; unset?: true; list?: string[]; cmdSet?: true }
type Entry =
  | { k: 'anchor'; anchor: Exclude<Anchor, null>; tail: string; orig: string }
  | { k: 'text'; text: string; orig: string }
  | { k: 'bound'; b: Binding; orig: string }
  | { k: 'u'; orig: string; unset?: true }   // unset: a name nothing assigned and no table knows (empty when the command runs)
  | { k: 'p'; orig: string }
  | { k: 'here'; body: number; orig: string }
  | { k: 'doc'; body: number; orig: string }

type Body = { text: string; use: 'code' | 'data' | null; q?: string }

interface Run {
  homes: HomeMap
  platform: Platform
  table: Entry[]
  bodies: Body[]
  out: ShellScan
  seen: Set<string>
  deadline: number
  /** Literals are read as PowerShell writes them (a backslash is an ordinary character), not as code. */
  psStrings: boolean
  /** The shell texts whose literals are swept once the whole command is read (`sweepLiterals`). */
  sweeps: Array<{ ctx: Ctx; toks: Tok[] }>
}

function newRun(homes: HomeMap, platform: Platform): Run {
  return { homes, platform, table: [], bodies: [], out: emptyScan(), seen: new Set(), deadline: performance.now() + SCAN_BUDGET_MS, psStrings: false, sweeps: [] }
}

/** True once the scan has run past its budget; the first time, the fault that refuses the call. */
function overBudget(run: Run): boolean {
  if (performance.now() <= run.deadline) return false
  const f = `the command took longer than ${SCAN_BUDGET_MS} ms to read`
  if (!run.out.faults.includes(f)) run.out.faults.push(f)
  return true
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
  // The same path named the same way twice (two readings of one text) is one entry.
  const key = `${p.op}\u0000${p.path}\u0000${p.raw}\u0000${p.via}\u0000${p.verb}\u0000${p.recursive}\u0000${p.inherited}\u0000${p.linkTarget ?? ''}`
  if (run.seen.has(key)) return
  run.seen.add(key)
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
  n += (text.match(/\.parent\b/gi) ?? []).length
  // cmd's `%~dpX` is the folder an item is in.
  n += (text.match(/%%?~[a-z]*p[a-z]*(?:\$\w+:)?[A-Za-z](?![\w%])/gi) ?? []).length
  n += (text.match(/\bdirname\b/g) ?? []).length
  // `Split-Path` answers the parent unless it is asked for the leaf, the extension or a yes/no; the
  // members `Parent` and `Root` named as a property (`-ExpandProperty Parent`, `% Root`, `.Root`) climb too
  // (review 2026-11-23, third).
  n += [...text.matchAll(/\bSplit-Path\b([^;|\n]*)/gi)].filter(m => !/-(?:Leaf|LeafBase|Extension|IsAbsolute|NoQualifier)\b/i.test(m[1])).length
  n += (text.match(/(?:-ExpandProperty|-Expand|-Exp|ForEach-Object|%|-MemberName)\s+['"]?(?:Parent|Root|PSDrive)\b/gi) ?? []).length
  n += (text.match(/\.(?:root|psdrive)\b/gi) ?? []).length
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
// `(?!\w)` first: a name may not stop short of its end to dodge the assignment test (`$env:GIT` of
// `$env:GITX=`, review 2026-11-23).
const NOT_ASSIGN = String.raw`(?!\w)(?!\s*[-+*/]?=(?!=))`
/** A PowerShell variable's scope prefix (`$script:X`, `${global:X}`). */
const PS_SCOPE = String.raw`(?:script|global|local|private|using):`

/**
 * Every spelling the substitution pass replaces, in the order they are tried. Each alternative has
 * its own named groups; the callback below reads which one matched.
 */
const SUBST_PARTS: Array<[string[], string]> = [
  [['homedrive'], String.raw`(?<hd>(?:\$env:HOMEDRIVE|\$\{env:HOMEDRIVE\}|%HOMEDRIVE%)(?:\$env:HOMEPATH|\$\{env:HOMEPATH\}|%HOMEPATH%))`],
  [['getfolderpath'], String.raw`(?<gfp>(?:\[(?:System\.)?Environment\]::)?GetFolderPath\s*\((?<gfpArg>[^()]*(?:\([^()]*\)[^()]*)*)\))`],
  [['getenvironmentvariable'], String.raw`(?<gev>(?:\[(?:System\.)?Environment\]::)?GetEnvironmentVariable\s*\(\s*['"](?<gevN>\w+)['"][^()]*\))`],
  [['gettemppath'], String.raw`(?<tmpp>(?:\[(?:System\.)?IO\.Path\]::)?GetTempPath\s*\(\s*\))`],
  [['resolve-path'], String.raw`(?<rp>\(\s*Resolve-Path\s+~\s*\)(?:\.Path)?)`],
  [['get-location'], String.raw`(?<gl>\(\s*Get-Location\s*\)(?:\.Path)?)`],
  [['pwd'], String.raw`(?<pwds>\$\(\s*pwd\s*\))`],
  [['environ'], String.raw`(?<envi>(?:\bos\.)?\benviron(?:\[\s*(?<eq1>['"])(?<en1>\w+)\k<eq1>\s*\]${NOT_ASSIGN}|\.get\(\s*(?<eq2>['"])(?<en2>\w+)\k<eq2>\s*(?:,[^()]*)?\)))`],
  [['process.env'], String.raw`(?<penv>\bprocess\.env(?:\.(?<pe1>\w+)|\[\s*['"](?<pe2>\w+)['"]\s*\])${NOT_ASSIGN})`],
  [['bun.env'], String.raw`(?<benv>\bBun\.env\.(?<be>\w+))`],
  [['getenv'], String.raw`(?<genv>(?:\bos\.)?\bgetenv\(\s*['"](?<ge>\w+)['"]\s*(?:,[^()]*)?\))`],
  [['$env{'], String.raw`(?<plenv>\$ENV\{(?<pl>\w+)\})`],
  [['env['], String.raw`(?<rbenv>\bENV\[\s*['"](?<rb>\w+)['"]\s*\])`],
  [['${env:'], String.raw`(?<denv>\$\{env:(?<de>\w+)\}${NOT_ASSIGN})`],
  [['$env:'], String.raw`(?<psenv>\$env:(?<pse>\w+)${NOT_ASSIGN})`],
  [['env:'], String.raw`(?<psdrv>(?<![\w$:])Env:\\?(?<pd>\w+))`],
  // A POSIX default (`${X:-}`, `${X:=dir}`): the name when it is set, the default when it is not.
  [['${'], String.raw`(?<pdef>\$\{(?<pdn>[A-Za-z_]\w*):?[-=](?<pdd>[^}]*)\})`],
  [['${'], String.raw`(?<brace>\$\{(?:${PS_SCOPE})?(?<br>\w+)\}${NOT_ASSIGN})`],
  [['$'], String.raw`(?<item>\$(?:_|PSItem)(?!\w))`],
  [['$'], String.raw`(?<keep>\$(?:null|true|false)(?!\w))`],
  // `$env:X=` (an assignment, which psenv leaves alone) is not the variable `$env`.
  [['$'], String.raw`(?<dvar>\$(?!env:)(?:${PS_SCOPE})?(?<dv>[A-Za-z_]\w*)${NOT_ASSIGN})`],
  [['$'], String.raw`(?<dpos>\$(?:\d|[@*#?$!]))`],
  [['%'], String.raw`(?<pct>%(?<pc>[A-Za-z_]\w*)%)`],
  // cmd's substring and substitution of a variable (`%X:~0,3%`, `%X:a=b%`) compute the text they name.
  [['%'], String.raw`(?<pcsub>%[A-Za-z_]\w*:(?:~[^%\n]*|[^%=\n]*=[^%\n]*)%)`],
  // A cmd `for` variable (`%d`, `%%d` in a batch, with its modifiers `%~fd`, `%~dpnxf`): a value the scan cannot read.
  [['%'], String.raw`(?<forv>%%?(?:~[fdpnxsatz]*(?:\$\w+:)?)?[A-Za-z](?![\w%]))`],
  [['!'], String.raw`(?<bang>!(?<bg>[A-Za-z_]\w*)!)`],
  [['path.home'], String.raw`(?<phome>(?:\bpathlib\.)?\bPath\.home\(\s*\))`],
  [['path.cwd'], String.raw`(?<pcwd>(?:\bpathlib\.)?\bPath\.cwd\(\s*\))`],
  [['expanduser'], String.raw`(?<expu>(?:\bos\.path\.)?\bexpanduser\(\s*(?:(?<exq>['"])(?<ext>[^'"]*)\k<exq>|(?<exa>[^()'"\s][^()'"]*))\s*\))`],
  [['userinfo'], String.raw`(?<uinfo>${OS_MOD}\buserInfo\(\s*\)\.homedir)`],
  [['homedir'], String.raw`(?<hdir>${OS_MOD}\bhomedir\(\s*\))`],
  [['getpwuid'], String.raw`(?<pwuid>(?:\bpwd\.)?\bgetpwuid\([^()]*(?:\([^()]*\))?[^()]*\)(?:\.pw_dir|\[\s*5\s*\])?)`],
  [['dir.home'], String.raw`(?<dhome>\bDir\.home\b)`],
  [['tmpdir'], String.raw`(?<otmp>${OS_MOD}\btmpdir\(\s*\))`],
  [['gettempdir'], String.raw`(?<gtmp>(?:\btempfile\.)?\bgettempdir\(\s*\))`],
  [['temp('], String.raw`(?<mktmp>(?:\btempfile\.)?\bmk[sd]temp\([^()]*\))`],
  [['getcwd', 'process.cwd'], String.raw`(?<gcwd>\bos\.getcwd\(\s*\)|\bprocess\.cwd\(\s*\))`],
  [['getuser', 'getlogin'], String.raw`(?<guser>\bgetpass\.getuser\(\s*\)|\bos\.getlogin\(\s*\))`],
]

const substCache = new Map<string, RegExp>()

/**
 * The substitution pattern for one text: only the spellings whose fixed part the text contains, so a long
 * text with none of them is not tried at every position against all of them (review 2026-11-23, cost).
 */
function substRe(text: string): RegExp | null {
  const lower = text.toLowerCase()
  const parts: string[] = []
  let key = ''
  for (const [k, [triggers, source]] of SUBST_PARTS.entries()) {
    if (!triggers.some(t => lower.includes(t))) continue
    parts.push(source)
    key += `${k},`
  }
  if (parts.length === 0) return null
  let re = substCache.get(key)
  if (!re) {
    if (substCache.size >= 256) substCache.clear()
    re = new RegExp(parts.join('|'), 'gi')
    substCache.set(key, re)
  }
  return re
}

type Bindings = Map<string, Binding[]>

/**
 * The binding of `keys` that holds at `pos`, counting only assignments made before `limit`: undefined
 * when none was assigned before it, null when it is assigned more than once (unreadable). Each list is in
 * position order and only grows at its end, so this is constant time (a copy per assignment was quadratic).
 */
function bindingAt(bindings: Bindings, keys: string[], pos: number, limit = Infinity): Binding | null | undefined {
  for (const key of keys) {
    const list = bindings.get(key)
    if (!list) continue
    let n = list.length
    while (n > 0 && list[n - 1].pos >= limit) n--
    if (n === 0 || list[0].pos > pos) continue
    if (n > 1) return null
    return list[0]
  }
  return undefined
}

/** PowerShell's automatic variables that an assignment does not change: `$HOME` is the real home whatever `$env:HOME` says. */
const PS_FIXED = new Set(['HOME', 'PWD', 'PSHOME', 'PID'])

function anchorEntry(run: Run, anchor: Exclude<Anchor, null>, orig: string, tail = ''): string {
  return sentinel(run, { k: 'anchor', anchor, tail, orig })
}

/** One env-style name read at `pos`: the propagation table first, then the anchor table. */
function envName(run: Run, bindings: Bindings, name: string, pos: number, orig: string, keyOrder: 'env' | 'var', unknown: 'u' | 'keep', limit = Infinity): string {
  const lower = name.toLowerCase()
  const upper = name.toUpperCase()
  // `$name` is a shell variable, never the environment variable of that name (review 2026-11-23, R4).
  const keys = keyOrder === 'env' ? [`env:${lower}`, lower] : PS_FIXED.has(upper) ? [] : [lower]
  const b = bindingAt(bindings, keys, pos, limit)
  if (b === null) return sentinel(run, { k: 'u', orig })
  if (b !== undefined) return sentinel(run, { k: 'bound', b, orig })
  const anchor = ANCHOR_NAMES[upper]
  if (anchor) return anchorEntry(run, anchor, orig)
  if (USER_NAMES.has(upper)) return sentinel(run, { k: 'text', text: run.homes.user, orig })
  return unknown === 'u' ? sentinel(run, { k: 'u', orig, unset: true }) : orig
}

function substitute(run: Run, text: string, bindings: Bindings, offset = 0, limit = Infinity): string {
  const re = substRe(text)
  if (re === null) return text
  let n = 0
  let over = false
  return text.replace(re, (m: string, ...rest: unknown[]) => {
    // Past the budget the rest is left as written: the fault already refuses the call.
    if ((++n & 255) === 0 && !over) over = overBudget(run)
    if (over) return m
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
    if (g('gev') !== undefined) return envName(run, bindings, g('gevN') ?? '', pos, m, 'env', 'u', limit)
    if (g('tmpp') !== undefined || g('otmp') !== undefined || g('gtmp') !== undefined || g('mktmp') !== undefined) return anchorEntry(run, 'temp', m)
    if (g('rp') !== undefined || g('phome') !== undefined || g('uinfo') !== undefined || g('hdir') !== undefined
      || g('pwuid') !== undefined || g('dhome') !== undefined) return anchorEntry(run, 'home', m)
    if (g('gl') !== undefined || g('pwds') !== undefined || g('pcwd') !== undefined || g('gcwd') !== undefined) return anchorEntry(run, 'cwd', m)
    if (g('envi') !== undefined) return envName(run, bindings, g('en1') ?? g('en2') ?? '', pos, m, 'env', 'u', limit)
    if (g('penv') !== undefined) return envName(run, bindings, g('pe1') ?? g('pe2') ?? '', pos, m, 'env', 'u', limit)
    if (g('benv') !== undefined) return envName(run, bindings, g('be') ?? '', pos, m, 'env', 'u', limit)
    if (g('genv') !== undefined) return envName(run, bindings, g('ge') ?? '', pos, m, 'env', 'u', limit)
    if (g('plenv') !== undefined) return envName(run, bindings, g('pl') ?? '', pos, m, 'env', 'u', limit)
    if (g('rbenv') !== undefined) return envName(run, bindings, g('rb') ?? '', pos, m, 'env', 'u', limit)
    if (g('denv') !== undefined) return envName(run, bindings, g('de') ?? '', pos, m, 'env', 'u', limit)
    if (g('psenv') !== undefined) return envName(run, bindings, g('pse') ?? '', pos, m, 'env', 'u', limit)
    if (g('psdrv') !== undefined) return envName(run, bindings, g('pd') ?? '', pos, m, 'env', 'u', limit)
    if (g('pdef') !== undefined) {
      const name = g('pdn') ?? ''
      const dflt = g('pdd') ?? ''
      if (dflt === '' || bindingAt(bindings, [name.toLowerCase()], pos, limit) !== undefined || ANCHOR_NAMES[name.toUpperCase()]) {
        return envName(run, bindings, name, pos, m, 'var', 'u', limit)
      }
      return /[$`%]/.test(dflt) ? sentinel(run, { k: 'u', orig: m }) : sentinel(run, { k: 'text', text: dflt, orig: m })
    }
    if (g('brace') !== undefined) return envName(run, bindings, g('br') ?? '', pos, m, 'var', 'u', limit)
    if (g('item') !== undefined) return sentinel(run, { k: 'p', orig: m })
    if (g('keep') !== undefined) return m
    if (g('dvar') !== undefined) return envName(run, bindings, g('dv') ?? '', pos, m, 'var', 'u', limit)
    if (g('dpos') !== undefined) return sentinel(run, { k: 'u', orig: m })
    if (g('pct') !== undefined) {
      // cmd expands `%X%` when it reads the line, before any `set X=` on that line has run (review
      // 2026-11-23, third): cmd's own assignment on the same line does not reach it. A PowerShell
      // assignment before `cmd /c` has run when cmd starts, so it does.
      const at = rest[rest.length - 3] as number
      const lineStart = offset + text.lastIndexOf('\n', at) + 1
      const name = g('pc') ?? ''
      const b = bindingAt(bindings, [`env:${name.toLowerCase()}`, name.toLowerCase()], pos, limit)
      const sameLineSet = b !== null && b !== undefined && b.cmdSet === true && b.pos >= lineStart
      return envName(run, bindings, name, pos, m, 'env', 'u', sameLineSet ? Math.min(limit, lineStart) : limit)
    }
    if (g('pcsub') !== undefined) { markSelfBuilding(run, `cmd's ${m}, which computes the text it names`); return sentinel(run, { k: 'u', orig: m }) }
    if (g('forv') !== undefined) return sentinel(run, { k: 'u', orig: m })
    if (g('bang') !== undefined) return envName(run, bindings, g('bg') ?? '', pos, m, 'env', 'u', limit)
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
function statementEnd(s: string, i: number, stopAtSpace: boolean, backslash = true): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === "'" || c === '"' || c === '`') {
      const k = closingQuote(s, j, backslash)
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

function closingQuote(s: string, j: number, backslash = true): number {
  const q = s[j]
  for (let k = j + 1; k < s.length; k++) {
    if (q !== "'" && ((backslash && s[k] === '\\') || s[k] === '`')) { k++; continue }
    if (s[k] === q) {
      if (q === "'" && s[k + 1] === "'") { k++; continue }
      return k
    }
  }
  return s.length
}

// `$X =`, `$env:X =`, `${X} =`, `${env:X} =`, `[string]$X =`, `$script:X =` (review 2026-11-23).
const PS_ASSIGN = /(^|[\s;{(|&=])(?:\[[^\]\n]+\]\s*)*\$(?:\{(env:|(?:script|global|local|private|using):)?([A-Za-z_]\w*)\}|(env:|(?:script|global|local|private|using):)?([A-Za-z_]\w*))\s*([-+*/]?)=(?!=)/g
const POSIX_ASSIGN = /(^|[\s;&|(\n])(export\s+)?([A-Za-z_]\w*)=/g
/** cmd's quoted `set "X=value"`. */
const CMD_SET_QUOTED = /(^|[\s;&|(\n])set\s+"([A-Za-z_]\w*)=([^"\n]*)"/gi
/** `Set-Variable -Name X -Value V`, `New-Variable X V`, `sv X V`: the value as written. */
const PS_SET_VARIABLE = /(^|[\s;&|(\n{])(?:Set-Variable|New-Variable|sv|nv)\b([^;|\n}]*)/gi
const CODE_ENV_ASSIGN = /(?:\bos\.environ\[\s*['"](\w+)['"]\s*\]|\bprocess\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\]))\s*=(?!=)/g
const PS_PARAM = /\bparam\s*\(([^)]*)\)/gi
const LOOP_VARS = [
  /\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b/gi,
  /(?:^|[\s;&|(\n])for\s+([A-Za-z_]\w*)\s+in\b/g,
  /-(?:PipelineVariable|pv|OutVariable|ov)\s+([A-Za-z_]\w*)/gi,
  PS_PARAM,
]

/** Reads every shell assignment of a text once (finding 2.M1 part 1). */
function findShellAssignments(run: Run, text: string, psText = false): Bindings {
  const found: Array<{ key: string; pos: number; rhs: string; rhsAt: number; dialect: 'ps' | 'posix' | 'code'; cmdSet?: true }> = []
  let depth: ((pos: number) => number) | null = null
  for (const m of text.matchAll(PS_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, false, !psText)
    const env = (m[2] ?? m[4]) === 'env:'
    const key = `${env ? 'env:' : ''}${(m[3] ?? m[5]).toLowerCase()}`
    // A home or temp name assigned inside a block, a condition or a group (`if ($false) { $env:USERPROFILE
    // = ... }`, `$false -and ($env:USERPROFILE = ...)`) may never run: the name stays the real folder
    // (review 2026-11-23, third). Nothing else is judged by where it is assigned.
    if (ANCHOR_NAMES[(m[3] ?? m[5]).toUpperCase()]) {
      depth ??= depthIndex(text, psText)
      if (depth((m.index ?? 0) + m[1].length) > 0) continue
    }
    // A chained assignment (`$X = $Y = 'v'`) binds both names to the last value.
    let rhs = m[6] ? '\u0000' : text.slice(start, end)
    let rhsAt = start
    for (let guard = 0; guard < 8; guard++) {
      const chain = rhs.match(/^\s*\$(?:\{[^}]*\}|[\w:]+)\s*=(?!=)/)
      if (!chain) break
      rhs = rhs.slice(chain[0].length); rhsAt += chain[0].length
    }
    found.push({ key, pos: (m.index ?? 0) + m[1].length, rhs, rhsAt, dialect: 'ps' })
  }
  for (const m of text.matchAll(CMD_SET_QUOTED)) {
    const at = (m.index ?? 0) + m[0].indexOf('"')
    found.push({ key: m[2].toLowerCase(), pos: (m.index ?? 0) + m[1].length, rhs: `"${m[3]}"`, rhsAt: at, dialect: 'ps', cmdSet: true })
  }
  for (const m of text.matchAll(PS_SET_VARIABLE)) {
    const args = tokenize(m[2]).filter((t): t is WordTok => t.kind === 'w').map(t => ({ t, text: t.pieces.map(p => p.t).join('') }))
    let name: string | null = null
    let value: WordTok | null = null
    const pos: WordTok[] = []
    for (let k = 0; k < args.length; k++) {
      const lower = args[k].text.toLowerCase()
      if (/^-n(?:a(?:me?)?)?$/.test(lower) && args[k + 1]) { name = args[++k].text; continue }
      if (/^-v(?:a(?:l(?:ue?)?)?)?$/.test(lower) && args[k + 1]) { value = args[++k].t; continue }
      if (lower.startsWith('-')) continue
      pos.push(args[k].t)
    }
    if (name === null && pos[0]) name = pos.shift()!.pieces.map(p => p.t).join('')
    if (value === null && pos[0]) value = pos[0]
    if (name === null || !/^[A-Za-z_]\w*$/.test(name)) continue
    const at = (m.index ?? 0) + m[1].length
    const rhsAt = value ? (m.index ?? 0) + m[0].length - m[2].length + value.start : 0
    found.push({ key: name.toLowerCase(), pos: at, rhs: value ? m[2].slice(value.start, value.end) : '\u0000', rhsAt, dialect: 'ps' })
  }
  for (const m of text.matchAll(POSIX_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, true)
    const key = m[3].toLowerCase()
    const at = (m.index ?? 0) + m[1].length
    const cmdSet = /(?:^|[\s;&|("'])set\s+$/i.test(text.slice(Math.max(0, at - 16), at)) ? { cmdSet: true as const } : {}
    found.push({ key, pos: at, rhs: text.slice(start, end), rhsAt: start, dialect: 'posix', ...cmdSet })
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
  for (const [fi, f] of found.entries()) {
    if ((fi & 63) === 63 && overBudget(run)) break
    const b: Binding = { pos: f.pos, value: null, here: null, ...(f.cmdSet ? { cmdSet: true as const } : {}) }
    const list = bindings.get(f.key) ?? []
    list.push(b)
    bindings.set(f.key, list)
    if (f.rhs === '\u0000') continue
    const lead = f.rhs.length - f.rhs.trimStart().length
    // Only the assignments made before this one count for its right-hand side.
    const rhsSub = substitute(run, f.rhs.trim(), bindings, f.rhsAt + lead, f.pos)
    const v = f.dialect === 'code' ? evalExpr(run, rhsSub, new Map()) : shellRhsValue(run, rhsSub, f.dialect)
    if (v && typeof v === 'object') {
      if ('here' in v) { b.here = v.here; b.value = null } else { b.unset = true; b.value = null }
    } else b.value = v
    // A PowerShell list (`$a = 'x','D:\DCIM'`): every element, so `$a[1]` or `$a` is judged on each of them,
    // never on the first one alone (review 2026-11-23, third).
    if (f.dialect === 'ps') {
      const list = listElements(rhsSub)
      if (list !== null) b.list = list
    }
  }
  return bindings
}

/** The bracket depth (`(`, `{`, `[`) at each position of a text, quotes and sentinels skipped; built once, read in constant time. */
function depthIndex(text: string, psText: boolean): (pos: number) => number {
  const at = new Uint16Array(text.length + 1)
  let d = 0
  for (let j = 0; j < text.length; j++) {
    at[j] = d
    const c = text[j]
    if (c === "'" || c === '"') {
      const k = Math.min(closingQuote(text, j, !psText), text.length - 1)
      for (let x = j + 1; x <= k; x++) at[x] = d
      j = k
      continue
    }
    if (c === '(' || c === '{' || c === '[') d = Math.min(d + 1, 65535)
    else if ((c === ')' || c === '}' || c === ']') && d > 0) d--
  }
  at[text.length] = d
  return (pos: number) => at[Math.max(0, Math.min(pos, text.length))]
}

/** The value a shell right-hand side binds, or null when it is unreadable; `unset` when it is only a name nothing set. */
function shellRhsValue(run: Run, rhs: string, dialect: 'ps' | 'posix'): string | null | { here: number } | { unset: true } {
  if (rhs === '') return dialect === 'posix' ? '' : null
  // `$null` and `[string]::Empty` are empty strings in a path (review 2026-11-23).
  if (/^(?:\$null|\[(?:System\.)?String\]::Empty)$/i.test(rhs)) return ''
  const toks = tokenize(rhs, dialect === 'posix')
  if (toks.length !== 1 || toks[0].kind !== 'w') return null
  const w = toks[0]
  const value = w.pieces.map(p => p.t).join('')
  if (w.subs.length) return null
  const only = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  if (only) {
    const e = run.table[Number(only[1])]
    if (e?.k === 'here') return { here: e.body }
    if ((e?.k === 'u' && e.unset) || (e?.k === 'bound' && e.b.unset)) return { unset: true }
  }
  // An unquoted PowerShell right-hand side that is not a variable is a command, not a value.
  if (dialect === 'ps' && w.pieces[0].q === 'n' && !w.pieces[0].t.startsWith(S0)) return null
  if (hasUnreadableSentinel(run, value)) return null
  return value
}

/** The elements of a right-hand side that is one comma list word (`'a','b'`, `a,b`), or null. */
function listElements(rhs: string): string[] | null {
  const toks = tokenize(rhs, false)
  if (toks.length !== 1 || toks[0].kind !== 'w') return null
  const pieces = toks[0].pieces
  if (!pieces.some(p => p.q === 'n' && p.t.includes(','))) return null
  const groups: Piece[][] = [[]]
  for (const p of pieces) {
    if (p.q !== 'n') { groups[groups.length - 1].push(p); continue }
    p.t.split(',').forEach((t, k) => { if (k > 0) groups.push([]); if (t !== '') groups[groups.length - 1].push({ t, q: 'n' }) })
  }
  const out = groups.filter(g => g.length).map(g => g.map(p => p.t).join(''))
  return out.length >= 2 ? out.slice(0, MAX_PATHS) : null
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

/**
 * The words and operators of a text. `posixQuotes`: a backslash escapes `"`, `$` and a backtick inside
 * double quotes, as a POSIX shell reads it; PowerShell and cmd read the backslash as an ordinary
 * character, so `"D:\"` is closed at its second quote there (review 2026-11-23).
 */
function tokenize(s: string, posixQuotes = true, run?: Run): Tok[] {
  const toks: Tok[] = []
  let tick = 0
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
    // A long text is read against the budget: past it the rest is not tokenized (the fault refuses the call).
    if (run !== undefined && (++tick & 4095) === 0 && overBudget(run)) break
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
        if (posixQuotes && d === '\\' && (s[j + 1] === '"' || s[j + 1] === '$' || s[j + 1] === '`')) { t += s[j + 1]; j += 2; continue }
        if (d === '$' && s[j + 1] === '(') {
          const k = matchParen(s, j + 1)
          const inner = s.slice(j + 2, k)
          subs.push(inner)
          // `"$($x)"` is `"$x"`: a subexpression that is one name reads as the name. One that is empty
          // when it runs (`$()`, `$($null)`, `$('')`, `$(echo)`) is an empty name (review 2026-11-23, third).
          t += new RegExp(`^\\s*${S0}\\d+${S1}\\s*$`).test(inner) ? inner.trim()
            : /^\s*(?:\$null|''|""|echo|Write-Output)?\s*$/i.test(inner) ? EMPTY_SUB : UNREAD
          j = k + 1; continue
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

/** A here-string's opener: `@'` or `@"`, then the end of its line. */
const HERE_STRING_OPEN = /@(['"])[ \t]*\r?\n/g
const HERE_DOC = /(^|[\s(;|&])<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\3(?=[\s;|&)]|$)/g
/** At most this many here-documents are lifted out of one text. */
const MAX_HERE_DOCS = 64

/**
 * Lifts every here-string and here-document body out of a text; the text keeps a sentinel word in its
 * place. Linear in the text (review 2026-11-23, third: a lazy pattern per opener and a terminator search
 * per opener were quadratic, and an engine reading a 1 MiB command was blocked for minutes): a
 * here-string opener is paired with the next closer of its quote, and once one has none no later opener
 * of that quote is tried; a here-document's terminator is looked up in an index of the text's lines.
 */
function liftBodies(run: Run, text: string): string {
  let out = ''
  let last = 0
  const noClose = new Set<string>()
  HERE_STRING_OPEN.lastIndex = 0
  for (let m = HERE_STRING_OPEN.exec(text); m !== null; m = HERE_STRING_OPEN.exec(text)) {
    const q = m[1]
    if (noClose.has(q)) { if (noClose.size === 2) break; continue }
    const bodyStart = m.index + m[0].length
    const close = text.indexOf(`\n${q}@`, bodyStart)
    if (close < 0) { noClose.add(q); continue }
    const end = close + 3
    const body = text.slice(bodyStart, close).replace(/\r$/, '')
    run.bodies.push({ text: body, use: null, q })
    out += `${text.slice(last, m.index)} ${sentinel(run, { k: 'here', body: run.bodies.length - 1, orig: text.slice(m.index, end) })} `
    last = end
    HERE_STRING_OPEN.lastIndex = end
  }
  out += text.slice(last)
  return liftHereDocs(run, out)
}

function liftHereDocs(run: Run, out: string): string {
  if (!out.includes('<<')) return out
  const starts: number[] = [0]
  for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n', i + 1)) starts.push(i + 1)
  const lineText = (n: number) => out.slice(starts[n], n + 1 < starts.length ? starts[n + 1] - 1 : out.length).replace(/\r$/, '')
  const lineOf = (pos: number) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1 } return lo }
  // The lines that could end a here-document (an identifier, optionally after tabs), by their text.
  const buildIndex = () => {
    const exact = new Map<string, number[]>()
    const stripped = new Map<string, number[]>()
    for (let n = 0; n < starts.length; n++) {
      const t = lineText(n)
      if (t.length > 256 || !/^\t*[A-Za-z_]\w*$/.test(t)) continue
      const add = (mp: Map<string, number[]>, k: string) => { const l = mp.get(k); if (l) l.push(n); else mp.set(k, [n]) }
      if (!t.startsWith('\t')) add(exact, t)
      add(stripped, t.replace(/^\t+/, ''))
    }
    return { exact, stripped }
  }
  let lines: { exact: Map<string, number[]>; stripped: Map<string, number[]> } | null = null
  const firstAtOrAfter = (list: number[] | undefined, from: number): number => {
    if (!list) return -1
    let lo = 0; let hi = list.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid }
    return lo < list.length ? list[lo] : -1
  }
  const edits: Array<{ from: number; to: number; put: string }> = []
  const nextBodyLine = new Map<number, number>()
  let skipFrom = -1
  let skipTo = -1
  let lifted = 0
  HERE_DOC.lastIndex = 0
  for (const m of out.matchAll(HERE_DOC)) {
    if (lifted >= MAX_HERE_DOCS) break
    const at = m.index ?? 0
    if (at >= skipFrom && at < skipTo) continue
    const lineEnd = out.indexOf('\n', at + m[0].length)
    if (lineEnd < 0) break
    lines ??= buildIndex()
    const opener = lineOf(at)
    const first = nextBodyLine.get(opener) ?? opener + 1
    const term = firstAtOrAfter((m[2] === '-' ? lines.stripped : lines.exact).get(m[4]), first)
    if (term < 0) continue
    const bodyStart = starts[first]
    const bodyEnd = starts[term]
    const after = term + 1 < starts.length ? starts[term + 1] - 1 : out.length
    run.bodies.push({ text: out.slice(bodyStart, Math.max(bodyStart, bodyEnd - 1)), use: null })
    const marker = sentinel(run, { k: 'doc', body: run.bodies.length - 1, orig: m[0].slice(m[1].length) })
    edits.push({ from: at + m[1].length, to: at + m[0].length, put: ` ${marker} ` })
    edits.push({ from: bodyStart - 1, to: after, put: '' })
    nextBodyLine.set(opener, term + 1)
    if (skipTo === bodyStart - 1) skipTo = after
    else { skipFrom = bodyStart - 1; skipTo = after }
    lifted++
  }
  if (edits.length === 0) return out
  edits.sort((a, b) => a.from - b.from)
  let res = ''
  let pos = 0
  for (const e of edits) {
    if (e.from < pos) continue
    res += out.slice(pos, e.from) + e.put
    pos = e.to
  }
  return res + out.slice(pos)
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
  // Review 2026-11-23 (second): a script block run with its own parameters (`& { param($p) ... } D:\x`),
  // a runspace handed a script, and C# compiled from the command.
  [/(?:^|[;|{(\n]|&&|\|\|)\s*[&.]\s*\{\s*param\s*\(/i, 'a script block handed its arguments'],
  [/\.Add(?:Script|Command)\s*\(|\[(?:System\.Management\.Automation\.)?PowerShell\]::Create\s*\(/i, 'a script run through the engine API'],
  [/\bAdd-Type\b[^\n]*-(?:TypeDefinition|MemberDefinition)\b/i, 'Add-Type, which compiles code the command carries'],
]

/** Markers that only an inline program carries. */
function codeMarker(code: string): string | null {
  if (/\bos\.(?:exec|spawn)[lv]p?e?\s*\(|\bos\.posix_spawnp?\s*\(/.test(code)) return 'a program started through os.exec* or os.spawn*'
  if (/\bctypes\b/.test(code)) return 'ctypes, which calls the system directly'
  if (/(?<![\w.$])(?:eval|exec|Function)\s*\(\s*(?!['"`])[^)\s]/.test(code)) return 'eval or exec of text built at run time'
  return null
}

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

type Expanded = { text: string; anchor: Anchor; pipe: boolean; here: number | null; doc: number | null; leadUnset: boolean; leadName: string }

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
  let leadName = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === EMPTY_SUB) { if (text === '') { leadUnset = true; leadName = 'the empty subexpression $()' } text += UNREAD; continue }
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
        if (e.b.unset) { if (text === '') { leadUnset = true; leadName = e.orig } text += UNREAD; break }
        if (e.b.value === null || depth > 8) { text += UNREAD; break }
        const inner = expand(run, e.b.value, base, true, depth + 1)
        if (text === '' && anchor === null) anchor = inner.anchor
        if (text === '' && inner.leadUnset) { leadUnset = true; leadName = e.orig }
        text += inner.text
        break
      }
      case 'u': if (text === '' && e.unset) { leadUnset = true; leadName = e.orig } text += UNREAD; break
      case 'p': pipe = true; text += PIPE; break
      case 'here': if (text === '') here = e.body; break
      case 'doc': if (text === '') doc = e.body; break
    }
  }
  if (tilde && /^~(?:[\\/]|$)/.test(text)) { text = run.homes.home + text.slice(1); anchor = 'home' }
  if (text.includes(PIPE)) pipe = true
  return { text, anchor, pipe, here, doc, leadUnset, leadName }
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
      // `D:*` is everything in D:'s current folder: the drive word is kept (review 2026-11-23).
      if (/^[A-Za-z]:$/.test(prefix)) s = prefix
      else if (!relAllowed) return null
      else s = '.'
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
  /** The inside of a method call's parentheses (`$o.DeleteFolder('D:\x')`): arguments a method the scan cannot read is handed. */
  methodArgs?: boolean
  /**
   * A group followed at once by a member or an index (`(Get-Item .).Parent`): its value is not the items
   * its own command named, so they never flow down the pipeline around it (review 2026-11-23, third).
   */
  transformed?: boolean
}

function segment(toks: Tok[], text: string): Seg[] {
  const segs: Seg[] = []
  let nextId = 0
  let nextPipe = 0
  const mk = (pipeline: number, pipeIndex: number, parentPipeline: number | null, parentPipeIndex: number): Seg =>
    ({ id: nextId++, words: [], redirects: [], pipeline, pipeIndex, parentPipeline, parentPipeIndex, subexpr: false, start: Infinity, end: 0, groups: [] })
  let cur = mk(nextPipe++, 0, null, 0)
  const stack: Array<{ seg: Seg; opener: string; hadWords: boolean; at: number }> = []
  let pending: string | null = null
  // A set, not a search of the list: a text of many statements has as many segments (review 2026-11-23, third, cost).
  const added = new Set<Seg>()
  const close = (s: Seg) => { if ((s.words.length || s.redirects.length) && !added.has(s)) { added.add(s); segs.push(s) } }
  const touch = (s: Seg, a: number, b: number) => { s.start = Math.min(s.start, a); s.end = Math.max(s.end, b) }
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti]
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
        // `.Name(` or `::Name(` right before the parenthesis: the arguments of a method call.
        if (t.op === '(' && /(?:\.|::)[A-Za-z_]\w*$/.test(text.slice(Math.max(0, t.start - 128), t.start))) cur.methodArgs = true
        break
      }
      case ')': case '}': {
        const top = stack.pop()
        const group = top ? { start: top.at, end: t.end, opener: top.opener } : null
        const next = toks[ti + 1]
        // A group followed at once by a member or an index (`(Get-ChildItem $HOME).FullName`,
        // `(gci D:\)[0].FullName`) is one operand whose value cannot be read (review 2026-11-23).
        // At the head of a pipeline (`(Get-Item .).Parent.GetDirectories() | ...`) it is the same: an
        // unreadable value, and the group's own items are not what flows on (review 2026-11-23, third).
        if (top && top.opener !== '{' && group && next?.kind === 'w' && next.start === t.end
          && /^(?:\.|\[|::)/.test(next.pieces.map(p => p.t).join(''))) {
          const w: WordTok = { kind: 'w', pieces: [{ t: UNREAD, q: 'n' }], start: group.start, end: next.end, subs: [] }
          top.seg.words.push(w)
          touch(top.seg, w.start, w.end)
          top.seg.subexpr = true
          top.seg.groups.push(group)
          cur.transformed = true
          close(cur)
          cur = top.seg
          ti++
          break
        }
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
  const formatted = formatWord(ws)
  if (formatted !== null) return formatted
  const first = ws[0].pieces[0]
  if (!first || !(first.q !== 'n' || first.t.startsWith(S0) || first.t.startsWith('$'))) return null
  if (ws.length % 2 === 0) return null
  for (let k = 1; k < ws.length; k += 2) if (ws[k].pieces.map(p => p.t).join('') !== '+') return null
  const pieces: Piece[] = []
  for (let k = 0; k < ws.length; k += 2) pieces.push(...ws[k].pieces)
  return { kind: 'w', pieces, start: ws[0].start, end: ws[ws.length - 1].end, subs: ws.flatMap(w => w.subs) }
}

/**
 * `'{0}:\DCIM' -f 'D'`: PowerShell's format operator over literals is the text it makes (review
 * 2026-11-23, third). Null for any other shape, or an operand that is not a literal.
 */
function formatWord(ws: WordTok[]): WordTok | null {
  if (ws.length !== 3 || ws[1].pieces.length !== 1 || ws[1].pieces[0].q !== 'n' || ws[1].pieces[0].t.toLowerCase() !== '-f') return null
  if (!ws[0].pieces.length || ws[0].pieces.some(p => p.q === 'n')) return null
  const fmt = ws[0].pieces.map(p => p.t).join('')
  const args: string[] = []
  let cur: string | null = null
  for (const p of ws[2].pieces) {
    if (p.q !== 'n') { cur = (cur ?? '') + p.t; continue }
    if (!/^,+$/.test(p.t)) return null
    if (cur === null) return null
    args.push(cur); cur = null
  }
  if (cur === null) return null
  args.push(cur)
  let ok = true
  const text = fmt.replace(/\{(\d+)(?:[,:][^}]*)?\}/g, (_m: string, n: string) => { const a = args[Number(n)]; if (a === undefined) ok = false; return a ?? '' })
  if (!ok) return null
  return { kind: 'w', pieces: [{ t: text, q: 's' }], start: ws[0].start, end: ws[2].end, subs: [] }
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
/**
 * The interpreter a program name is (`python3.12`, `pypy3`, `pythonw` are python; `nodejs`, `tsx`,
 * `ts-node` are node), or null (review 2026-11-23: an exact-name table missed the versioned ones).
 */
function interpFamily(v: string): string | null {
  if (/^(?:python\d*(?:\.\d+)*w?|py|pypy\d*(?:\.\d+)*)$/.test(v)) return 'python'
  if (/^(?:node|nodejs|tsx|ts-node)$/.test(v)) return 'node'
  if (/^(?:lua\d*(?:\.\d+)*|luajit)$/.test(v)) return 'lua'
  if (/^(?:bun|deno|ruby|perl|php|rscript|powershell|pwsh|cmd|bash|sh|zsh|dash|wsl)$/.test(v)) return v === 'dash' ? 'sh' : v
  return null
}
function isInterpreter(v: string): boolean {
  return interpFamily(v) !== null
}
/** Runners that start the program named after them: `uv run`, `poetry run`, `npx`, `pnpm dlx` ... */
const RUNNERS: Record<string, { sub?: string[]; valueFlags: string[] }> = {
  uv: { sub: ['run'], valueFlags: ['--with', '-w', '--python', '-p', '--project', '--directory', '--env-file', '--group', '--extra', '--package', '--index'] },
  uvx: { valueFlags: ['--with', '-w', '--python', '-p', '--from', '--index'] },
  poetry: { sub: ['run'], valueFlags: ['-C', '--directory', '-P', '--project'] },
  pipenv: { sub: ['run'], valueFlags: [] },
  conda: { sub: ['run'], valueFlags: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  mamba: { sub: ['run'], valueFlags: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  pdm: { sub: ['run'], valueFlags: ['-p', '--project'] },
  hatch: { sub: ['run'], valueFlags: ['-e', '--env'] },
  npx: { valueFlags: ['-p', '--package'] },
  bunx: { valueFlags: ['-p', '--package'] },
  pnpm: { sub: ['dlx', 'exec'], valueFlags: ['-C', '--dir', '--filter'] },
  npm: { sub: ['exec', 'x'], valueFlags: ['-p', '--package', '-w', '--workspace'] },
  yarn: { sub: ['dlx', 'exec'], valueFlags: ['-p', '--package'] },
}
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
  'membername', 'pipelinevariable', 'pv',
  // PowerShell's pattern and string operators: their operand is a pattern or a text, never a path (review 2026-11-23).
  ...['match', 'notmatch', 'like', 'notlike', 'replace', 'split', 'join', 'contains', 'notcontains']
    .flatMap(o => [o, `c${o}`, `i${o}`])])
const RECURSIVE_FLAGS = new Set(['-recurse', '-r', '-rf', '-fr', '--recursive', '/s', '/mir', '-rec'])
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'env', 'xargs', 'start-process', 'saps', 'start', 'exec', 'command', 'nice', 'timeout', 'call'])

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
  /** The shell that reads this text: PowerShell, cmd or a POSIX shell. */
  dialect: Dialect
  /** The shell reading of an inline program: only the verb table's mutations count (review 2026-11-23). */
  codeAsShell: boolean
  /** `segs` by pipeline and by the pipeline a group is written in (`segsIn`). */
  index?: { of: Seg[]; pipeline: Map<number | null, Seg[]>; parent: Map<number | null, Seg[]>; at: Map<string, Seg>; parentAt: Map<string, Seg[]> }
  /** `earlierInPipe`'s running unions, by `pipeline:upTo`. */
  unions?: Map<string, Flow>
}

type Dialect = 'ps' | 'cmd' | 'posix'
type PayloadOpts = { dialect?: Dialect; baseUnreadable?: boolean }

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

/** The elements of a list a word names (`$a`, `$a[1]`, `$a[0..2]`): every one, never the indexed one alone. */
function boundList(ctx: Ctx, w: Word): string[] | null {
  const m = w.value.match(new RegExp(`^${S0}(\\d+)${S1}(?:\\[[^\\]]*\\])*$`))
  if (!m) return null
  const e = ctx.run.table[Number(m[1])]
  return e?.k === 'bound' && e.b.list ? e.b.list : null
}

function emitWord(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  let status: Emitted = 'none'
  const list = boundList(ctx, w)
  const parts = list !== null ? list.map(v => ({ ...literalWord(v), raw: w.raw })) : commaParts(w)
  for (const [n, part] of parts.entries()) {
    if ((n & 63) === 63 && overBudget(ctx.run)) break
    const r = emitOne(ctx, seg, part, op, o)
    if (r === 'ok') status = 'ok'
    else if (r !== 'none' && status === 'none') status = r
  }
  return status
}

function emitOne(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  const values = w.quotedFirst !== null ? [w.quotedFirst, w.value] : [w.value]
  let status: Emitted = 'none'
  // PowerShell's splatting (`Remove-Item @args`) hands the command a table the scan does not read.
  if (ctx.dialect === 'ps' && w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && /^@[A-Za-z_]\w*$/.test(w.value)) return 'unreadable'
  for (const v of values) {
    const x = expand(ctx.run, v, ctx.base, ctx.tilde)
    if (x.doc !== null) continue
    if (x.here !== null) {
      // A here-string used as a value (an operand, a variable bound to one, a group, the head of a
      // pipeline) is the text it holds: each line is a word (review 2026-11-23, third). One fed to an
      // interpreter is a program, read as one where it is consumed.
      if (seg !== null && hereFedAsText(ctx, seg)) continue
      const tail = x.text.startsWith(UNREAD) ? x.text.slice(1) : x.text
      for (const line of hereLines(ctx, x.here)) {
        const r = emitOne(ctx, seg, { ...literalWord(line.value + tail), raw: line.raw }, op, o)
        if (r === 'ok') status = 'ok'
        else if (r !== 'none' && status === 'none') status = r
      }
      continue
    }
    let aroundItem = false
    if (x.pipe) {
      // The pipeline's item first (`$_`, `$_.FullName`, `"$_\obj"`): what the earlier elements named.
      if (x.text.startsWith(PIPE)) { if (status === 'none') status = 'pipe'; continue }
      // Text before it (`"D:\$_"`, `"$HOME\$_"`): the item is a name the scan cannot read, inside what
      // the text before it names (review 2026-11-23).
      x.text = x.text.replace(/\u0005(?:\.\w+)*/g, UNREAD)
      aroundItem = true
    }
    const c = toPath(ctx.run, x.text, o.relAllowed, ctx.base, x.anchor !== null)
    if (c === null) continue
    if (aroundItem && isMut(op)) unresolved(ctx.run, op, o.verb, o.recursive === true, ctx.origText)
    // A recursive delete or move through a word that starts with a name nothing set, followed by a
    // separator (`"$EMPTY"/*`, `"$env:UNSET\.cache"`): the name is empty when the command runs, and the
    // word is the root of the current drive (entry 4.M3's incident shape; review 2026-11-23).
    if (c === 'unreadable' && x.leadUnset && (op === 'delete' || op === 'move') && o.recursive && /^\u0004+[\\/]/.test(x.text)) {
      const root = ctx.run.platform === 'posix' ? '/' : /^[A-Za-z]:/.test(ctx.base) ? `${ctx.base.slice(0, 2).toUpperCase()}\\` : null
      if (root !== null) {
        const p: ShellPath = { raw: w.raw, path: root, op, recursive: true, children: true, inherited: false, anchor: null, device: false, verb: o.verb, via: ctx.via, unsetName: x.leadName }
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

/** The lines of a here-string body as words: a double-quoted one has its variables read, as PowerShell expands them. */
function hereLines(ctx: Ctx, idx: number): Array<{ value: string; raw: string }> {
  const b = ctx.run.bodies[idx]
  if (!b) return []
  const out: Array<{ value: string; raw: string }> = []
  for (const l of b.text.split(/\r?\n/)) {
    const line = l.trim()
    if (line === '' || line.length > 1024) continue
    out.push({ value: b.q === '"' ? substitute(ctx.run, line, new Map()) : line, raw: line })
    if (out.length >= 64) break
  }
  return out
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
  const cds = ctx.codeAsShell ? [] : codeCdCalls(ctx)
  let k = 0
  for (const [n, seg] of ctx.segs.entries()) {
    if ((n & 31) === 31 && overBudget(ctx.run)) return
    // A folder change made through a .NET or engine call before this command (review 2026-11-23).
    for (; k < cds.length && cds[k].at < seg.start; k++) {
      if (cds[k].path === null) ctx.baseUnreadable = true
      else { ctx.base = cds[k].path as string; ctx.baseUnreadable = false }
    }
    try {
      classifySegment(ctx, seg)
    } catch (e) {
      ctx.run.out.faults.push(`a segment could not be read: ${(e as Error)?.message ?? String(e)}`)
    }
  }
}

const CD_CALL = /\[(?:System\.)?IO\.Directory\]::SetCurrentDirectory\s*\(|\.SetLocation\s*\(|\[(?:System\.)?Environment\]::CurrentDirectory\s*=(?!=)/gi

/** `[IO.Directory]::SetCurrentDirectory(...)`, `$ExecutionContext.SessionState.Path.SetLocation(...)`, `[Environment]::CurrentDirectory = ...`. */
function codeCdCalls(ctx: Ctx): Array<{ at: number; path: string | null }> {
  const out: Array<{ at: number; path: string | null }> = []
  const run = ctx.run
  const was = run.psStrings
  run.psStrings = ctx.dialect === 'ps'
  try {
    for (const m of ctx.textSub.matchAll(CD_CALL)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      const expr = m[0].endsWith('(') ? callArgs(ctx.textSub, end - 1, !run.psStrings).args[0] : ctx.textSub.slice(end, statementEnd(ctx.textSub, end, false, false)).trim()
      const v = expr === undefined ? null : evalExpr(run, expr, new Map())
      const c = v === null ? null : toPath(run, expand(run, v, ctx.base, true).text, true, ctx.base, false)
      out.push({ at, path: c && c !== 'unreadable' && !c.children ? c.path : null })
    }
  } finally {
    run.psStrings = was
  }
  return out
}

/** The segments of one pipeline, or the groups written in one: indexed once, so a lookup is not a walk of every segment. */
function segsIn(ctx: Ctx, by: 'pipeline' | 'parent', key: number | null): Seg[] {
  if (!ctx.index || ctx.index.of !== ctx.segs) {
    const pipeline = new Map<number | null, Seg[]>()
    const parent = new Map<number | null, Seg[]>()
    const at = new Map<string, Seg>()
    const parentAt = new Map<string, Seg[]>()
    const add = <K>(m: Map<K, Seg[]>, k: K, s: Seg) => { const l = m.get(k); if (l) l.push(s); else m.set(k, [s]) }
    for (const s of ctx.segs) {
      add(pipeline, s.pipeline, s); add(parent, s.parentPipeline, s)
      const k = `${s.pipeline}:${s.pipeIndex}`
      if (!at.has(k)) at.set(k, s)
      if (s.parentPipeline !== null) add(parentAt, `${s.parentPipeline}:${s.parentPipeIndex}`, s)
    }
    ctx.index = { of: ctx.segs, pipeline, parent, at, parentAt }
  }
  return (by === 'pipeline' ? ctx.index.pipeline : ctx.index.parent).get(key) ?? []
}

/** The element before this one in its pipeline. */
function previousInPipe(ctx: Ctx, seg: Seg): Seg | undefined {
  segsIn(ctx, 'pipeline', seg.pipeline)
  return ctx.index?.at.get(`${seg.pipeline}:${seg.pipeIndex - 1}`)
}

/** What flows down a pipeline to one element: the items, and whether an element before it changed them. */
type Flow = { paths: ShellPath[]; opaque: boolean }

/**
 * Pipeline elements whose output is the items they were handed or named, so a later element acts on
 * those items (review 2026-11-23, third). Filters pass their input on and name no item of their own (their
 * operands are property names and patterns). Any other element (`Split-Path`, `Join-Path`,
 * `Select-Object -ExpandProperty Parent` or a calculated property, `ForEach-Object { ... }`, a program)
 * hands on something the scan cannot read, so what reaches a later mutation is unresolved.
 */
const ITEM_SOURCES = new Set(['get-item', 'gi', 'get-childitem', 'gci', 'ls', 'dir', 'resolve-path', 'rvpa', 'convert-path', 'cvpa',
  'select-string', 'sls', 'find', 'xargs', 'tee-object', 'tee', 'out-null', 'write-output', 'echo', 'write-host'])
const ITEM_FILTERS = new Set(['where-object', 'where', '?', 'sort-object', 'sort', 'get-unique', 'gu'])
/** `Select-Object` parameters that keep the items themselves. */
const SELECT_KEEPS = new Set(['-first', '-last', '-skip', '-skiplast', '-unique', '-index', '-wait'])
/** Members of an item that are the item's own path. */
const PATH_MEMBERS = new Set(['fullname', 'pspath', 'path', 'literalpath'])
/** Elements that hand on another path than the one they were given, in every shell. */
const PATH_TRANSFORMS = new Set(['split-path', 'join-path', 'dirname', 'basename', 'readlink'])

/** Whether an element passes items on (`pass`), and whether the paths it names itself join them (`own`). */
function passesItems(ctx: Ctx, seg: Seg): { pass: boolean; own: boolean } {
  if (seg.words.length === 0) return { pass: true, own: true }
  if (seg.transformed) return { pass: false, own: false }
  const words = seg.words.map(t => wordOf(ctx, t))
  let k = 0
  while (k < words.length && (words[k].text === '&' || words[k].text === '.')) k++
  const head = words[k]
  if (!head) return { pass: true, own: true }
  if (!seg.call && isValueWord(head)) return { pass: true, own: true }
  const verb = verbName(head.text)
  if (PATH_TRANSFORMS.has(verb)) return { pass: false, own: false }
  // cmd and a POSIX shell hand on text lines: only the transforms above are known to change them.
  if (ctx.dialect !== 'ps' || ctx.codeAsShell) return { pass: true, own: true }
  if (seg.call) return { pass: false, own: false }
  const rest = words.slice(k + 1)
  if (verb === 'select-object' || verb === 'select') {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].text.toLowerCase()
      if (SELECT_KEEPS.has(t)) { if (/^\d[\d,]*$/.test(rest[i + 1]?.text ?? '')) i++; continue }
      if ((t === '-expandproperty' || t === '-expand' || t === '-exp') && PATH_MEMBERS.has((rest[i + 1]?.text ?? '').toLowerCase())) { i++; continue }
      return { pass: false, own: false }
    }
    return { pass: seg.groups.length === 0, own: false }
  }
  if (verb === 'foreach-object' || verb === '%' || verb === 'foreach') {
    const member = rest.find(w => !w.text.startsWith('-'))
    const m = (member?.text ?? '').toLowerCase()
    if (seg.groups.length === 0 && member && (PATH_MEMBERS.has(m) || MEMBER_MUTATIONS[m] !== undefined)) return { pass: true, own: false }
    return { pass: false, own: false }
  }
  if (ITEM_FILTERS.has(verb)) return { pass: true, own: false }
  if (ITEM_SOURCES.has(verb) || DELETE_VERBS.has(verb) || MOVE_VERBS.has(verb) || COPY_VERBS.has(verb) || NEW_ITEM.has(verb)
    || WRITE_TARGET_FIRST.has(verb) || WRITE_ALL.has(verb) || CONTENT_VERBS.has(verb)) return { pass: true, own: true }
  return { pass: false, own: false }
}

/**
 * What the elements of a pipeline before `upTo` named, and the groups written in them (`@('D:\x') |
 * Remove-Item`, `(Get-ChildItem D:\x) | Remove-Item`: a group's paths flow down the pipeline too), each
 * path once, and whether an element on the way changed the items (`opaque`). Built element by element and
 * kept, so a long pipeline costs linear time (review 2026-11-23).
 */
function earlierInPipe(ctx: Ctx, pipeline: number, upTo: number): Flow {
  ctx.unions ??= new Map()
  let from = upTo
  while (from > 0 && !ctx.unions.has(`${pipeline}:${from}`)) from--
  let acc: Flow = from > 0 ? ctx.unions.get(`${pipeline}:${from}`) as Flow : { paths: [], opaque: false }
  for (let k = from; k < upTo; k++) {
    segsIn(ctx, 'pipeline', pipeline)
    const own = ctx.index?.at.get(`${pipeline}:${k}`)
    const pass = own ? passesItems(ctx, own) : { pass: true, own: true }
    const next = pass.pass ? [...acc.paths] : []
    const keys = new Set(next.map(p => `${p.path}\u0000${p.op}\u0000${p.children}`))
    const add = (list: ShellPath[]) => {
      for (const p of list) {
        const key = `${p.path}\u0000${p.op}\u0000${p.children}`
        if (keys.has(key) || next.length >= MAX_PATHS) continue
        keys.add(key); next.push(p)
      }
    }
    if (pass.pass && pass.own) {
      if (own) add(ctx.segPaths.get(own.id) ?? [])
      for (const other of ctx.index?.parentAt.get(`${pipeline}:${k}`) ?? []) {
        if (other.pipeline === pipeline || other.transformed || !passesItems(ctx, other).pass) continue
        add(ctx.segPaths.get(other.id) ?? [])
      }
    }
    acc = { paths: next, opaque: acc.opaque || !pass.pass }
    ctx.unions.set(`${pipeline}:${k + 1}`, acc)
  }
  return acc
}

function inheritedSources(ctx: Ctx, seg: Seg, pipeItem: boolean): Flow {
  const mine = earlierInPipe(ctx, seg.pipeline, seg.pipeIndex)
  const out: ShellPath[] = [...mine.paths]
  let opaque = mine.opaque
  // Inside a script block (`gci x | % { Remove-Item $_ }`): what the pipeline around the block named.
  if ((pipeItem || out.length === 0) && seg.parentPipeline !== null) {
    const around = earlierInPipe(ctx, seg.parentPipeline, seg.parentPipeIndex)
    out.push(...around.paths)
    opaque ||= around.opaque
  }
  return { paths: out, opaque }
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
    const flow: Flow = hasEarlier(ctx, seg) ? inheritedSources(ctx, seg, true) : { paths: [], opaque: false }
    const all = flow.paths
    // An element on the way changed the items (`Split-Path`, `Select-Object -ExpandProperty Parent`, a
    // script block): what arrives cannot be read (review 2026-11-23, third).
    if (flow.opaque) unreadable = true
    // What a content reader sends down the pipeline is the file's lines, not the file: the targets come
    // from text the scan cannot read (review 2026-11-23).
    const sources = all.filter(s => !CONTENT_VERBS.has(s.verb))
    if (sources.length < all.length) unreadable = true
    // Each source once: a chain of mutating elements (`gci x | ri | ri | ...`) would otherwise pass on
    // twice as many copies at every step (review 2026-11-23, cost).
    const once = new Set<string>()
    for (const s of sources) {
      if (s.path === null) continue
      const key = `${s.path}\u0000${s.children}`
      if (once.has(key) || once.size >= MAX_PATHS) continue
      once.add(key)
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
  // Redirects: a write on every target except the null devices (any verb, after `echo` too). In the
  // shell reading of an inline program a `>` is a comparison or an arrow, not a redirect.
  for (const r of ctx.codeAsShell ? [] : seg.redirects) {
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
  // a mention a later verb inherits (review 2026-11-23). In PowerShell such a segment is an expression
  // (`$t[($n-30)..($n-1)]`, `$_ -match "\[x\]"`), never a command: nothing else in it is a path. In cmd
  // and a POSIX shell the words are still classified below, in case the head is a quoted program.
  if (!seg.call && !ctx.codeAsShell && isValueWord(words[0])) {
    for (let k = 0; k < words.length; k++) {
      const w = words[k]
      if (looksLikeParam(w) && PS_VALUE_PARAMS.has(w.text.slice(1).toLowerCase())) { k++; continue }
      if (!isValueWord(w)) continue
      emitWord(ctx, seg, w, 'mention', { relAllowed: true, verb: 'value' })
      // A drive or share written as a method's argument (`$fso.DeleteFolder('D:\x')`): what the method does
      // with it cannot be read, so it is a program operand.
      if (seg.methodArgs && ctx.dialect === 'ps') emitAbsolute(ctx, seg, w, 'method')
    }
  }
  if (!seg.call && (ctx.codeAsShell || ctx.dialect === 'ps') && isExpressionHead(words[0])) { consumeDocs(ctx, seg, docWords, null); return }
  // Wrappers and runners.
  for (let guard = 0; guard < 16 && words.length; guard++) {
    const v = verbName(words[0].text)
    if (words[0].text === '.' || words[0].text === '&') { words = words.slice(1); continue }
    const runner = RUNNERS[v]
    if (runner) {
      const unwrapped = unwrapRunner(ctx, v, runner, words.slice(1))
      if (unwrapped === 'done') return
      if (unwrapped !== null) { words = unwrapped; continue }
    }
    if (!WRAPPERS.has(v) && !(v === 'wsl' && !words.slice(1).some(w => /^-(?:l?c)$/i.test(w.text)))) break
    if ((v === 'start-process' || v === 'saps' || (v === 'start' && ctx.dialect === 'ps')) && !ctx.codeAsShell) {
      const sp = startProcess(ctx, seg, words.slice(1))
      if (sp === 'done') return
      if (sp !== null) { words = sp; continue }
    }
    words = unwrapWrapper(v, words.slice(1))
  }
  if (words.length === 0) { consumeDocs(ctx, seg, docWords, null); return }
  // `cd..`, `cd\`, `chdir..`: PowerShell's built-in functions and cmd's spellings of cd (review 2026-11-23).
  const glued = words[0].tok.pieces.length === 1 && words[0].tok.pieces[0].q === 'n' ? words[0].text.match(/^(cd|chdir)([.\\/].*)$/i) : null
  if (glued) words = [literalWord(glued[1]), literalWord(glued[2]), ...words.slice(1)]
  const program = words[0]
  const verb = verbName(program.text)
  const operands = words.slice(1)
  consumeDocs(ctx, seg, docWords, verb)
  // A script block's `param(...)` is a statement of its own: what follows it on the line is the next one.
  if (verb === 'param' && ctx.dialect === 'ps' && !ctx.codeAsShell) {
    const g = seg.groups.find(x => x.opener === '(')
    const after = g ? seg.words.filter(t => t.start >= g.end) : []
    if (after.length) classifySegment(ctx, { ...seg, words: after, redirects: [], groups: seg.groups.filter(x => x !== g) })
    return
  }
  // cmd's `if [/i] [not] exist X | defined X | errorlevel N | A==B COMMAND`: the command is classified.
  if (verb === 'if' && operands.length && !ctx.codeAsShell) {
    const body = cmdIfBody(operands)
    if (body.length) classifySegment(ctx, { ...seg, words: body.map(w => w.tok), redirects: [], groups: [] })
    return
  }
  if (ctx.codeAsShell && !(DELETE_VERBS.has(verb) || MOVE_VERBS.has(verb) || COPY_VERBS.has(verb) || NEW_ITEM.has(verb)
    || WRITE_TARGET_FIRST.has(verb) || WRITE_ALL.has(verb))) return
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
  if (isInterpreter(verb)) return interpreter(ctx, seg, verb, operands)
  if (verb === 'find') return findVerb(ctx, seg, operands)
  if (CD_VERBS.has(verb)) return cdVerb(ctx, seg, verb, operands)
  if (POP_VERBS.has(verb)) {
    const top = ctx.dirStack.pop()
    if (top) { ctx.base = top.base; ctx.baseUnreadable = top.unreadable } else ctx.baseUnreadable = true
    return
  }
  // `cp -t DIR` / `--target-directory DIR`: the destination is named first (review 2026-11-23).
  const p = parseArgs(operands, verb, verb === 'cp' ? CP_VALUE_FLAGS : new Set(), seg.groups)
  if (verb === 'foreach-object' || verb === '%' || verb === 'foreach') {
    // `% Delete`, `ForEach-Object 'Delete'`, `ForEach-Object -MemberName MoveTo -ArgumentList ...`: a
    // method of each pipeline item.
    const member = (namedPaths(p, 'membername')[0] ?? p.positional[0])
    const mop = member && member.tok.pieces.length === 1 ? MEMBER_MUTATIONS[member.text.toLowerCase()] : undefined
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
  // Everything else: operands are unclassified; -OutFile, -Destination and -DestinationPath are writes. A
  // drive or share written inside an operand (`mshta "javascript:...('D:\\x')"`, an `Add-Type` source) is a
  // program operand too (review 2026-11-23); a `-Value` is a mention, as an assignment's value is.
  const writes = namedPaths(p, 'outfile', 'destination', 'dest', 'destinationpath')
  if (writes.length) mutate(ctx, seg, writes, 'write', verb, false)
  const programOperand = (w: Word) => { if (emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb }) !== 'ok') emitAbsolute(ctx, seg, w, verb) }
  for (const w of [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'filepath', 'target')]) programOperand(w)
  for (const w of namedPaths(p, 'value')) emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb })
  for (const [name, list] of p.named) {
    if (PS_PATH_PARAMS.has(name) || PS_VALUE_PARAMS.has(name)) continue
    for (const w of list) programOperand(w)
  }
}

const CP_VALUE_FLAGS = new Set(['-t', '--target-directory'])

/** A word that starts an expression rather than a command in PowerShell: a value, an index, a type, a number. */
function isExpressionHead(w: Word): boolean {
  return isValueWord(w) || /^\[|^\d[\d.]*$/.test(w.text) || (w.tok.pieces[0]?.q === 'n' && w.tok.pieces[0].t.startsWith('$'))
}

/** Drive, share and device spellings written inside a word (`'...Delete(@"D:\x",true)...'`). */
const EMBEDDED_ABS = /(?<![\w\\/:])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9$_-][\w.$-]*[\\/]|\\\\[?.][\\/])[^\s'"`;,|&<>(){}\u0002-\u0005]*/g

/**
 * Each drive-absolute, share or device spelling inside a word, as a program operand: judged against the
 * always-denied set only (a volume nothing protects, the home and its dot-entries, CynCo's folders).
 * A doubled backslash (`D:\\x`, as code escapes it) is read as one.
 */
function emitAbsolute(ctx: Ctx, seg: Seg | null, w: Word, verb: string): void {
  if (!/[\\/]/.test(w.text)) return
  for (const m of w.text.matchAll(EMBEDDED_ABS)) {
    const lit = m[0].startsWith('\\\\') ? `\\\\${m[0].slice(2).replace(/\\\\/g, '\\')}` : m[0].replace(/\\\\/g, '\\')
    emitWord(ctx, seg, { ...literalWord(lit), raw: lit }, 'unclassified', { relAllowed: false, verb })
  }
}

/** cmd's `if` with its condition taken off: the command it runs. */
function cmdIfBody(operands: Word[]): Word[] {
  let k = 0
  const lower = (j: number) => (operands[j]?.tok.pieces.length === 1 && operands[j].tok.pieces[0].q === 'n' ? operands[j].text.toLowerCase() : '')
  if (lower(k) === '/i') k++
  if (lower(k) === 'not') k++
  const kw = lower(k)
  if (kw === 'exist' || kw === 'defined' || kw === 'errorlevel' || kw === 'cmdextversion') k += 2
  else if (operands[k] && /==/.test(operands[k].text)) k += 1
  else if (/^(?:==|equ|neq|lss|leq|gtr|geq)$/.test(lower(k + 1))) k += 3
  else return []
  return operands.slice(k)
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
    for (const s of segsIn(ctx, 'parent', seg.pipeline)) {
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

/**
 * `uv run [opts] PROGRAM ...`, `npx [opts] PROGRAM ...`, `pnpm dlx ...`: the words from PROGRAM on. A
 * `-c` / `--call` of npx and `npm exec` is a shell command, scanned as one ('done'). null: not a run.
 */
function unwrapRunner(ctx: Ctx, v: string, runner: (typeof RUNNERS)[string], rest: Word[]): Word[] | 'done' | null {
  let i = 0
  if (runner.sub) {
    if (!rest[0] || !runner.sub.includes(rest[0].text.toLowerCase())) return null
    i = 1
  }
  const vf = new Set(runner.valueFlags)
  while (i < rest.length) {
    const t = rest[i].text
    if (t === '--') { i++; break }
    if ((t === '-c' || t === '--call') && (v === 'npx' || v === 'npm' || v === 'pnpm' || v === 'yarn' || v === 'bunx')) {
      const payload = rest[i + 1]
      if (!payload) return 'done'
      ctx.run.out.texts.push(renderOrig(ctx.run, payload.value))
      scanPayload(ctx.run, payload.value, ctx.base, `${ctx.via}>${v} -c`, ctx.depth + 1, 'shell', { dialect: ctx.run.platform === 'win32' ? 'cmd' : 'posix' })
      return 'done'
    }
    if (/^--[\w-]+=/.test(t)) { i++; continue }
    if (t.startsWith('-') && t !== '-') { i += vf.has(t) ? 2 : 1; continue }
    break
  }
  return rest.slice(i)
}

/** Start-Process's parameters, with their aliases; the switches take no value. */
const SP_PARAMS = ['argumentlist', 'credential', 'filepath', 'loaduserprofile', 'nonewwindow', 'passthru', 'redirectstandarderror',
  'redirectstandardinput', 'redirectstandardoutput', 'usenewenvironment', 'verb', 'wait', 'windowstyle', 'workingdirectory', 'environment']
const SP_ALIASES: Record<string, string> = { args: 'argumentlist', runas: 'credential', pspath: 'filepath', path: 'filepath', lup: 'loaduserprofile',
  nnw: 'nonewwindow', rse: 'redirectstandarderror', rsi: 'redirectstandardinput', rso: 'redirectstandardoutput' }
const SP_SWITCHES = new Set(['loaduserprofile', 'nonewwindow', 'passthru', 'usenewenvironment', 'wait'])

/**
 * `Start-Process` (`saps`, PowerShell's `start`) read as PowerShell binds it (review 2026-11-23, third):
 * every switch is skipped wherever it stands, a parameter is matched by any unambiguous prefix, the first
 * positional word is -FilePath and the second -ArgumentList. The program and its argument list (a comma
 * list is one argument per element, a single string is the whole command line) are scanned as the command
 * line the program is started with, in -WorkingDirectory when there is one. 'done' when it was scanned so,
 * the words to classify when there is no argument list, null when there is no program.
 */
function startProcess(ctx: Ctx, seg: Seg, rest: Word[]): Word[] | 'done' | null {
  const named = new Map<string, Word>()
  const positional: Word[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]
    const m = w.tok.pieces[0]?.q === 'n' ? w.text.match(/^-([A-Za-z]+)(?::([\s\S]+))?$/) : null
    if (!m) { positional.push(w); continue }
    const lower = m[1].toLowerCase()
    const name = SP_ALIASES[lower] ?? (SP_PARAMS.filter(p => p.startsWith(lower)).length === 1 ? SP_PARAMS.find(p => p.startsWith(lower)) : undefined)
    if (name === undefined) continue
    if (SP_SWITCHES.has(name)) continue
    if (m[2] !== undefined) { named.set(name, { ...w, value: w.value.slice(w.value.indexOf(':') + 1), text: m[2], raw: m[2], quotedFirst: null, tok: { ...w.tok, pieces: [{ t: m[2], q: 'n' }] } }); continue }
    const next = rest[i + 1]
    const group = seg.groups.find(g => g.opener !== '{' && g.start >= w.tok.end && (next === undefined || g.end <= next.tok.start))
    if (group) { named.set(name, unreadableWord('(...)')); continue }
    if (next !== undefined) { named.set(name, next); i++ }
  }
  const prog = named.get('filepath') ?? positional[0]
  if (prog === undefined) return null
  const args = named.get('argumentlist') ?? (named.has('filepath') ? positional[0] : positional[1])
  for (const k of ['redirectstandardoutput', 'redirectstandarderror']) {
    const w = named.get(k)
    if (w) mutate(ctx, seg, [w], 'write', `Start-Process -${k}`, false)
  }
  const input = named.get('redirectstandardinput')
  if (input) emitWord(ctx, seg, input, 'read', { relAllowed: true, verb: 'Start-Process' })
  if (args === undefined) return [prog]
  const quote = (s: string) => (/[\s"]/.test(s) && !s.includes(S0) ? `"${s.replace(/"/g, '')}"` : s)
  const list = commaParts(args)
  const argText = list.length > 1 || args.tok.pieces.some(p => p.q === 'n' && p.t.includes(',')) ? list.map(w => quote(w.value)).join(' ') : args.value
  let base = ctx.base
  let baseUnreadable = ctx.baseUnreadable
  const wd = named.get('workingdirectory')
  if (wd) {
    const p = pathOfWord(ctx, wd)
    if (p === null) baseUnreadable = true
    else { base = p; baseUnreadable = false }
  }
  const text = `${quote(prog.value)} ${argText}`
  ctx.run.out.texts.push(renderOrig(ctx.run, text))
  scanPayload(ctx.run, text, base, `${ctx.via}>Start-Process`, ctx.depth + 1, 'shell', { dialect: ctx.run.platform === 'win32' ? 'cmd' : 'posix', baseUnreadable })
  return 'done'
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
      // `-ArgumentList 'a','b'`: the list is the program's argv (review 2026-11-23).
      const al = rest.findIndex(w => /^-(?:argumentlist|args)$/i.test(w.text))
      const argv = al >= 0 && rest[al + 1] ? commaParts(rest[al + 1]) : []
      const others = rest.filter((_, k) => k !== fp && k !== fp + 1 && (al < 0 || (k !== al && k !== al + 1)))
      return [prog, ...argv, ...others]
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
    const consumer = verb !== null && (isInterpreter(verb) || verb === 'iex' || verb === 'invoke-expression')
    const piped = laterPipeHasInterpreter(ctx, seg)
    useBody(ctx, x.doc, consumer || piped ? 'code' : 'data', 'shell>heredoc')
  }
}

/** Programs and writers that take the text of what they are handed, never a path in it. */
const TEXT_CONSUMERS = new Set(['out-string', 'convertfrom-json', 'convertfrom-csv', 'convertfrom-stringdata', 'set-clipboard', 'scb',
  'iex', 'invoke-expression', ...WRITE_TARGET_FIRST, 'tee-object', 'tee'])

/**
 * A here-string at the head of a pipeline whose next element takes it as text (an interpreter, a writer,
 * a converter): a program or a file's content, never a list of paths.
 */
function hereFedAsText(ctx: Ctx, seg: Seg): boolean {
  if (laterPipeHasInterpreter(ctx, seg)) return true
  segsIn(ctx, 'pipeline', seg.pipeline)
  const next = ctx.index?.at.get(`${seg.pipeline}:${seg.pipeIndex + 1}`)
  if (!next || next.words.length === 0) return false
  return TEXT_CONSUMERS.has(verbName(wordOf(ctx, next.words[0]).text))
}

function laterPipeHasInterpreter(ctx: Ctx, seg: Seg): boolean {
  for (const other of segsIn(ctx, 'pipeline', seg.pipeline)) {
    if (other.pipeIndex <= seg.pipeIndex || other.words.length === 0) continue
    const first = wordOf(ctx, other.words[0])
    const v = verbName(first.text)
    if (isInterpreter(v) || v === 'iex' || v === 'invoke-expression') return true
  }
  return false
}

/** Here-strings of the earlier segment of a pipeline that this segment consumes. */
function heresPipedInto(ctx: Ctx, seg: Seg, verb: string): void {
  if (seg.pipeIndex === 0) return
  const code = isInterpreter(verb) || verb === 'iex' || verb === 'invoke-expression'
  const other = previousInPipe(ctx, seg)
  for (const t of other?.words ?? []) {
    const x = expand(ctx.run, t.pieces.map(p => p.t).join(''), ctx.base, false)
    if (x.here !== null) useBody(ctx, x.here, code ? 'code' : 'data', 'shell>heredoc')
  }
}

/** A body's consumer is known: a code body is scanned as shell text and as code, a data body only joins `texts`. */
function useBody(ctx: Ctx, idx: number, use: 'code' | 'data', via: string): void {
  const body = ctx.run.bodies[idx]
  if (!body || body.use !== null) return
  body.use = use
  ctx.run.out.texts.push(body.text)
  if (use === 'code') scanPayload(ctx.run, body.text, ctx.base, via, ctx.depth + 1, 'both', { baseUnreadable: ctx.baseUnreadable })
}

function cdVerb(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  // cmd's `cd /d X:\dir` and `chdir /d`: the switch is not the target (review 2026-11-23).
  if (verb === 'cd' || verb === 'chdir' || verb === 'pushd') operands = operands.filter(w => !(w.tok.pieces[0]?.q === 'n' && /^\/[A-Za-z?]$/.test(w.text)))
  const p = parseArgs(operands, verb, new Set(), seg.groups)
  const target = namedPaths(p, 'path', 'literalpath')[0] ?? p.positional[0]
  if (verb === 'pushd' || verb === 'push-location') ctx.dirStack.push({ base: ctx.base, unreadable: ctx.baseUnreadable })
  if (!target) {
    // A folder handed down the pipeline (`'D:\' | Set-Location`, `Get-Item D:\ | Set-Location`): the one
    // path the earlier elements named, or a folder the scan cannot read. A group as the target
    // (`cd (Get-PSDrive D).Root`) cannot be read either (review 2026-11-23).
    if (hasEarlier(ctx, seg)) {
      const flow = inheritedSources(ctx, seg, true)
      const from = flow.paths.filter(s => s.path !== null && !CONTENT_VERBS.has(s.verb))
      const one = !flow.opaque && from.length === 1 && !from[0].children ? from[0].path : null
      if (one !== null) { ctx.base = one; ctx.baseUnreadable = false } else ctx.baseUnreadable = true
      return
    }
    if (seg.groups.some(g => g.opener !== '{')) { ctx.baseUnreadable = true; return }
    if (verb === 'cd' || verb === 'chdir') { ctx.base = ctx.run.homes.home; ctx.baseUnreadable = false }
    return
  }
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
  const dstNamed = namedPaths(p, 'destination', 'dest', 't', 'target-directory', '--target-directory')
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
    if (expr[j] !== '-exec' && expr[j] !== '-execdir' && expr[j] !== '-ok' && expr[j] !== '-okdir') continue
    if (/^(?:rm|rmdir|unlink|shred)$/.test(verbName(expr[j + 1]))) del = true
    // The command run on each file is a command of its own, in which `{}` cannot be read (review 2026-11-23).
    let e = j + 1
    while (e < expr.length && !/^\\?[;+]$|^\\$/.test(expr[e])) e++
    const body = operands.slice(k + j + 1, k + e).map(w => (w.text === '{}' ? { ...w.tok, pieces: [{ t: UNREAD, q: 'n' as const }] } : w.tok))
    if (body.length) classifySegment(ctx, { ...seg, words: body, redirects: [], groups: [] })
    j = e
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

function interpreter(ctx: Ctx, seg: Seg, verb0: string, operands: Word[]): void {
  const verb = interpFamily(verb0) ?? verb0
  const texts = operands.map(w => w.text)
  const lower = texts.map(t => t.toLowerCase())
  const selfBuildingVar = () => markSelfBuilding(ctx.run, 'an inline program passed through a variable that cannot be read')
  const dialectOf = (v: string): Dialect => v === 'cmd' ? 'cmd' : v === 'powershell' || v === 'pwsh' ? 'ps' : 'posix'
  const scanText = (text: string, via: string, mode: 'shell' | 'both') => {
    ctx.run.out.texts.push(renderOrig(ctx.run, text))
    scanPayload(ctx.run, text, ctx.base, via, ctx.depth + 1, mode, { dialect: dialectOf(verb), baseUnreadable: ctx.baseUnreadable })
  }
  const runPayload = (from: number, via: string, mode: 'shell' | 'both', encoded = false) => {
    const pl = payloadOf(ctx, operands, from)
    if (pl.viaVariable) { selfBuildingVar(); return }
    if (pl.text === null) return
    if (encoded) {
      const decoded = decodeEncoded(pl.text)
      if (decoded === null) { markSelfBuilding(ctx.run, 'an -EncodedCommand that does not decode to text'); return }
      ctx.run.out.texts.push(decoded)
      scanPayload(ctx.run, decoded, ctx.base, 'shell>encoded', ctx.depth + 1, 'shell', { dialect: 'ps', baseUnreadable: ctx.baseUnreadable })
      return
    }
    scanText(pl.text, via, mode)
  }
  if (verb === 'cmd') {
    // Every switch up to /c, /k or /r, with or without a value (`/v:on`, `/t:0A`); /r is /c (review 2026-11-23).
    let k = 0
    while (k < lower.length && CMD_SWITCH.test(lower[k]) && operands[k].tok.pieces[0]?.q === 'n' && !/^\/[ckr]/.test(lower[k])) k++
    if (k < lower.length && /^\/[ckr]$/.test(lower[k])) return runPayload(k + 1, 'shell>cmd /c', 'shell')
    // `/c"rd /s /q D:\x"`, `/crd ...`: cmd takes the text glued to the switch as the start of its command
    // (measured; review 2026-11-23, third).
    if (k < lower.length && /^\/[ckr]./.test(lower[k]) && operands[k].tok.pieces[0]?.q === 'n') {
      const w = operands[k]
      const head = [w.tok.pieces[0].t.slice(2), ...w.tok.pieces.slice(1).map(p => p.t)].join('')
      const tail = k + 1 < operands.length ? ctx.textSub.slice(operands[k + 1].tok.start, operands[operands.length - 1].tok.end) : ''
      return scanText([head, tail].filter(s => s !== '').join(' '), 'shell>cmd /c', 'shell')
    }
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
  // An inline program: a short-option cluster that ends in the code letter (`python -Bc`, `node -pe`,
  // `ruby -we`), the long forms with and without `=`, and the code written onto the flag (`python -c"..."`);
  // only the options before the script or the module are read (review 2026-11-23).
  const code = CODE_FLAGS[verb]
  if (code) {
    for (let k = 0; k < operands.length; k++) {
      const w = operands[k]
      const first = w.tok.pieces[0]
      const t = lower[k]
      // A quoted flag is still a flag to the program (`Start-Process ... -ArgumentList '-c','...'`).
      if (!first || !t.startsWith('-') || t === '-') break
      const via = `shell>${verb0} ${texts[k].split(/\s/)[0]}`
      if (code.flag.test(t)) {
        if (verb === 'perl' && lower.some(x => /^-[a-z]*i/.test(x))) {
          const files = operands.slice(k + 2).filter(x => !/^-/.test(x.text))
          mutate(ctx, seg, files, 'write', 'perl -i', false)
        }
        return runPayload(k + 1, via, 'both')
      }
      const long = w.value.match(/^--(?:eval|print)=([\s\S]*)$/)
      if (long && (verb === 'node' || verb === 'bun')) return scanText(long[1], via, 'both')
      if (first.q === 'n' && w.tok.pieces.length > 1 && code.flag.test(first.t.toLowerCase())) return scanText(w.tok.pieces.slice(1).map(p => p.t).join(''), via, 'both')
      if (code.stop.test(t)) break
      if (code.value.test(t)) k++
    }
  }
  if (verb === 'deno' && lower[0] === 'eval') return runPayload(1, 'shell>deno eval', 'both')
  // `-`, or no script at all, reads the program from standard input: a here-document (the consumer
  // rules) or what the earlier element of the pipeline writes (fromStdin).
  const m = lower.indexOf('-m')
  if (lower.includes('-') || (m < 0 && !operands.some(w => !w.text.startsWith('-')))) fromStdin(ctx, seg, verb, 'both')
  return otherOperands(ctx, seg, verb, operands, 0, m)
}

/** Per interpreter: the flag that carries code, an option that ends the interpreter's options, one that takes a value. */
const CODE_FLAGS: Record<string, { flag: RegExp; stop: RegExp; value: RegExp }> = {
  python: { flag: /^-[a-z]*c$/i, stop: /^-[a-z]*m$/i, value: /^-[a-zA-Z]*[WX]$/ },
  node: { flag: /^(?:-[a-z]*[ep]|--eval|--print)$/i, stop: /^--$/, value: /^(?:-r|--require|--import|--loader|-c|--conditions|--env-file)$/ },
  bun: { flag: /^(?:-[a-z]*[ep]|--eval|--print)$/i, stop: /^--$/, value: /^(?:-r|--preload|--cwd|--config|--env-file)$/ },
  ruby: { flag: /^-[a-z]*e$/i, stop: /^--$/, value: /^-[a-z]*[ir]$/i },
  perl: { flag: /^-[a-z]*e$/i, stop: /^--$/, value: /^-[a-z]*[IM]$/ },
  php: { flag: /^-r$/, stop: /^--$/, value: /^-[cdz]$/ },
  lua: { flag: /^-e$/, stop: /^--$/, value: /^-l$/ },
  rscript: { flag: /^-e$/, stop: /^--$/, value: /^$/ },
}

/**
 * An interpreter that reads its program from standard input inside a pipeline (`echo ... | powershell -`,
 * `'...' | python -`): the text written by an `echo` or a value at the head of the pipeline is scanned as
 * the program; anything else feeding it cannot be read and is self-building (review 2026-11-23). A
 * here-string feeding it was scanned by `heresPipedInto`.
 */
function fromStdin(ctx: Ctx, seg: Seg, verb: string, mode: 'shell' | 'both'): void {
  if (seg.pipeIndex === 0) return
  const prev = previousInPipe(ctx, seg)
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
  const dialect: Dialect = verb === 'cmd' ? 'cmd' : verb === 'powershell' || verb === 'pwsh' ? 'ps' : 'posix'
  scanPayload(ctx.run, pl.text, ctx.base, `shell>${verb} stdin`, ctx.depth + 1, mode, { dialect, baseUnreadable: ctx.baseUnreadable })
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
    if (emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb }) !== 'ok') emitAbsolute(ctx, seg, w, verb)
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

/**
 * Settings that make git run a program or reach outside the work tree: `-c` with one of them runs what
 * the command text carries (review 2026-11-23).
 */
const GIT_RUNNING_KEY = /^(?:alias\.[^=]*=\s*!|core\.(?:sshcommand|pager|editor|fsmonitor|hookspath|gitproxy|askpass)\b|diff\.external\b|diff\.[^=]+\.(?:textconv|command)\b|filter\.[^=]+\.(?:clean|smudge|process)\b|merge\.[^=]+\.driver\b|sequence\.editor\b|credential\.helper\b|gpg\.(?:[^=.]+\.)?program\b|protocol\.[^=]*allow\b|uploadpack\.packobjectshook\b|url\.[^=]*\.(?:insteadof|pushinsteadof)\b|include\.path\b|includeif\.|pager\.|interactive\.difffilter\b|sendemail\.|remote\.[^=]+\.(?:uploadpack|receivepack|proxy)\b|http\.proxy\b)/i

/** `GIT_WORK_TREE=...`, `$env:GIT_DIR = ...` anywhere in the text: the word assigned to each (review 2026-11-23). */
function gitEnvWords(ctx: Ctx): Array<[string, Word]> {
  const out: Array<[string, Word]> = []
  for (const m of ctx.textSub.matchAll(/(?:\$\{?env:)?\b(GIT_WORK_TREE|GIT_DIR)\}?\s*=(?!=)\s*/gi)) {
    const at = (m.index ?? 0) + m[0].length
    const tok = tokenize(ctx.textSub.slice(at, statementEnd(ctx.textSub, at, true, ctx.dialect === 'posix')), ctx.dialect === 'posix')[0]
    if (!tok || tok.kind !== 'w') continue
    const value = tok.pieces.map(p => p.t).join('')
    out.push([m[1].toUpperCase(), { tok, value, text: expand(ctx.run, value, ctx.base, ctx.tilde).text, raw: renderOrig(ctx.run, value), quotedFirst: null }])
  }
  return out
}

function classifyGit(ctx: Ctx, seg: Seg | null, args: Word[], segText: string): void {
  // The work tree an environment variable names is where a destructive subcommand acts; the folder of the
  // other commands is unchanged by it.
  const env = ctx.via === 'argv' ? [] : gitEnvWords(ctx)
  // Settings handed to git through the environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_<n>`) can
  // move the work tree or name a program, and are not read (review 2026-11-23, third).
  if (ctx.via !== 'argv' && /\bGIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)\b\}?\s*=(?!=)/i.test(ctx.textSub)) {
    markSelfBuilding(ctx.run, 'git settings handed in through GIT_CONFIG_* in the environment')
  }
  const saved = { base: ctx.base, unreadable: ctx.baseUnreadable }
  for (const [name, w] of env) {
    ctx.run.out.sawWrite = true
    const r = emitWord(ctx, seg, w, 'write', { relAllowed: true, verb: `git (${name})` })
    if (r !== 'ok') unresolved(ctx.run, 'write', `git (${name})`, false, ctx.origText)
    if (name === 'GIT_WORK_TREE') {
      const p = pathOfWord(ctx, w)
      if (p === null) ctx.baseUnreadable = true
      else { ctx.base = p; ctx.baseUnreadable = false }
    }
  }
  try {
    classifyGitArgs(ctx, seg, args, segText)
  } finally {
    if (env.length) { ctx.base = saved.base; ctx.baseUnreadable = saved.unreadable }
  }
}

function classifyGitArgs(ctx: Ctx, seg: Seg | null, args: Word[], segText: string): void {
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
    if (t === '-c' || t === '--config-env') {
      const kv = args[i + 1]?.text ?? ''
      // `-c core.worktree=<p>` moves the work tree as `--work-tree <p>` does (review 2026-11-23, third).
      if (/^core\.worktree=/i.test(kv) && args[i + 1]) {
        if (t === '-c') gwrite(valueOf(args[i + 1], kv.indexOf('=') + 1), '-c core.worktree')
        else { out.sawWrite = true; unresolved(ctx.run, 'write', 'git --config-env core.worktree', false, ctx.origText) }
      }
      // A pager or an editor named by a bare program name (`core.pager=cat`, an empty value) carries no
      // command text and is honest work; every other such setting, and a pager with an argument, a path or
      // a shell character, runs what the command carries.
      const value = kv.includes('=') ? kv.slice(kv.indexOf('=') + 1) : ''
      const bareOk = /^(?:core\.(?:pager|editor)|sequence\.editor|pager\.[^=]*)=/i.test(kv) && !/[\s\\/!;&|`$<>%]/.test(value)
      if ((GIT_RUNNING_KEY.test(kv) && !bareOk) || /\bext::/.test(kv)) {
        markSelfBuilding(ctx.run, `git -c ${kv.replace(/=.*$/s, '')}, a setting that runs a program`)
      }
      i += 2; continue
    }
    if (t.startsWith('-')) { i++; continue }
    break
  }
  const sub = (args[i]?.text ?? '').toLowerCase()
  const rest = args.slice(i + 1)
  const v = gitVerb(sub)
  // Read from the subcommand on, so a `-c` before it cannot hide a destructive command (review 2026-11-23).
  const effect = bashEffect(segText) === 'revert' ? 'revert' : bashEffect(['git', ...args.slice(i).map(w => /[\s'"]/.test(w.text) ? `"${w.text.replace(/"/g, '')}"` : w.text)].join(' '))
  if (effect === 'revert' || sub === 'rm' || (sub === 'worktree' && rest[0]?.text.toLowerCase() === 'remove')) out.gitDestructive = true
  // A command git runs for this subcommand (`rebase -x`, `filter-branch --tree-filter`, `difftool -x`,
  // `grep -O`, `submodule foreach`, `--upload-pack`): scanned as the shell text git hands to its shell.
  const runs = (text: string) => {
    out.texts.push(renderOrig(ctx.run, text))
    scanPayload(ctx.run, text, ctx.base, `${ctx.via}>git ${sub}`, ctx.depth + 1, 'shell', { dialect: 'posix', baseUnreadable: ctx.baseUnreadable })
  }
  const RUN_FLAGS: Record<string, RegExp> = {
    rebase: /^(?:-x|--exec)$/, 'filter-branch': /^--[\w-]*-filter$/, difftool: /^(?:-x|--extcmd)$/, mergetool: /^(?:-x|--extcmd)$/,
    clone: /^(?:-u|--upload-pack)$/, fetch: /^--upload-pack$/, pull: /^--upload-pack$/, 'ls-remote': /^--upload-pack$/, push: /^--receive-pack$/,
    archive: /^--exec$/,
  }

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
    const runFlag = RUN_FLAGS[sub]
    if (runFlag && runFlag.test(t) && rest[k + 1]) { runs(rest[++k].value); continue }
    const runEq = t.match(/^(--[\w-]+)=([\s\S]*)$/)
    if (runFlag && runEq && runFlag.test(runEq[1])) { runs(w.value.slice(w.value.indexOf('=') + 1)); continue }
    if (sub === 'grep' && /^(?:-O.|--open-files-in-pager=)/.test(t)) { runs(t.startsWith('-O') ? w.value.slice(2) : w.value.slice(w.value.indexOf('=') + 1)); continue }
    // `apply` / `am` `--directory`, `checkout-index --prefix`: where the files are written (review 2026-11-23).
    if ((sub === 'apply' || sub === 'am') && /^--directory=/.test(t)) { gwrite(valueOf(w, 12), sub); continue }
    if ((sub === 'apply' || sub === 'am') && t === '--directory' && rest[k + 1]) { gwrite(rest[++k], sub); continue }
    if (sub === 'checkout-index' && /^--prefix=/.test(t)) { gwrite(valueOf(w, 9), sub); continue }
    if ((sub === 'apply' || sub === 'am') && t === '--unsafe-paths') { markSelfBuilding(ctx.run, `git ${sub} --unsafe-paths, which writes wherever the patch says`); continue }
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
  if ((sub === 'branch' && flags.some(f => f === '-D' || /^-[a-zA-Z]*D/.test(f) || ((f === '-d' || f === '--delete') && flags.some(g => g === '-f' || g === '--force'))))
    || (sub === 'switch' && flags.some(f => f === '-f' || f === '--force' || f === '--discard-changes'))
    || (sub === 'checkout-index' && flags.some(f => f === '-f' || f === '--force'))) out.gitDestructive = true
  if (operands.some(w => /^ext::/i.test(w.text))) markSelfBuilding(ctx.run, `git ${sub} with an ext:: address, which runs a program`)
  if (sub === 'submodule' && operands[0]?.text.toLowerCase() === 'foreach') {
    const cmd = rest.slice(rest.indexOf(operands[0]) + 1).filter(w => !/^--(?:recursive|quiet)$/.test(w.text))
    if (cmd.length) runs(cmd.length === 1 ? cmd[0].value : cmd.map(w => w.value).join(' '))
    return
  }
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
  { re: /\bDeno\.remove(?:Sync)?\s*\(/g, kind: 'delete', style: 'args' },
  { re: /\bDeno\.rename(?:Sync)?\s*\(/g, kind: 'move', style: 'args' },
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
  { re: /\bDeno\.(?:writeTextFile|writeFile|mkdir)(?:Sync)?\s*\(/g, kind: 'write', style: 'args' },
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
  // COM's Scripting.FileSystemObject and VisualBasic's FileSystem (review 2026-11-23).
  { re: /(?:\.|::)Delete(?:Folder|File|Directory)\s*\(/gi, kind: 'delete', style: 'args' },
  { re: /(?:\.|::)Move(?:Folder|File|Directory)\s*\(/gi, kind: 'move', style: 'args' },
  { re: /(?:\.|::)Copy(?:Folder|File|Directory)\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(/gi, kind: 'shell', style: 'args' },
  { re: /\[(?:System\.)?IO\.Directory\]::SetCurrentDirectory\s*\(|\.SetLocation\s*\(|\[(?:System\.)?Environment\]::CurrentDirectory\s*=(?!=)/gi, kind: 'cd', style: 'args' },
]

/** Top-level arguments of the call whose `(` is at `open`. */
function callArgs(s: string, open: number, backslash = true): { args: string[]; end: number } {
  const args: string[] = []
  let depth = 0
  let cur = ''
  for (let k = open; k < s.length; k++) {
    const c = s[k]
    if (c === "'" || c === '"' || c === '`') {
      const e = closingQuote(s, k, backslash)
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

function splitTop(s: string, sep: string, backslash = true): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" || c === '"' || c === '`') { const e = closingQuote(s, k, backslash); cur += s.slice(k, e + 1); k = e; continue }
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

const PS_STRING_LIT = /^(?:'((?:[^']|'')*)'|"([^"`]*)")$/s

function stringValue(e: string, ps = false): string | null {
  if (ps) {
    const pm = e.match(PS_STRING_LIT)
    return pm ? (pm[1] !== undefined ? pm[1].replace(/''/g, "'") : pm[2]) : null
  }
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
  const parts = splitTop(e, '/', !run.psStrings).map(p => stripParens(p))
  if (parts.length > 1 && !stringValue(e, run.psStrings)) {
    const head = evalAtom(run, parts[0], codeBindings)
    if (head === null) return null
    const tails: string[] = []
    for (const p of parts.slice(1)) { const v = stringValue(p, run.psStrings); if (v === null) return null; tails.push(v) }
    return [head.replace(/[\\/]+$/, ''), ...tails].join('/')
  }
  return evalAtom(run, e, codeBindings)
}

function evalAtom(run: Run, a: string, codeBindings: CodeBindings): string | null {
  const s = stringValue(a, run.psStrings)
  if (s !== null) return s
  // A PowerShell cast of a literal (`[IO.DirectoryInfo]'D:\x'`) is the literal.
  const cast = run.psStrings ? a.match(/^\[[\w.]+\]\s*(['"][\s\S]*)$/) : null
  if (cast) return evalAtom(run, cast[1], codeBindings)
  if (new RegExp(`^${S0}\\d+${S1}$`).test(a)) return hasUnreadableSentinel(run, a) ? null : a
  const path = a.match(/^(?:pathlib\.)?(?:Pure)?(?:Windows|Posix)?Path\(\s*(.*?)\s*\)$/s) ?? a.match(/^Bun\.file\(\s*(.*?)\s*\)$/s)
  if (path) {
    if (path[1] === '') return '.'
    const inner = splitTop(path[1], ',', !run.psStrings)
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
  // Every row's matches first, then in the order of the text, so a folder change (`os.chdir`) holds for
  // the calls after it and only for them (review 2026-11-23). At one parenthesis the earlier row wins.
  const calls = new Map<number, { call: (typeof CODE_CALLS)[number]; at: number }>()
  for (const call of table) {
    call.re.lastIndex = 0
    for (const m of code.matchAll(call.re)) {
      const open = (m.index ?? 0) + m[0].length - 1
      if (!calls.has(open)) calls.set(open, { call, at: m.index ?? 0 })
    }
  }
  const order = [...calls.entries()].sort((a, b) => a[0] - b[0])
  for (const [n, [open, { call, at }]] of order.entries()) {
    if ((n & 31) === 31 && overBudget(run)) return
    try {
      codeCall(ctx, code, call, at, open, codeBindings)
    } catch (e) {
      run.out.faults.push(`a code call could not be read: ${(e as Error)?.message ?? String(e)}`)
    }
  }
}

function codeCall(ctx: Ctx, code: string, call: (typeof CODE_CALLS)[number], at: number, open: number, cb: CodeBindings): void {
  const run = ctx.run
  // `[Environment]::CurrentDirectory = X`: an assignment, not a call; its value is the statement's rest.
  const { args } = code[open] === '=' ? { args: [code.slice(open + 1, statementEnd(code, open + 1, false, !run.psStrings)).trim()] } : callArgs(code, open, !run.psStrings)
  // A bare `$true` (`.Delete($true)`, `::Delete('x', $true)`) is the recursive switch, not a target.
  const flagArg = (a: string) => /^\$(?:true|false)$/i.test(a)
  const positional = args.filter(a => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a) && !/^\{/.test(a) && !flagArg(a))
  const verb = code.slice(at, open).replace(/^\./, '').trim()
  const recursive = call.recursive === true || args.some(a => /\brecursive\s*[:=]\s*(?:true|True)/.test(a) || /^\$true$/i.test(a)
    || /^['"]DeleteAllContents['"]$/.test(a))
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
  return splitTop(inner, ',', !run.psStrings).filter(x => x !== '').map(x => evalExpr(run, x, cb))
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
        // The program and its argument list, or its arguments one by one (`Process::Start('cmd', '/c ...')`).
        const rest = positional[1] !== undefined ? arrayElements(run, positional[1], cb) : null
        const more = rest ?? positional.slice(1).map(a => stringValue(stripParens(a), run.psStrings)).filter((x): x is string => x !== null)
        text = more.length ? argvText([v, ...more]) : v
      }
    }
  }
  if (text === null) { markSelfBuilding(run, `${verb} with a command that cannot be read`); return }
  // `cwd=` / `{ cwd: ... }`: the folder the command starts in (review 2026-11-23). A literal is the base;
  // anything else leaves the base unreadable, so a relative target is an unresolved mutation.
  let base = ctx.base
  let baseUnreadable = ctx.baseUnreadable
  const cwdArg = args.map(a => a.match(/^cwd\s*=\s*([\s\S]+)$/)?.[1] ?? a.match(/^\{[\s\S]*?\bcwd\s*:\s*((?:'[^']*'|"[^"]*"|`[^`]*`|[^,}])+)/)?.[1]).find(x => x !== undefined)
  if (cwdArg !== undefined) {
    const v = evalExpr(run, cwdArg.trim(), cb)
    const c = v === null ? null : toPath(run, expand(run, v, ctx.base, true).text, true, ctx.base, false)
    if (c && c !== 'unreadable' && !c.children) { base = c.path; baseUnreadable = false } else baseUnreadable = true
  }
  run.out.texts.push(renderOrig(run, text))
  scanPayload(run, text, base, `${ctx.via}>${verb}`, ctx.depth + 1, 'shell', { dialect: run.platform === 'win32' ? 'cmd' : 'posix', baseUnreadable })
}

/**
 * The string literals and the anchors of a code payload. An anchor, or a literal a classified call already
 * named, is a mention. Any other literal that holds a drive, share or device spelling is a program operand
 * ('unclassified'): a call the table does not read (`x = shutil.rmtree; x('D:/x')`, `os.truncate`,
 * `zipfile...extractall`, `ctypes`, `fs['rmSync']`) is judged on the always-denied set (review 2026-11-23).
 */
function codeMentions(ctx: Ctx, code: string, classified: Set<string | null>): void {
  const run = ctx.run
  const lit = /([rRbBuU]{0,2})('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g
  for (const m of code.matchAll(lit)) {
    const v = stringValue(m[0]) ?? m[2].slice(1, -1)
    if (v === '') continue
    const w = { ...literalWord(v), raw: renderOrig(run, m[0]) }
    const x = expand(run, v, ctx.base, ctx.tilde)
    // A literal that is not anchored is read only when it can only be a path: a drive with a separator
    // (`D:\`, `C:\x`), a share, a device path, or on a POSIX host an absolute path with a name in it.
    // A separator alone, `x:` and an msys `/a/b` in code on Windows are text (a join, a label, a regex),
    // and a guess there refused honest programs (review 2026-11-23, third; corpus of past runs).
    if (x.anchor === null && !x.pipe && !codePathLiteral(run, x.text)) continue
    const c = x.pipe ? null : toPath(run, x.text, false, ctx.base, x.anchor !== null)
    if (c !== null && c !== 'unreadable') {
      const op: PathOp = x.anchor === null && !c.relative && !classified.has(c.path) ? 'unclassified' : 'mention'
      emitWord(ctx, null, w, op, { relAllowed: false, verb: op === 'unclassified' ? 'a call the scan does not read' : 'literal' })
    } else emitAbsolute(ctx, null, w, 'a call the scan does not read')
  }
  for (let k = 0; k < code.length; k++) {
    if (code[k] !== S0) continue
    const { e, end } = entryAt(run, code, k)
    if (e?.k === 'anchor') emitWord(ctx, null, { ...literalWord(code.slice(k, end)), raw: e.orig }, 'mention', { relAllowed: false, verb: 'anchor' })
    k = end - 1
  }
}

/** A code literal that can only be a path (see `codeMentions`). */
function codePathLiteral(run: Run, t: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(t) || UNC.test(t) || /^[\\/]{2}[?.][\\/]/.test(t)) return true
  if (run.platform === 'posix' && /^\/[^/\s]/.test(t)) return true
  // A drive or share spelled inside the literal (`'cmd /c rd D:\x'`) is still read, by `emitAbsolute`.
  EMBEDDED_ABS.lastIndex = 0
  const embedded = EMBEDDED_ABS.test(t)
  EMBEDDED_ABS.lastIndex = 0
  return embedded
}

// ─── Driving the scan ──────────────────────────────────────────────────────────────────────────

function newCtx(run: Run, textSub: string, origText: string, base: string, via: string, depth: number, tilde: boolean,
  o: PayloadOpts & { codeAsShell?: boolean } = {}): Ctx {
  return {
    run, textSub, base, baseUnreadable: o.baseUnreadable === true, dirStack: [], via, depth, tilde, segPaths: new Map(), segs: [], origText,
    dialect: o.dialect ?? (run.platform === 'win32' ? 'ps' : 'posix'), codeAsShell: o.codeAsShell === true,
  }
}

/** Scans one text: as shell text, as code, or both (an inline program, findings unioned). */
function scanPayload(run: Run, text: string, base: string, via: string, depth: number, mode: 'shell' | 'code' | 'both', o: PayloadOpts = {}): void {
  if (depth > MAX_DEPTH) { run.out.faults.push(`a payload nested deeper than ${MAX_DEPTH}`); return }
  if (overBudget(run)) return
  if (mode === 'shell' || mode === 'both') scanShell(run, text, base, via, depth, { ...o, codeAsShell: mode === 'both' })
  if (mode === 'code' || mode === 'both') scanCode(run, text, base, via, depth, o)
}

const TOO_LONG = `a command or program longer than ${MAX_SCANNED_TEXT / 1024} KiB once its here-strings and here-documents are set aside`

/**
 * cmd's caret outside double quotes escapes the next character and is removed (`D^:\x` is `D:\x`,
 * measured; review 2026-11-23, third). Before one of cmd's own operators it is left for the tokenizer,
 * which keeps that character as text.
 */
function stripCarets(text: string): string {
  if (!text.includes('^')) return text
  let out = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    if (c === '^' && !quoted && i + 1 < text.length && !CARET_ESCAPABLE.has(text[i + 1])) continue
    out += c
  }
  return out
}

function scanShell(run: Run, text0: string, base: string, via: string, depth: number, o: PayloadOpts & { codeAsShell: boolean }): void {
  try {
    const text = o.dialect === 'cmd' ? stripCarets(text0) : text0
    const lifted = liftBodies(run, text)
    // Measured on the text as written (a substituted name is a longer sentinel).
    const plain = renderOrig(run, lifted, true)
    if (plain.length > MAX_SCANNED_TEXT) { run.out.faults.push(TOO_LONG); return }
    markSelfBuilding(run, findMarker(plain))
    const dialect: Dialect = o.dialect ?? (run.platform === 'win32' ? 'ps' : 'posix')
    const bindings = findShellAssignments(run, lifted, dialect !== 'posix')
    const sub = substitute(run, lifted, bindings)
    // PowerShell and cmd read a backslash before a quote as an ordinary character, a POSIX shell as an
    // escape; where the text has one, both readings are taken and their findings unioned (review 2026-11-23).
    const readings = dialect === 'posix' ? [true] : /\\["$`]/.test(sub) ? [false, true] : [false]
    let first: Tok[] = []
    for (const posixQuotes of readings) {
      const toks = tokenize(sub, posixQuotes, run)
      if (first.length === 0) first = toks
      const ctx = newCtx(run, sub, plain, base, via, depth, true, { ...o, dialect })
      ctx.segs = segment(toks, sub)
      classifySegments(ctx)
      // `$(...)` inside double quotes: scanned as a nested command.
      if (!o.codeAsShell) for (const t of toks) if (t.kind === 'w') for (const s of t.subs) scanPayload(run, s, ctx.base, via, depth + 1, 'shell', { dialect, baseUnreadable: ctx.baseUnreadable })
    }
    if (o.codeAsShell) return
    const ctx = newCtx(run, sub, plain, base, via, depth, true, { ...o, dialect })
    const was = run.psStrings
    run.psStrings = dialect === 'ps'
    try {
      scanCodeCalls(ctx, sub, SHELL_CODE_CALLS, new Map())
    } finally {
      run.psStrings = was
    }
    run.sweeps.push({ ctx, toks: first })
  } catch (e) {
    run.out.faults.push(`the shell text could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

/**
 * Every quoted literal and every whole word of the text that names a drive, a share or a home or temp
 * spelling, and that nothing above named: a mention (review 2026-11-23). An assignment the scan does not
 * model (`${X} = ...`, a hashtable for splatting, a script block's argument) still leaves its literal beside
 * the mutation it feeds, so a delete through the name is judged beside it. Run once the whole command is
 * read, and only when it has an unresolved mutation: a mention counts for nothing else.
 */
function sweepLiterals(ctx: Ctx, toks: Tok[]): void {
  const run = ctx.run
  const named = new Set(run.out.paths.map(p => p.path))
  for (const t of toks) {
    if (t.kind !== 'w') continue
    const parts = t.pieces.length === 1 ? [t.pieces[0].t] : t.pieces.filter(p => p.q !== 'n').map(p => p.t)
    for (const v of parts) {
      if (v === '' || !/[\\/:~]|\u0002/.test(v)) continue
      const x = expand(run, v, ctx.base, ctx.tilde)
      if (x.here !== null && run.bodies[x.here]?.use !== 'code') {
        for (const line of hereLines(ctx, x.here)) {
          const y = expand(run, line.value, ctx.base, ctx.tilde)
          if (y.pipe || (y.anchor === null && !DRIVE_ABS.test(y.text) && !UNC.test(y.text))) continue
          const c = toPath(run, y.text, false, ctx.base, y.anchor !== null)
          if (c === null || c === 'unreadable' || named.has(c.path)) continue
          named.add(c.path)
          emit(run, { raw: line.raw, path: c.path, op: 'mention', recursive: false, children: c.children, inherited: false, anchor: y.anchor, device: c.device, verb: 'literal', via: ctx.via })
        }
        continue
      }
      if (x.pipe || x.here !== null || x.doc !== null) continue
      if (x.anchor === null && !DRIVE_ABS.test(x.text) && !UNC.test(x.text)) continue
      const c = toPath(run, x.text, false, ctx.base, x.anchor !== null)
      if (c === null || c === 'unreadable' || named.has(c.path)) continue
      named.add(c.path)
      emit(run, { raw: renderOrig(run, v), path: c.path, op: 'mention', recursive: false, children: c.children, inherited: false, anchor: x.anchor, device: c.device, verb: 'literal', via: ctx.via })
    }
  }
}

const JS_MODULES: Record<string, string> = { fs: 'fs', 'fs/promises': 'fs.promises', child_process: 'child_process' }


/**
 * The code with its import aliases spelled out, so one call table reads them all (review 2026-11-23):
 * `import shutil as sh` makes `sh.` read `shutil.`; `from shutil import rmtree` makes `rmtree(` read
 * `shutil.rmtree(`; `x = shutil.rmtree` makes `x(` read `shutil.rmtree(`; `__import__('shutil').` reads
 * `shutil.`; a module bound to a name by `require(...)` or `import * as f from ...`, and the names
 * destructured from one, the same way. All of them are applied in one pass over the code, so the cost is
 * linear in its length however many aliases it repeats (a rewrite per alias was quadratic). (This module
 * starts no process: these are table data.)
 */
function aliasCode(code0: string): string {
  const code = code0.replace(/\b__import__\(\s*['"](os|shutil|subprocess)['"]\s*\)\./g, '$1.')
  const dotted = new Map<string, string>()
  const bare = new Map<string, string>()
  const addDotted = (local: string, mod: string) => { if (local !== mod && !dotted.has(local)) dotted.set(local, mod) }
  const addBare = (local: string, full: string) => { if (!bare.has(local)) bare.set(local, full) }
  for (const m of code.matchAll(/\bimport\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/g)) {
    for (const part of m[1].split(',')) {
      const pm = part.trim().match(/^(os|shutil|subprocess)\s+as\s+([A-Za-z_]\w*)$/)
      if (pm) addDotted(pm[2], pm[1])
    }
  }
  for (const m of code.matchAll(/\bfrom\s+(os|shutil|subprocess)\s+import\s+\(?([\w\s,]+?)\)?\s*(?=$|[;\n])/gm)) {
    for (const part of m[2].split(',')) {
      const pm = part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/)
      if (pm) addBare(pm[2] ?? pm[1], `${m[1]}.${pm[1]}`)
    }
  }
  for (const m of code.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\s*=\s*((?:shutil|os|subprocess)\.\w+)\s*(?=$|[;\n])/gm)) addBare(m[1], m[2])
  const req = String.raw`require\(\s*['"](?:node:)?(fs\/promises|fs|child_process)['"]\s*\)`
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${req}`, 'g'))) addDotted(m[1], JS_MODULES[m[2]])
  for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"](?:node:)?(fs\/promises|fs|child_process)['"]/g)) addDotted(m[1], JS_MODULES[m[2]])
  const destructured = [
    ...code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${req}`, 'g')),
    ...code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s+['"](?:node:)?(fs\/promises|fs|child_process)['"]/g),
  ]
  for (const m of destructured) {
    for (const part of m[1].split(',')) {
      const pm = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*(?::|\s+as\s+)\s*([A-Za-z_$][\w$]*))?$/)
      if (!pm) continue
      if (pm[1] === 'promises') addDotted(pm[2] ?? pm[1], 'fs.promises')
      else addBare(pm[2] ?? pm[1], `${JS_MODULES[m[2]]}.${pm[1]}`)
    }
  }
  if (dotted.size === 0 && bare.size === 0) return code
  // One pass: every name followed by `.` or `(` is looked up (an alternation of the names was quadratic).
  return code.replace(/(?<![\w.$])([A-Za-z_$][\w$]*)(?=(\.)|\s*\()/g, (m: string, name: string, dot: string | undefined) => {
    if (dot !== undefined) { const mod = dotted.get(name); return mod !== undefined ? mod : m }
    return bare.get(name) ?? m
  })
}

function scanCode(run: Run, text: string, base: string, via: string, depth: number, o: PayloadOpts): void {
  try {
    if (renderOrig(run, text).length > MAX_SCANNED_TEXT) { run.out.faults.push(TOO_LONG); return }
    markSelfBuilding(run, findMarker(renderOrig(run, text)) ?? codeMarker(text))
    const sub = substitute(run, text, findShellAssignments(run, text))
    const ctx = newCtx(run, sub, renderOrig(run, text), base, via, depth, true, { dialect: 'posix', baseUnreadable: o.baseUnreadable })
    const code = aliasCode(sub)
    const cb = findCodeAssignments(run, code)
    const before = run.out.paths.length
    scanCodeCalls(ctx, code, CODE_CALLS, cb)
    codeMentions(ctx, sub, new Set(run.out.paths.slice(before).map(p => p.path)))
  } catch (e) {
    run.out.faults.push(`the inline program could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

function finish(run: Run): ShellScan {
  if (run.out.unresolvedMutation !== null) for (const s of run.sweeps) sweepLiterals(s.ctx, s.toks)
  // A scan that ran past its budget anywhere, even where no step asked, refuses the call: a reading that
  // took that long is not trusted as complete (review 2026-11-23, third).
  overBudget(run)
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
  const run = newRun(homes, platformOf(opts))
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
  const run = newRun(homes, platformOf(opts))
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
      overBudget(run)
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
    overBudget(run)
    return run.out
  } catch (e) {
    run.out.faults.push(`the argv could not be read: ${(e as Error)?.message ?? String(e)}`)
    return run.out
  }
}

