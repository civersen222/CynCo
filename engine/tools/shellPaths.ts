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
  /** A working-folder spelling (`$PWD`, `Get-Location`, `os.getcwd()`) read after a folder change the scan could not read. */
  staleBase?: true
  /** The folder a program, a script, an interpreter or git is started in (op 'unclassified'). */
  startedIn?: true
  /** A volume, disk, partition, shadow-copy or backup operation, which names no path: what it does (`deviceVerb`). */
  deviceOp?: string
}
export type ShellScan = {
  paths: ShellPath[]
  texts: string[]             // texts[0] is the input; every unwrapped payload and every here-document body is appended
  /** `code`: every unread mutation of this kind came from a call inside an inline program (the policy escalates such a write). */
  unresolvedMutation: { op: 'write' | 'delete' | 'move' | 'link'; verb: string; recursive: boolean; code?: boolean } | null
  parentClimb: number         // parent-climb tokens seen in a text that has an unresolved mutation
  selfBuilding: string | null // the marker that was found
  gitDestructive: boolean
  gitConfigWrite: string | null   // the first setting, other than user.name and user.email, a writing `git config` names
  truncated: string | null    // which limit cut the scan short
  sawWrite: boolean           // a write-class verb, a redirect or a mutating code call was seen anywhere
  faults: string[]            // caught errors and hard limits
  /**
   * Facts the policy (`protectedPaths.ts`) judges, review 2026-11-23, fourth. The scan reports them and
   * decides nothing with them.
   */
  ranProgram: boolean         // a program, a script, an interpreter or git is started, or a command the tables do not know
  /** A temp or scratch name (`TEMP`, `TMP`, `TMPDIR`, `CYNCO_SCRATCH`) is assigned somewhere in the command: what was assigned. */
  tempRedirected: string | null
  /** A program the tables do not know was handed an operand the scan cannot read: its name. */
  unreadOperand: { verb: string } | null
  /** A program was started in a folder the scan cannot read (after a `cd` it could not follow): its name. */
  unreadFolder: { verb: string } | null
  /** The shell whose text held the unread mutation, so the refusal can name the literal form in it (review 2026-11-24, seventh). */
  unreadDialect: 'ps' | 'cmd' | 'posix' | null
  /**
   * The first broker the command starts, where its program word stands: what it does (`brokerVerb`, wave 19c). The
   * scan only reports it; the paths it reads are the same either way.
   */
  broker: string | null
}
/** `drives`: the drive letters the run has a folder on (win32); a literal on another drive is never text. */
export type ScanOpts = { platform?: 'win32' | 'posix'; drives?: string[] }

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
/** Right after the pipeline's item: its leaf name (`$($_.Name)`, `$($_.BaseName)`), never a separator or `..`. */
const ITEM_LEAF = '\u0001'
/** Right after the pipeline's item: the folder it is in (`$($_.DirectoryName)`). */
const ITEM_DIR = '\u000e'
/**
 * In an expanded word: a name the command makes or an item's own name (a date, a guid, a random name, a glob's
 * match), one segment, never a separator or `..` (review 2026-11-24, eighth). A `..` written after it climbs
 * from the folder it is in.
 */
const NAME = '\u0007'
/** In an expanded word: an item at any depth under the folder before it (a recursive listing, `find`, `git ls-files`), never a climb. */
const DESC = '\u0008'
/** The segment a NAME, a DESC or a glob stands for while a word is resolved (`toPath`). */
const PLACEHOLDER = '\u0007cynco\u0007'
/**
 * Every sentinel above (`\x01` to `\x08`, `\x0e`). None may come from the input: a command or an argv holding one
 * is unreadable (wave 19, C6: `x\x02 0\x03` in the text named entry 0 of the scan's table), and a `$'...'` string
 * that decodes to one is read with a `?` in its place (`ansiCDecoded`). None of the 3,342 past calls holds one.
 */
const SENTINEL_CHARS = /[\u0001-\u0008\u000e]/
const SENTINEL_CHARS_G = /[\u0001-\u0008\u000e]/g
const SENTINEL_INPUT = 'a command holding a control character the check uses itself (\\x01 to \\x08 or \\x0e)'

/**
 * The `selfBuilding` marker of a POSIX program word named by an unquoted expansion the scan cannot read (wave 15c):
 * the shell splits it, so it may be a whole command line. Honest work meets it too (wave 19, C8): an environment
 * path such as `$VIRTUAL_ENV/bin/python` or `$JAVA_HOME/bin/java`; the path check's refusal names the rewrite.
 */
export const UNREAD_PROGRAM = 'a program named by an expansion the check cannot read, which the shell splits into the command line it runs'

const WILDCARD = /[*?[]/

// ─── The scan's shared state ───────────────────────────────────────────────────────────────────

/** unset: the right-hand side was only a name nothing set, so the name is empty too. */
/** cmdSet: made by cmd's `set X=...`, which a `%X%` on the same line does not see (cmd expands the line first). */
/** `item`: the value is an item of a literal listing or `Get-Item` (its path members read as the item; no other member does). */
/** `hash`: a table of literals (`@{ Path = '.\x'; Recurse = $true }`), each key with its value or true for a switch. */
type Binding = { pos: number; value: string | null; here: number | null; unset?: true; list?: string[]; cmdSet?: true; item?: true
  hash?: Array<[string, string | true]> }
type Entry =
  | { k: 'anchor'; anchor: Exclude<Anchor, null>; tail: string; orig: string }
  | { k: 'text'; text: string; orig: string }
  | { k: 'bound'; b: Binding; orig: string }
  | { k: 'u'; orig: string; unset?: true }   // unset: a name nothing assigned and no table knows (empty when the command runs)
  | { k: 'p'; orig: string; xargs?: true }   // xargs: a line a listing printed, put in by xargs
  | { k: 'here'; body: number; orig: string }
  | { k: 'doc'; body: number; orig: string }

/** expands: the shell runs the `$( ... )` (and in a here-document the backticks) written in it (`@"..."@`, `<<EOF`). */
type Body = { text: string; use: 'code' | 'data' | null; q?: string; expands?: true }

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
  /** The text being substituted is PowerShell's (`${...}` is a variable name there, never a POSIX expansion). */
  psText: boolean
  /** The words written after an inline program (`python -c "..." a b`), as `sys.argv[1:]` reads them; null for one not read. */
  codeArgv?: Array<string | null>
  /** The shell texts whose literals are swept once the whole command is read (`sweepLiterals`). */
  sweeps: Array<{ ctx: Ctx; toks: Tok[] }>
  /** Upper-case drive letters the run has a folder on, or null when the caller did not say (win32). */
  drives: string[] | null
  /** Per text, how often each name occurs (`scriptRunToo`). */
  nameCounts: Map<string, Map<string, number>>
  /** The path modules of the inline program being read (`pathModules`; set by `scanCode`). */
  pathMods?: { mods: Set<string>; fns: Set<string> }
  /** `countClimbs` of each text an unread mutation was found in, counted once per scan (`unresolved`). */
  climbs?: Map<string, number>
}

function newRun(homes: HomeMap, platform: Platform, drives: string[] | null = null): Run {
  return { homes, platform, table: [], bodies: [], out: emptyScan(), seen: new Set(), deadline: performance.now() + SCAN_BUDGET_MS, psStrings: false, psText: false, sweeps: [],
    drives: drives === null ? null : drives.map(d => d.slice(0, 1).toUpperCase()), nameCounts: new Map() }
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
    ranProgram: false, tempRedirected: null, unreadOperand: null, unreadFolder: null, unreadDialect: null, broker: null,
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

function unresolved(run: Run, op: MutOp, verb: string, recursive: boolean, text: string, code = false, dialect: Dialect | null = null): void {
  const cur = run.out.unresolvedMutation
  if (cur === null || MUT_RANK[op] > MUT_RANK[cur.op]) { run.out.unresolvedMutation = code ? { op, verb, recursive, code } : { op, verb, recursive }; run.out.unreadDialect = dialect }
  else if (cur.op === op) {
    // One unread mutation of this kind outside an inline program's code makes the whole kind a shell one.
    const next = { op: cur.op, verb: cur.verb, recursive: cur.recursive || recursive }
    run.out.unresolvedMutation = cur.code === true && code ? { ...next, code: true } : next
  }
  // Counted once per text: an inline program with one unread write per function asked it for every write, which made
  // the scan quadratic in the program's length (a 70 KB program ran past the time budget; ninth review).
  const known = run.climbs?.get(text)
  const n = known ?? countClimbs(text)
  if (known === undefined) (run.climbs ??= new Map()).set(text, n)
  run.out.parentClimb = Math.max(run.out.parentClimb, n)
}

/**
 * An unresolved mutation of a shell text. In the shell reading of an inline program (`ctx.codeAsShell`)
 * only a literal target counts: `md` in a regex or `mkdir` in a string is not a command there, and the code
 * table is the authority for what code does with a target it computes (review 2026-11-23, fourth).
 */
function unresolvedIn(ctx: Ctx, op: MutOp, verb: string, recursive: boolean): void {
  if (ctx.codeAsShell) return
  unresolved(ctx.run, op, verb, recursive, ctx.origText, false, ctx.dialect)
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
  // PSParentPath, Directory and DirectoryName name a parent too (review 2026-11-23, fourth).
  n += (text.match(/(?:-ExpandProperty|-Expand|-Exp|ForEach-Object|%|-MemberName)\s+['"]?(?:Parent|Root|PSDrive|PSParentPath|Directory|DirectoryName)\b/gi) ?? []).length
  // (`[IO.Directory]` is the .NET class, not a member.)
  n += (text.match(/(?<!\bIO)\.(?:root|psdrive|psparentpath|directory|directoryname)\b/gi) ?? []).length
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
  // HOMEDRIVE alone is the home's drive (wave 15: it read as a name nothing set, the root of the current drive);
  // with HOMEPATH after it, it is the home (`hd` below).
  SYSTEMDRIVE: 'systemdrive', HOMEDRIVE: 'systemdrive',
  ONEDRIVE: 'onedrive', ONEDRIVECONSUMER: 'onedrive', ONEDRIVECOMMERCIAL: 'onedrive',
  PUBLIC: 'public',
  PROGRAMDATA: 'programdata', ALLUSERSPROFILE: 'programdata',
}
const USER_NAMES = new Set(['USERNAME', 'USER', 'LOGNAME'])
/** Environment variables Windows (or the run's environment) defines for every process: never an undefined `%X%`. */
const WINDOWS_ENV_NAMES = /^(?:PATH|PATHEXT|WINDIR|SYSTEMROOT|COMSPEC|PROGRAMFILES|PROGRAMW6432|COMMONPROGRAMFILES\w*|PSMODULEPATH|PROCESSOR_\w+|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|USERDOMAIN\w*|LOGONSERVER|DRIVERDATA|SESSIONNAME|PYTHON\w*|GIT_\w+|CYNCO_\w+|LOCALCODE_\w+)$/i

const OS_MOD = String.raw`(?:(?:require\(\s*['"](?:node:)?os['"]\s*\)|\bos)\.)?`
// `(?!\w)` first: a name may not stop short of its end to dodge the assignment test (`$env:GIT` of
// `$env:GITX=`, review 2026-11-23).
const NOT_ASSIGN = String.raw`(?!\w)(?!\s*[-+*/]?=(?!=))`
/** A PowerShell variable's scope prefix (`$script:X`, `${global:X}`). */
const PS_SCOPE = String.raw`(?:script|global|local|private|using|variable):`

/**
 * Every spelling the substitution pass replaces, in the order they are tried. Each alternative has
 * its own named groups; the callback below reads which one matched.
 */
const SUBST_PARTS: Array<[string[], string]> = [
  // `[IO.Path]::Combine(a, b, ...)`, folded as Join-Path is over the parts it reads (review 2026-11-24, seventh).
  [['combine'], String.raw`(?<comb>\[(?:System\.)?IO\.Path\]::Combine\s*\((?<combArgs>[^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\))`],
  [['homedrive'], String.raw`(?<hd>(?:\$env:HOMEDRIVE|\$\{env:HOMEDRIVE\}|%HOMEDRIVE%)(?:\$env:HOMEPATH|\$\{env:HOMEPATH\}|%HOMEPATH%))`],
  [['getfolderpath'], String.raw`(?<gfp>(?:\[(?:System\.)?Environment\]::)?GetFolderPath\s*\((?<gfpArg>[^()]*(?:\([^()]*\)[^()]*)*)\))`],
  [['getenvironmentvariable'], String.raw`(?<gev>(?:\[(?:System\.)?Environment\]::)?GetEnvironmentVariable\s*\(\s*['"](?<gevN>\w+)['"][^()]*\))`],
  [['gettemppath'], String.raw`(?<tmpp>(?:\[(?:System\.)?IO\.Path\]::)?GetTempPath\s*\(\s*\))`],
  // `$(Get-Location)` as well as `(Get-Location)`: the `$` is part of the spelling, never a literal `$` left in
  // front of the anchor (review 2026-11-23, fourth).
  [['resolve-path'], String.raw`(?<rp>\$?\(\s*Resolve-Path\s+~\s*\)(?:\.Path)?)`],
  [['get-location'], String.raw`(?<gl>\$?\(\s*Get-Location\s*\)(?:\.Path)?)`],
  [['pwd'], String.raw`(?<pwds>\$\(\s*pwd\s*\))`],
  [['environ'], String.raw`(?<envi>(?:\bos\.)?\benviron(?:\[\s*(?<eq1>['"])(?<en1>\w+)\k<eq1>\s*\]${NOT_ASSIGN}|\.get\(\s*(?<eq2>['"])(?<en2>\w+)\k<eq2>\s*(?:,[^()]*)?\)))`],
  [['process.env'], String.raw`(?<penv>\bprocess\.env(?:\.(?<pe1>\w+)|\[\s*['"](?<pe2>\w+)['"]\s*\])${NOT_ASSIGN})`],
  [['bun.env'], String.raw`(?<benv>\bBun\.env\.(?<be>\w+))`],
  [['deno.env'], String.raw`(?<denoenv>\bDeno\.env\.get\(\s*['"](?<dne>\w+)['"]\s*\))`],
  [['getenv'], String.raw`(?<genv>(?:\bos\.)?\bgetenv\(\s*['"](?<ge>\w+)['"]\s*(?:,[^()]*)?\))`],
  [['$env{'], String.raw`(?<plenv>\$ENV\{(?<pl>\w+)\})`],
  [['env['], String.raw`(?<rbenv>\bENV\[\s*['"](?<rb>\w+)['"]\s*\])`],
  [['${env:'], String.raw`(?<denv>\$\{env:(?<de>\w+)\}${NOT_ASSIGN})`],
  [['$env:'], String.raw`(?<psenv>\$env:(?<pse>\w+)${NOT_ASSIGN})`],
  [['env:'], String.raw`(?<psdrv>(?<![\w$:])Env:\\?(?<pd>\w+))`],
  // A POSIX default (`${X:-}`, `${X:=dir}`): the name when it is set, the default when it is not.
  // A POSIX array or indirect expansion (`${a[@]}`, `${!x}`, `${#x}`): a text the scan does not compute.
  [['${'], String.raw`(?<parr>\$\{[!#]?[A-Za-z_]\w*(?:\[[^\]]*\])?\}(?<=\[[^\]]*\]\}|\{[!#][A-Za-z_]\w*\}))`],
  [['${'], String.raw`(?<pdef>\$\{(?<pdn>[A-Za-z_]\w*):?[-=](?<pdd>[^}]*)\})`],
  [['${'], String.raw`(?<brace>\$\{(?:${PS_SCOPE})?(?<br>\w+)\}${NOT_ASSIGN})`],
  // Every other POSIX expansion of a name (`${X#p}`, `${X%p}`, `${X/a/b}`, `${X:+v}`, `${X:1}`): a text the
  // scan does not compute, empty when the name is unset (review 2026-11-23, fourth).
  [['${'], String.raw`(?<pop>\$\{(?<pon>[A-Za-z_]\w*)(?<poo>:?\+|##?|%%?|\/\/?|\^\^?|,,?|:\??|\?)[^}]*\})`],
  [['$'], String.raw`(?<item>\$(?:_|PSItem)(?!\w))`],
  [['$'], String.raw`(?<keep>\$(?:null|true|false)(?!\w))`],
  // `$env:X=` (an assignment, which psenv leaves alone) is not the variable `$env`.
  // The members written after it are captured (`dvm`): a member of a bound value is read below, never glued on as text.
  [['$'], String.raw`(?<dvar>\$(?!env:)(?:${PS_SCOPE})?(?<dv>[A-Za-z_]\w*)${NOT_ASSIGN}(?<dvm>(?:\.[A-Za-z_]\w*(?![\w(]))*)(?<dmc>\.(?<dmn>Replace|Substring|Remove|TrimEnd|TrimStart|Trim|ToLower|ToUpper|ToLowerInvariant|ToUpperInvariant|Insert)\((?<dma>\s*(?:'[^'\n]*'|"[^"$\x60\n]*"|-?\d+)(?:\s*,\s*(?:'[^'\n]*'|"[^"$\x60\n]*"|-?\d+))*\s*|\s*)\))?)`],
  // A splat (`Remove-Item @p`, `cmd @a`): the table or list bound to the name (review 2026-11-24, sixth).
  [['@'], String.raw`(?<splat>(?<![\w@.$'"])@(?<spn>[A-Za-z_]\w*)(?![\w({]))`],
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
  [['temp(', 'temporary'], String.raw`(?<mktmp>(?:\btempfile\.)?\b(?:mk[sd]?temp|NamedTemporaryFile|TemporaryDirectory|SpooledTemporaryFile|TemporaryFile)\([^()]*\))`],
  [['getcwd', 'process.cwd'], String.raw`(?<gcwd>\bos\.getcwd\(\s*\)|\bprocess\.cwd\(\s*\))`],
  [['getuser', 'getlogin'], String.raw`(?<guser>\bgetpass\.getuser\(\s*\)|\bos\.getlogin\(\s*\))`],
]

const substCache = new Map<string, RegExp>()

/**
 * The substitution pattern for one text: only the spellings whose fixed part the text contains, so a long
 * text with none of them is not tried at every position against all of them (review 2026-11-23, cost).
 */
/**
 * PowerShell's `${...}`: a variable whose name is any text up to `}` (`${x-y}`, `${a.b}`, `${a b}`, measured), with
 * a scope or `env:` before it; never a POSIX default or substitution (review 2026-11-24, seventh, P6). Tried first,
 * in PowerShell text only.
 */
const PS_BRACED = String.raw`(?<psb>\$\{(?<psbn>[^}\n]+)\}${NOT_ASSIGN})`

/** Whether `at` lies inside a single-quoted stretch of a PowerShell text (`''` is a quote inside one). */
let singleQuoteCache: { text: string; ranges: Array<[number, number]> } | null = null
function insideSingleQuotes(text: string, at: number): boolean {
  // The ranges of one text are found once (a walk per match was quadratic in a long text).
  if (singleQuoteCache === null || singleQuoteCache.text !== text) {
    const ranges: Array<[number, number]> = []
    for (let k = 0; k < text.length; k++) {
      const c = text[k]
      if (c === '`') { k++; continue }
      if (c === '"') { k = closingQuote(text, k, false); continue }
      if (c !== "'") continue
      let e = k + 1
      while (e < text.length && !(text[e] === "'" && text[e + 1] !== "'")) e += text[e] === "'" ? 2 : 1
      ranges.push([k, e])
      k = e
    }
    singleQuoteCache = { text, ranges }
  }
  const r = singleQuoteCache.ranges
  let lo = 0
  let hi = r.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (r[mid][1] < at) lo = mid + 1
    else if (r[mid][0] > at) hi = mid - 1
    else return true
  }
  return false
}

/**
 * Whether `at` lies in the plain text of a double-quoted stretch of a PowerShell text, outside any `$( ... )` in it.
 * There `"$n.md"` expands `$n` and keeps `.md` as text: a member is read only inside a subexpression (review
 * 2026-11-24, eighth: `".\docs\$n.md"` in a loop over names was read as a member of `$n` and refused).
 */
let doubleQuoteCache: { text: string; ranges: Array<[number, number]> } | null = null
function inDoubleQuotedText(text: string, at: number): boolean {
  if (doubleQuoteCache === null || doubleQuoteCache.text !== text) {
    const ranges: Array<[number, number]> = []
    for (let k = 0; k < text.length; k++) {
      const c = text[k]
      if (c === '`') { k++; continue }
      if (c === "'") { let e = k + 1; while (e < text.length && !(text[e] === "'" && text[e + 1] !== "'")) e += text[e] === "'" ? 2 : 1; k = e; continue }
      if (c !== '"') continue
      let start = k + 1
      let e = k + 1
      for (; e < text.length; e++) {
        const d = text[e]
        if (d === '`') { e++; continue }
        if (d === '"') { if (text[e + 1] === '"') { e++; continue } break }
        if (d === '$' && text[e + 1] === '(') {
          ranges.push([start, e])
          e = matchParen(text, e + 1)
          start = e + 1
        }
      }
      ranges.push([start, e])
      k = e
    }
    doubleQuoteCache = { text, ranges }
  }
  const r = doubleQuoteCache.ranges
  let lo = 0
  let hi = r.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (r[mid][1] < at) lo = mid + 1
    else if (r[mid][0] > at) hi = mid - 1
    else return true
  }
  return false
}

/**
 * Whether what follows a name at `at` is text, not a member: in a POSIX shell (no members), in the plain text of a
 * double-quoted string, and in a bare word that does not start with the name (`out\f$i.txt` and `out/${n}.md` are
 * expanded like `"out\f$i.txt"`), as PowerShell reads them (review 2026-11-24, eighth).
 */
function textAfterName(run: Run, text: string, at: number): boolean {
  if (!run.psText) return true
  if (at > 0 && /[\w\\/.~-]/.test(text[at - 1])) return true
  return inDoubleQuotedText(text, at)
}

/** `${C:\path} = ...`: an assignment through the FileSystem provider, a write of that file (P7). */
const PS_FILE_VARIABLE = /(^|[\s;{(|&])\$\{((?:[A-Za-z]:|\\\\|(?:Microsoft\.PowerShell\.Core\\)?FileSystem::)[^}\n]*)\}\s*[-+*/]?=(?!=)/gi

function substRe(text: string, ps = false): RegExp | null {
  const lower = text.toLowerCase()
  const parts: string[] = []
  let key = ps ? 'ps,' : ''
  if (ps && lower.includes('${')) { parts.push(PS_BRACED); key += 'psb,' }
  for (const [k, [triggers, source]] of SUBST_PARTS.entries()) {
    if (!triggers.some(t => lower.includes(t))) continue
    // The POSIX forms of `${...}` are not read in PowerShell text.
    if (ps && triggers.length === 1 && triggers[0] === '${') continue
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
    if (n > 1) return unionBinding(list, n)
    return list[0]
  }
  return undefined
}

/**
 * A name assigned more than once (`$f = 'a'; Remove-Item $f; $f = 'b'; Remove-Item $f`): every value it ever
 * held, as a list, so each use is judged on all of them whatever the order, inside loops and conditions too
 * (review 2026-11-24, seventh, P13: it was unreadable, and every reuse of a name refused). Null when one of
 * the values cannot be read (`+=`, a here-string, a value the scan does not read). Made once per count.
 */
const unions = new WeakMap<Binding[], Map<number, Binding | null>>()
function unionBinding(list: Binding[], n: number): Binding | null {
  let byN = unions.get(list)
  if (byN === undefined) { byN = new Map(); unions.set(list, byN) }
  const had = byN.get(n)
  if (had !== undefined) return had
  const values: string[] = []
  let item = true
  let made: Binding | null = null
  for (let k = 0; k < n; k++) {
    const b = list[k]
    if (b.unset || b.here !== null || b.hash !== undefined) { values.length = 0; break }
    if (b.list !== undefined) values.push(...b.list)
    else if (b.value !== null) values.push(b.value)
    else { values.length = 0; break }
    if (!b.item) item = false
  }
  if (values.length > 0 && values.length <= MAX_LOOP_ELEMENTS) made = { pos: list[0].pos, value: null, here: null, list: values, ...(item ? { item: true as const } : {}) }
  byN.set(n, made)
  return made
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
  // A shell variable nothing in the text set (`$tmp`, `${temp}`, POSIX `$tmp`) is not the environment variable
  // of that name: only PowerShell's fixed variables (`$HOME`, `$PWD`) and a POSIX name spelled exactly upper
  // case (`$TMPDIR`, `$HOME`) are read as their folder (review 2026-11-24, sixth: a payload's `$tmp = "$HOME\.cache"`
  // the scan did not see was read as the sandbox's temp folder).
  if (keyOrder === 'var' && !PS_FIXED.has(upper) && name !== upper) return unknown === 'u' ? sentinel(run, { k: 'u', orig, unset: true }) : orig
  // `$PID`, the shell's own process id: a number, a name with no separator (review 2026-11-24, eighth).
  if (keyOrder === 'var' && upper === 'PID') return sentinel(run, { k: 'text', text: NAME, orig })
  const anchor = ANCHOR_NAMES[upper]
  if (anchor) return anchorEntry(run, anchor, orig)
  if (USER_NAMES.has(upper)) return sentinel(run, { k: 'text', text: run.homes.user, orig })
  return unknown === 'u' ? sentinel(run, { k: 'u', orig, unset: true }) : orig
}

function substitute(run: Run, text: string, bindings: Bindings, offset = 0, limit = Infinity): string {
  const re = substRe(text, run.psText)
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
    if (g('psb') !== undefined) {
      // Inside single quotes PowerShell expands nothing: left as written for the payload's own shell to read.
      const at0 = rest[rest.length - 3] as number
      if (insideSingleQuotes(text, at0)) return m
      let name = g('psbn') ?? ''
      // A POSIX expansion PowerShell cannot have meant: of a name a POSIX loop or assignment bound (`for f in *.bak; do
      // mv "$f" "${f%.bak}"`) where PowerShell has no variable of that whole name, or with a colon after a name no
      // PowerShell drive or provider has (`${OUT:-build}`, `${UNSET:-}`, which fail there): read as a POSIX shell
      // reads it. A one-letter drive (`${d:-x}`) and a name PowerShell set are PowerShell's.
      const posix = name.match(/^([A-Za-z_]\w*)(?::?[-=+?]|##?|%%?|\/\/?|\^\^?|,,?|:\d)/)
      const noDrive = posix !== null && /^\w+:/.test(name) && posix[1].length > 1 && !/^(?:function|alias|variable|hk\w+|cert|wsman|filesystem)$/i.test(posix[1])
      if (posix && bindingAt(bindings, [name.toLowerCase()], pos, limit) === undefined
        && (noDrive || bindingAt(bindings, [posix[1].toLowerCase()], pos, limit) !== undefined)) {
        run.psText = false
        try { return substitute(run, m, bindings, pos, limit) } finally { run.psText = true }
      }
      const scope = name.match(/^(?:script|global|local|private|using|variable):/i)
      if (scope) name = name.slice(scope[0].length)
      if (/^env:/i.test(name)) return envName(run, bindings, name.slice(4), pos, m, 'env', 'u', limit)
      // `${C:\x}`, `${Function:f}`: an item of a provider, its content, never a path. A drive PowerShell does not
      // have (`${UNSET:-}`) is empty when the command runs: a name nothing set.
      if (name.includes(':')) return sentinel(run, /^(?:[A-Za-z]|function|alias|variable|hk\w+|cert|wsman|filesystem|microsoft\.powershell\.core\\filesystem):/i.test(name) ? { k: 'u', orig: m } : { k: 'u', orig: m, unset: true })
      const at = rest[rest.length - 3] as number
      const tail = textAfterName(run, text, at) ? null : text.slice(at + m.length, at + m.length + 256).match(/^(?:\[[^\]\n]*\])?((?:\.[A-Za-z_]\w*)+)(\()?/)
      if (tail) {
        const b = bindingAt(bindings, [name.toLowerCase()], pos, limit)
        const own = tail[2] === undefined && b !== null && b !== undefined && b.item === true && tail[1].split('.').filter(Boolean).every(x => PATH_MEMBERS.has(x.toLowerCase()))
        if (!own) return sentinel(run, { k: 'u', orig: m })
      }
      return envName(run, bindings, name, pos, m, 'var', 'u', limit)
    }
    if (g('comb') !== undefined) {
      // Each part a literal or one spelling the scan reads; a part that starts at a root starts over, as .NET's
      // Combine does. Anything else cannot be read.
      const inner = substitute(run, g('combArgs') ?? '', bindings, pos, limit)
      const parts = splitTop(inner, ',', false).map(x => x.trim())
      const vals = parts.map((x, k) => stringValue(x, true) ?? (new RegExp(`^${S0}\\d+${S1}$`).test(x) && !hasUnreadableSentinel(run, x) ? x : k > 0 ? madeLeaf(x) : null))
      if (vals.length === 0 || vals.some(v => v === null || v.includes(UNREAD))) return sentinel(run, { k: 'u', orig: m })
      let joined = ''
      for (const v of vals as string[]) joined = joined === '' || /^(?:[\\/]|[A-Za-z]:|\u0002)/.test(v) ? v : `${joined.replace(/[\\/]+$/, '')}\\${v.replace(/^[\\/]+/, '')}`
      return sentinel(run, { k: 'bound', b: { pos, value: joined, here: null }, orig: m })
    }
    if (g('hd') !== undefined) return anchorEntry(run, 'home', m)
    if (g('gfp') !== undefined) {
      const arg = g('gfpArg') ?? ''
      if (/LocalApplicationData/i.test(arg)) return anchorEntry(run, 'localappdata', m)
      if (/ApplicationData/i.test(arg)) return anchorEntry(run, 'appdata', m)
      return anchorEntry(run, 'home', m)
    }
    if (g('gev') !== undefined) return envName(run, bindings, g('gevN') ?? '', pos, m, 'env', 'u', limit)
    // .NET's GetTempPath() ends with a separator, so `GetTempPath() + 'x'` is a file in the temp folder.
    if (g('tmpp') !== undefined) return anchorEntry(run, 'temp', m, '\\')
    if (g('otmp') !== undefined || g('gtmp') !== undefined || g('mktmp') !== undefined) return anchorEntry(run, 'temp', m)
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
      // A default that holds another expansion (`${X-$HOME/.ssh}`) is that expansion, read the same way
      // (review 2026-11-23, fourth); a backtick or a `%` in it is not read.
      if (/[`%]/.test(dflt)) return sentinel(run, { k: 'u', orig: m })
      if (dflt.includes('$')) return sentinel(run, { k: 'bound', b: { pos, value: substitute(run, dflt, bindings, pos, limit), here: null }, orig: m })
      return sentinel(run, { k: 'text', text: dflt, orig: m })
    }
    if (g('parr') !== undefined) return sentinel(run, { k: 'u', orig: m })
    if (g('brace') !== undefined) {
      // `${t}.Parent.FullName`, `${a}[0].PSDrive.Root`: a member of the braced name, read as the dotted form is.
      const at = rest[rest.length - 3] as number
      const tail = textAfterName(run, text, at) ? null : text.slice(at + m.length, at + m.length + 256).match(/^(?:\[[^\]\n]*\])?((?:\.[A-Za-z_]\w*)+)(\()?/)
      if (tail) {
        const b = bindingAt(bindings, [(g('br') ?? '').toLowerCase()], pos, limit)
        const own = tail[2] === undefined && b !== null && b !== undefined && b.item === true && tail[1].split('.').filter(Boolean).every(x => PATH_MEMBERS.has(x.toLowerCase()))
        if (!own) return sentinel(run, { k: 'u', orig: m })
      }
      return envName(run, bindings, g('br') ?? '', pos, m, 'var', 'u', limit)
    }
    if (g('pop') !== undefined) {
      const name = g('pon') ?? ''
      const bound = bindingAt(bindings, [name.toLowerCase()], pos, limit)
      // A suffix or prefix taken off a name bound to relative values that never climb (`${f%.json}` of
      // `for f in out/*.json`): a name inside the working folder (review 2026-11-24, sixth).
      const vals = bound ? (bound.list ?? (bound.value !== null ? [bound.value] : null)) : null
      if (bound && /^:?\?$/.test(g('poo') ?? '') && /^\$\{[A-Za-z_]\w*:?\?\}$/.test(m)) return sentinel(run, { k: 'bound', b: bound, orig: m })
      if (vals !== null && /^(?:#|##|%|%%)$/.test(g('poo') ?? '') && vals.every(v => !v.includes(S0) && !v.includes(UNREAD) && !/^(?:[\\/]|[A-Za-z]:|~)/.test(v) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v))) {
        return sentinel(run, { k: 'text', text: `./${DESC}`, orig: m })
      }
      const set = bindingAt(bindings, [name.toLowerCase(), `env:${name.toLowerCase()}`], pos, limit) !== undefined || ANCHOR_NAMES[name.toUpperCase()] !== undefined
      return set ? sentinel(run, { k: 'u', orig: m }) : sentinel(run, { k: 'u', orig: m, unset: true })
    }
    if (g('denoenv') !== undefined) return envName(run, bindings, g('dne') ?? '', pos, m, 'env', 'u', limit)
    if (g('item') !== undefined) return sentinel(run, { k: 'p', orig: m })
    if (g('keep') !== undefined) return m
    if (g('splat') !== undefined) {
      const b = bindingAt(bindings, [(g('spn') ?? '').toLowerCase()], pos, limit)
      return b === undefined ? m : sentinel(run, b === null ? { k: 'u', orig: m } : { k: 'bound', b, orig: m })
    }
    if (g('dvar') !== undefined) {
      const name = g('dv') ?? ''
      // `$ExecutionContext.InvokeProvider...` is read as the call it is (`SHELL_CODE_CALLS`), not as a value.
      if (/^ExecutionContext$/i.test(name)) return m
      const members = g('dvm') ?? ''
      const at = rest[rest.length - 3] as number
      // In the plain text of a double-quoted string only the name is expanded: what follows it (`.md`, `.Replace(`)
      // is text (review 2026-11-24, eighth).
      // So it is in a bare word that does not start with the name (`out\f$i.txt` is expanded like `"out\f$i.txt"`),
      // and in a POSIX shell, which has no members at all.
      if ((members !== '' || g('dmc') !== undefined) && textAfterName(run, text, at)) {
        const bare = `$${g('dv') ?? ''}`
        const scopeLen = m.indexOf(bare) >= 0 ? m.indexOf(bare) + bare.length : bare.length
        return envName(run, bindings, name, pos, m.slice(0, scopeLen), 'var', 'u', limit) + m.slice(scopeLen)
      }
      const after = text.slice(at + m.length, at + m.length + 256)
      // `$PWD.Path` and `$PWD.ProviderPath` are the working folder itself (review 2026-11-24, sixth: the member
      // was glued on as a sibling folder's name).
      if (name.toUpperCase() === 'PWD' && /^\.(?:Path|ProviderPath)$/i.test(members) && g('dmc') === undefined) return anchorEntry(run, 'cwd', m)
      // A method called on the variable (`$p.Replace('a', 'b')`): over a literal it is the text it makes; any
      // other method or receiver cannot be read, and neither can an index then a member (`$a[0].Parent`).
      const bound = bindingAt(bindings, PS_FIXED.has(name.toUpperCase()) ? [] : [name.toLowerCase()], pos, limit)
      if (g('dmc') !== undefined) {
        // A chain after it (`$p.ToUpper().Replace(...)`) is not followed: the whole cannot be read.
        // On a list PowerShell runs the method on every element (measured): the list it makes (review 2026-11-24, seventh, P8).
        if (bound && bound.list !== undefined && !bound.item && members === '' && !/^\.[A-Za-z_]/.test(after)) {
          const each = bound.list.map(el => methodValue(run, { pos: bound.pos, value: el, here: null }, g('dmn') ?? '', g('dma') ?? ''))
          return each.every((x): x is string => x !== null) ? sentinel(run, { k: 'bound', b: { pos: bound.pos, value: null, here: null, list: each }, orig: m }) : sentinel(run, { k: 'u', orig: m })
        }
        const made = bound && members === '' && !/^\.[A-Za-z_]/.test(after) ? methodValue(run, bound, g('dmn') ?? '', g('dma') ?? '') : null
        return made !== null ? sentinel(run, { k: 'text', text: made, orig: m }) : sentinel(run, { k: 'u', orig: m })
      }
      // Another method of a text (an item's own methods, `.MoveTo(`, `.Delete(`, are read as code calls).
      if (/^\.[A-Za-z_]\w*\(/.test(after) && !(bound && bound.item)) return sentinel(run, { k: 'u', orig: m })
      const idx = after.match(/^\[[^\]\n]*\]((?:\.[A-Za-z_]\w*)+)/)
      if (members === '' && idx) {
        const b = bindingAt(bindings, [name.toLowerCase()], pos, limit)
        const own = b !== null && b !== undefined && b.item === true && idx[1].split('.').filter(Boolean).every(x => PATH_MEMBERS.has(x.toLowerCase()))
        if (!own) return sentinel(run, { k: 'u', orig: m })
      }
      if (members === '') return envName(run, bindings, name, pos, m, 'var', 'u', limit)
      const bare = m.slice(0, m.length - members.length)
      const b = bindingAt(bindings, PS_FIXED.has(name.toUpperCase()) ? [] : [name.toLowerCase()], pos, limit)
      // Nothing bound it: the member stays as written, as before.
      if (b === undefined) return envName(run, bindings, name, pos, bare, 'var', 'u', limit) + members
      // A member of a bound value (review of wave 5: `$v = Get-Item .; Remove-Item $v.Parent.FullName` read
      // `.Parent.FullName` as a file name in the folder): only an item's own path is the item; any other member,
      // and any member of a text, names something the scan cannot read.
      // `$paths.Values` of a table of literals: the list of its values (review 2026-11-24, eighth, C3).
      if (b !== null && b.hash !== undefined && /^\.Values$/i.test(members)) {
        const vals = b.hash.map(([, v]) => v).filter((v): v is string => v !== true)
        return vals.length ? sentinel(run, { k: 'bound', b: { pos: b.pos, value: null, here: null, list: vals }, orig: m }) : sentinel(run, { k: 'u', orig: m })
      }
      // An item's leaf name (`$f.Name`, `$f.BaseName`): one name, never a separator or `..` (review 2026-11-24, eighth).
      if (b !== null && b.item === true && /^\.(?:Name|BaseName)$/i.test(members)) return sentinel(run, { k: 'text', text: NAME, orig: m })
      const own = b !== null && b.item === true && members.split('.').filter(Boolean).every(x => PATH_MEMBERS.has(x.toLowerCase()))
      return own ? envName(run, bindings, name, pos, m, 'var', 'u', limit) : sentinel(run, { k: 'u', orig: m })
    }
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
      // A name set only on this same line, and never before it, is not defined when cmd reads the line, and cmd
      // leaves `%X%` as written: a folder named `%X%` (review 2026-11-24, seventh: `set OUT=dist&& rd /s /q %OUT%`
      // was refused as a target it could not read).
      // Not after `call` or with delayed expansion (`/v:on`), which read the line again, not in `%%X%%`, and not for a
      // name Windows defines in every environment (`%windir%`).
      const line = text.slice(lineStart - offset, text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at))
      if (sameLineSet && bindingAt(bindings, [`env:${name.toLowerCase()}`, name.toLowerCase()], pos, Math.min(limit, lineStart)) === undefined
        && ANCHOR_NAMES[name.toUpperCase()] === undefined && !USER_NAMES.has(name.toUpperCase()) && !WINDOWS_ENV_NAMES.test(name)
        && text[at - 1] !== '%' && !/\bcall\b|\/v(?::on)?\b/i.test(line)) return sentinel(run, { k: 'text', text: m, orig: m })
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

/**
 * A string method called on a variable bound to a literal (`$p.Replace('proj\x', '.cache')`, `.TrimEnd('x')`,
 * `.Substring(0, 11)`), with literal arguments: the text it makes, which is then judged like any spelling
 * (review 2026-11-24, sixth). Null for a value that is not a literal, or any other method.
 */
function methodValue(run: Run, b: Binding, method: string, argText: string): string | null {
  // A list (`$t = '.\a','D:\DCIM'`) is not one text: the method runs on every element (review 2026-11-24, seventh, P8).
  if (b.value === null || b.list !== undefined || b.value.includes(S0) || b.value.includes(UNREAD) || b.item) return null
  const v = b.value
  const args = argText.trim() === '' ? [] : splitTop(argText, ',', false).map(a => {
    const t = a.trim()
    return /^-?\d+$/.test(t) ? Number(t) : stringValue(t, true)
  })
  if (args.some(a => a === null)) return null
  const str = (k: number) => (typeof args[k] === 'string' ? args[k] as string : null)
  const num = (k: number) => (typeof args[k] === 'number' ? args[k] as number : null)
  const trimSet = (x: string, chars: string | null, end: boolean, start: boolean) => {
    const set = chars === null ? null : new Set(chars)
    const hit = (c: string) => (set === null ? /\s/.test(c) : set.has(c))
    let a = 0; let z = x.length
    if (start) while (a < z && hit(x[a])) a++
    if (end) while (z > a && hit(x[z - 1])) z--
    return x.slice(a, z)
  }
  switch (method.toLowerCase()) {
    case 'replace': return str(0) !== null && str(1) !== null && str(0) !== '' ? v.split(str(0) as string).join(str(1) as string) : null
    case 'substring': { const a = num(0); const n = num(1); return a === null ? null : n === null ? v.slice(a) : v.slice(a, a + n) }
    case 'remove': { const a = num(0); const n = num(1); return a === null ? null : n === null ? v.slice(0, a) : v.slice(0, a) + v.slice(a + n) }
    case 'trimend': return args.length <= 1 ? trimSet(v, str(0), true, false) : null
    case 'trimstart': return args.length <= 1 ? trimSet(v, str(0), false, true) : null
    case 'trim': return args.length <= 1 ? trimSet(v, str(0), true, true) : null
    case 'tolower': case 'tolowerinvariant': return v.toLowerCase()
    case 'toupper': case 'toupperinvariant': return v.toUpperCase()
    case 'insert': { const a = num(0); const t = str(1); return a === null || t === null ? null : v.slice(0, a) + t + v.slice(a) }
    default: return null
  }
}

// ─── (c2) Single-assignment constant propagation ──────────────────────────────────────────────

/** The end of the statement that starts at `i`: the first `;`, newline, `|`, `}` or `)` outside quotes and brackets. */
function statementEnd(s: string, i: number, stopAtSpace: boolean, backslash = true): number {
  let depth = 0
  let last = ''
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === "'" || c === '"' || c === '`') {
      const k = closingQuote(s, j, backslash)
      j = k
      last = c
      continue
    }
    if (c === S0) { const k = s.indexOf(S1, j); j = k < 0 ? s.length : k; last = S1; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; last = c; continue }
    if ((c === ')' || c === ']' || c === '}') && depth > 0) { depth--; last = c; continue }
    if (depth > 0) continue
    // PowerShell goes on reading a list on the next line after a trailing comma (review 2026-11-23, fourth).
    if (c === '\n' && last === ',' && !stopAtSpace) continue
    if (c !== ' ' && c !== '\t' && c !== '\r') last = c
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
const PS_MEMBER_ASSIGN = /(^|[\s;{(|&])\$([A-Za-z_]\w*)\s*(?:\[[^\]\n]*\]|\.[A-Za-z_]\w*)+\s*[-+*/]?=(?!=)/g
const PS_ASSIGN = /(^|[\s;{(|&=])(?:\[[^\]\n]+\]\s*)*\$(?:\{(env:|(?:script|global|local|private|using|variable):)?([^}:\n]+)\}|(env:|(?:script|global|local|private|using|variable):)?([A-Za-z_]\w*))\s*([-+*/]?)=(?!=)/gi
/**
 * The variable provider and `Get-Variable` change a variable the way an assignment does (review 2026-11-24,
 * seventh, P7): `Set-Item variable:t ...`, `New-Item variable:t`, `(Get-Variable t).Value = ...`, `Get-Variable t |
 * % { $_.Value = ... }`. What they assign is not read: the name becomes unreadable.
 */
const PS_VARIABLE_WRITES = [
  /(?:^|[\s;&|(\n{])(?:Set-Item|si|New-Item|ni|Clear-Item|cli|Copy-Item|cpi|Move-Item|mi|Rename-Item|rni)\b[^;|\n]*?(?<![\w$])variable:\\?([A-Za-z_]\w*)/gi,
  /\(\s*(?:Get-Variable|gv)\s+(?:-Name\s+)?['"]?([A-Za-z_]\w*)['"]?[^)]*\)\.Value\s*[-+*/]?=(?!=)/gi,
  /(?:Get-Variable|gv)\s+(?:-Name\s+)?['"]?([A-Za-z_]\w*)['"]?[^;\n|]*\|[^;\n]*\.Value\s*[-+*/]?=(?!=)/gi,
]
const POSIX_ASSIGN = /(^|[\s;&|(\n])(export\s+)?([A-Za-z_]\w*)=/g
/** `$a, $b = ...`: a multiple assignment (review 2026-11-24, eighth). */
const PS_MULTI_ASSIGN = /(^|[\s;{(|&])((?:\$(?:(?:script|global|local|private):)?[A-Za-z_]\w*\s*,\s*)+\$(?:(?:script|global|local|private):)?[A-Za-z_]\w*)\s*=(?!=)/gi
/** The parameters that name a path, for a key of `$PSDefaultParameterValues`. */
const DEFAULT_PATH_PARAMS = ['path', 'literalpath', 'pspath', 'lp', 'destination', 'dest', 'destinationpath', 'filepath', 'outfile', 'newname',
  'target', 'value', 'outputdirectory', 'workingdirectory', 'argumentlist', 'stackname']
/** The common parameters that set a variable, and their aliases. */
const VARIABLE_PARAMS = ['outvariable', 'pipelinevariable', 'errorvariable', 'warningvariable', 'informationvariable']
const VARIABLE_PARAM_ALIASES: Record<string, string> = { ov: 'outvariable', pv: 'pipelinevariable', ev: 'errorvariable', wv: 'warningvariable', iv: 'informationvariable' }

/**
 * The names that hold the same table or list as another (`$q = $p`), each mapped to its whole set, so a member or
 * index assignment through one changes them all (review 2026-11-24, eighth).
 */
function aliasSets(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const m of text.matchAll(/(?:^|[\s;{(|&])\$([A-Za-z_]\w*)\s*=\s*\$([A-Za-z_]\w*)\s*(?=[;\n}|)]|$)/g)) {
    const a = m[1].toLowerCase()
    const b = m[2].toLowerCase()
    const set = new Set([...(out.get(a) ?? [a]), ...(out.get(b) ?? [b])])
    for (const n of set) out.set(n, set)
  }
  return out
}
/** cmd's quoted `set "X=value"`. */
const CMD_SET_QUOTED = /(^|[\s;&|(\n])set\s+"([A-Za-z_]\w*)=([^"\n]*)"/gi
/** `Set-Variable -Name X -Value V`, `New-Variable X V`, `sv X V`: the value as written. */
const PS_SET_VARIABLE = /(^|[\s;&|(\n{])(?:Set-Variable|New-Variable|sv|nv)\b([^;|\n}]*)/gi
const CODE_ENV_ASSIGN = /(?:\bos\.environ\[\s*['"](\w+)['"]\s*\]|\bprocess\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\]))\s*=(?!=)/g
const PS_PARAM = /\bparam\s*\(([^)]*)\)/gi
const LOOP_VARS = [
  /\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b/gi,
  /(?:^|[\s;&|(\n])for\s+([A-Za-z_]\w*)\s+in\b/g,
  PS_PARAM,
  // POSIX `read [-r] NAME` (a `while read` loop): a value the scan cannot read, not a name nothing set.
  /(?:^|[\s;&|(\n])read\s+(?:-[A-Za-z]+\s+)*([A-Za-z_]\w*)/g,
]

/**
 * The functions a PowerShell text defines (`function Clear-Out([string]$p) { ... }`, `function F { param($a, $b) ... }`)
 * whose every call in the text passes only literal words (`Clear-Out .\out`, `F -b x 'y'`): each parameter with the
 * values its calls give it. A function called with anything else, or used other than by its name at the head of a
 * statement, is left out, so its parameters stay unreadable (review 2026-11-24, eighth, C7).
 */
function functionParams(text: string): Array<{ at: number; paramAt: number | null; names: string[]; values: string[][] }> {
  const out: Array<{ at: number; paramAt: number | null; names: string[]; values: string[][] }> = []
  for (const m of text.matchAll(/(^|[\s;{])function\s+([A-Za-z_][\w-]*)\s*(?:\(([^()]*)\))?\s*\{/gi)) {
    const at = (m.index ?? 0) + m[1].length
    const open = (m.index ?? 0) + m[0].length - 1
    let depth = 0
    let close = text.length
    for (let k = open; k < text.length; k++) {
      const c = text[k]
      if (c === "'" || c === '"') { k = closingQuote(text, k, false); continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) { close = k; break }
    }
    const body = text.slice(open + 1, close)
    const pm = m[3] === undefined ? body.match(/^\s*param\s*\(([^()]*)\)/i) : null
    const decl = m[3] ?? pm?.[1] ?? null
    if (decl === null) continue
    const names = [...decl.matchAll(/\$([A-Za-z_]\w*)/g)].map(x => x[1].toLowerCase())
    if (names.length === 0 || names.length > 8) continue
    const fname = m[2]
    const esc = fname.replace(/[-]/g, '\\-')
    const values: string[][] = names.map(() => [])
    let ok = true
    let calls = 0
    // Every other mention of the name must be a call at the head of a statement after the body.
    for (const c of text.matchAll(new RegExp(`(^|[^\\w$-])${esc}(?![\\w-])`, 'gi'))) {
      const i = (c.index ?? 0) + c[1].length
      if (i >= at && i <= close) continue
      if (i < close || !/(?:^|[;\n{]|&&|\|\|)\s*$/.test(text.slice(Math.max(0, i - 64), i))) { ok = false; break }
      const end = statementEnd(text, i + fname.length, false, false)
      const toks = tokenize(text.slice(i + fname.length, end), false)
      let pos = 0
      for (let k = 0; k < toks.length && ok; k++) {
        const t = toks[k]
        if (t.kind !== 'w' || t.subs.length) { ok = false; break }
        const raw = t.pieces.map(x => x.t).join('')
        if (t.pieces[0].q === 'n' && /^-[A-Za-z]/.test(raw)) {
          const pn = raw.slice(1).toLowerCase()
          const idx = names.findIndex(n => n.startsWith(pn))
          const v = toks[k + 1]
          if (idx < 0 || v === undefined || v.kind !== 'w') { ok = false; break }
          const vr = v.pieces.map(x => x.t).join('')
          if (!literalArg(v, vr)) { ok = false; break }
          values[idx].push(vr); k++
          continue
        }
        if (!literalArg(t, raw) || pos >= names.length) { ok = false; break }
        values[pos++].push(raw)
      }
      calls++
    }
    if (!ok || calls === 0 || values.some(v => v.length > MAX_LOOP_ELEMENTS)) continue
    out.push({ at, paramAt: pm ? open + 1 + (pm.index ?? 0) + pm[0].indexOf('param') : null, names, values })
  }
  return out
}

/** A function argument the scan reads as written: quoted with nothing to expand, or a bare word of path characters. */
function literalArg(t: WordTok, raw: string): boolean {
  if (t.subs.length || raw.includes('$') || raw.includes('`')) return false
  if (t.pieces.every(p => p.q === 's' || (p.q === 'd' && !p.t.includes('$')))) return true
  return t.pieces.length === 1 && /^[\w.\\/:-]+$/.test(raw) && !raw.startsWith('-')
}

/** Reads every shell assignment of a text once (finding 2.M1 part 1). */
function findShellAssignments(run: Run, text: string, psText = false): Bindings {
  // `temp`: the assignment sets a temp or scratch name in its own dialect (`tempAssignment`).
  const found: Array<{ key: string; pos: number; rhs: string; rhsAt: number; dialect: 'ps' | 'posix' | 'code'; cmdSet?: true; item?: string
    loop?: { src: string; at: number; dialect: 'ps' | 'posix' }; temp?: true; unbound?: true; items?: string[] }> = []
  let depth: ((pos: number) => number) | null = null
  for (const m of text.matchAll(PS_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, false, !psText)
    const env = (m[2] ?? m[4])?.toLowerCase() === 'env:'
    const key = `${env ? 'env:' : ''}${(m[3] ?? m[5]).toLowerCase()}`
    const temp = env && TEMP_NAMES.has((m[3] ?? m[5]).toUpperCase()) ? { temp: true as const } : {}
    // A chained assignment (`$X = $Y = 'v'`) binds both names to the last value.
    // `$i += 1`: a counter stays a number, a name with no separator (review 2026-11-24, eighth); any other
    // compound assignment is not read.
    let rhs = m[6] ? (/^\s*-?\d+\s*$/.test(text.slice(start, end)) ? COUNTER : '\u0000') : text.slice(start, end)
    let rhsAt = start
    for (let guard = 0; guard < 8; guard++) {
      const chain = rhs.match(/^\s*\$(?:\{[^}]*\}|[\w:]+)\s*=(?!=)/)
      if (!chain) break
      rhs = rhs.slice(chain[0].length); rhsAt += chain[0].length
    }
    // A home or temp name assigned inside a block, a condition or a group (`if ($false) { $env:USERPROFILE
    // = ... }`, `$false -and ($env:USERPROFILE = ...)`) may never run: the name stays the real folder
    // (review 2026-11-23, third). Nothing else is judged by where it is assigned. A temp name assigned there
    // may run too: its value is still judged (`tempAssignment`), only never bound.
    if (ANCHOR_NAMES[(m[3] ?? m[5]).toUpperCase()]) {
      depth ??= depthIndex(text, psText)
      if (depth((m.index ?? 0) + m[1].length) > 0) {
        if (env && TEMP_NAMES.has((m[3] ?? m[5]).toUpperCase())) found.push({ key: `\u0000unbound:${key}`, pos: (m.index ?? 0) + m[1].length, rhs, rhsAt, dialect: 'ps', temp: true, unbound: true })
        continue
      }
    }
    found.push({ key, pos: (m.index ?? 0) + m[1].length, rhs, rhsAt, dialect: 'ps', ...temp })
  }
  // `$v[0] = ...`, `$v.Path = ...`: the variable no longer holds the value it was bound to (review of wave 5), and
  // neither does any name that holds the same table or list (`$q = $p; $q.Path = ...` changes `$p`: eighth review).
  const aliases = psText ? aliasSets(text) : new Map<string, Set<string>>()
  for (const m of text.matchAll(PS_MEMBER_ASSIGN)) {
    const at = (m.index ?? 0) + m[1].length
    for (const n of aliases.get(m[2].toLowerCase()) ?? [m[2].toLowerCase()]) found.push({ key: n, pos: at, rhs: '\u0000', rhsAt: 0, dialect: 'ps' })
  }
  if (psText) {
    // `$a, $b = 'x', 'y'`: each name its element; `$first, $rest = Get-ChildItem x`: items of the listing; any other
    // right-hand side leaves every name unreadable (review 2026-11-24, eighth: only the last name was seen).
    for (const m of text.matchAll(PS_MULTI_ASSIGN)) {
      const names = [...m[2].matchAll(/\$(?:(?:script|global|local|private):)?([A-Za-z_]\w*)/gi)].map(x => x[1].toLowerCase())
      const start = (m.index ?? 0) + m[0].length
      const end = statementEnd(text, start, false, false)
      const rhs = text.slice(start, end)
      const pos = (m.index ?? 0) + m[1].length
      const src = itemSourceValues(rhs.trim())
      const elems = splitTop(rhs, ',', false)
      let off = start
      const at: number[] = []
      for (const e of elems) { at.push(off + (e.length - e.trimStart().length)); off += e.length + 1 }
      names.forEach((n, k) => {
        if (n === 'null') return
        if (src !== null) { found.push({ key: n, pos, rhs: '\u0000', rhsAt: 0, dialect: 'ps', ...(src.length > 1 ? { items: src } : { item: src[0] }) }); return }
        const one = elems.length === names.length && elems[k].trim() !== '' ? elems[k].trim() : null
        found.push({ key: n, pos, rhs: one ?? '\u0000', rhsAt: one !== null ? at[k] : 0, dialect: 'ps' })
      })
    }
    // `$PSDefaultParameterValues` supplies any parameter a command does not spell (measured: `['Resolve-Path:Path']`
    // makes a bare `Resolve-Path` resolve it): a write to it that names a path parameter, or one the scan cannot read,
    // builds what the later commands touch (review 2026-11-24, eighth). Preferences (`'*:Encoding'`) are not paths.
    for (const m of text.matchAll(/\$(?:(?:script|global|local):)?PSDefaultParameterValues\b/gi)) {
      const at = (m.index ?? 0) + m[0].length
      const stmt = text.slice(at, statementEnd(text, at, false, false))
      if (!/^\s*(?:\[[^\]\n]*\]\s*)?[-+]?=(?!=)|^\s*\.\s*(?:Add|set_Item|Item)\b/i.test(stmt)) continue
      const keys = [...stmt.matchAll(/['"]([^'"\n]*:[^'"\n]*)['"]\s*(?:\]\s*)?[=,]/g)].map(k => (k[1].split(':').pop() ?? '').trim().toLowerCase())
      if (keys.length === 0 || keys.some(pn => pn === '' || /[*?[]/.test(pn) || DEFAULT_PATH_PARAMS.some(x => x.startsWith(pn) || pn.startsWith(x)))) {
        markSelfBuilding(run, '$PSDefaultParameterValues, which supplies a parameter a later command does not spell')
      }
    }
    // A name handed by reference (`[ref]$t`) may be changed through the reference: unreadable from there on.
    for (const m of text.matchAll(/\[ref\]\s*\$([A-Za-z_]\w*)/gi)) found.push({ key: m[1].toLowerCase(), pos: m.index ?? 0, rhs: '\u0000', rhsAt: 0, dialect: 'ps' })
    // `$ExecutionContext.SessionState.PSVariable.Set('c', ...)` sets the name it is given; a name it computes cannot be read.
    for (const m of text.matchAll(/\.PSVariable\.(?:Set|Add|Remove)\s*\(\s*(['"]?)([^'",)\s]*)\1/gi)) {
      if (m[1] !== '' && /^[A-Za-z_]\w*$/.test(m[2])) found.push({ key: m[2].toLowerCase(), pos: m.index ?? 0, rhs: '\u0000', rhsAt: 0, dialect: 'ps' })
      else markSelfBuilding(run, 'a variable set through PSVariable with a name the check cannot read')
    }
    // The common parameters that set a variable (`-OutVariable t`, `-ov:t`, `-ov +t`, `-ErrorVariable e`, `-wv w`, `-iv i`,
    // `-pv p`, by any prefix): what an item source hands on for -OutVariable and -PipelineVariable, unreadable otherwise
    // (review 2026-11-24, eighth: the glued and the appending forms were not seen, and an earlier literal stood).
    for (const m of text.matchAll(/(^|[\s(])-([A-Za-z]{2,})(?::\s*|\s+)(\+?)([A-Za-z_]\w*)/g)) {
      const pn = m[2].toLowerCase()
      const full = VARIABLE_PARAM_ALIASES[pn] ?? VARIABLE_PARAMS.find(v => v.startsWith(pn) && pn.length >= 3)
      if (full === undefined) continue
      const at = (m.index ?? 0) + m[1].length
      let from = at
      while (from > 0 && !';\n|{('.includes(text[from - 1])) from--
      const stmt = text.slice(from, at) + ' ' + text.slice(at + m[0].length - m[1].length, statementEnd(text, at + m[0].length - m[1].length, false, false))
      const src = full === 'outvariable' || full === 'pipelinevariable' ? itemSourceValues(stmt.trim()) : null
      found.push({ key: m[4].toLowerCase(), pos: at, rhs: '\u0000', rhsAt: 0, dialect: 'ps', ...(src === null ? {} : src.length > 1 ? { items: src } : { item: src[0] }) })
    }
  }
  if (psText) {
    for (const re of PS_VARIABLE_WRITES) {
      for (const m of text.matchAll(re)) found.push({ key: m[1].toLowerCase(), pos: m.index ?? 0, rhs: '\u0000', rhsAt: 0, dialect: 'ps' })
    }
  }
  for (const m of text.matchAll(CMD_SET_QUOTED)) {
    const at = (m.index ?? 0) + m[0].indexOf('"')
    found.push({ key: m[2].toLowerCase(), pos: (m.index ?? 0) + m[1].length, rhs: `"${m[3]}"`, rhsAt: at, dialect: 'ps', cmdSet: true,
      ...(TEMP_NAMES.has(m[2].toUpperCase()) ? { temp: true as const } : {}) })
  }
  for (const m of text.matchAll(PS_SET_VARIABLE)) {
    // `Set-Variable @sv`: the name and the value come in through a splat (review 2026-11-24, eighth).
    if (/(?:^|\s)@[A-Za-z_]\w*/.test(m[2])) { markSelfBuilding(run, 'a variable set through a splat'); continue }
    const all = tokenize(m[2])
    const args = all.filter((t): t is WordTok => t.kind === 'w').map(t => ({ t, text: t.pieces.map(p => p.t).join('') }))
    let name: string | null = null
    let value: WordTok | null = null
    // `-Value (...)`: a value the scan cannot read, never the first word inside the group (review 2026-11-23, fourth).
    let groupValue = false
    const pos: WordTok[] = []
    for (let k = 0; k < args.length; k++) {
      const lower = args[k].text.toLowerCase()
      if (/^-n(?:a(?:me?)?)?$/.test(lower) && args[k + 1]) { name = args[++k].text; continue }
      if (/^-v(?:a(?:l(?:ue?)?)?)?$/.test(lower)) {
        const after = all[all.indexOf(args[k].t) + 1]
        if (after?.kind === 'op' && ['(', '$(', '@('].includes(after.op)) { groupValue = true; continue }
        if (args[k + 1]) { value = args[++k].t; continue }
      }
      if (lower.startsWith('-')) continue
      pos.push(args[k].t)
    }
    if (name === null && pos[0]) name = pos.shift()!.pieces.map(p => p.t).join('')
    if (value === null && pos[0] && !groupValue) value = pos[0]
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
    const isSet = /(?:^|[\s;&|("'])set\s+$/i.test(text.slice(Math.max(0, at - 16), at))
    const cmdSet = isSet ? { cmdSet: true as const } : {}
    // POSIX sets a temp name only spelled upper case (`TMPDIR=`); cmd's `set` in any case. `tmp=` is a variable.
    const temp = (isSet ? TEMP_NAMES.has(m[3].toUpperCase()) : TEMP_NAMES.has(m[3])) ? { temp: true as const } : {}
    found.push({ key, pos: at, rhs: text.slice(start, end), rhsAt: start, dialect: 'posix', ...cmdSet, ...temp })
  }
  for (const m of text.matchAll(CODE_ENV_ASSIGN)) {
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(text, start, false)
    const name = m[1] ?? m[2] ?? m[3] ?? ''
    const key = `env:${name.toLowerCase()}`
    found.push({ key, pos: m.index ?? 0, rhs: text.slice(start, end), rhsAt: start, dialect: 'code', ...(TEMP_NAMES.has(name.toUpperCase()) ? { temp: true as const } : {}) })
  }
  // A function defined in the command and called with literal arguments only: each parameter is the list of what
  // its calls pass, by position or by name (review 2026-11-24, eighth, C7). Its `param(...)` is then not read again.
  const boundParams = new Set<number>()
  if (psText) for (const fn of functionParams(text)) {
    if (fn.paramAt !== null) boundParams.add(fn.paramAt)
    for (const [k, n] of fn.names.entries()) {
      const vals = fn.values[k]
      const src = vals.length ? vals.map(v => `'${v.replace(/'/g, "''")}'`).join(',') : ''
      found.push({ key: n, pos: fn.at, rhs: '\u0000', rhsAt: 0, dialect: 'ps', ...(src !== '' ? { loop: { src, at: 0, dialect: 'ps' as const } } : {}) })
    }
  }
  // Loop and parameter variables hold a value the scan cannot read, but they are not empty: bound,
  // unreadable (a leading unset name is read as empty, review 2026-11-23).
  for (const re of LOOP_VARS) {
    for (const m of text.matchAll(re)) {
      if (re === PS_PARAM && boundParams.has(m.index ?? -1)) continue
      const names = re === PS_PARAM ? [...m[1].matchAll(/\$([A-Za-z_]\w*)/g)].map(x => x[1]) : [m[1]]
      // `foreach ($d in Get-ChildItem build)`: each item is inside the folder listed (review 2026-11-23, fourth).
      let item: string | null = null
      let items: string[] | null = null
      // The loop's own list (review 2026-11-24, sixth): `foreach ($d in 'build','dist')`, `@(...)`, a range, a
      // variable bound to a list; a POSIX `for d in build dist`. Each element is judged where the variable is used.
      let loop: { src: string; at: number; dialect: 'ps' | 'posix' } | null = null
      if (re === LOOP_VARS[0]) {
        const from = (m.index ?? 0) + m[0].length
        const close = matchParen(text, text.lastIndexOf('(', from))
        const srcItems = itemSourceValues(text.slice(from, close).trim().replace(/^\(([\s\S]*)\)$/, '$1'))
        // `foreach ($d in Get-ChildItem .\a,.\b)`: each folder's items (review 2026-11-24, seventh, P9).
        if (srcItems !== null && srcItems.length > 1) items = srcItems
        else item = srcItems?.[0] ?? null
        if (item === null && items === null) loop = { src: text.slice(from, close), at: from, dialect: 'ps' }
      } else if (re === LOOP_VARS[1]) {
        const from = (m.index ?? 0) + m[0].length
        const end = text.slice(from).search(/[;\n]|\bdo\b/)
        loop = { src: text.slice(from, end < 0 ? text.length : from + end), at: from, dialect: 'posix' }
      } else if (re === LOOP_VARS[LOOP_VARS.length - 1]) {
        // `LISTING | while read f; do ...`: each line the listing prints (`listingSource`).
        const at = (m.index ?? 0) + m[0].indexOf('read')
        const w = text.slice(Math.max(0, at - 256), at).match(/\|\s*while\s+(?:[A-Za-z_]\w*=\S*\s+){0,4}$/)
        if (w) {
          const pipe = at - w[0].length
          let from = pipe - 1
          while (from >= 0 && from > pipe - 1024 && !';\n|&'.includes(text[from])) from--
          if (from >= 0 && from > pipe - 1024 || from < 0) loop = { src: `$(${text.slice(from + 1, pipe).trim()})`, at: from + 1, dialect: 'posix' }
        } else if (/(?:^|[\s;&|(\n])while\s+(?:[A-Za-z_]\w*=\S*\s+){0,4}$/.test(text.slice(Math.max(0, at - 256), at))) {
          // `while read f; do ...; done < <(LISTING)`: the listing fed in by a process substitution (review
          // 2026-11-24, seventh), read as `LISTING | while read f` is.
          const fed = /\bdone\s*<\s*<\(/g
          fed.lastIndex = at
          const d = fed.exec(text)
          if (d !== null && d.index - at < 4096) {
            const open = d.index + d[0].length - 1
            const close = matchParen(text, open)
            if (close < text.length) loop = { src: `$(${text.slice(open + 1, close).trim()})`, at: open + 1, dialect: 'posix' }
          }
        }
      }
      for (const n of names) found.push({ key: n.toLowerCase(), pos: m.index ?? 0, rhs: '\u0000', rhsAt: 0, dialect: 'ps', ...(item !== null ? { item } : {}), ...(items !== null ? { items } : {}), ...(loop !== null ? { loop } : {}) })
    }
  }
  found.sort((a, b) => a.pos - b.pos)
  const bindings: Bindings = new Map()
  for (const [fi, f] of found.entries()) {
    if ((fi & 63) === 63 && overBudget(run)) break
    const b: Binding = { pos: f.pos, value: null, here: null, ...(f.cmdSet ? { cmdSet: true as const } : {}) }
    if (!f.unbound) {
      const list = bindings.get(f.key) ?? []
      list.push(b)
      bindings.set(f.key, list)
    }
    bindValue(run, f, b, bindings)
    if (f.temp) tempAssignment(run, b, text.slice(f.pos, Math.min(text.length, f.pos + 120, statementEnd(text, f.rhsAt || f.pos, false, !psText))))
  }
  return bindings
}

/** The right-hand side recorded for a counter's `+= 1` (`findShellAssignments`). */
const COUNTER = '\u0000counter'

/** The temp and scratch names, as their environment variables are spelled. */
const TEMP_NAMES = new Set(['TEMP', 'TMP', 'TMPDIR', 'CYNCO_SCRATCH'])

/**
 * A temp or scratch name assigned in its own dialect (`$env:TEMP =`, POSIX `TMPDIR=`, cmd `set TMP=`, code's
 * `os.environ['TMP'] =`; review 2026-11-24, seventh, policy item 4). A use of that name later in the same text
 * reads the value it was given (the binding), so it is judged where it lands. What reads the name without the
 * binding (a program started afterwards, `GetTempPath()`, `tempfile.gettempdir()`) cannot follow it, so the
 * assignment is reported (`tempRedirected`, judged by RS3) unless its value is read and stays in a folder
 * of this run: a temp or scratch folder, the working folder, a relative path that does not climb.
 */
function tempAssignment(run: Run, b: Binding, orig: string): void {
  if (run.out.tempRedirected !== null) return
  if (!safeTempValue(run, b, 0)) run.out.tempRedirected = renderOrig(run, orig).trim()
}

function safeTempValue(run: Run, b: Binding, depth: number): boolean {
  if (depth > 8 || b.unset || b.here !== null || b.list !== undefined || b.hash !== undefined || b.value === null) return false
  const v = b.value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  if (v === '' || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v)) return false
  const head = v.match(new RegExp(`^${S0}(\\d+)${S1}`))
  if (head) {
    const e = run.table[Number(head[1])]
    const rest = v.slice(head[0].length)
    if (rest.includes(S0) || (rest !== '' && !/^[\\/]/.test(rest))) return false
    if (e?.k === 'anchor') return (e.anchor === 'temp' || e.anchor === 'scratch' || e.anchor === 'cwd') && !e.tail.includes('..')
    if (e?.k === 'bound') return safeTempValue(run, e.b, depth + 1)
    return false
  }
  // A literal: relative, and inside the working folder.
  return !v.includes(S0) && !v.includes(UNREAD) && !v.includes(EMPTY_SUB) && !/^(?:[\\/]|[A-Za-z]:|~|%|\$)/.test(v)
}

/** The value one assignment binds (`findShellAssignments`). */
function bindValue(run: Run, f: { key: string; pos: number; rhs: string; rhsAt: number; dialect: 'ps' | 'posix' | 'code'; item?: string; items?: string[]
  loop?: { src: string; at: number; dialect: 'ps' | 'posix' } }, b: Binding, bindings: Bindings): void {
  if (f.item !== undefined) { b.value = f.item; b.item = true; return }
  if (f.items !== undefined) { b.list = f.items; b.item = true; return }
  if (f.loop !== undefined) {
    const src = f.loop.src.trim()
    const lead = f.loop.src.length - f.loop.src.trimStart().length
    const sub = substitute(run, src, bindings, f.loop.at + lead, f.pos)
    // `foreach ($x in $list)` with `$list = Get-ChildItem .\out`: each element is an item of the listing, whose own path
    // members read as the item (review 2026-11-24, eighth, C3).
    const only = f.loop.dialect === 'ps' ? sub.trim().match(new RegExp(`^${S0}(\\d+)${S1}$`)) : null
    const e = only ? run.table[Number(only[1])] : null
    if (e?.k === 'bound' && e.b.item) {
      if (e.b.list !== undefined) b.list = e.b.list; else b.value = e.b.value
      if (b.list !== undefined || b.value !== null) b.item = true
      return
    }
    const list = loopList(run, sub, f.loop.dialect)
    if (list !== null) b.list = list
    return
  }
  if (f.rhs === '\u0000') return
  if (f.rhs === COUNTER) { b.value = NAME; return }
  const lead = f.rhs.length - f.rhs.trimStart().length
  // Only the assignments made before this one count for its right-hand side.
  const rhsSub = substitute(run, f.rhs.trim(), bindings, f.rhsAt + lead, f.pos)
  if (f.dialect === 'ps') {
    const h = hashValue(rhsSub, run)
    if (h !== null) { b.hash = h; return }
    // `$dirs = @('build', 'dist')`: the list (review 2026-11-24, sixth).
    if (/^@\(/.test(rhsSub.trim())) { const l = loopList(run, rhsSub, 'ps'); if (l !== null) { b.list = l; return } }
    // `$names = (Get-ChildItem .\out -Filter *.tmp).Name`: the leaf names of a listing (review 2026-11-24, eighth).
    const names = rhsSub.trim().match(/^\(([\s\S]*)\)\.(?:Name|BaseName)$/i)
    if (names && matchParen(rhsSub.trim(), 0) === rhsSub.trim().length - names[0].length + names[1].length + 1 && itemSourceValues(names[1]) !== null) { b.list = [NAME]; return }
  }
  const made = f.dialect === 'code' ? null : madeValue(run, rhsSub, f.dialect)
  if (made !== null) { b.value = made.value; if (made.item) b.item = true; return }
  // `$stamp = Get-Date -Format yyyyMMdd`, `$ts = [DateTime]::Now.ToString('yyyyMMddHHmmss')`, `$n = Get-Random`: a
  // name the command makes (review 2026-11-24, eighth: the value was unread, and a write through it refused).
  const madeName = f.dialect === 'ps' ? madeKind(rhsSub.trim()) : null
  if (madeName !== null) { b.value = madeName; return }
  let v = f.dialect === 'code' ? evalExpr(run, rhsSub, new Map()) : shellRhsValue(run, rhsSub, f.dialect)
  // `$t = Get-Item x`, `$d = Get-ChildItem build`: the item, or an item inside the folder (review 2026-11-23, fourth).
  if (v === null && f.dialect === 'ps') {
    const items = itemSourceValues(rhsSub)
    if (items !== null && items.length > 1) { b.list = items; b.item = true; return }
    v = items?.[0] ?? newItemValue(run, rhsSub)
    if (v !== null) b.item = true
  }
  if (v && typeof v === 'object') {
    if ('here' in v) { b.here = v.here; b.value = null } else { b.unset = true; b.value = null }
  } else b.value = v
  // A PowerShell list (`$a = 'x','D:\DCIM'`): every element, so `$a[1]` or `$a` is judged on each of them,
  // never on the first one alone (review 2026-11-23, third).
  if (f.dialect === 'ps') {
    const list = listElements(rhsSub)
    if (list !== null) b.list = list
  }
  // `$dir = "data\teams\$t"` inside `foreach ($t in 'north','west')`: one value per element of the list the name holds
  // (review 2026-11-24, eighth, C3).
  if (b.list === undefined && b.value !== null && !b.item) {
    const inner = listInside(run, b.value)
    if (inner !== null && inner.list.length <= MAX_LOOP_ELEMENTS) { const v0 = b.value; b.list = inner.list.map(x => v0.split(inner.at).join(x)); b.value = null }
  }
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
  // A group that only makes a name (`'report-{0}.md' -f (Get-Date -Format yyyyMMdd)`, `'save-' + (Get-Date ...) + '.json'`)
  // is that name, a literal for the expression around it (review 2026-11-24, eighth, C6).
  if (dialect === 'ps' && rhs.includes('(')) rhs = madeGroupsAsText(rhs)
  const toks = dialect === 'ps' ? joinCommaToks(tokenize(rhs, false)) : tokenize(rhs, true)
  // `'{0}:\{1}' -f 'D', 'DCIM'` and `'D:' + '\DCIM'` over literals: the text they make (review 2026-11-23, fourth).
  if (dialect === 'ps' && toks.length > 1 && toks.every(t => t.kind === 'w')) {
    const made = wordsExpression(toks as WordTok[])
    if (made === null || made.subs.length) return null
    const v = made.pieces.map(p => p.t).join('')
    return hasUnreadableSentinel(run, v) || v.includes(UNREAD) ? null : v
  }
  if (toks.length !== 1 || toks[0].kind !== 'w') return null
  const w = toks[0]
  const value = w.pieces.map(p => p.t).join('')
  // `"$env:TEMP\run-$(Get-Date -Format yyyyMMdd).log"`: a name made by a date, a guid or a counter, after the
  // last separator, is a name inside that folder (review 2026-11-24, sixth); any other subexpression is not read.
  if (w.subs.length) {
    // Each made name is a NAME (or DESC) in the value (`subValue`); anything else left an UNREAD.
    if (value.includes(UNREAD) || value.includes(EMPTY_SUB) || hasUnreadableSentinel(run, value)) return null
    return value
  }
  const only = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  if (only) {
    const e = run.table[Number(only[1])]
    if (e?.k === 'here') return { here: e.body }
    if ((e?.k === 'u' && e.unset) || (e?.k === 'bound' && e.b.unset)) return { unset: true }
  }
  // An unquoted PowerShell right-hand side that is not a variable is a command, not a value; a number is a value
  // (`$i = 0`, review 2026-11-24, eighth).
  if (dialect === 'ps' && w.pieces[0].q === 'n' && !w.pieces[0].t.startsWith(S0) && !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  if (hasUnreadableSentinel(run, value)) return null
  return value
}

/** Every top-level group of a PowerShell text that only makes a name, written as a quoted NAME (or DESC) instead. */
function madeGroupsAsText(text: string): string {
  let out = ''
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (c === "'" || c === '"') { const e = closingQuote(text, k, false); out += text.slice(k, e + 1); k = e; continue }
    const open = c === '(' ? k : c === '$' && text[k + 1] === '(' ? k + 1 : -1
    if (open < 0) { out += c; continue }
    const close = matchParen(text, open)
    const kind = close < text.length ? madeKind(text.slice(open + 1, close)) : null
    if (kind === null) { out += c; continue }
    out += `'${kind}'`
    k = close
  }
  return out
}

/** An anchor's sentinel in a substituted text, when the text is only that (`$env:TEMP`, `"$env:CYNCO_SCRATCH"`). */
function onlyAnchor(run: Run, s: string, anchors: Anchor[]): string | null {
  const m = s.trim().replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1').replace(/^(['"])([\s\S]*)\1$/, '$2').match(new RegExp(`^${S0}(\\d+)${S1}[\\\\/]?$`))
  if (!m) return null
  const e = run.table[Number(m[1])]
  return e?.k === 'anchor' && anchors.includes(e.anchor) && e.tail.replace(/[\\/]/g, '') === '' ? `${S0}${m[1]}${S1}` : null
}

/**
 * The value of a right-hand side the shell makes rather than spells (review 2026-11-24, sixth): a new item in
 * the temp folder (`$(mktemp)`, `$(mktemp -d)`, `[IO.Path]::GetTempFileName()`, `New-TemporaryFile`), a name
 * made inside the temp or scratch folder (`Join-Path $env:TEMP ([guid]::NewGuid())`), the working folder's
 * repository root (`git rev-parse --show-toplevel`: a mission is never a subfolder of a repository), the
 * folder of a literal (`Split-Path .\out\a.txt`). Null for anything else.
 */
function madeValue(run: Run, rhs: string, dialect: 'ps' | 'posix'): { value: string; item?: true } | null {
  const s = rhs.trim()
  const temp = (orig: string) => anchorEntry(run, 'temp', orig, `\\${NAME}`)
  if (/^(["']?)(?:\$\(\s*mktemp(?:\s+-[dtuq]+)*(?:\s+[\w.X-]+)?\s*\)|`\s*mktemp(?:\s+-[dtuq]+)*(?:\s+[\w.X-]+)?\s*`)\1$/.test(s)) return { value: temp('$(mktemp)') }
  const mk = mktempValue(run, s)
  if (mk !== null) return { value: mk === 'temp' ? temp('$(mktemp)') : mk }
  if (dialect === 'ps' && /^(?:\[(?:System\.)?IO\.Path\]::GetTempFileName\(\s*\)|New-TemporaryFile|\(\s*New-TemporaryFile\s*\)\.FullName)$/i.test(s)) return { value: temp('New-TemporaryFile'), item: true }
  // `d=$(date +%Y%m%d)`, `$s = $(Get-Date -Format yyyy)`: a name the command makes (review 2026-11-24, eighth).
  const sub = s.match(/^(["']?)\$\(([\s\S]*)\)\1$/)
  if (sub && matchParen(s, s.indexOf('(')) === s.lastIndexOf(')')) {
    const k = madeKind(sub[2])
    if (k !== null) return { value: k }
  }
  const jp = dialect === 'ps' ? s.match(/^Join-Path\s+(?:-Path\s+)?(\S+)\s+(?:-ChildPath\s+)?([\s\S]+)$/i) : null
  if (jp) {
    const folder = onlyAnchor(run, jp[1], ['temp', 'scratch'])
    const leaf = jp[2].trim()
    // A leaf the command computes (a guid, a date, a counter): a name inside the folder, never a climb.
    if (folder !== null && madeNameGroup(leaf)) return { value: `${folder}\\${madeKind(leaf.trim().slice(1, -1))}` }
    // `('ck-' + [guid]::NewGuid())`, `$([guid]::NewGuid())`, `"probe-$([guid]::NewGuid().ToString('N'))"`: one name (C2).
    const made = folder !== null ? madeLeaf(leaf) : null
    if (made !== null) return { value: `${folder}\\${made}` }
    // Any readable folder with a made leaf (`Join-Path 'backups' ('save-' + (Get-Date -Format yyyyMMdd) + '.json')`, C6).
    const base = folder === null ? (stringValue(jp[1], true) ?? (/^[\w.\\/:-]+$/.test(jp[1]) || new RegExp(`^${S0}\\d+${S1}$`).test(jp[1]) ? jp[1] : null)) : null
    const made2 = base !== null && !hasUnreadableSentinel(run, base) && !base.includes(UNREAD) ? madeLeaf(leaf) : null
    if (made2 !== null) return { value: `${base!.replace(/[\\/]+$/, '')}\\${made2}` }
    // A child with folders before the made name (`Join-Path $PWD "logs\run-$(Get-Date -Format yyyyMMdd).log"`): the
    // literal folders, then the one name (ninth review).
    const dirBase = folder ?? (base !== null && !hasUnreadableSentinel(run, base) && !base.includes(UNREAD) ? base.replace(/[\\/]+$/, '') : null)
    const nested = dirBase !== null ? nestedMadeLeaf(leaf) : null
    if (nested !== null) return { value: `${dirBase}\\${nested}` }
    if (folder !== null && /^\(\s*\$\w+\s*\)$/.test(leaf)) return { value: `${folder}\\${UNREAD}` }
    const lit = folder !== null ? stringValue(leaf, true) ?? (/^[\w.-]+$/.test(leaf) ? leaf : null) : null
    if (folder !== null && lit !== null && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(lit) && !/^[\\/]|^[A-Za-z]:/.test(lit)) return { value: `${folder}\\${lit}` }
  }
  if (dialect === 'ps' ? /^git\s+rev-parse\s+--show-toplevel$/.test(s) : /^("?)\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)\1$/.test(s)) {
    return { value: anchorEntry(run, 'cwd', 'git rev-parse --show-toplevel') }
  }
  const sp = dialect === 'ps' ? s.match(/^Split-Path\s+(?:-Parent\s+|-Path\s+)*('[^']*'|"[^"$`]*"|[\w.\\/:-]+)(?:\s+-Parent)?$/i) : null
  if (sp) {
    const lit = sp[1].replace(/^(['"])([\s\S]*)\1$/, '$2')
    if (!lit.includes(S0) && /[\\/]/.test(lit)) return { value: nodePath.win32.dirname(lit) }
  }
  return null
}

/** A PowerShell table of literal values (`@{ Path = '.\build'; Recurse = $true }`), for a splat; null otherwise. */
function hashValue(rhs: string, run?: Run): Array<[string, string | true]> | null {
  const m = rhs.trim().match(/^@\{([\s\S]*)\}$/)
  if (!m) return null
  const out: Array<[string, string | true]> = []
  for (const part of splitTop(m[1].replace(/\n/g, ';'), ';', false)) {
    const t = part.trim()
    if (t === '') continue
    const kv = t.match(/^['"]?([A-Za-z_]\w*)['"]?\s*=\s*([\s\S]+)$/)
    if (!kv) return null
    const v = kv[2].trim()
    if (/^\$true$/i.test(v)) { out.push([kv[1], true]); continue }
    if (/^\$false$/i.test(v)) continue
    const lit = /^-?\d+$/.test(v) ? v : stringValue(v, true)
    // A double-quoted value is read through the names it holds (`Path = "$PWD\build"`, review 2026-11-24, eighth).
    if (lit === null || (lit.includes(S0) && (run === undefined || !v.startsWith('"') || hasUnreadableSentinel(run, lit)))) return null
    out.push([kv[1], lit])
  }
  return out
}

const MAX_LOOP_ELEMENTS = 64

/**
 * The items a listing command prints, as loop elements (review 2026-11-24, sixth): `ls` (a glob is the items it
 * matches, a folder's names are names in the working folder), `find ROOT...` (the root and the items under it),
 * `git ls-files` (names in the working folder). Null for any other command or a part that cannot be read.
 */
function listingSource(run: Run, text: string): string[] | null {
  const toks = tokenize(text.trim(), true)
  if (toks.length === 0 || toks.some(t => t.kind !== 'w' || t.subs.length)) return null
  const words = (toks as WordTok[]).map(t => t.pieces.map(p => p.t).join(''))
  if (words.some(v => hasUnreadableSentinel(run, v) || v.includes(UNREAD))) return null
  const verb = verbName(words[0])
  const rest = words.slice(1)
  if (verb === 'ls') {
    const ops = rest.filter(w => !w.startsWith('-'))
    if (ops.length === 0) return [`./${NAME}`]
    return ops.map(w => (WILDCARD.test(w) ? w : `./${NAME}`))
  }
  if (verb === 'find') {
    const roots: string[] = []
    for (const w of rest) { if (/^[-(!]/.test(w)) break; roots.push(w) }
    // A name, a path pattern or `-type f` leaves the root itself out of what it prints (review 2026-11-24, seventh: a
    // filtered delete over its items was logged as deleting the root).
    const children = rest.some((w, k) => /^-(?:i?name|i?path|i?regex|i?wholename)$/.test(w) || (w === '-type' && rest[k + 1] === 'f') || (w === '-mindepth' && Number(rest[k + 1]) >= 1))
    return (roots.length ? roots : ['.']).flatMap(r => (children ? [] : [r]).concat(`${r.replace(/[\\/]+$/, '')}/${DESC}`))
  }
  if (verb === 'git' && (rest[0] === 'diff' || rest[0] === 'ls-tree') && rest.some(w => /^--name-(?:only|status)$/.test(w)) && !rest.some(w => /^(?:-C|--git-dir|--work-tree)/.test(w))) return [`./${DESC}`]
  if (verb === 'git' && rest[0] === 'ls-files') return [`./${DESC}`]
  // `seq 1 5`: numbers, each a name with no separator (review 2026-11-24, eighth).
  if (verb === 'seq' && rest.length >= 1 && rest.length <= 3 && rest.every(w => /^-?\d+$/.test(w))) return [NAME]
  return null
}

/**
 * The elements a loop variable takes from a list written in the command (review 2026-11-24, sixth), each in
 * its substituted form, or null when one of them cannot be read. PowerShell: a comma list, `@(...)` of one or
 * more values, a range of integers, a variable bound to a list or a value, one value; POSIX: words that are
 * literals or globs (a glob is the items it matches, inside its folder).
 */
function loopList(run: Run, src0: string, dialect: 'ps' | 'posix'): string[] | null {
  let src = src0.trim()
  if (dialect === 'posix') {
    const sub = src.match(/^"?(?:\$\(([\s\S]*)\)|`([^`]*)`)"?$/)
    if (sub && (sub[2] !== undefined || matchParen(src, src.indexOf('(')) === src.lastIndexOf(')'))) return listingSource(run, sub[1] ?? sub[2])
    // A brace list (`{build,dist}`), unquoted: one element per alternative.
    src = src.replace(/(?<=^|\s)([^\s{}'"]*)\{([^{}\s'"]*,[^{}\s'"]*)\}([^\s{}'"]*)(?=\s|$)/g, (_m: string, a: string, list: string, b: string) => list.split(',').map(x => `${a}${x}${b}`).join(' '))
    const toks = tokenize(src, true)
    // `for f in $(ls out/*.log)`, `$(find build -name '*.o')`, `$(git ls-files)`: the items that listing names.
    if (toks.length === 1 && toks[0].kind === 'w' && toks[0].subs.length === 1 && toks[0].pieces.map(p => p.t).join('') === UNREAD) {
      return listingSource(run, toks[0].subs[0])
    }
    if (toks.length === 0 || toks.length > MAX_LOOP_ELEMENTS || toks.some(t => t.kind !== 'w' || t.subs.length)) return null
    const out = (toks as WordTok[]).map(t => t.pieces.map(p => p.t).join(''))
    return out.length > MAX_LOOP_ELEMENTS || out.some(v => hasUnreadableSentinel(run, v) || v.includes(UNREAD) || /[`]/.test(v)) ? null : out
  }
  for (let guard = 0; guard < 4; guard++) {
    const g = src.match(/^@?\(([\s\S]*)\)$/)
    if (!g || matchParen(src, src.indexOf('(')) !== src.length - 1) break
    src = g[1].trim()
  }
  const range = src.match(/^(-?\d+)\s*\.\.\s*(-?\d+)$/)
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])]
    if (Math.abs(b - a) >= MAX_LOOP_ELEMENTS) return null
    const out: string[] = []
    for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? 1 : -1) out.push(String(k))
    return out
  }
  const only = src.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  if (only) {
    const e = run.table[Number(only[1])]
    if (e?.k === 'bound' && e.b.list) return e.b.list
  }
  // Elements written as groups (`@((Join-Path $env:TEMP 'work'))`, `('a' + 'b')`): each one a value or none.
  const elems = splitTop(src, ',', false).map(x => x.trim()).filter(x => x !== '')
  if (elems.length === 0 || elems.length > MAX_LOOP_ELEMENTS) return null
  const out: string[] = []
  for (const el0 of elems) {
    let el = el0
    while (/^\(([\s\S]*)\)$/.test(el) && matchParen(el, 0) === el.length - 1) el = el.slice(1, -1).trim()
    const toks = joinCommaToks(tokenize(el, false))
    if (toks.length === 0 || toks.some(t => t.kind !== 'w')) return null
    const ws = toks as WordTok[]
    const w = ws.length === 1 ? ws[0] : wordsExpression(ws)
    if (w === null || w.subs.length) return null
    if (ws.length === 1 && w.pieces[0]?.q === 'n' && !w.pieces[0].t.startsWith(S0) && !/^[\w.\\/:-]+$/.test(w.pieces[0].t)) return null
    const v = w.pieces.map(p => p.t).join('')
    if (hasUnreadableSentinel(run, v) || v.includes(UNREAD)) return null
    out.push(v)
  }
  return out
}

/** The elements of a right-hand side that is one comma list word (`'a','b'`, `a,b`), or null. */
function listElements(rhs: string): string[] | null {
  const toks = joinCommaToks(tokenize(rhs, false))
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

/** PowerShell's item sources a variable or a loop is bound to, and whether each hands on the items inside the folder it names. */
const ITEM_SOURCE_LISTS: Record<string, boolean> = { 'get-childitem': true, gci: true, ls: true, dir: true, 'get-item': false, gi: false,
  'resolve-path': false, rvpa: false, 'get-location': false, gl: false, pwd: false }

/**
 * `Get-ChildItem build`, `Get-Item x`, `Resolve-Path y`, `Get-Location` with at most one literal path: the
 * value an item of it is when bound to a variable or a loop (review 2026-11-23, fourth). A listing's item is
 * inside the folder listed (`build\` then a name the scan cannot read); `-Name` hands on bare names, which
 * are not read. Null for anything else.
 */
function itemSourceValue(text: string): string | null {
  const v = itemSourceValues(text)
  return v !== null && v.length === 1 ? v[0] : null
}

/**
 * The items of an item source, one per path it names: `Get-Item .\build,C:\x` is two items, never one name
 * with a comma in it (review 2026-11-24, seventh, P9: the list was read as one relative file name). A
 * parameter is bound as PowerShell binds it, by any prefix, glued or spaced, with a colon and a space too
 * (`-L:C:\x`, `-Path: C:\x`); one the scan does not know makes the whole unreadable.
 */
function itemSourceValues(text: string): string[] | null {
  if (/[|;`%~$]/.test(text.replace(new RegExp(`${S0}\\d+${S1}`, 'g'), ''))) return null
  const toks = joinCommaToks(tokenize(text.trim(), false))
  if (toks.length === 0 || toks.some(t => t.kind !== 'w')) return null
  const words = (toks as WordTok[]).map(t => ({ t, text: t.pieces.map(p => p.t).join('') }))
  // `git ls-files` lists names in the working folder (review 2026-11-24, sixth).
  if (verbName(words[0].text) === 'git' && words[1]?.text === 'ls-files' && !words.some(w => /^(?:-C|--git-dir|--work-tree)/.test(w.text))) return [`.\\${DESC}`]
  const verb = verbName(words[0].text)
  const list = ITEM_SOURCE_LISTS[verb]
  if (list === undefined) return null
  const paths: string[] = []
  let recurse = false
  const split = (t: WordTok): string[] => {
    const out: string[] = ['']
    for (const p of t.pieces) {
      if (p.q !== 'n') { out[out.length - 1] += p.t; continue }
      p.t.split(',').forEach((x, k) => { if (k > 0) out.push(''); out[out.length - 1] += x })
    }
    return out.filter(x => x !== '')
  }
  for (let k = 1; k < words.length; k++) {
    const w = words[k].text
    const quoted = words[k].t.pieces[0]?.q !== 'n'
    const pm = quoted ? null : w.match(/^-([A-Za-z][\w-]*)(?::([\s\S]*))?$/)
    if (pm) {
      const name = canonParam(pm[1].toLowerCase(), verb)
      // `Resolve-Path X -Relative`: the same items, spelled relative to the working folder (eighth review).
      if ((verb === 'resolve-path' || verb === 'rvpa') && /^rel/.test(name) && !/^relativeb/.test(name)) continue
      if (name === 'name' || /^relative/.test(name) || name === 'rel') return null
      const glued = pm[2] !== undefined && pm[2] !== '' ? pm[2] : null
      const takeNext = pm[2] === '' || (glued === null && !LIST_SWITCHES.has(name) && !SWITCHES_OF.has(name))
      if (name === 'path' || name === 'literalpath') {
        if (glued !== null) paths.push(...glued.split(','))
        else if (takeNext && words[k + 1]) paths.push(...split(words[++k].t))
        continue
      }
      if (name === 'recurse' || name === 'depth') recurse = true
      if (glued !== null) {
        if (/^(?:filter|include|exclude|depth|attributes|erroraction|warningaction)$/.test(name)) continue
        return null
      }
      if (/^(?:filter|include|exclude|depth|attributes|erroraction|warningaction)$/.test(name) || pm[2] === '') { k++; continue }
      if (LIST_SWITCHES.has(name) || SWITCHES_OF.has(name)) continue
      return null
    }
    paths.push(...split(words[k].t))
  }
  if (paths.length > MAX_LOOP_ELEMENTS) return null
  const ps = paths.length ? paths : ['.']
  return ps.map(p => (list ? `${p.replace(/[\\/]+$/, '')}\\${recurse ? DESC : NAME}` : p))
}

/**
 * `$d = New-Item -ItemType Directory -Force .\out\w1`, `mkdir $env:TEMP\x`, `ni -Path (Join-Path $env:TEMP 'w')`:
 * the item New-Item makes, as `Get-Item` of it would be (review 2026-11-24, seventh: a variable bound to New-Item's
 * output was never read, and the standard temp-folder idiom was refused). Its folder and name are read as they
 * are for the write itself; a link, or a part the scan cannot read, is null.
 */
function newItemValue(run: Run, text: string): string | null {
  let s = text.trim()
  while (/^\(([\s\S]*)\)$/.test(s) && matchParen(s, 0) === s.length - 1) s = s.slice(1, -1).trim()
  const head = s.match(/^(New-Item|ni|mkdir|md)\s+/i)
  if (!head) return null
  const toks = tokenize(s.slice(head[0].length), false)
  let path: string | null = null
  let name: string | null = null
  const valueOf = (k: number): { v: string | null; next: number } => {
    const t = toks[k]
    if (t === undefined) return { v: null, next: k }
    if (t.kind === 'op' && t.op === '(') {
      let depth = 0
      let e = k
      for (; e < toks.length; e++) {
        const x = toks[e]
        if (x.kind === 'op' && (x.op === '(' || x.op === '$(' || x.op === '@(')) depth++
        if (x.kind === 'op' && x.op === ')') { depth--; if (depth === 0) break }
      }
      const inner = e < toks.length ? s.slice(head[0].length + t.end, head[0].length + toks[e].start) : ''
      const made = madeValue(run, inner, 'ps')
      const wv = made === null ? shellRhsValue(run, inner, 'ps') : made.value
      return { v: typeof wv === 'string' ? wv : null, next: e }
    }
    if (t.kind !== 'w') return { v: null, next: k }
    return { v: madeWordValue(run, t), next: k }
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.kind !== 'w') return null
    const w = t.pieces.map(p => p.t).join('')
    const pm = t.pieces[0]?.q === 'n' ? w.match(/^-([A-Za-z][\w-]*)(?::([\s\S]*))?$/) : null
    if (pm) {
      const pn = canonParam(pm[1].toLowerCase(), 'new-item')
      if (/^(?:force|confirm|whatif|verbose)$/.test(pn)) continue
      const r = pm[2] !== undefined && pm[2] !== '' ? { v: madeWordValue(run, { ...t, pieces: [{ t: pm[2], q: 'n' }] }), next: k } : valueOf(k + 1)
      k = r.next
      if (pn === 'itemtype') { if (r.v === null || !/^(?:directory|file|d|f)$/i.test(r.v.replace(/^['"]|['"]$/g, ''))) return null; continue }
      if (pn === 'path') { if (r.v === null) return null; path = r.v; continue }
      if (pn === 'name') { if (r.v === null || /[\\/]|^\.\.?$/.test(r.v)) return null; name = r.v; continue }
      if (/^(?:value|erroraction|warningaction)$/.test(pn)) continue
      return null
    }
    if (path !== null) return null
    const r = valueOf(k)
    if (r.v === null) return null
    path = r.v; k = r.next
  }
  if (path === null) return name
  return name === null ? path : `${path.replace(/[\\/]+$/, '')}\\${name}`
}

/**
 * Subexpressions that make a fresh name and nothing else: a date, a guid, a random number or file name, the
 * leaf name of an item (review 2026-11-24, seventh). Written after the last separator of a path they are a
 * name inside the folder before it; a format with a separator or `..` in it is not one of them.
 */
const MADE_FORMAT = String.raw`\(\s*(?:'[^'\\/"$]*[A-Za-z0-9][^'\\/"$]*'|"[^"\\/'$\u0060]*[A-Za-z0-9][^"\\/'$\u0060]*")?\s*\)`
const MADE_NAME_SUB = new RegExp(String.raw`^\s*(?:(?:Get-Date|Get-Random)\b(?![^;|()]*(?:[\\/]|\.\.))[^;|()]*|\(\s*(?:Get-Date|Get-Random)\b[^;|()\\/]*\)(?:\.ToString${MADE_FORMAT})?|New-Guid|\(\s*New-Guid\s*\)\.Guid|\[guid\]::NewGuid\(\)(?:\.Guid|\.ToString${MADE_FORMAT})?|\(\s*\[guid\]::NewGuid\(\)\s*\)(?:\.Guid|\.ToString${MADE_FORMAT})?|\[(?:System\.)?IO\.Path\]::GetRandomFileName\(\s*\)|\[datetime\]::(?:Now|UtcNow|Today)(?:\.(?:Ticks|Year|Month|Day|Hour|Minute|Second)|\.ToString${MADE_FORMAT}|\.ToFileTime(?:Utc)?\(\s*\))?|\$PID|date\s+[+\-](?![^;|\u0060]*(?:[\\/]|\.\.))[^;|\u0060]*|\(\s*Get-Item\s+[^()|;]*\)\.(?:Name|BaseName))\s*$`, 'i')

/**
 * What a subexpression that makes a name stands for in a word: NAME (one name), DESC for a bare `Get-Date`, whose
 * default text holds separators (`11/24/2026 3:30:16 AM`) but never a climb, or null when it makes no name.
 * A `-Format` (or `-f`, `-UFormat`) is made of letters and digits and so is never `.` or `..`: a format
 * without one (`-f .`) is not read as a name (review 2026-11-24, eighth).
 */
function madeKind(inner: string): typeof NAME | typeof DESC | null {
  if (!MADE_NAME_SUB.test(inner)) return null
  const gd = inner.match(/^\s*\(?\s*Get-Date\b([^;|()]*)/i)
  if (gd) {
    const fmt = gd[1].match(/-(?:Format|f|UFormat|UF\w*|Fo\w*)\s*[: ]\s*(\S+)/i)
    if (fmt === null) return /\)\.ToString\(\s*['"]/i.test(inner) ? NAME : DESC
    if (!/[A-Za-z0-9]/.test(fmt[1]) || /['"].*['"].*['"]|%(?![A-Za-z])/.test(fmt[1])) return null
  }
  return NAME
}

/**
 * `$(mktemp [-d] [-t] [-p DIR] [--tmpdir[=DIR]] [--suffix=SFX] [TEMPLATE])`: a new item in the folder those options name
 * (review 2026-11-24, eighth, C2): 'temp' for the temp folder, `DIR/NAME` for a folder the scan reads (a temp, scratch or
 * working-folder spelling, or a relative path that does not climb), null for anything else.
 */
function mktempValue(run: Run, s: string): string | 'temp' | null {
  const m = s.match(/^(["']?)(?:\$\(([\s\S]*)\)|`([^`]*)`)\1$/)
  if (!m) return null
  const inner = (m[2] ?? m[3] ?? '').trim()
  if (!/^mktemp\s/.test(inner) && inner !== 'mktemp') return null
  const toks = tokenize(inner.slice(6), true)
  if (toks.some(t => t.kind !== 'w' || t.subs.length)) return null
  const words = (toks as WordTok[]).map(t => t.pieces.map(p => p.t).join(''))
  let dir: string | null = null
  let template: string | null = null
  let tFlag = false
  for (let k = 0; k < words.length; k++) {
    const w = words[k]
    if (w === '-p' || w === '--tmpdir') { if (w === '-p' || (words[k + 1] !== undefined && !words[k + 1].startsWith('-') && template === null && /[\\/]|^\u0002/.test(words[k + 1]))) { dir = words[++k] ?? null; if (dir === null) return null } continue }
    if (w.startsWith('--tmpdir=')) { dir = w.slice(9); continue }
    if (w.startsWith('--suffix=')) { if (/[\\/]|\.\./.test(w.slice(9))) return null; continue }
    if (w === '--suffix') { const x = words[++k]; if (x === undefined || /[\\/]|\.\./.test(x)) return null; continue }
    if (/^-[dtuq]+$/.test(w)) { if (w.includes('t')) tFlag = true; continue }
    if (w.startsWith('-') || template !== null) return null
    template = w
  }
  if (template !== null && /[\\/]/.test(template)) {
    if (tFlag || dir !== null) return null
    dir = template.replace(/[\\/][^\\/]*$/, '')
  }
  if (dir === null) return 'temp'
  if (dir.includes(UNREAD) || hasUnreadableSentinel(run, dir) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(dir)) return null
  // Only a temp, scratch or working-folder spelling, or a relative path: never an absolute folder elsewhere.
  if (dir.startsWith(S0)) {
    const e = run.table[Number(dir.slice(1, dir.indexOf(S1)))]
    if (!(e?.k === 'anchor' && (e.anchor === 'temp' || e.anchor === 'scratch' || e.anchor === 'cwd'))) return null
  } else if (/^(?:[\\/]|[A-Za-z]:|~)/.test(dir) || dir.includes(S0)) return null
  return `${dir.replace(/[\\/]+$/, '')}/${NAME}`
}

/**
 * A leaf made of quoted literals and name makers joined by `+` (`'ck-' + [guid]::NewGuid()`, `('run-' + (Get-Random))`,
 * `$([guid]::NewGuid())`, `[IO.Path]::GetRandomFileName()`), with no separator and no `..` in any literal: the one name
 * it makes, a NAME standing for each maker; null for anything else (review 2026-11-24, eighth, C2).
 */
function madeLeaf(text: string): string | null {
  let t = text.trim()
  for (let g = 0; g < 4; g++) {
    const m = t.match(/^\$?\(([\s\S]*)\)$/)
    if (!m || matchParen(t, t.indexOf('(')) !== t.length - 1) break
    t = m[1].trim()
  }
  const parts = splitTop(t, '+', false).map(x => x.trim())
  let out = ''
  let made = false
  for (let x of parts) {
    if (x === '') return null
    const lit = /^'[^'\\/]*'$|^"[^"\\/$`]*"$/.test(x) ? x.slice(1, -1) : null
    if (lit !== null) { out += lit; continue }
    const inner = x.match(/^\$?\(([\s\S]*)\)$/)
    if (inner && matchParen(x, x.indexOf('(')) === x.length - 1) x = inner[1].trim()
    // `"probe-$([guid]::NewGuid().ToString('N'))"`: a double-quoted literal around one maker.
    const dq = x.match(/^"([^"\\/$`]*)\$\(([^"]*)\)([^"\\/$`]*)"$/)
    if (dq && madeKind(dq[2]) === NAME) { out += dq[1] + NAME + dq[3]; made = true; continue }
    if (madeKind(x) !== NAME) return null
    out += NAME
    made = true
  }
  // Every maker's name holds a letter or a digit, so only a literal can make `..`.
  if (!made || out.includes('..')) return null
  return out
}

/**
 * A double-quoted child of literal folders and then a made leaf (`"logs\run-$(Get-Date -Format yyyyMMdd).log"`): the
 * folders as written and the one name the leaf makes; null when a folder is not a plain name (`..` included) or the
 * leaf is not one `madeLeaf` reads (ninth review).
 */
function nestedMadeLeaf(leaf: string): string | null {
  const m = leaf.trim().match(/^"((?:[\w.-]+[\\/])+)([^"\\/]*)"$/)
  if (!m || m[1].split(/[\\/]/).some(d => d === '..' || d === '.')) return null
  const last = madeLeaf(`"${m[2]}"`)
  return last === null ? null : m[1].replace(/\//g, '\\') + last
}

/** A group that makes a fresh name (`(Get-Random)`, `([guid]::NewGuid())`, `(New-Guid)`), for a Join-Path leaf or a `-f` argument. */
function madeNameGroup(t: string): boolean {
  const s = t.trim()
  return /^\(([\s\S]*)\)$/.test(s) && matchParen(s, 0) === s.length - 1 && madeKind(s.slice(1, -1)) !== null
}

/** Switch parameters of the item cmdlets: no value follows them. */
const SWITCHES_OF = new Set(['force', 'recurse', 'confirm', 'whatif', 'verbose', 'debug', 'passthru', 'file', 'directory', 'hidden', 'readonly',
  'system', 'followsymlink', 'raw', 'container', 'append', 'nonewline', 'noclobber', 'notypeinformation', 'update', 'wait', 'usetransaction',
  'asstring', 'leaf', 'parent', 'isabsolute', 'resolve', 'qualifier', 'noqualifier', 'extension', 'leafbase'])

/** A word's value when every subexpression in it makes a fresh name after its last separator (`"$env:TEMP\$(New-Guid)"`); null otherwise. */
function madeWordValue(run: Run, t: WordTok): string | null {
  const value = t.pieces.map(p => p.t).join('')
  if (hasUnreadableSentinel(run, value)) return null
  return value.includes(UNREAD) || value.includes(EMPTY_SUB) ? null : value
}

function hasUnreadableSentinel(run: Run, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== S0) continue
    const { e, end } = entryAt(run, s, i)
    if (!e || e.k === 'u' || e.k === 'p' || e.k === 'doc') return true
    if (e.k === 'bound' && e.b.value === null && e.b.here === null && e.b.list === undefined) return true
    i = end - 1
  }
  return false
}

// ─── (b) Tokenizer ─────────────────────────────────────────────────────────────────────────────

type Piece = { t: string; q: 'n' | 's' | 'd' }
interface WordTok { kind: 'w'; pieces: Piece[]; start: number; end: number; subs: string[] }
interface OpTok { kind: 'op'; op: string; start: number; end: number }
type Tok = WordTok | OpTok

function matchParen(s: string, open: number, within = Infinity): number {
  let depth = 0
  const stop = Math.min(s.length, open + within)
  for (let k = open; k < stop; k++) {
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
/** How far a subexpression glued to a word is looked for its closing parenthesis. */
const GLUED_SUB_WINDOW = 512

/** What a subexpression stands for in a word: the name it is, empty, or a value the scan cannot read. */
function subValue(inner: string, run?: Run): string {
  // `"$($x)"` is `"$x"`: a subexpression that is one name reads as the name. One that is empty when it runs
  // (`$()`, `$($null)`, `$('')`, `$(echo)`, `$([string]::Empty)`, `$(Out-Null)`, `$(@())`, `$(''+'')`) is
  // an empty name (review 2026-11-23, third and fourth).
  // `"$($_.FullName)"` is the pipeline's item; `"$($_.Name)"` and `"$($_.BaseName)"` are its leaf name (ITEM_LEAF),
  // read where the block's feed is known (review 2026-11-24, seventh). A member after a variable's own name is
  // taken with the name by the substitution, so only the pipeline's item leaves one here.
  const own = inner.match(new RegExp(`^\\s*(${S0}\\d+${S1})\\.(?:FullName|PSPath|Path|LiteralPath)\\s*$`, 'i'))
  if (own) return own[1]
  const leaf = inner.match(new RegExp(`^\\s*(${S0}\\d+${S1})\\.(?:Name|BaseName)\\s*$`, 'i'))
  if (leaf) return `${leaf[1]}${ITEM_LEAF}`
  const dirOf = inner.match(new RegExp(`^\\s*(${S0}\\d+${S1})\\.(?:DirectoryName|Directory)\\s*$`, 'i'))
  if (dirOf) return `${dirOf[1]}${ITEM_DIR}`
  const made = madeKind(inner)
  if (made !== null) return made
  // `"$($names[0])"`: an element of the name, judged on every element the name holds (`boundList`).
  const indexed = inner.match(new RegExp(`^\\s*(${S0}\\d+${S1})\\[\\s*-?\\d+\\s*\\]\\s*$`))
  if (indexed) return indexed[1]
  // `$(basename "$f")` of a loop variable over globs and literal names that never end in `.` or `..`: one name
  // (review 2026-11-24, eighth).
  const bn = run ? inner.match(new RegExp(`^\\s*basename\\s+("?)${S0}(\\d+)${S1}\\1(?:\\s+[\\w.-]+)?\\s*$`)) : null
  if (bn && run) {
    const e = run.table[Number(bn[2])]
    const vals = e?.k === 'bound' ? (e.b.list ?? (e.b.value !== null ? [e.b.value] : null)) : null
    if (vals !== null && vals.length > 0 && vals.every(v => !v.includes(S0) && !v.includes(UNREAD) && !/(?:^|[\\/])\.{1,2}[\\/]*$/.test(v))) return NAME
  }
  return new RegExp(`^\\s*${S0}\\d+${S1}\\s*$`).test(inner) ? inner.trim()
    : /^\s*(?:\$null|''|""|echo|Write-Output|Out-Null|@\(\s*\)|\[(?:System\.)?String\]::Empty|''\s*\+\s*''|""\s*\+\s*"")?\s*;?\s*$/i.test(inner) ? EMPTY_SUB : UNREAD
}

/**
 * The words and operators of a text. `posixQuotes`: a backslash escapes `"`, `$` and a backtick inside
 * double quotes, as a POSIX shell reads it; PowerShell and cmd read the backslash as an ordinary
 * character, so `"D:\"` is closed at its second quote there (review 2026-11-23). `cmd`: the text is read
 * as cmd reads it, where `'`, a backtick and `#` are ordinary characters (review 2026-11-23, fourth: two
 * apostrophes hid cmd's own `&` between them).
 */
function tokenize(s: string, posixQuotes = true, run?: Run, cmd = false, posixEscapes = false): Tok[] {
  const toks: Tok[] = []
  let tick = 0
  let pieces: Piece[] = []
  let subs: string[] = []
  let wStart = -1
  // The last character read as part of a word or an operator (never one of a comment).
  let lastSig = ''
  const unq = (t: string, at: number) => {
    if (wStart < 0) wStart = at
    const last = pieces[pieces.length - 1]
    if (last && last.q === 'n') last.t += t
    else pieces.push({ t, q: 'n' })
    lastSig = t.slice(-1)
  }
  const quoted = (t: string, q: 's' | 'd', at: number) => {
    if (wStart < 0) wStart = at
    pieces.push({ t, q })
    lastSig = q === 's' ? "'" : '"'
  }
  const endWord = (at: number) => {
    if (wStart >= 0) toks.push({ kind: 'w', pieces, start: wStart, end: at, subs })
    pieces = []; subs = []; wStart = -1
  }
  const op = (o: string, a: number, b: number) => { endWord(a); toks.push({ kind: 'op', op: o, start: a, end: b }); lastSig = o.slice(-1) }
  let i = 0
  while (i < s.length) {
    // A long text is read against the budget: past it the rest is not tokenized (the fault refuses the call).
    if (run !== undefined && (++tick & 4095) === 0 && overBudget(run)) break
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\r') { endWord(i); i++; continue }
    // A line that ends in a comma or a pipe goes on on the next line, as PowerShell (a list, a pipeline) and a
    // POSIX shell (a pipeline) read it (review 2026-11-23, fourth).
    if (c === '\n' && (lastSig === ',' || lastSig === '|') && !cmd) { endWord(i); i++; continue }
    if (c === '\n') { op('\n', i, i + 1); i++; continue }
    if (c === S0) {
      const j = s.indexOf(S1, i)
      const end = j < 0 ? s.length : j + 1
      unq(s.slice(i, end), i); i = end; continue
    }
    if (!cmd && c === '#' && wStart < 0) { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue }
    if (!cmd && c === '<' && s[i + 1] === '#') { endWord(i); const j = s.indexOf('#>', i + 2); i = j < 0 ? s.length : j + 2; continue }
    if (cmd && (c === "'" || c === '`')) { unq(c, i); i++; continue }
    // `posixEscapes` (a POSIX shell's own text): `\"` and `\'` outside quotes are the quote character itself (wave 15:
    // read as a backslash and an opening quote, `echo \"; rm -rf ~/.ssh; echo \"` hid its rm inside a string). Any
    // other backslash stays as written, so a Windows path spelled in POSIX text reads as it did. `\\` is one
    // backslash, so the quote after it opens a string where the shell opens one (wave 15b, P3-F1: read as a
    // backslash and an escaped quote, `echo \\" x" ; rm -rf ~/.ssh` hid its rm inside a string).
    if (posixEscapes && c === '\\' && s[i + 1] === '\\') { unq('\\', i); i += 2; continue }
    if (posixEscapes && c === '\\' && (s[i + 1] === '"' || s[i + 1] === "'")) { unq(s[i + 1], i); i += 2; continue }
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
        if (!cmd && d === '`' && j + 1 < s.length) { t += s[j + 1]; j += 2; continue }
        // Inside double quotes a POSIX shell's backslash escapes `"`, `$`, a backtick and itself (wave 15b, P3-F1:
        // `"a\\" ; rm -rf ~/.ssh ; echo "b"` closes at its second quote there).
        if (posixQuotes && d === '\\' && (s[j + 1] === '"' || s[j + 1] === '$' || s[j + 1] === '`' || s[j + 1] === '\\')) { t += s[j + 1]; j += 2; continue }
        if (!cmd && d === '$' && s[j + 1] === '(') {
          const k = matchParen(s, j + 1)
          const inner = s.slice(j + 2, k)
          subs.push(inner)
          t += subValue(inner, run)
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
    // PowerShell's stop-parsing token: the rest of the line goes to the program as written, its `&&`, `|`
    // and `;` included (review 2026-11-23, fourth). Read as one literal word.
    if (!posixQuotes && !cmd && wStart < 0 && s.startsWith('--%', i) && /^(?:[ \t\r\n]|$)/.test(s.slice(i + 3, i + 4))) {
      unq('--%', i); endWord(i + 3)
      let j = i + 3
      while (s[j] === ' ' || s[j] === '\t') j++
      const nl = s.indexOf('\n', j)
      const end = nl < 0 ? s.length : nl
      if (end > j) { quoted(s.slice(j, end), 's', j); endWord(end) }
      i = end; continue
    }
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
    if (!cmd && c === '$' && s[i + 1] === '(') {
      // A subexpression glued to the text of a word (`a$(x)`, `--work-tree=$(Split-Path $PWD)`, `$(x)\y`) is
      // part of that one argument, as PowerShell and a POSIX shell pass it (review 2026-11-23, fourth).
      // Looked for within a bounded window, so a run of unclosed openers stays linear; a subexpression longer
      // than that is a group of its own, as before.
      const k = matchParen(s, i + 1, GLUED_SUB_WINDOW)
      const after = s[k + 1]
      if ((wStart >= 0 && k < s.length) || (k < s.length && after !== undefined && !/[\s;|&)}\n]/.test(after) && after !== '.' && after !== '[')) {
        const inner = s.slice(i + 2, k)
        subs.push(inner)
        unq(subValue(inner, run), i)
        i = k + 1; continue
      }
      op('$(', i, i + 2); i += 2; continue
    }
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
/**
 * Which positions of a text are code, outside a quote and a comment, as the text's shell reads it: one
 * forward pass, asked in increasing order (review 2026-11-23, fourth: an `@'` inside a `#` comment or at the
 * end of a closed string opened a here-string, and the real command lines up to the next `'@` were read as
 * data, so they were never judged). A double-quoted string's `$( ... )` is code again. `skip` marks a lifted
 * body the pass jumps over.
 */
function codeScanner(text: string, dialect: Dialect): { isCode: (pos: number) => boolean; skip: (from: number, to: number) => void } {
  type Frame = { k: 'code'; depth: number } | { k: 'sq' } | { k: 'dq' }
  const stack: Frame[] = [{ k: 'code', depth: 0 }]
  const skips: Array<[number, number]> = []
  let si = 0
  let p = 0
  const tokenStart = (j: number) => j === 0 || /[\s;|&({}]/.test(text[j - 1])
  const step = () => {
    while (si < skips.length && skips[si][1] <= p) si++
    if (si < skips.length && p >= skips[si][0]) { p = skips[si][1]; si++; return }
    const c = text[p]
    const top = stack[stack.length - 1]
    if (c === S0) { const j = text.indexOf(S1, p); p = j < 0 ? text.length : j + 1; return }
    if (top.k === 'sq') {
      if (c === "'") { if (dialect === 'ps' && text[p + 1] === "'") { p += 2; return } stack.pop() }
      p++; return
    }
    if (top.k === 'dq') {
      if (dialect === 'ps' && c === '`') { p += 2; return }
      if (dialect === 'posix' && c === '\\') { p += 2; return }
      if (c === '"') { if (dialect === 'ps' && text[p + 1] === '"') { p += 2; return } stack.pop(); p++; return }
      if (dialect !== 'cmd' && c === '$' && text[p + 1] === '(') { stack.push({ k: 'code', depth: 0 }); p += 2; return }
      p++; return
    }
    if (dialect !== 'cmd' && c === '#' && tokenStart(p)) { const j = text.indexOf('\n', p); p = j < 0 ? text.length : j; return }
    if (dialect === 'ps' && c === '<' && text[p + 1] === '#') { const j = text.indexOf('#>', p + 2); p = j < 0 ? text.length : j + 2; return }
    if (dialect === 'ps' && c === '`') { p += 2; return }
    if (dialect === 'posix' && c === '\\') { p += 2; return }
    if (c === "'" && dialect !== 'cmd') { stack.push({ k: 'sq' }); p++; return }
    if (c === '"') { stack.push({ k: 'dq' }); p++; return }
    if (c === '(') { top.depth++; p++; return }
    if (c === ')') {
      if (top.depth > 0) top.depth--
      else if (stack.length > 1) stack.pop()
      p++; return
    }
    p++
  }
  return {
    isCode(pos: number): boolean {
      while (p < pos) step()
      return p === pos && stack[stack.length - 1].k === 'code'
    },
    // Bodies are lifted in the order of the text, so the ranges arrive sorted.
    skip(from: number, to: number): void { skips.push([from, to]) },
  }
}

function liftBodies(run: Run, text: string, dialect: Dialect = 'ps'): string {
  let out = ''
  let last = 0
  const noClose = new Set<string>()
  const scanner = codeScanner(text, dialect)
  HERE_STRING_OPEN.lastIndex = 0
  for (let m = HERE_STRING_OPEN.exec(text); m !== null; m = HERE_STRING_OPEN.exec(text)) {
    const q = m[1]
    if (noClose.has(q)) { if (noClose.size === 2) break; continue }
    // Only an opener where a new word starts, in code: never in a comment or a string.
    // A parameter's value glued on with a colon (`-Destination:@'`) is one too (review 2026-11-24, seventh, P10).
    const glued = dialect === 'ps' && text[m.index - 1] === ':' && /(?:^|\s)-[A-Za-z][\w-]*:$/.test(text.slice(Math.max(0, m.index - 64), m.index))
    if (!(m.index === 0 || /[\s(=;|&,{[+]/.test(text[m.index - 1]) || glued) || !scanner.isCode(m.index)) continue
    const bodyStart = m.index + m[0].length
    const close = text.indexOf(`\n${q}@`, bodyStart)
    // An opener with no closer is text: the scan goes on past its two characters as code.
    if (close < 0) { noClose.add(q); scanner.skip(m.index, m.index + 2); continue }
    const end = close + 3
    const body = text.slice(bodyStart, close).replace(/\r$/, '')
    run.bodies.push({ text: body, use: null, q, ...(q === '"' ? { expands: true as const } : {}) })
    out += `${text.slice(last, m.index)} ${sentinel(run, { k: 'here', body: run.bodies.length - 1, orig: text.slice(m.index, end) })} `
    last = end
    scanner.skip(m.index, end)
    HERE_STRING_OPEN.lastIndex = end
  }
  out += text.slice(last)
  return liftHereDocs(run, out, dialect)
}

function liftHereDocs(run: Run, out: string, dialect: Dialect = 'ps'): string {
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
  const scanner = codeScanner(out, dialect)
  HERE_DOC.lastIndex = 0
  for (const m of out.matchAll(HERE_DOC)) {
    if (lifted >= MAX_HERE_DOCS) break
    const at = m.index ?? 0
    if (at >= skipFrom && at < skipTo) continue
    // Only an opener in code: never in a comment or a string (review 2026-11-23, fourth).
    if (!scanner.isCode(at + m[1].length)) continue
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
    run.bodies.push({ text: out.slice(bodyStart, Math.max(bodyStart, bodyEnd - 1)), use: null, ...(m[3] === '' ? { expands: true as const, q: 'doc' } : {}) })
    scanner.skip(bodyStart, after)
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
  // Review 2026-11-23 (fourth): an alias or a function defined in the command changes what a command name
  // runs (`Set-Alias Get-Content Remove-Item; Get-Content D:\x -Recurse`, measured to take effect), and no
  // honest command of past runs defines one.
  [/(?:^|[;&|(\n{]|&&|\|\|)\s*(?:Set-Alias|New-Alias|Import-Alias|sal|nal|ipal)\b/i, 'an alias defined in the command, which changes what a command name runs'],
  [/\b(?:New-Item|Set-Item|ni|si|Copy-Item|cpi|Rename-Item|rni)\b[^;\n|]*\b(?:alias|function):/i, 'an alias or a function defined through its drive, which changes what a command name runs'],
  [/\$\{?(?:alias|function):[\w-]+\}?\s*=(?!=)/i, 'an alias or a function defined through its drive, which changes what a command name runs'],
  // Brokers that start a program outside this run at another level: the scheduler, WMI's process creation,
  // the Run keys (review 2026-11-23, fourth). No mission needs them.
  [/\bschtasks(?:\.exe)?\b[^\n;|]*\/(?:create|change|run)\b|\b(?:Register-ScheduledTask|Set-ScheduledTask|New-ScheduledTaskAction|Start-ScheduledTask|Register-ScheduledJob)\b|(?:^|[;&|(\n]|&&|\|\|)\s*at(?:\.exe)?\s+(?:\\\\|\d{1,2}:\d{2})/i, 'the Task Scheduler, which runs a program outside this run'],
  [/\b(?:Invoke-WmiMethod|iwmi|Invoke-CimMethod|New-CimInstance)\b[^\n]*\bWin32_Process\b|\[wmiclass\][^\n]*Win32_Process|\bwmic(?:\.exe)?\b[^\n]*\bprocess\b[^\n]*\bcall\b[^\n]*\bcreate\b/i, 'WMI process creation, which runs a program outside this run'],
  [/\b(?:reg(?:\.exe)?\s+(?:add|import|copy|load|restore)|New-ItemProperty|Set-ItemProperty|New-Item|Set-Item|Copy-ItemProperty|sp|si|ni)\b[^\n]*\\CurrentVersion\\(?:Run|RunOnce|RunServices|RunServicesOnce|Policies\\Explorer\\Run)\b/i, 'a Run key, which runs a program at the next sign-in'],
  // Review 2026-11-24 (sixth): every other change to a scheduled task or a service (the owner keeps tasks
  // disabled on purpose), `runas`, and a file-system drive made through the engine API, whose root the scan
  // cannot read.
  [/\bschtasks(?:\.exe)?\b[^\n;|]*\/(?:delete|end)\b|\b(?:Enable|Disable|Unregister|Stop)-ScheduledTask\b|\b(?:New|Set|Remove|Start|Stop|Restart)-Service\b|(?:^|[;&|(\n]|&&|\|\|)\s*sc(?:\.exe)?\s+(?:create|config|delete|start|stop|failure)(?=\s)|(?:^|[;&|(\n]|&&|\|\|)\s*runas(?:\.exe)?\s/i, 'a scheduled task, a service or runas, which runs a program outside this run'],
  [/\.SessionState\.Drive\.New\s*\(/i, 'a drive made through the engine API, whose root cannot be read'],
  // Review 2026-11-24 (eighth): a process object whose properties name the program and its arguments, a shell handed a
  // command line through a here-string or a process substitution, a trap's action, and awk's own command runner and
  // redirections, none of which the scan reads as the command line it is.
]

/**
 * A process object (`New-Object System.Diagnostics.Process`, `[Diagnostics.Process]::new()`, a `ProcessStartInfo`)
 * starts the program its properties name (review 2026-11-24, eighth: it was not seen at all). With one literal
 * `FileName` and at most one literal `Arguments` and no other property set, that command line is read where it
 * stands; anything else is a command the scan cannot read.
 */
const PROCESS_OBJECT = /\bNew-Object\s+(?:-TypeName\s+)?(?:System\.)?Diagnostics\.Process(?:StartInfo)?\b|\[(?:System\.)?Diagnostics\.Process(?:StartInfo)?\]::new\s*\(|\.StartInfo\b/i
function processObject(run: Run, text: string, base: string, via: string, depth: number, o: PayloadOpts): void {
  const sets = [...text.matchAll(/\.(?:StartInfo\.)?(\w+)\s*=(?!=)\s*('[^'\n]*'|"[^"$`\n]*"|[^;\n]*)/g)]
  const file = sets.filter(m => /^FileName$/i.test(m[1]))
  const args = sets.filter(m => /^Arguments$/i.test(m[1]))
  const other = sets.filter(m => !/^(?:FileName|Arguments|UseShellExecute|CreateNoWindow|RedirectStandard\w+|WindowStyle)$/i.test(m[1]))
  const lit = (m: RegExpMatchArray | undefined) => (m === undefined ? '' : stringValue(m[2].trim(), true))
  const f = lit(file[0])
  const a = lit(args[0])
  if (file.length !== 1 || args.length > 1 || other.length > 0 || f === null || f === '' || a === null || /\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(\s*\$/i.test(text)) {
    markSelfBuilding(run, 'a process object, which starts the program its properties name'); return
  }
  const line = a === '' ? f : `${f} ${a}`
  run.out.texts.push(line)
  scanPayload(run, line, base, `${via}>process`, depth + 1, 'shell', { dialect: 'ps', baseUnreadable: o.baseUnreadable })
}

/**
 * In a POSIX shell's text only (in PowerShell `<<<` is an error and runs nothing): a shell handed a command line through a
 * here-string or a process substitution (review 2026-11-24, eighth).
 */
const POSIX_MARKER = /(?:^|[\s;&|(\n{])(?:ba|z|da|k)?sh(?:\.exe)?\s+(?:-\w+\s+)*<<<|(?:^|[;&|(\n{]|&&|\|\|)\s*(?:source|\.)\s+<\(/i

/** A function that takes the name of a command the scan reads (`function Sort-Object { ... }`): it runs instead of it. */
function shadowingFunction(text: string): string | null {
  for (const m of text.matchAll(/(?:^|[;&|(\n{]|&&|\|\|)\s*(?:function|filter)\s+(?:(?:global|script|local|private):)?([\w-]+)/gi)) {
    const name = m[1].toLowerCase()
    if (KNOWN_COMMANDS.has(name)) return `a function named ${m[1]}, which runs in place of that command`
  }
  return null
}

/** Markers that only an inline program carries. */
function codeMarker(code: string): string | null {
  if (/\bos\.(?:exec|spawn)[lv]p?e?\s*\(|\bos\.posix_spawnp?\s*\(/.test(code)) return 'a program started through os.exec* or os.spawn*'
  if (/\bctypes\b/.test(code)) return 'ctypes, which calls the system directly'
  if (/\bgetattr\s*\(\s*(?:__import__\(\s*['"](?:os|shutil|subprocess|pathlib)['"]\s*\)|os\b|shutil\b|subprocess\b|pathlib\b)/.test(code)) return 'a call looked up by name, which cannot be read'
  if (/(?<![\w.$])(?:eval|exec|Function)\s*\(\s*(?!['"`])[^)\s]/.test(code)) return 'eval or exec of text built at run time'
  return null
}

/**
 * `Invoke-Expression 'python --version'`, `iex "npm test"`: a single literal string with nothing PowerShell expands
 * in it is a command written out, read as PowerShell text where it stands (review 2026-11-24, seventh); any other
 * use of iex builds the text it runs.
 */
const LITERAL_IEX = /(?:^|[\s;|&({])(?:Invoke-Expression|iex)\s+(?:-Command\s+)?('[^'\n]*'|"[^"$`\n]*")(?=\s*(?:$|[;\n|)}]))/gi
function literalIexRemoved(text: string): string {
  return /\b(?:Invoke-Expression|iex)\b/i.test(text) ? text.replace(LITERAL_IEX, (m: string, s: string) => m.slice(0, m.length - s.length).replace(/(?:Invoke-Expression|iex)\s+(?:-Command\s+)?$/i, ' ')) : text
}

function findMarker(text0: string): string | null {
  const text = literalIexRemoved(text0)
  for (const [re, name] of MARKERS) if (re.test(text)) return name
  const shadow = /\b(?:function|filter)\s/i.test(text) ? shadowingFunction(text) : null
  if (shadow !== null) return shadow
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
      // A body glued after other text is a part of the word the scan cannot read, never nothing (review
      // 2026-11-24, seventh, P10).
      case 'here': if (text === '') here = e.body; else text += UNREAD; break
      case 'doc': if (text === '') doc = e.body; else text += UNREAD; break
    }
  }
  if (tilde && /^~(?:[\\/]|$)/.test(text)) { text = run.homes.home + text.slice(1); anchor = 'home' }

  if (text.includes(PIPE)) pipe = true
  return { text, anchor, pipe, here, doc, leadUnset, leadName }
}

type Cand = { path: string; children: boolean; device: boolean; relative: boolean } | 'unreadable' | null

/**
 * The loopback spellings of an administrative share's host this list holds (wave 15c, N10), and no others:
 * `localhost`, a decimal dotted 127 address in two to four parts (`127.1`, `127.0.1`, `127.0.0.1`), each of these
 * with a trailing dot, `[::1]` and `0--1.ipv6-literal.net`. Shared with `canonPath` (`toolPaths.ts`). Any other
 * spelling Windows also resolves to this machine stays a share here, which refuses a write (wave 19, C7: the
 * decimal `2130706433`, hex `0x7f.1` and octal `0177.0.0.1` forms, a longer IPv6 literal name such as
 * `0--0-0-0-0-0-0-1.ipv6-literal.net`, this machine's own name and its network addresses); the path check refuses
 * the audit and guard folders through any host's share (`judgePath`).
 */
export const ADMIN_SHARE_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){1,3}|\[::1\]|0--1\.ipv6-literal\.net)\.?`
const ADMIN_SHARE = new RegExp(String.raw`^[\\/]{2}${ADMIN_SHARE_HOST}[\\/]([A-Za-z])\$(?=[\\/]|$)(.*)$`, 'i')

const DRIVE_ABS = /^[A-Za-z]:(?:[\\/]|$)/
const DRIVE_REL = /^[A-Za-z]:(?![\\/])/
const UNC = /^[\\/]{2}[^\\/?.]/

/** Whether a word is a path, and which (finding 2.M4: `\` and `/` are both separators on every platform). */
function toPath(run: Run, text0: string, relAllowed: boolean, base: string, anchored: boolean, msysRoot = false, strict = false): Cand {
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
  // The local administrative share is the local drive (wave 15: `\\localhost\C$\Users\<owner>\.cache` read as a
  // network share): `\\localhost\X$`, `\\127.0.0.1\X$` and the `\\?\UNC\` forms of both, and since wave 15c the
  // other loopback spellings `ADMIN_SHARE_HOST` lists (any spelling it does not list stays a share: wave 19, C7).
  const adminShare = run.platform === 'win32' && !device ? s.match(ADMIN_SHARE) : null
  if (adminShare) s = `${adminShare[1].toUpperCase()}:${adminShare[2] === '' ? '\\' : adminShare[2]}`
  let children = false
  let placeholders = false
  if (device) {
    const uIdx = s.indexOf(UNREAD)
    if (uIdx >= 0) {
      const prefix = s.slice(0, uIdx)
      const lastSep = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'))
      if (lastSep < 0 || strict) return 'unreadable'
      s = prefix.slice(0, lastSep + 1)
      children = true
    }
    return { path: s, children, device: true, relative: false }
  }
  if (s.includes(UNREAD) || s.includes(NAME) || s.includes(DESC) || WILDCARD.test(s)) {
    // Review 2026-11-24, eighth (blocker): a part the scan cannot read, a made name or a wildcard no longer cuts
    // the word and throws away what follows it. Each segment is classed: one holding a part that can be
    // anything (UNREAD) ends what can be read, and a `..` after it is unreadable, since the part may hold
    // separators and climbs of its own; one holding only a made name (NAME) or a wildcard is one name, which a
    // `..` after it cancels exactly as the provider resolves it (`Resolve-Path "C:\Win*\..\Users"` is C:\Users,
    // measured); one holding items under a folder at any depth (DESC) is unreadable when a `..` follows. Every
    // other segment is resolved as written, and the word is cut only at a placeholder that survives.
    const drive = s.match(/^[A-Za-z]:/)?.[0] ?? ''
    const toks = s.slice(drive.length).match(/[^\\/]+|[\\/]+/g) ?? []
    const isSep = (t: string) => /^[\\/]/.test(t)
    const special = (t: string) => WILDCARD.test(t) || t.includes(NAME) || t.includes(DESC)
    let uAt = -1
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]
      if (isSep(t)) continue
      // Made names and dots only (`"$(Get-Date -f .)."`): the segment may be `..` itself.
      const onlyDots = t.includes(NAME) && /^[.\u0007]+$/.test(t) && (t.includes('.') || (t.match(/\u0007/g) ?? []).length > 1)
      // A POSIX glob that can match `.` or `..` (`.*`, `..?`) climbs through it (bash without globskipdots).
      const dotGlob = msysRoot && WILDCARD.test(t) && /^\.[.*?]*$/.test(t.replace(/\[[^\]]*\]/g, '?')) && toks.slice(k + 1).some(x => !isSep(x))
      if (t.includes(UNREAD) || onlyDots || dotGlob) { uAt = k; break }
    }
    const climbAfter = (from: number) => toks.slice(from + 1).some(t => t === '..')
    if (uAt >= 0) {
      // An unread part with nothing before it is the whole word; a mutation through an unread part, or a climb
      // written after one, cannot be judged where it lands.
      if (climbAfter(uAt) || strict || uAt === 0) return 'unreadable'
      toks.length = uAt
      children = true
      if (drive === '' && toks.join('').replace(/[\\/]/g, '') === '' && !anchored) return 'unreadable'
    }
    const descAt = toks.findIndex(t => !isSep(t) && t.includes(DESC))
    if (descAt >= 0 && climbAfter(descAt)) return 'unreadable'
    // A first word with no folder before it that is one placeholder (`*.log`): names in the working folder;
    // where no relative word is allowed it is not a path at all.
    const t0 = toks[0]
    if (drive === '' && t0 !== undefined && !isSep(t0) && special(t0) && !anchored && !relAllowed) return null
    s = drive + toks.map(t => (!isSep(t) && special(t) ? (placeholders = true, PLACEHOLDER) : t)).join('')
    if (s === '') s = '.'
  }
  const isDriveAbs = DRIVE_ABS.test(s)
  const isDriveRel = DRIVE_REL.test(s) && !isDriveAbs
  const isUnc = UNC.test(s)
  const isPosixAbs = !isUnc && /^[\\/]/.test(s)
  const hasDotDot = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)
  const relative = !isDriveAbs && !isDriveRel && !isUnc && !isPosixAbs && !anchored
  if (relative && !hasDotDot && !relAllowed) return null
  let path = resolveFor(run.platform, base, s, { isDriveAbs, isDriveRel, isUnc, isPosixAbs }, msysRoot)
  if (placeholders) {
    // Cut at the first placeholder that survived the resolution: the names a glob or a made name stands for
    // are inside the folder before it.
    const at = path.indexOf(PLACEHOLDER)
    if (at >= 0) {
      const P = run.platform === 'win32' ? nodePath.win32 : nodePath.posix
      path = P.dirname(path.slice(0, at) + 'x')
      children = true
    }
  }
  return { path, children, device: false, relative }
}

function resolveFor(platform: Platform, base: string, s: string,
  k: { isDriveAbs: boolean; isDriveRel: boolean; isUnc: boolean; isPosixAbs: boolean }, msysRoot = false): string {
  if (platform === 'posix') {
    if (k.isDriveAbs || k.isUnc || k.isDriveRel) return s
    return nodePath.posix.resolve(base.replace(/\\/g, '/'), s.replace(/\\/g, '/'))
  }
  let w = s.replace(/\//g, '\\')
  if (k.isPosixAbs && !k.isUnc) {
    // A WSL mount (`/mnt/d/DCIM`) is that drive (review 2026-11-24, sixth); so is an msys drive (`/d/DCIM`),
    // and, in a POSIX shell's reading or with a trailing separator, the drive's root itself (`/d`, `/d/`).
    // Cygwin's `/cygdrive/c/...` too (wave 15: it read as a folder `cygdrive` at the root of the current drive).
    const mnt = w.match(/^\\(?:mnt|cygdrive)\\([A-Za-z])(?:\\(.*))?$/)
    const msys = w.match(/^\\([A-Za-z])\\(.*\S.*)$/)
    if (mnt) w = `${mnt[1].toUpperCase()}:\\${mnt[2] ?? ''}`
    else if (msys && msys[2].replace(/\\/g, '') !== '') w = `${msys[1].toUpperCase()}:\\${msys[2]}`
    else if (/^\\[A-Za-z]\\$/.test(w) || (msysRoot && /^\\[A-Za-z]$/.test(w))) w = `${w[1].toUpperCase()}:\\`
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
  const stack: Array<{ seg: Seg; opener: string; hadWords: boolean; at: number; redirect?: string }> = []
  // A redirect followed by a group (`> (Join-Path $env:TEMP "sim-$_.txt")`): PowerShell evaluates the group and writes
  // to what it makes (measured; review 2026-11-24, eighth, C5). Its value is the redirect's target when the group is
  // one value the scan reads (`expressionWord`), unreadable otherwise.
  let redirectGroup: string | null = null
  let pending: string | null = null
  // A set, not a search of the list: a text of many statements has as many segments (review 2026-11-23, third, cost).
  const added = new Set<Seg>()
  // A pipeline element that is only a group (`@('D:\x') | ...`, `& { process { ... } } | ...`) is kept too: what
  // it hands on is judged by its group (review 2026-11-23, fourth).
  const close = (s: Seg) => { if ((s.words.length || s.redirects.length || s.groups.length || s.call) && !added.has(s)) { added.add(s); segs.push(s) } }
  const touch = (s: Seg, a: number, b: number) => { s.start = Math.min(s.start, a); s.end = Math.max(s.end, b) }
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti]
    if (t.kind === 'w') {
      if (pending !== null) { cur.redirects.push({ op: pending, target: t }); pending = null }
      else cur.words.push(t)
      touch(cur, t.start, t.end)
      continue
    }
    if (pending !== null && (t.op === '(' || t.op === '$(')) { redirectGroup = pending; pending = null }
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
        stack.push({ seg: cur, opener: t.op, hadWords: cur.words.length > 0, at: t.start, ...(redirectGroup !== null ? { redirect: redirectGroup } : {}) })
        redirectGroup = null
        cur = mk(nextPipe++, 0, cur.pipeline, cur.pipeIndex)
        // `.Name(` or `::Name(` right before the parenthesis: the arguments of a method call.
        if (t.op === '(' && /(?:\.|::)[A-Za-z_]\w*$/.test(text.slice(Math.max(0, t.start - 128), t.start))) cur.methodArgs = true
        break
      }
      case ')': case '}': {
        const top = stack.pop()
        const group = top ? { start: top.at, end: t.end, opener: top.opener } : null
        if (top && top.redirect !== undefined && group) {
          const target = expressionWord(cur, text)
          top.seg.redirects.push({ op: top.redirect, target })
          touch(top.seg, group.start, group.end)
          close(cur)
          cur = top.seg
          break
        }
        const next = toks[ti + 1]
        // A group followed at once by a member or an index (`(Get-ChildItem $HOME).FullName`,
        // `(gci D:\)[0].FullName`) is one operand whose value cannot be read (review 2026-11-23).
        // At the head of a pipeline (`(Get-Item .).Parent.GetDirectories() | ...`) it is the same: an
        // unreadable value, and the group's own items are not what flows on (review 2026-11-23, third).
        if (top && top.opener !== '{' && group && next?.kind === 'w' && next.start === t.end
          && /^(?:\.|\[|::)/.test(next.pieces.map(p => p.t).join(''))) {
          // `(Get-ChildItem -Recurse -Filter *.pyc).FullName`: the path of each item of a literal listing,
          // which is inside the folder listed (review 2026-11-23, fourth).
          const member = next.pieces.map(p => p.t).join('')
          const items = /^\.(?:FullName|Path|PSPath)$/i.test(member) ? itemSourceValues(text.slice(top.at + top.opener.length, t.start)) : null
          // The items of a listing read are a value, the same at the head of a pipeline as among the operands
          // (review 2026-11-24, seventh: at the head the word was read as a program, and the flow as opaque).
          const w: WordTok = { kind: 'w', pieces: items !== null ? itemPieces(items) : [{ t: UNREAD, q: 'n' }], start: group.start, end: next.end, subs: [] }
          top.seg.words.push(w)
          touch(top.seg, w.start, w.end)
          top.seg.subexpr = true
          top.seg.groups.push(group)
          if (items === null) cur.transformed = true
          close(cur)
          cur = top.seg
          ti++
          break
        }
        if (top && top.opener !== '{' && top.hadWords) {
          // An expression group handed to a path verb (`Remove-Item ($env:USERPROFILE + '\.x')`) or to an
          // interpreter (`cmd /c ("rd /s /q " + "D:\x")`, review 2026-11-23, fourth) is one of its operands; any
          // other group is a subexpression whose value cannot be read.
          // After an assignment (`$d = New-Item -Path (Join-Path ...)`) the command is the word after `=`.
          const ws = top.seg.words
          const head = ws.length >= 3 && ws[1].pieces.length === 1 && ws[1].pieces[0].q === 'n' && ws[1].pieces[0].t === '=' ? ws[2] : ws[0]
          const pathVerb = head !== undefined && isPathVerb(head)
          let merged = head !== undefined && (pathVerb || isInterpreter(verbName(head.pieces.map(p => p.t).join('')))) ? expressionWord(cur, text) : null
          // `Remove-Item (Get-ChildItem .\out -Filter *.tmp)`, `Remove-Item (Resolve-Path .\out\*.tmp)`: the items of a
          // listing read, as a word of their own (review 2026-11-24, seventh).
          if (merged === null && pathVerb && top.opener !== '{' && cur.groups.length === 0 && cur.redirects.length === 0) {
            const items = itemSourceValues(text.slice(top.at + top.opener.length, t.start))
            if (items !== null) merged = { kind: 'w', pieces: itemPieces(items), start: group?.start ?? top.at, end: t.end, subs: [] }
          }
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

/** The items of a listing as one value word: a list of quoted items when there are several. */
function itemPieces(items: string[]): Piece[] {
  const out: Piece[] = []
  items.forEach((v, k) => { if (k > 0) out.push({ t: ',', q: 'n' }); out.push({ t: v, q: 's' }) })
  return out
}

function isPathVerb(w: WordTok): boolean {
  const v = verbName(w.pieces.map(p => p.t).join(''))
  return DELETE_VERBS.has(v) || MOVE_VERBS.has(v) || WRITE_TARGET_FIRST.has(v) || WRITE_ALL.has(v) || NEW_ITEM.has(v)
    || COPY_VERBS.has(v) || ARCHIVE_VERBS.has(v) || READ_VERBS.has(v) || LIST_VERBS.has(v) || NOTHING_VERBS.has(v)
    || CD_VERBS.has(v) || v === 'robocopy' || v === 'mklink' || v === 'ln'
}

/** A group that is a value (a variable, an anchor, a quoted string, or such pieces joined by `+`), as one word. */
function expressionWord(inner: Seg, text?: string): WordTok | null {
  // A group inside it (`@('.uild', ([char]68+':\DCIM'))`) is a part the scan cannot read: not one word (review of wave 5).
  if (inner.words.length === 0 || inner.redirects.length) return null
  const groups = inner.groups.filter(g => g.opener !== '{')
  if (groups.length === 0) return wordsExpression(inner.words)
  // Except one group that only makes a fresh name, written last (`Join-Path $env:TEMP (Get-Random)`, `'.\b\db-{0:yyyyMMdd}.db'
  // -f (Get-Date)`): a name the scan cannot read, inside the folder before it (review 2026-11-24, seventh).
  // Every group a name maker (review 2026-11-24, eighth: `('save-' + (Get-Date -Format yyyyMMdd) + '.json')`), in its place.
  if (text === undefined || groups.length !== inner.groups.length) return null
  // A group that is an item's leaf name with a literal ending (`($_.BaseName + '.txt')`) is that leaf (eighth review, C1).
  const leafOf = (t: string): string | null => {
    const m = t.match(new RegExp(`^\\s*(${S0}\\d+${S1})\\.(?:Name|BaseName)\\s*\\+\\s*(['"])([^'"\\\\/$]*)\\2\\s*$`, 'i'))
    return m && !m[3].includes('..') ? `${m[1]}${ITEM_LEAF}${m[3]}` : null
  }
  const kinds = groups.map(g => { const t = text.slice(g.start, g.end).trim().replace(/^\$?\(([\s\S]*)\)$/, '$1'); return madeKind(t) ?? leafOf(t) })
  if (kinds.some(k => k === null)) return null
  const made: WordTok[] = groups.map((g, k) => ({ kind: 'w', pieces: [{ t: kinds[k] as string, q: 's' }], start: g.start, end: g.end, subs: [] }))
  return wordsExpression([...inner.words, ...made].sort((a, b) => a.start - b.start))
}

/**
 * The words of a PowerShell comma list written with spaces (`'a', 'b'`, `'a' ,'b'`) joined into the one
 * argument PowerShell binds them as (review 2026-11-23, fourth: `Start-Process cmd '/c', 'rd ...'` was read
 * as a list of one). A word that is a parameter name is never joined into a list.
 */
function joinCommaToks<T extends Tok>(toks: T[], groups: Seg['groups'] = []): T[] {
  const out: T[] = []
  // The word being joined is a copy owned here, grown in place: a copy per element was quadratic in a long list.
  let own: WordTok | null = null
  for (const t of toks) {
    const prev = out[out.length - 1]
    // Never across a group written between them (review of wave 5: `Remove-Item (Split-Path $PWD), .\build`
    // joined the command name into a list and the delete was read as a value).
    if (t.kind === 'w' && prev?.kind === 'w' && !groups.some(g => g.opener !== '{' && g.start >= prev.end && g.end <= t.start)) {
      const pw = prev as WordTok
      const pl = pw.pieces[pw.pieces.length - 1]
      const tf = t.pieces[0]
      const isParam = tf?.q === 'n' && /^-[A-Za-z]/.test(tf.t)
      if (!isParam && ((pl?.q === 'n' && pl.t.endsWith(',')) || (tf?.q === 'n' && tf.t.startsWith(',')))) {
        if (own !== pw) { own = { ...pw, pieces: [...pw.pieces], subs: [...pw.subs] }; out[out.length - 1] = own as T }
        for (const p of t.pieces) own.pieces.push(p)
        for (const s of t.subs) own.subs.push(s)
        own.end = t.end
        continue
      }
    }
    out.push(t)
  }
  return out
}

/** A value made of words (a literal, a variable, such pieces joined by `+`, or `-f` over literals), as one word; null when it is not one. */
function wordsExpression(ws0: WordTok[]): WordTok | null {
  const ws = joinCommaToks(ws0)
  if (ws.length === 0) return null
  const formatted = formatWord(ws)
  if (formatted !== null) return formatted
  // `Join-Path a b` over two words is `a\b` (review 2026-11-23, fourth: a delete through it was refused
  // as unread once an unread target is refused).
  if (ws[0].pieces.length === 1 && ws[0].pieces[0].q === 'n' && /^join-path$/i.test(ws[0].pieces[0].t)) {
    const parts = ws.slice(1).filter(w => !(w.pieces.length === 1 && w.pieces[0].q === 'n' && /^-(?:path|childpath)$/i.test(w.pieces[0].t)))
    if (parts.length !== 2 || parts.some(w => w.pieces[0]?.q === 'n' && w.pieces[0].t.startsWith('-'))) return null
    return { kind: 'w', pieces: [...parts[0].pieces, { t: '\\', q: 's' }, ...parts[1].pieces], start: ws[0].start, end: ws[ws.length - 1].end, subs: ws.flatMap(w => w.subs) }
  }
  // `$_.FullName -replace '\.log$', '.old'`: a new ending for the name, in the same folder (eighth review, C4). The
  // pattern is anchored at the end and holds no separator, class or wildcard; the replacement holds no separator.
  if (ws.length === 3 && ws[1].pieces.length === 1 && ws[1].pieces[0].q === 'n' && /^-[ci]?replace$/i.test(ws[1].pieces[0].t)) {
    const args = ws[2].pieces
    const pat = args.length >= 3 && args[0].q !== 'n' ? args[0].t : null
    const rep = args.length >= 3 && args[1].q === 'n' && args[1].t === ',' && args[2].q !== 'n' ? args.slice(2).map(p => p.t).join('') : null
    if (pat !== null && rep !== null && args.slice(2).every(p => p.q !== 'n') && /^(?:\\\.|[A-Za-z0-9_-])+\$$/.test(pat) && /^[A-Za-z0-9_.-]*$/.test(rep) && !rep.includes('..')) {
      return { kind: 'w', pieces: [...ws[0].pieces, { t: NAME, q: 's' }], start: ws[0].start, end: ws[2].end, subs: ws[0].subs }
    }
  }
  const first = ws[0].pieces[0]
  // A first piece the scan cannot read (`(Get-PSDrive D).Root + 'x'`) still makes one word: an unreadable one
  // (review 2026-11-23, fourth).
  if (!first || !(first.q !== 'n' || first.t.startsWith(S0) || first.t.startsWith('$') || first.t.startsWith(UNREAD))) return null
  if (ws.length % 2 === 0) return null
  for (let k = 1; k < ws.length; k += 2) if (ws[k].pieces.map(p => p.t).join('') !== '+') return null
  const pieces: Piece[] = []
  for (let k = 0; k < ws.length; k += 2) pieces.push(...ws[k].pieces)
  // `$_.BaseName + '.txt'`: the item's leaf name, then quoted text (ITEM_LEAF), never a member chain (eighth review, C1).
  for (let k = 0; k + 1 < pieces.length; k++) {
    if (pieces[k].q === 'n' && pieces[k + 1].q !== 'n' && new RegExp(`${S1}\\.(?:Name|BaseName)$`, 'i').test(pieces[k].t)) {
      pieces[k] = { ...pieces[k], t: pieces[k].t.replace(/\.(?:Name|BaseName)$/i, ITEM_LEAF) }
    }
  }
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
  // An argument is a quoted literal, a number, or a name the scan bound (`-f 3`, `-f $i`: review 2026-11-24, eighth, C6).
  const plain = new RegExp(`^(?:-?\\d+|${S0}\\d+${S1})$`)
  for (const p of ws[2].pieces) {
    if (p.q !== 'n') { cur = (cur ?? '') + p.t; continue }
    const parts = p.t.split(',')
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) { if (cur === null) return null; args.push(cur); cur = null }
      if (parts[k] === '') continue
      if (!plain.test(parts[k])) return null
      cur = (cur ?? '') + parts[k]
    }
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
const WRITE_TARGET_FIRST = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'start-transcript', 'set-itemproperty', 'set-acl', 'truncate',
  'export-csv', 'epcsv', 'export-clixml', 'export-formatdata'])
const WRITE_ALL = new Set(['tee-object', 'tee', 'mkdir', 'md', 'touch', 'icacls', 'attrib', 'takeown', 'chmod', 'chown'])
const NEW_ITEM = new Set(['new-item', 'ni'])
const COPY_VERBS = new Set(['copy-item', 'cpi', 'cp', 'copy', 'xcopy'])
const ARCHIVE_VERBS = new Set(['expand-archive', 'compress-archive'])
const READ_VERBS = new Set(['get-content', 'gc', 'cat', 'type', 'more', 'less', 'head', 'tail', 'get-item', 'gi', 'test-path',
  'resolve-path', 'convert-path', 'split-path', 'join-path', 'select-string', 'sls', 'grep', 'findstr', 'wc',
  'diff', 'fc', 'comp', 'compare-object', 'get-filehash', 'stat', 'file', 'du', 'measure-object',
  'where', 'which', 'get-command', 'import-csv', 'get-itemproperty'])
/**
 * Programs that read but can also write, delete or run a program through an option (review 2026-11-24, sixth:
 * as reads they let `rg --pre`, `pytest --basetemp`, `sort -o`, `uniq IN OUT` and `certutil -encode` through).
 */
const READER_WRITERS = new Set(['rg', 'pytest', 'sort', 'uniq', 'certutil'])
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
  'membername', 'pipelinevariable', 'pv', 'stackname',
  // PowerShell's pattern and string operators: their operand is a pattern or a text, never a path (review 2026-11-23).
  ...['match', 'notmatch', 'like', 'notlike', 'replace', 'split', 'join', 'contains', 'notcontains']
    .flatMap(o => [o, `c${o}`, `i${o}`])])
const RECURSIVE_FLAGS = new Set(['-recurse', '-r', '-rf', '-fr', '--recursive', '/s', '/mir', '-rec'])
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'env', 'xargs', 'parallel', 'start-process', 'saps', 'start', 'exec', 'command', 'nice', 'timeout', 'call'])

function verbName(w: string): string {
  // `@rd` in cmd is `rd` with its echo turned off.
  const base = w.replace(/^.*[\\/]/, '').replace(/^@(?=[A-Za-z])/, '').toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/** The single- and double-quoted stretches of a PowerShell text (a here-string's body is lifted out already). */
function quotedRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === '`') { k++; continue }
    if (c === "'" || c === '"') { const e = closingQuote(s, k, false); out.push([k, e]); k = e }
  }
  return out
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
  /** The quoted stretches of a PowerShell text, where a `.Method(` is not a call (`quotedRanges`). */
  quoted?: Array<[number, number]>
}

type Dialect = 'ps' | 'cmd' | 'posix'
type PayloadOpts = { dialect?: Dialect; baseUnreadable?: boolean; fielded?: boolean; ansiC?: boolean }

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

/** The first name inside a word that a loop bound to a list of elements, with that list (`listInside`). */
function listInside(run: Run, value: string): { at: string; list: string[] } | null {
  for (const m of value.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))) {
    const e = run.table[Number(m[1])]
    // A list a name was assigned (`$t = 'a','b'`) is read once per element too (review 2026-11-24, eighth: `"$($t[1])"`).
    if (e?.k === 'bound' && e.b.list && !e.b.item) return { at: m[0], list: e.b.list }
  }
  return null
}

/**
 * Each element of the word's list is emitted. An element the scan cannot read makes the whole word
 * unreadable, even when another element read (review of wave 5: `Remove-Item .\build, $x` with `$x`
 * unreadable was 'ok' and allowed); the elements that read are still emitted.
 */
function emitWord(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  let status: Emitted = 'none'
  let anyUnreadable = false
  // A list-bound name inside a longer word (`".\out\$d"`, `"$env:TEMP\part$i.txt"`): the word once per element,
  // so an element that climbs (`..\x`) is read as the path it makes (review 2026-11-24, sixth). Each element of a
  // comma list first (`$a, $b`: eighth review, the second name was read inside the first one's word).
  const parts = commaParts(w).flatMap(pw => {
    const list = boundList(ctx, pw)
    if (list !== null) return list.map(v => ({ ...literalWord(v), raw: w.raw }))
    const inner = listInside(ctx.run, pw.value)
    return inner !== null ? inner.list.map(v => ({ ...literalWord(pw.value.split(inner.at).join(v)), raw: w.raw })) : [pw]
  })
  for (const [n, part] of parts.entries()) {
    if ((n & 63) === 63 && overBudget(ctx.run)) break
    const r = emitOne(ctx, seg, part, op, o)
    if (r === 'unreadable') anyUnreadable = true
    if (r === 'ok') status = 'ok'
    else if (r !== 'none' && status === 'none') status = r
  }
  return anyUnreadable ? 'unreadable' : status
}

function emitOne(ctx: Ctx, seg: Seg | null, w: Word, op: PathOp, o: EmitOpts): Emitted {
  const values = w.quotedFirst !== null ? [w.quotedFirst, w.value] : [w.value]
  let status: Emitted = 'none'
  // A mutation one reading of which cannot be read is unreadable, whatever another reading of the word names (review
  // 2026-11-24, eighth: the quoted first piece of `('.\' + $x + '\..\..\.ssh')` read as the folder and hid the rest).
  let unreadSeen = false
  // An item of the registry, the environment, a function, a variable, an alias or a certificate is not a file.
  // Read on this word's own spelling, never on the whole list it came from (review 2026-11-24, seventh, P5: a
  // list whose first element was in such a provider let every later element through unjudged).
  if (ctx.dialect === 'ps' && isMut(op) && NON_FILE_PROVIDER.test(renderOrig(ctx.run, w.value).trim().replace(/^['"]/, ''))) return 'ok'
  // PowerShell's splatting (`Remove-Item @args`) hands the command a table the scan does not read.
  if (ctx.dialect === 'ps' && w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && splatOf(ctx.run, w.value) !== null) return 'unreadable'
  for (const v of values) {
    const x = expand(ctx.run, v, ctx.base, ctx.tilde)
    if (x.doc !== null) continue
    if (x.here !== null) {
      // A here-string used as a value (an operand, a variable bound to one, a group, the head of a
      // pipeline) is the text it holds: each line is a word (review 2026-11-23, third). One fed to an
      // interpreter is a program, read as one where it is consumed.
      if (seg !== null && seg.words[0]?.start === w.tok.start && hereFedAsText(ctx, seg)) continue
      const tail = x.text.startsWith(UNREAD) ? x.text.slice(1) : x.text
      for (const line of hereLines(ctx, x.here, true)) {
        const r = emitOne(ctx, seg, { ...literalWord(line.value + tail), raw: line.raw }, op, o)
        if (r === 'ok') status = 'ok'
        else if (r !== 'none' && status === 'none') status = r
        if (r === 'unreadable') unreadSeen = true
      }
      continue
    }
    let aroundItem = false
    // The leaf name of an item a listing of a literal folder hands the block (`Join-Path .\out $_.Name`,
    // `"out\$($_.Name)"`, `"$($_.BaseName).bak"`): one name, never a separator or `..`, so a placeholder name
    // is judged in its place (review 2026-11-24, seventh). From any other feed it is not read.
    if (x.pipe && seg !== null && ITEM_LEAF_RE.test(x.text) && itemFeed(ctx, seg)) {
      x.text = x.text.replace(new RegExp(ITEM_LEAF_RE.source, 'g'), 'cynco-item')
      x.pipe = x.text.includes(PIPE)
    }
    // The folder an item of a listing is in (`$_.DirectoryName`, `"$($_.DirectoryName)\x"`): the folder listed, or a
    // folder under it for a recursive listing (review 2026-11-24, eighth, C1).
    if (x.pipe && seg !== null && ITEM_DIR_RE.test(x.text)) {
      const dir = itemFolder(ctx, seg)
      if (dir !== null) { x.text = x.text.replace(new RegExp(ITEM_DIR_RE.source, 'gi'), () => dir); x.pipe = x.text.includes(PIPE) }
    }
    // A name a `-Name` listing printed, written after a folder (`".\out\$_"`, `Join-Path .\out $_`): a relative path
    // under the folder listed, never a climb, so it is a name under what the text before it names (eighth review, C4).
    if (x.pipe && seg !== null && /[^\u0005]\u0005(?![.\w])/.test(x.text) && nameFeed(ctx, seg)) {
      x.text = x.text.replace(/\u0005(?![.\w])/g, DESC)
      x.pipe = x.text.includes(PIPE)
    }
    // An item's own path with a suffix written as text (`"$($_.FullName).bak"`, `($_.FullName + '.bak')`, a `-replace` of
    // its ending): a name beside the item, in the folder the item is in, judged as the item (eighth review, C4).
    if (x.pipe && itemWithSuffix(ctx, w, x.text)) x.text = PIPE
    if (x.pipe) {
      // The pipeline's item first (`$_`, `$_.FullName`, `"$_\obj"`): what the earlier elements named. A
      // member that is not the item's own path (`$_.Parent.FullName`, `$_.Directory`, `$_.Name`) names
      // something else, which the scan cannot read (review 2026-11-23, fourth).
      // `".\$_"` is the item named relative to the current folder, as a value item already is (review
      // 2026-11-23, fourth: `'build','dist' | % { Remove-Item ".\$_" }`).
      if (/^\.[\\/]\u0005/.test(x.text)) x.text = x.text.slice(2)
      // A name under the item that climbs (`"$_\..\..\x"`) is not the item (review 2026-11-24, seventh).
      if (/\u0005[^\u0005]*(?:^|[\\/])\.\.(?:[\\/]|$)/.test(x.text)) { { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }; continue }
      // `"$_\a.txt"` in a block fed by a list of values (`'build','dist' | % { ... "$_\a.txt" }`): the word once per
      // value (review 2026-11-24, sixth).
      const vals = seg !== null && /^\u0005[\\/]/.test(x.text) ? feedLiterals(ctx, seg, true) : null
      if (vals !== null) {
        for (const lit of vals) {
          const val = v.replace(new RegExp(`${S0}(\\d+)${S1}`, 'g'), (m: string, n: string) => (ctx.run.table[Number(n)]?.k === 'p' ? lit : m))
          const r = emitOne(ctx, seg, { ...literalWord(val), raw: w.raw }, op, o)
          if (r === 'ok') status = 'ok'
          else if (r !== 'none' && status !== 'ok') status = r
          if (r === 'unreadable') unreadSeen = true
        }
        continue
      }
      if (x.text.startsWith(PIPE)) {
        const members = (x.text.slice(1).match(/^(?:\.\w+)+/)?.[0] ?? '').split('.').filter(Boolean)
        if (members.some(m => !PATH_MEMBERS.has(m.toLowerCase()))) { { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }; continue }
        if (status === 'none') status = 'pipe'
        continue
      }
      // A block fed a list of plain names or a range (`'a.txt','b.txt' | % { Remove-Item ".\out\$_" }`,
      // `1..3 | % { ... ".\out\run$_.log" }`): the word once per value (review 2026-11-24, sixth).
      // In a double-quoted word `.log` after `$_` is text, not a member.
      const lits = seg !== null && (!/\u0005\./.test(x.text) || w.tok.pieces.some(pc => pc.q === 'd' && pc.t.includes(S0))) ? feedLiterals(ctx, seg) : null
      if (lits !== null) {
        for (const lit of lits) {
          const val = v.replace(new RegExp(`${S0}(\\d+)${S1}`, 'g'), (m: string, n: string) => (ctx.run.table[Number(n)]?.k === 'p' ? lit : m))
          const r = emitOne(ctx, seg, { ...literalWord(val), raw: w.raw }, op, o)
          if (r === 'ok') status = 'ok'
          else if (r !== 'none' && status !== 'ok') status = r
          if (r === 'unreadable') unreadSeen = true
        }
        continue
      }
      // `ls out | xargs -I % rm out/%`: a line a listing inside the working folder printed (a name or a relative path
      // that never climbs), with text around it: a name inside what the text before it names (review 2026-11-24, seventh).
      if (seg !== null && xargsItemIn(ctx, v) && listingFlowInside(ctx, seg)) {
        x.text = x.text.replace(/\u0005/g, 'cynco-item')
        x.pipe = false
      } else {
        // Text before it (`"D:\$_"`, `"$HOME\$_"`): the item is a name the scan cannot read, inside what
        // the text before it names (review 2026-11-23).
        x.text = x.text.replace(/\u0005(?:\.\w+)*/g, UNREAD)
        aroundItem = true
      }
    }
    // PowerShell's drives of two or more letters (review 2026-11-24, sixth): `Home:\.cache` is wherever such a
    // drive is rooted, which the scan cannot read; the registry, environment, function, variable, alias and
    // certificate drives hold no files.
    if (ctx.dialect === 'ps' && isMut(op) && /^[A-Za-z][A-Za-z0-9_]+:(?!:)/.test(x.text) && x.anchor === null && !/^[A-Za-z][\w+.-]*:\/\//.test(x.text)) {
      if (/^(?:hkcu|hklm|hkcr|hku|hkcc|env|function|variable|alias|cert|wsman):/i.test(x.text)) { status = 'ok'; continue }
      { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }
      continue
    }
    // A POSIX shell's `~name/...` is that user's home: the real home for the account's own name, a folder the scan
    // cannot read for any other (review 2026-11-24, seventh). Quoted, it is a literal name.
    // `~+` is the working folder and `~-` the one before it, which the scan does not follow (eighth review).
    if (ctx.dialect === 'posix' && x.anchor === null && w.tok.pieces[0]?.q === 'n' && /^~[+-](?:[\\/]|$)/.test(x.text)) {
      x.text = x.text[1] === '+' ? ctx.base + x.text.slice(2) : UNREAD + x.text.slice(2)
      if (x.text.startsWith(ctx.base)) x.anchor = 'cwd'
    }
    const tildeUser = ctx.dialect === 'posix' && x.anchor === null && w.tok.pieces[0]?.q === 'n' ? x.text.match(/^~([A-Za-z0-9._-]+)(?=[\\/]|$)/) : null
    if (tildeUser) {
      if (tildeUser[1].toLowerCase() !== ctx.run.homes.user.toLowerCase()) { { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }; continue }
      x.text = ctx.run.homes.home + x.text.slice(tildeUser[0].length)
      x.anchor = 'home'
    }
    const c = toPath(ctx.run, x.text, o.relAllowed, ctx.base, x.anchor !== null, ctx.dialect === 'posix' || POSIX_TOOLS.has(o.verb), isMut(op) && !aroundItem)
    if (c === null) continue
    if (aroundItem && isMut(op)) unresolvedIn(ctx, op, o.verb, o.recursive === true)
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
    if (c === 'unreadable') { { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }; continue }
    if (c.relative && ctx.baseUnreadable && isMut(op)) { { unreadSeen = true; if (status !== 'ok') status = 'unreadable' }; continue }
    // A relative read or listing after a folder change the scan could not follow names a folder it cannot
    // read: what it hands down a pipeline is marked so (review 2026-11-23, fourth).
    const staleRelative = c.relative && ctx.baseUnreadable
    const p: ShellPath = {
      raw: w.raw, path: c.path, op, recursive: o.recursive === true, children: c.children || o.children === true,
      inherited: o.inherited === true, anchor: x.anchor, device: c.device, verb: o.verb, via: ctx.via,
    }
    if (op === 'link') p.linkTarget = o.linkTarget ?? null
    // `$PWD`, `Get-Location`, `os.getcwd()` after a folder change the scan could not follow: the folder it
    // names is not the one the scan has (review 2026-11-23, fourth).
    if ((x.anchor === 'cwd' && ctx.baseUnreadable) || staleRelative) p.staleBase = true
    emit(ctx.run, p)
    if (seg) {
      const list = ctx.segPaths.get(seg.id) ?? []
      list.push(p)
      ctx.segPaths.set(seg.id, list)
    }
    status = 'ok'
  }
  return isMut(op) && unreadSeen ? 'unreadable' : status
}

/** Whether a word holds an item xargs put in (`out/%`). */
function xargsItemIn(ctx: Ctx, value: string): boolean {
  for (const m of value.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))) {
    const e = ctx.run.table[Number(m[1])]
    if (e?.k === 'p' && e.xargs) return true
  }
  return false
}

/**
 * Whether what flows down to this element is the lines of listings inside the working folder (`ls out`, `find src
 * -name x`, `git ls-files`): names and relative paths that never climb out of it.
 */
function listingFlowInside(ctx: Ctx, seg: Seg): boolean {
  if (seg.pipeIndex === 0 || ctx.baseUnreadable) return false
  const flow = earlierInPipe(ctx, seg.pipeline, seg.pipeIndex)
  if (flow.opaque || flow.paths.length === 0) return false
  const P = ctx.run.platform === 'win32' ? nodePath.win32 : nodePath.posix
  return flow.paths.every(p => !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p.raw)
    && p.path !== null && (p.path === ctx.base || p.path.toLowerCase().startsWith(`${ctx.base.toLowerCase().replace(/[\\/]+$/, '')}${P.sep}`)))
}

/** The pipeline's item followed by its folder: `$($_.DirectoryName)` (ITEM_DIR) or `$_.DirectoryName` / `$_.Directory` as a member. */
const ITEM_DIR_RE = /\u0005(?:\u000e|\.(?:DirectoryName|Directory)(?![\w(]|\.\w))/i

/**
 * The folder the items handed to this element are in, when they come from a listing of one literal folder: that
 * folder, or a folder under it (DESC) when the listing recurses. Null for any other feed (eighth review, C1).
 */
function itemFolder(ctx: Ctx, seg: Seg): string | null {
  if (!itemFeed(ctx, seg)) return null
  const f = feedOf(ctx, seg) ?? (seg.pipeIndex > 0 ? { pipeline: seg.pipeline, upTo: seg.pipeIndex } : null)
  if (f === null) return null
  const flow = earlierInPipe(ctx, f.pipeline, f.upTo)
  const P = ctx.run.platform === 'win32' ? nodePath.win32 : nodePath.posix
  // A listing's items are in the folder listed; an item `Get-Item` named is in its own parent.
  const folders = new Set(flow.paths.map(p => (p.path === null ? null : p.op === 'list' || p.children ? p.path : P.dirname(p.path))))
  if (flow.opaque || folders.size !== 1 || folders.has(null)) return null
  const dir = [...folders][0] as string
  const head = ctx.index?.at.get(`${f.pipeline}:0`)
  const recurse = flow.paths.some(p => p.recursive) || (head?.words ?? []).some(t => /^-(?:r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|depth)$/i.test(t.pieces.map(x => x.t).join('')))
  return recurse ? `${dir.replace(/[\\/]+$/, '')}\\${DESC}` : dir
}

/** Whether the items handed to this element are the names a `-Name` listing of a literal folder printed (eighth review, C4). */
function nameFeed(ctx: Ctx, seg: Seg): boolean {
  const f = feedOf(ctx, seg) ?? (seg.pipeIndex > 0 ? { pipeline: seg.pipeline, upTo: seg.pipeIndex } : null)
  if (f === null) return false
  segsIn(ctx, 'pipeline', f.pipeline)
  const head = ctx.index?.at.get(`${f.pipeline}:0`)
  if (!head || head.words.length === 0 || head.groups.length) return false
  const words = head.words.map(t => wordOf(ctx, t))
  if (!LIST_VERBS.has(verbName(words[0].text)) || !words.some(w => /^-n(?:a(?:me?)?)?$/i.test(w.text))) return false
  for (let k = 1; k < f.upTo; k++) {
    const mid = ctx.index?.at.get(`${f.pipeline}:${k}`)
    if (!mid || mid.words.length === 0 || !ITEM_FILTERS.has(verbName(wordOf(ctx, mid.words[0]).text))) return false
  }
  return !words.slice(1).some(w => hasUnreadableSentinel(ctx.run, w.value) || w.value.includes(UNREAD))
}

/**
 * Whether a word is the pipeline's item, or its own path member, followed only by quoted text with no separator and
 * no `..` (`"$($_.FullName).bak"`, `($_.FullName + '.bak')`): an unquoted member chain (`$_.FullName.bak`) is not.
 */
function itemWithSuffix(ctx: Ctx, w: Word, text: string): boolean {
  const m = text.match(/^\u0005((?:\.(?:FullName|PSPath|Path|LiteralPath))?)([\s\S]+)$/i)
  if (!m || /[\\/\u0002-\u0006]|\.\./.test(m[2])) return false
  const k = w.tok.pieces.findIndex(p => [...p.t.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))].some(x => ctx.run.table[Number(x[1])]?.k === 'p'))
  if (k < 0) return false
  const p0 = w.tok.pieces[k]
  const after0 = p0.t.slice(p0.t.lastIndexOf(S1) + 1)
  if (p0.q === 'n' && !/^(?:\.(?:FullName|PSPath|Path|LiteralPath))?$/i.test(after0)) return false
  return w.tok.pieces.slice(k + 1).every(p => p.q !== 'n' && !p.t.includes(S0))
}

/** The pipeline's item followed by its leaf name: `$($_.Name)` (ITEM_LEAF) or `$_.Name` / `$_.BaseName` as a member. */
const ITEM_LEAF_RE = /\u0005(?:\u0001|\.(?:Name|BaseName)(?![\w(]|\.\w))/i

/**
 * Whether the items a block or an element is handed come from a listing of a folder the scan read
 * (`Get-ChildItem x`, `Get-Item x`, filters after it), so an item's `Name` is a leaf name (review 2026-11-24, seventh).
 */
function itemFeed(ctx: Ctx, seg: Seg): boolean {
  const f = feedOf(ctx, seg) ?? (seg.pipeIndex > 0 ? { pipeline: seg.pipeline, upTo: seg.pipeIndex } : null)
  if (f === null) return false
  const flow = earlierInPipe(ctx, f.pipeline, f.upTo)
  if (flow.opaque || flow.paths.length === 0) return false
  segsIn(ctx, 'pipeline', f.pipeline)
  const head = ctx.index?.at.get(`${f.pipeline}:0`)
  if (!head || head.words.length === 0) return false
  const v = verbName(wordOf(ctx, head.words[0]).text)
  return LIST_VERBS.has(v) || v === 'get-item' || v === 'gi'
}

/** The lines of a here-string body as words: a double-quoted one has its variables read, as PowerShell expands them. */
/**
 * The lines of a here-string body as words: a double-quoted one has its variables read, as PowerShell
 * expands them. `strict` (a body used as a value): every line counts, and a line too long to read is a fault
 * that refuses the call (review 2026-11-23, fourth: a body read only up to its 64th line let a target on
 * the 65th through).
 */
function hereLines(ctx: Ctx, idx: number, strict = false): Array<{ value: string; raw: string }> {
  const b = ctx.run.bodies[idx]
  if (!b) return []
  const out: Array<{ value: string; raw: string }> = []
  for (const l of b.text.split(/\r?\n/)) {
    if ((out.length & 63) === 63 && overBudget(ctx.run)) break
    const line = l.trim()
    if (line === '') continue
    if (line.length > 1024) {
      if (strict) { const f = 'a here-string used as a value has a line longer than 1024 characters'; if (!ctx.run.out.faults.includes(f)) ctx.run.out.faults.push(f) }
      continue
    }
    out.push({ value: b.q === '"' ? substitute(ctx.run, line, new Map()) : line, raw: line })
    if (!strict && out.length >= 64) break
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

/** The parameters of the cmdlets the verb table reads, by kind, for binding a prefix (`canonParam`). */
const PARAMS_OF: Array<[Set<string>, string[]]> = [
  [DELETE_VERBS, ['path', 'literalpath', 'filter', 'include', 'exclude', 'recurse', 'force', 'credential', 'stream']],
  [MOVE_VERBS, ['path', 'literalpath', 'destination', 'newname', 'filter', 'include', 'exclude', 'recurse', 'force', 'passthru', 'credential']],
  [COPY_VERBS, ['path', 'literalpath', 'destination', 'filter', 'include', 'exclude', 'recurse', 'force', 'passthru', 'container', 'credential', 'tosession', 'fromsession']],
  [WRITE_TARGET_FIRST, ['path', 'literalpath', 'value', 'filepath', 'encoding', 'force', 'inputobject', 'append', 'nonewline', 'noclobber', 'width', 'delimiter', 'notypeinformation', 'stream', 'filter', 'include', 'exclude', 'credential', 'passthru']],
  [WRITE_ALL, ['path', 'literalpath', 'filepath', 'variable', 'append', 'inputobject', 'encoding']],
  [NEW_ITEM, ['path', 'name', 'itemtype', 'value', 'force', 'credential']],
  [LIST_VERBS, ['path', 'literalpath', 'filter', 'include', 'exclude', 'recurse', 'depth', 'force', 'name', 'file', 'directory', 'hidden', 'readonly', 'system', 'attributes', 'followsymlink']],
  [READ_VERBS, ['path', 'literalpath', 'filter', 'include', 'exclude', 'totalcount', 'tail', 'raw', 'encoding', 'delimiter', 'stream', 'force', 'readcount']],
  [CD_VERBS, ['path', 'literalpath', 'stackname', 'passthru']],
  [ARCHIVE_VERBS, ['path', 'literalpath', 'destinationpath', 'force', 'compressionlevel', 'update', 'passthru']],
]
/** cmd's commands that are aliases of PowerShell's item cmdlets in PowerShell 5.1 (`Get-Alias`), where `/x` is a path. */
const PS_ALIASES_OF_CMD = new Set(['copy', 'move', 'del', 'erase', 'rd', 'rmdir', 'ren', 'type', 'md', 'mkdir', 'dir'])

/** PowerShell's common parameters (every cmdlet has them, `about_CommonParameters`): those that take a value, the switches, and their aliases. */
const COMMON_VALUE_PARAMS = ['erroraction', 'warningaction', 'informationaction', 'errorvariable', 'warningvariable', 'informationvariable',
  'outvariable', 'outbuffer', 'pipelinevariable']
const COMMON_SWITCH_PARAMS = ['verbose', 'debug', 'whatif', 'confirm', 'usetransaction']
const COMMON_ALIASES: Record<string, string> = { ea: 'erroraction', wa: 'warningaction', infa: 'informationaction', ev: 'errorvariable',
  wv: 'warningvariable', iv: 'informationvariable', ov: 'outvariable', ob: 'outbuffer', pv: 'pipelinevariable', vb: 'verbose', db: 'debug',
  wi: 'whatif', cf: 'confirm', usetx: 'usetransaction' }

/** A listing's switches: no value follows them. */
const LIST_SWITCHES = new Set(['file', 'directory', 'name', 'hidden', 'readonly', 'system', 'recurse', 'force', 'followsymlink'])

/**
 * The aliases of those parameters in PowerShell 5.1 (`Get-Command <cmdlet>`, measured; review 2026-11-24,
 * seventh): every one binds, and so does any prefix of one (`-PSP`, `-Ty`).
 */
const PARAM_ALIASES: Array<[Set<string>, Record<string, string>]> = [
  [NEW_ITEM, { type: 'itemtype', target: 'value', pspath: 'path', lp: 'path' }],
  [LIST_VERBS, { pspath: 'literalpath', lp: 'literalpath', ad: 'directory', af: 'file', ah: 'hidden', h: 'hidden', as: 'system', ar: 'readonly', s: 'recurse' }],
  [WRITE_TARGET_FIRST, { pspath: 'literalpath', lp: 'literalpath' }],
  [WRITE_ALL, { pspath: 'literalpath', lp: 'literalpath' }],
  [READ_VERBS, { pspath: 'literalpath', lp: 'literalpath', first: 'totalcount', head: 'totalcount', last: 'tail' }],
  [DELETE_VERBS, { pspath: 'literalpath', lp: 'literalpath' }],
  [MOVE_VERBS, { pspath: 'literalpath', lp: 'literalpath' }],
  [COPY_VERBS, { pspath: 'literalpath', lp: 'literalpath' }],
  [CD_VERBS, { pspath: 'literalpath', lp: 'literalpath' }],
  [ARCHIVE_VERBS, { pspath: 'literalpath', lp: 'literalpath' }],
]

/**
 * A cmdlet's parameter name as PowerShell binds it: an alias is the parameter it names, and a prefix of a name
 * or of an alias is the one parameter it starts (one letter included: `-L:` is `-LiteralPath`, review
 * 2026-11-24, seventh), or as written.
 */
function canonParam(name: string, verb: string): string {
  const own = PARAMS_OF.find(([set]) => set.has(verb))?.[1]
  if (!own) return name
  // Every cmdlet's common parameters bind too, by their aliases and by any prefix (review 2026-11-24, eighth: `-wv w`,
  // `-ob 1`, `-ErrorA 0`, `-PipelineVar p` were read as switches and their value as the cmdlet's first operand).
  const params = [...own, ...COMMON_VALUE_PARAMS, ...COMMON_SWITCH_PARAMS]
  const aliases: Record<string, string> = { ...COMMON_ALIASES, ...(PARAM_ALIASES.find(([set]) => set.has(verb))?.[1] ?? {}) }
  if (params.includes(name)) return name
  if (aliases[name] !== undefined) return aliases[name]
  const cands = [...new Set([...params.filter(c => c.startsWith(name)), ...Object.keys(aliases).filter(a => a.startsWith(name)).map(a => aliases[a])])]
  if (cands.length === 1) return cands[0]
  // Ambiguous to PowerShell (an error there), but where one of them names a path the check reads it as that.
  return cands.find(c => /^(?:path|literalpath|destination|destinationpath|filepath)$/.test(c)) ?? name
}

/** Whether a cmdlet's own parameter takes a value: every one the verb table knows except its switches. */
function takesValue(name: string, verb: string): boolean {
  const params = PARAMS_OF.find(([set]) => set.has(verb))?.[1]
  return params !== undefined && params.includes(name) && !SWITCHES_OF.has(name) && !(LIST_VERBS.has(verb) && LIST_SWITCHES.has(name))
}

/** Parsed operands of a command: positional words, named parameters and switches. */
interface Parsed {
  positional: Word[]
  named: Map<string, Word[]>
  flags: string[]        // every flag word, lower-case
  recursive: boolean
  /** A cmdlet written by its full name was given a parameter it does not have, which the scan cannot place (eighth review). */
  unknownParam?: string
}

/** A word that is a PowerShell parameter name, never a parameter's value. */
function looksLikeParam(w: Word | undefined): boolean {
  return w !== undefined && w.tok.pieces[0]?.q === 'n' && /^-[A-Za-z][\w-]*(?::.*)?$/.test(w.text)
}

/** A splat written as a word (`@p`), or null: the binding entry behind it (none when nothing set the name). */
function splatOf(run: Run, value: string): { b: Binding | null } | null {
  if (/^@[A-Za-z_]\w*$/.test(value)) return { b: null }
  const m = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  const e = m ? run.table[Number(m[1])] : null
  if (!e || (e.k !== 'bound' && e.k !== 'u') || !/^@[A-Za-z_]\w*$/.test(e.orig)) return null
  return { b: e.k === 'bound' ? e.b : null }
}

/** PowerShell's own aliases of its cmdlets: a list handed to one of them binds to one parameter, never one argument each. */
const PS_CMDLET_ALIASES = new Set(['rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'cp', 'copy', 'cpi', 'mv', 'move', 'mi', 'ren', 'rni',
  'ni', 'md', 'mkdir', 'sc', 'ac', 'gc', 'cat', 'type', 'ls', 'dir', 'gci', 'cd', 'sl', 'chdir', 'pushd', 'popd', 'echo', 'write',
  'iex', 'icm', 'saps', 'start', 'foreach', '%', '?', 'where', 'select', 'sort', 'measure', 'tee', 'clc', 'cli', 'gi', 'si', 'sp',
  'rp', 'ii', 'ft', 'fl', 'oh', 'cls', 'clear', 'kill', 'spps', 'ps', 'gps', 'sleep', 'iwr', 'irm', 'diff', 'compare', 'group',
  'sv', 'set', 'gv', 'rv', 'nv', 'ndr', 'rdr', 'gdr', 'pwd', 'gl', 'gm', 'gal', 'sal', 'nal', 'ipmo', 'gcm', 'h', 'r', 'man', 'help'])

/** A program PowerShell starts as a native program, not a cmdlet, a function or one of its aliases. */
function isNativeHead(v: string): boolean {
  return v !== '' && !/^[a-z]+-[a-z]+$/.test(v) && !PS_CMDLET_ALIASES.has(v)
}

/** PowerShell's automatic variables: set by PowerShell, never by the command, and never read as a command's own name. */
const PS_AUTOMATIC = /^\$(?:args|input|_|psitem|psboundparameters|matches|myinvocation|this|event\w*|sender|foreach|switch|true|false|null|pwd|home|host|pid|pshome|profile|lastexitcode|error|\?)$/i

/**
 * A name written bare as an argument (`$a`): the list bound to it (a list of literals the scan read), or whether
 * nothing the scan can read stands behind it. Null when the word is not a bare name or it reads as a value.
 */
function bareVarOf(run: Run, value: string): { list?: string[]; unreadable?: true } | null {
  const m = value.match(new RegExp(`^${S0}(\\d+)${S1}$`))
  const e = m ? run.table[Number(m[1])] : null
  if (!e || (e.k !== 'bound' && e.k !== 'u') || !/^\$[A-Za-z_]\w*$/.test(e.orig) || PS_AUTOMATIC.test(e.orig)) return null
  if (e.k === 'u') return e.unset ? null : { unreadable: true }
  if (e.b.list && !e.b.item) return { list: e.b.list }
  if (!e.b.unset && e.b.value === null && e.b.here === null && e.b.list === undefined && e.b.hash === undefined) return { unreadable: true }
  // A name bound to a value made of what the scan cannot read (`$a = $env:X`).
  // A name nothing set inside it is empty, as everywhere in the scan.
  const unreadIn = (s: string) => [...s.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))].some(x => {
    const y = run.table[Number(x[1])]
    return !y || (y.k === 'u' && !y.unset) || y.k === 'p' || y.k === 'doc' || (y.k === 'bound' && !y.b.unset && y.b.value === null && y.b.here === null && y.b.list === undefined)
  })
  if (!e.b.unset && e.b.value !== null && e.b.list === undefined && (e.b.value.includes(UNREAD) || unreadIn(e.b.value))) return { unreadable: true }
  return null
}

/**
 * The words a splat stands for (review 2026-11-24, sixth): a table of literals bound to the name (`$p = @{ Path =
 * '.\build'; Recurse = $true }`) is its parameters, a list is its elements. Null when it is not one of these.
 */
function splatWords(ctx: Ctx, w: Word): Word[] | null {
  if (w.tok.pieces.length !== 1 || w.tok.pieces[0].q !== 'n') return null
  const sp = splatOf(ctx.run, w.value)
  if (sp === null || sp.b === null) return null
  if (sp.b.hash) {
    const out: Word[] = []
    for (const [k, v] of sp.b.hash) {
      out.push({ ...literalWord(`-${k}`), raw: w.raw })
      if (v !== true) out.push({ ...literalWord(v), raw: w.raw, tok: { kind: 'w', pieces: [{ t: v, q: 's' }], start: w.tok.start, end: w.tok.end, subs: [] } })
    }
    return out
  }
  if (sp.b.list) return sp.b.list.map(v => ({ ...literalWord(v), raw: w.raw, tok: { kind: 'w', pieces: [{ t: v, q: 's' }], start: w.tok.start, end: w.tok.end, subs: [] } }))
  return null
}

/** A word standing for a value that cannot be read: a group or a subexpression bound to a parameter. */
function unreadableWord(raw: string): Word {
  return { ...literalWord(UNREAD), raw }
}

/**
 * `groupsFrom`: the end of the program word. Every group or subexpression written after it that is not a
 * parameter's value and not inside a word is an argument too, and one the scan cannot read: it takes its
 * place among the positional words (or in the list it continues, after a word that ends with a comma), so a
 * mutation, a listing or a program handed it reads it as unreadable (review of wave 5: `Remove-Item .\build,
 * (Split-Path $PWD)` dropped the group and deleted the parent).
 */
function parseArgs(words: Word[], verb: string, valueFlags: Set<string> = new Set(), groups: Seg['groups'] = [], groupsFrom: number | null = null,
  blockText?: (start: number, end: number) => string, ps = true): Parsed {
  const positional: Word[] = []
  const named = new Map<string, Word[]>()
  const flags: string[] = []
  // In PowerShell `copy`, `move`, `del` and `rd` are aliases of the item cmdlets, and `/Users` is a path there, not a switch
  // (review 2026-11-24, eighth).
  const cmdFamily = CMD_FAMILY.has(verb) && !(ps && PS_ALIASES_OF_CMD.has(verb))
  let unknownParam: string | undefined
  let afterDashDash = false
  const taken = new Set<Seg['groups'][number]>()
  // Where each word went, so a group that continues a word's comma list joins that list.
  const into = new Map<Word, Word[]>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const t = w.text
    const unquoted = w.tok.pieces[0]?.q === 'n'
    if (afterDashDash || !unquoted) { positional.push(w); into.set(w, positional); continue }
    // Only a parameter written as one is one: a variable whose value starts with a dash is a value (review 2026-11-24,
    // eighth: `$f = '-Filter'; Copy-Item $f C:\x` hands PowerShell a file named -Filter and the destination after it).
    // The command was written as if it were a parameter, so which word the cmdlet takes as its target is not what the
    // text says: recorded, and a cmdlet that writes refuses it.
    if (ps && t.startsWith('-') && w.tok.pieces[0]?.t.startsWith('-') !== true) { unknownParam ??= t; positional.push(w); into.set(w, positional); continue }
    if (t === '--') { afterDashDash = true; flags.push('--'); continue }
    if (cmdFamily && CMD_SWITCH.test(t)) { flags.push(t.toLowerCase()); continue }
    // In PowerShell a cmd alias's one-letter switch (`rd /s /q`, `del /q`) is still read as one: PowerShell fails on it
    // and runs nothing, and reading it as a folder at the drive's root would refuse for the wrong reason. A longer word
    // (`/Users`) is a path there.
    if (ps && PS_ALIASES_OF_CMD.has(verb) && /^\/-?[A-Za-z?](?::.*)?$/.test(t)) { flags.push(t.toLowerCase()); continue }
    const pm = t.match(/^-([A-Za-z][\w-]*?)(?::([\s\S]*))?$/)
    if (pm && t.length > 1) {
      // A cmdlet's parameter is bound by any unambiguous prefix of its name or of an alias, spaced or glued
      // (review 2026-11-24, sixth: `-Pa:C:\x`, `-Desti:x`, `-DestinationPa:x` were stored under the prefix and
      // dropped). One letter too, in PowerShell (seventh: `-L:C:\x` is `-LiteralPath`); a POSIX tool's `-r` is not.
      const name0 = pm[1].toLowerCase()
      const name = valueFlags.has(`-${name0}`) || (name0.length < 2 && !ps) ? name0 : canonParam(name0, verb)
      flags.push(t.toLowerCase())
      // The value glued on, as written (a here-string glued on is a value too, which the text alone loses).
      // `-Destination: C:\x` (a colon and then a space) binds the next word, as a spaced name does (measured).
      const gluedValue = pm[2] !== undefined ? w.value.slice(w.value.indexOf(':') + 1) : ''
      const colonSpaced = pm[2] !== undefined && gluedValue === ''
      if (gluedValue !== '') {
        const list = named.get(name) ?? []
        const text = pm[2] ?? ''
        const glued: Word = { ...w, value: gluedValue, text, raw: text, quotedFirst: null, tok: { ...w.tok, pieces: [{ t: gluedValue, q: 'n' }] } }
        list.push(glued)
        named.set(name, list)
        into.set(w, list)
        continue
      }
      // A listing's switches take no value (`Get-ChildItem -File C:\x`, review 2026-11-24, sixth).
      if (LIST_VERBS.has(verb) && LIST_SWITCHES.has(name)) continue
      if (ps && PARAMS_OF.some(([set]) => set.has(verb))) {
        // A common parameter's value is a preference or a variable's name, never a path (eighth review).
        if (COMMON_VALUE_PARAMS.includes(name)) { if (words[i + 1] !== undefined && (colonSpaced || !looksLikeParam(words[i + 1]))) i++; continue }
        if (COMMON_SWITCH_PARAMS.includes(name)) continue
        // A parameter this cmdlet does not have: PowerShell refuses the call, so no honest command has one, and the
        // scan cannot say which word it would take (eighth review). Recorded for the verb to refuse.
        const own = PARAMS_OF.find(([set]) => set.has(verb))?.[1] ?? []
        if (verb.includes('-') && !own.includes(name) && !PS_PATH_PARAMS.has(name) && !PS_VALUE_PARAMS.has(name) && !SWITCHES_OF.has(name)) unknownParam ??= t
      }
      // A known parameter of a cmdlet the table reads takes the next word as its value unless it is a switch
      // (review 2026-11-24, seventh, P4: `Push-Location -StackName s C:\x` read `s` as the folder).
      if (PS_PATH_PARAMS.has(name) || PS_VALUE_PARAMS.has(name) || valueFlags.has(`-${name}`) || colonSpaced || (ps && takesValue(name, verb))) {
        // A group or a subexpression written right after the parameter is its value, and it cannot be
        // read (`-Path (Join-Path 'D:\' 'Video')`); the next word is never taken in its place, and a word
        // that is itself a parameter is never a value (review 2026-11-23).
        const next = words[i + 1]
        // A script block bound to a path parameter (`-Destination { "$HOME\" + $_.Name }`): PowerShell binds
        // what the block makes for each item, which the scan cannot read (review 2026-11-24, sixth).
        const block = PS_PATH_PARAMS.has(name) && name !== 'value' ? groups.find(x => x.opener === '{' && x.start >= w.tok.end && (next === undefined || x.end <= next.tok.start)) : undefined
        if (block) {
          // `{ '.\out\' + $_.Name }`, `{ ".\out\$($_.Name)" }`: a name inside a literal folder.
          const bt = blockText ? blockText(block.start, block.end) : ''
          const lit = bt.match(/^\{\s*(['"])([^'"$`]*[\\/])\1\s*\+\s*\$(?:_|PSItem)\.(?:Name|BaseName)\s*\}$/i)
            ?? bt.match(/^\{\s*"([^"$`]*[\\/])\$\(\$(?:_|PSItem)\.(?:Name|BaseName)\)"\s*\}$/i)
          // `{ Join-Path .\out $_.Name }` (review 2026-11-24, seventh).
          const jp = lit ? null : bt.match(/^\{\s*Join-Path\s+(?:-Path\s+)?(['"]?)([^'"$`\s(){}]+)\1\s+(?:-ChildPath\s+)?\$(?:_|PSItem)\.(?:Name|BaseName)\s*\}$/i)
          const folder = lit ? (lit[2] ?? lit[1]) : jp ? `${jp[2].replace(/[\\/]+$/, '')}\\` : null
          const list = named.get(name) ?? []
          list.push(folder !== null && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(folder) ? { ...literalWord(`${folder}${NAME}`), raw: bt } : unreadableWord('{...}'))
          named.set(name, list); taken.add(block); continue
        }
        const g = groups.find(x => x.opener !== '{' && x.start >= w.tok.end && (next === undefined || x.end <= next.tok.start))
        const list = named.get(name) ?? []
        // `-Destination (New-Item -ItemType Directory -Force .\out\copy)`: the item it makes, a literal path (ninth review).
        const made = g && blockText ? blockText(g.start, g.end).trim()
          .match(/^\(\s*(?:New-Item|ni|mkdir|md)\s+(?:(?:-ItemType|-Type)\s+\w+\s+|-Force\s+|-Path\s+)*('[^'$`]*'|"[^"$`]*"|[\w.\\/:-]+)(?:\s+(?:-ItemType|-Type)\s+\w+|\s+-Force)*\s*\)$/i) : null
        if (g && made) { list.push({ ...literalWord(made[1].replace(/^(['"])([\s\S]*)\1$/, '$2')), raw: made[0] }); taken.add(g) }
        else if (g) { list.push(unreadableWord('(...)')); taken.add(g) }
        else if (next !== undefined && !looksLikeParam(next)) { const v = words[++i]; list.push(v); into.set(v, list) }
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
    into.set(w, positional)
  }
  if (groupsFrom !== null) {
    for (const g of groups) {
      if (g.opener === '{' || taken.has(g) || g.start < groupsFrom) continue
      // A group merged into a word (`(Get-Item x).FullName`) is read as that word.
      if (words.some(w => w.tok.start <= g.start && w.tok.end >= g.end)) continue
      const word: Word = { ...unreadableWord('(...)'), tok: { kind: 'w', pieces: [{ t: UNREAD, q: 'n' }], start: g.start, end: g.end, subs: [] } }
      // The word right before it: when it ends with a comma, the group is the next element of its list.
      let before: Word | undefined
      for (const w of words) if (w.tok.end <= g.start && (before === undefined || w.tok.end > before.tok.end)) before = w
      const last = before?.tok.pieces[before.tok.pieces.length - 1]
      const list = before !== undefined && last?.q === 'n' && last.t.endsWith(',') ? into.get(before) ?? positional : positional
      let at = list.length
      while (at > 0 && list[at - 1].tok.start > g.start) at--
      list.splice(at, 0, word)
    }
  }
  const recursive = flags.some(f => RECURSIVE_FLAGS.has(f) || /^-[rRfivd]*[rR][rRfivd]*$/.test(f) && f.length <= 5 || /^-recu/.test(f))
  return unknownParam !== undefined ? { positional, named, flags, recursive, unknownParam } : { positional, named, flags, recursive }
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
  'select-string', 'sls', 'find', 'xargs', 'tee-object', 'tee', 'out-null', 'write-output', 'echo', 'write-host', 'printf'])
const ITEM_FILTERS = new Set(['where-object', 'where', '?', 'sort-object', 'sort', 'get-unique', 'gu'])
/** `Select-Object` parameters that keep the items themselves. */
const SELECT_KEEPS = new Set(['-first', '-last', '-skip', '-skiplast', '-unique', '-index', '-wait'])
/** Members of an item that are the item's own path. */
const PATH_MEMBERS = new Set(['fullname', 'pspath', 'path', 'literalpath'])
/** Elements that hand on another path than the one they were given, in every shell. */
const PATH_TRANSFORMS = new Set(['split-path', 'join-path', 'dirname', 'basename', 'readlink'])
/** Every command name the scan reads by name: a function defined under one of them is self-building. */
const KNOWN_COMMANDS = new Set([...DELETE_VERBS, ...MOVE_VERBS, ...WRITE_TARGET_FIRST, ...WRITE_ALL, ...NEW_ITEM, ...COPY_VERBS,
  ...ARCHIVE_VERBS, ...READ_VERBS, ...LIST_VERBS, ...NOTHING_VERBS, ...CD_VERBS, ...POP_VERBS, ...ITEM_SOURCES, ...ITEM_FILTERS,
  ...PATH_TRANSFORMS, ...WRAPPERS, 'select-object', 'select', 'foreach-object', 'foreach', 'git', 'cmd', 'powershell', 'pwsh', 'python',
  'node', 'bash', 'sh', 'robocopy', 'mklink', 'ln', 'tar', 'invoke-expression', 'iex', 'invoke-command', 'icm'])

/** Whether an element passes items on (`pass`), and whether the paths it names itself join them (`own`). */
function passesItems(ctx: Ctx, seg: Seg): { pass: boolean; own: boolean } {
  if (seg.transformed) return { pass: false, own: false }
  // A script block run as a pipeline element (`& { process { $_.Parent } }`, `. { ... }`) hands on what its
  // block makes, which the scan cannot read (review 2026-11-23, fourth); a value group (`@('D:\x')`) hands on
  // its value.
  if (seg.words.length === 0) return seg.call || seg.groups.some(g => g.opener === '{') ? { pass: false, own: false } : { pass: true, own: true }
  const words = seg.words.map(t => wordOf(ctx, t))
  let k = 0
  while (k < words.length && (words[k].text === '&' || words[k].text === '.' || (k < words.length - 1 && /^(?:do|then|else|elif)$/.test(words[k].text)))) k++
  const head = words[k]
  if (!head) return seg.groups.some(g => g.opener === '{') ? { pass: false, own: false } : { pass: true, own: true }
  if (!seg.call && isValueWord(head)) return { pass: true, own: true }
  // A range (`1..3 | ...`) hands on integers, which name nothing (review 2026-11-24, sixth).
  if (!seg.call && /^-?\d+\.\.-?\d+$/.test(head.text)) return { pass: true, own: false }
  if (listingItems(ctx, seg) !== null) return { pass: true, own: true }
  const verb = verbName(head.text)
  if (verb === 'join-path' && !seg.call && seg.groups.length === 0 && wordsExpression(seg.words) !== null) return { pass: true, own: true }
  if (PATH_TRANSFORMS.has(verb)) return { pass: false, own: false }
  // cmd and a POSIX shell hand on text lines: only the transforms above are known to change them.
  if (ctx.dialect !== 'ps' || ctx.codeAsShell) return { pass: true, own: true }
  // A line filter given only its pattern (`grep '\.tmp$'`, `sort`, `head -5`) hands on some of the lines it was fed,
  // unchanged (review 2026-11-24, eighth: `ls out | grep x | xargs -I{} rm out/{}` was opaque).
  if (/^(?:grep|egrep|fgrep|findstr|sort|uniq|head|tail)$/.test(verb) && words.slice(k + 1).filter(w => !w.text.startsWith('-')).length <= (/grep|findstr/.test(verb) ? 1 : 0)) return { pass: true, own: false }
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
    // A member that changes the item (`% Replace 'a' 'b'` makes another string, `% Delete` hands on nothing):
    // what flows on cannot be read (review 2026-11-24, sixth).
    if (seg.groups.length === 0 && member && PATH_MEMBERS.has(m)) return { pass: true, own: false }
    // A block that only hands on the item or its own path (`% { $_ }`, `% { $_.FullName }`).
    if (seg.groups.length === 1 && seg.groups[0].opener === '{' && rest.every(w => w.tok.start > seg.groups[0].end || w.tok.end < seg.groups[0].start)) {
      const block = renderOrig(ctx.run, ctx.textSub.slice(seg.groups[0].start, seg.groups[0].end))
      if (/^\{\s*\$(?:_|PSItem)(?:\.(?:FullName|PSPath|Path|LiteralPath))?\s*\}$/i.test(block)) return { pass: true, own: false }
      // A porcelain status line cut to its path (`% { $_.Substring(3) }`), right after `git status --porcelain` (wave 15).
      if (/^\{\s*\$(?:_|PSItem)\.Substring\(\s*3\s*\)(?:\.Trim\(\s*\))?\s*\}$/i.test(block) && porcelainBefore(ctx, seg)) return { pass: true, own: false }
    }
    return { pass: false, own: false }
  }
  if (ITEM_FILTERS.has(verb)) return { pass: true, own: false }
  // `Get-ChildItem -Name` and `Resolve-Path -Relative` hand on names, which the next element reads against
  // its own folder, not the one listed (review 2026-11-23, fourth).
  if (LIST_VERBS.has(verb) && rest.some(w => /^-n(?:a(?:me?)?)?$/i.test(w.text))) return { pass: false, own: false }
  // `Resolve-Path -Relative` names the same items relative to the working folder (review 2026-11-24, sixth);
  // against another base (`-RelativeBasePath`) it does not.
  if ((verb === 'resolve-path' || verb === 'rvpa') && rest.some(w => /^-rel/i.test(w.text))) {
    // Its own items, spelled relative to the working folder (eighth review: with nothing before it, own:false left the
    // delete it feeds with no sources at all).
    return rest.some(w => /^-relativeb/i.test(w.text)) ? { pass: false, own: false } : { pass: true, own: true }
  }
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
    let groupOpaque = false
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
      if (own) add(listingItems(ctx, own) ?? ctx.segPaths.get(own.id) ?? [])
      for (const other of ctx.index?.parentAt.get(`${pipeline}:${k}`) ?? []) {
        if (other.pipeline === pipeline) continue
        // A group written in this element that changes what it holds (`(Split-Path $PWD)`, `([char]68+':\')`):
        // what flows on cannot be read (review of wave 5: it was skipped, and the literal beside it flowed alone).
        if (other.transformed || !passesItems(ctx, other).pass) { groupOpaque = true; continue }
        add(ctx.segPaths.get(other.id) ?? [])
      }
    }
    acc = { paths: next, opaque: acc.opaque || !pass.pass || groupOpaque }
    ctx.unions.set(`${pipeline}:${k + 1}`, acc)
  }
  return acc
}

function inheritedSources(ctx: Ctx, seg: Seg, pipeItem: boolean): Flow {
  const mine = earlierInPipe(ctx, seg.pipeline, seg.pipeIndex)
  const out: ShellPath[] = [...mine.paths]
  let opaque = mine.opaque
  // Inside a script block (`gci x | % { Remove-Item $_ }`): what the pipeline around the block named.
  const feed = (pipeItem || out.length === 0) ? feedOf(ctx, seg) : null
  if (feed !== null) {
    const around = earlierInPipe(ctx, feed.pipeline, feed.upTo)
    out.push(...around.paths)
    opaque ||= around.opaque
  }
  return { paths: out, opaque }
}

/**
 * The pipeline element whose items a script block's `$_` is: the nearest enclosing block that is a pipeline
 * element after the first, through `if`, `try`, `foreach` and other blocks that do not rebind it (review
 * 2026-11-24, sixth: `'build','dist' | % { if (Test-Path $_) { Remove-Item $_ } }` read one level only).
 */
function feedOf(ctx: Ctx, seg: Seg): { pipeline: number; upTo: number } | null {
  let cur: Seg | undefined = seg
  for (let guard = 0; guard < 8 && cur !== undefined && cur.parentPipeline !== null; guard++) {
    if (cur.parentPipeIndex > 0) return { pipeline: cur.parentPipeline, upTo: cur.parentPipeIndex }
    segsIn(ctx, 'pipeline', cur.parentPipeline)
    cur = ctx.index?.at.get(`${cur.parentPipeline}:${cur.parentPipeIndex}`)
  }
  return null
}

/**
 * The literal values a script block's `$_` takes, when the pipeline feeding it is one value list of plain
 * names (`'a.txt','b.txt' | % { ... }`) or a range of integers (`1..3 | % { ... }`); null otherwise.
 */
function feedLiterals(ctx: Ctx, seg: Seg, whole = false): string[] | null {
  const f = feedOf(ctx, seg)
  if (f === null || f.upTo !== 1) return null
  segsIn(ctx, 'pipeline', f.pipeline)
  const head = ctx.index?.at.get(`${f.pipeline}:0`)
  if (!head || head.redirects.length) return null
  let vals: string[] | null = null
  // `@('a','b') | % { ... }`: the list written as a group (review 2026-11-24, seventh).
  if (head.words.length === 0 && head.groups.length === 1 && (head.groups[0].opener === '@(' || head.groups[0].opener === '(')) {
    const g = head.groups[0]
    vals = loopList(ctx.run, ctx.textSub.slice(g.start, g.end), 'ps')
  } else {
    if (head.groups.length || head.words.length === 0) return null
    const words = joinCommaToks(head.words).map(t => wordOf(ctx, t))
    if (words.length !== 1) return null
    const range = words[0].text.match(/^(-?\d+)\.\.(-?\d+)$/)
    if (range) return loopList(ctx.run, words[0].text, 'ps')
    if (!isValueWord(words[0])) return null
    // A variable bound to a list (`$names = 'a','b'; $names | % { ... }`) is that list (review 2026-11-24, seventh).
    vals = boundList(ctx, words[0]) ?? commaParts(words[0]).map(w => w.value)
  }
  if (vals === null || vals.length > MAX_LOOP_ELEMENTS) return null
  // `whole`: the value is the whole of the path (`"$_\a.txt"`), so any value that does not climb is read as it
  // is; otherwise it is a name inside the text before it and must be a plain name.
  if (whole) {
    return vals.every(v => !hasUnreadableSentinel(ctx.run, v) && !v.includes(UNREAD) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(expand(ctx.run, v, ctx.base, ctx.tilde).text)) ? vals : null
  }
  const parts = vals.map(v => expand(ctx.run, v, ctx.base, ctx.tilde).text)
  return parts.every(p => /^[\w .+-]+$/.test(p) && !/^\.\.?$/.test(p.trim())) ? parts : null
}

function hasEarlier(ctx: Ctx, seg: Seg): boolean {
  return seg.pipeIndex > 0 || feedOf(ctx, seg) !== null
}

const PORCELAIN = 'git status --porcelain'

/** The element before this one is `git status --porcelain` (wave 15). */
function porcelainBefore(ctx: Ctx, seg: Seg): boolean {
  if (seg.pipeIndex === 0) return false
  segsIn(ctx, 'pipeline', seg.pipeline)
  const prev = ctx.index?.at.get(`${seg.pipeline}:${seg.pipeIndex - 1}`)
  return prev !== undefined && listingItems(ctx, prev)?.[0]?.verb === PORCELAIN
}

/**
 * An element that lists names inside a folder it reads (review 2026-11-24, sixth): `git ls-files`,
 * `git diff --name-only` and `git ls-tree --name-only` list the work tree; `grep -l`, `rg -l`, `findstr /m`
 * and `Select-String -List` the folders they search. What it hands on is the items inside them.
 */
function listingItems(ctx: Ctx, seg: Seg): ShellPath[] | null {
  if (seg.words.length === 0 || seg.groups.length) return null
  // Only these heads list names; anything else is not read further (a long segment is not expanded for nothing).
  const head0 = verbName(seg.words[0].pieces.map(p => p.t).join(''))
  if (!/^(?:git|grep|rg|findstr)$/.test(head0) && !(LIST_VERBS.has(head0) && ctx.dialect === 'ps')) return null
  const words = seg.words.map(t => wordOf(ctx, t))
  const verb = verbName(words[0].text)
  const rest = words.slice(1).map(w => w.text)
  const item = (path: string, verbName: string): ShellPath => ({ raw: path, path, op: 'list', recursive: false, children: true, inherited: false,
    anchor: null, device: false, verb: verbName, via: ctx.via })
  if (ctx.baseUnreadable) return null
  // `Get-ChildItem X -Name` hands on names, which the next element reads against the working folder, never
  // against X (review 2026-11-24, seventh): items inside the working folder. Without -Name it is read below.
  if (LIST_VERBS.has(verb)) {
    return words.slice(1).some(w => w.tok.pieces[0]?.q === 'n' && /^-n(?:a(?:me?)?)?$/i.test(w.text)) ? [item(ctx.base, `${verb} -Name`)] : null
  }
  if (verb === 'git') {
    if (rest.some(t => /^(?:-C|--git-dir|--work-tree|--git-dir=.*|--work-tree=.*)$/.test(t))) return null
    const sub = rest.find(t => !t.startsWith('-'))
    const names = rest.some(t => /^--name-(?:only|status)$/.test(t))
    if (sub === 'ls-files' || (sub === 'diff' && names) || (sub === 'ls-tree' && names)) return [item(ctx.base, `git ${sub}`)]
    // `git status --porcelain` lists the work tree's own paths, relative to its root and never climbing, each after a
    // two-letter status and a space; a later `% { $_.Substring(3) }` hands on the path alone (wave 15).
    if (sub === 'status' && rest.some(t => /^--porcelain(?:=v1)?$/.test(t))) return [item(ctx.base, PORCELAIN)]
    return null
  }
  const listFlag = (verb === 'grep' || verb === 'rg') ? rest.some(t => /^-[A-Za-z]*l[A-Za-z]*$/.test(t) || t === '--files-with-matches')
    : verb === 'findstr' ? rest.some(t => /^\/m$/i.test(t)) : false
  if (!listFlag) return null
  const ops = words.slice(1).filter(w => !w.text.startsWith('-') && !/^\/[A-Za-z]$/.test(w.text))
  const folders = ops.slice(1)
  const out: ShellPath[] = []
  for (const w of folders.length ? folders : [literalWord('.')]) {
    const p = pathOfWord(ctx, w)
    if (p === null) return null
    out.push(item(p, `${verb} -l`))
  }
  return out
}

/**
 * Emits the targets of a mutating verb: its own operands, or, with none (or only `$_`), the paths of the
 * earlier segments of its pipeline (g); an operand that cannot be read is an unresolved mutation (h).
 */
function mutate(ctx: Ctx, seg: Seg, targets: Word[], op: MutOp, verb: string, recursive: boolean, relAllowed = true, children = false): void {
  ctx.run.out.sawWrite = true
  // A POSIX shell's `rm` with no operand, at the head of its pipeline, deletes nothing: it reads no standard input
  // (wave 15b, P3-F10: Windows PowerShell 5.1 hands `bash -c 'trap "rm -rf x" EXIT; make'` on as `trap rm`, and an
  // unread delete there refused honest work).
  if (targets.length === 0 && ctx.dialect === 'posix' && !ctx.codeAsShell && /^(?:rm|rmdir|unlink)$/.test(verb) && !hasEarlier(ctx, seg)
    && seg.groups.length === 0 && !seg.subexpr) return
  let emitted = false
  let unreadable = false
  let pipe = targets.length === 0
  let explicit = false
  for (const w of targets) {
    const r = emitWord(ctx, seg, w, op, { relAllowed, recursive, verb, children })
    if (r === 'ok') emitted = true
    else if (r === 'unreadable') unreadable = true
    else if (r === 'pipe') { pipe = true; explicit = true }
  }
  if (pipe && !emitted) {
    // `$_` written as an operand inside a script block (`% { (gc $_.FullName) -replace 'a','b' | Set-Content
    // $_.FullName }`) is the block's item: PowerShell binds the arguments before the inner pipeline runs, so
    // what flows through the inner pipeline is not it (review 2026-11-23, fourth).
    const feed = explicit ? feedOf(ctx, seg) : null
    const flow: Flow = !hasEarlier(ctx, seg) ? { paths: [], opaque: false }
      : feed !== null ? earlierInPipe(ctx, feed.pipeline, feed.upTo)
        : inheritedSources(ctx, seg, true)
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
    // The items handed in were read: a method call's own empty group (`$_.Delete()`) is not a part left unread
    // (review 2026-11-24, seventh).
    else if (!flow.opaque) emitted = true
  }
  if (unreadable || (seg.subexpr && !emitted)) unresolvedIn(ctx, op, verb, recursive)
}

function classifySegment(ctx: Ctx, seg: Seg): void {
  // PowerShell binds `a, b` and `a ,b` as one list argument (review 2026-11-23, fourth).
  let words = (ctx.dialect === 'ps' && !ctx.codeAsShell ? joinCommaToks(seg.words, seg.groups) : seg.words).map(t => wordOf(ctx, t))
  // Redirects: a write on every target except the null devices (any verb, after `echo` too). In the
  // shell reading of an inline program a `>` is a comparison or an arrow, not a redirect.
  // cmd's `for ... do echo x> %d\a.txt`: the redirect is the body's, read with the body (`cmdFor`).
  const cmdForLoop = words.length > 1 && verbName(words[0].text) === 'for' && isCmdFor(words.slice(1))
  for (const r of ctx.codeAsShell || cmdForLoop ? [] : seg.redirects) {
    if (r.op === '<') { if (r.target) emitWord(ctx, seg, wordOf(ctx, r.target), 'read', { relAllowed: true, verb: '<' }); continue }
    ctx.run.out.sawWrite = true
    if (!r.target) { unresolvedIn(ctx, 'write', r.op, false); continue }
    const tw = wordOf(ctx, r.target)
    if (/^(?:\$null|nul|\/dev\/null|&\d)$/i.test(tw.text)) continue
    const st = emitWord(ctx, seg, tw, 'write', { relAllowed: true, verb: r.op })
    if (st === 'unreadable' || st === 'pipe') unresolvedIn(ctx, 'write', r.op, false)
    if (st === 'none') {
      const x = expand(ctx.run, tw.value, ctx.base, ctx.tilde)
      if (x.here === null && x.doc === null) unresolvedIn(ctx, 'write', r.op, false)
    }
  }
  // `echo rd /s /q D:\x > x.cmd` in a command that runs x.cmd: the echoed text is that script (review 2026-11-23, fourth).
  if (!ctx.codeAsShell && words.length > 1 && NOTHING_VERBS.has(verbName(words[0].text))) {
    for (const r of seg.redirects) {
      if (r.op === '<' || !r.target) continue
      const tw = wordOf(ctx, r.target)
      if (SCRIPT_EXT.test(tw.text) && scriptRunToo(ctx, tw.text)) scriptContent(ctx, tw.text, ctx.textSub.slice(words[1].tok.start, words[words.length - 1].tok.end))
    }
  }
  // Here-documents in this segment: their consumer decides code or data (finding 2.M2).
  const docWords = words.filter(w => expand(ctx.run, w.value, ctx.base, false).doc !== null)
  if (docWords.length) words = words.filter(w => !docWords.includes(w))
  // A POSIX compound keyword in front of a command (`do rm -rf "$d"`, `then mv ...`, `if [ ... ]`, `! cmd`): the
  // command after it is the command (review 2026-11-24, sixth: the keyword was read as the program and the
  // real verb as one of its operands). cmd's `if` is read below; PowerShell's keywords stand alone on their words.
  for (let guard = 0; guard < 4 && words.length > 1 && !ctx.codeAsShell; guard++) {
    const k = words[0].tok.pieces.length === 1 && words[0].tok.pieces[0].q === 'n' ? words[0].text : ''
    const kw = /^(?:do|then|else|elif|!)$/.test(k) || (/^(?:if|while|until)$/.test(k) && ctx.dialect !== 'cmd' && cmdIfBody(words.slice(1)).length === 0)
    if (!kw) break
    words = words.slice(1)
  }
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
  // A POSIX shell splits an unquoted expansion in the program's place at whitespace (wave 15b: `c="rm -rf
  // $HOME/.ssh"; $c` and `x=" "; rm${x}-rf${x}...` were one program word nobody knew). Where the expansion was
  // read and holds whitespace, the command line it makes is read as well.
  // Any whitespace in it splits it, before the name too (wave 15c, N3: `x=" rm"; $x -rf ../sibling` was one program
  // word, ` rm`). Where the expansion cannot be read, the shell may split it into a whole command line, the
  // program included, so the command builds what it runs (wave 15c, the wave-15b builder's leftover:
  // `c=$(cat cmd.txt); $c` was read as running nothing).
  if (ctx.dialect === 'posix' && !ctx.codeAsShell && words[0].tok.pieces.every(p => p.q === 'n') && words[0].value.includes(S0)) {
    const head = words[0].text
    if (head.includes(UNREAD)) markSelfBuilding(ctx.run, UNREAD_PROGRAM)
    if (/\s/.test(head) && !head.includes(S0) && !head.includes(UNREAD)) {
      const rest = words.length > 1 ? renderOrig(ctx.run, ctx.textSub.slice(words[1].tok.start, words[words.length - 1].tok.end)) : ''
      const line = `${head.trim()} ${rest}`.trim()
      ctx.run.out.texts.push(line)
      scanPayload(ctx.run, line, ctx.base, `${ctx.via}>split`, ctx.depth + 1, 'shell', { dialect: 'posix', baseUnreadable: ctx.baseUnreadable })
    }
  }
  // A value written where a command would stand (`'D:\x' | Remove-Item`, `'a','b' | ...`,
  // `$env:USERPROFILE | ...`, the inside of `@('D:\x')`): what it names flows down the pipeline, so it is
  // a mention a later verb inherits (review 2026-11-23). In PowerShell such a segment is an expression
  // (`$t[($n-30)..($n-1)]`, `$_ -match "\[x\]"`), never a command: nothing else in it is a path. In cmd
  // and a POSIX shell the words are still classified below, in case the head is a quoted program.
  if (!seg.call && !ctx.codeAsShell && isValueWord(words[0])) {
    // A group in a value list (`'.\build', ([char]68+':\DCIM') | Remove-Item`): what flows on cannot be read (review of wave 5).
    if (ctx.dialect === 'ps' && seg.groups.some(g => g.opener !== '{' && g.start > words[0].tok.start && !seg.words.some(t => t.start <= g.start && t.end >= g.end))) seg.transformed = true
    // An operator over the value (`'{0}:\DCIM' -f 'D'`, `$p -replace 'proj','.ssh'`, `'a;D:\x' -split ';'`): what
    // it makes is read where it can be (`-f` and `+` over literals); otherwise what flows on cannot be read,
    // and the words it is made of are never what flows (review 2026-11-23, fourth).
    if (ctx.dialect === 'ps' && words.some(w => w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && /^(?:-[A-Za-z]+|[+*/%]|-)$/.test(w.text))) {
      const made = wordsExpression(words.map(w => w.tok))
      if (made !== null) emitWord(ctx, seg, wordOf(ctx, made), 'mention', { relAllowed: true, verb: 'value' })
      else seg.transformed = true
    }
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
  // A PowerShell statement that starts with a group (`(Get-Date) - $t`) or is a method's arguments
  // (`.Substring(0, [Math]::Min(100, $n))`) is an expression, never a command (review 2026-11-23, fourth:
  // read as a program handed an operand, it was refused).
  if (!seg.call && ctx.dialect === 'ps' && !ctx.codeAsShell && (seg.methodArgs || seg.groups.some(g => g.opener !== '{' && g.start < words[0].tok.start))) {
    for (const w of words) emitAbsolute(ctx, seg, w, 'expression')
    consumeDocs(ctx, seg, docWords, null)
    return
  }
  // A list bound to a name and passed bare to a native program (`$a = '/c','rd','/s','/q','x'; & cmd $a`):
  // PowerShell hands each element on as an argument of its own, exactly as `@a` does, so the program's own options
  // (cmd /c, powershell -Command, python -c, git -C) read the elements. A name the scan cannot read, written where
  // an interpreter, a shell or git takes its first argument, is a command line the scan cannot read (ninth review).
  if (ctx.dialect === 'ps' && !ctx.codeAsShell) {
    const h = words[0]?.text === '&' || words[0]?.text === '.' ? 1 : 0
    const headV = verbName(words[h]?.text ?? '')
    if (words.length > h + 1 && isNativeHead(headV)) {
      const bare = (w: Word) => (w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' ? bareVarOf(ctx.run, w.value) : null)
      const first = bare(words[h + 1])
      if ((isInterpreter(headV) || headV === 'git') && first !== null && first.unreadable) {
        markSelfBuilding(ctx.run, 'a command line handed in through a variable that cannot be read')
      }
      words = words.flatMap((w, k) => {
        const e = k > h ? bare(w) : null
        return e?.list ? e.list.map(v => ({ ...literalWord(v), raw: w.raw, tok: { kind: 'w' as const, pieces: [{ t: v, q: 's' as const }], start: w.tok.start, end: w.tok.end, subs: [] } })) : [w]
      })
    }
  }
  // A splat of a table or a list the scan read is the words it stands for; one it cannot read, handed to a
  // program that runs a command line, is a command the scan cannot read (review 2026-11-24, sixth).
  if (ctx.dialect === 'ps' && !ctx.codeAsShell && words.some(w => splatOf(ctx.run, w.value) !== null)) {
    // A splat of a name nothing in the command set (`@path` of forfiles' text where PowerShell reads a splat) hands
    // on nothing (review 2026-11-24, seventh).
    // PowerShell's own variables (`@args` in a function, `@PSBoundParameters`, `@input`) are set, and stay unreadable.
    // cmd's `for ... do @rd` and `if ... @del` are cmd's echo-off, read with cmd's loop.
    const cmdConstruct = /^(?:for|if)$/i.test(words[0]?.text ?? '')
    words = words.flatMap((w, k) => (!cmdConstruct && k > 0 && w.tok.pieces[0]?.q === 'n' && w.tok.pieces.slice(1).every(p => p.t === '') && splatOf(ctx.run, w.value)?.b === null && /^@[A-Za-z_]\w*$/.test(w.value)
      && !/^@(?:args|input|psboundparameters|_|psitem|matches|myinvocation|this|event\w*|sender|foreach|switch)$/i.test(w.value) ? [] : splatWords(ctx, w) ?? [w]))
    const head = verbName(words[0]?.text ?? '')
    if ((isInterpreter(head) || head === 'start-process' || head === 'saps' || head === 'start') && words.some(w => splatOf(ctx.run, w.value) !== null)) {
      markSelfBuilding(ctx.run, 'a command line handed in through a splat that cannot be read')
    }
  }
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
    // wsl is read as an interpreter: with or without -c it hands its line to a shell (review 2026-11-23, fourth).
    if (!WRAPPERS.has(v)) break
    if ((v === 'start-process' || v === 'saps' || (v === 'start' && ctx.dialect === 'ps')) && !ctx.codeAsShell) {
      const sp = startProcess(ctx, seg, words.slice(1))
      if (sp === 'done') return
      if (sp !== null) { words = sp; continue }
    }
    if (v === 'xargs' || v === 'parallel') { words = xargsCommand(ctx, v, words.slice(1)); continue }
    words = unwrapWrapper(v, words.slice(1))
  }
  if (words.length === 0) { consumeDocs(ctx, seg, docWords, null); return }
  // `cd..`, `cd\`, `chdir..`: PowerShell's built-in functions and cmd's spellings of cd (review 2026-11-23).
  const glued = words[0].tok.pieces.length === 1 && words[0].tok.pieces[0].q === 'n' ? words[0].text.match(/^(cd|chdir)([.\\/].*)$/i) : null
  if (glued) words = [literalWord(glued[1]), literalWord(glued[2]), ...words.slice(1)]
  // `--%` (stop parsing): the rest of the line reaches the program as written, split as a native program splits it
  // (review 2026-11-24, sixth: `robocopy --% src dst`, `attrib --% -h C:\x` were one operand).
  const stop = words.findIndex((w, k) => k > 0 && w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && w.value === '--%')
  if (stop > 0 && !isInterpreter(verbName(words[0].text)) && verbName(words[0].text) !== 'git') {
    const restText = words.slice(stop + 1).map(w => w.value).join(' ')
    words = [...words.slice(0, stop), ...(restText.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map(x => ({ ...literalWord(x.replace(/"/g, '')), raw: x }))]
  }
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
  if (deviceVerb(ctx, seg, verb, operands)) return
  // Reported only: the segment is read on as before (wave 19c).
  brokerVerb(ctx, program, verb, operands)
  // A program-position script is run (exec); a program-position .exe or extensionless word is not a target.
  if (SCRIPT_EXT.test(program.text.replace(/[\\/]+$/, ''))) { emitWord(ctx, seg, program, 'exec', { relAllowed: true, verb: 'run' }); started(ctx, verb) }
  // A here-string piped into this segment.
  heresPipedInto(ctx, seg, verb)
  // A group or subexpression handed to git (`git -C .\sub, (Split-Path $PWD) clean -fdx`) names a folder or a
  // value the scan cannot read: git's work through it is unresolved (review of wave 5).
  // Only where git takes a folder: after `-C`, `--work-tree`, `--git-dir` (spaced, glued with `=`, or as the next
  // element of a list after them); a group elsewhere (`git diff -- ($files -join ' ')`) is an argument git reads.
  const gitFolderGroup = (g: Seg['groups'][number]) => {
    let k = -1
    for (let j = 0; j < seg.words.length; j++) if (seg.words[j].end <= g.start) k = j
    const at = (j: number) => (j >= 0 ? seg.words[j].pieces.map(x => x.t).join('') : '')
    const prev = at(k)
    if (/^(?:-C|--work-tree|--git-dir)$/.test(prev) || (/^--(?:work-tree|git-dir)=$/.test(prev) && seg.words[k].end === g.start)) return true
    return prev.endsWith(',') && /^(?:-C|--work-tree|--git-dir)$/.test(at(k - 1))
  }
  if (verb === 'git' && ctx.dialect === 'ps' && !ctx.codeAsShell
    && seg.groups.some(g => g.opener !== '{' && g.start >= program.tok.end && !seg.words.some(t => t.start <= g.start && t.end >= g.end) && gitFolderGroup(g))) {
    ctx.run.out.sawWrite = true
    unresolvedIn(ctx, 'write', 'git', true)
  }
  if (verb === 'git') { started(ctx, 'git'); return classifyGit(ctx, seg, operands, renderOrig(ctx.run, ctx.textSub.slice(seg.start, seg.end))) }
  if (isInterpreter(verb)) { started(ctx, verb); return interpreter(ctx, seg, verb, operands) }
  // `Invoke-Expression 'npm test'`: the literal string is read as the PowerShell command it is (`literalIexRemoved`).
  if ((verb === 'iex' || verb === 'invoke-expression') && !ctx.codeAsShell) {
    const ops = operands.filter(w => !/^-command$/i.test(w.text))
    const lit = ops.length === 1 && ops[0].tok.pieces.length > 0 && ops[0].tok.pieces.every(p => p.q !== 'n') && ops[0].tok.subs.length === 0
      && !ops[0].value.includes(S0) && !ops[0].value.includes(UNREAD) ? ops[0].value : null
    if (lit === null) { markSelfBuilding(ctx.run, 'Invoke-Expression of text the check cannot read'); return }
    ctx.run.out.texts.push(lit)
    scanPayload(ctx.run, lit, ctx.base, `${ctx.via}>iex`, ctx.depth + 1, 'shell', { dialect: 'ps', baseUnreadable: ctx.baseUnreadable })
    return
  }
  // A POSIX trap's action is a command line run later: read as one (review 2026-11-24, eighth). In PowerShell text too
  // when the action is a quoted string, which only a POSIX shell takes (PowerShell's `trap` takes a block), so the
  // command reads the same on the Bash tool's other shells (ninth review).
  const trapFirst = verb === 'trap' && !ctx.codeAsShell ? operands.find(w => !/^-/.test(w.text)) : undefined
  if (verb === 'trap' && !ctx.codeAsShell && (ctx.dialect === 'posix'
    || (ctx.dialect === 'ps' && trapFirst !== undefined && trapFirst.tok.pieces.length > 0 && trapFirst.tok.pieces.every(p => p.q !== 'n')))) {
    const first = trapFirst
    if (first) {
      const pl = payloadOf(ctx, [first], 0)
      if (pl.text === null) markSelfBuilding(ctx.run, 'a trap action the check cannot read')
      else { ctx.run.out.texts.push(pl.text); scanPayload(ctx.run, pl.text, ctx.base, `${ctx.via}>trap`, ctx.depth + 1, 'shell', { dialect: 'posix', baseUnreadable: ctx.baseUnreadable }) }
    }
    return
  }
  if (/^[gmn]?awk$/.test(verb) && !ctx.codeAsShell) awkProgram(ctx, seg, verb, operands)
  if (verb === 'find') return findVerb(ctx, seg, operands)
  if (CD_VERBS.has(verb)) return cdVerb(ctx, seg, verb, operands)
  if (POP_VERBS.has(verb)) {
    const top = ctx.dirStack.pop()
    if (top) { ctx.base = top.base; ctx.baseUnreadable = top.unreadable } else ctx.baseUnreadable = true
    return
  }
  // `cp -t DIR` / `--target-directory DIR`: the destination is named first (review 2026-11-23).
  // In a POSIX shell a command substitution written as an argument (`mv $(cat list) ./moved`) is an argument the
  // scan cannot read too (review 2026-11-24, sixth).
  let argGroups = ctx.dialect === 'posix' ? seg.groups.filter(g => g.opener === '$(') : seg.groups
  // `rm -f $(git ls-files -o)`, `rm -rf $(find . -name __pycache__)`: a listing written as an operand is the items it
  // names, as it is in a for loop (review 2026-11-24, seventh).
  let ops = operands
  if (!ctx.codeAsShell && (DELETE_VERBS.has(verb) || MOVE_VERBS.has(verb) || COPY_VERBS.has(verb) || WRITE_ALL.has(verb))) {
    for (const g of argGroups.filter(x => x.opener === '$(' && x.start >= program.tok.end && !seg.words.some(t => t.start <= x.start && t.end >= x.end))) {
      const items = listingSource(ctx.run, ctx.textSub.slice(g.start + 2, g.end - 1))
      if (items === null) continue
      const at = ops.findIndex(w => w.tok.start > g.start)
      const ws = items.map(v => ({ ...literalWord(v), raw: renderOrig(ctx.run, ctx.textSub.slice(g.start, g.end)), tok: { kind: 'w' as const, pieces: [{ t: v, q: 's' as const }], start: g.start, end: g.end, subs: [] } }))
      ops = at < 0 ? [...ops, ...ws] : [...ops.slice(0, at), ...ws, ...ops.slice(at)]
      argGroups = argGroups.filter(x => x !== g)
    }
  }
  const p = parseArgs(ops, verb, verb === 'cp' ? CP_VALUE_FLAGS : new Set(), argGroups, (ctx.dialect === 'ps' || ctx.dialect === 'posix') && !ctx.codeAsShell ? program.tok.end : null,
    (a, b) => renderOrig(ctx.run, ctx.textSub.slice(a, b)), ctx.dialect === 'ps')
  // A cmdlet that writes, deletes, moves or copies, given a parameter it does not have: which word PowerShell would take
  // as the target cannot be read (review 2026-11-24, eighth).
  // So is one handed a splat the scan cannot expand, which may carry the destination (`Copy-Item @c` with `$c` bound
  // to a table it cannot read: the copy's source and destination were taken from the other words).
  const unreadSplat = ctx.dialect === 'ps' && ops.some(w => w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && splatOf(ctx.run, w.value) !== null)
  if ((p.unknownParam !== undefined || unreadSplat) && !ctx.codeAsShell) {
    const op: MutOp | null = DELETE_VERBS.has(verb) ? 'delete' : MOVE_VERBS.has(verb) ? 'move'
      : COPY_VERBS.has(verb) || WRITE_TARGET_FIRST.has(verb) || WRITE_ALL.has(verb) || NEW_ITEM.has(verb) || ARCHIVE_VERBS.has(verb) ? 'write' : null
    if (op !== null) { ctx.run.out.sawWrite = true; unresolvedIn(ctx, op, verb, p.recursive); return }
  }
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
  if (NOTHING_VERBS.has(verb)) {
    // What it writes out flows down the pipeline: an element the scan cannot read makes all of it unreadable.
    // printf's format (`'%s\n'`) is not an item: what it holds is a mention, never what makes the flow unreadable.
    for (const [k, w] of [...p.positional, ...namedPaths(p, 'inputobject')].entries()) {
      if (emitWord(ctx, seg, w, 'mention', { relAllowed: true, verb }) === 'unreadable' && !(verb === 'printf' && k === 0)) seg.transformed = true
    }
    return
  }
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
    // A script written here (`Set-Content run.cmd 'rd /s /q D:\x'`, `'...' | Out-File x.ps1`): its content is
    // read as the program it is, since the same command may run it (review 2026-11-23, fourth).
    const script = targets.find(t => SCRIPT_EXT.test(t.text) && scriptRunToo(ctx, t.text))
    if (script) {
      let content = [...rest, ...namedPaths(p, 'value', 'inputobject')]
      if (content.length === 0 && seg.pipeIndex > 0) content = (previousInPipe(ctx, seg)?.words ?? []).map(t => wordOf(ctx, t)).filter(isValueWord)
      for (const w of content) {
        const x = expand(ctx.run, w.value, ctx.base, false)
        const text = x.here !== null ? ctx.run.bodies[x.here]?.text ?? null : x.text.includes(UNREAD) ? null : renderOrig(ctx.run, w.value)
        if (text !== null) scriptContent(ctx, script.text, text)
      }
    }
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
    const dest = namedPaths(p, 'destinationpath', 'destination', 'dest')
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
    ctx.run.out.ranProgram = true
    for (const w of p.positional) emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
    return
  }
  if (verb === 'join-path') {
    // Over two words it makes one path, which is what flows down a pipeline (review 2026-11-24, sixth).
    const jw = wordsExpression(seg.words)
    if (jw !== null && seg.groups.length === 0) { emitWord(ctx, seg, wordOf(ctx, jw), 'mention', { relAllowed: true, verb }); return }
  }
  // `Set-Item Env:NODE_OPTIONS ...`, `Set-Item variable:x ...`: an item of a provider that holds no files is not a
  // program's operand (review 2026-11-24, seventh); the temp rule reads the env: names. Anywhere else it writes.
  if ((verb === 'set-item' || verb === 'si') && ctx.dialect === 'ps') {
    const targets = [...namedPaths(p, 'path', 'literalpath', 'lp', 'pspath'), ...p.positional.slice(0, 1)]
    const files = targets.filter(w => !NON_FILE_PROVIDER.test(w.text) && !NON_FILE_PROVIDER.test(w.raw.trim().replace(/^['"]/, '')))
    if (files.length || targets.length === 0) mutate(ctx, seg, files, 'write', verb, false)
    return
  }
  if (READER_WRITERS.has(verb)) return readerWriter(ctx, seg, verb, operands)
  if (READ_VERBS.has(verb) || LIST_VERBS.has(verb)) {
    const op: PathOp = LIST_VERBS.has(verb) ? 'list' : 'read'
    // pytest is in the read table for its operands, but it runs the tests it finds.
    if (verb === 'pytest') started(ctx, verb)
    if (verb === 'certutil' && p.flags.some(f => f === '-decode' || f === '/decode')) markSelfBuilding(ctx.run, 'certutil -decode')
    const named = [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'lp', 'pspath', 'filepath')]
    // An item source handed something the scan cannot read hands on items it cannot read (review of wave 5:
    // `Get-ChildItem .\build, (Split-Path $PWD) -Force | Remove-Item` passed on only the build folder).
    for (const w of named) if (emitWord(ctx, seg, w, op, { relAllowed: true, verb, recursive: op === 'list' && p.recursive }) === 'unreadable') seg.transformed = true
    // A listing with no folder named lists the current one: what it hands down a pipeline is the items
    // inside it (`Get-ChildItem -Recurse -Filter *.pyc | Remove-Item`, review 2026-11-23, fourth).
    if (named.length === 0 && op === 'list' && seg.pipeIndex === 0 && !seg.groups.some(g => g.opener !== '{')) emitWord(ctx, seg, literalWord('.'), 'list', { relAllowed: true, verb, children: true, recursive: p.recursive })
    return
  }
  // Everything else: operands are unclassified; -OutFile, -Destination and -DestinationPath are writes. A
  // drive or share written inside an operand (`mshta "javascript:...('D:\\x')"`, an `Add-Type` source) is a
  // program operand too (review 2026-11-23); a `-Value` is a mention, as an assignment's value is.
  if (optionWrites(ctx, seg, verb, operands)) { started(ctx, verb); return }
  const writes = namedPaths(p, 'outfile', 'destination', 'dest', 'destinationpath')
  if (writes.length) mutate(ctx, seg, writes, 'write', verb, false)
  // A program, unless the head is a keyword or a cmdlet that only reads, filters or formats (review
  // 2026-11-23, fourth): it is started in the current folder, and an operand handed to it that the scan
  // cannot read is reported (`unreadOperand`), as a mutation through an unread target is.
  // A head the scan cannot read (`subprocess.run([sys.executable, ...])`) names no program to judge here.
  const isProgram = !NOT_A_PROGRAM.test(verb) && !verb.includes(UNREAD) && !/^[-+*/%=!<>|&]+$/.test(verb)
  if (isProgram) started(ctx, verb)
  // A drive or share spelling inside the operand is read whatever the word itself reads as (`/out:D:\b`
  // reads as a rooted path on the current drive).
  const programOperand = (w: Word) => {
    const r = emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
    // A group glued to the program word (`str(x)`, `p.get('a')`) is code PowerShell is shown by mistake (an
    // inline program's text read as PowerShell), not an operand handed to a program.
    const glued = w.value === UNREAD && w.tok.start === program.tok.end
    if (r === 'unreadable' && isProgram && !ctx.codeAsShell && !glued) ctx.run.out.unreadOperand ??= { verb }
    if (r !== 'ok' || !startsAbsolute(w)) emitAbsolute(ctx, seg, w, verb)
  }
  for (const w of [...p.positional, ...namedPaths(p, 'path', 'literalpath', 'lp', 'pspath', 'filepath', 'target')]) programOperand(w)
  // An option with its value glued on (`-oD:\b`, `/out:D:\b`) is read whatever the parameter parse made of it.
  for (const w of operands) if (!startsAbsolute(w)) emitAbsolute(ctx, seg, w, verb)
  for (const w of namedPaths(p, 'value')) emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb })
  for (const [name, list] of p.named) {
    // A cmdlet's own parameters are read above; a program's (`foo.exe -c X`, `mytool -File X`) are operands of
    // the program like any other (review 2026-11-24, sixth).
    if ((PS_PATH_PARAMS.has(name) || PS_VALUE_PARAMS.has(name)) && verb.includes('-')) continue
    for (const w of list) programOperand(w)
  }
}

const CP_VALUE_FLAGS = new Set(['-t', '--target-directory'])

/** PowerShell's providers that hold no files: the registry, the environment, functions, variables, aliases, certificates. */
const NON_FILE_PROVIDER = /^(?:hkcu|hklm|hkcr|hku|hkcc|env|function|variable|alias|cert|wsman):/i

/** POSIX tools (none of them a PowerShell alias) whose bare `/d` operand is msys's spelling of a drive's root (review 2026-11-24, sixth). */
const POSIX_TOOLS = new Set(['rsync', 'ln', 'find', 'touch', 'chmod', 'chown', 'tar', 'sdelete', 'shred', 'dd', 'install', 'scp', 'ditto'])

/** Verbs that act on a volume, a disk or a partition as a whole, whatever their operands. */
const DEVICE_VERBS = new Set(['format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'set-partition', 'resize-partition',
  'set-disk', 'repair-volume', 'optimize-volume', 'clear-recyclebin', 'diskpart', 'diskshadow', 'format', 'label', 'disable-computerrestore',
  'reagentc', 'bcdedit', 'remove-wbbackupset', 'remove-wbsystemstatebackup', 'remove-wbcatalog', 'remove-computerrestorepoint',
  // Storage pools, virtual disks, physical disks and disk images (review 2026-11-24, seventh).
  'remove-storagepool', 'remove-virtualdisk', 'reset-physicaldisk', 'dismount-diskimage', 'dismount-vhd', 'remove-physicaldisk',
  'clear-storagediagnosticinfo', 'set-physicaldisk', 'resize-virtualdisk',
  // A volume relabelled, a partition made, a disk converted, a backup policy removed or changed (review 2026-11-24, eighth).
  'set-volume', 'new-partition', 'convert-disk', 'remove-wbpolicy', 'set-wbpolicy', 'new-volume', 'format-disk'])

/**
 * Policy item 5 of the sixth review (2026-11-24): a volume, disk, partition, shadow-copy or backup operation is
 * refused as a device operation wherever it stands (plain, through cmd /c, powershell -Command, Start-Process,
 * a pipeline), because most of them name no path at all (`Format-Volume -DriveLetter D`) and a shadow copy is
 * what restored the owner's files on 2026-11-22. Returns true when it reported one.
 */
function deviceVerb(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): boolean {
  if (ctx.codeAsShell) return false
  const ops = operands.map(w => w.text.toLowerCase())
  const text = renderOrig(ctx.run, ctx.textSub.slice(seg.start, seg.end))
  let what: string | null = null
  if (DEVICE_VERBS.has(verb)) what = `runs ${verb}, which acts on a whole volume, disk or partition`
  else if (verb === 'mountvol' && ops.some(t => /^\/[dp]$/.test(t))) what = 'removes a volume mount point (mountvol /d or /p)'
  else if (verb === 'fsutil' && ((ops[0] === 'volume' && ops[1] === 'dismount') || (ops[0] === 'usn' && ops[1] === 'deletejournal')
    || (ops[0] === 'file' && ops[1] === 'setzerodata') || (ops[0] === 'reparsepoint' && ops[1] === 'delete') || ops[0] === 'repair')) what = `runs fsutil ${ops.slice(0, 2).join(' ')}`
  else if (verb === 'vssadmin' && /^(?:delete|resize)$/.test(ops[0] ?? '')) what = `runs vssadmin ${ops[0]}, which removes shadow copies`
  else if (verb === 'wmic' && ops.includes('shadowcopy') && ops.includes('delete')) what = 'deletes shadow copies through wmic'
  // A volume formatted, dismounted or checked through WMI (`wmic volume ... call format`, Win32_Volume's Format):
  // no path is named, the drive letter is a property (review 2026-11-24, seventh).
  else if (verb === 'wmic' && (ops.includes('volume') || ops.includes('diskdrive') || ops.includes('logicaldisk')) && ops.some(t => /^(?:format|dismount|chkdsk|delete|defrag)$/.test(t))) what = 'formats, dismounts or deletes a volume through wmic'
  else if (verb === 'wbadmin' && (ops[0] === 'delete' || (ops[0] === 'disable' && ops[1] === 'backup'))) what = ops[0] === 'delete' ? 'deletes backups through wbadmin' : 'switches the backup schedule off through wbadmin'
  else if (/^(?:remove-ciminstance|rcim|remove-wmiobject|rwmi|invoke-cimmethod|invoke-wmimethod)$/.test(verb) && /Win32_ShadowCopy/i.test(ctx.origText)) what = 'deletes shadow copies through WMI'
  // `Get-WmiObject Win32_ShadowCopy | % { $_.Delete() }`, `(gwmi Win32_ShadowCopy).Delete()`: the objects' own Delete (ninth review).
  else if (/^(?:get-wmiobject|gwmi|get-ciminstance|gcim)$/.test(verb) && /Win32_ShadowCopy/i.test(text) && /\.Delete\s*\(/i.test(ctx.origText)) what = 'deletes shadow copies through WMI'
  // `foreach ($s in Get-WmiObject Win32_ShadowCopy) { $s.Delete() }`: a loop over the listing, each object's own
  // Delete (wave 15: it read as a delete through a target that cannot be read).
  else if (verb === 'foreach' && /\bforeach\s*\(\s*\$\w+\s+in\s+\(?\s*(?:get-wmiobject|gwmi|get-ciminstance|gcim)\b[^)]*\bWin32_ShadowCopy\b/i.test(ctx.origText)
    && /\.Delete\s*\(/i.test(ctx.origText)) what = 'deletes shadow copies through WMI'
  else if (/^(?:remove-ciminstance|rcim|remove-wmiobject|rwmi|invoke-cimmethod|invoke-wmimethod|set-ciminstance|set-wmiinstance)$/.test(verb) && /Win32_(?:Volume|DiskDrive|DiskPartition|LogicalDisk|MappedLogicalDisk)\b|MSFT_(?:Volume|Disk|Partition|StoragePool|VirtualDisk|PhysicalDisk)\b/i.test(ctx.origText)) what = 'acts on a volume, a disk or a partition through WMI'
  // A WSL distribution unregistered (its virtual disk is deleted with it) or moved (review 2026-11-24, seventh).
  else if (/^wsl$/.test(verb) && ops.some(t => /^--(?:unregister|import-in-place)$/.test(t) || (t === '--manage' && ops.includes('--move')))) what = 'deletes or moves a WSL distribution and its virtual disk'
  else if (verb === 'wslconfig' && ops.some(t => /^\/(?:u|unregister)$/.test(t))) what = 'deletes a WSL distribution and its virtual disk'
  if (what === null) return false
  ctx.run.out.sawWrite = true
  const p: ShellPath = { raw: text.trim(), path: ctx.base, op: 'write', recursive: true, children: false, inherited: false, anchor: null, device: true,
    verb, via: ctx.via, deviceOp: what }
  emit(ctx.run, p)
  return true
}

/** A host operand of scp (`host:path`, `user@host:path`, `scp://...`); a one-letter name before the colon is a drive. */
const SCP_REMOTE = /^(?:scp:\/\/|[^\s\\/:@]+@[^\s\\/:]+:|[^\s\\/:@]{2,}:)/i

/**
 * Brokers (decision sheet item 12, plan step P3 item (1), wave 19c): a program that hands its work to a service that
 * runs it at the service's own level, outside the run's low-integrity token and its sandbox: WSL in any form (System32's
 * `bash.exe`, the WSL launcher, included), Docker and Podman, the Task Scheduler for anything but `/query`, WMI's
 * process creation, `runas`, and ssh, sftp and scp to a host (`Start-Process -Verb RunAs` is `startProcess`'s). It is
 * read where the program word stands, in any dialect and through any wrapper the scan reads, so the word in a string,
 * a comment or an operand (`docker-compose.yml`) is none. It is reported (`ShellScan.broker`, the first one), never
 * read in place of the segment: the paths the scan reads are the same with it as without it, and an interactive
 * engine, which judges nothing, is unchanged. The policy refuses it as rule `broker` (`protectedPaths.ts`).
 */
function brokerVerb(ctx: Ctx, program: Word, verb: string, operands: Word[]): void {
  if (ctx.codeAsShell || ctx.run.out.broker !== null) return
  const ops = operands.map(w => w.text.toLowerCase())
  const spelled = [program.text, program.value, program.raw].map(s => s.replace(/["']+$/, ''))
  let what: string | null = null
  if (/^(?:wsl|wslconfig|wslg)$/.test(verb)) what = `runs ${verb}, which starts programs in a WSL distribution outside this run`
  else if (verb === 'bash' && spelled.some(s => /(?:^|[\\/])(?:system32|sysnative)[\\/]bash(?:\.exe)?$/i.test(s))) what = 'runs System32\'s bash.exe, the WSL launcher, which starts programs in a WSL distribution outside this run'
  else if (/^(?:docker|docker-compose|podman|podman-compose)$/.test(verb)) what = `runs ${verb}, whose service starts containers outside this run`
  else if (verb === 'schtasks' && !/^[-/]query$/.test(ops[0] ?? '')) what = 'runs schtasks for something other than /query; the Task Scheduler runs programs outside this run'
  else if (verb === 'wmic' && ops.includes('process') && ops.includes('call') && ops.includes('create')) what = 'creates a process through WMI (wmic process call create), which runs it outside this run'
  else if (/^(?:invoke-cimmethod|icim|invoke-wmimethod|iwmi)$/.test(verb) && /\bWin32_Process\b/i.test(ctx.origText)) what = `creates a process through WMI (${verb} on Win32_Process), which runs it outside this run`
  else if (verb === 'runas') what = 'runs runas, which starts a program under another account or token'
  else if (verb === 'ssh' || verb === 'sftp') what = `runs ${verb}, which runs or copies on another host`
  else if (verb === 'scp' && operands.some(w => !w.text.startsWith('-') && (SCP_REMOTE.test(w.text) || w.text.includes(UNREAD) || hasUnreadableSentinel(ctx.run, w.value)))) what = 'runs scp to or from a host'
  if (what !== null) ctx.run.out.broker = what
}

/**
 * Heads of the "everything else" branch that are not programs: the shells' keywords and builtins, and the
 * PowerShell cmdlets that read, filter, format, wait or convert (review 2026-11-23, fourth). Measured on
 * the commands of past runs: without this set, `if (-not $?)`, `[Math]::Min(...)` and `Select-Object ...`
 * read as programs handed an unreadable operand.
 */
const NOT_A_PROGRAM = new RegExp('^(?:' + [
  'if', 'elseif', 'else', 'for', 'foreach', 'while', 'do', 'until', 'switch', 'break', 'continue', 'return', 'exit', 'throw', 'trap',
  'try', 'catch', 'finally', 'function', 'filter', 'param', 'begin', 'process', 'end', 'not', '-not', '-and', '-or', 'true', 'false',
  '\\[', '\\[\\[', 'test', ':', 'set', 'shift', 'unset', 'wait', 'goto', 'setlocal', 'endlocal', 'title', 'ver', 'pause', 'cls', 'color',
  'rem', 'clear', 'sleep', 'start-sleep', 'add-member', 'set-strictmode', 'import-module', 'clear-host', 'new-timespan', 'new-guid',
  'new-object', 'stop-process', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  // POSIX keywords and builtins, and the programs that only print what they are given or what they read
  // (review 2026-11-24, sixth: `$(date +%s)` and `$(basename "$f")` were read as unknown programs).
  'then', 'elif', 'fi', 'done', 'esac', 'in', 'read', 'local', 'export', 'declare', 'typeset', 'readonly', 'mapfile', 'getopts',
  'date', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'cut', 'tr', 'seq', 'expr', 'true', 'false', 'printenv', 'nproc',
  'hostname', 'whoami', 'uname', 'mktemp',
].join('|') + ')$|^(?:get|select|format|measure|foreach|where|write|convertto|convertfrom|out|test|compare|group|sort|join|split|wait|receive|read|show)-', 'i')

/**
 * A program, a script, an interpreter or git starts here (review 2026-11-23, fourth): the scan says so
 * (`ranProgram`) and names the folder it starts in as one of its operands (`startedIn`), or reports that the
 * folder cannot be read (`unreadFolder`). The policy judges both.
 */
function started(ctx: Ctx, verb: string): void {
  // A shell handed a command the scan reads is not a program of its own here: what it runs is read in its
  // payload (review 2026-11-24, sixth: `cmd /c "dir D:\DCIM"` counted as more than a read).
  if (!/^(?:cmd|powershell|pwsh|bash|sh|zsh)$/.test(verb)) ctx.run.out.ranProgram = true
  if (ctx.codeAsShell) return
  if (ctx.baseUnreadable) { ctx.run.out.unreadFolder ??= { verb }; return }
  emit(ctx.run, { raw: ctx.base, path: ctx.base, op: 'unclassified', recursive: false, children: false, inherited: false, anchor: null,
    device: false, verb, via: ctx.via, startedIn: true })
}

/**
 * Whether the command names the script it writes a second time (`Set-Content run.py ...; python run.py`,
 * `echo ... >x.cmd&x`): only then is its content read as a program. Writing a program is not running it.
 */
function scriptRunToo(ctx: Ctx, file: string): boolean {
  const name = file.replace(/^.*[\\/]/, '')
  const stem = name.replace(/\.\w+$/, '').toLowerCase()
  if (stem === '') return false
  // The names of the text counted once per text (a search per write was quadratic in a long command).
  let counts = ctx.run.nameCounts.get(ctx.origText)
  if (counts === undefined) {
    counts = new Map()
    for (const m of ctx.origText.matchAll(/[\w.-]+/g)) {
      const t = m[0].toLowerCase()
      const bare = t.replace(/\.\w+$/, '')
      counts.set(bare, (counts.get(bare) ?? 0) + 1)
    }
    ctx.run.nameCounts.set(ctx.origText, counts)
  }
  return (counts.get(stem) ?? 0) >= 2
}

/** The content of a script the command writes, read as the program it is (`.cmd`, `.ps1`, `.sh`, or code). */
function scriptContent(ctx: Ctx, file: string, text: string): void {
  const ext = (file.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase()
  const run = ctx.run
  run.out.texts.push(text)
  const via = `${ctx.via}>script .${ext}`
  const o = { baseUnreadable: ctx.baseUnreadable }
  if (ext === 'cmd' || ext === 'bat') scanPayload(run, text, ctx.base, via, ctx.depth + 1, 'shell', { ...o, dialect: 'cmd' })
  else if (ext === 'ps1') scanPayload(run, text, ctx.base, via, ctx.depth + 1, 'shell', { ...o, dialect: 'ps' })
  else if (ext === 'sh') scanPayload(run, text, ctx.base, via, ctx.depth + 1, 'shell', { ...o, dialect: 'posix' })
  else scanPayload(run, text, ctx.base, `${ctx.via}>script .${ext} -`, ctx.depth + 1, 'both', o)
}

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
  // An option with its value glued on (`-oD:\b`, `--out=D:\b`, `/out:D:\b`, `-DbuildDir=D:\b`): the value
  // is read too (review 2026-11-23, fourth).
  const glued = w.text.match(/^(?:-[A-Za-z](?=[A-Za-z]:[\\/]|\\\\)|--?[\w.-]+[=:]|\/[\w.-]+[:=]|-[DP][\w.-]+=)([\s\S]+)$/)
  for (const t of glued ? [w.text, glued[1]] : [w.text]) {
    for (const m of t.matchAll(EMBEDDED_ABS)) {
      const lit = m[0].startsWith('\\\\') ? `\\\\${m[0].slice(2).replace(/\\\\/g, '\\')}` : m[0].replace(/\\\\/g, '\\')
      emitWord(ctx, seg, { ...literalWord(lit), raw: lit }, 'unclassified', { relAllowed: false, verb })
    }
  }
}

/** A word that is itself a drive, share or device path: the path reading of it already named it. */
function startsAbsolute(w: Word): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(w.text)
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
  if (first.t.startsWith(S0) || first.t.startsWith(UNREAD) || first.t.startsWith(EMPTY_SUB)) return true
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
  const allTexts = operands.map(w => (w.tok.pieces[0]?.q === 'n' ? w.text.toLowerCase() : ''))
  const inAt = allTexts.indexOf('in')
  // The loop's own switches are the words before `in`: the body's (`del /f`) are not (review 2026-11-24, sixth).
  const lowerTexts = inAt >= 0 ? allTexts.map((t, j) => (j < inAt || t === 'in' || t === 'do' ? t : '')) : allTexts
  const doAt = lowerTexts.indexOf('do')
  const lo = inAt >= 0 ? operands[inAt].tok.end : seg.start
  const hi = doAt >= 0 ? operands[doAt].tok.start : Infinity
  const items: Word[] = []
  for (const g of seg.groups) {
    if (g.start < lo || g.end > hi) continue
    for (const s of segsIn(ctx, 'parent', seg.pipeline)) {
      if (s === seg || s.start < g.start || s.end > g.end) continue
      for (const t of s.words) {
        const w = wordOf(ctx, t)
        items.push(w)
        // A switch inside the set (`('dir /b *.tmp')`) is not a path.
        if (!/^\/[A-Za-z]$/.test(w.text)) emitWord(ctx, seg, w, 'mention', { relAllowed: false, verb: 'for' })
      }
    }
  }
  const rAt = lowerTexts.indexOf('/r')
  if (rAt >= 0 && operands[rAt + 1] && !/^%%?[A-Za-z]$/.test(operands[rAt + 1].raw)) {
    emitWord(ctx, seg, operands[rAt + 1], 'mention', { relAllowed: true, verb: 'for /r' })
  }
  if (doAt < 0 || doAt + 1 >= operands.length) return
  const bodyToks = operands.slice(doAt + 1).map(w => w.tok)
  // `for [/d] %d in (build\* x) do rd /s /q "%d"` (no /r, /f or /l): the loop variable is each element of a
  // literal list, a wildcard element being the items it matches inside its folder; the body is read once per
  // element with the variable as that element (review 2026-11-23, fourth). Modifiers (`%~dpd`) stay unread.
  const loopVar = operands.find(w => /^%%?[A-Za-z]$/.test(w.raw))?.raw
  let plain = rAt < 0 && !lowerTexts.includes('/f') && !lowerTexts.includes('/l')
  let readable = items.length > 0 && items.length <= 16 && items.every(w => !w.text.includes(UNREAD) && !hasUnreadableSentinel(ctx.run, w.value))
  // `for /r ROOT %v in (...)`: every item under ROOT; `for /f %v in ('dir /b [/s] X')`: the names dir prints, in
  // the working folder (with /s, full paths under X's folder) (review 2026-11-24, sixth).
  if (rAt >= 0 && readable && !lowerTexts.includes('/f') && !lowerTexts.includes('/l')) {
    const root = operands[rAt + 1] && !/^%%?[A-Za-z]$/.test(operands[rAt + 1].raw) ? operands[rAt + 1].value : '.'
    items.splice(0, items.length, literalWord(`${root.replace(/[\\/]+$/, '')}\\${DESC}`))
    plain = true
  } else if (lowerTexts.includes('/f') && !lowerTexts.includes('/l') && items.length >= 1) {
    const setText = items.map(w => w.text).join(' ').replace(/^'([\s\S]*)'$/, '$1')
    const d = setText.match(/^dir((?:\s+\/[a-z](?::\S*)?)*)\s+([^\s/][^\s]*)?((?:\s+\/[a-z](?::\S*)?)*)$/i)
    if (d) {
      const sw = `${d[1]} ${d[3]}`.toLowerCase()
      const folder = d[2] ? d[2].replace(/[^\\/]*$/, '') : ''
      // The whole set is the one listing (in cmd's own text a quote is an ordinary character, so the set was split
      // into words, and the switch was left behind as an element: review 2026-11-24, seventh).
      items.splice(0, items.length, literalWord(/\/s\b/.test(sw) ? `${folder || '.\\'}${DESC}` : `.\\${NAME}`))
      plain = true
      readable = true
    }
  } else if (lowerTexts.includes('/l') && rAt < 0 && !lowerTexts.includes('/f')) {
    // `for /l %i in (1,1,3)`: numbers, each a name with no separator (review 2026-11-24, eighth).
    const nums = items.map(w => w.text).join(',').split(',').map(x => x.trim()).filter(x => x !== '')
    if (nums.length === 3 && nums.every(x => /^-?\d+$/.test(x))) { items.splice(0, items.length, literalWord(NAME)); plain = true; readable = true }
  }
  // The redirects of the body hold the variable too (`... > out\sim%i.txt`, eighth review).
  const markToks = [...bodyToks, ...seg.redirects.flatMap(r => (r.target ? [r.target] : []))]
  const marks = loopVar === undefined ? [] : [...new Set(markToks.flatMap(t => t.pieces.flatMap(p => [...p.t.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))]
    .filter(m => { const e = ctx.run.table[Number(m[1])]; return e?.k === 'u' && e.orig === loopVar }).map(m => m[0]))))]
  // The variable with modifiers (`%~dpnf`, `%~nxf`): read from the element where the modifiers name a folder or a name
  // (eighth review, C1); any other modifier leaves the body unread.
  const modMarks = loopVar === undefined ? [] : [...new Set(markToks.flatMap(t => t.pieces.flatMap(p => [...p.t.matchAll(new RegExp(`${S0}(\\d+)${S1}`, 'g'))]
    .filter(m => { const e = ctx.run.table[Number(m[1])]; return e?.k === 'u' && new RegExp(`^%%?~[a-z]+${loopVar.replace(/^%+/, '')}$`, 'i').test(e.orig) }).map(m => m[0]))))]
  const modValue = (mark: string, value: string): string | null => {
    const e = ctx.run.table[Number(mark.slice(1, mark.indexOf(S1)))]
    const mods = (e?.orig.match(/~([a-z]+)/i)?.[1] ?? '').toLowerCase().slice(0, -1)
    if (!/^[fdpnx]+$/.test(mods)) return null
    if (mods.includes('f')) return value
    const folder = /[dp]/.test(mods) ? value.replace(/[^\\/]*$/, '') : ''
    return /[nx]/.test(mods) ? `${folder}${NAME}` : folder === '' ? null : folder
  }
  if (plain && readable && (marks.length > 0 || modMarks.length > 0)) {
    for (const item of items) {
      const mods = modMarks.map(m => [m, modValue(m, item.value)] as const)
      if (mods.some(([, v]) => v === null)) { classifySegment(ctx, { ...seg, words: bodyToks, redirects: seg.redirects, groups: [] }); return }
      const put = (t: string) => mods.reduce((acc, [m, v]) => acc.split(m).join(v as string), marks.reduce((acc, m) => acc.split(m).join(item.value), t))
      const redirects = seg.redirects.map(r => ({ op: r.op, target: r.target ? { ...r.target, pieces: r.target.pieces.map(p => ({ ...p, t: put(p.t) })) } : null }))
      classifySegment(ctx, { ...seg, words: bodyToks.map(t => ({ ...t, pieces: t.pieces.map(p => ({ ...p, t: put(p.t) })) })), redirects, groups: [] })
    }
    return
  }
  const body: Seg = { ...seg, words: bodyToks, redirects: seg.redirects, groups: [] }
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
 * PowerShell's common parameters: those that take a value, and the switches (review 2026-11-23, fourth:
 * `-ErrorAction SilentlyContinue` was skipped and its value taken for the program).
 */
const SP_COMMON_VALUE: Record<string, string> = { erroraction: 'erroraction', ea: 'erroraction', warningaction: 'warningaction', wa: 'warningaction',
  informationaction: 'informationaction', infa: 'informationaction', errorvariable: 'errorvariable', ev: 'errorvariable',
  warningvariable: 'warningvariable', wv: 'warningvariable', informationvariable: 'informationvariable', iv: 'informationvariable',
  outvariable: 'outvariable', ov: 'outvariable', outbuffer: 'outbuffer', ob: 'outbuffer', pipelinevariable: 'pipelinevariable', pv: 'pipelinevariable' }
const SP_COMMON_SWITCHES = new Set(['verbose', 'vb', 'debug', 'db', 'whatif', 'wi', 'confirm', 'cf'])

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
  const groupOf = new Map<string, Seg['groups'][number]>()
  const positional: Word[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]
    const m = w.tok.pieces[0]?.q === 'n' ? w.text.match(/^-([A-Za-z]+)(?::([\s\S]+))?$/) : null
    if (!m) { positional.push(w); continue }
    const lower = m[1].toLowerCase()
    if (SP_COMMON_SWITCHES.has(lower)) continue
    if (SP_COMMON_VALUE[lower] !== undefined) { if (m[2] === undefined) i++; continue }
    const name = SP_ALIASES[lower] ?? (SP_PARAMS.filter(p => p.startsWith(lower)).length === 1 ? SP_PARAMS.find(p => p.startsWith(lower)) : undefined)
    // A parameter name the scan does not know: how PowerShell binds the words after it cannot be read.
    if (name === undefined) { ctx.run.out.ranProgram = true; unresolvedIn(ctx, 'write', 'Start-Process', false); return 'done' }
    if (SP_SWITCHES.has(name)) continue
    if (m[2] !== undefined) { named.set(name, { ...w, value: w.value.slice(w.value.indexOf(':') + 1), text: m[2], raw: m[2], quotedFirst: null, tok: { ...w.tok, pieces: [{ t: m[2], q: 'n' }] } }); continue }
    const next = rest[i + 1]
    const group = seg.groups.find(g => g.opener !== '{' && g.start >= w.tok.end && (next === undefined || g.end <= next.tok.start))
    if (group) { named.set(name, unreadableWord('(...)')); groupOf.set(name, group); continue }
    if (next !== undefined) { named.set(name, next); i++ }
  }
  // `-Verb RunAs` asks Windows for an elevated start, a broker (wave 19c, `brokerVerb`); a verb the scan cannot read
  // may be RunAs. Reported only: the program and its arguments are read on as before.
  const spVerb = named.get('verb')
  if (spVerb !== undefined && ctx.run.out.broker === null) {
    const v = spVerb.text.trim().replace(/^["']+|["']+$/g, '')
    if (/^runas$/i.test(v) || spVerb.text.includes(UNREAD) || hasUnreadableSentinel(ctx.run, spVerb.value)) {
      ctx.run.out.broker = 'starts a program with Start-Process -Verb RunAs, which asks Windows for an elevated start'
    }
  }
  const prog = named.get('filepath') ?? positional[0]
  if (prog === undefined) return null
  let args = named.get('argumentlist') ?? (named.has('filepath') ? positional[0] : positional[1])
  // The argument list as a group written in place of the second positional word (`Start-Process cmd @('/c', ...)`).
  let argGroup = groupOf.get('argumentlist') ?? null
  if (args === undefined && argGroup === null) {
    argGroup = seg.groups.find(g => g.opener !== '{' && g.start >= prog.tok.end) ?? null
    if (argGroup) args = unreadableWord('(...)')
  }
  for (const k of ['redirectstandardoutput', 'redirectstandarderror']) {
    const w = named.get(k)
    if (w) mutate(ctx, seg, [w], 'write', `Start-Process -${k}`, false)
  }
  const input = named.get('redirectstandardinput')
  if (input) emitWord(ctx, seg, input, 'read', { relAllowed: true, verb: 'Start-Process' })
  if (args === undefined) return [prog]
  const quote = (s: string) => (/[\s"]/.test(s) && !s.includes(S0) ? `"${s.replace(/"/g, '')}"` : s)
  // A group of literals (`@('/c','rd ...')`) or a variable bound to a list or a value is read as that list or
  // value; anything else cannot be read (review 2026-11-23, fourth).
  let list: Word[] | null = null
  if (argGroup !== null) {
    const inner = ctx.textSub.slice(argGroup.start, argGroup.end).replace(/^[@$]?\(/, '').replace(/\)$/, '')
    const toks = joinCommaToks(tokenize(inner, false))
    const only = toks.length === 1 && toks[0].kind === 'w' ? wordOf(ctx, toks[0]) : null
    if (only !== null && !only.text.includes(UNREAD) && !hasUnreadableSentinel(ctx.run, only.value)) list = commaParts(only)
  } else {
    const bound = boundList(ctx, args)
    const e = bound === null ? args.value.match(new RegExp(`^${S0}(\\d+)${S1}$`)) : null
    const entry = e ? ctx.run.table[Number(e[1])] : null
    if (bound !== null) list = bound.map(v => literalWord(v))
    else if (entry?.k === 'bound' && entry.b.value !== null && !hasUnreadableSentinel(ctx.run, entry.b.value)) list = [literalWord(entry.b.value)]
    else {
      // Each element as the program receives it: a name inside single quotes is the program's own to set.
      const parts = commaParts(args).map(w => { const v = reopenQuoted(ctx.run, w.tok); return { ...w, value: v, tok: { ...w.tok, pieces: [{ t: v, q: 's' as const }] } } })
      if (!parts.some(w => hasUnreadableSentinel(ctx.run, w.value) || w.value.includes(UNREAD) || w.value.includes(EMPTY_SUB))) list = parts
    }
  }
  const family = interpFamily(verbName(expand(ctx.run, prog.value, ctx.base, ctx.tilde).text))
  if (list === null) {
    ctx.run.out.ranProgram = true
    if (family !== null) { markSelfBuilding(ctx.run, 'Start-Process handed a shell or an interpreter an argument list that cannot be read'); return 'done' }
    unresolvedIn(ctx, 'write', 'Start-Process', false)
    if (argGroup !== null) emitAbsolute(ctx, seg, literalWord(ctx.textSub.slice(argGroup.start, argGroup.end)), 'Start-Process')
    return 'done'
  }
  const argText = list.length > 1 || args.tok.pieces.some(p => p.q === 'n' && p.t.includes(',')) || argGroup !== null ? list.map(w => quote(w.value)).join(' ') : list[0].value
  let base = ctx.base
  let baseUnreadable = ctx.baseUnreadable
  const wd = named.get('workingdirectory')
  if (wd) {
    const p = pathOfWord(ctx, wd)
    if (p === null) baseUnreadable = true
    else { base = p; baseUnreadable = false }
  }
  const via = `${ctx.via}>Start-Process`
  // No shell is between Start-Process and the program: cmd's `/c` and powershell's `-Command` take the whole
  // rest of the line as their command, so it is read as that, never split by an outer shell's `&&` or `;`
  // first (review 2026-11-23, fourth: a `pushd D:\` there was read in a command of its own).
  const cmdLine = family === 'cmd' ? argText.match(/^\s*(?:\/[A-Za-z](?::\S*)?\s+)*\/[ckr](?:\s+|(?=\S))([\s\S]*)$/i) : null
  const psLine = family === 'powershell' || family === 'pwsh' ? argText.match(/(?:^|\s)[-/](?:c|co|com|comm|comma|comman|command)\s+([\s\S]*)$/i) : null
  if (cmdLine || psLine) {
    const sub: Ctx = { ...ctx, base, baseUnreadable }
    started(sub, family ?? 'Start-Process')
    // From a list, the elements after the switch, as the program receives them; from one string, the rest
    // of it, one level of whole-text quotes removed as the program's own argument parsing does.
    const at = list.findIndex(w => (cmdLine ? /^\/[ckr]$/i : /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i).test(w.value))
    const whole = (cmdLine ?? psLine)![1].trim()
    const payload = list.length > 1 && at >= 0 ? list.slice(at + 1).map(w => w.value).join(' ')
      : /^"[^"]*"$/.test(whole) ? whole.slice(1, -1) : whole
    ctx.run.out.texts.push(renderOrig(ctx.run, payload))
    scanPayload(ctx.run, payload, base, `${via}>${family}`, ctx.depth + 1, 'shell', { dialect: cmdLine ? 'cmd' : 'ps', baseUnreadable })
    return 'done'
  }
  const text = `${quote(prog.value)} ${argText}`
  ctx.run.out.texts.push(renderOrig(ctx.run, text))
  scanPayload(ctx.run, text, base, via, ctx.depth + 1, 'shell', { dialect: ctx.run.platform === 'win32' ? 'cmd' : 'posix', baseUnreadable })
  return 'done'
}

/**
 * The command `xargs` or `parallel` runs, with the items it is fed where it puts them (review 2026-11-24,
 * sixth): its replace string (`-I{}`, `-I %`, `--replace`, parallel's `{}`) is the pipeline's item, and with
 * none the items are appended after the command's own operands. A replace string inside a longer word is the
 * item with text around it; inside a shell's or an interpreter's program, a command the scan cannot read.
 */
function xargsCommand(ctx: Ctx, v: string, rest: Word[]): Word[] {
  let repl: string | null = v === 'parallel' ? '{}' : null
  let i = 0
  const vf = new Set(['-n', '-p', '-P', '-d', '-L', '-a', '-s', '-E', '-j', '--jobs', '-S', '--delimiter', '--arg-file', '--max-args', '--max-procs'])
  while (i < rest.length) {
    const t = rest[i].text
    if (t === '--') { i++; break }
    if (/^-I./.test(t)) { repl = t.slice(2); i++; continue }
    if (t === '-I' || t === '-J') { repl = rest[i + 1]?.text ?? '{}'; i += 2; continue }
    if (t === '-i' || t === '--replace') { repl = '{}'; i++; continue }
    if (/^(?:-i|--replace=)./.test(t)) { repl = t.replace(/^(?:-i|--replace=)/, ''); i++; continue }
    if (!/^-/.test(t) || t === '-') break
    i += vf.has(t) ? 2 : 1
  }
  const cmd = rest.slice(i)
  if (cmd.length === 0) return cmd
  const item = (raw: string): Word => ({ ...literalWord(sentinel(ctx.run, { k: 'p', orig: raw })), raw })
  // Only a shell, or an interpreter handed a program on its command line, builds a command from the items; an
  // interpreter running a fixed script or module takes them as file arguments (review 2026-11-24, seventh:
  // `git ls-files '*.py' | xargs python -m black` was refused).
  const head = verbName(cmd[0].text)
  const inner = /^(?:sh|bash|zsh|dash|cmd|powershell|pwsh|wsl)$/.test(head)
    || (isInterpreter(head) && cmd.slice(1).some(w => /^(?:-[a-z]*[ce]|-[a-z]*p|-r|--eval|--print|-command|-encodedcommand|-ec)$/i.test(w.text)))
  if (repl !== null && repl !== '' && cmd.some(w => w.text.includes(repl as string))) {
    if (inner && cmd.slice(1).some(w => w.text.includes(repl as string))) markSelfBuilding(ctx.run, `${v} hands a shell or an interpreter a command built from its input`)
    return cmd.map(w => {
      // The item with a suffix that stays in its folder (`{}.old`) is the same item for the check.
      if (w.text === repl || (w.text.startsWith(repl as string) && !/[\\/]|\.\./.test(w.text.slice((repl as string).length)))) return item(repl as string)
      if (!w.text.includes(repl as string)) return w
      const val = w.value.split(repl as string).join(sentinel(ctx.run, { k: 'p', orig: repl as string, xargs: true }))
      return { ...literalWord(val), raw: w.raw }
    })
  }
  if (inner) markSelfBuilding(ctx.run, `${v} hands a shell or an interpreter what it reads as arguments`)
  return [...cmd, item('{}')]
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

/** `READER_WRITERS`: each option that writes, deletes or runs a program is read as that; the rest are reads. */
/**
 * Programs the tables did not know that write, delete or move where an operand or an option says (review
 * 2026-11-24, sixth): rsync (the last operand; `--delete` deletes there; `--remove-source-files` moves the
 * sources), sdelete, cipher /w:, compact /s:, npm/pnpm/yarn --prefix, pip --target/--prefix/--root, dotnet
 * -o/--output, install, msiexec TARGETDIR=. True when the verb is one of them (read here).
 */
function optionWrites(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): boolean {
  const texts = operands.map(w => w.text)
  const lower = texts.map(t => t.toLowerCase())
  const glued = (k: number, cut: number): Word => ({ ...literalWord(operands[k].value.slice(cut)), raw: operands[k].raw })
  const after = (names: string[]): Word[] => {
    const out: Word[] = []
    for (let k = 0; k < operands.length; k++) {
      for (const n of names) {
        if (lower[k] === n && operands[k + 1]) { out.push(operands[k + 1]); break }
        if (lower[k].startsWith(`${n}=`) || (n.startsWith('/') && lower[k].startsWith(`${n}:`))) { out.push(glued(k, n.length + 1)); break }
      }
    }
    return out
  }
  const remote = (w: Word) => /^(?:[\w.-]+@)?[\w.-]{2,}:(?![\\/]{2})/.test(w.text) || /^[a-z][\w+.-]*:\/\//i.test(w.text)
  if (verb === 'rsync') {
    const vf = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from', '--log-file', '-T', '--temp-dir', '--partial-dir', '--backup-dir', '--chmod', '--port', '--password-file', '--link-dest', '--compare-dest', '--copy-dest'])
    const pos: Word[] = []
    for (let k = 0; k < operands.length; k++) {
      if (texts[k].startsWith('-')) { if (vf.has(texts[k])) k++; continue }
      pos.push(operands[k])
    }
    if (pos.length === 0) return true
    const dest = pos[pos.length - 1]
    const sources = pos.slice(0, -1)
    if (lower.some(t => t === '--remove-source-files')) { const local = sources.filter(w => !remote(w)); if (local.length) mutate(ctx, seg, local, 'move', 'rsync', true) }
    else for (const w of sources) if (!remote(w)) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb: 'rsync' })
    if (!remote(dest)) mutate(ctx, seg, [dest], lower.some(t => t.startsWith('--delete') || t === '--del') ? 'delete' : 'write', 'rsync', true)
    return true
  }
  // scp copies its sources to its last operand, ditto copies them into it (wave 15: a target outside the roots was
  // judged only as a program operand, against the always-denied set). A remote operand is no path here.
  if (verb === 'scp' || verb === 'ditto') {
    // scp's `-S program` and an ssh option that runs a local command (`-o ProxyCommand=...`, `-oLocalCommand=...`)
    // start a program the scan does not read.
    // Since wave 15b (P3-F9) also `-S`, `-D` (a local SFTP server program) or `-F` (a config file, which can hold a
    // ProxyCommand) anywhere in a cluster of flags, glued to its value or not (`-rS ./prog`, `-Fcfg`), and
    // `-o 'Match exec ...'`. A cluster is read letter by letter up to the first flag that takes a value.
    const RUNS = /^(?:proxycommand|localcommand|knownhostscommand|permitlocalcommand|match\b[\s\S]*\bexec)\b/i
    const runsProgram = (t: string, next: string): boolean => {
      const s = t.slice(1)
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if ('SFD'.includes(ch)) return true
        if ('cijlPX'.includes(ch)) return false
        if (ch === 'o') return RUNS.test(i + 1 < s.length ? s.slice(i + 1) : next)
      }
      return false
    }
    if (verb === 'scp' && texts.some((t, k) => t.startsWith('-') && !t.startsWith('--') && runsProgram(t, texts[k + 1] ?? ''))) markSelfBuilding(ctx.run, 'scp told to run a program (-S, -D, -F, or -o ProxyCommand, LocalCommand or Match exec)')
    const vf = new Set(verb === 'scp' ? ['-P', '-i', '-o', '-F', '-c', '-l', '-S', '-J', '-D', '-X'] : ['--arch', '--bom'])
    const pos: Word[] = []
    for (let k = 0; k < operands.length; k++) {
      if (texts[k].startsWith('-')) { if (vf.has(texts[k])) k++; continue }
      pos.push(operands[k])
    }
    if (pos.length === 0) return true
    const dest = pos[pos.length - 1]
    for (const w of pos.slice(0, -1)) if (!remote(w)) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb })
    if (!remote(dest)) mutate(ctx, seg, [dest], 'write', verb, true)
    return true
  }
  if (verb === 'sdelete' || verb === 'sdelete64') {
    const targets = operands.filter(w => !/^[-/]/.test(w.text))
    mutate(ctx, seg, targets, 'delete', verb, lower.some(t => /^[-/][a-z]*s/.test(t)))
    return true
  }
  if (verb === 'cipher' || verb === 'compact') {
    const sw = after(verb === 'cipher' ? ['/w', '/s'] : ['/s'])
    const targets = operands.filter(w => !/^\//.test(w.text))
    if (sw.length || targets.length) mutate(ctx, seg, [...sw, ...targets], 'write', verb, true)
    return true
  }
  const opts: Record<string, string[]> = {
    npm: ['--prefix', '-C'], pnpm: ['--prefix', '--dir', '-C'], yarn: ['--cwd', '--modules-folder'], bun: ['--cwd'],
    pip: ['--target', '-t', '--prefix', '--root'], pip3: ['--target', '-t', '--prefix', '--root'],
    dotnet: ['-o', '--output'],
  }
  if (opts[verb]) {
    const ws = after(opts[verb])
    if (ws.length === 0) return false
    mutate(ctx, seg, ws, 'write', verb, true)
    for (const w of operands) if (!ws.includes(w)) emitAbsolute(ctx, seg, w, verb)
    return true
  }
  if (verb === 'install') {
    const pos = operands.filter(w => !w.text.startsWith('-'))
    if (pos.length) mutate(ctx, seg, [pos[pos.length - 1]], 'write', 'install', true)
    return true
  }
  if (verb === 'msiexec') {
    const props = operands.filter(w => /^(?:TARGETDIR|INSTALLDIR|INSTALLLOCATION|APPDIR)=/i.test(w.text)).map(w => glued(operands.indexOf(w), w.value.indexOf('=') + 1))
    if (props.length) mutate(ctx, seg, props, 'write', 'msiexec', true)
    return false
  }
  return false
}

function readerWriter(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  const texts = operands.map(w => w.text)
  const lower = texts.map(t => t.toLowerCase())
  const valueOf = (names: string[]): Word[] => {
    const out: Word[] = []
    for (let k = 0; k < operands.length; k++) {
      const t = lower[k]
      for (const n of names) {
        if (t === n && operands[k + 1]) { out.push(operands[k + 1]); k++; break }
        if (n.startsWith('--') && t.startsWith(`${n}=`)) { const v = operands[k].value.slice(operands[k].value.indexOf('=') + 1); out.push({ ...operands[k], value: v, text: texts[k].slice(n.length + 1), quotedFirst: null, tok: { ...operands[k].tok, pieces: [{ t: v, q: 'n' }] } }); break }
        if (/^-[a-z]$/.test(n) && t.startsWith(n) && t.length > 2 && !t.startsWith('--')) { const v = operands[k].value.slice(2); out.push({ ...literalWord(v), raw: operands[k].raw }); break }
      }
    }
    return out
  }
  const used = new Set<Word>()
  const write = (ws: Word[], op: MutOp, recursive: boolean) => { for (const w of ws) used.add(w); if (ws.length) mutate(ctx, seg, ws, op, verb, recursive) }
  if (verb === 'rg') {
    const pre = valueOf(['--pre'])
    for (const w of pre) {
      used.add(w)
      ctx.run.out.ranProgram = true
      if (/\s/.test(w.text)) markSelfBuilding(ctx.run, 'rg --pre, which runs a command on every file it searches')
      else emitWord(ctx, seg, w, 'exec', { relAllowed: true, verb: 'rg --pre' })
    }
  } else if (verb === 'pytest') {
    started(ctx, verb)
    write(valueOf(['--basetemp']), 'delete', true)
  } else if (verb === 'sort') {
    write(valueOf(['-o', '--output', '/o']), 'write', false)
  } else if (verb === 'uniq') {
    const pos = operands.filter(w => !w.text.startsWith('-'))
    if (pos.length >= 2) write([pos[1]], 'write', false)
  } else if (verb === 'certutil') {
    if (lower.some(t => t === '-decode' || t === '/decode')) markSelfBuilding(ctx.run, 'certutil -decode')
    ctx.run.out.ranProgram = true
    if (lower.some(t => /^[-/](?:encode|decode|encodehex|decodehex|urlcache)$/.test(t))) {
      const pos = operands.filter(w => !/^[-/]/.test(w.text) && !/^[a-z][\w+.-]*:\/\//i.test(w.text))
      if (pos.length >= (lower.some(t => /^[-/]urlcache$/.test(t)) ? 1 : 2)) write([pos[pos.length - 1]], 'write', false)
    }
  }
  // With `rg --pre` every file searched is handed to that program, not only read.
  const handed = verb === 'rg' && lower.some(t => t === '--pre' || t.startsWith('--pre='))
  for (const w of operands) {
    if (used.has(w) || (/^[-/]/.test(w.text) && w.tok.pieces[0]?.q === 'n')) continue
    emitWord(ctx, seg, w, handed ? 'unclassified' : 'read', { relAllowed: !handed, verb })
  }
}

function cdVerb(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  // cmd's `cd /d X:\dir` and `chdir /d`: the switch is not the target (review 2026-11-23).
  if (verb === 'cd' || verb === 'chdir' || verb === 'pushd') operands = operands.filter(w => !(w.tok.pieces[0]?.q === 'n' && /^\/[A-Za-z?]$/.test(w.text)))
  const p = parseArgs(operands, verb, new Set(), seg.groups, null, undefined, ctx.dialect === 'ps')
  const target = namedPaths(p, 'path', 'literalpath')[0] ?? p.positional[0]
  if (verb === 'pushd' || verb === 'push-location') ctx.dirStack.push({ base: ctx.base, unreadable: ctx.baseUnreadable })
  // A parameter the cmdlet does not have: which word is the folder cannot be read (eighth review).
  if (p.unknownParam !== undefined) { ctx.baseUnreadable = true; return }
  if (!target) {
    // The repository root of the working folder (`Set-Location (git rev-parse --show-toplevel)`, `cd $(git rev-parse
    // --show-toplevel)`, `git rev-parse --show-toplevel | Set-Location`) is the folder a binding of it reads as (a
    // mission is never a subfolder of a repository): the folder does not change (ninth review).
    const gs = seg.groups.filter(g => g.opener !== '{')
    const TOP = /^[$@]?\(\s*git(?:\.exe)?\s+rev-parse\s+--show-toplevel\s*\)$/i
    if (gs.length === 1 && TOP.test(renderOrig(ctx.run, ctx.textSub.slice(gs[0].start, gs[0].end)).trim())) return
    const prev = gs.length === 0 && hasEarlier(ctx, seg) ? ctx.segs.find(s => s.pipeline === seg.pipeline && s.pipeIndex === seg.pipeIndex - 1) : undefined
    if (prev && prev.groups.length === 0 && TOP.test(`(${renderOrig(ctx.run, ctx.textSub.slice(prev.start, prev.end)).trim()})`)) return
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
  // A list, or a group beside the target (`Set-Location -Path .uild, ([char]68+':')`): not one folder the scan can read (review of wave 5).
  if (commaParts(target).length > 1 || seg.groups.some(g => g.opener !== '{' && !seg.words.some(t => t.start <= g.start && t.end >= g.end))) { ctx.baseUnreadable = true; return }
  const next = pathOfWord(ctx, target) ?? loopFolder(ctx, seg, target)
  if (next === null) { ctx.baseUnreadable = true; return }
  ctx.base = next
  ctx.baseUnreadable = false
}

/**
 * A folder change into a loop variable bound to a list of folders in one parent (`for p in packages/*\/; do (cd "$p"
 * && npm run build); done`, `foreach ($p in 'packages\a','packages\b') { Push-Location $p ... }`, `Get-ChildItem
 * packages -Directory | % { Push-Location $_.FullName ... }`): a folder in that parent, named by the element when
 * there is one (a glob's own pattern, `.*` included), otherwise by a name the scan cannot read (review 2026-11-24,
 * seventh). Null when the elements cannot be read or are not in one parent.
 */
function loopFolder(ctx: Ctx, seg: Seg, target: Word): string | null {
  const P = ctx.run.platform === 'win32' ? nodePath.win32 : nodePath.posix
  let paths: string[] = []
  const list = boundList(ctx, target)
  const inner = list === null ? listInside(ctx.run, target.value) : null
  if (list !== null || inner !== null) {
    const values = list ?? (inner as { at: string; list: string[] }).list.map(v => target.value.split((inner as { at: string }).at).join(v))
    for (const v of values) {
      const x = expand(ctx.run, v, ctx.base, ctx.tilde)
      if (x.pipe || x.here !== null || x.text.includes(UNREAD)) return null
      const t = x.text.replace(/[\\/]+$/, '')
      if (t === '' || /(?:^|[\\/])\.\.?$/.test(t)) return null
      paths.push(P.resolve(ctx.base, ctx.run.platform === 'win32' ? t.replace(/\//g, '\\') : t))
    }
  } else {
    const x = expand(ctx.run, target.value, ctx.base, ctx.tilde)
    if (!/^\u0005(?:\.(?:FullName|PSPath|Path|LiteralPath))?$/i.test(x.text) || !hasEarlier(ctx, seg)) return null
    const flow = inheritedSources(ctx, seg, true)
    const from = flow.paths.filter(s => s.path !== null && !CONTENT_VERBS.has(s.verb))
    if (flow.opaque || from.length === 0 || from.length < flow.paths.length) return null
    // An item of a folder listing is one level under the folder listed, whatever its `children` flag says (review
    // 2026-11-24, eighth, C9: a climb from it was read one level too high); under a recursive listing its depth is
    // not known.
    if (from.some(s => s.op === 'list' && s.recursive)) return null
    paths = from.map(s => (s.children || s.op === 'list' ? P.join(s.path as string, NAME) : s.path as string))
  }
  if (paths.length === 0 || paths.length > MAX_LOOP_ELEMENTS) return null
  const parents = new Set(paths.map(p => P.dirname(p).toLowerCase()))
  if (parents.size !== 1) return null
  if (paths.length === 1) return paths[0]
  const names = paths.map(p => P.basename(p))
  return P.join(P.dirname(paths[0]), names.every(n => n.startsWith('.')) ? `.${NAME}` : names.some(n => n.startsWith('.')) ? `.${NAME}` : NAME)
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
  if (/^(?:rename-item|rni)$/.test(verb) && !srcNamed.length) sources = p.positional.slice(0, 1)
  mutate(ctx, seg, sources, 'move', verb, true)
  // Rename-Item and cmd's ren only rename in place (a new name with a folder in it is an error), so the new
  // name lands beside the item already judged (review 2026-11-24, sixth).
  if (/^(?:rename-item|rni|ren|rename)$/.test(verb) && (ctx.dialect !== 'posix')) return
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
  // `cp -s` (`-rs`, `--symbolic-link`) makes links to the sources, not copies (review 2026-11-24, eighth).
  if (verb === 'cp' && p.flags.some(f => f === '--symbolic-link' || /^-[a-zA-Z]*s[a-zA-Z]*$/.test(f))) {
    for (const src of sources) for (const d of dests) link(ctx, seg, d, src, 'cp -s')
    return
  }
  for (const w of sources) emitWord(ctx, seg, w, 'read', { relAllowed: true, verb })
  mutate(ctx, seg, dests, 'write', verb, p.recursive)
}

function robocopy(ctx: Ctx, seg: Seg, p: Parsed): void {
  // PowerShell hands a list to a native program as separate arguments: robocopy's folders then shift, so
  // a list among them is not read as one folder (review of wave 5).
  if (p.positional.slice(0, 2).some(w => commaParts(w).length > 1 || w.value.endsWith(","))) {
    ctx.run.out.sawWrite = true
    unresolvedIn(ctx, 'delete', 'robocopy', true)
  }
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
    if (!at) { unresolvedIn(ctx, 'link', verb, false); return }
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

function link(ctx: Ctx, seg: Seg, at: Word, target: Word | null, verb: string, relToLink = false): void {
  ctx.run.out.sawWrite = true
  // A target bound to a list (a loop variable) is each element; one bound to an item made in a folder (`$(mktemp
  // -d)`) is that folder (review 2026-11-24, sixth). A symbolic link's relative target is read from the link's
  // own folder, as the system reads it (`ln -s ../src out/src` points to `src`).
  let values = target === null ? [] : (boundList(ctx, target) ?? [target.value])
  // `... | % { New-Item -ItemType SymbolicLink -Path x -Target $_ }`: the items the pipeline hands the block.
  if (target !== null && values.length === 1 && /^\u0005(?:\.(?:FullName|PSPath|Path))?$/i.test(expand(ctx.run, values[0], ctx.base, ctx.tilde).text)) {
    const flow = hasEarlier(ctx, seg) ? inheritedSources(ctx, seg, true) : { paths: [], opaque: true }
    const ps = flow.paths.filter(x => x.path !== null && !CONTENT_VERBS.has(x.verb))
    values = !flow.opaque && ps.length > 0 && ps.length <= MAX_LOOP_ELEMENTS && ps.every(x => !x.children) ? ps.map(x => x.path as string) : [UNREAD]
  }
  const linkDir = relToLink ? (() => { const p = pathOfWord(ctx, at); return p === null ? null : (ctx.run.platform === 'win32' ? nodePath.win32 : nodePath.posix).dirname(p) })() : null
  const targets = values.map(v => {
    const x = expand(ctx.run, v, linkDir ?? ctx.base, ctx.tilde)
    if (x.pipe || x.here !== null) return null
    const c = toPath(ctx.run, x.text, true, linkDir ?? ctx.base, x.anchor !== null)
    return c === null || c === 'unreadable' ? null : c.path
  })
  if (targets.length === 0) targets.push(null)
  let bad = false
  for (const t of targets) {
    const r = emitWord(ctx, seg, at, 'link', { relAllowed: true, verb, linkTarget: t })
    if (r !== 'ok' || t === null) bad = true
  }
  if (bad) unresolvedIn(ctx, 'link', verb, false)
}

function mklink(ctx: Ctx, seg: Seg, p: Parsed): void {
  const [at, target] = p.positional
  if (!at) { unresolvedIn(ctx, 'link', 'mklink', false); return }
  link(ctx, seg, at, target ?? null, 'mklink', !p.flags.some(f => f === '/j' || f === '/h'))
}

function lnVerb(ctx: Ctx, seg: Seg, p: Parsed): void {
  const pos = p.positional
  if (pos.length === 0) { unresolvedIn(ctx, 'link', 'ln', false); return }
  if (pos.length === 1) {
    const t = pos[0]
    const name = (pathOfWord(ctx, t) ?? t.text).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
    return link(ctx, seg, literalWord(name || '.'), t, 'ln')
  }
  link(ctx, seg, pos[pos.length - 1], pos[0], 'ln', p.flags.some(f => /^-[a-z]*s[a-z]*$/.test(f) || f === '--symbolic'))
}

/**
 * awk's own output and commands (review 2026-11-24, eighth): `print > "file"` and `>> "file"` write that file, read
 * when the target is literal text and the record numbers (`NR`, `FNR`, `NF`), a name with no separator, between its
 * literals; `system(...)`, a pipe to a command, or a redirect to anything else is a command line the scan cannot read.
 */
function awkProgram(ctx: Ctx, seg: Seg, verb: string, operands: Word[]): void {
  const prog = operands.find(w => !/^-/.test(w.text) && w.tok.pieces.some(p => p.q !== 'n'))
  if (!prog) return
  const text = prog.tok.pieces.map(p => p.t).join('')
  if (/\bsystem\s*\(|\|\s*"|"\s*\|\s*getline/.test(text)) { markSelfBuilding(ctx.run, 'an awk program that runs a command'); return }
  const redirects = [...text.matchAll(/\bprintf?\b[^;}]*?(>>?)\s*([^;}]*)/g)]
  for (const r of redirects) {
    // `print > ("out/part" NR ".txt")`, the form awk's manual recommends: one pair of enclosing parentheses (ninth review).
    const t0 = r[2].trim()
    const target = /^\([^()]*\)$/.test(t0) ? t0.slice(1, -1).trim() : t0
    const parts = target.match(/"[^"]*"|\b(?:NR|FNR|NF)\b/g) ?? []
    if (parts.join('').replace(/\s+/g, '') !== target.replace(/\s+/g, '') || parts.length === 0) { markSelfBuilding(ctx.run, 'an awk program that writes a file it computes'); return }
    const value = parts.map(x => (x.startsWith('"') ? x.slice(1, -1) : NAME)).join('')
    ctx.run.out.sawWrite = true
    mutate(ctx, seg, [literalWord(value)], 'write', `${verb} print >`, false)
  }
}

function findVerb(ctx: Ctx, seg: Seg, operands: Word[]): void {
  const paths: Word[] = []
  let k = 0
  while (k < operands.length && !/^[-(!]/.test(operands[k].text)) paths.push(operands[k++])
  // A root written as a group or a subexpression (`find $(cat list) -delete`) cannot be read: it is never `.`.
  const firstExpr = operands[k]?.tok.start ?? Infinity
  if (seg.groups.some(g => g.opener !== '{' && g.start < firstExpr && !seg.words.some(t => t.start <= g.start && t.end >= g.end))) paths.push(unreadableWord('(...)'))
  // Each root as its values (a loop variable bound to a list is each element), or null when one cannot be read.
  const rootValues: string[] | null = (() => {
    const out: string[] = []
    for (const w of paths.length ? paths : [literalWord('.')]) {
      for (const v of boundList(ctx, w) ?? [w.value]) {
        const x = expand(ctx.run, v, ctx.base, ctx.tilde)
        const c = x.pipe || x.here !== null ? 'unreadable' : toPath(ctx.run, x.text, true, ctx.base, x.anchor !== null)
        if (c === null || c === 'unreadable') return null
        out.push(v)
      }
    }
    return out.length <= MAX_LOOP_ELEMENTS ? out : null
  })()
  const expr = operands.slice(k).map(w => w.text.toLowerCase())
  let del = expr.includes('-delete')
  for (let j = 0; j < expr.length - 1; j++) {
    if (expr[j] !== '-exec' && expr[j] !== '-execdir' && expr[j] !== '-ok' && expr[j] !== '-okdir') continue
    let e = j + 1
    while (e < expr.length && !/^\\?[;+]$|^\\$/.test(expr[e])) e++
    const words = operands.slice(k + j + 1, k + e)
    j = e
    // Roots it read (review 2026-11-24, sixth): a delete run on each item, and nothing else, is the roots' delete
    // below; any other command is read once per root with `{}` as an item under it. Unread roots: `{}` cannot be
    // read. A delete body that names anything beside the item (`rm -rf ~/.cache/{}`, `rm -rf {} ../.vscode`) is
    // read per root too, never skipped (review 2026-11-24, seventh: the skip let those operands through).
    const bodyDeletes = /^(?:rm|rmdir|unlink|shred)$/.test(verbName(words[0]?.text ?? ''))
      && words.slice(1).every(w => /^-/.test(w.text) || w.text === '{}' || (w.text.startsWith('{}') && !/[\\/]|\.\./.test(w.text.slice(2))))
      && words.slice(1).some(w => w.text.startsWith('{}'))
    if (bodyDeletes) del = true
    if (rootValues !== null && bodyDeletes) continue
    const per = rootValues ?? [null]
    for (const root of per) {
      const body = words.map(w => (w.text === '{}' ? { ...w.tok, pieces: [{ t: root === null ? UNREAD : `${root.replace(/[\\/]+$/, '')}/${DESC}`, q: 'n' as const }] } : w.tok))
      if (body.length) classifySegment(ctx, { ...seg, words: body, redirects: [], groups: [] })
    }
  }
  // cmd's find.exe is a text search: `find "text" file`; its operands are reads.
  // A filter (`-name`, `-type`, a depth) makes it a delete of items under each root, not of the root itself.
  const filtered = expr.some(t => /^-(?:i?name|i?path|i?regex|type|mtime|mmin|atime|newer|size|empty|mindepth|perm|user)$/.test(t))
  // `-fprint FILE`, `-fprint0 FILE`, `-fls FILE`, `-fprintf FILE FMT`: find creates or truncates FILE (review 2026-11-24, eighth).
  for (let j = 0; j < expr.length - 1; j++) {
    if (/^-(?:fprint0?|fprintf|fls)$/.test(expr[j])) { ctx.run.out.sawWrite = true; mutate(ctx, seg, [operands[k + j + 1]], 'write', `find ${expr[j]}`, false); j++ }
  }
  if (del) mutate(ctx, seg, paths.length ? paths : [literalWord('.')], 'delete', 'find', true, true, filtered)
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
      else if (/^-C./.test(t)) dir = literalWord(t.slice(2))
      else if (/^-?[A-Za-z]*f$/.test(t) && !t.startsWith('--') && operands[j + 1]) file = operands[j + 1]
      else if (t.startsWith('--file=')) file = literalWord(t.slice(7))
    }
    if (extract) { if (file) emitWord(ctx, seg, file, 'read', { relAllowed: true, verb }); mutate(ctx, seg, [dir ?? literalWord('.')], 'write', verb, true); return }
    // `--remove-files` deletes every file it puts in the archive (review 2026-11-24, eighth).
    if (texts.includes('--remove-files')) {
      const srcs = operands.filter(w => !/^-/.test(w.text) && w !== file && w !== dir)
      mutate(ctx, seg, srcs.length ? srcs : [literalWord('.')], 'delete', 'tar --remove-files', true)
    }
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
  if (sub === 'a' || sub === 'u') {
    if (operands[1]) mutate(ctx, seg, [operands[1]], 'write', verb, false)
    // `-sdel` deletes the files once they are in the archive (eighth review).
    if (texts.some(t => /^-sdel$/i.test(t))) { const srcs = operands.slice(2).filter(w => !/^-/.test(w.text)); mutate(ctx, seg, srcs.length ? srcs : [literalWord('.')], 'delete', '7z -sdel', true) }
    return
  }
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

/**
 * A payload word with every name the outer text never set put back as written, where it stands inside single
 * quotes: the outer shell does not expand it there, and the payload's own shell reads it, and may set it
 * (review 2026-11-24, sixth: `powershell -Command '$t = ''.\build''; Remove-Item $t'` was read as a delete
 * through a name nothing set). A double-quoted or bare name was expanded by the outer shell and stays so.
 */
function reopenQuoted(run: Run, tok: WordTok): string {
  return tok.pieces.map(p => (p.q === 's' && p.t.includes(S0)
    ? p.t.replace(new RegExp(`${S0}(\\d+)${S1}`, 'g'), (m: string, n: string) => { const e = run.table[Number(n)]; return (e?.k === 'u' && e.unset) || e?.k === 'p' ? e.orig : m })
    : p.t)).join('')
}

/**
 * The first argument a native program receives from Windows PowerShell 5.1 for one argument `v` (wave 15). 5.1
 * wraps an argument in double quotes when it holds whitespace outside the double quotes no backslash escapes, and
 * escapes nothing inside; the program's C runtime then splits the line (`\"` is a quote, `"` toggles quoting, a
 * backslash before anything else is itself). So `rm -rf \"$X\"/*` arrives as `rm -rf "$X"/*`, and
 * `echo "a b"` as `echo a` (the rest is a second argument). Null when the result is `v` itself.
 */
function ps51Delivered(v: string): string | null {
  let quotes = 0
  let wrap = false
  let afterBackslash = false
  for (const ch of v) {
    if (ch === '"' && !afterBackslash) quotes++
    else if (/\s/.test(ch) && quotes % 2 === 0) wrap = true
    afterBackslash = ch === '\\'
  }
  const line = wrap ? `"${v}"` : v
  let out = ''
  let inQuotes = false
  for (let i = 0; i < line.length;) {
    const c = line[i]
    if (c === '\\') {
      let n = 0
      while (line[i + n] === '\\') n++
      if (line[i + n] === '"') {
        out += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) out += '"'
        else inQuotes = !inQuotes
        i += n + 1
        continue
      }
      out += '\\'.repeat(n)
      i += n
      continue
    }
    if (c === '"') { inQuotes = !inQuotes; i++; continue }
    if (!inQuotes && /\s/.test(c)) break
    out += c
    i++
  }
  return out === v ? null : out
}

/**
 * A POSIX `-c` payload with its positional parameters put in as the words after it (wave 15b, P3-F2): `args[0]`
 * is `$0`, `args[1]` is `$1`. `$N`, `${N}`, `$@`, `$*`, `${@}` and `${*}` outside single quotes are replaced, a
 * value quoted for where it stands (single-quoted outside quotes, escaped inside double quotes); a parameter with
 * no word is empty, as the shell has it; one whose word the scan cannot read (null) stays as written.
 */
const POSITIONAL_REF = /^\$(?:\d|[@*]|\{(?:\d+|[@*])\})$/

/**
 * A payload word with its positional parameters (`$1`, `$@` ...) put back as written where they stand inside
 * single quotes, so `bindPositional` can bind them (wave 15b): the outer text's reading had made each one a name
 * it cannot read. A double-quoted or bare one was expanded by the outer shell and stays so.
 */
function positionalAsWritten(run: Run, w: Word): Word {
  const re = new RegExp(`${S0}(\\d+)${S1}`, 'g')
  let changed = false
  const pieces = w.tok.pieces.map(p => {
    if (p.q !== 's' || !p.t.includes(S0)) return p
    const t = p.t.replace(re, (m: string, n: string) => { const e = run.table[Number(n)]; return e !== undefined && 'orig' in e && POSITIONAL_REF.test(e.orig) ? e.orig : m })
    if (t !== p.t) changed = true
    return { ...p, t }
  })
  if (!changed) return w
  return { ...w, tok: { ...w.tok, pieces }, value: pieces.map(p => p.t).join('') }
}

function bindPositional(text: string, args: Array<string | null>): string {
  if (args.length === 0 || !/\$(?:\d|[@*]|\{(?:\d+|[@*])\})/.test(text)) return text
  const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`
  const dq = (v: string) => v.replace(/[\\"$`]/g, m => `\\${m}`)
  let out = ''
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (quote === "'") { out += c; if (c === "'") quote = ''; i++; continue }
    if (c === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue }
    if (c === "'" && quote === '') { quote = "'"; out += c; i++; continue }
    if (c === '"') { quote = quote === '"' ? '' : '"'; out += c; i++; continue }
    const m = c === '$' ? text.slice(i).match(/^\$(?:(\d)|([@*])|\{(\d+)\}|\{([@*])\})/) : null
    if (!m) { out += c; i++; continue }
    const all = m[2] ?? m[4]
    if (all !== undefined) {
      const rest = args.slice(1)
      if (rest.some(v => v === null)) { out += m[0]; i += m[0].length; continue }
      const vals = rest as string[]
      out += quote === '"' ? vals.map(dq).join(all === '@' ? '" "' : ' ') : vals.map(sq).join(' ')
    } else {
      const n = Number(m[1] ?? m[3])
      const v = n < args.length ? args[n] : ''
      if (v === null) { out += m[0]; i += m[0].length; continue }
      out += quote === '"' ? dq(v) : v === '' ? '' : sq(v)
    }
    i += m[0].length
  }
  return out
}

/** The text of the words from `from` to the end of the segment, one quote level removed when it is one quoted word. */
function payloadOf(ctx: Ctx, words: Word[], from: number, native = false): { text: string | null; viaVariable: boolean } {
  const rest = words.slice(from)
  if (rest.length === 0) return { text: null, viaVariable: false }
  if (rest.length === 1) {
    const w = rest[0]
    const value = w.value
    // A payload computed by a subexpression (`cmd /c "$('rd ...')"`, `bash -c "$(cat c.sh)"`): a single string
    // literal is that text; anything else is a program the command builds (review 2026-11-23, fourth).
    if (w.tok.subs.length > 0 && (value.includes(UNREAD) || value.includes(EMPTY_SUB))) {
      const lit = w.tok.subs.length === 1 && (value === UNREAD || value === EMPTY_SUB) ? stringValue(w.tok.subs[0].trim(), true) : null
      return lit !== null ? { text: lit, viaVariable: false } : { text: null, viaVariable: true }
    }
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
    return { text: reopenQuoted(ctx.run, w.tok), viaVariable: false }
  }
  // PowerShell hands a native program each argument with its own quotes removed, and wraps in double quotes
  // only an argument that holds whitespace; after `--%` the rest of the line goes as written. So `'&&'` and
  // `"&"` reach cmd as its operators (review 2026-11-23, fourth). The payload is built the same way.
  if (native) {
    const parts: string[] = []
    for (const [k, w] of rest.entries()) {
      if (w.tok.pieces.length === 1 && w.tok.pieces[0].q === 'n' && w.value === '--%') {
        const next = rest[k + 1]
        if (next) parts.push(ctx.textSub.slice(next.tok.start, rest[rest.length - 1].tok.end))
        break
      }
      if (w.tok.subs.length > 0 && (w.value.includes(UNREAD) || w.value.includes(EMPTY_SUB))) return { text: null, viaVariable: true }
      const v = reopenQuoted(ctx.run, w.tok)
      parts.push(/\s/.test(w.text) ? `"${v}"` : v)
    }
    return { text: parts.join(' '), viaVariable: false }
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
  // `powershell -WorkingDirectory X -Command ...` runs its command in X (review 2026-11-24, sixth).
  let payBase = ctx.base
  let payUnreadable = ctx.baseUnreadable
  const scanText = (text: string, via: string, mode: 'shell' | 'both') => {
    ctx.run.out.texts.push(renderOrig(ctx.run, text))
    scanPayload(ctx.run, text, payBase, via, ctx.depth + 1, mode, { dialect: dialectOf(verb), baseUnreadable: payUnreadable })
  }
  const runPayload = (from: number, via: string, mode: 'shell' | 'both', encoded = false, words: Word[] = operands) => {
    const pl = payloadOf(ctx, words, from, ctx.dialect === 'ps' && !ctx.codeAsShell && mode === 'shell')
    if (pl.viaVariable) { selfBuildingVar(); return }
    if (pl.text === null) {
      // The payload is a group the scan could not evaluate (`python -c (Get-Content x -Raw)`, `cmd /c (...)`):
      // a program the command builds (review 2026-11-23, fourth).
      const flag = operands[from - 1]
      if (flag && seg.groups.some(g => g.opener !== '{' && g.start >= flag.tok.end)) markSelfBuilding(ctx.run, 'an inline program built by an expression that cannot be read')
      return
    }
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
    // `/k` (or `/c`) with nothing after it reads its commands from standard input (measured; review 2026-11-23, fourth).
    if (k < lower.length && /^\/[ckr]$/.test(lower[k]) && k + 1 >= operands.length && !seg.groups.some(g => g.start >= operands[k].tok.end)) return fromStdin(ctx, seg, verb, 'shell')
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
      if ((t === '-workingdirectory' || t === '-wd') && operands[k + 1]) {
        const wd = pathOfWord(ctx, operands[k + 1])
        if (wd === null) payUnreadable = true
        else { payBase = wd; payUnreadable = false }
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
    // Only among the shell's own options, before its first other word (`wsl find ... -exec` is not `-c`). For bash,
    // sh and zsh the command string is the first word after the options, wherever `-c` stands among them, and
    // `-o`, `+o`, `-O`, `+O` (also last in a cluster: `-euo pipefail`), `--rcfile` and `--init-file` take the next
    // word as their value (wave 15c, N4: `bash -o pipefail -c '...'` took `pipefail` for a script, and `bash -c -e
    // '...'` read `-e` as the payload). `ci` is the command string's index, `k` the word before it.
    let k = -1
    let ci = -1
    if (verb === 'wsl') {
      const firstWord = lower.findIndex(t => !t.startsWith('-'))
      k = lower.findIndex((t, j) => /^-[a-z]*c$/.test(t) && !t.startsWith('--') && (firstWord < 0 || j < firstWord))
      ci = k + 1
    } else {
      let hasC = false
      let j = 0
      for (; j < lower.length; j++) {
        const t = lower[j]
        if (t === '--' || t === '-') { j++; break }
        if (!/^[-+]./.test(t)) break
        if (t.startsWith('--')) { if (t === '--rcfile' || t === '--init-file') j++; continue }
        const letters = texts[j].slice(1)
        if (texts[j].startsWith('-') && letters.includes('c')) hasC = true
        // One value for EACH o or O letter of the cluster, as bash's option parser takes them (wave 19, C4:
        // `bash -ooc pipefail errexit '...'` took `errexit` for the command string).
        j += (letters.match(/[oO]/g) ?? []).length
      }
      if (hasC) { ci = j; k = j - 1 }
    }
    if (k >= 0) {
      // A payload written as adjacent quoted pieces (`'find ~ -name '\''x'\'' -delete'`): the POSIX reading of
      // it too, where the PowerShell reading differs (review 2026-11-24, sixth).
      const next = operands[ci]
      if (next && ctx.dialect !== 'posix') {
        const raw = ctx.textSub.slice(next.tok.start, seg.end).replace(/'\\''/g, '\u0007')
        const q = raw.match(/^'([^']*)'/)
        // (the sequence '\'' is POSIX's quote inside single quotes)
        const posix = q && q[1].includes('\u0007') ? q[1].replace(/\u0007/g, "'") : null
        if (posix !== null && posix !== next.value) scanText(reopenQuoted(ctx.run, { kind: 'w', pieces: [{ t: posix, q: 's' }], start: 0, end: 0, subs: [] }), `shell>${verb} -c`, 'shell')
      }
      // What Windows PowerShell 5.1 hands the shell (`ps51Delivered`: `bash -c 'rm -rf \"$X\"/*'` reaches bash as
      // `rm -rf "$X"/*`; wave 8 RR8-3, read since wave 15), beside the payload as written, which is what PowerShell
      // 7's standard argument passing hands on; for every payload since wave 15b (P3-F10). `trap rm`, which 5.1
      // makes of `trap "rm -rf x" EXIT`, deletes nothing (`mutate`).
      // The shell runs the one word after `-c`; the words after it are its `$0`, `$1` ... (wave 15b, P3-F2: joined
      // with them, `bash -c 'rm -rf ~/.ssh' _` was read as one quoted program word). That word is read with its
      // positional parameters bound to those words, beside the joined reading the scan always made (which hands
      // the later words to a program it cannot read).
      const args = operands.slice(ci + 1)
      const positional = args.map(w => (w.tok.subs.length === 0 && !w.value.includes(S0) ? w.value : null))
      const word = next && args.length > 0 ? positionalAsWritten(ctx.run, next) : next
      if (word && args.length > 0) {
        const one = payloadOf(ctx, [word], 0)
        if (one.text !== null && !one.viaVariable) scanText(bindPositional(one.text, positional), `shell>${verb} -c`, 'shell')
      }
      if (word && ctx.dialect === 'ps' && !ctx.codeAsShell) {
        const written = payloadOf(ctx, [word], 0, true)
        const delivered = written.text === null || written.viaVariable ? null : ps51Delivered(written.text)
        if (delivered !== null) scanText(bindPositional(delivered, positional), `shell>${verb} -c`, 'shell')
      }
      return runPayload(ci, `shell>${verb} -c`, 'shell')
    }
    // `wsl ls ';' rm -rf ...`: with no -c, wsl hands the rest of its line to the distribution's shell
    // (review 2026-11-23, fourth). `--cd` starts it in a folder the scan does not follow.
    if (verb === 'wsl') {
      let j = 0
      let cd = false
      while (j < operands.length && lower[j].startsWith('-') && operands[j].tok.pieces[0]?.q === 'n') {
        if (lower[j] === '-e' || lower[j] === '--exec' || lower[j] === '--') { j++; break }
        if (lower[j] === '--cd') cd = true
        j += ['-d', '--distribution', '-u', '--user', '--cd'].includes(lower[j]) ? 2 : 1
      }
      const pl = j < operands.length ? payloadOf(ctx, operands, j, ctx.dialect === 'ps') : { text: null, viaVariable: false }
      if (pl.viaVariable) { selfBuildingVar(); return }
      if (pl.text !== null) {
        ctx.run.out.texts.push(renderOrig(ctx.run, pl.text))
        scanPayload(ctx.run, pl.text, ctx.base, 'shell>wsl', ctx.depth + 1, 'shell', { dialect: 'posix', baseUnreadable: ctx.baseUnreadable || cd })
        return
      }
    }
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
        // perl's in-place switch in a cluster (`-pi`, `-i.bak`), never inside a module option (`-Mstrict`, `-MFile::Path`;
        // review 2026-11-24, eighth): the cluster is read on the word as written, and stops at an option that takes a value.
        if (verb === 'perl' && operands.some(x => { const m = x.text.match(/^-([A-Za-z]*)/); return m !== null && /^[^MIme]*i/.test(m[1]) })) {
          const files = operands.slice(k + 2).filter(x => !/^-/.test(x.text))
          mutate(ctx, seg, files, 'write', 'perl -i', false)
        }
        // A quoted program with words after it: the words are its arguments (`sys.argv[1]`, `process.argv[1]`),
        // read where the program names them, and judged as a program's operands here (review 2026-11-24, seventh).
        const pw = operands[k + 1]
        // Only plain words, spaced from the program and from each other, with no group among them: a program PowerShell
        // split at a `\"` it does not read as an escape is not a program and its arguments.
        const extraWords = operands.slice(k + 2)
        const plainArgs = extraWords.length > 0 && extraWords.length <= 16 && extraWords[0].tok.start > (pw?.tok.end ?? Infinity)
          && extraWords.every((w, j) => w.tok.pieces.length === 1 && /^[\w.\\/:~-]+$/.test(w.tok.pieces[0].t.replace(new RegExp(`${S0}\\d+${S1}`, 'g'), 'x'))
            && (j === 0 || w.tok.start > extraWords[j - 1].tok.end))
          && !seg.groups.some(g => pw !== undefined && g.start >= pw.tok.end)
        if (verb !== 'perl' && pw !== undefined && plainArgs && pw.tok.pieces.length > 0 && pw.tok.pieces.every(p => p.q !== 'n')) {
          const extra = operands.slice(k + 2)
          const was = ctx.run.codeArgv
          ctx.run.codeArgv = extra.map(w => { const x = expand(ctx.run, w.value, ctx.base, ctx.tilde); return x.pipe || x.here !== null || x.text.includes(UNREAD) || x.text === '' ? null : x.text })
          try { runPayload(k + 1, via, 'both', false, operands.slice(0, k + 2)) } finally { ctx.run.codeArgv = was }
          for (const w of extra) { emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb }); if (!startsAbsolute(w)) emitAbsolute(ctx, seg, w, verb) }
          return
        }
        return runPayload(k + 1, via, 'both')
      }
      const long = w.value.match(/^--(?:eval|print)=([\s\S]*)$/)
      if (long && (verb === 'node' || verb === 'bun')) return scanText(long[1], via, 'both')
      if (first.q === 'n' && w.tok.pieces.length > 1 && code.flag.test(first.t.toLowerCase())) return scanText(w.tok.pieces.slice(1).map(p => p.t).join(''), via, 'both')
      if (code.stop.test(t)) break
      // The value regex is matched on the word as written: python's `-X` and `-W` take a value, its `-x` does
      // not (review 2026-11-24, seventh: lower-cased, `-X utf8` ended the scan and hid the `-c` after it).
      if (code.value.test(texts[k]) || (verb === 'python' && /^--check-hash-based-pycs$/.test(t))) k++
    }
    // The options ended at a word that is not a script, with a code flag after it: the value of an option the
    // table does not know, and the program after it was not read. It is not run unread.
    const stop = operands.findIndex((w, k) => !w.text.startsWith('-') && (k === 0 || operands[k - 1].text.startsWith('-')))
    if (stop >= 0 && !SCRIPT_EXT.test(operands[stop].text) && !operands.slice(0, stop).some(x => code.stop.test(x.text.toLowerCase()))
      && operands.slice(stop + 1).some(x => code.flag.test(x.text.toLowerCase()) || /^--(?:eval|print)=/.test(x.text))) {
      markSelfBuilding(ctx.run, `an inline program after an option of ${verb0} the check does not know`)
      return
    }
  }
  if (verb === 'deno' && lower[0] === 'eval') return runPayload(1, 'shell>deno eval', 'both')
  // `-`, or no script at all, reads the program from standard input: a here-document (the consumer
  // rules) or what the earlier element of the pipeline writes (fromStdin).
  const m = lower.indexOf('-m')
  if (lower.includes('-') || (m < 0 && !operands.some(w => !w.text.startsWith('-')))) fromStdin(ctx, seg, verb, 'both')
  // `python -m pytest ...`, `python -m pip ...`: the module is the program, with its own option table (review
  // 2026-11-24, seventh: `python -m pytest --basetemp=../.cache` lost the rule `pytest --basetemp` has).
  if (verb === 'python' && m >= 0 && operands[m + 1] && /^(?:pytest|pip|pip3)$/.test(operands[m + 1].text)) {
    return classifySegment(ctx, { ...seg, words: operands.slice(m + 1).map(w => w.tok), redirects: [], groups: [] })
  }
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
    // An option's own value glued on (`--target=D:\x`, `-tD:\x`) is read too (review 2026-11-23, fourth), a
    // relative one that climbs as well (`--basetemp=../.cache`, review 2026-11-24, seventh).
    if (t.startsWith('-') && w.tok.pieces[0]?.q === 'n') {
      emitAbsolute(ctx, seg, w, verb)
      const eq = w.value.indexOf('=')
      if (/^--[\w-]+=/.test(t) && eq > 0) emitWord(ctx, seg, { ...literalWord(w.value.slice(eq + 1)), raw: w.raw }, 'unclassified', { relAllowed: false, verb })
      if (valueFlags.has(t.toLowerCase())) k++
      continue
    }
    if (CMD_SWITCH.test(t) && (verb === 'cmd')) continue
    if (!scriptSeen) {
      scriptSeen = true
      if (SCRIPT_EXT.test(t)) { emitWord(ctx, seg, w, 'exec', { relAllowed: true, verb }); continue }
    }
    emitWord(ctx, seg, w, 'unclassified', { relAllowed: false, verb })
    if (!startsAbsolute(w)) emitAbsolute(ctx, seg, w, verb)
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
  // The object store, the index and the common folder name where git writes too (review 2026-11-23, fourth).
  // The trace files git writes and the configuration files it reads and writes (review 2026-11-24, eighth).
  for (const m of ctx.textSub.matchAll(/(?:\$\{?env:)?\b(GIT_WORK_TREE|GIT_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_TRACE\w*|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG)\}?\s*=(?!=)\s*/gi)) {
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
  // Any spelling of them counts, `[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT', ...)` and
  // `Set-Item env:...` included; so does GIT_EXEC_PATH, the folder git runs its own commands from (review
  // 2026-11-23, fourth).
  if (ctx.via !== 'argv' && /\bGIT_(?:CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)|CONFIG|EXEC_PATH)\b/i.test(ctx.textSub)) {
    markSelfBuilding(ctx.run, 'git settings handed in through GIT_CONFIG_* or GIT_EXEC_PATH in the environment')
  }
  // The variables that name a program git runs (an editor, a pager, ssh, an askpass or diff helper), as the `-c`
  // forms of them are (review 2026-11-24, sixth).
  // A pager set to `cat`, `less` or `more` (or nothing) is honest and is not counted.
  const pagerSet = [...ctx.textSub.matchAll(/(?<![\w-])(?:GIT_)?PAGER\}?['"]?\s*[=,]\s*['"]?([^'";\s)|&]*)/gi)].some(m => !/^(?:cat|less|more)?$/i.test(m[1]))
  if (ctx.via !== 'argv' && (pagerSet || /\b(?:GIT_(?:SSH_COMMAND|SSH|EDITOR|SEQUENCE_EDITOR|ASKPASS|EXTERNAL_DIFF|PROXY_COMMAND)|SSH_ASKPASS)\b/i.test(ctx.textSub)
    || /(?:\$\{?env:|\bset\s+"?|\bexport\s+|(?:^|[\s;&|(])|\[Environment\]::SetEnvironmentVariable\(\s*['"])(?:EDITOR|VISUAL)\b\}?['"]?\s*[=,]/i.test(ctx.textSub))) {
    markSelfBuilding(ctx.run, 'a program for git to run, handed in through the environment')
  }
  // A git location set through an API rather than an assignment: where git then writes cannot be read.
  if (ctx.via !== 'argv' && /(?:SetEnvironmentVariable\s*\(\s*['"]|\b(?:Set-Item|New-Item|si|ni)\b[^;\n|]*\benv:\\?)GIT_(?:WORK_TREE|DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|COMMON_DIR)\b/i.test(ctx.textSub)) {
    ctx.run.out.sawWrite = true
    unresolvedIn(ctx, 'write', 'git (environment)', false)
  }
  const saved = { base: ctx.base, unreadable: ctx.baseUnreadable }
  for (const [name, w] of env) {
    ctx.run.out.sawWrite = true
    const r = emitWord(ctx, seg, w, 'write', { relAllowed: true, verb: `git (${name})` })
    if (r !== 'ok') unresolvedIn(ctx, 'write', `git (${name})`, false)
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
    if (r === 'unreadable') unresolvedIn(ctx, 'write', gitVerb(sub), false)
  }
  const valueOf = (w: Word, from: number): Word => {
    const v = w.value.slice(w.value.indexOf('=') + 1)
    return { ...w, value: v, text: w.text.slice(from), raw: w.raw.slice(w.raw.indexOf('=') + 1), quotedFirst: null }
  }
  // A group written right after an option is its value, and it cannot be read (`git -C $(Split-Path $PWD)
  // clean -fdx`): the next word is never taken in its place (review 2026-11-23, fourth).
  const groupAfter = (w: Word): boolean => {
    if (seg === null) return false
    const next = args[args.indexOf(w) + 1]
    return seg.groups.some(g => g.opener !== '{' && g.start >= w.tok.end && (next === undefined || g.end <= next.tok.start))
  }
  while (i < args.length) {
    const t = args[i].text
    if ((t === '-C' || t === '--git-dir' || t === '--work-tree') && groupAfter(args[i])) {
      out.sawWrite = true
      unresolvedIn(ctx, 'write', gitVerb(t), false)
      if (t !== '--git-dir') ctx.baseUnreadable = true
      i++; continue
    }
    if (t === '-C' && args[i + 1]) {
      gwrite(args[i + 1], '-C')
      const next = pathOfWord(ctx, args[i + 1])
      if (next !== null) ctx.base = next
      i += 2; continue
    }
    if (/^--(?:git-dir|work-tree)=/.test(t)) { gwrite(valueOf(args[i], t.indexOf('=') + 1), t.slice(0, t.indexOf('='))); i++; continue }
    if ((t === '--git-dir' || t === '--work-tree') && args[i + 1]) { gwrite(args[i + 1], t); i += 2; continue }
    // `--exec-path=<dir>`: git runs its own commands from that folder.
    if (/^--exec-path=/.test(t)) { markSelfBuilding(ctx.run, 'git --exec-path, which runs git commands from another folder'); i++; continue }
    // `--config-env=<key>=<var>` is `--config-env <key>=<var>` (review 2026-11-23, fourth).
    if (/^--config-env=/.test(t)) {
      const kw = { ...args[i], value: args[i].value.slice(args[i].value.indexOf('=') + 1), text: t.slice(t.indexOf('=') + 1) }
      args = [...args.slice(0, i), literalWord('--config-env'), kw, ...args.slice(i + 1)]
      continue
    }
    if (t === '-c' || t === '--config-env') {
      const kv = args[i + 1]?.text ?? ''
      // `-c core.worktree=<p>` moves the work tree as `--work-tree <p>` does (review 2026-11-23, third).
      if (/^core\.worktree=/i.test(kv) && args[i + 1]) {
        if (t === '-c') gwrite(valueOf(args[i + 1], kv.indexOf('=') + 1), '-c core.worktree')
        else { out.sawWrite = true; unresolvedIn(ctx, 'write', 'git --config-env core.worktree', false) }
      }
      // A pager or an editor named by a bare program name (`core.pager=cat`, an empty value) carries no
      // command text and is honest work; every other such setting, and a pager with an argument, a path or
      // a shell character, runs what the command carries.
      const value = kv.includes('=') ? kv.slice(kv.indexOf('=') + 1) : ''
      const bareOk = /^(?:core\.(?:pager|editor)|sequence\.editor|pager\.[^=]*)=/i.test(kv) && !/[\s\\/!;&|`$<>%]/.test(value)
      // Through --config-env the value is a variable's, which the scan does not read.
      if ((GIT_RUNNING_KEY.test(kv) && (!bareOk || t === '--config-env')) || /\bext::/.test(kv)) {
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
  // git takes any unique prefix of a long option (`fetch --upl`, `push --e`; measured on git 2.53, wave 15b, P3-F8),
  // and push's `--exec` is its `--receive-pack`.
  // rebase takes any prefix of `--exec` from `--ex` on (`--e` is ambiguous to git), and rebase and difftool take `-x`
  // at the end of a cluster of their switches (`-ix`, `-yx`); difftool does not abbreviate `--extcmd` (measured on
  // git 2.53, wave 19, C2: "option `exec' requires a value", "switch `x' requires a value", "invalid option: --extc").
  const RUN_FLAGS: Record<string, RegExp> = {
    rebase: /^(?:-[ifkmnqrv]*x|--e(?:x(?:e(?:c)?)?)?)$/, 'filter-branch': /^--[\w-]*-filter$/, difftool: /^(?:-[ygd]*x|--extcmd)$/, mergetool: /^(?:-x|--extcmd)$/,
    clone: longPrefixes(['-u'], 'upload-pack'), fetch: longPrefixes([], 'upload-pack'), pull: longPrefixes([], 'upload-pack'),
    'ls-remote': longPrefixes([], 'upload-pack'), push: longPrefixes([], 'receive-pack', 'exec'), archive: longPrefixes([], 'exec'),
    'fetch-pack': longPrefixes([], 'upload-pack'), 'send-pack': longPrefixes([], 'receive-pack', 'exec'),
    // 19b, C19-5 (measured on git 2.53): send-email runs these by their exact names (`--to-c` is "unrecognized
    // argument"), and an SMTP server given as a path is started as a sendmail program; instaweb starts its httpd and
    // browser, by any prefix down to `--h` and `--b`, and `-d` / `-b` after its `-l` switch.
    'send-email': /^--(?:to-cmd|cc-cmd|header-cmd|sendmail-cmd|smtp-server)$/,
    instaweb: /^(?:-l*[db]|--h(?:t(?:t(?:p(?:d)?)?)?)?|--b(?:r(?:o(?:w(?:s(?:e(?:r)?)?)?)?)?)?)$/,
  }
  // A word git does not know as a command is an alias, possibly of the repository's own configuration, which a run
  // can write (`alias.x = fetch`): its options may be any of these (wave 15c, the wave-15b builder's leftover).
  const ALIAS_RUN_FLAGS = longPrefixes([], 'upload-pack', 'receive-pack', 'exec')
  const subWord = args[i]?.text ?? ''
  const subRunFlag = Object.prototype.hasOwnProperty.call(RUN_FLAGS, sub) ? RUN_FLAGS[sub] : subWord !== '' && !GIT_MAIN_COMMANDS.has(subWord) ? ALIAS_RUN_FLAGS : undefined
  // `-x` with its value glued on (`-xmake`, `-ixmake`): git takes the rest of the word as the command (wave 19, C2).
  const GLUED_RUN_FLAG: Record<string, RegExp> = { rebase: /^-[ifkmnqrv]*x/, difftool: /^-[ygd]*x/, instaweb: /^-l*[db]/ }
  const gluedRunFlag = Object.prototype.hasOwnProperty.call(GLUED_RUN_FLAG, sub) ? GLUED_RUN_FLAG[sub] : undefined

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
    const runFlag = subRunFlag
    if (runFlag && runFlag.test(t) && rest[k + 1]) { runs(rest[++k].value); continue }
    const runEq = t.match(/^(--[\w-]+)=([\s\S]*)$/)
    if (runFlag && runEq && runFlag.test(runEq[1])) { runs(w.value.slice(w.value.indexOf('=') + 1)); continue }
    const glued = gluedRunFlag?.exec(w.value)
    if (glued && w.value.length > glued[0].length) { runs(w.value.slice(glued[0].length)); continue }
    if (sub === 'grep' && /^(?:-O.|--open-files-in-pager=)/.test(t)) { runs(t.startsWith('-O') ? w.value.slice(2) : w.value.slice(w.value.indexOf('=') + 1)); continue }
    // `apply` / `am` `--directory`, `checkout-index --prefix`: where the files are written (review 2026-11-23).
    if ((sub === 'apply' || sub === 'am') && /^--directory=/.test(t)) { gwrite(valueOf(w, 12), sub); continue }
    if ((sub === 'apply' || sub === 'am') && t === '--directory' && rest[k + 1]) { gwrite(rest[++k], sub); continue }
    if (sub === 'checkout-index' && /^--prefix=/.test(t)) { gwrite(valueOf(w, 9), sub); continue }
    if ((sub === 'apply' || sub === 'am') && t === '--unsafe-paths') { markSelfBuilding(ctx.run, `git ${sub} --unsafe-paths, which writes wherever the patch says`); continue }
    // Options that name where git writes: a separate git folder, a template, marks files, an output folder,
    // any `--<x>-dir=` / `--<x>-directory=`, `-o` with its value glued on (review 2026-11-23, fourth).
    if (/^--(?:separate-git-dir|template|export-marks|import-marks|output-directory|output[\w-]*|[\w-]+-dir|[\w-]+-directory)=/.test(t)) { gwrite(valueOf(w, t.indexOf('=') + 1), sub); continue }
    if ((t === '--separate-git-dir' || t === '--template' || t === '--output-directory' || t === '--export-marks' || t === '--import-marks' || (t === '--file' && sub !== 'commit' && sub !== 'config')) && rest[k + 1]) { gwrite(rest[++k], sub); continue }
    if (/^-o./.test(t) && sub !== 'commit' && w.tok.pieces[0]?.q === 'n') { gwrite({ ...w, value: w.value.slice(2), text: t.slice(2), raw: w.raw.slice(2), quotedFirst: null }, sub); continue }
    // `clone -c <key>=<value>` / `--config`: a setting of the new repository, which can run a program.
    // Any prefix of `--config` from `--co` on (`--c` is ambiguous to git; wave 15b, P3-F8).
    const configOpt = t.match(/^(--co(?:n(?:f(?:i(?:g)?)?)?)?)(=|$)/)
    if ((sub === 'clone' || sub === 'submodule') && (t === '-c' || configOpt !== null)) {
      const glued = configOpt !== null && configOpt[2] === '='
      const kv = glued ? t.slice(configOpt[1].length + 1) : rest[k + 1]?.text ?? ''
      if (GIT_RUNNING_KEY.test(kv) || /^core\.worktree=/i.test(kv) || /\bext::/.test(kv)) markSelfBuilding(ctx.run, `git ${sub} -c ${kv.replace(/=.*$/s, '')}, a setting that runs a program`)
      if (!glued) k++
      continue
    }
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
  // `bisect run <cmd> [<arg>...]`: git runs the words after `run` through its shell (19b, C19-5), as `submodule foreach`.
  if (sub === 'bisect' && operands[0]?.text.toLowerCase() === 'run') {
    const cmd = rest.slice(rest.indexOf(operands[0]) + 1)
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
    // `git ls-files -d | xargs git rm`: the items a listing it read hands on, as any mutation reads them (review
    // 2026-11-24, seventh).
    if (r === 'pipe' && seg !== null && hasEarlier(ctx, seg)) {
      const flow = inheritedSources(ctx, seg, true)
      const sources = flow.paths.filter(s => s.path !== null && !CONTENT_VERBS.has(s.verb))
      if (flow.opaque || sources.length === 0 || sources.length < flow.paths.length) { unresolvedIn(ctx, op, verb, recursive); continue }
      for (const s of sources.slice(0, MAX_PATHS)) {
        const p: ShellPath = { ...s, op, recursive, inherited: true, verb, via: ctx.via }
        delete p.linkTarget
        emit(ctx.run, p)
      }
      continue
    }
    // A pathspec of `git rm`, `git restore`, `git clean` or `git checkout --` that cannot be read still names only files
    // of the work tree (git refuses a path outside it): the work tree's own files, when git finds it from the working
    // folder the scan read and nothing names another (review 2026-11-24, eighth: `foreach ($d in $del) { git rm
    // "gilded/tests/$d" }` over a list read from a file was escalated before the cut was closed, and refused after it).
    if (r === 'unreadable' && /^git (?:rm|restore|clean|checkout)$/.test(verb) && !ctx.baseUnreadable
      && !/--(?:work-tree|git-dir)|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b|(?:^|\s)-C\b/i.test(ctx.textSub)) {
      emitWord(ctx, seg, literalWord(ctx.base), op, { relAllowed: true, verb, recursive, children: true })
      continue
    }
    if (r === 'unreadable' || r === 'pipe') unresolvedIn(ctx, op, verb, recursive)
  }
}

// ─── (i) Code calls ────────────────────────────────────────────────────────────────────────────

const FS_MOD = String.raw`(?:\bfs|\bfsp|\bfsPromises|\bfse|require\(\s*['"](?:node:)?fs(?:/promises|-extra)?['"]\s*\))(?:\.promises)?\.`
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
  // Review 2026-11-24, sixth: archives unpacked, files truncated or opened for writing, Ruby's File and FileUtils,
  // fs-extra's calls.
  { re: /\.extractall\s*\(/g, kind: 'write', recursive: true, style: 'args' },
  { re: /\bshutil\.unpack_archive\s*\(/g, kind: 'copy', style: 'args' },
  { re: /\bos\.truncate\s*\(/g, kind: 'write', style: 'args' },
  { re: /\bsqlite3\.connect\s*\(/g, kind: 'write', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:truncate|truncateSync)\\s*\\(`, 'g'), kind: 'write', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:openSync|open)\\s*\\(`, 'g'), kind: 'open', style: 'args' },
  { re: /\bFile\.(?:write|binwrite)\s*\(/g, kind: 'write', style: 'args' },
  { re: /\bFile\.open\s*\(/g, kind: 'open', style: 'args' },
  { re: /\bFileUtils\.(?:mkdir_p|mkdir|touch)\s*\(/g, kind: 'write', style: 'args' },
  { re: /\bFileUtils\.(?:mv|move)\s*\(/g, kind: 'move', style: 'args' },
  { re: /\bFileUtils\.(?:cp|cp_r|copy)\s*\(/g, kind: 'copy', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:removeSync|remove|emptyDirSync|emptyDir)\\s*\\(`, 'g'), kind: 'delete', recursive: true, style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:outputFileSync|outputFile|ensureDirSync|ensureDir|mkdirpSync|mkdirsSync|writeJsonSync|outputJsonSync)\\s*\\(`, 'g'), kind: 'write', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:moveSync|move)\\s*\\(`, 'g'), kind: 'move', style: 'args' },
  { re: new RegExp(`${FS_MOD}(?:copySync|copy)\\s*\\(`, 'g'), kind: 'copy', style: 'args' },
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
  // An archive extracted into a folder, or a folder packed into an archive: a copy from the first to the second
  // (review 2026-11-24, eighth: a relative `..\.config` was not read).
  { re: /\[(?:System\.)?IO\.Compression\.ZipFile(?:Extensions)?\]::(?:ExtractToDirectory|CreateFromDirectory)\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\.Delete\s*\(/g, kind: 'delete', style: 'receiver-or-args' },
  { re: /\.MoveTo\s*\(/g, kind: 'move', style: 'receiver-or-args' },
  { re: /\.CopyTo\s*\(/g, kind: 'copy', style: 'receiver-or-args' },
  // COM's Scripting.FileSystemObject and VisualBasic's FileSystem (review 2026-11-23).
  { re: /(?:\.|::)Delete(?:Folder|File|Directory)\s*\(/gi, kind: 'delete', style: 'args' },
  { re: /(?:\.|::)Move(?:Folder|File|Directory)\s*\(/gi, kind: 'move', style: 'args' },
  { re: /(?:\.|::)Copy(?:Folder|File|Directory)\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(/gi, kind: 'shell', style: 'args' },
  // PowerShell's own provider API, the same operations as the item cmdlets (review 2026-11-24, sixth).
  { re: /\.InvokeProvider\.Item\.(?:Remove|Clear)\s*\(/gi, kind: 'delete', style: 'args' },
  { re: /\.InvokeProvider\.Item\.(?:Move|Rename)\s*\(/gi, kind: 'move', style: 'args' },
  { re: /\.InvokeProvider\.Item\.Copy\s*\(/gi, kind: 'copy', style: 'args' },
  { re: /\.InvokeProvider\.(?:Item\.(?:New|Set)|Content\.GetWriter)\s*\(/gi, kind: 'write', style: 'args' },
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

/** `list`: a loop variable of an inline program over a list the scan read (each element, substituted form). */
type CodeBindings = Map<string, { value: string | null; count: number; list?: string[] }>

/** The names an inline program binds to Node's `path` or Python's `os.path` module (`pathModules`). */
const PATH_MODULES_DEFAULT = ['os.path', 'posixpath', 'ntpath', 'path', 'path.posix', 'path.win32']

/**
 * The names the code binds to a path module (review 2026-11-24, sixth): `p = require('path')`, `import * as p
 * from 'path'`, `import os.path as osp`, `from os import path`; and the functions destructured from one
 * (`const { join } = require('path')`, `from os.path import join`), which `evalCall` reads as joins.
 */
function pathModules(code: string): { mods: Set<string>; fns: Set<string> } {
  const mods = new Set(PATH_MODULES_DEFAULT)
  const fns = new Set<string>()
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s+|,\s*)([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](?:node:)?path['"]\s*\)/g)) mods.add(m[1])
  for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"](?:node:)?path['"]/g)) mods.add(m[1])
  for (const m of code.matchAll(/\bimport\s+(?:os\.path|posixpath|ntpath)\s+as\s+([A-Za-z_]\w*)/g)) mods.add(m[1])
  if (/\bfrom\s+os\s+import\s+[^\n;]*\bpath\b/.test(code)) mods.add('path')
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?path['"]\s*\)|\bfrom\s+(?:os\.path|posixpath|ntpath)\s+import\s+([\w\s,]+)/g)) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) {
      const pm = part.trim().match(/^(join|resolve)(?:\s*(?::|\s+as\s+)\s*([A-Za-z_$][\w$]*))?$/)
      if (pm) fns.add(pm[2] ?? pm[1])
    }
  }
  return { mods, fns }
}

/** A code expression's value when it is the whole of one literal form (finding 2.M1 part 3), else null. */
function evalExpr(run: Run, e0: string, codeBindings: CodeBindings): string | null {
  const e = stripParens(e0)
  if (e === '') return null
  // An item source's own path is read whole (`Get-Item ./out/a.txt` is one command, not a division).
  if (run.psStrings && /^(?:Get-Item|gi|Get-ChildItem|gci|Resolve-Path|rvpa)\s/i.test(e)) return evalAtom(run, e, codeBindings)
  const parts = splitTop(e, '/', !run.psStrings).map(p => stripParens(p))
  if (parts.length > 1 && !stringValue(e, run.psStrings)) {
    const head = evalAtom(run, parts[0], codeBindings)
    if (head === null) return null
    const tails: string[] = []
    for (const p of parts.slice(1)) { const v = evalAtom(run, p, codeBindings); if (v === null) return null; tails.push(v) }
    return joinParts([head, ...tails])
  }
  // Python's `%` over literals (`'out/%s' % 'cache'`, `'%s/%s' % ('out', 'x')`): the text it makes (eighth review).
  if (!run.psStrings) {
    const pct = splitTop(e, '%', true)
    if (pct.length === 2) {
      const fmt0 = stringValue(pct[0].trim())
      // cmd's `%s` reading may have taken the conversion as a loop variable: the format is read as written.
      const fmt = fmt0 === null ? null : renderOrig(run, fmt0)
      const rhs = stripParens(pct[1].trim())
      const vals = splitTop(rhs, ',', true).map(x => x.trim()).filter(x => x !== '').map(x => evalAtom(run, x, codeBindings))
      if (fmt !== null && vals.length > 0 && vals.every(v => v !== null)) {
        let k = 0
        const out = fmt.replace(/%[sdr]/g, () => (vals[k++] as string) ?? '\u0004')
        return k === vals.length ? out : null
      }
    }
  }
  // String concatenation over values the scan reads (`d + '/a.txt'`, `process.env.CYNCO_SCRATCH + '/n'`,
  // PowerShell's `[IO.Path]::GetTempPath() + 'work'`).
  {
    const plus = splitTop(e, '+', !run.psStrings)
    if (plus.length > 1) {
      let out = ''
      for (const p of plus) { const v = evalAtom(run, stripParens(p), codeBindings); if (v === null) return null; out += v }
      return out
    }
  }
  return evalAtom(run, e, codeBindings)
}

/** Path parts joined as `os.path.join` and `path.join` join them: an absolute part (or an anchor) starts over. */
function joinParts(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (out === '' || /^(?:[\\/]|[A-Za-z]:|~|\u0002)/.test(p)) { out = p; continue }
    out = `${out.replace(/[\\/]+$/, '')}/${p.replace(/^[\\/]+/, '')}`
  }
  return out
}

function evalAtom(run: Run, a: string, codeBindings: CodeBindings): string | null {
  const s = stringValue(a, run.psStrings)
  if (s !== null) return s
  // A PowerShell cast of a literal (`[IO.DirectoryInfo]'D:\x'`) is the literal.
  const cast = run.psStrings ? a.match(/^\[[\w.]+\]\s*(['"][\s\S]*)$/) : null
  if (cast) return evalAtom(run, cast[1], codeBindings)
  if (new RegExp(`^${S0}\\d+${S1}$`).test(a)) return hasUnreadableSentinel(run, a) ? null : a
  if (run.psStrings) {
    // A literal written inside an outer single-quoted payload (`''C:\x''`).
    if (/^''[\s\S]*''$/.test(a)) { const v = stringValue(a.slice(1, -1).replace(/''/g, "'"), true); if (v !== null) return v }
    if (/^\(?\s*(?:Resolve-Path|Convert-Path)\s+\.\s*\)?$/i.test(a)) return anchorEntry(run, 'cwd', a)
    // `(Get-Item .\out\a.txt).Delete()`, `(Get-Item x).FullName`: the item a literal item source names, as the
    // variable bound to it is read (review 2026-11-24, seventh).
    const src = a.match(/^\(\s*((?:Get-Item|gi|Get-ChildItem|gci|Resolve-Path|rvpa)\s[^()]*)\)(?:\.(?:FullName|PSPath|Path))?$/i)
      ?? a.match(/^((?:Get-Item|gi|Get-ChildItem|gci|Resolve-Path|rvpa)\s[^()]*)$/i)
    if (src) return itemSourceValue(src[1])
    if (/^Join-Path\s/i.test(a)) {
      const parts = splitTop(a.slice(9).trim(), ' ', false).filter(x => x !== '' && !/^-(?:Path|ChildPath)$/i.test(x))
      if (parts.length !== 2) return null
      const x = evalAtom(run, stripParens(parts[0]), codeBindings)
      const y = evalAtom(run, stripParens(parts[1]), codeBindings)
      return x === null || y === null ? null : `${x.replace(/[\\/]+$/, '')}\\${y.replace(/^[\\/]+/, '')}`
    }
    const path = a.match(/^(?:pathlib\.)?(?:Pure)?(?:Windows|Posix)?Path\(\s*(.*?)\s*\)$/s)
    if (path) {
      if (path[1] === '') return '.'
      const inner = splitTop(path[1], ',', false)
      return inner.length === 1 ? evalAtom(run, stripParens(inner[0]), codeBindings) : null
    }
    return null
  }
  // A template literal or an f-string whose holes are loop variables of a list the scan read are read per
  // element (`codeTargets`); any other hole cannot be read.
  const tpl = a.match(/^`([^`]*)`$/s) ?? a.match(/^[fF][rR]?(?:'([^'\\\n]*)'|"([^"\\\n]*)")$/)
  if (tpl) {
    const body = tpl[1] ?? tpl[2] ?? ''
    const hole = a.startsWith('`') ? /\$\{([^}]*)\}/g : /\{([^{}]*)\}/g
    let ok = true
    const v = body.replace(hole, (_m: string, x: string) => { const r = evalAtom(run, x.trim(), codeBindings); if (r === null) ok = false; return r ?? '' })
    return ok ? v : null
  }
  if (a === '__dirname' || a === 'import.meta.dirname') return anchorEntry(run, 'cwd', a)
  // `sys.argv[1]`, `process.argv[1]`: a word written after the inline program (review 2026-11-24, seventh).
  const argv = a.match(/^(?:sys\.argv|process\.argv)\[\s*(\d+)\s*\]$/)
  if (argv) {
    const words = run.codeArgv
    if (words === undefined) return null
    const i = Number(argv[1]) - 1
    return i >= 0 && i < words.length ? words[i] : null
  }
  // A new name for an item of a listing or a glob, in the same folder (`f.replace('.md', '.txt')`,
  // `p.with_suffix('.bak')`): literal arguments with no separator and no `..` (review 2026-11-24, seventh).
  const rename = a.match(/^([A-Za-z_]\w*)\.(replace|with_suffix|with_name|with_stem)\(\s*((?:'[^'\\/]*'|"[^"\\/]*")(?:\s*,\s*(?:'[^'\\/]*'|"[^"\\/]*"))*)\s*\)$/)
  if (rename && !/\.\./.test(rename[3])) {
    const b = codeBindings.get(rename[1])
    const v = b && b.count === 1 ? b.value : null
    if (v !== null && !/^(?:[\\/]|[A-Za-z]:|~)/.test(v) && !v.includes(S0) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v)) return `./${DESC}`
    return null
  }
  // `f[:-4]` (then `+ '.bak'`): a slice of a relative name that holds no `..` at all, so cutting it cannot make one; an
  // item under the working folder (ninth review). What is joined after it is read as written.
  const slice = a.match(/^([A-Za-z_]\w*)\[\s*(?:-?\d+)?\s*:\s*-?\d*\s*\]$/)
  if (slice) {
    const b = codeBindings.get(slice[1])
    const v = b && b.count === 1 ? b.value : null
    if (v !== null && !/^(?:[\\/]|[A-Za-z]:|~)/.test(v) && !v.includes(S0) && !v.includes('..') && !v.includes(UNREAD)) return `./${DESC}`
    return null
  }
  // `f.name` of a temporary file (`NamedTemporaryFile`), whose binding is the temp folder: a name inside it.
  const member = a.match(/^([A-Za-z_]\w*)\.name$/)
  if (member) {
    const b = codeBindings.get(member[1])
    if (b && b.count === 1 && b.value !== null && onlyAnchor(run, b.value, ['temp', 'scratch']) !== null) return `${b.value}/${NAME}`
    return null
  }
  // `'out/{}'.format('cache')`: the text it makes over literal arguments (eighth review).
  const fmt = a.match(/^([rRbBuU]{0,2}(?:'[^'\\\n]*'|"[^"\\\n]*"))\.format\(([\s\S]*)\)$/)
  if (fmt) {
    const f = stringValue(fmt[1])
    const vals = splitTop(fmt[2], ',', true).map(x => x.trim()).filter(x => x !== '').map(x => evalAtom(run, x, codeBindings))
    if (f === null || vals.some(v => v === null)) return null
    let k = 0
    let ok = true
    const out = f.replace(/\{(\d*)\}/g, (_m: string, n: string) => { const v = vals[n === '' ? k++ : Number(n)]; if (v === undefined || v === null) ok = false; return v ?? '' })
    return ok ? out : null
  }
  // The folder a path is in (`p.parent`, `Path.cwd().parent`), and a new leaf in it (`p.with_name('x')`), read
  // lexically: a climb written after the path (review 2026-11-24, eighth, C1: a write through `p.parent` of a literal was
  // unread, and the climb counter refused it with a false reason).
  const parent = a.match(/^([\s\S]+)\.parent$/)
  if (parent) {
    const v = evalAtom(run, parent[1], codeBindings)
    return v === null ? null : `${v.replace(/[\\/]+$/, '')}/..`
  }
  const leaf = a.match(/^([\s\S]+)\.(with_name|with_suffix|with_stem)\(\s*('[^'\\/]*'|"[^"\\/]*")\s*\)$/)
  if (leaf && !/\.\./.test(leaf[3])) {
    const v = evalAtom(run, leaf[1], codeBindings)
    return v === null ? null : `${v.replace(/[\\/]+$/, '')}/../${NAME}`
  }
  // A method that returns the same path (`Path('x').resolve()`, `.absolute()`).
  const same = a.match(/^([\s\S]+)\.(?:resolve|absolute|expanduser)\(\s*\)$/)
  if (same && !/^[A-Za-z_$][\w$]*$/.test(same[1])) return evalAtom(run, same[1], codeBindings)
  const call = evalCall(run, a, codeBindings)
  if (call !== undefined) return call
  if (/^[A-Za-z_]\w*$/.test(a)) {
    const b = codeBindings.get(a)
    if (b && b.count === 1) return b.value
  }
  return null
}

/**
 * A call the scan evaluates over arguments it reads (review 2026-11-24, sixth): the path joins (`os.path.join`,
 * `path.join`, `path.resolve`, `pathlib.Path(a, b)`), the calls that return their argument as a path (`str`,
 * `os.fspath`, `os.path.abspath`, `normpath`, `path.normalize`), and a new folder made under a prefix
 * (`fs.mkdtempSync(prefix)`: the prefix and a name it makes). undefined: not one of these calls.
 */
function evalCall(run: Run, a: string, cb: CodeBindings): string | null | undefined {
  if (!a.endsWith(')')) return undefined
  let open = -1
  for (let k = 0; k < a.length && open < 0; k++) if (a[k] === '(' && matchParen(a, k) === a.length - 1) open = k
  if (open <= 0) return undefined
  const callee = a.slice(0, open).trim().replace(/^require\(\s*['"](?:node:)?path['"]\s*\)/, 'path')
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callee)) return undefined
  const args = callArgs(a, open).args.filter(x => !/^[A-Za-z_]\w*\s*=(?!=)/.test(x))
  const all = (): string[] | null => { const out: string[] = []; for (const x of args) { const v = evalExpr(run, x, cb); if (v === null) return null; out.push(v) } return out }
  const dot = callee.lastIndexOf('.')
  const mod = dot > 0 ? callee.slice(0, dot) : ''
  const fn = dot > 0 ? callee.slice(dot + 1) : callee
  const { mods, fns } = run.pathMods ?? { mods: new Set(PATH_MODULES_DEFAULT), fns: new Set<string>() }
  if (/^(?:pathlib\.)?(?:Pure)?(?:Windows|Posix)?Path$/.test(callee) || /^Bun\.file$/.test(callee)) {
    if (args.length === 0) return '.'
    const v = all()
    return v === null ? null : joinParts(v)
  }
  if (((fn === 'join' || fn === 'resolve') && mods.has(mod)) || (mod === '' && fns.has(fn))) {
    const v = all()
    return v === null || v.length === 0 ? null : joinParts(v)
  }
  // `os.path.dirname(p)`, `path.dirname(f)`: the folder the path is in, as a climb written after it (eighth review, C1).
  if (fn === 'dirname' && (mods.has(mod) || mod === 'os.path')) {
    const v = args.length === 1 ? evalExpr(run, args[0], cb) : null
    return v === null ? null : `${v.replace(/[\\/]+$/, '')}/..`
  }
  if (/^(?:str|String|os\.fspath|os\.path\.(?:abspath|normpath|realpath))$/.test(callee) || (fn === 'normalize' && mods.has(mod))) {
    return args.length === 1 ? evalExpr(run, args[0], cb) : null
  }
  if (/^(?:fs\.(?:promises\.)?)?mkdtemp(?:Sync)?$/.test(callee)) {
    const v = args.length >= 1 ? evalExpr(run, args[0], cb) : null
    return v === null ? null : `${v}${NAME}`
  }
  return undefined
}

/**
 * The values a code target takes (review 2026-11-24, sixth): once per element of the one loop variable it
 * names (`for d in ['build', 'dist']: shutil.rmtree(d)`), or the one value; null when any cannot be read.
 */
function codeTargets(run: Run, expr: string, cb: CodeBindings): string[] | null {
  // A shell variable bound to a list (`foreach ($d in 'a','b') { [IO.Directory]::Delete($d, $true) }`).
  const sh = expr.trim().match(new RegExp(`^${S0}(\\d+)${S1}$`))
  const se = sh ? run.table[Number(sh[1])] : null
  if (se?.k === 'bound' && se.b.list && se.b.value === null && !se.b.item) return se.b.list
  const names = [...new Set([...expr.matchAll(/(?<![\w.$'"])([A-Za-z_$][\w$]*)(?![\w$'"])/g)].map(m => m[1]).filter(n => cb.get(n)?.list))].slice(0, 3)
  if (names.length === 0) { const v = evalExpr(run, expr, cb); return v === null ? null : [v] }
  let combos: Array<Array<[string, string]>> = [[]]
  for (const n of names) combos = combos.flatMap(c => (cb.get(n)?.list ?? []).map(el => [...c, [n, el] as [string, string]])).slice(0, MAX_LOOP_ELEMENTS)
  const out: string[] = []
  for (const c of combos) {
    const one: CodeBindings = new Map(cb)
    for (const [n, el] of c) one.set(n, { value: el, count: 1 })
    const v = evalExpr(run, expr, one)
    if (v === null) return null
    out.push(v)
  }
  return out.length ? out : null
}

const CODE_ASSIGN = /(^|[\s;{(\n])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*([-+*/|]?)=(?![=>])/g

/** Where a comprehension's or a loop's iterable ends: a top-level `:`, ` if `, or the bracket that closes it. */
function iterableEnd(code: string, from: number): number {
  let depth = 0
  for (let k = from; k < code.length; k++) {
    const c = code[k]
    if (c === "'" || c === '"' || c === '`') { k = closingQuote(code, k); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return k; depth-- }
    // A comprehension's next `for` ends it too (`for r, _, fs in os.walk('out') for f in fs`, review 2026-11-24, seventh).
    else if (depth === 0 && (c === ':' || c === '\n' || c === ';' || code.startsWith(' if ', k) || code.startsWith(' for ', k))) return k
  }
  return code.length
}

/**
 * The elements an iterable of an inline program yields, in substituted form, or null: a list or tuple of
 * values the scan reads, a glob (`glob.glob('out/*.tmp')`, `Path('out').glob('*.pyc')`, `rglob`), a listing of
 * a folder (`os.listdir('out')`, `fs.readdirSync('src')`: names, joined to it where they are used), a name
 * bound to one of these (review 2026-11-24, sixth).
 */
function iterElements(run: Run, it0: string, cb: CodeBindings): string[] | null {
  const raw = it0.trim()
  const it = /^\([\s\S]*,[\s\S]*\)$/.test(raw) && matchParen(raw, 0) === raw.length - 1 ? raw : stripParens(raw)
  const lit = it.match(/^[[(]([\s\S]*)[\])]$/)
  if (lit && (it[0] === '[' ? splitTop(it, '\u0000').length === 1 && splitTop(it.slice(1, -1), ']').length === 1 : matchParen(it, 0) === it.length - 1)) {
    const elems = splitTop(lit[1], ',').filter(x => x !== '')
    if (elems.length === 0 || elems.length > MAX_LOOP_ELEMENTS) return null
    const out: string[] = []
    for (const x of elems) { const v = evalExpr(run, x, cb); if (v === null) return null; out.push(v) }
    return out
  }
  const glob = it.match(/^(?:glob\.)?i?glob\(\s*([\s\S]*?)\s*(?:,[^()]*)?\)$/)
  if (glob) { const v = evalExpr(run, glob[1], cb); return v === null ? null : [v] }
  const pglob = it.match(/^([\s\S]+)\.(r?glob)\(\s*([\s\S]*?)\s*\)$/)
  if (pglob) {
    const base = evalExpr(run, pglob[1], cb)
    const pat = evalExpr(run, pglob[3], cb)
    return base === null || pat === null ? null : [joinParts([base, pglob[2] === 'rglob' ? `**/${pat}` : pat])]
  }
  // `Path('out').iterdir()`: the items inside the folder (review 2026-11-24, seventh).
  const iter = it.match(/^([\s\S]+)\.iterdir\(\s*\)$/)
  if (iter) { const base = evalExpr(run, iter[1], cb); return base === null ? null : [joinParts([base, NAME])] }
  // A listing filtered or sorted keeps its items (`fs.readdirSync('logs').filter(f => ...)`).
  const kept = it.match(/^([\s\S]+?)\.(?:filter|sort)\(/)
  if (kept && matchParen(it, kept[0].length - 1) === it.length - 1 && /^(?:os\.listdir|os\.scandir|fs\.readdirSync|readdirSync|fs\.promises\.readdir|require\(\s*['"](?:node:)?fs['"]\s*\)\.readdirSync)\(/.test(kept[1])) return iterElements(run, kept[1], cb)
  const ls = it.match(/^(?:os\.listdir|os\.scandir|fs\.readdirSync|readdirSync|fs\.promises\.readdir|require\(\s*['"](?:node:)?fs['"]\s*\)\.readdirSync)\(\s*([\s\S]*?)\s*(?:,[^()]*)?\)$/)
  if (ls) { const v = ls[1] === '' ? '.' : evalExpr(run, ls[1], cb); return v === null ? null : [`./${NAME}`] }
  if (/^[A-Za-z_$][\w$]*$/.test(it)) return cb.get(it)?.list ?? null
  return null
}

function findCodeAssignments(run: Run, code: string): CodeBindings {
  const out: CodeBindings = new Map()
  const bind = (name: string, value: string | null, list?: string[]) => {
    const prev = out.get(name)
    // A name assigned more than once (the same local name in several functions) is every value it held, each judged;
    // one value the scan cannot read leaves it unread (ninth review: every program of two such functions was
    // escalated where one function alone was read).
    const was = prev ? (prev.list ?? (prev.value !== null ? [prev.value] : null)) : null
    const now = list ?? (value !== null ? [value] : null)
    const union = prev && was !== null && now !== null && was.length + now.length <= MAX_LOOP_ELEMENTS ? [...new Set([...was, ...now])] : undefined
    out.set(name, { value: prev ? null : value, count: (prev?.count ?? 0) + 1, ...(list && !prev ? { list } : union ? { list: union } : {}) })
  }
  type Found = { at: number; run: () => void }
  const found: Found[] = []
  for (const m of code.matchAll(CODE_ASSIGN)) {
    const name = m[2]
    // The second name of a tuple (`fd, p = ...`) is bound below, and a keyword argument (`f(a, b=1)`) binds nothing.
    if (/,\s*$/.test(code.slice(Math.max(0, (m.index ?? 0) - 64), (m.index ?? 0) + m[1].length))) continue
    const start = (m.index ?? 0) + m[0].length
    const end = statementEnd(code, start, false)
    found.push({ at: m.index ?? 0, run: () => bind(name, m[3] ? null : evalExpr(run, code.slice(start, end).trim(), out)) })
  }
  // `with tempfile.TemporaryDirectory() as d:`: the value of the expression.
  for (const m of code.matchAll(/\bwith\s+([^\n:]+?)\s+as\s+([A-Za-z_]\w*)\s*:/g)) {
    found.push({ at: m.index ?? 0, run: () => bind(m[2], evalExpr(run, m[1], out)) })
  }
  // `fd, p = tempfile.mkstemp()`: the second name is a new file in the temp folder; any other tuple is not read
  // (review 2026-11-24, seventh).
  for (const m of code.matchAll(/(^|[;\n])[ \t]*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*=(?!=)/g)) {
    const start = (m.index ?? 0) + m[0].length
    const rhs = code.slice(start, statementEnd(code, start, false)).trim()
    found.push({ at: m.index ?? 0, run: () => {
      const v = evalExpr(run, rhs, out)
      const temp = v !== null && onlyAnchor(run, v, ['temp']) !== null
      bind(m[2], null)
      bind(m[3], temp ? `${v}/${NAME}` : null)
    } })
  }
  // Python `for x in IT` (a statement or a comprehension), `for r, ds, fs in os.walk('d')`; JavaScript
  // `for (const x of IT)` and `IT.forEach(x => ...)`.
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+/g)) {
    const from = (m.index ?? 0) + m[0].length
    const it = code.slice(from, iterableEnd(code, from)).trim()
    const names = m[1].split(',').map(x => x.trim())
    found.push({ at: m.index ?? 0, run: () => {
      const walk = it.match(/^os\.walk\(\s*([\s\S]*?)\s*(?:,[^()]*)?\)$/)
      if (walk && names.length === 3) {
        const root = evalExpr(run, walk[1], out)
        bind(names[0], null, root === null ? undefined : [`${root.replace(/[\\/]+$/, '')}/${DESC}`])
        bind(names[1], null, root === null ? undefined : [`./${NAME}`])
        bind(names[2], null, root === null ? undefined : [`./${NAME}`])
        return
      }
      const list = names.length === 1 ? iterElements(run, it, out) : null
      for (const n of names) bind(n, null, list ?? undefined)
    } })
  }
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g)) {
    const from = (m.index ?? 0) + m[0].length
    const it = code.slice(from, iterableEnd(code, from)).trim()
    found.push({ at: m.index ?? 0, run: () => { const list = iterElements(run, it, out); bind(m[1], null, list ?? undefined) } })
  }
  for (const m of code.matchAll(/\.forEach\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) {
    const dot = m.index ?? 0
    const recv = receiverOf(code, dot)
    found.push({ at: dot, run: () => { const list = iterElements(run, recv, out); bind(m[1], null, list ?? undefined) } })
  }
  found.sort((x, y) => x.at - y.at)
  for (const f of found) f.run()
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
  const quoted = ctx.quoted ?? []
  for (const k of [...calls.keys()]) if (quoted.some(([a, b]) => k > a && k < b)) calls.delete(k)
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
    // `[IO.Directory]::Delete($_, $true)`, `$_.Delete()` in a pipeline's block: the items fed to the block
    // (review 2026-11-24, sixth).
    const item = !CODE_CALLS.includes(call) ? expr.trim().match(new RegExp(`^${S0}(\\d+)${S1}(?:\\.(?:FullName|PSPath|Path))?$`, 'i')) : null
    if (item && run.table[Number(item[1])]?.k === 'p') {
      const seg = ctx.segs.filter(x => x.start <= at && at < x.end && x.words.length > 0).sort((x, y) => y.start - x.start)[0]
      if (seg) {
        const w: Word = { ...literalWord(sentinel(run, { k: 'p', orig: '$_' })), raw: renderOrig(run, expr) }
        if (isMut(op)) { mutate(ctx, seg, [w], op, verb, recursive); return 'ok' }
        return emitWord(ctx, seg, w, op, { relAllowed: true, verb }) === 'unreadable' ? 'unreadable' : 'ok'
      }
    }
    const vs = codeTargets(run, expr, cb)
    if (vs === null) return 'unreadable'
    let all: 'ok' | 'unreadable' = 'ok'
    for (const v of vs) {
      const r = emitWord(ctx, null, { ...literalWord(v), raw: renderOrig(run, expr) }, op, { relAllowed: true, verb, recursive })
      if (r !== 'ok') all = 'unreadable'
    }
    return all
  }
  const mut = (expr: string | undefined, op: MutOp) => {
    run.out.sawWrite = true
    if (target(expr, op) !== 'ok') unresolved(run, op, verb, recursive, code, CODE_CALLS.includes(call))
  }
  const useReceiver = call.style === 'receiver' || (call.style === 'receiver-or-args'
    && (positional.length === 0 || ((call.kind === 'move' || call.kind === 'copy') && positional.length === 1)))
  const recv = useReceiver ? receiverOf(code, at) : undefined
  switch (call.kind) {
    case 'delete': return mut(useReceiver ? recv : positional[0], 'delete')
    case 'write': {
      // `extractall(path='..')`, `extractall()` (the working folder).
      const kw = args.find(a => /^path\s*=(?!=)/.test(a))?.replace(/^path\s*=\s*/, '')
      if (!useReceiver && positional[0] === undefined && /extractall$/.test(verb)) return mut(kw ?? "'.'", 'write')
      return mut(useReceiver ? recv : positional[0], 'write')
    }
    case 'move': {
      // A destination that cannot be read makes the move one whose target cannot be read (policy item 3 of the
      // sixth review: a delete or a move through an unread target stays refused).
      const dest = (expr: string | undefined) => { run.out.sawWrite = true; if (target(expr, 'write') !== 'ok') unresolved(run, 'move', verb, recursive, code, CODE_CALLS.includes(call)) }
      if (useReceiver) { mut(recv, 'move'); return dest(positional[0]) }
      mut(positional[0], 'move'); return dest(positional[1])
    }
    case 'copy':
      if (useReceiver) { if (recv !== undefined) target(recv, 'read'); return mut(positional[0], 'write') }
      if (positional[0] !== undefined) target(positional[0], 'read')
      return mut(positional[1], 'write')
    case 'shell': return shellCall(ctx, args, positional, verb, cb)
    case 'link': {
      run.out.sawWrite = true
      // os.symlink / os.link / fs.symlink / fs.link take (target, link); CreateJunction takes (link, target).
      const [tExpr, lExpr] = /CreateJunction$/.test(verb) ? [positional[1], positional[0]] : [positional[0], positional[1]]
      const lv = lExpr !== undefined ? evalExpr(run, lExpr, cb) : null
      // A symbolic link's relative target is read from the link's own folder, as the shell's `ln -s` is (review
      // 2026-11-24, eighth); a hard link's is a path from the working folder.
      const lp = lv !== null && /symlink/i.test(verb) ? toPath(run, expand(run, lv, ctx.base, true).text, true, ctx.base, false) : null
      const linkBase = lp && lp !== 'unreadable' && !lp.children ? (run.platform === 'win32' ? nodePath.win32 : nodePath.posix).dirname(lp.path) : ctx.base
      const tv = tExpr !== undefined ? evalExpr(run, tExpr, cb) : null
      const tp = tv !== null ? toPath(run, expand(run, tv, linkBase, true).text, true, linkBase, false) : null
      const linkTarget = tp && tp !== 'unreadable' ? tp.path : null
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
      // Perl: `open(F, '>x')`, `open(F, '>', 'x')`.
      const perl = positional.length >= 2 ? stringValue(stripParens(positional[1])) : null
      const pm = perl !== null ? perl.match(/^\s*(\+?(?:>>?|<))\s*([\s\S]*)$/) : null
      if (pm && /^[A-Za-z_]\w*$/.test(positional[0].trim())) {
        if (!pm[1].includes('>') && !pm[1].includes('+')) return
        if (pm[2] !== '') return mut(JSON.stringify(pm[2]), 'write')
        return mut(positional[2], 'write')
      }
      const modeArg = positional[1] ?? args.find(a => /^(?:mode|flags?)\s*[=:]/.test(a))?.replace(/^(?:mode|flags?)\s*[=:]\s*/, '')
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
      if (v !== null && /Diagnostics\.Process\]::Start$/i.test(verb) && positional.length > 1) {
        // .NET's `Process::Start(program, arguments)`: the second argument is the raw command line the program gets
        // (cmd's `/c rd ...`, powershell's `-Command ...`), never one quoted argument; read through the bindings. One
        // the scan cannot read is a command line it cannot read, never dropped (ninth review).
        let a = positional.length === 2 ? evalExpr(run, positional[1], cb) : null
        // A name bound to one literal is its text, split by the program as the rest of the line is; anything else
        // bound (a list, a value the scan did not read) leaves the command line unread.
        if (a !== null) {
          a = a.replace(new RegExp(`${S0}(\\d+)${S1}`, 'g'), (m, n: string) => {
            const e = run.table[Number(n)]
            if (e?.k === 'u' && !e.unset) return UNREAD
            if (e?.k !== 'bound') return m
            if (e.b.unset) return ''
            return e.b.value !== null && e.b.list === undefined && e.b.hash === undefined && !e.b.value.includes(S0) ? e.b.value : UNREAD
          })
          if (a.includes(UNREAD)) a = null
        }
        if (a === null) { markSelfBuilding(run, `${verb} with arguments that cannot be read`); return }
        text = a.trim() === '' ? v : `${/\s/.test(v) ? `"${v}"` : v} ${a}`
      } else if (v !== null) {
        // The program and its argument list, or its arguments one by one (`spawnSync('cmd', ['/c', ...])`).
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
  // A drive-relative literal (`'D:DCIM'`, which a new process reads as `D:\DCIM`) on a drive the run has no
  // folder on is a path; on the run's own drive `a:b` stays text (review 2026-11-23, fourth).
  const rel = t.match(/^([A-Za-z]):[^\\/\s:'"]/)
  if (rel && run.platform === 'win32') {
    const d = rel[1].toUpperCase()
    const own = run.drives ?? [winDrive(run)?.slice(0, 1) ?? '']
    if (!own.includes(d)) return true
  }
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

/**
 * git's own commands, as `git --list-cmds=main,nohelpers` lists them on git 2.53 (measured 2026-11-24). Any other
 * word in the command's place is an alias (git never lets an alias shadow one of these) or a program
 * `git-<word>` on the PATH; either may take the options that run a program (wave 15c). Shared with the Git tool.
 */
export const GIT_MAIN_COMMANDS: ReadonlySet<string> = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle '
  + 'cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone '
  + 'column commit commit-graph commit-tree config count-objects credential credential-cache credential-store credential-wincred '
  + 'daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack '
  + 'filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep gui gui.tcl '
  + 'hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers '
  + 'last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index '
  + 'merge-octopus merge-one-file merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve '
  + 'merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs '
  + 'patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote '
  + 'remote-ext remote-fd remote-ftp remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset '
  + 'restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout '
  + 'stage stash status stripspace submodule subtree survey svn switch symbolic-ref tag unpack-file unpack-objects update '
  + 'update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version '
  + 'whatchanged worktree write-tree').split(' '))

/** `short` written exactly, or `--` and any prefix of one of `names` (git takes a unique prefix of a long option). */
function longPrefixes(short: string[], ...names: string[]): RegExp {
  const alts = new Set<string>(short)
  for (const n of names) for (let k = 1; k <= n.length; k++) alts.add(`--${n.slice(0, k)}`)
  return new RegExp(`^(?:${[...alts].join('|')})$`)
}

/**
 * At most this many words come out of the brace lists of one word (bash makes every combination). A word whose
 * lists make more is never cut short (wave 15c, N1: the 65th word, the one bash deleted, was dropped): the call is
 * unreadable (`BRACE_OVERFLOW`).
 */
const MAX_BRACE_WORDS = 256
const BRACE_OVERFLOW = `a brace list that makes more than ${MAX_BRACE_WORDS} words`
/**
 * At most this many words come out of the brace lists of one text, and at most `MAX_SCANNED_TEXT` characters (wave
 * 19, C5): each word was capped, the text was not, and the expansion ran before the scan's budget was ever checked
 * (measured on the wave-15c build: 120 KiB of eight-list words, each making 256, held the event loop 360 ms, and one
 * eight-list word with a 120 KiB tail 101 ms, before the result was refused as too long). Past either cap the call is
 * unreadable; the budget is also checked between words.
 */
const MAX_BRACE_TEXT_WORDS = 4096
const BRACE_TEXT_OVERFLOW = `brace lists that make more than ${MAX_BRACE_TEXT_WORDS} words, or more than 128 KiB of text, across the command`

/**
 * A POSIX text as the shell splits it into fields where the text alone says how (wave 15b, P3-F10): `$IFS` and
 * `${IFS}` outside single quotes are a space when the text assigns no IFS (its default splits at a space, a tab
 * and a newline), and an unquoted brace list with a comma (`{rm,-rf,~/.ssh}`, `x{a,b}y`) is the words it expands
 * to. Neither was read: `rm${IFS}-rf${IFS}$HOME/.ssh` and `{rm,-rf,~/.ssh}` were one program word the tables did
 * not know, and both are what reaches bash from Windows PowerShell 5.1 when a payload's plain quotes are split.
 * Null when the text has neither; `overflow` names the fault when a word's lists make more than `MAX_BRACE_WORDS`
 * words, the text's lists more than `MAX_BRACE_TEXT_WORDS` words or the text more than `MAX_SCANNED_TEXT`
 * characters (the expansion stops there), or the scan ran past its budget.
 */
function posixFields(run: Run, text: string): { text: string; overflow: string | null } | null {
  const ifs = !/\bIFS\s*=/.test(text) && /\$\{?IFS\b/.test(text)
  // Any `{` with a `,` and then a `}` after it: the words themselves are judged by `braceList`, which keeps quoted
  // and escaped text whole (wave 15c, N2: a trigger that refused whitespace and braces between the braces missed
  // `{"a b",~/.ssh}`, `{a\ b,...}` and `{x{y},...}`). Linear: three index lookups.
  const open = text.indexOf('{')
  const comma = open < 0 ? -1 : text.indexOf(',', open)
  const braces = comma >= 0 && text.lastIndexOf('}') > comma
  if (!ifs && !braces) return null
  // The words of the text with their spans, by its quoting: a word ends at unquoted whitespace or an operator.
  let out = ''
  let word = ''
  let quote: '' | "'" | '"' = ''
  let overflow: string | null = null
  let made = 0
  const flush = () => {
    if (!braces || overflow !== null) out += word
    else if (overBudget(run)) { overflow = `the command took longer than ${SCAN_BUDGET_MS} ms to read`; out += word }
    else {
      const e = expandBraces(word, MAX_SCANNED_TEXT - out.length)
      if (e === 'words') { overflow = BRACE_OVERFLOW; out += word }
      else if (e === 'chars' || (e.length > 1 && (made += e.length) > MAX_BRACE_TEXT_WORDS)) { overflow = BRACE_TEXT_OVERFLOW; out += word }
      else out += e.join(' ')
    }
    word = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") { word += c; if (c === "'") quote = ''; continue }
    if (c === '\\' && i + 1 < text.length) { word += text.slice(i, i + 2); i++; continue }
    if (c === "'" && quote === '') { quote = "'"; word += c; continue }
    if (c === '"') { quote = quote === '"' ? '' : '"'; word += c; continue }
    if (ifs && c === '$') {
      const m = text.slice(i).match(/^\$(?:\{IFS\}|IFS(?![A-Za-z0-9_]))/)
      if (m) {
        if (quote === '"') word += ' '
        else { flush(); out += ' ' }
        i += m[0].length - 1
        continue
      }
    }
    if (quote === '' && /[\s;|&()<>]/.test(c)) { flush(); out += c; continue }
    word += c
  }
  flush()
  return out === text && overflow === null ? null : { text: out, overflow }
}

/**
 * A POSIX text with each unquoted ANSI-C string (`$'...'`) written as the single-quoted text it decodes to, as bash
 * reads it (wave 15c, the wave-15b builder's leftover: `x=$'\x20'; rm${x}-rf${x}$HOME/.ssh` and `rm -rf
 * $'\x2e\x2e'/.ssh` were read as text nobody knew). Escapes: `\a \b \e \E \f \n \r \t \v \\ \' \" \?`, octal
 * `\nnn`, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and `\cX`; an unknown escape is kept as written, a NUL ends the string
 * (bash drops the rest) and the scan's own sentinel characters (`\x01` to `\x08` and `\x0e`) become `?` (wave
 * 19, C6: `\x0e`, ITEM_DIR, came through and was read as the pipeline item's folder). An unquoted locale string
 * (`$"..."`) is written as the double-quoted string it is when there is no message catalog (wave 19, C3: `rm -rf
 * $"../.ssh"` was read as a name `$..` inside the folder). Null when the text holds neither.
 */
function ansiCDecoded(text: string): string | null {
  if (!text.includes("$'") && !text.includes('$"')) return null
  let out = ''
  let quote: '' | "'" | '"' = ''
  let found = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") { out += c; if (c === "'") quote = ''; continue }
    if (c === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i++; continue }
    // `$"`: the `$` goes, and the double-quoted string is read as one.
    if (quote === '' && c === '$' && text[i + 1] === '"') { found = true; continue }
    if (c === '"') { quote = quote === '"' ? '' : '"'; out += c; continue }
    if (quote === '' && c === "'") { quote = "'"; out += c; continue }
    if (quote !== '' || c !== '$' || text[i + 1] !== "'") { out += c; continue }
    // `$'`: decode up to the first quote no backslash escapes.
    let s = ''
    let j = i + 2
    let ended = false
    for (; j < text.length && text[j] !== "'"; j++) {
      if (text[j] !== '\\' || j + 1 >= text.length) { if (!ended) s += text[j]; continue }
      const e = text[j + 1]
      const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
      let ch: string
      let used = 2
      const hex = (max: number) => { const m = text.slice(j + 2, j + 2 + max).match(/^[0-9A-Fa-f]+/); return m ? m[0] : '' }
      if (e in simple) ch = simple[e]
      else if (/[0-7]/.test(e)) { const m = text.slice(j + 1, j + 4).match(/^[0-7]{1,3}/) as RegExpMatchArray; ch = String.fromCharCode(parseInt(m[0], 8) & 0xff); used = 1 + m[0].length }
      else if (e === 'x' && hex(2) !== '') { const h = hex(2); ch = String.fromCharCode(parseInt(h, 16)); used = 2 + h.length }
      else if ((e === 'u' || e === 'U') && hex(e === 'u' ? 4 : 8) !== '') { const h = hex(e === 'u' ? 4 : 8); const n = parseInt(h, 16); ch = n <= 0x10ffff ? String.fromCodePoint(n) : '?'; used = 2 + h.length }
      else if (e === 'c' && j + 2 < text.length) { ch = String.fromCharCode(text.charCodeAt(j + 2) & 0x1f); used = 3 }
      else ch = `\\${e}`
      if (ch === '\0') ended = true
      if (!ended) s += ch
      j += used - 1
    }
    found = true
    out += `'${s.replace(SENTINEL_CHARS_G, '?').replace(/'/g, "'\\''")}'`
    i = j
  }
  return found ? out : null
}

/**
 * One word with its unquoted brace lists expanded (`x{a,b}y` is `xay xby`), as bash expands them, in bash's order;
 * `'words'` when they make more than `MAX_BRACE_WORDS` words (never a list cut short: wave 15c, N1), `'chars'` when
 * the words would hold more than `maxChars` characters with a space between each two (wave 19, C5: counted before
 * a step's words are made, so a long word is never copied 256 times first). Each step replaces one word by two or
 * more, so the loop ends within `MAX_BRACE_WORDS` steps; the words before the first one that still holds a list hold
 * none, so the search goes on from there.
 */
function expandBraces(word: string, maxChars: number): string[] | 'words' | 'chars' {
  const words = [word]
  let chars = word.length
  let from = 0
  for (;;) {
    let k = -1
    let b: { open: number; close: number; alts: string[] } | null = null
    for (let j = from; j < words.length; j++) { b = braceList(words[j]); if (b !== null) { k = j; break } }
    if (k < 0 || b === null) return words
    if (words.length - 1 + b.alts.length > MAX_BRACE_WORDS) return 'words'
    const w = words[k]
    const bl = b
    const kept = w.length - (bl.close + 1 - bl.open)
    chars += bl.alts.reduce((n, a) => n + kept + a.length + 1, 0) - (w.length + 1)
    if (chars > maxChars) return 'chars'
    words.splice(k, 1, ...bl.alts.map(a => w.slice(0, bl.open) + a + w.slice(bl.close + 1)))
    from = k
  }
}

/** The first unquoted `{a,b}` of a word that is not a `${...}`: where it opens and closes, and its alternatives. */
function braceList(w: string): { open: number; close: number; alts: string[] } | null {
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < w.length; i++) {
    const c = w[i]
    if (quote === "'") { if (c === "'") quote = ''; continue }
    if (c === '\\') { i++; continue }
    if (c === "'" && quote === '') { quote = "'"; continue }
    if (c === '"') { quote = quote === '"' ? '' : '"'; continue }
    if (quote !== '' || c !== '{' || w[i - 1] === '$') continue
    // The matching close at depth zero, and the commas at depth one, outside quotes.
    let depth = 0
    let q2: '' | "'" | '"' = ''
    const commas: number[] = []
    for (let j = i; j < w.length; j++) {
      const d = w[j]
      if (q2 === "'") { if (d === "'") q2 = ''; continue }
      if (d === '\\') { j++; continue }
      if (d === "'" && q2 === '') { q2 = "'"; continue }
      if (d === '"') { q2 = q2 === '"' ? '' : '"'; continue }
      if (q2 !== '') continue
      if (d === '{') depth++
      else if (d === '}' && --depth === 0) {
        if (commas.length === 0) break
        const cuts = [i, ...commas, j]
        return { open: i, close: j, alts: cuts.slice(0, -1).map((a, n) => w.slice(a + 1, cuts[n + 1])) }
      } else if (d === ',' && depth === 1) commas.push(j)
    }
  }
  return null
}

/**
 * PowerShell 5.1 reads more than ASCII: the Unicode space separators, VT, FF and NEL are whitespace to it, a
 * lone CR ends a statement, and the curly quotes are quotes (measured; review 2026-11-23, fourth: each made
 * the check read one harmless word where PowerShell ran a delete). Mapped to their ASCII forms before a
 * PowerShell text is read. The sentinels (U+0002 to U+0006) are untouched.
 */
const PS_SPACES = /[\u000b\u000c\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g
const PS_SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b]/g
const PS_DOUBLE_QUOTES = /[\u201c\u201d\u201e]/g
const PS_ODD_CHARS = /[\u000b\u000c\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u2013-\u201e\r]/
function psNormalize(text: string): string {
  if (!PS_ODD_CHARS.test(text)) return text
  return text
    .replace(/\r(?!\n)/g, '\n')
    .replace(PS_SPACES, ' ')
    .replace(PS_SINGLE_QUOTES, "'")
    .replace(PS_DOUBLE_QUOTES, '"')
    // The en dash, the em dash and the horizontal bar start a parameter as `-` does (review 2026-11-24, sixth).
    .replace(/(^|[\s(;|&{,])[\u2013\u2014\u2015]/g, '$1-')
}

/** The `$( ... )` (and, in a here-document, the backticks) a shell runs inside a body it expands. */
function bodySubexpressions(body: string, doc: boolean): string[] {
  const out: string[] = []
  for (let i = body.indexOf('$('); i >= 0 && out.length < MAX_PATHS; i = body.indexOf('$(', i + 1)) {
    const k = matchParen(body, i + 1)
    out.push(body.slice(i + 2, k))
    i = k
  }
  if (doc) for (const m of body.matchAll(/`([^`]+)`/g)) out.push(m[1])
  return out
}

function scanShell(run: Run, text0: string, base: string, via: string, depth: number, o: PayloadOpts & { codeAsShell: boolean }): void {
  try {
    const dialect: Dialect = o.dialect ?? (run.platform === 'win32' ? 'ps' : 'posix')
    const text = dialect === 'cmd' ? stripCarets(text0) : dialect === 'ps' ? psNormalize(text0) : text0
    const firstBody = run.bodies.length
    const lifted = liftBodies(run, text, dialect)
    // Measured on the text as written (a substituted name is a longer sentinel).
    const plain = renderOrig(run, lifted, true)
    if (plain.length > MAX_SCANNED_TEXT) { run.out.faults.push(TOO_LONG); return }
    // The text as the shell splits it at `$IFS` and expands its brace lists, read beside the text as written
    // (wave 15b, P3-F10); here-document bodies are set aside first, so their text is not split.
    // The text with its `$'...'` strings decoded, read beside the text as written (wave 15c); that reading is
    // split and expanded in its turn.
    if (dialect === 'posix' && !o.codeAsShell && o.ansiC !== true && o.fielded !== true) {
      const decoded = ansiCDecoded(lifted)
      if (decoded !== null) scanShell(run, renderOrig(run, decoded), base, via, depth, { ...o, ansiC: true })
    }
    if (dialect === 'posix' && !o.codeAsShell && o.fielded !== true) {
      const fielded = posixFields(run, lifted)
      // An overflow refuses the whole call, so the text is not read on (wave 19, C5: reading the 120 KiB as written
      // after the cap cost 100 ms more).
      if (fielded !== null && fielded.overflow !== null) { if (!run.out.faults.includes(fielded.overflow)) run.out.faults.push(fielded.overflow); return }
      else if (fielded !== null) scanShell(run, renderOrig(run, fielded.text), base, via, depth, { ...o, fielded: true })
    }
    markSelfBuilding(run, findMarker(plain))
    if (dialect === 'posix' && POSIX_MARKER.test(plain)) markSelfBuilding(run, 'a shell handed a command line through a here-string or a process substitution')
    if (dialect === 'ps' && PROCESS_OBJECT.test(plain)) processObject(run, plain, base, via, depth, o)
    // A body the shell expands (`@"..."@`, an unquoted here-document) runs the subexpressions written in it,
    // whatever is done with the body afterwards (review 2026-11-23, fourth).
    if (!o.codeAsShell) {
      for (let b = firstBody; b < run.bodies.length; b++) {
        const body = run.bodies[b]
        if (!body.expands) continue
        for (const s of bodySubexpressions(body.text, body.q === 'doc')) {
          run.out.texts.push(s)
          scanPayload(run, s, base, `${via}>here`, depth + 1, 'shell', { dialect: body.q === 'doc' ? 'posix' : dialect, baseUnreadable: o.baseUnreadable })
        }
      }
    }
    const wasPs = run.psText
    run.psText = dialect === 'ps'
    let bindings: Bindings
    let sub: string
    try {
      bindings = findShellAssignments(run, lifted, dialect !== 'posix')
      sub = substitute(run, lifted, bindings)
    } finally {
      run.psText = wasPs
    }
    // PowerShell and cmd read a backslash before a quote as an ordinary character, a POSIX shell as an
    // escape; where the text has one, both readings are taken and their findings unioned (review 2026-11-23).
    // A backslash before a subexpression, a brace or a name (`"$env:TEMP\$(New-Guid)"`) is a separator in
    // PowerShell and starts no second reading: read as an escaped dollar it glued the folder to the next name
    // and refused ordinary temp work (review 2026-11-24, seventh).
    const readings = dialect === 'posix' ? [true] : /\\"|\\[$`](?![({\w])/.test(sub) ? [false, true] : [false]
    let first: Tok[] = []
    let firstCtx: Ctx | null = null
    for (const posixQuotes of readings) {
      const toks = tokenize(sub, posixQuotes, run, dialect === 'cmd' && !posixQuotes, dialect === 'posix')
      if (first.length === 0) first = toks
      const ctx = newCtx(run, sub, plain, base, via, depth, true, { ...o, dialect })
      ctx.segs = segment(toks, sub)
      firstCtx ??= ctx
      classifySegments(ctx)
      // `$(...)` inside double quotes: scanned as a nested command.
      if (!o.codeAsShell) for (const t of toks) if (t.kind === 'w') for (const s of t.subs) scanPayload(run, s, ctx.base, via, depth + 1, 'shell', { dialect, baseUnreadable: ctx.baseUnreadable })
    }
    if (o.codeAsShell) return
    const ctx = newCtx(run, sub, plain, base, via, depth, true, { ...o, dialect })
    // `${C:\x} = 'v'`, `${C:\x} += 'v'`: PowerShell writes the file through the FileSystem provider (measured: `${C:\x}`
    // reads it), so the assignment is a write to that path (review 2026-11-24, seventh, P7).
    if (dialect === 'ps') {
      for (const m of sub.matchAll(PS_FILE_VARIABLE)) {
        run.out.sawWrite = true
        const r = emitWord(ctx, null, { ...literalWord(m[2]), raw: renderOrig(run, m[0]) }, 'write', { relAllowed: true, verb: 'variable =' })
        if (r !== 'ok') unresolved(run, 'write', 'variable =', false, plain)
      }
    }
    // A call on the pipeline's item (`% { [IO.Directory]::Delete($_, $true) }`) reads what the pipeline handed it.
    if (firstCtx !== null) { ctx.segs = firstCtx.segs; ctx.segPaths = firstCtx.segPaths }
    const was = run.psStrings
    run.psStrings = dialect === 'ps'
    try {
      // Text inside quotes is a literal to PowerShell, not a call: a payload written there is read where it is
      // handed to its shell (review 2026-11-24, sixth: it was also read here, with the quotes of the outer text).
      ctx.quoted = dialect === 'ps' ? quotedRanges(sub) : []
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
  // `import('fs').then(f => f.rmSync(...))` (review 2026-11-24, sixth).
  for (const m of code.matchAll(/\bimport\(\s*['"](?:node:)?(fs\/promises|fs|child_process)['"]\s*\)\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)) addDotted(m[2], JS_MODULES[m[1]])
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
    const was = run.pathMods
    run.pathMods = pathModules(code)
    const cb = findCodeAssignments(run, code)
    const before = run.out.paths.length
    scanCodeCalls(ctx, code, CODE_CALLS, cb)
    // Bun's shell (`Bun.$\`rm -rf x\``): the template is a POSIX shell command (review 2026-11-24, sixth).
    for (const m of code.matchAll(/\bBun\.\$\s*`([^`]*)`/g)) {
      if (m[1].includes('${')) { markSelfBuilding(run, 'Bun.$ with a command built at run time'); continue }
      run.out.texts.push(m[1])
      scanPayload(run, m[1], base, `${via}>Bun.$`, depth + 1, 'shell', { dialect: 'posix', baseUnreadable: o.baseUnreadable })
    }
    codeMentions(ctx, sub, new Set(run.out.paths.slice(before).map(p => p.path)))
    run.pathMods = was
  } catch (e) {
    run.out.faults.push(`the inline program could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

/**
 * Writes to a temp or scratch name: an assignment in any of the shells or the inline programs, an API that
 * sets the environment, a code call handed an environment of its own. The temp spellings name the sandbox's
 * folders only while nothing in the command points them elsewhere (review 2026-11-23, fourth).
 */
const TEMP_NAME = String.raw`(?:TEMP|TMP|TMPDIR|CYNCO_SCRATCH)`
/**
 * Read by dialect, never as a name anywhere in the text (review 2026-11-24, sixth: `$tmp = ...`, `tmp=...` and
 * a read of `"$env:TEMP\x"` inside a write's path were taken for a reassignment of TEMP, and the temp folder the
 * brief sends a mission to was refused). A PowerShell variable `$tmp` and a POSIX variable `tmp` are not the
 * TEMP name: PowerShell sets it only as `$env:NAME` (an assignment, a list assignment, a foreach variable),
 * POSIX only with the name upper case (a `NAME=value` prefix, export, declare, read, printf -v, a for
 * variable), cmd with `set NAME=` (any case).
 */
const TEMP_WRITES: RegExp[] = [
  // An assignment the bindings read (`$env:TEMP =`, POSIX `TMPDIR=` and `export TMPDIR=`, cmd `set TMP=` and
  // `set "TMP=..."`, `os.environ['TMP'] =`, `process.env.TMP =`) is judged on its value (`tempAssignment`, review
  // 2026-11-24, seventh); these are the forms whose value the scan does not bind.
  // PowerShell: `$a, $env:TEMP = ...`, `$env:TEMP, $a = ...`, `foreach ($env:TEMP in ...)`.
  new RegExp(String.raw`\$\{?env:${TEMP_NAME}\}?(?:\s*,\s*\$\{?[\w:]+\}?){1,8}\s*[-+*/]?=(?!=)`, 'i'),
  new RegExp(String.raw`,\s*\$\{?env:${TEMP_NAME}\}?\s*=(?!=)`, 'i'),
  new RegExp(String.raw`\bforeach\s*\(\s*\$\{?env:${TEMP_NAME}\}?\s+in\b`, 'i'),
  // POSIX: the name exactly, upper case: an append, a backtick or a brace before it, read, printf -v, a for variable.
  new RegExp(String.raw`(?:^|[\s;&|(\x60{]|\$\()(?:(?:export|declare|typeset|local|readonly)\s+(?:-\w+\s+)*)?${TEMP_NAME}\+=`),
  new RegExp(String.raw`[\x60{]${TEMP_NAME}=`),
  new RegExp(String.raw`\b(?:read|mapfile|readarray)\s+(?:-\w+(?:\s+\S+)?\s+){0,6}(?:[A-Za-z_]\w*\s+){0,8}${TEMP_NAME}\b(?!\s*=)`),
  new RegExp(String.raw`\bprintf\s+-v\s+${TEMP_NAME}\b|\bgetopts\s+\S+\s+${TEMP_NAME}\b|(?:^|[\s;&|(])for\s+${TEMP_NAME}\s+in\b`),
  // cmd: `set /p TEMP=` (read from the console), `set /a TEMP=`.
  new RegExp(String.raw`\bset\s+\/[ap]\s+"?${TEMP_NAME}=`, 'i'),
  // The code forms the bindings do not read: a bare `environ[...]`, Perl's `$ENV{...}`, Ruby's `ENV[...]`, an
  // environment table of its own.
  new RegExp(String.raw`(?<!\bos\.)\benviron\s*\[\s*['"]${TEMP_NAME}['"]\s*\]\s*=(?!=)|\$ENV\{${TEMP_NAME}\}\s*=(?!=)|\bENV\[\s*['"]${TEMP_NAME}['"]\s*\]\s*=(?!=)`),
  new RegExp(String.raw`(?<!\bos\.|\bprocess\.)\b(?!environ\b)\w*env\w*\s*\[\s*['"]${TEMP_NAME}['"]\s*\]\s*=(?!=)`, 'i'),
  new RegExp(String.raw`SetEnvironmentVariable\s*\(\s*['"]${TEMP_NAME}['"]`, 'i'),
  new RegExp(String.raw`\bputenv\s*\(\s*['"]${TEMP_NAME}['"]`, 'i'),
  // An environment handed to a program that sets a temp name (`env={'TMPDIR': ...}`, `env: { TEMP: ... }`).
  new RegExp(String.raw`\benv\s*[=:]\s*(?:\{|dict\s*\()[^})]{0,512}['"]?${TEMP_NAME}['"]?\s*[:=]`, 'i'),
  // A name built at run time: it may be a temp name.
  /SetEnvironmentVariable\s*\(\s*(?!['"][^'"$`]*['"]\s*[,)])/i,
  /\bputenv\s*\(\s*(?!['"][^'"]*['"]\s*[,)])/,
  /\benviron\s*\[\s*(?!['"][^'"]*['"]\s*\])[^\]\n]*\]\s*=(?!=)/,
  /\benviron\.__setitem__\s*\(|\benviron\s*\|=/,
  /\bprocess\.env\s*\[\s*(?!['"`][^'"`$]*['"`]\s*\])[^\]\n]*\]\s*=(?!=)/,
  /\bReflect\.(?:set|defineProperty)\s*\(\s*process\.env\b/,
  /\btempfile\.tempdir\s*=(?!=)/,
  /\benviron\.(?:update|setdefault)\s*\(|\bObject\.assign\s*\(\s*process\.env\b/,
  // An environment handed to a program and built from a computed key (`env={k: v}`, `env[k] = v`).
  /\benv\s*[=:]\s*\{\s*\[|\benv\s*\[\s*(?!['"])[^\]\n]*\]\s*=(?!=)/,
]

/**
 * Review of wave 5. Any item command acting in the env: provider (`Copy-Item env:CAM env:TEMP`, `New-Item -Path
 * Env: -Name TEMP`, `... | Copy-Item -Destination env:TEMP`, `Remove-Item Env:\TEMP`); `$env:X` is a read, not
 * the provider. Read one pipeline element at a time, so a long command costs linear time (sixth review: as one
 * pattern from every verb to the end of the line it was quadratic).
 */
const ENV_ITEM_VERB = /\b(?:Copy-Item|cpi|copy|cp|Move-Item|mi|mv|move|Rename-Item|rni|ren|rename|New-Item|ni|Set-Item|si|Clear-Item|cli|Remove-Item|ri|del|erase|rm|Set-Content|sc|Add-Content|ac|Clear-Content|clc|Out-File|Tee-Object)\b/i
const ENV_PROVIDER = /(?<![$\w{:\\/])env:/i

/**
 * Policy item 4 of the seventh review: only an item command whose operand in the env: provider is a temp or
 * scratch name (`env:TEMP`, `Env:\TMP`), or the provider's root with a name that is one or that cannot be read
 * (`New-Item -Path Env: -Name TEMP`, `-Name $n`). `Remove-Item Env:NODE_ENV` and `Set-Item Env:NODE_OPTIONS`
 * touch no temp name.
 */
function envProviderItem(t: string): string | null {
  if (!ENV_PROVIDER.test(t)) return null
  for (const part of t.split(/[;\n|]/)) {
    if (!ENV_ITEM_VERB.test(part) || !ENV_PROVIDER.test(part)) continue
    if (new RegExp(String.raw`(?<![$\w{:\\/])env:\\?${TEMP_NAME}\b`, 'i').test(part)) return part.trim()
    // `Rename-Item env:X TEMP`: a variable renamed to a temp name.
    if (/\b(?:Rename-Item|rni|ren|rename)\b/i.test(part) && new RegExp(String.raw`(?:^|[\s'":])${TEMP_NAME}(?:$|[\s'"])`, 'i').test(part)) return part.trim()
    // The provider's root, or a name the scan cannot read, with the name given elsewhere.
    const rooted = /(?<![$\w{:\\/])env:\\?(?![\w])/i.test(part) || /(?<![$\w{:\\/])env:\\?[$(]/i.test(part)
    if (!rooted) continue
    const name = part.match(/-(?:N|Na|Nam|Name|NewName|NewN\w*)\s*[:\s]\s*['"]?([^'"\s;|]+)/i)?.[1]
    if (name === undefined || !/^[A-Za-z_]\w*$/.test(name) || TEMP_NAMES.has(name.toUpperCase())) return part.trim()
  }
  return null
}

function finish(run: Run): ShellScan {
  for (const t of run.out.texts) {
    const hit = TEMP_WRITES.map(re => t.match(re)?.[0]).find(m => m !== undefined) ?? envProviderItem(t) ?? undefined
    if (hit !== undefined) { run.out.tempRedirected ??= hit.trim(); break }
  }
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
  const run = newRun(homes, platformOf(opts), opts?.drives ?? null)
  const input = typeof text === 'string' ? text : String(text ?? '')
  run.out.texts.push(input)
  try {
    if (input.length > MAX_TEXT) { run.out.faults.push('a command longer than 1 MiB'); return run.out }
    if (SENTINEL_CHARS.test(input)) { run.out.faults.push(SENTINEL_INPUT); return run.out }
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
  const run = newRun(homes, platformOf(opts), opts?.drives ?? null)
  try {
    const list = (Array.isArray(words) ? words : []).map(w => String(w ?? ''))
    if (list.length === 0) return run.out
    if (list.join(' ').length > MAX_TEXT) { run.out.faults.push('a command longer than 1 MiB'); return run.out }
    if (list.join(' ').length > MAX_SCANNED_TEXT) { run.out.faults.push(TOO_LONG); return run.out }
    if (list.some(w => SENTINEL_CHARS.test(w))) { run.out.faults.push(SENTINEL_INPUT); return run.out }
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

/**
 * Whether a PowerShell command ends in a native program: the last element of its last top-level statement is
 * a program PowerShell starts (`pytest`, `git`, `cmd /c ...`, `& 'C:\x\tool.exe'`), not a cmdlet, one of
 * PowerShell's aliases, a keyword, a value or an expression. Under `powershell -Command` such a program's exit
 * code reaches the caller only as 0 or 1 (measured 2026-11-24: `cmd /c exit 3` answers 1); the Bash tool carries
 * the real one for these commands only (`impl/bash.ts`). Pure; false for anything it cannot read.
 */
export function endsInNativeProgram(text: string): boolean {
  return nativeTail(text) !== null
}

/**
 * Where the last top-level statement of a command that `endsInNativeProgram` starts, when that statement stands
 * at the start of the text or after a `;` or a line break, and the text holds no here-string (whose lifting would
 * move the offsets); null otherwise (wave 15b). The Bash tool sets `$LASTEXITCODE` to 0 there, so a last program
 * that cannot start reads 1, never a code an earlier program of the command left. Null as well when that last
 * statement reads `$LASTEXITCODE` or `$?` (wave 15c, N6: `python a.py; python report.py $LASTEXITCODE` would be
 * handed 0, a different command from the one the model wrote).
 */
export function nativeTailStart(text: string): number | null {
  const t = nativeTail(text)
  if (t === null || !t.asWritten) return null
  if (/\$(?:global:|script:)?LASTEXITCODE\b|\$\?|\$\{(?:global:)?(?:LASTEXITCODE|\?)\}/i.test(text.slice(t.start))) return null
  const before = text.slice(0, t.start).replace(/[ \t]+$/, '')
  return before === '' || before.endsWith(';') || before.endsWith('\n') ? t.start : null
}

/** The last statement's start in the text as it was read, and whether that text is the text as written (no here-string lifted). */
function nativeTail(text: string): { start: number; asWritten: boolean } | null {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SCANNED_TEXT) return null
    const run = newRun({ home: '', appData: '', localAppData: '', temp: '', scratch: null, user: '' }, 'win32')
    const lifted = liftBodies(run, psNormalize(text), 'ps')
    const segs = segment(tokenize(lifted, false, run, false), lifted).filter(s => s.parentPipeline === null)
    if (segs.length === 0) return null
    // The statement that starts last, and the last element of its pipeline.
    const lastStart = segs.reduce((a, s) => (s.start > a.start && s.pipeIndex === 0 ? s : a), segs.find(s => s.pipeIndex === 0) ?? segs[0])
    const elements = segs.filter(s => s.pipeline === lastStart.pipeline)
    const last = elements.reduce((a, s) => (s.pipeIndex > a.pipeIndex ? s : a), elements[0])
    // Nothing of the text may come after it but whitespace, a comment or a redirect target.
    if (segs.some(s => s.start > last.start && s.pipeline !== last.pipeline)) return null
    const head = last.words[0]
    if (!head || last.subexpr) return null
    if (!last.call && head.pieces.some(p => p.q !== 'n')) return null
    const word = head.pieces.map(p => p.t).join('')
    if (!last.call && !/^[A-Za-z0-9_.\\/:~-]/.test(word)) return null
    if (word.includes(S0) || word.includes(UNREAD)) return null
    const verb = verbName(word)
    return isNativeHead(verb) && !NOT_A_PROGRAM.test(verb) && !/^\d/.test(verb) ? { start: lastStart.start, asWritten: run.bodies.length === 0 && lifted.length === text.length } : null
  } catch {
    return null
  }
}

