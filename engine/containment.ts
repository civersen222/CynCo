/**
 * engine/containment.ts: the containment of unattended runs (F242).
 *
 * On 2026-11-22 one Bash call of an unattended campaign mission deleted every dot-folder of the
 * owner's home folder and then the application folders of AppData\Local, in alphabetical order
 * up to "pip". This module is the run context every layer consults (`runContainment()`),
 * the per-run sandbox and its record (`<sandbox root>/<run id>/containment.json`), the one
 * environment builder for every child that runs workspace code (`toolEnv`), the one place that
 * decides how such a child is started (`containedCommand`: as it is, or on Windows through the
 * low-integrity launcher `engine/lowIntegrityLauncher.ts`), `toolExec` / `toolExecSync`, and the
 * one refusal format every layer uses.
 *
 * It imports node built-ins, `./paths.js`, `./missionEnv.js` and `./realPath.js` only, and no Bun
 * API, so the tools, the audit and the integrity module can import it without a cycle and vitest's
 * Node can load it. Every synchronous child it starts (`icacls`, `whoami`, the launcher probe, the
 * volume listing, the access-list restore of a release) goes through `runVia`, which applies the F155 rule. No `icacls` call carries
 * `/T`, and the module never calls a recursive remove: `removeTreeNoFollow` is the one walk that
 * deletes, and only `sweepSandboxes` calls it.
 */
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, ExecException, ExecSyncOptions } from 'node:child_process'
import type { BigIntStats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditDir, cyncoHome, guardDir, modelsDir, sandboxRoot } from './paths.js'
import { isContainedRun, RUN_ID_RE } from './missionEnv.js'
import { type EntryKind, isInside, isLinkEntry, listEntries, realPathOf, whyNotAtOwnPath } from './realPath.js'

// ─── Types and module state ──────────────────────────────────────────────────────────────────

export const CONTAINMENT_LAYERS = ['lowil', 'paths'] as const
export type ContainmentLayer = (typeof CONTAINMENT_LAYERS)[number]
export type ContainmentKind = 'mission' | 'daemon-task' | 'precheck' | 'grader'

export interface RunContainment {
  runId: string
  kind: ContainmentKind
  test: boolean
  missionCwd: string
  cwdLabel: 'low' | 'none'
  extraRoots: string[]
  sandbox: { root: string; home: string; tmp: string; scratch: string }
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  unprotectedVolumes: string[]
  isolation: 'verified' | 'overlay'
  /**
   * B1 (wave 19): the copy of Git's Unix tools this run's children start first (`<it>\usr\bin` first on
   * a contained child's PATH, `toolEnv`), from the record, which only the starter writes
   * (`LOCALCODE_CONTAINMENT_MSYS`, read at create). Null or absent: today's behaviour.
   */
  msysRuntime?: string | null
}

export interface ContainmentRecord {
  schema: 1
  runId: string; kind: ContainmentKind; test: boolean
  missionCwd: string; cwdLabel: 'low' | 'none'; cwdGranted: boolean
  extraRoots: string[]
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  unprotectedVolumes: string[]
  createdAt: string
  createdByPid: number
  holder: { pid: number; startedAt: string } | null
  releasedAt: string | null
  releasedBy?: 'release' | 'sweep' | 'failed-establish' | 'holder-gone'
  /**
   * Each folder whose access list was widened (`cwdGranted`) so that its label could be set, with
   * the copy of its access list saved in the run folder just before (`icacls /save`). The release
   * puts that access list back (R1 F1). A record written before 2026-11-24 has none.
   */
  grants?: Array<{ folder: string; aclFile: string }>
  /**
   * P2-B4: the grants a release (or a failed establish) could not undo (another run held the folder,
   * a link under it led out, or the write failed). The sweep keeps the run folder, with the saved
   * copies, while one is listed; `restoreKeptGrants` (`cynco-sandbox.mjs restore-acl <run id>`) puts
   * them back and empties it. `why` (wave 19, C5/C6): `held` another run holds the folder, `label` its
   * label could not be set back first, `link` the restore waits for rule M, `restore` the write failed,
   * `unfinished` written with the release's first write, so a release that ends part way still says so
   * (restore-acl then sets the folder's label back first, as for `label`). A record of before wave 19 has none.
   */
  grantsKept?: Array<{ folder: string; aclFile: string; why?: GrantKeptWhy }>
  /**
   * R1 (wave 19b): the process releasing this record, written with the release's first write when it
   * keeps grants (`unfinished`) and removed by its last one. While that process is alive (and is not the
   * reader), the release is still running: `restore-acl` waits and `status` says so (`releaseInProgress`).
   * Judged by the pid alone, as a holder is.
   */
  releasing?: { pid: number; startedAt: string }
  /**
   * Wave 15c: the release stopped setting the sandbox's home, tmp and scratch back to medium after
   * `folders` folders (`SANDBOX_SET_BACK_BUDGET`); the rest stays labelled low, and the sweep removes
   * the sandbox by its listing walk without walking it again. BB-6 (wave 19c): `notEntered`, the folders not
   * entered because Windows reads their name as another entry (R2), with `budgetStopped` whether the budget
   * stopped the walk too; a record without them is a budget stop (`sandboxLeftLowWords` says which).
   */
  sandboxLeftLow?: { folders: number; at: string; notEntered?: number; budgetStopped?: boolean }
  /** C8 (wave 19): when the release set the whole sandbox back to medium; the sweep then does not walk it again. */
  sandboxSetBackAt?: string
  /** B1 (wave 19): the real path of the copy of Git's Unix tools, checked at create; absent when the switch is off. */
  msysRuntime?: string | null
  /**
   * P2-F6: for each folder the run works in, read at establish before any label or grant, the
   * entries under it that already had inheritance turned off, or were links, or could not be read:
   * their paths, one per line, in `listFile` in the run folder (medium, so the run cannot change it).
   * The release never turns inheritance back on for one of them, and names them. `unread` says why
   * the folder could not be read; then nothing under it is reset. A record written before
   * 2026-11-24 has none, and nothing under its folders is reset either.
   */
  inheritanceBefore?: Array<{ folder: string; listFile?: string; count?: number; unread?: string }>
}

/** Why a grant is kept in the record (`ContainmentRecord.grantsKept`). */
export type GrantKeptWhy = 'held' | 'label' | 'link' | 'restore' | 'unfinished'

/** The injectable synchronous runner (the test seam). `out` is stdout plus stderr. */
export type ContainmentRunner = (file: string, args: string[], capMs: number) => { ok: boolean; out: string; code: number | null }

let current: RunContainment | null = null

/** The context of this process, or null when it is not a contained run. */
export function runContainment(): RunContainment | null {
  return current
}

/** Set by the engine's boot block, by the driver after its adopt, and by tests (restored to null). */
export function setRunContainment(c: RunContainment | null): void {
  current = c
}

function frozen(c: RunContainment): RunContainment {
  Object.freeze(c.sandbox)
  Object.freeze(c.folders)
  Object.freeze(c.extraRoots)
  Object.freeze(c.unprotectedVolumes)
  return Object.freeze(c)
}

/**
 * C1 (wave 19): one rule on every host, not the host's `isAbsolute`. A drive path (`C:\x`, `C:/x`)
 * or a UNC path (`\\server\share`) is absolute everywhere, so a test that builds a Windows context
 * from Windows literals passes on Linux CI too; a path rooted without a drive (`\x`, `/x`) is not
 * on Windows, where it gives Windows PowerShell an empty LocalApplicationData exactly as a relative
 * one does (measured 2026-11-24); a device path (`\\?\`, `\\.\`) is not either. Elsewhere `/x` is.
 */
function absoluteOnEveryHost(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\?.]/.test(p) || (process.platform !== 'win32' && p.startsWith('/'))
}

/**
 * A context for a test, built from the folders the test names. Pure: it touches no disk. Refuses
 * to run inside a process that is itself an unattended run.
 */
export function testContainment(a: {
  missionCwd: string
  sandbox: { root: string; home: string; tmp: string; scratch: string }
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  kind?: ContainmentKind
  extraRoots?: string[]
  unprotectedVolumes?: string[]
  isolation?: 'verified' | 'overlay'
  runId?: string
  msysRuntime?: string | null
}): RunContainment {
  if (isContainedRun(process.env, process.argv)) {
    throw new Error('testContainment() was called in a process that is itself an unattended run')
  }
  // P2-B10: toolEnv hands these on as USERPROFILE, TEMP and the like. A relative one is read against
  // the child's working folder: Windows PowerShell with a relative USERPROFILE writes its module
  // analysis cache under it (measured), which is how a cache got into the repository.
  for (const k of ['root', 'home', 'tmp', 'scratch'] as const) {
    if (!absoluteOnEveryHost(a.sandbox[k])) throw new Error(`testContainment() takes absolute paths: the sandbox ${k} ${a.sandbox[k]} is not one`)
  }
  if (!absoluteOnEveryHost(a.home)) throw new Error(`testContainment() takes absolute paths: the home ${a.home} is not one`)
  return frozen({
    runId: a.runId ?? mintRunId('test'),
    kind: a.kind ?? 'mission',
    test: true,
    missionCwd: resolve(a.missionCwd),
    cwdLabel: 'none',
    extraRoots: (a.extraRoots ?? []).map(p => resolve(p)),
    sandbox: { ...a.sandbox },
    home: a.home,
    folders: { ...a.folders },
    unprotectedVolumes: [...(a.unprotectedVolumes ?? [])],
    isolation: a.isolation ?? 'overlay',
    msysRuntime: a.msysRuntime ?? null,
  })
}

// ─── The refusal text, one format for every layer ────────────────────────────────────────────

export type RefusalLayer = 'containment' | 'protected path' | 'audit' | 'integrity'
const REFUSAL_LAYERS: readonly RefusalLayer[] = ['containment', 'protected path', 'audit', 'integrity']

const DEFAULT_ADVICE: Record<RefusalLayer, string> = {
  containment: 'The command was not run, and retrying it will not help: this is an unattended run and its tools start only inside its sandbox.',
  audit: 'Nothing was run. No tool will run until that is fixed, and it cannot be fixed from inside the run: do not retry and do not try another tool. Say in your reply that the run stopped because the record could not be written, and stop.',
  integrity: 'Nothing was run. A protected folder changed during this run; the run has been stopped and the owner has been paged. Do not retry and do not try another tool. Say in your reply what you did last, and stop.',
  // The protected-path layer always passes its own advice (`Nothing was run.`, a blank line and
  // its advice paragraph); this is the floor when it does not.
  'protected path': 'Nothing was run.',
}

export function refusalPrefix(layer: RefusalLayer): string {
  return `Refused [${layer}]:`
}

/** `Refused [<layer>]: <reason>. <advice>`, what the model is shown as a tool result. */
export function refusalText(layer: RefusalLayer, reason: string, advice?: string): string {
  return `${refusalPrefix(layer)} ${reason}. ${advice ?? DEFAULT_ADVICE[layer]}`
}

/** The layer a refusal text was made by, read from its prefix; null for any other text. */
export function refusalLayerOf(output: string): RefusalLayer | null {
  if (typeof output !== 'string') return null
  for (const layer of REFUSAL_LAYERS) if (output.startsWith(refusalPrefix(layer))) return layer
  return null
}

/**
 * The reason a refusal text carries, as every fault is raised with it: the first line after the
 * `Refused [<layer>]:` prefix, at most 300 characters. One form for the executor and for the sites
 * that start a process without it, so the operator reads the same text from every source.
 */
export function refusalReasonOf(text: string): string {
  const line = String(text).slice(String(text).indexOf(':') + 1).trim().split('\n')[0] ?? ''
  return line.trim().slice(0, 300)
}

/** `<tag> REFUSED: <layer>: <reason> — nothing was <run | dispatched>`, for stderr, a log or an outcome. */
export function operatorRefusal(tag: string, layer: RefusalLayer, reason: string, what: 'run' | 'dispatched'): string {
  return `${tag} REFUSED: ${layer}: ${reason} — nothing was ${what}`
}

export const NO_CONTAINMENT = 'no containment was established for this unattended run'
export const SWITCH_IN_UNATTENDED = 'LOCALCODE_CONTAINMENT_OFF switches a containment layer off and may not be set for a dispatched mission, a daemon task, a precheck or a grader'
export const LAUNCHER_UNAVAILABLE = (why: string) => `the low-integrity launcher is unavailable on this Windows runtime (${why})`
export const MSYS_IN_CONTAINED_RUN = 'Git Bash and the other programs of Git\\usr\\bin (bash, sh, grep, sed, tail, head, ls) cannot start inside a contained run on Windows: the process that starts the run\'s commands holds the installed Git\'s shared namespace at normal integrity for as long as the run lasts, so that no low process can make it, and a low program of that Git cannot join it'
/** B1 (wave 19): the hint with the Git-tools switch on. */
export const MSYS_WITH_COPY = (copy: string) => `A program of Git's Unix tools could not start. In this run they work from a copy (${copy}\\usr\\bin), which comes first on the PATH: call bash, sh, grep, sed and the rest by their bare names. Started by a full path (C:\\Program Files\\Git\\...), they fail, always; and if the copy itself fails, something is running it at normal privilege (the owner's side), which this run cannot change`

/** The line `dispatch-mission.sh` prints and the campaign runner reads back (ruling 3.3). */
export const DISPATCH_RUN_PREFIX = '[dispatch] run '

/** The launcher's own exit codes (entry 1.M1): "did not run" and "ended with no status". */
export const LAUNCHER_REFUSED_EXIT = 197
export const LAUNCHER_CHILD_GONE_EXIT = 198

/**
 * The per-spawn seal (review of slice S5): `containedCommand` puts a fresh random value in the
 * launcher's OWN environment under this key, the launcher takes it out of its environment before it
 * builds the child's (and `toolEnv` strips the key for every child), and the launcher ends its own
 * 197 and 198 with `[containment] sealed <seal> <status>` on stderr. The child shares that stderr and
 * passes its status through, so without the seal a command could print the refused line, exit 197
 * and have its own call booked as one that never ran. The child's environment never holds the value.
 * Measured (containmentLauncher.test.ts, "the seal ... (MEASURED)"): the low child cannot open its
 * launcher or the engine for reading. It could read the environment block of a live medium Git Bash
 * through a process handle it INHERITED (a handle's access is not checked again against the integrity
 * label), so the launcher makes every handle it inherited non-inheritable before it starts the child
 * (`dropInheritedHandles`, engine/lowIntegrityLauncher.ts; review of wave 5); the same case now asserts
 * that the child holds no inherited handle and reads no environment through one.
 */
export const LAUNCHER_SEAL_ENV = 'CYNCO_LAUNCHER_SEAL'
export const LAUNCHER_SEAL_PREFIX = '[containment] sealed '

/** A sandbox is removed by the sweep this many days after it was created. */
export const SANDBOX_KEEP_DAYS = 7

const HOLDERLESS_GRACE_MS = 15 * 60_000
const LONG_COMMAND_CHARS = 8000
const LAUNCHER_SCRIPT = 'lowIntegrityLauncher.ts'
const LAUNCHER_CONFIG = 'lowIntegrityLauncher.bunfig.toml'

/**
 * A refusal made before a spawn, or a launcher that could not run (codes ECONTAINMENT / ECHILDGONE).
 * `ran` is true when a process the caller started did run (the launcher's child ended with no status,
 * or a Bun it started could not load its script): then `exitCode` is that process's status, or null.
 */
export class ContainmentRefusal extends Error {
  code: 'ECONTAINMENT' | 'ECHILDGONE'
  reason: string
  ran: boolean
  exitCode: number | null
  constructor(code: 'ECONTAINMENT' | 'ECHILDGONE', reason: string, text: string, ran = false, exitCode: number | null = null) {
    super(text)
    this.name = 'ContainmentRefusal'
    this.code = code
    this.reason = reason
    this.ran = ran
    this.exitCode = exitCode
  }
}

// ─── The checkout, the switch ────────────────────────────────────────────────────────────────

let checkoutCache: string | null = null

/** The checkout the running engine was loaded from: the parent of `engine/`, as a real path. */
export function engineCheckout(): string {
  if (checkoutCache === null) checkoutCache = realPathOf(dirname(dirname(fileURLToPath(import.meta.url))), { quiet: true })
  return checkoutCache
}

/** The ONE read of `LOCALCODE_CONTAINMENT_OFF`: a comma list of layer words. */
export function containmentSwitch(env: Record<string, string | undefined> = process.env)
  : { raw: string | null; off: ContainmentLayer[]; unknown: string[] } {
  const v = env.LOCALCODE_CONTAINMENT_OFF
  if (typeof v !== 'string' || v.trim() === '') return { raw: null, off: [], unknown: [] }
  const off: ContainmentLayer[] = []
  const unknown: string[] = []
  for (const word of v.split(',').map(w => w.trim().toLowerCase()).filter(w => w !== '')) {
    if ((CONTAINMENT_LAYERS as readonly string[]).includes(word)) off.push(word as ContainmentLayer)
    else unknown.push(word)
  }
  return { raw: v, off, unknown }
}

function switchedOff(layer: ContainmentLayer, test: boolean, env: Record<string, string | undefined> = process.env): boolean {
  const sw = containmentSwitch(env)
  return test && sw.unknown.length === 0 && sw.off.includes(layer)
}

/** Is `layer` switched off for this context? Only ever for a test context, and never with an unknown word. */
export function containmentOff(layer: ContainmentLayer, ctx: RunContainment | null,
  env: Record<string, string | undefined> = process.env): boolean {
  return switchedOff(layer, ctx?.test === true, env)
}

function unknownLayerReason(word: string): string {
  return `LOCALCODE_CONTAINMENT_OFF names an unknown layer: ${word}`
}

// ─── The environment builder ─────────────────────────────────────────────────────────────────

/**
 * What a contained child never inherits: the exact names of before wave 19, and (B2, wave 19) every
 * variable whose NAME says credential or session, whatever program set it. A run started from a tool
 * shell handed its children that shell's messaging token and socket, its session and account
 * identifiers, an ask-pass program and an API base address (names read 2026-11-25, never values).
 * Matched on the name, without case, so the rule names no program. What each pattern can cost an
 * honest tool inside a run: a forge, registry or cloud token, key, password or credential file is not
 * there (an authenticated push, publish or download fails; a test that reads a key skips or fails);
 * ASKPASS, an SSH or GPG agent: no password prompt and no key of the owner's reaches the box; SESSION:
 * on Linux the desktop bus and session type are gone (keyrings, notifications); ACCOUNT, ORGANIZATION,
 * USER_EMAIL: an SDK's account selection. An address (a name ending in BASE_URL or API_BASE) is not in
 * the rule (wave 19b): an address is not a credential, and stripping one can send a client that was
 * pointed at a local server (the model server on this PC, a proxy) to its public default address
 * instead. The cache and home levers (PIP_CACHE_DIR, npm_config_cache, PYTHONUSERBASE, CARGO_HOME,
 * RUSTUP_HOME, NPM_CONFIG_USERCONFIG, PIP_CONFIG_FILE) match none of them and pass as before.
 */
export const SECRET_ENV = [
  /^CYNCO_NTFY_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^LOCALCODE_API_KEY$/, /^OPENAI_API_KEY$/,
  /(^|_)(AUTH_?)?TOKENS?(_|$)/i, /(^|_)SECRETS?(_|$)/i, /PASS(WORD|WD|PHRASE)/i, /(^|_)PASS(_|$)/i,
  /(^|_)(API|ACCESS|PRIVATE|SIGNING)_?KEYS?(_|$)/i, /(^|_)KEYS?$/i, /ASKPASS/i, /(^|_)AGENT_(INFO|SOCK|PID)$/i,
  /(^|_)O?AUTH(_|$)/i, /CREDENTIAL/i, /(^|_)COOKIES?(_|$)/i, /(^|_)SESSION(_|$)/i, /(^|_)MESSAGING(_|$)/i,
  /(^|_)(ACCOUNT|ORGANI[SZ]ATION)(_|$)/i, /(^|_)USER_EMAIL$/i,
]

/** Keys the harness reads and no tool child may hold, in every mode (Phase 7 final review I1). */
const ALWAYS_STRIP = [/^LOCALCODE_MISSION_/, /^CYNCO_MARKER_CHECK/, /^CYNCO_MISSION_ALSO_LABEL$/, /^CYNCO_LAUNCHER_SEAL$/]
/** Keys that name the containment's own folders and switches; stripped when a context is set. */
const CONTEXT_STRIP = /^LOCALCODE_(SANDBOX_ROOT|GUARD_DIR|AUDIT_DIR|MODELS_DIR|CONTAINMENT_|UNPROTECTED_VOLUMES_OK)/

/** A PATH entry as a comparable folder: quotes off, slashes one way, no trailing separator, case folded. */
function pathEntryKey(entry: string): string {
  return entry.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Git's (or any msys) Unix folders: `...\usr\bin`, `...\usr\local\bin`, and the bare POSIX forms. */
const MSYS_PATH_ENTRY = /(^|\\)usr\\(local\\)?bin$/

/**
 * The PATH of a contained child on Windows, from the PATH it would have had. Pure. Nothing is
 * removed and nothing is repeated: Windows' own `System32` and `System32\WindowsPowerShell\v1.0`
 * entries that stand after the first of Git's Unix folders (`usr\bin`, `usr\local\bin`; Git Bash
 * puts them first when it starts a program) are moved to just before it, so a bare `whoami`,
 * `find`, `sort` or `timeout` starts Windows' program and not msys's copy (R1 F2), while `grep`,
 * `sed` and the other Unix-only names stay reachable after them. When one of the two is not on the
 * PATH at all and a Unix folder is, it is put there too. With no Unix folder on it the PATH is
 * returned as it was. `o.first` is a list of folders put ahead of
 * everything (none today; the hook for a private copy of Git's Unix runtime, which would have to
 * come first). `o.systemRoot` is the Windows folder (default `C:\Windows`).
 *
 * It is not `toolEnv`'s default (P2-F5, decided in wave 15b): as the default it made a bare `bash`
 * start System32\bash.exe, the WSL launcher, instead of Git's. Since wave 19 (B1) `toolEnv` calls it
 * only with the Git-tools switch on, with the copy's `usr\bin` in `first`, so a bare `bash` is the copy's.
 */
export function containedPathValue(pathValue: string, o: { systemRoot?: string; first?: string[] } = {}): string {
  const systemRoot = (o.systemRoot ?? 'C:\\Windows').replace(/[\\/]+$/, '')
  const sys32 = `${systemRoot}\\System32`
  const wanted = [sys32, `${sys32}\\WindowsPowerShell\\v1.0`]
  const wantedKeys = wanted.map(pathEntryKey)
  const entries = pathValue.split(';')
  const firstMsys = entries.findIndex(e => MSYS_PATH_ENTRY.test(pathEntryKey(e)))
  let out = entries
  if (firstMsys >= 0) {
    const isSystem = (e: string) => wantedKeys.includes(pathEntryKey(e))
    const moved = entries.slice(firstMsys).filter(isSystem)
    const present = new Set(entries.filter(isSystem).map(pathEntryKey))
    const added = wanted.filter((w, i) => !present.has(wantedKeys[i]))
    out = [
      ...entries.slice(0, firstMsys),
      ...moved, ...added,
      ...entries.slice(firstMsys).filter(e => !isSystem(e)),
    ]
  }
  const first = (o.first ?? []).filter(f => f.trim() !== '')
  return (first.length ? [...first, ...out] : out).join(';')
}

/**
 * The environment of every child that runs workspace code. With no context: `base` without the
 * harness-only keys, with UTF-8 forced for Python. With a context: also without the containment's
 * own keys and the secrets, and with home, temp and scratch pointed into the sandbox; on Windows
 * also every `OneDrive*` variable pointed at `<sandbox home>\OneDrive`. The PATH is kept as given
 * (not `containedPathValue`: P2-F5). Applied exactly once per child (it is not idempotent: PYTHONUSERBASE is
 * derived from the base APPDATA). Left as they are, a named limit (reads are not restricted):
 * PSModulePath, BUN_INSTALL, CARGO_HOME, and the Bun cache keys the acceptance's inner run sets.
 */
export function toolEnv(base: Record<string, string | undefined> = process.env, ctx: RunContainment | null = runContainment(),
  platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  const win = platform === 'win32'
  const norm = (k: string) => (win ? k.toUpperCase() : k)
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) {
    const nk = norm(k)
    if (ALWAYS_STRIP.some(re => re.test(nk))) continue
    if (ctx && (CONTEXT_STRIP.test(nk) || SECRET_ENV.some(re => re.test(nk)))) continue
    out[k] = v
  }
  const get = (key: string): string | undefined => {
    if (!win) return base[key]
    for (const [k, v] of Object.entries(base)) if (k.toUpperCase() === key && typeof v === 'string') return v
    return undefined
  }
  // On Windows a key differing only in case is the same variable: keep one spelling.
  const set = (key: string, value: string) => {
    if (win) for (const k of Object.keys(out)) if (k !== key && k.toUpperCase() === key) delete out[k]
    out[key] = value
  }
  set('PYTHONIOENCODING', 'utf-8')
  set('PYTHONUTF8', '1')
  if (!ctx) return out

  const sb = ctx.sandbox
  set('HOME', sb.home)
  set('TEMP', sb.tmp)
  set('TMP', sb.tmp)
  set('TMPDIR', sb.tmp)
  set('CYNCO_SCRATCH', sb.scratch)
  set('GIT_CONFIG_GLOBAL', join(sb.home, '.gitconfig'))
  // Wave 19b: the child's own Bun never fetches a package by itself. Bun installs a missing one from the
  // registry when the script it runs lies outside every node_modules tree; --no-install in BUN_OPTIONS
  // stops that, whatever the command line or a bunfig asks (measured 2026-11-25: --install=force and
  // auto = "fallback" included). What the starter's BUN_OPTIONS held stays, before it. An explicit
  // `bun install` or `bun add` still runs; `bunx` of a tool that is not installed answers that it is not.
  const bunOptions = (get('BUN_OPTIONS') ?? '').trim()
  set('BUN_OPTIONS', /(^|\s)--no-install(\s|$)/.test(bunOptions) ? bunOptions : `${bunOptions} --no-install`.trim())
  const userBase = get('PYTHONUSERBASE')
  if (userBase !== undefined && userBase !== '') set('PYTHONUSERBASE', userBase)
  else if (win) set('PYTHONUSERBASE', join(get('APPDATA') || join(ctx.home, 'AppData', 'Roaming'), 'Python'))
  else set('PYTHONUSERBASE', join(ctx.home, '.local'))
  if (win) {
    set('USERPROFILE', sb.home)
    const m = /^([A-Za-z]:)(.*)$/.exec(sb.home)
    set('HOMEDRIVE', m ? m[1] : '')
    set('HOMEPATH', m ? (m[2].replace(/\//g, '\\') || '\\') : sb.home)
    set('APPDATA', join(sb.home, 'AppData', 'Roaming'))
    set('LOCALAPPDATA', join(sb.home, 'AppData', 'Local'))
    // NOW.md:96: OneDrive, OneDriveConsumer, OneDriveCommercial (and any other spelling Windows
    // adds) named the real profile's OneDrive folder; each one present now names the sandbox's.
    for (const k of Object.keys(out)) if (/^ONEDRIVE/i.test(k)) out[k] = join(sb.home, 'OneDrive')
    // The PATH is passed as it was given (P2-F5, wave 15b): reordering it with containedPathValue
    // made a bare `bash` under a Git Bash PATH start System32\bash.exe, the WSL launcher. A Windows
    // program that shares a name with one of Git's resolves to Git's copy; the msys hint says so.
    // B1 (wave 19): with the switch on (`msysRuntime`, from the record), the copy's usr\bin goes first,
    // under every spelling of the key, so a bare bash, grep or a hook's sh is the copy's (measured: only
    // a name resolved through PATH reaches it). Nowhere else: no medium process may start the copy.
    if (ctx.msysRuntime) {
      // F1 (wave 19b): a Windows path whatever the host (the host's join gave C:\x/usr/bin on Linux).
      const first = [win32.join(ctx.msysRuntime, 'usr', 'bin')]
      const systemRoot = get('SYSTEMROOT') || 'C:\\Windows'
      const keys = Object.keys(out).filter(k => k.toUpperCase() === 'PATH')
      if (keys.length === 0) out.PATH = first[0]
      for (const k of keys) out[k] = containedPathValue(out[k] ?? '', { first, systemRoot })
    }
  }
  const xdg: Array<[string, string[]]> = [
    ['XDG_CONFIG_HOME', ['.config']], ['XDG_CACHE_HOME', ['.cache']],
    ['XDG_DATA_HOME', ['.local', 'share']], ['XDG_STATE_HOME', ['.local', 'state']],
  ]
  for (const [key, parts] of xdg) if (get(key) !== undefined) set(key, join(sb.home, ...parts))
  return out
}

// ─── How a contained child is started ────────────────────────────────────────────────────────

export interface ToolCommand { file: string; args: string[]; shell?: string | true }
export interface ContainedSpawn {
  file: string; args: string[]; cwd: string | undefined
  env: Record<string, string | undefined>; viaLauncher: boolean
  /** A long command written to the run folder; the caller deletes it when the child has ended. */
  commandFile?: string
  /** The launcher's seal for this spawn (`LAUNCHER_SEAL_ENV`); set exactly when `viaLauncher`. */
  seal?: string
}

let commandFileSeq = 0

function launcherPaths(): { script: string; config: string } {
  const engineDir = join(engineCheckout(), 'engine')
  return { script: join(engineDir, LAUNCHER_SCRIPT), config: join(engineDir, LAUNCHER_CONFIG) }
}

/** The launcher's start form, up to and including its script path. */
function launcherHead(): string[] {
  const { script, config } = launcherPaths()
  return ['--no-env-file', `--config=${config}`, script]
}

/**
 * The ONE place that decides the file, arguments, working folder and environment of a child that
 * runs workspace code. Pass-through with no context, off Windows, or for a test context with
 * `lowil` switched off; otherwise the low-integrity launcher's argv, started in the checkout with
 * the engine's own environment (the launcher builds the child's environment after it has lowered
 * its token).
 */
export function containedCommand(cmd: ToolCommand, o: {
  ctx?: RunContainment | null; cwd?: string
  env?: Record<string, string | undefined>; extraEnv?: Record<string, string>
  platform?: NodeJS.Platform; execPath?: string
} = {}): ContainedSpawn {
  const ctx = o.ctx === undefined ? runContainment() : o.ctx
  const platform = o.platform ?? process.platform
  if (!ctx || platform !== 'win32' || containmentOff('lowil', ctx)) {
    return {
      file: cmd.file, args: [...cmd.args], cwd: o.cwd, viaLauncher: false,
      env: toolEnv({ ...(o.env ?? process.env), ...(o.extraEnv ?? {}) }, ctx, platform),
    }
  }
  const pairs = new Map<string, string>()
  for (const [k, v] of Object.entries(o.env ?? {})) if (typeof v === 'string' && v !== process.env[k]) pairs.set(k, v)
  for (const [k, v] of Object.entries(o.extraEnv ?? {})) pairs.set(k, v)
  let mode: string[]
  let commandFile: string | undefined
  if (cmd.shell !== undefined) {
    const shell = cmd.shell === true ? '' : cmd.shell
    if (cmd.file.length > LONG_COMMAND_CHARS) {
      commandFile = join(ctx.sandbox.root, `cmd-${process.pid}-${++commandFileSeq}.txt`)
      writeFileSync(commandFile, cmd.file, 'utf-8')
      mode = ['--shell', shell, '--command-file', commandFile]
    } else {
      mode = ['--shell', shell, cmd.file]
    }
  } else {
    mode = ['--exec', cmd.file, ...cmd.args]
  }
  const args = [
    ...launcherHead(),
    '--run-dir', ctx.sandbox.root,
    '--cwd', o.cwd ?? process.cwd(),
    ...[...pairs].flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...mode,
  ]
  const seal = randomBytes(16).toString('hex')
  const out: ContainedSpawn = {
    file: o.execPath ?? process.execPath, args, cwd: engineCheckout(),
    env: { ...process.env, [LAUNCHER_SEAL_ENV]: seal }, viaLauncher: true, seal,
  }
  if (commandFile !== undefined) out.commandFile = commandFile
  return out
}

function runningUnderBun(): boolean {
  return typeof (globalThis as { Bun?: { version?: string } }).Bun?.version === 'string'
}

/** Why the launcher cannot run in this process, or null when it can. */
function launcherUnavailable(bun: boolean): string | null {
  if (!bun) return LAUNCHER_UNAVAILABLE('not Bun')
  const { script, config } = launcherPaths()
  for (const p of [script, config]) if (!existsSync(p)) return LAUNCHER_UNAVAILABLE(`launcher file missing: ${p}`)
  return null
}

function spawnRefusalReason(o: { ctx?: RunContainment | null; required?: boolean; platform?: NodeJS.Platform; bun?: boolean } = {}): string | null {
  const ctx = o.ctx === undefined ? runContainment() : o.ctx
  if (!ctx) return o.required === true ? NO_CONTAINMENT : null
  const sw = containmentSwitch()
  if (sw.unknown.length > 0) return unknownLayerReason(sw.unknown[0])
  if (sw.raw !== null && !ctx.test) return SWITCH_IN_UNATTENDED
  if ((o.platform ?? process.platform) !== 'win32') return null
  if (containmentOff('lowil', ctx)) return null
  const unavailable = launcherUnavailable(o.bun ?? runningUnderBun())
  if (unavailable !== null) return unavailable
  // B1 (wave 19): before the first low child of this process, the installed Git's namespace is held at
  // normal integrity. Only on the real path (no platform or runtime given), so a pure caller starts nothing.
  if (o.platform === undefined && o.bun === undefined) return holdGitNamespace(ctx)
  return null
}

/**
 * Null when a child may be started now; otherwise the complete refusal text the caller returns
 * (`Refused [containment]: ...`). There is no downgrade: on Windows a contained run whose launcher
 * cannot run starts nothing.
 */
export function toolSpawnRefusal(o: { ctx?: RunContainment | null; required?: boolean; platform?: NodeJS.Platform; bun?: boolean } = {}): string | null {
  const reason = spawnRefusalReason(o)
  return reason === null ? null : refusalText('containment', reason)
}

/**
 * Bun's own line when it could not read a module it was asked to load. Measured 2026-11-23 on Bun
 * 1.3.13: a Bun process at low integrity gets it for ANY file in a folder that is not labelled low
 * (a script in the engine's checkout, `C:\Windows\System32\drivers\etc\hosts`), exit 1, before the
 * script has run a line; node and PowerShell at the same level read the same files.
 */
const BUN_LOW_READ = /^error: EPERM reading "([^"\r\n]+)"\s*$/m

/**
 * A launcher exit that means "did not run" (197 with its refused line), "ended with no status"
 * (198 with its line), or a Bun the launcher started that could not load its own script at low
 * integrity (exit 1 with Bun's `error: EPERM reading "<file>"` line; the gate-authoring check is
 * the known case, 01-isolation entry 1.B2 part 2). A 197 or 198 counts only when stderr carries the
 * launcher's seal line for THIS spawn (`seal`, from `containedCommand`): the child shares the
 * launcher's stderr and passes its own status through, so a command that prints the refused line
 * and exits 197 itself is an ordinary exit code (review of slice S5). With no seal no 197 or 198 is
 * a fault. A command that prints Bun's line itself and exits 1 reads as "did not run" for a harness
 * check, never as a pass; `ran` is true for it and for 198, because a process did run, so a tool
 * result built from either carries an exit code and is never read as a refusal made before a spawn.
 */
export function launcherFaultOf(status: number | null | undefined, stderr: string | Buffer | null | undefined, seal: string | undefined)
  : { code: 'ECONTAINMENT' | 'ECHILDGONE'; reason: string; text: string; ran: boolean; exitCode: number | null } | null {
  if (status === 1) {
    const m = BUN_LOW_READ.exec(stderr == null ? '' : String(stderr))
    if (m === null) return null
    const reason = `Bun at low integrity could not read ${m[1]} (EPERM), a file outside the folders the run may write, so the command did not run`
    return {
      code: 'ECONTAINMENT', reason, ran: true, exitCode: 1,
      text: refusalText('containment', reason, 'A Bun script that lives outside the mission folder cannot be run inside a contained run on this Bun; nothing it would have done was done.'),
    }
  }
  if (status !== LAUNCHER_REFUSED_EXIT && status !== LAUNCHER_CHILD_GONE_EXIT) return null
  if (typeof seal !== 'string' || seal.length < 16) return null
  const lines = (stderr == null ? '' : String(stderr)).split(/\r?\n/)
  const sealAt = lines.lastIndexOf(`${LAUNCHER_SEAL_PREFIX}${seal} ${status}`)
  if (sealAt < 0) return null
  const before = lines.slice(0, sealAt).reverse()
  if (status === LAUNCHER_REFUSED_EXIT) {
    const line = before.find(l => l.startsWith('[containment] refused: '))
    if (line === undefined) return null
    const reason = line.slice('[containment] refused: '.length).trim()
    return { code: 'ECONTAINMENT', reason, text: refusalText('containment', reason), ran: false, exitCode: null }
  }
  const line = before.find(l => l.startsWith('[containment] child ended: '))
  if (line === undefined) return null
  const reason = `the contained command ended without an exit status (${line.slice('[containment] child ended: '.length).trim()})`
  return {
    code: 'ECHILDGONE', reason, ran: true, exitCode: null,
    text: refusalText('containment', reason, 'It started and then ended without an exit status, so its result is unknown: check what it changed before running it again.'),
  }
}

function removeCommandFile(p: string | undefined): void {
  if (p === undefined) return
  try {
    unlinkSync(p)
  } catch (e) {
    console.log(`[containment] the command file ${p} could not be removed: ${(e as Error).message}`)
  }
}

function refuseBeforeSpawn(ctx: RunContainment | null): void {
  const reason = spawnRefusalReason({ ctx })
  if (reason !== null) throw new ContainmentRefusal('ECONTAINMENT', reason, refusalText('containment', reason))
}

/**
 * `exec` with the shared environment and, in a contained run on Windows, the launcher. The same
 * callback, error fields, encoding and `maxBuffer` as `exec`; the returned child is the one whose
 * pid the caller owns (the launcher's, when there is one). Throws `ContainmentRefusal` when
 * `toolSpawnRefusal` is non-null: callers ask first, the throw is the backstop.
 */
export function toolExec(command: string, options: {
  cwd?: string; shell?: string; encoding: 'utf-8'; timeout?: number; maxBuffer?: number
  windowsHide?: boolean; env?: Record<string, string | undefined>
}, callback: (err: ExecException | null, stdout: string, stderr: string) => void,
ctx: RunContainment | null = runContainment()): ChildProcess {
  refuseBeforeSpawn(ctx)
  const c = containedCommand({ file: command, args: [], shell: options.shell ?? true }, { ctx, cwd: options.cwd, env: options.env })
  if (!c.viaLauncher) return exec(command, { ...options, cwd: c.cwd, env: c.env }, callback)
  const { shell: _shell, ...rest } = options
  return execFile(c.file, c.args, { ...rest, cwd: c.cwd, env: c.env }, (err, stdout, stderr) => {
    removeCommandFile(c.commandFile)
    const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
    const fault = err ? launcherFaultOf(code, stderr, c.seal) : null
    if (fault) {
      callback(new ContainmentRefusal(fault.code, fault.reason, fault.text, fault.ran, fault.exitCode) as unknown as ExecException, stdout, stderr)
      return
    }
    // execFile's error carries the same fields exec's does (code, killed, signal, cmd).
    callback(err as ExecException | null, stdout, stderr)
  })
}

/** `execSync` over the same answer as `toolExec`; a launcher fault throws `ContainmentRefusal`. */
export function toolExecSync(command: string, options: ExecSyncOptions = {}, ctx: RunContainment | null = runContainment()): string | Buffer {
  refuseBeforeSpawn(ctx)
  const c = containedCommand({ file: command, args: [], shell: options.shell ?? true }, {
    ctx, cwd: typeof options.cwd === 'string' ? options.cwd : options.cwd?.toString(),
    env: options.env as Record<string, string | undefined> | undefined,
  })
  if (!c.viaLauncher) return execSync(command, { ...options, cwd: c.cwd, env: c.env })
  const { shell: _shell, ...rest } = options
  try {
    return execFileSync(c.file, c.args, { ...rest, cwd: c.cwd, env: c.env })
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string | Buffer | null }
    const fault = launcherFaultOf(err.status, err.stderr, c.seal)
    if (fault) throw new ContainmentRefusal(fault.code, fault.reason, fault.text, fault.ran, fault.exitCode)
    throw e
  } finally {
    removeCommandFile(c.commandFile)
  }
}

const MSYS_SIGNATURE = /NtCreateDirectoryObject\(\\BaseNamedObjects\\msys-/

/** What a contained command's output is followed by, so a failure the containment caused says so. Pure. */
export function containmentHint(kind: 'failure' | 'success' | 'timeout', output: string,
  ctx: RunContainment | null = runContainment(), platform: NodeJS.Platform = process.platform): string {
  if (!ctx || platform !== 'win32') return ''
  if (kind === 'timeout') {
    return '\n[containment] This run may write only in its mission folder and in $env:CYNCO_SCRATCH. A Python program that asks for a temporary file or folder anywhere else can spin until the timeout instead of failing; pytest does that from a folder it may not write unless it is run with -p no:cacheprovider.'
  }
  if (MSYS_SIGNATURE.test(output)) {
    // B1 (wave 19), PLAN step 4: with the switch on, the copy first on PATH answers a bare name; what
    // still fails is a program of Git's started by its full path, or a copy that something runs at
    // normal privilege (measured: then every low start of it fails).
    if (ctx.msysRuntime) return `\n[containment] ${MSYS_WITH_COPY(ctx.msysRuntime)}`
    // P2-F5: the PATH is not reordered, so a Windows program that shares a name with one of Git's
    // resolves to Git's copy in a dispatched mission; its full path is the way round.
    const sys32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32`
    return `\n[containment] ${MSYS_IN_CONTAINED_RUN}. Use the PowerShell form instead (Select-String, Select-Object -First / -Last, Get-Content -Tail, Get-ChildItem). A git hook written as a shell script fails the same way. In a dispatched mission Git's Unix folder comes first on the PATH, so a Windows program that shares a name with one of Git's (whoami, find, sort, timeout, hostname, as in a cmd line) starts Git's copy and fails the same way: name the Windows one by its full path, for example ${sys32}\\whoami.exe or ${sys32}\\find.exe.`
  }
  const bun = kind === 'failure' ? BUN_LOW_READ.exec(output) : null
  if (bun !== null) {
    return `\n[containment] Bun at low integrity could not load ${bun[1]} (EPERM): a Bun script outside the folders this run may write cannot be run inside a contained run on this Bun. The shell itself ran, so whatever the command did before that line was done.`
  }
  return ''
}

// ─── Run ids, integrity level, volumes ───────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `<label>-<YYYYMMDD>T<HHMMSS>-<4 hex>` in local time; always matches RUN_ID_RE. */
export function mintRunId(label: string, now: Date = new Date()): string {
  let safe = String(label ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40)
  if (safe === '') safe = 'run'
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${safe}-${stamp}-${randomBytes(2).toString('hex')}`
}

function sys(exe: string): string {
  return join(process.env.SystemRoot || 'C:/Windows', 'System32', exe)
}

/**
 * The working folder of the system programs this module starts (icacls, whoami, Windows PowerShell;
 * P2-B10): on Windows System32, which a process of this user cannot write, never the checkout. Every
 * path such a child is handed is absolute; what a child writes relative to its working folder
 * (Windows PowerShell's module analysis cache when it was handed a relative USERPROFILE, measured)
 * then lands nowhere instead of in the repository. Elsewhere the checkout, as before. The launcher's
 * probe (this runtime itself) still starts in the checkout, where it has always been started.
 */
export function harnessChildCwd(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32') : engineCheckout()
}

/** One synchronous child, never through a shell, in `harnessChildCwd()` (the probe: the checkout). A timeout says ETIMEDOUT in `out`. */
function runOnce(file: string, args: string[], capMs: number): { ok: boolean; out: string; code: number | null } {
  const cwd = file === process.execPath ? engineCheckout() : harnessChildCwd()
  const r = spawnSync(file, args, { cwd, windowsHide: true, timeout: capMs, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code ?? r.error.message
    return { ok: false, out: `${out}${out && !out.endsWith('\n') ? '\n' : ''}${code}`, code: r.status ?? null }
  }
  return { ok: r.status === 0, out, code: r.status ?? null }
}

/**
 * Every synchronous child of this module goes through here. bun's stale spawn deadline (F155)
 * can end a call with ETIMEDOUT long before its cap: a timeout that arrived before half the cap
 * had passed is retried once, and said out loud.
 */
function runVia(runner: ContainmentRunner | undefined, file: string, args: string[], capMs: number) {
  const r = runner ?? runOnce
  const t0 = Date.now()
  const first = r(file, args, capMs)
  const ms = Date.now() - t0
  if (!first.ok && first.code === null && /ETIMEDOUT/.test(first.out) && ms < capMs / 2) {
    console.log(`[containment] ${file}: an impossible ETIMEDOUT after ${ms} ms; retried once (F155)`)
    return r(file, args, capMs)
  }
  return first
}

function lastLine(out: string): string {
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  return lines.length ? lines[lines.length - 1] : '(no output)'
}

function levelFromGroups(out: string): 'low' | 'medium' | 'high' | 'unknown' {
  const m = /S-1-16-(\d+)/.exec(out)
  if (!m) return 'unknown'
  const rid = Number(m[1])
  if (rid <= 0x1000) return 'low'
  if (rid < 0x3000) return 'medium'
  return 'high'
}

function readIntegrityLevel(runner?: ContainmentRunner): 'low' | 'medium' | 'high' | 'unknown' {
  const r = runVia(runner, sys('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], 10_000)
  if (!r.ok) {
    console.log(`[containment] the integrity level of this process could not be read (${lastLine(r.out)})`)
    return 'unknown'
  }
  return levelFromGroups(r.out)
}

let ownLevelCache: 'low' | 'medium' | 'high' | 'unknown' | null = null

/** This process's integrity level, read from its own token (never from a variable); cached. */
export function ownIntegrityLevel(): 'low' | 'medium' | 'high' | 'unknown' {
  if (process.platform !== 'win32') return 'medium'
  if (ownLevelCache === null) ownLevelCache = readIntegrityLevel()
  return ownLevelCache
}

let sidCache: string | null = null

function userSid(runner?: ContainmentRunner): { sid: string } | { error: string } {
  if (!runner && sidCache !== null) return { sid: sidCache }
  const r = runVia(runner, sys('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], 10_000)
  const m = /"(S-1-[\d-]+)"/.exec(r.out)
  if (!r.ok || !m) return { error: `the user SID could not be read: ${lastLine(r.out)}` }
  if (!runner) sidCache = m[1]
  return { sid: m[1] }
}

/**
 * Every attached volume that integrity labels cannot protect: a removable or network volume with a
 * file system, or a local volume whose file system is not NTFS. `[]` off Windows. One read-only
 * query; it reads nothing on the volumes themselves. Throws when the listing fails, or when a line
 * that starts as a volume line cannot be read, because an unknown answer is never "no such volume".
 * `serial` is the volume's `VolumeSerialNumber` as Windows prints it (hex), or null when Windows
 * gave none (a network drive often has none) or anything that is not hex (the volume is listed all
 * the same), so a caller can tell another volume mounted at the same letter from the one it saw before.
 */
export function listUnprotectedVolumes(o: { platform?: NodeJS.Platform; run?: ContainmentRunner } = {})
  : Array<{ root: string; fileSystem: string; kind: 'local' | 'removable' | 'network'; serial: string | null }> {
  if ((o.platform ?? process.platform) !== 'win32') return []
  const script = 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.DriveType)|$($_.FileSystem)|$($_.VolumeSerialNumber)" }'
  const r = runVia(o.run, sys('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], 20_000)
  if (!r.ok) throw new Error(`the attached volumes could not be listed (${lastLine(r.out)})`)
  const out: Array<{ root: string; fileSystem: string; kind: 'local' | 'removable' | 'network'; serial: string | null }> = []
  for (const line of r.out.split(/\r?\n/)) {
    // Everything after the third bar is the serial, whatever it holds (P2-F3: a serial that is not
    // hex must not drop its volume from the listing, which is what the refusals read). A line that
    // starts as a volume line and cannot be read fails the listing instead of being passed over.
    const m = /^\s*([A-Za-z]:)\|(\d+)\|([^|]*?)\s*(?:\|(.*))?$/.exec(line)
    if (!m) {
      if (/^\s*[A-Za-z]:\|/.test(line)) throw new Error(`the attached volumes could not be listed (a line of the listing could not be read: ${line.trim()})`)
      continue
    }
    const type = Number(m[2])
    const fs = m[3]
    const root = `${m[1].toUpperCase()}\\`
    const s = (m[4] ?? '').trim()
    const serial = /^[0-9A-Fa-f]+$/.test(s) ? s.toUpperCase() : null
    if ((type === 2 || type === 4) && fs !== '') out.push({ root, fileSystem: fs, kind: type === 2 ? 'removable' : 'network', serial })
    else if (type === 3 && fs !== '' && fs.toUpperCase() !== 'NTFS') out.push({ root, fileSystem: fs, kind: 'local', serial })
  }
  return out
}

/** The ONE read of `LOCALCODE_UNPROTECTED_VOLUMES_OK`: volume roots as `X:\`; anything else as written. */
export function acknowledgedVolumes(env: Record<string, string | undefined> = process.env): string[] {
  const v = env.LOCALCODE_UNPROTECTED_VOLUMES_OK
  if (typeof v !== 'string') return []
  const out: string[] = []
  for (const raw of v.split(';').map(s => s.trim()).filter(s => s !== '')) {
    const m = /^([A-Za-z]):?[\\/]?$/.exec(raw)
    const entry = m ? `${m[1].toUpperCase()}:\\` : raw
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

// ─── Paths ───────────────────────────────────────────────────────────────────────────────────

function real(p: string): string {
  return realPathOf(p, { quiet: true })
}

function samePath(a: string, b: string): boolean {
  const ra = real(a), rb = real(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/** `child` is `parent` or beneath it, on real paths. */
function within(parent: string, child: string): boolean {
  return isInside(real(parent), real(child))
}

function isVolumeRoot(p: string): boolean {
  return dirname(p) === p
}

function volumeOf(p: string): string | null {
  const m = /^([A-Za-z]):/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\` : null
}

function isUnc(p: string): boolean {
  return /^(\\\\|\/\/)/.test(p)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[containment] ${p} could not be read: ${(e as Error).message}`)
    return false
  }
}

function processStartedAt(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Is this record's holder gone? A holder is gone when its pid is not running; a record with no
 * holder is held for 15 minutes after it was created (the starter has handed it to an engine by then).
 * The one answer the sweep, an establish's step 1 and `cynco-sandbox.mjs release-dead` act on.
 */
export function holderGone(rec: ContainmentRecord, nowMs: number = Date.now()): boolean {
  if (rec.holder) return !pidAlive(rec.holder.pid)
  return nowMs - Date.parse(rec.createdAt) > HOLDERLESS_GRACE_MS
}

// ─── Records ─────────────────────────────────────────────────────────────────────────────────

const RECORD = 'containment.json'

/**
 * R1 (wave 19b): the pid of another live process that is releasing this record (its release has not
 * ended), else null. This process's own pid is never one: a release is synchronous, so in this process
 * it has ended (or thrown) by the time anything reads the record. `cynco-sandbox.mjs status` and
 * `restore-acl` ask it.
 */
export function releaseInProgress(rec: Pick<ContainmentRecord, 'releasing'>): number | null {
  const pid = rec.releasing?.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  return pidAlive(pid) ? pid : null
}

/** The command that puts back a grant a release kept (P2-B4; scripts/cynco-sandbox.mjs). */
const RESTORE_ACL_COMMAND = (runId: string) => `bun scripts/cynco-sandbox.mjs restore-acl ${runId}`

function readRecord(path: string): { ok: true; rec: ContainmentRecord } | { ok: false; error: string } {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf-8')) as ContainmentRecord
    if (rec === null || typeof rec !== 'object') return { ok: false, error: 'not a JSON object' }
    return { ok: true, rec }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** A temporary file and a rename, so a reader never sees half a record. Null, or why it failed. */
function writeRecord(path: string, rec: ContainmentRecord): string | null {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
    return null
  } catch (e) {
    console.log(`[containment] the record ${path} could not be written: ${(e as Error).message}`)
    return (e as Error).message
  }
}

function markReleased(path: string, rec: ContainmentRecord, by: NonNullable<ContainmentRecord['releasedBy']>, now: Date): string | null {
  rec.releasedAt = now.toISOString()
  rec.releasedBy = by
  return writeRecord(path, rec)
}

function namedFolders(rec: ContainmentRecord): string[] {
  return [rec.missionCwd, ...(rec.extraRoots ?? [])]
}

function labelledFolders(rec: ContainmentRecord): string[] {
  return rec.cwdLabel === 'low' ? namedFolders(rec) : []
}

/**
 * Every parseable record of a direct child of the root whose folder name is a run id and equals
 * the record's own run id, oldest first. A link is never followed: the root's listing must call
 * the child a folder (see `listEntries`). An unreadable root gives [].
 */
export function containmentRecords(o: { sandboxRoot?: string } = {}): ContainmentRecord[] {
  const root = o.sandboxRoot ?? sandboxRoot()
  let entries: Array<{ name: string; kind: string }>
  try {
    entries = listEntries(root)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.log(`[containment] the sandbox root ${root} could not be listed: ${(e as Error).message}`)
    return []
  }
  const out: ContainmentRecord[] = []
  for (const { name, kind } of entries) {
    if (!RUN_ID_RE.test(name) || kind !== 'dir') continue
    const dir = join(root, name)
    const r = readRecord(join(dir, RECORD))
    if (!r.ok) continue
    if (r.rec.schema !== 1 || r.rec.runId !== name) continue
    out.push(r.rec)
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** Another record (not `exceptId`) that labels `folder`, is not released and whose holder is not gone. */
function activeHolderOf(root: string, folder: string, exceptId: string, nowMs: number): ContainmentRecord | null {
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    if (rec.runId === exceptId || rec.releasedAt) continue
    if (!labelledFolders(rec).some(f => samePath(f, folder))) continue
    if (!holderGone(rec, nowMs)) return rec
  }
  return null
}

function sandboxOf(runDir: string): RunContainment['sandbox'] {
  return { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }
}

function contextOf(rec: ContainmentRecord, runDir: string, isolation: 'verified' | 'overlay'): RunContainment {
  return frozen({
    runId: rec.runId, kind: rec.kind, test: rec.test === true,
    missionCwd: rec.missionCwd, cwdLabel: rec.cwdLabel, extraRoots: [...(rec.extraRoots ?? [])],
    sandbox: sandboxOf(runDir), home: rec.home, folders: { ...rec.folders },
    unprotectedVolumes: [...(rec.unprotectedVolumes ?? [])], isolation,
    // B1: from the record alone, never from this process's environment.
    msysRuntime: typeof rec.msysRuntime === 'string' && rec.msysRuntime !== '' ? rec.msysRuntime : null,
  })
}

/**
 * The context a run folder's record describes, with no probe and no holder written: what
 * `adoptContainment` builds on, and what the launcher reads before it lowers its token.
 */
export function containmentFromRecord(runDir: string)
  : { ok: true; containment: RunContainment; record: ContainmentRecord } | { ok: false; reason: string; unread?: string } {
  const path = join(runDir, RECORD)
  const r = readRecord(path)
  if (!r.ok) return { ok: false, reason: `the containment record ${path} could not be read (${r.error})`, unread: r.error }
  if (r.rec.schema !== 1) return { ok: false, reason: `the containment record ${path} is not a version this engine reads (schema ${String(r.rec.schema)})` }
  return { ok: true, containment: contextOf(r.rec, runDir, 'overlay'), record: r.rec }
}

// ─── Labels ──────────────────────────────────────────────────────────────────────────────────

function setLabel(runner: ContainmentRunner | undefined, dir: string, level: 'L' | 'M') {
  return runVia(runner, sys('icacls.exe'), [dir, '/setintegritylevel', `(OI)(CI)${level}`], 30_000)
}

/**
 * The cap of a call that writes a folder's access list (the grant, the restore): Windows then
 * rewrites what every entry under the folder inherited. Measured 2026-11-24 on a scratch tree of
 * 100,100 entries: the grant 6.6 s, the restore 6.7 s; rule M bounds a work folder at 200,000.
 */
const ACL_WRITE_CAP_MS = 120_000

function grantFull(runner: ContainmentRunner | undefined, dir: string, sid: string) {
  return runVia(runner, sys('icacls.exe'), [dir, '/grant', `*${sid}:(OI)(CI)F`], ACL_WRITE_CAP_MS)
}

/** The probe's own file names: `probe-<pid>.tmp` in the sandbox, the dotted form in a folder the run works in. */
const SANDBOX_PROBE_FILE = /^probe-\d+\.tmp$/
const WORK_FOLDER_PROBE_FILE = /^\.cynco-containment-probe-\d+\.tmp$/

/** Remove the probe's own leftovers at the top of `dir`: only names matching `pattern`, nothing else. */
function removeProbeLeftovers(dir: string, pattern: RegExp): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    console.log(`[containment] ${dir} could not be listed for probe leftovers: ${(e as Error).message}`)
    return
  }
  for (const n of names) {
    if (!pattern.test(n)) continue
    try {
      unlinkSync(join(dir, n))
    } catch (e) {
      console.log(`[containment] the probe leftover ${join(dir, n)} could not be removed: ${(e as Error).message}`)
    }
  }
}

/**
 * The probe (Windows): the launcher lowers itself and tries one create that must fail (the run
 * folder, medium) and one per folder that must succeed (the sandbox tmp and each labelled folder).
 * Null when it passed; otherwise the reason.
 */
function probe(runner: ContainmentRunner | undefined, runDir: string, labelled: Array<{ path: string; word: string }>): string | null {
  const sb = sandboxOf(runDir)
  const mustFail = join(runDir, `probe-${process.pid}.tmp`)
  const mustSucceed = [join(sb.tmp, `probe-${process.pid}.tmp`), ...labelled.map(f => join(f.path, `.cynco-containment-probe-${process.pid}.tmp`))]
  // The sandbox tmp folder and the run folder hold `probe-<pid>.tmp`; a folder the run works in
  // only ever the dotted name, so a `probe-1.tmp` of the owner's in the repository is never touched.
  const tops: Array<[string, RegExp]> = [[sb.tmp, SANDBOX_PROBE_FILE], [runDir, SANDBOX_PROBE_FILE], ...labelled.map(f => [f.path, WORK_FOLDER_PROBE_FILE] as [string, RegExp])]
  for (const [d, pattern] of tops) removeProbeLeftovers(d, pattern)
  const r = runVia(runner, process.execPath, [...launcherHead(), '--run-dir', runDir, '--probe', mustFail, ...mustSucceed], 20_000)
  for (const [d, pattern] of tops) removeProbeLeftovers(d, pattern)
  const refused = r.out.split(/\r?\n/).find(l => l.startsWith('[containment] refused: '))
  let answer: { outside?: string; inside?: string[] } | null = null
  for (const line of r.out.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      answer = JSON.parse(t) as { outside?: string; inside?: string[] }
      break
    } catch (e) {
      console.log(`[containment] the probe printed a line that is not JSON (${(e as Error).message})`)
    }
  }
  if (r.code === LAUNCHER_REFUSED_EXIT || answer === null) {
    const own = refused ? refused.slice('[containment] refused: '.length).trim() : 'the probe printed nothing'
    return own.startsWith('the low-integrity launcher is unavailable') ? own : LAUNCHER_UNAVAILABLE(own)
  }
  if (answer.outside === 'created') return `the sandbox root ${dirname(runDir)} gives no protection: a low-integrity process created a file in ${runDir}`
  // Only a denial proves the boundary; EEXIST, ENOENT or no answer measured nothing.
  if (answer.outside !== 'EPERM' && answer.outside !== 'EACCES') return `the probe could not show that ${runDir} is closed to a low-integrity process (its create there answered ${answer.outside ?? 'nothing'}, not a denial)`
  const inside = answer.inside ?? []
  if (inside[0] !== 'created') return `the sandbox ${sb.tmp} is not writable at low integrity (${inside[0] ?? 'no answer'})`
  for (let i = 0; i < labelled.length; i++) {
    const code = inside[i + 1]
    if (code !== 'created') return `${labelled[i].word} ${labelled[i].path} is not writable at low integrity (${code ?? 'no answer'}); its label was not set or has been removed`
  }
  return null
}

// ─── establishContainment ────────────────────────────────────────────────────────────────────

/** The establish's read of inheritance (P2-F6) is ended after this long; the folder is then `unread`. */
const INHERITANCE_READ_CAP_MS = 300_000

/**
 * A name Windows keeps for a device (wave 15c, measured 2026-11-24): `icacls <dir>\nul` and .NET's
 * `GetAccessControl` read the NUL device's descriptor (an explicit Low label, no inherited entry), not
 * the file of that name a listing shows; through `\\?\<path>` they read the file. The owner's
 * checkout holds one such file (a worktree's `nul`).
 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * C3 (wave 19), measured 2026-11-25: Win32 drops a trailing dot or space from a name, so icacls and
 * .NET handed `<dir>\foo.` read and reset the owner's `foo`, and `<dir>\x.\*` lists the owner's `x`;
 * through `\\?\` they act on `foo.` itself (a label set and a reset with it succeed where the run has
 * the rights, as in the sandbox and a granted folder). Node and Bun act on the name as written.
 */
const NAME_WINDOWS_READS_AS_ANOTHER = /[. ]$/

/** The path icacls is given for an entry: its `\\?\` form when its name is a device's, or ends in a dot or a space. */
function asEntry(path: string, name: string): string {
  return RESERVED_DEVICE_NAME.test(name) || NAME_WINDOWS_READS_AS_ANOTHER.test(name) ? `\\\\?\\${path}` : path
}
const INHERITANCE_READ_DONE = 'cynco-inheritance-read|'

/**
 * P2-F6: the entries under `folder` that already have inheritance turned off (the access list is
 * protected, or it lists entries and none is inherited: the release's own test, `inheritanceOffOf`),
 * that are links (a link's own access list is not asked, and a link is never entered), or whose
 * access list cannot be read: written to `listFile`, one path per line. One Windows PowerShell walk
 * (measured 2026-11-24: 5,292 entries in 0.85 s, 126,400 in 14.6 s); it reads, and changes nothing.
 * `unread` when the walk did not finish: then the release resets nothing under the folder. An entry
 * whose name is a device's or ends in a dot or a space is asked through its `\\?\` form (C3, wave
 * 19), and such a folder is listed as unread and not entered (`<it>\*` would list another folder).
 * Exported for its test.
 */
export function readInheritanceOff(runner: ContainmentRunner | undefined, folder: string, listFile: string): { listFile: string; count: number } | { unread: string } {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$secAccess = [System.Security.AccessControl.AccessControlSections]::Access',
    '$sidType = [System.Security.Principal.SecurityIdentifier]',
    '$stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]',
    `$stack.Push((New-Object System.IO.DirectoryInfo ${q(folder)}))`,
    '$n = 0',
    // PowerShell variables are not case-sensitive: every name below is distinct without case.
    'while ($stack.Count -gt 0) { $d = $stack.Pop(); foreach ($e in $d.EnumerateFileSystemInfos()) { $n++; $f = $e.FullName; $attr = $e.Attributes; '
      + 'if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { "link|$f"; continue }; $isDir = [bool]($attr -band [System.IO.FileAttributes]::Directory); '
      // Wave 15c: a name Windows keeps for a device (nul, con, com1...) is asked through its \\?\ form,
      // or the device's own access list is read instead of the entry's. C3 (wave 19): so is a name that
      // ends in a dot or a space, or `foo.` is read as `foo`; such a folder is not entered (its `\*`
      // lists another folder), and is listed as unread so the release leaves it as it is.
      + `$p = $f; $odd = $e.Name -match '${NAME_WINDOWS_READS_AS_ANOTHER.source}'; if ($odd -or $e.Name -match '${RESERVED_DEVICE_NAME.source}') { $p = '\\\\?\\' + $f }; `
      + 'if ($odd -and $isDir) { "unread|$f"; continue }; '
      + 'try { if ($isDir) { $acl = [System.IO.Directory]::GetAccessControl($p, $secAccess) } else { $acl = [System.IO.File]::GetAccessControl($p, $secAccess) } } catch { "unread|$f"; if ($isDir) { $stack.Push($e) }; continue }; '
      + 'if ($isDir) { $stack.Push($e) }; if ($acl.AreAccessRulesProtected) { "off|$f"; continue }; '
      + '$r = $acl.GetAccessRules($true, $true, $sidType); if ($r.Count -gt 0) { $inh = $false; foreach ($x in $r) { if ($x.IsInherited) { $inh = $true; break } }; if (-not $inh) { "off|$f" } } } }',
    `"${INHERITANCE_READ_DONE}$n"`,
  ].join('; ')
  const r = runVia(runner, sys('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], INHERITANCE_READ_CAP_MS)
  const lines = r.out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  // P2-B5: what happened to the read first, then its last line (after a cut, that line is a path the
  // walk had reached, not the cause).
  if (!r.ok) return { unread: `the read failed or was cut at its cap of ${INHERITANCE_READ_CAP_MS / 1000} s; its last line: ${lastLine(r.out)}` }
  if (!lines.some(l => l.startsWith(INHERITANCE_READ_DONE))) return { unread: `the read did not say it finished; its last line: ${lastLine(r.out)}` }
  const kept = lines.filter(l => /^(off|link|unread)\|/.test(l)).map(l => l.slice(l.indexOf('|') + 1))
  try {
    writeFileSync(listFile, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8')
  } catch (e) {
    return { unread: `the list could not be written to ${listFile} (${(e as Error).message})` }
  }
  return { listFile, count: kept.length }
}

function defaultFolders(): RunContainment['folders'] {
  return { state: cyncoHome(), models: modelsDir(), guard: guardDir(), audit: auditDir() }
}

/** Rules M1 to M9 for one folder; null when it may be a write root of the run. */
function folderRefusal(input: string, word: string, o: {
  kind: ContainmentKind; checkout: string; home: string; folders: RunContainment['folders']; sandboxRoot: string
  unprotected: string[]; checkGit: boolean; checkHardLinks: boolean; isFolder: (p: string) => boolean; platform: NodeJS.Platform
}): string | null {
  if (!o.isFolder(input)) return `${word} ${input} does not exist or is not a folder`
  const p = real(input)
  // C3 (wave 19): icacls would be handed this folder's path, and Win32 reads it as another folder's.
  // R5 (wave 19b): Windows' name rule, for an establish on Windows only; elsewhere such a name is an ordinary one.
  const oddPart = o.platform !== 'win32' ? undefined : p.split(/[\\/]/).find(s => s !== '.' && s !== '..' && NAME_WINDOWS_READS_AS_ANOTHER.test(s))
  if (oddPart !== undefined) return `${word} ${p} has a part of its path whose name Windows reads as another folder (${oddPart}: it ends in a dot or a space)`
  if (within(o.checkout, p) || within(p, o.checkout)) return `${word} ${p} is, contains or is inside the checkout this engine runs from (${o.checkout})`
  if (within(p, o.home)) return `${word} ${p} is the home folder ${o.home} or contains it`
  if (isVolumeRoot(p)) return `${word} ${p} is a volume root`
  const vol = volumeOf(p)
  if (isUnc(input) || isUnc(p) || (vol !== null && o.unprotected.includes(vol))) return `${word} ${p} is on a network share or on a volume without integrity labels`
  const authoring = join(o.folders.state, 'authoring')
  const inAuthoring = within(authoring, p) && !samePath(authoring, p)
  const protectedList: Array<[string | null, string]> = [
    [o.folders.guard, 'the guard folder'], [o.folders.audit, 'the audit folder'], [o.folders.models, 'the models folder'],
    [o.sandboxRoot, 'the sandbox root'], [o.folders.state, "CynCo's state folder"],
  ]
  for (const [path, name] of protectedList) {
    if (path === null || !isAbsolute(path)) continue
    if (name === "CynCo's state folder" && inAuthoring) continue
    if (within(path, p) || within(p, path)) return `${word} ${p} is, contains or is inside ${path} (${name})`
  }
  const realHome = real(o.home)
  if (isInside(realHome, p) && !inAuthoring) {
    const first = relative(realHome, p).split(/[\\/]/)[0]
    if (first.startsWith('.')) return `${word} ${p} is inside ${join(o.home, first)}, a dot-folder of the home folder`
  }
  const linkOut = linkLeadingOut(p, RULE_M_MAX_ENTRIES, o.platform)
  if (linkOut && 'why' in linkOut) return `${word} ${p} ${linkOut.why}`
  if (linkOut) return `${word} ${p} holds a link that leads outside it (${linkOut.link} -> ${linkOut.target})`
  if (o.checkGit) {
    const git = join(p, '.git')
    let why: string | null = null
    try {
      // The folder's listing first: lstat calls a junction a low process made a folder (F4).
      const st = lstatSync(git)
      if (isLinkEntry(git) === true) why = '.git is a link'
      else if (!st.isDirectory()) why = '.git is a file: a worktree or a submodule'
      else if (!existsSync(join(git, 'HEAD'))) why = '.git holds no HEAD'
    } catch (e) {
      why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? '.git is missing' : `.git could not be read: ${(e as Error).message}`
    }
    if (why) return `${word} ${p} is not the top of its own git repository (${why}); a mission works in a clone made with git clone --no-hardlinks, not in a worktree or a subfolder`
  }
  if (o.checkHardLinks) {
    const hard = fileWithOtherNames(p)
    if (hard?.hardLink) return `${word} ${p} ${hard.why}; a low label set on such a file reaches every other name of it, so the folder is not labelled: work in a clone made with git clone --no-hardlinks`
    if (hard) return `${word} ${p} ${hard.why}; the folder is not labelled`
  }
  return null
}

/**
 * Does a walk enter the entry `e` (at `p`) of the folder whose native real path is `parentReal`?
 * Only a folder that is where its path says (`whyNotAtOwnPath`). That is what the listing calls a
 * folder, and also what it calls a link when the link is not a redirect: a folder carrying a
 * reparse tag that resolves to its own path (a ProjFS placeholder of VFS for Git or Scalar, say; none
 * was found on this PC, where OneDrive's placeholders are not listed as links), which stat calls a
 * folder. A link that resolves elsewhere, or not at all, is never entered and `why` is null: not
 * entering it is the rule, not a fault. A folder the listing calls a folder that is not where its
 * path says is not entered either, and `why` says why (a swap after the listing, or a reparse kind
 * the listing does not flag).
 */
function entryToEnter(parentReal: string, e: { name: string; kind: EntryKind }, p: string): { enter: boolean; why: string | null } {
  if (e.kind === 'file') return { enter: false, why: null }
  const why = whyNotAtOwnPath(parentReal, e.name)
  if (e.kind === 'dir') return { enter: why === null, why }
  if (why !== null) return { enter: false, why: null }
  try {
    return { enter: statSync(p).isDirectory(), why: null }
  } catch (err) {
    return { enter: false, why: `could not be read (${(err as Error).message})` }
  }
}

/**
 * Why `dir` may not be labelled because of a hard link: the first regular file under it with more
 * than one name, or a folder or entry under it that could not be read (so the answer is unknown);
 * `hardLink` is false when the reason is a folder that is not where its path says, for which the
 * advice about clones does not fit. Null when the whole tree was read and no file has a second name.
 * Walks every level, entering only a folder at its own real path (`entryToEnter`). An entry's kind
 * comes from its folder's listing (`listEntries`), never from lstat, which calls a junction a
 * low-integrity process made a folder and follows it (F4). Every entry that is not entered is asked
 * with lstat, which enters nothing: a link to a folder reads as a folder or a link and is not
 * counted; a file carrying a reparse tag, which the listing calls a link, answers EACCES (measured
 * 2026-11-24) and is refused as unreadable, so a second name on such a file is not missed.
 */
function fileWithOtherNames(dir: string): { why: string; hardLink: boolean } | null {
  let top: string
  try {
    top = realpathSync.native(dir)
  } catch (e) {
    return { why: `holds a folder that could not be read for hard links (${dir}: ${(e as Error).message})`, hardLink: true }
  }
  const pending = [{ path: dir, real: top }]
  while (pending.length > 0) {
    const d = pending.pop()!
    let entries: Array<{ name: string; kind: EntryKind }>
    try {
      entries = listEntries(d.path)
    } catch (e) {
      return { why: `holds a folder that could not be read for hard links (${d.path}: ${(e as Error).message})`, hardLink: true }
    }
    for (const e of entries) {
      const p = join(d.path, e.name)
      const to = entryToEnter(d.real, e, p)
      if (to.enter) {
        pending.push({ path: p, real: join(d.real, e.name) })
        continue
      }
      if (e.kind === 'dir') {
        return { why: `holds a folder that is not where its path says (${p} ${to.why}), so whether a file under it has another name cannot be told`, hardLink: false }
      }
      let st
      try {
        st = lstatSync(p)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        return { why: `holds an entry that could not be read for hard links (${p}: ${(err as Error).message})`, hardLink: true }
      }
      if (st.isFile() && st.nlink > 1) return { why: `holds a file with more than one name (${p} has ${st.nlink})`, hardLink: true }
    }
  }
  return null
}

/** Rule M walks at most this many entries of a folder before it refuses it (NOW.md:84). */
export const RULE_M_MAX_ENTRIES = 200_000

/**
 * Rule M: a link anywhere under `dir` whose target is outside it (`link`), or why that could not be
 * told (`why`), or null. The whole tree is walked (NOW.md:84: a junction deeper than the top two
 * levels, which this walk used to stop at, was followed by a later `Remove-Item .\*`), entering only
 * a folder at its own real path (`entryToEnter`), so no link is ever entered. Every entry it does
 * not enter (a symbolic link, a junction of either form (F4), a folder not at its own real path) is
 * judged where `realpathSync.native` says it lands; a link that lands inside the folder (what npm or
 * pnpm make between workspace packages) is not reported. One whose target cannot be resolved is
 * refused (NOW.md:77: a low-made junction whose target is gone resolves to its own path by every
 * other means, and leads out again once its target is made again; an ordinary dangling link is
 * refused with it). So is a folder it cannot list (it used to be passed, with a log line) and a tree
 * of more than `maxEntries` entries. On Windows (`platform`, default this host's) an entry whose name
 * ends in a dot or a space is refused by name too (C3); elsewhere it is an ordinary name (R5, wave 19b).
 * Exported for its tests and its measurement.
 */
export function linkLeadingOut(dir: string, maxEntries: number = RULE_M_MAX_ENTRIES, platform: NodeJS.Platform = process.platform): { link: string; target: string } | { why: string } | null {
  let dirReal: string
  try {
    dirReal = realpathSync.native(dir)
  } catch (e) {
    return { why: `could not be resolved to its real path, so its links could not be checked (${(e as Error).message})` }
  }
  const pending: Array<{ path: string; real: string }> = [{ path: dir, real: dirReal }]
  let seen = 0
  while (pending.length > 0) {
    const d = pending.pop()!
    let entries: Array<{ name: string; kind: EntryKind }>
    try {
      entries = listEntries(d.path)
    } catch (e) {
      return { why: `holds a folder that could not be listed, so whether a link in it leads outside it is not known (${d.path}: ${(e as Error).message})` }
    }
    seen += entries.length
    if (seen > maxEntries) {
      return { why: `holds more than ${maxEntries.toLocaleString('en-US')} entries, so whether a link under it leads outside it was not checked; a mission works in a smaller clone, or in one without its installed packages` }
    }
    for (const e of entries) {
      // C3 (wave 19): icacls and .NET read such an entry as another one (measured); refused by name.
      if (platform === 'win32' && NAME_WINDOWS_READS_AS_ANOTHER.test(e.name)) {
        return { why: `holds an entry whose name Windows reads as another entry (${join(d.path, e.name)}: its name ends in a dot or a space)` }
      }
      if (e.kind === 'file') continue
      const p = join(d.path, e.name)
      if (entryToEnter(d.real, e, p).enter) {
        pending.push({ path: p, real: join(d.real, e.name) })
        continue
      }
      let target: string
      try {
        target = realpathSync.native(p)
      } catch (err) {
        return { why: `holds a link whose target cannot be resolved (${p}: ${(err as Error).message}); such a link leads wherever its target is made again` }
      }
      if (!isInside(dirReal, target) && !isInside(dir, target)) return { link: p, target }
    }
  }
  return null
}

// ─── The Git-tools switch and the installed Git's namespace (B1, wave 19) ─────────────────────

/**
 * The installed Git whose Unix tools a contained child would reach by a bare name: the first PATH
 * entry that holds `msys-2.0.dll` (a Git Bash PATH names `<git>\usr\bin`), else the root above the
 * first `git.exe` on PATH (`<git>\cmd`, `<git>\bin`, `<git>\mingw64\bin`), else `%ProgramFiles%\Git`;
 * each only when `<root>\usr\bin\msys-2.0.dll` is there. Null when none is. Reads, starts nothing.
 */
export function installedGitRoot(env: Record<string, string | undefined> = process.env): string | null {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH')
  const entries = (key ? env[key] ?? '' : '').split(';').map(e => e.trim().replace(/^"(.*)"$/, '$1')).filter(e => /^[A-Za-z]:[\\/]/.test(e))
  const has = (root: string) => existsSync(join(root, 'usr', 'bin', 'msys-2.0.dll'))
  for (const e of entries) {
    if (existsSync(join(e, 'msys-2.0.dll')) && /[\\/]usr[\\/]bin[\\/]?$/i.test(e)) {
      const root = dirname(dirname(e.replace(/[\\/]+$/, '')))
      if (has(root)) return root
    }
  }
  for (const e of entries) {
    if (!existsSync(join(e, 'git.exe'))) continue
    const dir = e.replace(/[\\/]+$/, '')
    for (const root of [dirname(dir), dirname(dirname(dir))]) if (has(root)) return root
  }
  const pf = env.ProgramFiles ?? env.PROGRAMFILES
  if (pf && has(join(pf, 'Git'))) return join(pf, 'Git')
  return null
}

function sha256Of(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (e) {
    void e
    return null
  }
}

/**
 * B1: the copy of Git's Unix tools a run may start first, or why not (PLAN step 2 of the
 * investigation, and the owner's condition that a copy older than the installed Git is refused). The
 * copy must be a folder of its own, outside everything the run may write, the home and the sandbox
 * root, with no low label and no link, holding `usr\bin\bash.exe` and `etc\fstab`, and its
 * `msys-2.0.dll` must be the installed Git's, byte for byte (a stale copy after a Git update: msys
 * children of different versions in one chain were never measured).
 */
function msysCopyRefusal(input: string, o: {
  win: boolean; run?: ContainmentRunner; home: string; sandboxRoot: string; checkout: string; writeRoots: string[]; gitRoot: string | null
}): { copy: string } | { why: string } {
  const named = `LOCALCODE_CONTAINMENT_MSYS names ${input}`
  if (!o.win) return { why: 'LOCALCODE_CONTAINMENT_MSYS is for Windows only (a copy of Git\'s Unix tools for a contained run there)' }
  if (!absoluteOnEveryHost(input)) return { why: `${named}, which is not an absolute path` }
  if (!isDir(input)) return { why: `${named}, which does not exist or is not a folder` }
  const copy = real(input)
  const at = `the copy of Git's tools at ${copy}`
  for (const [rel, word] of [[['usr', 'bin', 'bash.exe'], 'usr\\bin\\bash.exe'], [['etc', 'fstab'], 'etc\\fstab'], [['usr', 'bin', 'msys-2.0.dll'], 'usr\\bin\\msys-2.0.dll']] as const) {
    if (!existsSync(join(copy, ...rel))) return { why: `${at} holds no ${word}; make it with scripts/cynco-containment-setup.ps1 -MsysCopy -Apply` }
  }
  const places: Array<[string, string]> = [
    [o.home, 'the home folder'], [o.sandboxRoot, 'the sandbox root'], [o.checkout, 'the checkout this engine runs from'],
    ...o.writeRoots.map(r => [r, 'a folder this run may write'] as [string, string]),
  ]
  for (const [p, what] of places) {
    if (within(p, copy) || within(copy, p)) return { why: `${at} is, contains or is inside ${p} (${what}), so the run could change the programs it starts` }
  }
  const label = runVia(o.run, sys('icacls.exe'), [copy], 10_000)
  if (!label.ok) return { why: `the integrity label of ${at} could not be read (${lastLine(label.out)})` }
  if (/Mandatory Label\\Low Mandatory Level/i.test(label.out)) return { why: `${at} carries a Low integrity label, so a contained run could change the programs it starts` }
  const link = linkLeadingOut(copy, RULE_M_MAX_ENTRIES, 'win32')
  if (link && 'why' in link) return { why: `${at} ${link.why}` }
  if (link) return { why: `${at} holds a link that leads outside it (${link.link} -> ${link.target})` }
  if (o.gitRoot === null) return { why: `the installed Git's usr\\bin\\msys-2.0.dll was not found, so ${at} could not be compared with it` }
  const mine = sha256Of(join(copy, 'usr', 'bin', 'msys-2.0.dll'))
  const theirs = sha256Of(join(o.gitRoot, 'usr', 'bin', 'msys-2.0.dll'))
  if (mine === null || theirs === null) return { why: `the msys-2.0.dll of ${at} or of the installed Git (${o.gitRoot}) could not be read` }
  if (mine !== theirs) return { why: `the copy of Git's tools at ${copy} is older than the installed Git; run the setup step again` }
  return { copy }
}

/**
 * B1 (wave 19): the installed Git's shared namespace is held at normal integrity for as long as this
 * process may start contained children. msys keeps a shared object folder per installation
 * (`\BaseNamedObjects\msys-2.0S5-<hash of its folder>`); the first msys process of an installation
 * makes it, and every later one joins it whatever its integrity level (measured 2026-11-24 and 25 with
 * a copy standing for the installed Git: a medium process joined a folder a low one made, and while a
 * medium one held it every low start failed, 4 of 4, `NtCreateDirectoryObject ... 0xC0000022`). Without
 * a holder, whether a low child's Git Bash starts depended on whether some Git Bash happened to be open,
 * and a low child could make the namespace an ordinary Git Bash then joins. The holder is one idle
 * `sh.exe -c "echo ready; read _"` of the installed Git, started here at normal integrity in System32,
 * its stdin a pipe whose only writer is this process: it ends when its stdin closes, which is when this
 * process releases its last run or ends in any way (measured: 22 ms after the close; at once after
 * a forced end of a Bun or a Node parent). It is ready (has joined or made the namespace) before the
 * first contained child of the process starts. Cost measured on this PC: ready in 38 ms, 9.7 MB.
 * A holder that ends while a run it held is not released poisons that run: no contained child starts
 * in this process until every such run is released (a low process could then make the namespace, and a
 * new holder would join it).
 */
type GitHolder = { child: ChildProcess; pid: number; runs: Set<string>; endedHere: boolean }
let gitHolder: GitHolder | null = null
const poisonedRuns = new Set<string>()
let noGitLogged = false
const GIT_HOLDER_READY_MS = 10_000
/**
 * R3 (wave 19b): a holder that could not be started is not started again for this long; until then every
 * contained spawn of the process gets the same refusal at once (each try held the caller's event loop,
 * up to 10 s when the start failed without throwing). Kept per sh.exe, so another Git is not held back.
 */
export const GIT_HOLDER_RETRY_MS = 30_000
let holderFailure: { sh: string; until: number; why: string } | null = null

function holderAlive(h: GitHolder): boolean {
  return h.child.exitCode === null && h.child.signalCode === null && pidAlive(h.pid)
}

/**
 * Hold the installed Git's namespace for `ctx` (B1). Null when it is held (or there is no installed Git
 * whose namespace a child could reach: then there is nothing to hold); otherwise why no contained child
 * may start. `gitRoot` is a seam (default `installedGitRoot()`); `readyDir` is where the holder says it
 * is ready (default the run folder, which stays medium).
 */
export function holdGitNamespace(ctx: RunContainment, o: { gitRoot?: string | null; readyDir?: string; now?: () => number } = {}): string | null {
  if (poisonedRuns.size > 0) {
    return `the process that held Git's shared namespace for run ${[...poisonedRuns][0]} ended before that run was released; no contained command starts in this process until it is, because a low process could then have made that namespace`
  }
  if (gitHolder && holderAlive(gitHolder)) {
    gitHolder.runs.add(ctx.runId)
    return null
  }
  const root = o.gitRoot === undefined ? installedGitRoot() : o.gitRoot
  if (root === null) {
    if (!noGitLogged) console.log('[containment] no installed Git with an msys runtime was found; there is no Git namespace to hold')
    noGitLogged = true
    return null
  }
  const sh = join(root, 'usr', 'bin', 'sh.exe')
  const nowMs = (o.now ?? Date.now)()
  if (holderFailure && holderFailure.sh === sh && nowMs < holderFailure.until) return `${holderFailure.why} (a failed start is not tried again for ${GIT_HOLDER_RETRY_MS / 1000} s)`
  const failed = (why: string): string => {
    holderFailure = { sh, until: nowMs + GIT_HOLDER_RETRY_MS, why }
    return why
  }
  if (!existsSync(sh)) return `the installed Git at ${root} has no usr\\bin\\sh.exe to hold its namespace with`
  const readyFile = join(o.readyDir ?? ctx.sandbox.root, `git-namespace-holder-${process.pid}-${Date.now()}.ready`)
  let fd: number
  try {
    fd = openSync(readyFile, 'w')
  } catch (e) {
    return `the ready file of the holder of Git's namespace could not be made (${(e as Error).message})`
  }
  const env: Record<string, string | undefined> = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, PATH: `${join(root, 'usr', 'bin')};${sys('')}`,
    TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, HOME: process.env.USERPROFILE,
  }
  let child: ChildProcess
  try {
    child = spawn(sh, ['-c', 'echo ready; read _'], { cwd: harnessChildCwd(), env, stdio: ['pipe', fd, 'ignore'], windowsHide: true })
  } catch (e) {
    closeSync(fd)
    unlinkQuiet(readyFile)
    return failed(`the holder of Git's namespace (${sh}) could not be started (${(e as Error).message})`)
  }
  closeSync(fd)
  child.on('error', e => console.log(`[containment] the holder of Git's namespace (${sh}): ${(e as Error).message}`))
  // R3 (wave 19b): a start that fails without throwing gives no pid (Node and Bun report it as an 'error'
  // event later; measured with a folder named sh.exe): refused at once, not after the 10 s wait.
  if (child.pid === undefined) {
    unlinkQuiet(readyFile)
    return failed(`the holder of Git's namespace (${sh}) could not be started (no process was made)`)
  }
  const h: GitHolder = { child, pid: child.pid, runs: new Set([ctx.runId]), endedHere: false }
  // It never keeps this process alive: when the process ends, its end of the pipe closes and the holder ends.
  child.unref()
  ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  child.on('exit', () => {
    if (!h.endedHere) for (const r of h.runs) poisonedRuns.add(r)
    if (gitHolder === h) gitHolder = null
  })
  // Ready means sh has started, so its msys runtime has made or joined the namespace (it does so
  // before main); a synchronous wait, so a synchronous spawn site is covered as well.
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < GIT_HOLDER_READY_MS) {
    try {
      if (readFileSync(readyFile, 'utf-8').includes('ready')) { ready = true; break }
    } catch (e) {
      void e
    }
    if (h.pid > 0 && !pidAlive(h.pid)) break
    Atomics.wait(wait, 0, 0, 10)
  }
  unlinkQuiet(readyFile)
  if (!ready) {
    h.endedHere = true
    try { child.kill() } catch (e) { void e }
    return failed(`the holder of Git's namespace (${sh}) did not say it was ready within ${GIT_HOLDER_READY_MS / 1000} s`)
  }
  gitHolder = h
  holderFailure = null
  return null
}

/** Remove the holder's ready file; a failure is logged, never thrown. */
function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p)
  } catch (e) {
    console.log(`[containment] the holder's ready file ${p} could not be removed: ${(e as Error).message}`)
  }
}

/** B1: `runId` no longer needs the holder; the last run's release ends it (its stdin is closed). */
export function releaseGitNamespace(runId: string): void {
  poisonedRuns.delete(runId)
  const h = gitHolder
  if (!h || !h.runs.delete(runId) || h.runs.size > 0) return
  h.endedHere = true
  gitHolder = null
  try {
    h.child.stdin?.end()
  } catch (e) {
    console.log(`[containment] the holder of Git's namespace could not be told to end: ${(e as Error).message}`)
  }
}

/** B1, for tests and the boot's report: the holder's pid and the runs it holds, or null. */
export function gitNamespaceHolder(): { pid: number; runs: string[] } | null {
  return gitHolder && holderAlive(gitHolder) ? { pid: gitHolder.pid, runs: [...gitHolder.runs] } : null
}

/**
 * Create the sandbox of one run, write its record, label it and the folders it works in, and
 * probe the result. Never throws, and never creates the sandbox ROOT: a root that does not exist
 * is a refusal. The refusals and their texts are `01-isolation.md` section 8.2.
 */
export function establishContainment(a: {
  kind: ContainmentKind; label?: string; runId?: string
  missionCwd: string; labelCwd?: boolean
  extraRoots?: string[]
  test?: boolean
  sandboxRoot?: string; home?: string
  folders?: Partial<RunContainment['folders']>
  probe?: boolean; platform?: NodeJS.Platform
  run?: ContainmentRunner
  now?: () => Date
  /** Test seam for rule M1: whether a mission folder or extra root is an existing folder (default: a stat). */
  isFolder?: (path: string) => boolean
  /** B1: the copy of Git's Unix tools (default: `LOCALCODE_CONTAINMENT_MSYS`, read here and nowhere else); null is off. */
  msys?: string | null
  /** B1, test seam: the installed Git's root, whose usr\bin\msys-2.0.dll the copy's must equal (default: `installedGitRoot()`). */
  gitRoot?: string | null
}): { ok: true; containment: RunContainment; ms: number } | { ok: false; reason: string } {
  const t0 = Date.now()
  const now = a.now ?? (() => new Date())
  const test = a.test === true
  const platform = a.platform ?? process.platform
  const win = platform === 'win32'
  const sw = containmentSwitch()
  // E1, E2: the switch.
  if (!test && sw.raw !== null) return { ok: false, reason: SWITCH_IN_UNATTENDED }
  if (test && sw.unknown.length > 0) return { ok: false, reason: unknownLayerReason(sw.unknown[0]) }
  // E3: a low process never establishes a second containment.
  const level = !win ? 'medium' : a.run ? readIntegrityLevel(a.run) : ownIntegrityLevel()
  if (level === 'low') return { ok: false, reason: 'this process is already running at low integrity, and a contained run does not establish a second containment' }
  // E4: exactly one of a label and a well-formed run id.
  const hasLabel = typeof a.label === 'string', hasId = typeof a.runId === 'string'
  if (hasLabel === hasId || (hasId && !RUN_ID_RE.test(a.runId!))) {
    return { ok: false, reason: `establishContainment needs exactly one of a label and a well-formed run id (got ${hasLabel && hasId ? `label ${a.label} and run id ${a.runId}` : hasId ? `run id ${a.runId}` : 'neither'})` }
  }
  const checkout = engineCheckout()
  // E5: no cwd.
  if (typeof a.missionCwd !== 'string' || a.missionCwd.trim() === '') {
    return { ok: false, reason: `this task names no cwd, so it would work in the engine's own checkout ${checkout}; give the mission a cwd` }
  }
  // E6: asked before anything is created, so a refusal under vitest's Node touches no folder.
  const lowilOff = switchedOff('lowil', test)
  if (win && !lowilOff) {
    const why = launcherUnavailable(runningUnderBun())
    if (why) return { ok: false, reason: why }
  }
  // S1, S2: the sandbox root.
  const rootIn = a.sandboxRoot ?? sandboxRoot()
  const home = a.home ?? homedir()
  if (!isAbsolute(rootIn) || !isDir(rootIn)) {
    return { ok: false, reason: `the sandbox root ${rootIn} is not an absolute path to an existing folder; create it once with scripts/cynco-containment-setup.ps1 or name another folder in LOCALCODE_SANDBOX_ROOT` }
  }
  const root = real(rootIn)
  if (isVolumeRoot(root) || within(root, home)) return { ok: false, reason: `the sandbox root ${root} is a drive root, or is or contains the home folder ${home}` }
  // V1, V2, V3: volumes integrity labels cannot protect.
  let volumes: Array<{ root: string; fileSystem: string }>
  try {
    volumes = listUnprotectedVolumes({ platform, run: a.run })
  } catch (e) {
    const msg = (e as Error).message
    const inner = /^the attached volumes could not be listed \((.*)\)$/.exec(msg)?.[1] ?? msg
    return { ok: false, reason: `the attached volumes could not be listed (${inner}), so it is not known whether one of them is unprotected` }
  }
  const acked = acknowledgedVolumes()
  for (const v of volumes) {
    if (!acked.includes(v.root)) return { ok: false, reason: `${v.root} (${v.fileSystem}) cannot be protected by integrity labels and is not acknowledged` }
  }
  for (const entry of acked) {
    if (!volumes.some(v => v.root === entry)) return { ok: false, reason: `the entry ${entry} of LOCALCODE_UNPROTECTED_VOLUMES_OK is not the root of an attached volume that integrity labels cannot protect` }
  }
  const unprotected = volumes.map(v => v.root)
  // S3: the sandbox root itself on such a volume.
  const rootVol = volumeOf(root)
  if (rootVol !== null && unprotected.includes(rootVol)) return { ok: false, reason: `the sandbox root ${root} is on ${rootVol}, a volume without integrity labels` }
  // H1: a home folder that is itself labelled low is protected by nothing.
  if (win) {
    const r = runVia(a.run, sys('icacls.exe'), [home], 10_000)
    if (!r.ok) return { ok: false, reason: `the integrity label of the home folder ${home} could not be read (${lastLine(r.out)})` }
    if (/Mandatory Label\\Low Mandatory Level/i.test(r.out)) return { ok: false, reason: `the home folder ${home} is itself labelled low integrity, so low integrity protects nothing in it` }
  }
  // M1 to M9: the mission folder and each extra root.
  const folders: RunContainment['folders'] = { ...defaultFolders(), ...(a.folders ?? {}) }
  const labelCwd = a.labelCwd !== false && win
  const common = { kind: a.kind, checkout, home, folders, sandboxRoot: root, unprotected, checkHardLinks: labelCwd, isFolder: a.isFolder ?? isDir, platform }
  const missionWhy = folderRefusal(a.missionCwd, 'the mission folder', { ...common, checkGit: a.kind === 'mission' })
  if (missionWhy) return { ok: false, reason: missionWhy }
  for (const extra of a.extraRoots ?? []) {
    const why = folderRefusal(extra, 'the extra folder', { ...common, checkGit: false })
    if (why) return { ok: false, reason: why }
  }
  const missionCwd = real(a.missionCwd)
  const extraRoots = (a.extraRoots ?? []).map(real)
  // B1 (wave 19): the Git-tools switch, read by the starter here, at create, and nowhere else; what it
  // names travels in the record, which the run cannot change. Off (unset or empty) is today's behaviour.
  const msysIn = a.msys === undefined ? process.env.LOCALCODE_CONTAINMENT_MSYS : a.msys
  let msysRuntime: string | null = null
  if (typeof msysIn === 'string' && msysIn.trim() !== '') {
    const m = msysCopyRefusal(msysIn.trim(), {
      win, run: a.run, home, sandboxRoot: root, checkout, writeRoots: [missionCwd, ...extraRoots],
      gitRoot: a.gitRoot === undefined ? installedGitRoot() : a.gitRoot,
    })
    if ('why' in m) return { ok: false, reason: m.why }
    msysRuntime = m.copy
  }
  const runId = hasId ? a.runId! : mintRunId(a.label!, now())
  const runDir = join(root, runId)
  const workFolders = [{ path: missionCwd, word: 'the mission folder' }, ...extraRoots.map(p => ({ path: p, word: 'the extra folder' }))]

  // Step 1: a record that names one of these folders and whose holder is gone is released now,
  // its labels set back as a release sets them (so a dead run's label is not mistaken below for
  // one a release failed to remove).
  const nowMs = now().getTime()
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    if (rec.releasedAt || !holderGone(rec, nowMs)) continue
    if (!namedFolders(rec).some(f => workFolders.some(w => samePath(f, w.path)))) continue
    releaseRecord(rec, join(root, rec.runId), 'holder-gone', { platform, run: a.run, now })
  }
  // Step 1b: a folder that still reads low with no live run holding it is one an earlier release
  // could not set back (the run may have changed its permissions). It is refused, loudly, before
  // anything is created: labelling it again would hide that.
  if (labelCwd) {
    for (const f of workFolders) {
      if (activeHolderOf(root, f.path, '', now().getTime())) continue
      const r = runVia(a.run, sys('icacls.exe'), [f.path], 10_000)
      if (!r.ok) return { ok: false, reason: `the integrity label of ${f.word} ${f.path} could not be read (${lastLine(r.out)})` }
      if (/Mandatory Label\\Low Mandatory Level/i.test(r.out)) {
        return { ok: false, reason: `${f.word} ${f.path} is already labelled low integrity and no live run holds it (an earlier run's release did not set it back, or it sits in a folder labelled low). Look at what changed in it, then set it back with icacls "${f.path}" /setintegritylevel (OI)(CI)M` }
      }
    }
  }
  // Step 2: the run folder (never recursive: an existing one is a refusal) and its five subfolders.
  const sb = sandboxOf(runDir)
  try {
    mkdirSync(runDir)
    for (const d of [sb.home, join(sb.home, 'AppData', 'Roaming'), join(sb.home, 'AppData', 'Local'), sb.tmp, sb.scratch]) mkdirSync(d, { recursive: true })
  } catch (e) {
    return { ok: false, reason: `the sandbox ${runDir} could not be created (${(e as Error).message})` }
  }
  // Step 3: the record, BEFORE any label (rule R1).
  const recPath = join(runDir, RECORD)
  const rec: ContainmentRecord = {
    schema: 1, runId, kind: a.kind, test,
    missionCwd, cwdLabel: labelCwd ? 'low' : 'none', cwdGranted: false,
    extraRoots, home, folders, unprotectedVolumes: unprotected,
    createdAt: now().toISOString(), createdByPid: process.pid,
    holder: a.kind === 'precheck' || a.kind === 'grader' ? { pid: process.pid, startedAt: processStartedAt() } : null,
    releasedAt: null,
    ...(msysRuntime !== null ? { msysRuntime } : {}),
  }
  try {
    writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' })
  } catch (e) {
    return { ok: false, reason: `the sandbox ${runDir} could not be created (${(e as Error).message})` }
  }
  const labelled: string[] = []
  const fail = (reason: string): { ok: false; reason: string } => {
    for (const f of labelled) {
      const other = activeHolderOf(root, f, runId, now().getTime())
      if (other) continue
      const r = setLabel(a.run, f, 'M')
      if (!r.ok) console.log(`[containment] ${f} could not be set back to medium integrity after a failed establish (${lastLine(r.out)})`)
    }
    for (const g of rec.grants ?? []) {
      const holder = activeHolderOf(root, g.folder, runId, now().getTime())
      const blocked = holder ? `run ${holder.runId} still holds the folder` : aclRestoreBlocked(g.folder)
      const why = blocked ?? restoreAcl(a.run, g)
      if (why) {
        // P2-B4: kept in the record, so the sweep keeps the saved copy and restore-acl can put it back.
        rec.grantsKept = [...(rec.grantsKept ?? []), { folder: g.folder, aclFile: g.aclFile, why: holder ? 'held' : blocked ? 'link' : 'restore' }]
        console.log(`[containment] the access list of ${g.folder} could not be put back after a failed establish (${why}); put it back with: ${RESTORE_ACL_COMMAND(runId)}`)
      }
    }
    if (win) {
      const sbBack = resetSandboxLabels(a.run, runDir)
      if (!sbBack.ok || sbBack.stoppedAfter !== null) console.log(`[containment] after a failed establish: ${sbBack.line}`)
      if (sbBack.leftLow !== null) rec.sandboxLeftLow = { ...sbBack.leftLow, at: now().toISOString() }
    }
    markReleased(recPath, rec, 'failed-establish', now())
    return { ok: false, reason }
  }
  // Step 4: the sandbox's own labels. The run folder itself stays medium, so the run cannot change its record.
  let sid: string | null = null
  if (win) {
    const s = userSid(a.run)
    if ('error' in s) return fail(`the sandbox ${runDir} could not be labelled low integrity (${s.error})`)
    sid = s.sid
    const g = grantFull(a.run, runDir, sid)
    if (!g.ok) return fail(`the sandbox ${runDir} could not be labelled low integrity (${lastLine(g.out)})`)
    for (const d of [sb.home, sb.tmp, sb.scratch]) {
      const r = setLabel(a.run, d, 'L')
      if (!r.ok) return fail(`the sandbox ${d} could not be labelled low integrity (${lastLine(r.out)})`)
    }
  } else {
    try {
      chmodSync(runDir, 0o700)
    } catch (e) {
      return fail(`the sandbox ${runDir} could not be created (${(e as Error).message})`)
    }
  }
  // Step 5: git identity through an include of the owner's file, which the run cannot write.
  const ownerGitconfig = join(home, '.gitconfig')
  const seeded = existsSync(ownerGitconfig)
    ? `[include]\n\tpath = ${ownerGitconfig.replace(/\\/g, '/')}\n`
    : '# No .gitconfig in the home folder to include; this run has its own git identity only if it sets one.\n'
  try {
    writeFileSync(join(sb.home, '.gitconfig'), seeded, 'utf-8')
  } catch (e) {
    return fail(`the sandbox ${runDir} could not be created (${(e as Error).message})`)
  }
  // Step 6: the folders the run works in.
  if (labelCwd && sid !== null) {
    // P2-F6: first, before any label or grant, which entries under each already had inheritance off,
    // so that the release turns it back on only for what this run turned off.
    rec.inheritanceBefore = workFolders.map((f, i) => ({ folder: f.path, ...readInheritanceOff(a.run, f.path, join(runDir, `inheritance-${i}.before`)) }))
    const recErr = writeRecord(recPath, rec)
    if (recErr !== null) return fail(`the sandbox ${runDir} could not be created (${recErr})`)
    for (const [i, f] of workFolders.entries()) {
      let r = setLabel(a.run, f.path, 'L')
      if (!r.ok) {
        // R1 F1: the grant below changes the owner's folder; its access list is saved first, in the
        // run folder (medium, so the run cannot change the copy), and the release puts it back. A
        // folder whose access list cannot be saved is not granted anything.
        const aclFile = join(runDir, `acl-${i}.before`)
        const saved = runVia(a.run, sys('icacls.exe'), [f.path, '/save', aclFile, '/c'], 30_000)
        if (!saved.ok) {
          return fail(`${f.word} ${f.path} could not be labelled low integrity (${lastLine(r.out)}), and its access list could not be saved before the grant that would let it be labelled (${lastLine(saved.out)})`)
        }
        // Recorded before the grant (P2-F2): a grant that fails or is cut at its cap may already have
        // changed the folder, and the failed establish puts the saved copy back.
        rec.grants = [...(rec.grants ?? []), { folder: f.path, aclFile }]
        writeRecord(recPath, rec)
        const g = grantFull(a.run, f.path, sid)
        if (g.ok) {
          rec.cwdGranted = true
          writeRecord(recPath, rec)
          r = setLabel(a.run, f.path, 'L')
        } else {
          r = g
        }
      }
      if (!r.ok) return fail(`${f.word} ${f.path} could not be labelled low integrity (${lastLine(r.out)})`)
      labelled.push(f.path)
    }
  }
  // Step 7: the probe, measured by this process.
  let isolation: 'verified' | 'overlay' = 'overlay'
  if (win && a.probe !== false && !lowilOff) {
    const why = probe(a.run, runDir, labelCwd ? workFolders : [])
    if (why) return fail(why)
    isolation = 'verified'
  }
  return { ok: true, containment: contextOf(rec, runDir, isolation), ms: Date.now() - t0 }
}

// ─── adoptContainment ────────────────────────────────────────────────────────────────────────

/**
 * Verify the sandbox a starter created for this run and hold it. Never creates; never throws. The
 * context is built from the RECORD, never from this process's environment. Does not set module
 * state: the caller calls `setRunContainment`.
 */
export function adoptContainment(a: {
  runId: string | null; missionCwd: string; who: 'engine' | 'one-shot' | 'driver'
  sandboxRoot?: string; probe?: boolean; platform?: NodeJS.Platform
}): { ok: true; containment: RunContainment; probeMs: number } | { ok: false; reason: string } {
  const platform = a.platform ?? process.platform
  if (containmentSwitch().raw !== null) return { ok: false, reason: SWITCH_IN_UNATTENDED }
  const runId = typeof a.runId === 'string' && RUN_ID_RE.test(a.runId) ? a.runId : null
  if (runId === null) {
    if (a.who === 'engine') return { ok: false, reason: 'no run id was handed to this engine (LOCALCODE_MISSION_RUN_ID is unset or malformed); a mission is started with scripts/dispatch-mission.sh, which creates the sandbox' }
    if (a.who === 'one-shot') return { ok: false, reason: 'the task file names no sandbox (runId); a one-shot is started by the daemon or the campaign runner, which create it' }
    return { ok: false, reason: 'the driver was handed no run id (LOCALCODE_MISSION_RUN_ID is unset or malformed); it is started by scripts/dispatch-mission.sh' }
  }
  if (typeof a.missionCwd !== 'string' || a.missionCwd.trim() === '') return { ok: false, reason: 'this run was not told its mission folder' }
  const runDir = join(a.sandboxRoot ?? sandboxRoot(), runId)
  const path = join(runDir, RECORD)
  // The read and the schema check are the launcher's own (containmentFromRecord); A8 to A12 follow.
  const read = containmentFromRecord(runDir)
  if (!read.ok) return { ok: false, reason: read.unread !== undefined ? `no containment record at ${path} (${read.unread})` : read.reason }
  const rec = read.record
  if (rec.test === true) return { ok: false, reason: 'this containment record was made by a test and cannot serve a run' }
  if (rec.releasedAt) return { ok: false, reason: `the containment record ${path} was released at ${rec.releasedAt}` }
  const wanted: ContainmentKind = a.who === 'one-shot' ? 'daemon-task' : 'mission'
  if (rec.kind !== wanted) {
    return { ok: false, reason: `the containment record ${path} is for a ${String(rec.kind)} run; ${a.who === 'one-shot' ? 'a one-shot adopts only a daemon-task' : `the ${a.who} adopts only a mission`} record` }
  }
  if (typeof rec.missionCwd !== 'string' || !samePath(rec.missionCwd, a.missionCwd)) {
    return { ok: false, reason: `the containment record ${path} is for ${String(rec.missionCwd)}, not for this run's folder ${real(a.missionCwd)}` }
  }
  const sb = sandboxOf(runDir)
  for (const d of [sb.home, sb.tmp, sb.scratch]) if (!isDir(d)) return { ok: false, reason: `the sandbox folder ${d} is missing` }
  const holds = a.who === 'engine' || a.who === 'one-shot'
  if (holds && rec.holder && rec.holder.pid !== process.pid && pidAlive(rec.holder.pid)) {
    return { ok: false, reason: `the containment record ${path} is already held by pid ${rec.holder.pid}` }
  }
  const win = platform === 'win32'
  if (win) {
    const why = launcherUnavailable(runningUnderBun())
    if (why) return { ok: false, reason: why }
  }
  let isolation: 'verified' | 'overlay' = 'overlay'
  let probeMs = 0
  if (win && a.probe !== false) {
    const t0 = Date.now()
    const labelled = rec.cwdLabel === 'low'
      ? [{ path: rec.missionCwd, word: 'the mission folder' }, ...(rec.extraRoots ?? []).map(p => ({ path: p, word: 'the extra folder' }))]
      : []
    const why = probe(undefined, runDir, labelled)
    probeMs = Date.now() - t0
    if (why) return { ok: false, reason: why }
    isolation = 'verified'
  }
  if (holds && rec.holder?.pid !== process.pid) {
    rec.holder = { pid: process.pid, startedAt: processStartedAt() }
    const err = writeRecord(path, rec)
    if (err !== null) return { ok: false, reason: `the containment record ${path} could not be written (${err})` }
  }
  return { ok: true, containment: contextOf(rec, runDir, isolation), probeMs }
}

// ─── releaseContainment ──────────────────────────────────────────────────────────────────────

/**
 * Mark a run released and set the folders it labelled back to medium integrity, unless another
 * live run still holds one, putting back the access list of a folder this run's establish widened
 * (R1 F1); on Windows also set the sandbox's own home, tmp and scratch back to medium (NOW.md:78).
 * Never throws, idempotent; the note says what it did and did not do, and is logged whenever a
 * folder that was due was not set back. Never deletes the sandbox.
 */
export function releaseContainment(c: RunContainment | string, o: {
  sandboxRoot?: string; platform?: NodeJS.Platform; run?: ContainmentRunner
} = {}): { relabelled: boolean; note: string } {
  const runId = typeof c === 'string' ? c : c.runId
  const runDir = typeof c === 'string' ? join(o.sandboxRoot ?? sandboxRoot(), c) : c.sandbox.root
  if (!RUN_ID_RE.test(runId)) return { relabelled: false, note: `no containment record for ${runId}` }
  // B1: this process holds the installed Git's namespace for this run no longer (the last run's release ends the holder).
  releaseGitNamespace(runId)
  const path = join(runDir, RECORD)
  const r = readRecord(path)
  if (!r.ok) return { relabelled: false, note: `no containment record for ${runId}` }
  if (r.rec.releasedAt) return { relabelled: true, note: `run ${runId} was already released at ${r.rec.releasedAt}` }
  const res = releaseRecord(r.rec, runDir, 'release', { platform: o.platform, run: o.run })
  return { relabelled: res.relabelled, note: res.note }
}

/**
 * Mark a record released, set its folders back to medium and, on Windows, its sandbox's home, tmp
 * and scratch too (`sandboxSetBack`: whether they now read medium, so the sweep may walk them).
 */
function releaseRecord(rec: ContainmentRecord, runDir: string, by: NonNullable<ContainmentRecord['releasedBy']>,
  o: { platform?: NodeJS.Platform; run?: ContainmentRunner; now?: () => Date }): { relabelled: boolean; note: string; sandboxSetBack: boolean } {
  const now = o.now ?? (() => new Date())
  const root = dirname(runDir)
  const path = join(runDir, RECORD)
  const lines: string[] = []
  let allDone = true
  const win = (o.platform ?? process.platform) === 'win32'
  // C5 (wave 19): every grant is kept in the same write that marks the record released, and dropped
  // below once it is put back; a release that ends part way (a Stop, a restart, the watcher killed,
  // minutes into the walk of the mission folder) then still says what it left, and the sweep keeps
  // the saved copy restore-acl needs.
  const grants = rec.grants ?? []
  if (win && grants.length > 0) {
    rec.grantsKept = grants.map(g => ({ folder: g.folder, aclFile: g.aclFile, why: 'unfinished' as const }))
    // R1 (wave 19b): while this process walks, the grants are not kept yet, they are being put back.
    rec.releasing = { pid: process.pid, startedAt: processStartedAt() }
  }
  const markErr = markReleased(path, rec, by, now())
  if (markErr !== null) {
    allDone = false
    lines.push(`the record could not be marked released (${markErr})`)
  }
  // BB-4 (wave 19c): a release that throws in a process that keeps running (the daemon's sweep catches per
  // record) takes its `releasing` out of the record before the error leaves, so restore-acl and status do not
  // wait on a live process that is releasing nothing; the grants stay kept as 'unfinished' for restore-acl.
  try {
    const due = labelledFolders(rec)
    if (!win) {
      lines.unshift(`run ${rec.runId} released${due.length ? ' (no integrity labels on this system)' : ''}`)
      return { relabelled: allDone, note: lines.join('; '), sandboxSetBack: true }
    }
    const grantOf = (f: string) => grants.find(g => samePath(g.folder, f))
    // A grant an engine made before the copy was kept: said, never guessed at.
    if (rec.cwdGranted && grants.length === 0) {
      lines.push(`the access list of ${due.join(', ')} was widened for this run by an engine that kept no copy of it, so it was not put back (a grant of full control to this user, (OI)(CI)F, may still be on it)`)
    }
    // P2-B4: every grant left in place is kept in the record (the sweep keeps the run folder and its
    // saved copy while one is), and its line names the command that puts it back.
    const kept: Array<{ folder: string; aclFile: string; why: GrantKeptWhy }> = []
    const keep = (g: { folder: string; aclFile: string }, why: GrantKeptWhy) => {
      allDone = false
      kept.push({ folder: g.folder, aclFile: g.aclFile, why })
      return `put it back with: ${RESTORE_ACL_COMMAND(rec.runId)}`
    }
    const grantKept = (f: string, why: string, kind: GrantKeptWhy) => {
      const g = grantOf(f)
      if (!g) return
      lines.push(`${f}: the access-list grant made for this run was not undone, because ${why}; its saved access list is ${g.aclFile}; ${keep(g, kind)}`)
    }
    for (const f of due) {
      const holder = activeHolderOf(root, f, rec.runId, now().getTime())
      if (holder) {
        lines.push(`${f} stays labelled low: run ${holder.runId} still holds it`)
        grantKept(f, `run ${holder.runId} still holds the folder`, 'held')
        continue
      }
      if (!isDir(f)) {
        allDone = false
        lines.push(`${f} is missing, so its label was not set back`)
        continue
      }
      const res = setLabel(o.run, f, 'M')
      if (!res.ok) {
        allDone = false
        lines.push(`${f} could not be set back to medium integrity (${lastLine(res.out)})`)
        grantKept(f, 'its label could not be set back first', 'label')
        continue
      }
      // Rule R1: a run that became active during the relabel keeps its label.
      const relabelForLateRun = (): boolean => {
        const late = activeHolderOf(root, f, rec.runId, now().getTime())
        if (!late) return false
        const again = setLabel(o.run, f, 'L')
        lines.push(again.ok
          ? `${f} was labelled low again: run ${late.runId} became active during the release`
          : `${f} could not be labelled low again for run ${late.runId}, which became active during the release (${lastLine(again.out)})`)
        grantKept(f, `run ${late.runId} became active during the release`, 'held')
        return true
      }
      if (relabelForLateRun()) continue
      // Rule R4: a label the run set itself on something under the folder (measured: it survives the
      // root relabel) is found and set back, one listing per folder, never entering a link.
      const walk = resetLowResidue(o.run, f, inheritanceRuleOf(rec, f))
      if (walk.failed.length > 0) {
        allDone = false
        lines.push(`${f}: ${walk.failed.length} entr${walk.failed.length === 1 ? 'y' : 'ies'} under it may still be labelled low (${walk.failed.slice(0, 3).join('; ')}${walk.failed.length > 3 ? '; ...' : ''})`)
      }
      if (relabelForLateRun()) continue
      lines.push(`${f} set back to medium integrity (${walkWords(walk, 'it')})`)
      // R1 F1: last, once nothing under the folder needs the grant to be relabelled any more.
      const g = grantOf(f)
      if (g) {
        const line = restoreGrantLine(o.run, g)
        lines.push(line.ok ? line.text : `${line.text}; ${keep(g, line.why ?? 'restore')}`)
      }
    }
    // NOW.md:78: the sandbox itself, so that no other run can write it or make a link in it, and the
    // sweep never walks a folder a live low process can rename in. Within its budget (wave 15c): past
    // it the rest stays labelled low, as every release left it before wave 15, and the sweep removes it.
    // A budget of its own, whoever releases (F2, wave 19b).
    const sb = resetSandboxLabels(o.run, runDir)
    if (!sb.ok) allDone = false
    lines.push(sb.line)
    if (sb.leftLow !== null) rec.sandboxLeftLow = { ...sb.leftLow, at: rec.releasedAt ?? now().toISOString() }
    // C8 (wave 19): set back whole, so the sweep need not walk it again.
    else if (sb.ok) rec.sandboxSetBackAt = now().toISOString()
    // A grant of `due` this release could not reach (its folder missing) is not kept: nothing to put back there.
    if (kept.length > 0) rec.grantsKept = kept
    else delete rec.grantsKept
    delete rec.releasing
    if (sb.stoppedAfter !== null || rec.sandboxSetBackAt !== undefined || grants.length > 0) {
      const err = writeRecord(path, rec)
      if (err !== null) {
        allDone = false
        lines.push(`the record could not keep what this release left (${err})`)
      }
    }
    const note = [`run ${rec.runId} released`, ...lines].join('; ')
    if (!allDone) console.log(`[containment] ${note}`)
    return { relabelled: allDone, note, sandboxSetBack: sb.ok && sb.stoppedAfter === null }
  } catch (e) {
    if (rec.releasing !== undefined) {
      delete rec.releasing
      writeRecord(path, rec)
    }
    throw e
  }
}

/**
 * P2-F2, P2-B4: put back the access list saved before a grant, unless a link under the folder leads
 * outside it (or the walk cannot tell); the line says which. Shared by the release and restore-acl.
 */
function restoreGrantLine(runner: ContainmentRunner | undefined, g: { folder: string; aclFile: string }): { ok: boolean; text: string; why?: GrantKeptWhy } {
  const blocked = aclRestoreBlocked(g.folder)
  if (blocked) return { ok: false, why: 'link', text: `${g.folder}: the access list saved before this run's grant was not put back, because ${blocked}; writing it rewrites what every entry under the folder inherited; its saved access list is ${g.aclFile}` }
  const why = restoreAcl(runner, g)
  if (why) return { ok: false, why: 'restore', text: `${g.folder}: the access list saved before this run's grant could not be put back (${why}); the copy is ${g.aclFile}` }
  return { ok: true, text: `${g.folder}: the access list saved before this run's grant was put back` }
}

/**
 * P2-B4: put back the grants a release kept (`grantsKept`), now that what kept them may be gone: the
 * same guards as the release (a folder another live run holds, a link under it that leads out). The
 * record keeps what is still kept. `done` when nothing is left kept. `cynco-sandbox.mjs restore-acl`.
 */
export function restoreKeptGrants(runId: string, o: { sandboxRoot?: string; platform?: NodeJS.Platform; run?: ContainmentRunner; now?: () => Date } = {})
  : { done: boolean; note: string; unread?: true } {
  const root = o.sandboxRoot ?? sandboxRoot()
  if (!RUN_ID_RE.test(runId)) return { done: true, note: `no containment record for ${runId}` }
  const runDir = join(root, runId)
  const path = join(runDir, RECORD)
  // C6 (c), wave 19: a record that is there and cannot be read is not "no record": what it keeps is unknown.
  if (!presentNoFollow(path)) return { done: true, note: `no containment record for ${runId}` }
  const r = readRecord(path)
  if (!r.ok) return { done: false, unread: true, note: `the record of ${runId} could not be read (${r.error})` }
  const rec = r.rec
  // Nothing for this command to do: the release of a live run puts its access lists back itself.
  if (!rec.releasedAt) return { done: true, note: `run ${runId} is not released; its release puts its access lists back` }
  // R1 (wave 19b): a release still running in another process is still putting them back; writing the
  // access list now would pull the grant from under its walk, and its last write would overwrite this one's.
  const releaser = releaseInProgress(rec)
  if (releaser !== null) return { done: false, note: `run ${runId} is still being released by process ${releaser}; restore-acl waits until that release has ended` }
  const due = rec.grantsKept ?? []
  if (due.length === 0) return { done: true, note: `run ${runId} keeps no grant to put back` }
  if ((o.platform ?? process.platform) !== 'win32') return { done: false, note: `run ${runId}: an access list is put back on Windows only` }
  const nowMs = (o.now ?? (() => new Date()))().getTime()
  const still: Array<{ folder: string; aclFile: string; why?: GrantKeptWhy }> = []
  const lines: string[] = []
  for (const g of due) {
    // C6 (a): a folder that is gone (deleted or moved) has no access list to put back.
    if (!presentNoFollow(g.folder)) {
      lines.push(`${g.folder} is gone; nothing to put back`)
      continue
    }
    const holder = activeHolderOf(dirname(runDir), g.folder, rec.runId, nowMs)
    if (holder) {
      still.push({ ...g, why: 'held' })
      lines.push(`${g.folder}: not put back, because run ${holder.runId} still holds the folder`)
      continue
    }
    // C6 (b), C5: kept because its label could not be set back, or by a release that ended part way:
    // the folder's own label goes back to medium first (the grant is what lets it be set), or nothing is written.
    if (g.why === 'label' || g.why === 'unfinished') {
      const l = setLabel(o.run, g.folder, 'M')
      if (!l.ok) {
        still.push(g)
        lines.push(`${g.folder}: not put back, because its label could not be set back to medium integrity first (${lastLine(l.out)})`)
        continue
      }
    }
    const line = restoreGrantLine(o.run, g)
    if (!line.ok) still.push({ ...g, why: line.why ?? 'restore' })
    lines.push(line.text)
  }
  rec.grantsKept = still
  const err = writeRecord(path, rec)
  if (err !== null) lines.push(`the record could not be written (${err})`)
  return { done: still.length === 0 && err === null, note: `run ${runId}: ${lines.join('; ')}` }
}

/**
 * `leftLow` (R2, wave 19b): in a sandbox's walk (one with a budget), the folders that were not entered
 * because Windows reads their name as another entry; what is under them stays as the run left it, as
 * past a budget stop, and the sweep removes them by its listing walk.
 */
type ResidueWalk = { dirs: number; reset: string[]; inheritance: string[]; failed: string[]; keptOff: string[]; keptWhy: string; leftLow: string[] }

/**
 * Which entries under a walked folder get inheritance turned back on (NOW.md:110, P2-F6): every one
 * in the sandbox, where every entry is the run's own; in a folder the run worked in, only one that
 * was not on the establish's list (`except`); none when there is no such list (`none`, with why).
 */
type InheritanceRule = { reset: 'all' } | { reset: 'except'; keep: Set<string> } | { reset: 'none'; why: string }

const foldEntry = (p: string) => p.replace(/\//g, '\\').toLowerCase()

function inheritanceRuleOf(rec: ContainmentRecord, folder: string): InheritanceRule {
  const b = (rec.inheritanceBefore ?? []).find(x => samePath(x.folder, folder))
  if (!b) return { reset: 'none', why: "this run's record keeps no list of what had it off before the run" }
  if (b.unread !== undefined || !b.listFile) return { reset: 'none', why: `what had it off before the run could not be read (${b.unread ?? 'no list'})` }
  try {
    return { reset: 'except', keep: new Set(readFileSync(b.listFile, 'utf-8').split(/\r?\n/).filter(l => l !== '').map(foldEntry)) }
  } catch (e) {
    return { reset: 'none', why: `the list of what had it off before the run could not be read (${(e as Error).message})` }
  }
}

/** The words in brackets after "set back to medium integrity" (the acceptance reads its count). */
function walkWords(walk: ResidueWalk, under: 'it' | 'them'): string {
  const list = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', ...' : ''}`
  return `${walk.dirs} folder${walk.dirs === 1 ? '' : 's'} read for labels set under ${under}`
    + (walk.reset.length ? `; ${walk.reset.length} set back: ${list(walk.reset)}` : '')
    + (walk.inheritance.length ? `; inheritance turned back on for ${walk.inheritance.length}: ${list(walk.inheritance)}` : '')
    + (walk.keptOff.length ? `; inheritance left off for ${walk.keptOff.length}, ${walk.keptWhy}: ${list(walk.keptOff)}` : '')
}

/**
 * NOW.md:78: the sandbox's `home`, `tmp` and `scratch` set back to medium integrity, each with the
 * release's own walk (`resetLowResidue`: never entering a link, every low label the run set itself
 * under it set back). A folder that is gone is nothing to set back; one its run folder's listing
 * calls a link is never touched (the run folder is medium, so a run cannot make one there).
 */
/**
 * Wave 15c: how far the set-back of a released sandbox goes (`resetSandboxLabels`): it stops before
 * the next folder once it has listed `folders` folders or spent `ms` milliseconds, whichever comes
 * first. Each folder costs one `icacls` start (measured 2026-11-24: about 20 ms on an idle PC, 30 to
 * 61 ms under load), and the walk runs synchronously on the caller's event loop (the daemon's task
 * release and sweep among them). The sandboxes measured on this PC held 2 to 10 folders; a CynCo-size
 * tree in scratch (about 16,000 folders) took about 17 minutes. The folders a run worked in (the
 * owner's repository) are walked to the end: they have no budget.
 */
export const SANDBOX_SET_BACK_BUDGET: { readonly folders: number; readonly ms: number; readonly calls: number } = { folders: 200, ms: 5_000, calls: 2_000 }

/**
 * A budget shared by the walks of one set-back: folders listed so far, the calls made for single
 * entries inside them (C2, wave 19: one wide folder holds thousands; each is a label read, set or
 * reset of 20 to 60 ms), the deadline, and where it stopped. It is asked before every folder and
 * before every call inside one, so one set-back holds its caller for at most the budget plus one call.
 */
type WalkBudget = { folders: number; maxFolders: number; calls: number; maxCalls: number; deadline: number; stopped: boolean }

function sandboxBudget(): WalkBudget {
  return {
    folders: 0, maxFolders: SANDBOX_SET_BACK_BUDGET.folders, calls: 0, maxCalls: SANDBOX_SET_BACK_BUDGET.calls,
    deadline: Date.now() + SANDBOX_SET_BACK_BUDGET.ms, stopped: false,
  }
}

/** Is the budget spent (it then says so), before one more call inside a folder? Never with no budget. */
function callBudgetSpent(budget: WalkBudget | undefined): boolean {
  if (!budget) return false
  if (budget.calls >= budget.maxCalls || Date.now() >= budget.deadline) budget.stopped = true
  else budget.calls++
  return budget.stopped
}

/** Is a budget spent (C8: the sweep asks before it starts on the next sandbox of its pass)? */
function budgetSpent(budget: WalkBudget): boolean {
  return budget.stopped || budget.folders >= budget.maxFolders || budget.calls >= budget.maxCalls || Date.now() >= budget.deadline
}

/**
 * `budget`: one of its own by default; the sweep hands one budget to every set-back of a sandbox
 * released before its pass (C8, wave 19), so those hold its caller for the budget at most, however many
 * it meets; a release the sweep makes itself has a budget of its own (F2, wave 19b).
 * `stoppedAfter` counts the folders of this sandbox only.
 */
function resetSandboxLabels(runner: ContainmentRunner | undefined, runDir: string, budget: WalkBudget = sandboxBudget())
  : { ok: boolean; line: string; stoppedAfter: number | null; leftLow: NonNullable<ContainmentRecord['sandboxLeftLow']> | null } {
  const sb = sandboxOf(runDir)
  const startFolders = budget.folders
  const total: ResidueWalk = { dirs: 0, reset: [], inheritance: [], failed: [], keptOff: [], keptWhy: '', leftLow: [] }
  // The three tops first (three calls, inside any budget): no new entry under them is made low.
  const tops: string[] = []
  for (const d of [sb.home, sb.tmp, sb.scratch]) {
    const link = isLinkEntry(d)
    if (link === null && !presentNoFollow(d)) continue
    if (link !== false) {
      total.failed.push(`${d} is ${link ? 'a link' : 'not in the listing of its run folder'}, so it was not touched`)
      continue
    }
    const r = setLabel(runner, d, 'M')
    if (!r.ok) {
      total.failed.push(`${d} could not be set back to medium integrity (${lastLine(r.out)})`)
      continue
    }
    tops.push(d)
  }
  for (const d of tops) {
    // Every entry of the sandbox is the run's own: inheritance is turned back on wherever it is off.
    const walk = resetLowResidue(runner, d, { reset: 'all' }, budget)
    total.dirs += walk.dirs
    total.reset.push(...walk.reset)
    total.inheritance.push(...walk.inheritance)
    total.failed.push(...walk.failed)
    total.keptOff.push(...walk.keptOff)
    total.keptWhy = walk.keptWhy
    total.leftLow.push(...walk.leftLow)
    if (budget.stopped) break
  }
  // R2 (wave 19b): a folder left low for its name is a stop as a spent budget is: the sweep removes the sandbox.
  const stoppedAfter = budget.stopped || total.leftLow.length > 0 ? budget.folders - startFolders : null
  const notEntered = total.leftLow.length === 0 ? '' : `${total.leftLow.slice(0, 3).map(p => `${p} was not entered: Windows reads its name as another entry (it ends in a dot or a space), so what is under it stays as the run left it`).join('; ')}${total.leftLow.length > 3 ? `; and ${total.leftLow.length - 3} more` : ''}; `
  const stopWords = `${notEntered}the sandbox was not set back ${budget.stopped ? `past ${stoppedAfter} folders` : 'under those'}; the sweep removes it`
  const stopped = stoppedAfter === null ? '' : `; ${stopWords}`
  // BB-6 (wave 19c): what the record keeps of a stop, with why (the `at` is the caller's).
  const leftLow = stoppedAfter === null ? null
    : total.leftLow.length === 0 ? { folders: stoppedAfter, at: '' }
      : { folders: stoppedAfter, at: '', notEntered: total.leftLow.length, budgetStopped: budget.stopped }
  if (total.failed.length > 0) {
    return { ok: false, stoppedAfter, leftLow, line: `the sandbox ${runDir} may still be labelled low in ${total.failed.length} place${total.failed.length === 1 ? '' : 's'} (${total.failed.slice(0, 3).join('; ')}${total.failed.length > 3 ? '; ...' : ''})${stopped}` }
  }
  if (stoppedAfter !== null) return { ok: true, stoppedAfter, leftLow, line: stopWords }
  return { ok: true, stoppedAfter, leftLow, line: `the sandbox's home, tmp and scratch set back to medium integrity (${walkWords(total, 'them')})` }
}

/**
 * BB-6 (wave 19c): the words for a sandbox a release left low, as the sweep's line and `cynco-sandbox.mjs status`
 * say them after "not set back": "past N folders" for a budget stop, "under N folder(s) whose name ends in a dot
 * or a space" for the folders not entered for their name (R2), both when both happened.
 */
export function sandboxLeftLowWords(s: NonNullable<ContainmentRecord['sandboxLeftLow']>): string {
  const past = `past ${s.folders} folders`
  const n = s.notEntered
  if (typeof n !== 'number' || n <= 0) return past
  const under = `under ${n} folder${n === 1 ? '' : 's'} whose name ends in a dot or a space`
  return s.budgetStopped ? `${past} and ${under}` : under
}

/** A folder's DACL in SDDL from an `icacls /save` file (UTF-16: its name, then its descriptor), or why not. */
function savedDacl(aclFile: string, folder: string): { dacl: string } | { error: string } {
  let text: string
  try {
    text = readFileSync(aclFile).toString('utf16le').replace(/^\uFEFF/, '')
  } catch (e) {
    return { error: `the saved copy could not be read (${(e as Error).message})` }
  }
  const [name, sddl] = text.split(/\r?\n/).map(l => l.trim())
  if (!name || name.toLowerCase() !== basename(folder).toLowerCase()) return { error: `the saved copy names ${name || 'nothing'}, not ${basename(folder)}` }
  // The DACL is `D:` with its flags and ACEs, up to an `S:` (the SACL) outside any ACE, or the end.
  const m = /^.*?(D:[A-Z]*(?:\([^()]*\))*)/.exec(sddl ?? '')
  if (!m || !/^D:[A-Z]*(\([A-Za-z0-9;:\-]*\))*$/.test(m[1])) return { error: `the saved copy holds no access list this engine reads (${(sddl ?? '').slice(0, 80)})` }
  return { dacl: m[1] }
}

/**
 * P2-F2: why the saved access list of `folder` may not be written back now, or null. Writing a
 * folder's DACL makes Windows recompute what every entry under it inherited, a walk of the whole
 * tree that this module does not control; a link under the folder that leads outside it (one the
 * run made) could carry that rewrite to the owner's files behind it. So the restore waits until no
 * such link is there, the same answer rule M gives at establish (`linkLeadingOut`).
 */
function aclRestoreBlocked(folder: string): string | null {
  // An access list is put back on Windows only (the release and restore-acl reach here only there).
  const out = linkLeadingOut(folder, RULE_M_MAX_ENTRIES, 'win32')
  if (out === null) return null
  return 'why' in out ? `the folder ${out.why}` : `${out.link} leads outside it (to ${out.target})`
}

/**
 * R1 F1: put back the access list a folder had before this run's grant, from the copy `icacls /save`
 * made in the run folder. `icacls /restore` needs a privilege an ordinary owner does not hold
 * (measured 2026-11-24: "Not all privileges or groups referenced are assigned to the caller"), so the
 * DACL alone is written through .NET's `Directory.SetAccessControl`, which an owner may always do;
 * the label (the SACL) is not touched. Only the folder's own explicit entries change; what its
 * children inherited from the grant goes with it. Null, or why not.
 */
function restoreAcl(runner: ContainmentRunner | undefined, g: { folder: string; aclFile: string }): string | null {
  const saved = savedDacl(g.aclFile, g.folder)
  if ('error' in saved) return saved.error
  if (isLinkEntry(g.folder) !== false) return `${g.folder} is not a folder its parent's listing shows, so it was not touched`
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$ds = New-Object System.Security.AccessControl.DirectorySecurity',
    `$ds.SetSecurityDescriptorSddlForm(${q(saved.dacl)}, [System.Security.AccessControl.AccessControlSections]::Access)`,
    `[System.IO.Directory]::SetAccessControl(${q(g.folder)}, $ds)`,
    "'cynco-acl-restored'",
  ].join('; ')
  const r = runVia(runner, sys('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], ACL_WRITE_CAP_MS)
  return r.ok && /cynco-acl-restored/.test(r.out) ? null : lastLine(r.out)
}

type LowState = 'explicit' | 'inherited' | 'none'

/**
 * Is there an entry at `p` (a link counts as itself, its target is not asked)? The parent's listing
 * first: lstat follows a junction a low process made (F4), so one whose target is gone reads as absent.
 */
function presentNoFollow(p: string): boolean {
  if (isLinkEntry(p) !== null) return true
  try {
    lstatSync(p)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** The low label of one icacls block: set on the entry itself, inherited (`(I)`), or none. */
function lowStateOf(block: string): LowState {
  const m = /Mandatory Label\\Low Mandatory Level:(\S*)/i.exec(block)
  if (!m) return 'none'
  return m[1].includes('(I)') ? 'inherited' : 'explicit'
}

/**
 * NOW.md:110: has inheritance been turned off on this entry? True when its block lists access
 * entries and not one of them is inherited (`(I)`): a file or folder made in a folder always
 * inherits, so only a process that turned inheritance off (`icacls /inheritance:r`, which a low
 * process may do to what it can write) leaves an entry with explicit entries alone. The mandatory
 * label line is not an access entry.
 */
function inheritanceOffOf(block: string): boolean {
  const aces = block.split(/\r?\n/).map(l => l.trim()).filter(l => /:\(/.test(l) && !/^Mandatory Label\\/i.test(l))
  return aces.length > 0 && !aces.some(l => l.includes('(I)'))
}

/**
 * Read `icacls "<dir>\*" /L` output: each entry's block starts at column 0 with its full path,
 * and its ACE lines follow, indented. Only the paths in `entries` are recognised (a name with a
 * space cannot be told from the first ACE otherwise); keys are folded on Windows.
 */
function blocksOfListing(out: string, entries: string[]): Map<string, string> {
  const fold = (p: string) => p.toLowerCase()
  // C2 (wave 19): an index by folded path. A header line is its entry's path alone, or the path, a
  // space and the first access entry; the longest path that is the whole line or ends at one of its
  // spaces wins, as the scan over every entry (longest first) answered, at one lookup per space.
  const index = new Map<string, string>()
  for (const p of entries) index.set(fold(p), p)
  const blocks = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line !== '' && !/^\s/.test(line)) {
      const fl = fold(line)
      let hit = index.get(fl)
      for (let i = fl.lastIndexOf(' '); hit === undefined && i > 0; i = fl.lastIndexOf(' ', i - 1)) hit = index.get(fl.slice(0, i))
      current = hit === undefined ? null : []
      if (hit !== undefined) {
        blocks.set(fold(hit), current!)
        current!.push(line.slice(hit.length))
      }
      continue
    }
    current?.push(line)
  }
  return new Map([...blocks].map(([k, lines]) => [k, lines.join('\n')]))
}

/**
 * Rule R4 of the release: walk `top` without ever entering a link, list each folder's entries
 * with ONE `icacls "<dir>\*" /L`, and set back every entry that carries a low label of its own
 * (not inherited): `(OI)(CI)M` on a folder, `M` on anything else, always with `/L` so a link's own
 * label is what changes. An entry the listing does not show is asked on its own. Never `/T`.
 *
 * Each entry's kind comes from the folder's own listing (`listEntries`), never from lstat: lstat
 * calls a junction a low-integrity process made a folder and follows it (F4), and `icacls
 * "<junction>\*"` reads and sets the labels of its TARGET's children. The walk is finite: it enters
 * a folder only when that folder's native real path is its parent's real path joined with its name
 * (`entryToEnter`, which never enters a link that resolves elsewhere or not at all); so every folder
 * it enters is a different real folder under `top`, and NTFS gives a folder one parent (there are no
 * hard links to folders), so no folder is entered twice and no cycle can be walked. The check is
 * made when a folder is queued and again when it is taken from the queue, just before it is listed:
 * a folder swapped for a link in between (each folder costs an icacls run, so the gap can be
 * seconds) is not listed through, and the release says it was not entered.
 */
function resetLowResidue(runner: ContainmentRunner | undefined, top: string, rule: InheritanceRule, budget?: WalkBudget): ResidueWalk {
  const out: ResidueWalk = { dirs: 0, reset: [], inheritance: [], failed: [], keptOff: [], keptWhy: rule.reset === 'none' ? rule.why : 'which had it off before this run', leftLow: [] }
  const icacls = sys('icacls.exe')
  let topReal: string
  try {
    topReal = realpathSync.native(top)
  } catch (e) {
    out.failed.push(`${top} could not be resolved to its real path (${(e as Error).message})`)
    return out
  }
  const pending: Array<{ path: string; real: string; parentReal: string | null; name: string }> = [
    { path: top, real: topReal, parentReal: null, name: basename(top) },
  ]
  walk: while (pending.length > 0) {
    // Wave 15c: a sandbox's walk stops before the next folder once its budget is spent (the rest stays
    // low, and the sweep removes it); a folder the run worked in is walked without one.
    if (budget && (budget.folders >= budget.maxFolders || budget.calls >= budget.maxCalls || Date.now() >= budget.deadline)) {
      budget.stopped = true
      break
    }
    const d = pending.pop()!
    if (d.parentReal !== null) {
      const why = whyNotAtOwnPath(d.parentReal, d.name)
      if (why) {
        out.failed.push(`${d.path} was not entered: it ${why}`)
        continue
      }
    }
    let listed: Array<{ name: string; kind: 'dir' | 'link' | 'file' }>
    try {
      listed = listEntries(d.path)
    } catch (e) {
      out.failed.push(`${d.path} could not be listed (${(e as Error).message})`)
      continue
    }
    if (listed.length === 0) continue
    out.dirs++
    if (budget) budget.folders++
    const entries = listed.map(e => ({ path: join(d.path, e.name), name: e.name, kind: e.kind }))
    const listing = runVia(runner, icacls, [join(d.path, '*'), '/L'], 60_000)
    const blocks = blocksOfListing(listing.out, entries.map(e => e.path))
    for (const e of entries) {
      // Asked before the label is read, so a folder the listing calls a link that is walked as the
      // folder it is gets a folder's label.
      const to = entryToEnter(d.real, e, e.path)
      // Wave 15c: the listing's block for a device's name (nul, con, ...) is the device's, and C3 (wave
      // 19) the block for `foo.` or `foo ` is `foo`'s; such an entry is asked, and set, through its \\?\
      // form (`asEntry`; measured 2026-11-25: a set and a reset through it succeed where the run has the
      // rights, C4).
      const at = asEntry(e.path, e.name)
      let block = at === e.path ? blocks.get(e.path.toLowerCase()) : undefined
      if (block === undefined) {
        if (callBudgetSpent(budget)) break walk
        const one = runVia(runner, icacls, [at, '/L'], 10_000)
        if (!one.ok) {
          if (presentNoFollow(e.path)) out.failed.push(`the label of ${e.path} could not be read (${lastLine(one.out)})`)
          continue
        }
        block = one.out
      }
      if (lowStateOf(block) === 'explicit') {
        if (callBudgetSpent(budget)) break walk
        const r = runVia(runner, icacls, [at, '/L', '/setintegritylevel', e.kind === 'dir' || to.enter ? '(OI)(CI)M' : 'M'], 30_000)
        if (r.ok) out.reset.push(e.path)
        else out.failed.push(`${e.path} could not be set back (${lastLine(r.out)})`)
      }
      // NOW.md:110: after the label (which `/reset` leaves as it is, measured 2026-11-24), so the
      // entry's own explicit entries, which can be what let the label be set, are still there. Only
      // where the run turned it off (P2-F6): an entry of the owner's that had it off before the run
      // (a protected secrets file, pytest's .pytest_cache) keeps its own access list, and is named.
      if (inheritanceOffOf(block)) {
        if (rule.reset === 'all' || (rule.reset === 'except' && !rule.keep.has(foldEntry(e.path)))) {
          if (callBudgetSpent(budget)) break walk
          const r = runVia(runner, icacls, [at, '/reset', '/L'], 30_000)
          if (r.ok) out.inheritance.push(e.path)
          else out.failed.push(`inheritance could not be turned back on for ${e.path} (${lastLine(r.out)})`)
        } else {
          out.keptOff.push(e.path)
        }
      }
      // A link's own label was set back above; what it points at is never walked.
      if (to.why) out.failed.push(`${e.path} was not entered: it ${to.why}`)
      // C3 (wave 19): icacls handed `<it>\*` or `<it>\<name>` would act in the folder whose name it
      // has without the dot or space (measured); its own label and inheritance were asked above
      // through `\\?\`, what is under it is not walked, and the release says so.
      if (to.enter && NAME_WINDOWS_READS_AS_ANOTHER.test(e.name)) {
        // R2 (wave 19b): in a sandbox (a walk with a budget) it is left low, as a budget stop leaves the
        // rest, and the sweep removes it by its listing walk, which acts on the literal name (measured
        // 2026-11-25 under Node and Bun: x. was removed and x beside it was not); a failed line made the
        // sweep keep such a sandbox for ever. Under a folder the run worked in, it is said as before.
        if (budget) {
          out.leftLow.push(e.path)
          continue
        }
        out.failed.push(`${e.path} was not entered: Windows reads its name as another entry (it ends in a dot or a space), so what is under it was not read`)
        continue
      }
      if (to.enter) pending.push({ path: e.path, real: join(d.real, e.name), parentReal: d.real, name: e.name })
    }
  }
  return out
}

// ─── sweepSandboxes ──────────────────────────────────────────────────────────────────────────

/**
 * Remove a link as an entry, never what it points at. `rmdirSync` first: it removes a junction or a
 * folder link alone (measured for a junction a low process made, F4). When it fails for any reason,
 * `unlinkSync`: on Windows `rmdirSync` of an entry that is not a folder answers ENOENT, not ENOTDIR
 * (measured 2026-11-24 under Bun 1.3.13 and Node 24 on a file carrying a reparse tag, which a
 * low-integrity process can set on a file it wrote with no privilege). Neither call follows a link:
 * `unlinkSync` removes a name, and on a real folder (one the listing wrongly called a link) it fails
 * without touching anything, empty or not (measured: EPERM). When both fail the error names both
 * answers and is thrown, which stops the sweep at this run folder.
 */
function removeLinkEntry(p: string, log: (line: string) => void): void {
  let asFolder: NodeJS.ErrnoException
  try {
    rmdirSync(p)
    return
  } catch (e) {
    asFolder = e as NodeJS.ErrnoException
  }
  try {
    unlinkSync(p)
  } catch (e) {
    throw new Error(`${p} could not be removed as a link (rmdir answered ${asFolder.code ?? asFolder.message}, unlink answered ${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`)
  }
  log(`[containment] ${p} is not a folder link (rmdir answered ${asFolder.code ?? asFolder.message}); it was removed as a file link`)
}

/**
 * Remove a tree without ever following a link. The one walk in this change that deletes; only
 * `sweepSandboxes` calls it. The only deleting calls are `unlinkSync` on what the listing calls a
 * file, `rmdirSync` on a folder this walk has emptied, and `removeLinkEntry` on what the listing
 * calls a link.
 *
 * An entry's kind comes from its folder's listing (`listEntries`), never from lstat: lstat calls a
 * junction made by a low-integrity process a folder and returns its TARGET's stat (F4), so a walk
 * that asked lstat entered such a junction and deleted what it pointed at, at medium integrity. A
 * link is removed as an entry and never entered. The folder handed in is judged by its parent's
 * listing the same way. Before a folder is entered, again after it is listed, and again before each
 * of its entries is removed, its native real path must be its parent's real path joined with its
 * name (`whyNotAtOwnPath`, which resolves the whole path, so a swapped ancestor fails it too): that
 * stops the walk at a folder swapped for a link after its parent was listed or while it is being
 * emptied, and at any reparse kind a listing does not flag. When that cannot be shown the walk
 * throws; the sweep then keeps the run folder with its record, logs why, and tries it again on its
 * next pass.
 *
 * Each folder is also read with lstat before and after it is listed, and compared with what its
 * parent saw (dev and ino). That sees a folder replaced by another folder, or by a link lstat
 * recognises (one made at medium integrity); it cannot see a swap to a junction made at low
 * integrity, because lstat follows that one and answers with its target's dev and ino (F4), which
 * is why the real-path check above exists. A swap inside the window left, between the last check
 * and the one delete that follows it (microseconds; a live low process would have to make both of
 * its renames inside it, and could widen it with an opportunistic lock), is not excluded by a
 * path-based walk: what closes it is a sandbox set back to medium before the delete, so that no low
 * process can rename in it, which the release and the sweep now do (`resetSandboxLabels`).
 *
 * `keep`: the name of a file at the top that is left in place (the run's record, which the sweep
 * removes last).
 */
function removeTreeNoFollow(dir: string, log: (line: string) => void, from?: { parentReal: string; seen: BigIntStats }, keep?: string): void {
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  const changed = (why: string) => new Error(`${dir} ${why}; the sweep stops there and enters nothing`)
  let parentReal: string
  if (from) {
    parentReal = from.parentReal
  } else {
    const link = isLinkEntry(dir)
    if (link === true) throw changed('is a link')
    if (link === null) throw changed(`is not in the listing of ${dirname(dir)}, so whether it is a link is not known`)
    try {
      parentReal = realpathSync.native(dirname(dir))
    } catch (e) {
      throw changed(`has a parent that could not be resolved to its real path (${(e as Error).message})`)
    }
  }
  const name = basename(dir)
  const ownWhy = whyNotAtOwnPath(parentReal, name)
  if (ownWhy) throw changed(ownWhy)
  const before = lstatSync(dir, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory()) throw changed('is no longer a folder')
  if (from && !same(before, from.seen)) throw changed('was replaced after it was read')
  const entries = listEntries(dir)
  const after = lstatSync(dir, { bigint: true })
  if (after.isSymbolicLink() || !same(before, after)) throw changed('was replaced while it was listed')
  const afterWhy = whyNotAtOwnPath(parentReal, name)
  if (afterWhy) throw changed(`${afterWhy} after it was listed`)
  const real = join(parentReal, name)
  const stillHere = () => {
    const why = whyNotAtOwnPath(parentReal, name)
    if (why) throw changed(`${why} before an entry in it was removed`)
  }
  for (const e of entries) {
    if (e.name === keep && e.kind === 'file') continue
    const p = join(dir, e.name)
    stillHere()
    if (e.kind === 'link') {
      removeLinkEntry(p, log)
    } else if (e.kind === 'dir') {
      removeTreeNoFollow(p, log, { parentReal: real, seen: lstatSync(p, { bigint: true }) })
      stillHere()
      rmdirSync(p)
    } else {
      unlinkSync(p)
    }
  }
}

/**
 * Release the records whose holder is gone and remove the run folders older than `keepDays` whose
 * holder is not alive. Only a direct child of the root whose name is a run id and whose own record
 * names that id is ever touched; links are removed as entries and never entered. Refuses, removing
 * nothing, when the root is a drive root or is or contains the home folder.
 */
export function sweepSandboxes(o: {
  sandboxRoot?: string; now?: () => Date; keepDays?: number; log?: (line: string) => void
  home?: string; platform?: NodeJS.Platform; run?: ContainmentRunner
} = {}): { removed: string[]; kept: number } {
  const log = o.log ?? ((line: string) => console.log(line))
  const now = o.now ?? (() => new Date())
  const rootIn = o.sandboxRoot ?? sandboxRoot()
  const home = o.home ?? homedir()
  if (!isAbsolute(rootIn) || !isDir(rootIn)) return { removed: [], kept: 0 }
  const root = real(rootIn)
  if (isVolumeRoot(root) || within(root, home)) {
    log(`[containment] the sweep refused: the sandbox root ${root} is a drive root, or is or contains the home folder ${home}; nothing was removed`)
    return { removed: [], kept: 0 }
  }
  const keepMs = (o.keepDays ?? SANDBOX_KEEP_DAYS) * 24 * 3600_000
  const removed: string[] = []
  let kept = 0
  // C8 (wave 19): one set-back budget for the whole pass (the daemon runs it on its event loop), for the
  // sandboxes of runs released before. F2 (wave 19b): a release the sweep makes itself (a holder that is
  // gone, an old unreleased run) has a budget of its own, as every release has: with a spent pass budget it
  // set back nothing and left its sandbox low for its whole week. Such releases are rare.
  const passBudget = sandboxBudget()
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    const runDir = join(root, rec.runId)
    try {
      const nowMs = now().getTime()
      const gone = holderGone(rec, nowMs)
      let sandboxSetBack = false
      if (!rec.releasedAt && gone) {
        const res = releaseRecord(rec, runDir, 'holder-gone', { platform: o.platform, run: o.run, now })
        sandboxSetBack = res.sandboxSetBack
        log(`[containment] ${res.note} (its holder is gone)`)
      }
      const old = nowMs - Date.parse(rec.createdAt) > keepMs
      const holderAlive = rec.holder !== null && pidAlive(rec.holder.pid)
      if (!old || holderAlive) {
        kept++
        continue
      }
      if (!rec.releasedAt) {
        const res = releaseRecord(rec, runDir, 'sweep', { platform: o.platform, run: o.run, now })
        sandboxSetBack = res.sandboxSetBack
        log(`[containment] ${res.note}`)
      }
      // P2-B4: a grant its release could not undo keeps the run folder, with the saved copy the
      // restore needs, until restore-acl has put it back.
      const grantsKept = rec.grantsKept ?? []
      if (grantsKept.length > 0) {
        kept++
        log(`[containment] the sweep keeps ${runDir}: the access list saved before this run's grant on ${grantsKept.map(g => g.folder).join(', ')} was not put back (${grantsKept.map(g => g.aclFile).join(', ')}); put it back with: ${RESTORE_ACL_COMMAND(rec.runId)}`)
        continue
      }
      // NOW.md:78: a sandbox released before its release set it back (or whose set-back failed)
      // is set back now, so the delete below never walks a folder a live low process can rename in.
      // One that cannot be set back is kept, and said, until a later pass can. Wave 15c: one whose
      // release stopped at the set-back budget, or whose set-back here stops at it, is removed as
      // every sandbox was before wave 15: by the listing walk below, which never enters a link.
      // C8 (wave 19): a sandbox its release set back whole holds nothing a low process can rename in.
      if (!sandboxSetBack && rec.sandboxSetBackAt === undefined && (o.platform ?? process.platform) === 'win32') {
        if (rec.sandboxLeftLow) {
          log(`[containment] ${runDir}: its release did not set the sandbox back ${sandboxLeftLowWords(rec.sandboxLeftLow)}; the sweep removes it by its listing, never entering a link`)
        } else if (budgetSpent(passBudget)) {
          kept++
          log(`[containment] the sweep leaves ${runDir} to its next pass: this pass has spent its budget for setting sandboxes back (${SANDBOX_SET_BACK_BUDGET.folders} folders or ${SANDBOX_SET_BACK_BUDGET.ms / 1000} s)`)
          continue
        } else {
          const sb = resetSandboxLabels(o.run, runDir, passBudget)
          if (!sb.ok) {
            kept++
            log(`[containment] the sweep keeps ${runDir}: ${sb.line}`)
            continue
          }
          if (sb.stoppedAfter !== null) log(`[containment] ${runDir}: ${sb.line}`)
        }
      }
      // By the root's listing, not lstat (F4); a run folder whose kind cannot be told is kept.
      const link = isLinkEntry(runDir)
      if (link !== false) {
        log(link
          ? `[containment] ${runDir} is a link; the sweep does not touch it`
          : `[containment] ${runDir} is not in the listing of ${root}, so whether it is a link is not known; the sweep does not touch it`)
        kept++
        continue
      }
      // The record goes last: a run folder whose walk stops part way is still a record, so the next
      // sweep visits it again and says again why it stops, instead of losing sight of it.
      removeTreeNoFollow(runDir, log, undefined, RECORD)
      unlinkSync(join(runDir, RECORD))
      rmdirSync(runDir)
      removed.push(runDir)
      log(`[containment] removed the sandbox ${runDir} (created ${rec.createdAt})`)
    } catch (e) {
      kept++
      log(`[containment] the sweep could not finish ${runDir}: ${(e as Error).message}`)
    }
  }
  return { removed, kept }
}
