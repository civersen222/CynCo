/**
 * engine/integrity.ts: the integrity layer of unattended runs (F242).
 *
 * On 2026-11-22 an unattended mission deleted every dot-folder of the owner's home folder and then
 * the application folders of AppData\Local up to pip, and ran 108 more turns, for 2 hours 10 minutes,
 * before anyone noticed; every record of the run lived in the folder it deleted. This module is what
 * notices, and what stops everything afterwards:
 *
 * - a manifest of the protected folders, in two classes. FROZEN folders (the models, the profiles,
 *   the held-out gates, `.ssh`, the local model store) must not change at all during a run; a
 *   recursive stat-only walk records every entry's kind, size and time. PRESENCE folders (the home
 *   folder's top level, every folder of it and its dot-files; `AppData\Local`, `Roaming`, `LocalLow`
 *   and `Local\Packages`, with an allowance of `APPDATA_LOSS_AT`; the known folders OneDrive holds
 *   (`OneDrive`, counted); the desk tools' folder, the state
 *   folder and its authoring and campaign folders, the top of every volume integrity labels cannot
 *   protect) must not LOSE anything; one listing per folder records names and child counts. Until
 *   2026-11-24 the home was watched by its dot-entries alone, and the walk into `AppData\Local` of
 *   2026-11-22 went unseen. A FROZEN root that is a link or junction is
 *   refused (a protected folder must be a real folder); a folder that was empty at the baseline is
 *   never a loss, in any PRESENCE root.
 * - the baseline pair, keyed by a run id that is used once: the starter takes the baseline before
 *   its engine starts (`takeBaseline`), the early reading compares without closing it
 *   (`compareRun`), and the settling compare after the engine is confirmed dead closes it
 *   (`settleRun`). A compare that cannot be done is a change.
 * - the integrity latch, `<guard>/HALT.json`: written first, create-exclusive, on any change; then
 *   the latch log, then one page per run (kept in `<guard>/unsent/` when it cannot be sent). Every
 *   unattended starter refuses while it exists (`haltRefusal`), and only the owner clears it, at a
 *   terminal (`scripts/cynco-guard.mjs clear`; `clearHalt` itself refuses without a terminal and
 *   the typed word). Anything at that name, a dangling link included, is the latch.
 * - the models hash record, `<guard>/models-hashes.json`, and its cheap check before a run.
 * - the in-run tripwire: a contained engine re-lists its baseline's PRESENCE folders on a timer and
 *   before tool calls, and reports a lost folder once; a loss is remembered for the life of the
 *   process. Volume roots are left out of it: a synchronous listing of a sleeping or failing drive
 *   cannot be bounded and would block the engine's event loop (F225), so the top of every volume is
 *   compared only by the baseline and the settling compare, which the starter runs in its own
 *   process. A loss there still latches, with a page one step below top priority whose text names
 *   the drive and the folder, so the owner can tell their own tidy-up from an attack.
 *
 * Everything persisted is in the guard folder (`guardDir()`, outside the home folder), so nothing
 * that decides "may this run" is read from the home folder. The module creates the guard folder's
 * sub-folders and never the guard folder itself, never unlinks, makes no network call (every pager
 * is a parameter) and starts one process of its own: `reg.exe query` of the user's shell folders, by its
 * full path, read-only, when a baseline that derives its roots reads the known folders of this account's
 * own profile (`knownFolderPlaces`, wave 15). The only other child anything here can cause is the volume
 * listing of `listUnprotectedVolumes`, owned by engine/containment.ts. Which profile is this account's
 * is asked of the system through bun:ffi under Bun (`systemProfileHome`), no process; so is the serial
 * of a volume the listing does not name, read with `stat` at its letter (`volumeSerialAt`, wave 15c).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  opendirSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname, uptime, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { cyncoHome, guardDir, guardDirSource, modelsDir, sandboxRoot } from './paths.js'
import { isInside, realPathOf } from './realPath.js'
import { RUN_ID_RE } from './missionEnv.js'
import { listUnprotectedVolumes } from './containment.js'
import type { RunContainment } from './containment.js'

// ─── Constants and types ─────────────────────────────────────────────────────────────────────

export const LATCH_FILE = 'HALT.json'
export const GUARD_CLEAR_COMMAND = 'bun scripts/cynco-guard.mjs clear'
/** Names that come and go by themselves; never recorded, in either class. */
export const TRANSIENT_NAME = /\.(tmp|temp|lock|swp|part)(\.|$)|~$/i
/** Folders a FROZEN walk does not enter: the harness's own gate runs write bytecode beside the gates,
 *  and any `git status` in the held-out repository rewrites .git/index. */
export const FROZEN_SKIP_DIRS: readonly string[] = ['__pycache__', '.git']
/** Entries at the top of a volume that Windows itself manages. */
export const VOLUME_SKIP = /^(\$.*|System Volume Information)$/i
/** What the model is told. It names no path: a lost folder can be one the model may not learn the name of. */
export const INTEGRITY_LOSS_TO_MODEL =
  'a protected folder on this machine was lost, or the integrity latch was set, while this run was working'

/**
 * A baseline that cannot be taken, or a FROZEN folder that cannot be walked. `kind` is `refusal`
 * when the cause is the latch, an unusable guard folder or the models record (the sentence is the
 * refusal itself), and `baseline` for every other cause.
 */
export class ManifestError extends Error {
  kind: 'refusal' | 'baseline'
  constructor(message: string, kind: 'refusal' | 'baseline' = 'baseline') {
    super(message)
    this.name = 'ManifestError'
    this.kind = kind
  }
}

export interface FrozenRoot { path: string; mutable: string[] }
export interface PresenceRoot {
  path: string
  dotOnly: boolean     // only entries whose name starts with a dot
  files: boolean       // record files by name as well as folders
  counts: boolean      // record each folder's number of direct children
  volume: boolean      // the top of a volume integrity labels cannot protect
  network: boolean     // a mapped network drive: never listed by the in-run tripwire
  // The three below came with wave 8 (2026-11-24); a baseline written before it has none, which reads as false or empty.
  filesDotOnly?: boolean   // with `files`: record a file only when its name starts with a dot (the home's top level)
  application?: boolean    // an application folder of the profile: fewer than APPDATA_LOSS_AT entries lost in a run are notes
  uncounted?: string[]     // with `counts`: folders of this root recorded by name only (`n: null`), never opened
  // Wave 15 (2026-11-24): absent in a baseline written before it, and for a volume Windows gave no serial for.
  serial?: string          // with `volume`: the volume's VolumeSerialNumber at the baseline; another volume at the letter is not compared
}

/**
 * In an application root (AppData\Local, Roaming, LocalLow, Local\Packages), the number of its entries
 * gone or emptied in one run at which that is a loss; fewer are written as notes. Applications add and
 * remove a folder of their own now and then (an updater dropping its cache, a package removed by a Store
 * update), and one or two such in a run of hours must not stop every unattended run until the owner
 * clears the latch at a terminal. The walk of 2026-11-22 took about twenty top-level folders of
 * AppData\Local and 96 of the 110 package folders, far above it. The cost: a deletion of one or two
 * application folders per root, per run, latches nothing, and an application's whole state is one
 * entry (the browser profile under Roaming gone whole is a note); LocalLow, which a contained process
 * can write, has the same allowance. A root gone whole is always a loss, and the owner's own folders
 * at the home's top level have no allowance.
 */
export const APPDATA_LOSS_AT = 3
export interface Roots { frozen: FrozenRoot[]; presence: PresenceRoot[] }

export type FrozenEntry = [rel: string, kind: 'f' | 'd' | 'l', size: number, mtimeMs: number, target?: string]
export interface FrozenSection { root: string; exists: boolean; entries: FrozenEntry[] }
export interface PresenceSection {
  root: string; exists: boolean; listed: boolean
  entries: Record<string, { k: 'f' | 'd' | 'l'; n: number | null }>
}

export interface Manifest {
  schema: 1
  runId: string
  takenAt: string                     // ISO, millisecond precision
  by: string
  /** The process that will settle this baseline, when the starter named one (an in-process starter: the daemon, ideation). */
  holder?: { pid: number; host: string } | null
  /** After this time the run is over by its own limit, so a baseline still open is an orphan (ISO). */
  deadline?: string | null
  home: string
  exclude: string[]                   // real paths: the mission folder and the run's extra roots
  roots: Roots                        // stored; every compare walks THESE, never roots recomputed from the environment
  frozen: FrozenSection[]
  presence: PresenceSection[]
  notes: string[]                     // e.g. 'D:\\: could not be listed (detached or asleep); not compared'
}

export interface Change {
  class: 'FROZEN' | 'PRESENCE'
  root: string
  path: string
  kind: 'added' | 'removed' | 'modified' | 'kind-changed' | 'gone' | 'emptied' | 'root-gone' | 'root-appeared'
  detail?: string
  /** Set on a change at the top of a volume integrity labels cannot protect (the owner's own drives). */
  volume?: boolean
  /** Set on a change in an application root (AppData), so the owner's summary can say so. */
  application?: boolean
}

export interface Compare {
  run: string; at: string; by: string
  kind: 'reading' | 'settle'
  settled: boolean                    // true: the baseline is closed
  from: 'live' | 'recorded'
  changed: boolean
  changes: Change[]                   // at most 200, FROZEN first, each class sorted by path
  changeCount: number                 // the true total
  /** Entries lost in an application root below APPDATA_LOSS_AT: not changes; each is also in `notes`. */
  allowed?: string[]
  summary: string                     // for the owner: names the first path
  publicSummary: string               // for records that are committed or shown to a model: names no path
  firstClass: 'FROZEN' | 'PRESENCE' | null
  firstRoot: string | null
  entries: number; ms: number
  notes: string[]
  latchPath: string | null            // set when THIS compare wrote, or met, the integrity latch because of what it found
  notConfirmedDead?: string
  error?: string
}

export type LatchReason = 'integrity-change' | 'presence-lost' | 'manifest-error' | 'engine-not-confirmed-dead'
export interface Latch {
  schema: 1; at: string; by: string; pid: number; host: string
  run: string; reason: LatchReason; detail: string | null
  campaignId: string | null; wave: number | null; cwd: string | null
  summary: string; publicSummary: string
  changeCount: number; changes: Change[]        // the first 50
  baseline: string | null                       // path of the tripped baseline, when there is one
}

export interface Page { title: string; message: string; priority: number }
export type Pager = (p: Page) => Promise<boolean>

export interface ModelsRecord {
  schema: 1; taken: string
  root: string                                  // absolute, forward slashes
  files: Array<{ rel: string; bytes: number; mtimeMs: number; sha256: string }>
}

type Volume = { root: string; kind: 'local' | 'removable' | 'network'; serial?: string | null }
type Context = { campaignId?: string; wave?: number; cwd?: string }

const MAX_CHANGES = 200
const LATCH_CHANGES = 50
const DEFAULT_CONFIRM_MS = 2000
/** A baseline whose starter named no time limit is an orphan after a day. */
const DEFAULT_MAX_RUN_MS = 24 * 3_600_000
/** A baseline taken more than this before the machine started is from before the restart (uptime is coarse). */
const BOOT_SLACK_MS = 60_000
const PAGE_TITLE = 'CynCo integrity latch'
/** A latch whose every change is at the top of an unprotected drive: high, one step below a loss of the home. */
const PAGE_PRIORITY = 5
const VOLUME_PAGE_PRIORITY = 4
/** How long `tripHalt` waits before reading an existing latch a second time (it may be mid-write). */
const LATCH_REREAD_MS = 50
/** The target text of a link whose target could not be read; never equal to anything at a compare. */
const UNREADABLE_TARGET = '(unreadable: '
const COMPARE_FAILED_PUBLIC = 'the integrity check could not be completed'
const PRESENCE_FAILED_PUBLIC = 'the presence check could not be completed'
const NOT_SENT_FALSE = 'the sender returned false: no CYNCO_NTFY_URL in this process, or ntfy did not accept it'

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────

const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e))
const textOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isMissing = (e: unknown): boolean => { const c = (e as NodeJS.ErrnoException)?.code; return c === 'ENOENT' || c === 'ENOTDIR' }

/** A path as a comparison key: resolved, no trailing separator, case folded on Windows. */
function keyOf(p: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? r.toLowerCase() : r
}

/** `YYYYMMDDTHHMMSS` in UTC. */
function stampOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').slice(0, 15)
}

/** `<dir>/<name>` with the folder as it was given, for sentences. */
const shown = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

function syncSleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Creates `<guard>/<sub>` when missing; never the guard folder itself, and never writes through a link. */
function ensureSub(guard: string, sub: string): string {
  const p = join(guard, sub)
  try {
    mkdirSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const st = lstatSync(p)
    if (st.isSymbolicLink()) throw new Error(`${p} is a link; nothing is written through it`)
    if (!st.isDirectory()) throw new Error(`${p} is not a folder`)
  }
  return p
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

const beforePath = (guard: string, runId: string) => join(guard, 'manifests', `${runId}.before.json`)
const BEFORE_SUFFIX = '.before.json'

// ─── protectedRoots ──────────────────────────────────────────────────────────────────────────

/** The protected folders. The only place their real paths are named. Pure. */
export function protectedRoots(o: {
  home?: string; cynco?: string; models?: string
  volumes?: Array<{ root: string; kind: 'local' | 'removable' | 'network'; serial?: string | null }>
} = {}): Roots {
  const home = resolve(o.home ?? homedir())
  // The default state folder AND the redirected one: a campaign under a redirected CYNCO_HOME must
  // not drop cover of the real profiles and held-out folders (entry 4.M6).
  const states: string[] = []
  for (const s of [join(home, '.cynco'), o.cynco ?? cyncoHome()]) {
    if (!states.some(x => keyOf(x) === keyOf(s))) states.push(resolve(s))
  }
  const frozen: FrozenRoot[] = []
  const presence: PresenceRoot[] = []
  const addF = (path: string, mutable: string[] = []) => {
    if (!frozen.some(r => keyOf(r.path) === keyOf(path))) frozen.push({ path: resolve(path), mutable })
  }
  const addP = (path: string, opts: Partial<Omit<PresenceRoot, 'path'>>) => {
    if (presence.some(r => keyOf(r.path) === keyOf(path))) return
    presence.push({ path: resolve(path), dotOnly: false, files: false, counts: false, volume: false, network: false, ...opts })
  }
  addF(o.models ?? modelsDir())
  for (const s of states) { addF(join(s, 'profiles')); addF(join(s, 'heldout')) }
  addF(join(home, '.ssh'), ['known_hosts', 'known_hosts.old'])
  // The home's whole top level (wave 8): every folder by name with its child count, dot or not, so a
  // project folder or AppData gone or emptied is a loss; files by dot-name only, because the registry
  // hive and its logs (NTUSER.DAT and the like) come and go at the top level by themselves.
  addP(home, { files: true, filesDotOnly: true, counts: true })
  // The application folders of the profile (wave 8): on 2026-11-22 the same call that deleted the
  // dot-folders walked AppData\Local in alphabetical order and deleted what was not held open.
  // Top-level folders by name with child counts; the packages folder one level further, by name.
  // In AppData\Local two folders by name only: Temp (290,546 entries on this PC on 2026-11-24, most of
  // every walk's time, and turnover by nature) and D3DSCache (the shader cache); Windows' own cleanup
  // (Storage Sense is on here) empties both, which would spend the allowance before any application.
  addP(join(home, 'AppData', 'Local'), { counts: true, application: true, uncounted: ['Temp', 'D3DSCache'] })
  for (const sub of ['Roaming', 'LocalLow']) addP(join(home, 'AppData', sub), { counts: true, application: true })
  addP(join(home, 'AppData', 'Local', 'Packages'), { application: true })
  // The known folders OneDrive holds (wave 8 review): on this PC Desktop, Documents and Pictures are
  // redirected to OneDrive\Desktop, \Documents and \Pictures, one level below the home's top level.
  // Counted, no allowance; a root that does not exist is recorded as absent and never compared.
  addP(join(home, 'OneDrive'), { counts: true })
  // The local model store: loss only, counted. Nothing CynCo loads comes from it, and processes outside
  // any run (a model pull, the owner's other apps, the store's own migration on update) add to it while
  // a daemon task runs; as a FROZEN root every such addition latched at top priority (review of wave 5).
  addP(join(home, '.ollama', 'models'), { counts: true })
  // the desk tools' own folder: its sub-folders by name; its owner program prunes several of them by age, so no counts
  addP(join(home, '.claude'), {})
  for (const s of states) { addP(join(s, 'authoring'), { counts: true }); addP(join(s, 'campaigns'), { counts: true }) }
  for (const s of states) addP(s, {})
  // Counted, so a top-level folder emptied in place (D:\DCIM after its sub-folders went) is seen.
  // Keyed by its serial number when Windows gives one (wave 15): another volume at the same letter is not this one.
  for (const v of o.volumes ?? []) {
    addP(v.root, { files: true, counts: true, volume: true, network: v.kind === 'network', ...(typeof v.serial === 'string' && v.serial !== '' ? { serial: v.serial } : {}) })
  }
  return { frozen, presence }
}

// ─── The known folders where Windows says they are (wave 15, NOW.md:66) ─────────────────────

/** The values of User Shell Folders that name the folders a person keeps their own files in. */
const KNOWN_FOLDER_VALUES = ['Desktop', 'Personal', 'My Pictures']
const ONEDRIVE_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

/** `reg.exe query` of the user's shell folders, by its full path; read-only, five seconds at most. */
function queryShellFolders(): string {
  const exe = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'reg.exe')
  const r = spawnSync(exe, ['query', SHELL_FOLDERS_KEY], { encoding: 'utf-8', timeout: 5_000, windowsHide: true })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`reg.exe exited ${String(r.status)}${r.stderr ? `: ${r.stderr.trim()}` : ''}`)
  return r.stdout
}

/**
 * The profile folder of this process's own account, as the system reports it, whatever the
 * environment says; null when it cannot be read (wave 15b, check P1-C2). Under Bun on Windows
 * `os.userInfo().homedir` and `os.homedir()` follow USERPROFILE (measured: with USERPROFILE set to a
 * fake folder Bun answered the fake folder and Node the real profile), so under Bun it asks
 * userenv.dll's GetUserProfileDirectoryW for the current process token (the pseudo handle -4), the
 * call the acceptance's `systemHome` makes; elsewhere `os.userInfo().homedir`, which Node takes from
 * that same call on Windows. Synchronous: bun:ffi is loaded through `createRequire`, by a computed
 * name so the suite's Node-side module graph never tries to resolve it. Never throws.
 */
export function systemProfileHome(): string | null {
  const bun = (globalThis as { Bun?: { version?: unknown } }).Bun
  if (process.platform === 'win32' && typeof bun?.version === 'string') {
    try {
      const ffiModule = 'bun:ffi'
      const ffi = createRequire(import.meta.url)(ffiModule) as {
        dlopen: (lib: string, s: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, (...a: unknown[]) => number>; close: () => void }
        FFIType: Record<string, unknown>
      }
      const lib = ffi.dlopen('userenv.dll', { GetUserProfileDirectoryW: { args: [ffi.FFIType.i64, ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 } })
      try {
        const size = new Uint32Array([1024])
        const buf = new Uint16Array(1024)
        if (!lib.symbols.GetUserProfileDirectoryW!(-4n, buf, size) || size[0]! < 2 || size[0]! > 1024) return null
        return String.fromCharCode(...buf.subarray(0, size[0]! - 1))
      } finally {
        lib.close()
      }
    } catch {
      return null
    }
  }
  try {
    return userInfo().homedir
  } catch {
    return null
  }
}

/**
 * Where the known folders really are: when the home is this account's own profile (the system's
 * answer, `profile`, default `systemProfileHome`, never `homedir()`, which follows USERPROFILE; a
 * caller may pass `system` instead), Desktop, Documents and Pictures from User Shell Folders and the
 * OneDrive folders the environment names, each only when it lies inside the home (a value that names
 * a folder outside it is a note: the registry and the variables are this account's, the home may be a
 * folder a test or a rehearsal repointed them at); for any home, every folder of its top level whose
 * name starts with `OneDrive - ` (an organisation's OneDrive). Impure, beside the pure
 * `protectedRoots`: it reads the system's answer, the registry (`query`, default `reg.exe`), the
 * environment and the home's top level. Never throws; what it cannot read is a note. Only Windows has
 * a registry: elsewhere the environment is read alone.
 */
export function knownFolderPlaces(o: {
  home: string; system?: boolean; profile?: () => string | null
  env?: Record<string, string | undefined>; query?: () => string; notes: string[]
}): string[] {
  const env = o.env ?? process.env
  const home = resolve(o.home)
  const out: string[] = []
  const add = (p: string) => { const r = resolve(p); if (!out.some(x => keyOf(x) === keyOf(r))) out.push(r) }
  let system = o.system
  if (system === undefined) {
    let profile: string | null = null
    try { profile = (o.profile ?? systemProfileHome)() } catch { profile = null }
    if (profile === null || profile === '') {
      system = false
      o.notes.push('the profile of this account could not be read from the system; the known folders are not read from the registry or the environment')
    } else if (keyOf(resolve(profile)) !== keyOf(home)) {
      system = false
      o.notes.push(`the home ${home} is not the profile of this account (${profile}); its known folders are not read from the registry or the environment`)
    } else {
      system = true
    }
  }
  if (system) {
    if (o.query || process.platform === 'win32') {
      let text = ''
      try {
        text = (o.query ?? queryShellFolders)()
      } catch (e) {
        o.notes.push(`the known folders could not be read from the registry (${textOf(e)}); the defaults are watched`)
      }
      const vars = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s+(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+?)\s*$/.exec(line)
        if (!m || !KNOWN_FOLDER_VALUES.includes(m[1]!)) continue
        let unset = false
        const value = m[2]!.replace(/%([^%]+)%/g, (_, name: string) => {
          const v = vars.get(name.toLowerCase())
          if (typeof v !== 'string' || v === '') { unset = true; return '' }
          return v
        })
        if (unset) { o.notes.push(`the known folder ${m[1]} (${m[2]}) names a variable that is not set here; not watched`); continue }
        if (!isAbsolute(value)) { o.notes.push(`the known folder ${m[1]} (${m[2]}) is not an absolute path; not watched`); continue }
        if (!isInside(home, value)) { o.notes.push(`the known folder ${m[1]} (${value}) is outside the home ${home}; not watched`); continue }
        add(value)
      }
    }
    for (const k of ONEDRIVE_VARS) {
      const v = env[k]
      if (typeof v !== 'string' || v === '' || !isAbsolute(v)) continue
      if (!isInside(home, v)) { o.notes.push(`the variable ${k} (${v}) names a folder outside the home ${home}; not watched`); continue }
      add(v)
    }
  }
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('OneDrive - ')) add(join(home, e.name))
    }
  } catch (e) {
    o.notes.push(`${home}: its top level could not be listed for its OneDrive folders (${codeOf(e)})`)
  }
  return out
}

/** The drive of a path, upper case (`C:`), or the share of a UNC path, lower case. */
const driveOf = (p: string) => {
  const r = resolve(p)
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(r)
  return unc ? unc[0].toLowerCase() : r.slice(0, 2).toUpperCase()
}

/**
 * The roots with the known folders added (wave 15, NOW.md:66). A place that is already a PRESENCE
 * root, or a folder directly inside a counted one (whose child count that root keeps already: the home
 * itself, `OneDrive`), adds nothing, unless it is a OneDrive folder (`OneDrive - <organisation>`),
 * whose own children are the known folders. Any other place on the home's drive becomes a counted PRESENCE
 * root, no allowance, so a folder of it gone or emptied is a loss. A place on another drive or a share
 * is a note and not watched: a listing of a drive that sleeps cannot be bounded on the engine's event
 * loop, and the settle has no rule for a known folder that is detached. Pure.
 */
export function withKnownFolders(roots: Roots, places: string[], home: string, notes: string[]): Roots {
  const presence = [...roots.presence]
  for (const raw of places) {
    const p = resolve(raw)
    if (presence.some(r => keyOf(r.path) === keyOf(p))) continue
    // A OneDrive folder holds known folders, so its own children are counted, as `OneDrive`'s are.
    const holdsKnownFolders = /^OneDrive( - |$)/i.test(basename(p))
    if (!holdsKnownFolders && presence.some(r => r.counts && !r.dotOnly && !r.volume && keyOf(dirname(p)) === keyOf(r.path))) continue
    if (driveOf(p) !== driveOf(home)) {
      notes.push(`the known folder ${raw} is not on the home's drive; not watched (a drive that sleeps cannot be listed within a bound)`)
      continue
    }
    presence.push({ path: p, dotOnly: false, files: false, counts: true, volume: false, network: false })
  }
  return { frozen: roots.frozen, presence }
}

// ─── takeManifest ────────────────────────────────────────────────────────────────────────────

/** The excluded real paths that touch `realRoot` (inside it, or holding it). */
function excludesFor(realRoot: string, exclude: string[]): string[] {
  return exclude.filter(x => isInside(realRoot, x) || isInside(x, realRoot))
}

function walkFrozen(r: FrozenRoot, exclude: string[], notes: string[]): FrozenSection {
  const out: FrozenSection = { root: r.path, exists: false, entries: [] }
  let st: Stats
  try {
    st = lstatSync(r.path)
  } catch (e) {
    if (isMissing(e)) return out
    throw new ManifestError(`the frozen folder ${r.path} cannot be read (${codeOf(e)})`)
  }
  if (st.isSymbolicLink()) {
    // Everything behind a link would go unwatched, and a retarget would hide a replaced folder.
    let target: string
    try { target = readlinkSync(r.path) } catch (e) { target = `(a target that cannot be read: ${codeOf(e)})` }
    throw new ManifestError(`the frozen folder ${r.path} is a link to ${target}; a protected folder must be a real folder`)
  }
  if (!st.isDirectory()) throw new ManifestError(`the protected folder ${r.path} exists but is not a folder`)
  const realRoot = realPathOf(r.path, { quiet: true })
  const ex = excludesFor(realRoot, exclude)
  if (ex.some(x => isInside(x, realRoot))) {
    notes.push(`${r.path}: inside an excluded folder; not compared`)
    return out
  }
  out.exists = true
  const walk = (abs: string, rel: string) => {
    let names: string[]
    try {
      names = readdirSync(abs)
    } catch (e) {
      throw new ManifestError(`the frozen folder ${abs} cannot be read (${codeOf(e)})`)
    }
    names.sort()
    for (const name of names) {
      if (TRANSIENT_NAME.test(name)) continue
      const childRel = rel ? `${rel}/${name}` : name
      const childAbs = join(abs, name)
      if (ex.length > 0 && ex.some(x => isInside(x, join(realRoot, childRel)))) continue
      let s: Stats
      try {
        s = lstatSync(childAbs)
      } catch (e) {
        // Gone between the listing and the look: the next walk sees it gone.
        if (isMissing(e)) continue
        throw new ManifestError(`the frozen entry ${childAbs} cannot be read (${codeOf(e)})`)
      }
      if (s.isSymbolicLink()) {
        let target: string
        try { target = readlinkSync(childAbs) } catch (e) { target = `${UNREADABLE_TARGET}${codeOf(e)})` }
        out.entries.push([childRel, 'l', 0, 0, target])
      } else if (s.isDirectory()) {
        if (FROZEN_SKIP_DIRS.includes(name)) continue
        out.entries.push([childRel, 'd', 0, 0])
        walk(childAbs, childRel)
      } else {
        out.entries.push([childRel, 'f', s.size, s.mtimeMs])
      }
    }
  }
  walk(r.path, '')
  return out
}

function kindOf(s: Stats | Dirent): 'f' | 'd' | 'l' {
  return s.isSymbolicLink() ? 'l' : s.isDirectory() ? 'd' : 'f'
}

/** True when the folder holds nothing but transient or excluded names; reads only until the first other entry. */
function isEmptyDir(abs: string, realDir: string, excluded: (p: string) => boolean): boolean {
  const d = opendirSync(abs)
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (TRANSIENT_NAME.test(e.name) || excluded(join(realDir, e.name))) continue
      return false
    }
    return true
  } finally {
    d.closeSync()
  }
}

/**
 * One listing of a PRESENCE root and one look into each folder in it: where `counts` is on, its
 * children are counted; elsewhere it is only asked whether it is empty (`n: 0`) or not (`n: null`).
 * A folder with no children is recorded with `n: 0` and never compared, in every root, which is how
 * "an empty folder that disappears is not a loss" is kept while a folder that is still there at the
 * compare is still seen. A folder the root names in `uncounted` is never looked into: it is
 * recorded with `n: null`, its name and kind only, at every listing.
 */
function listPresence(r: PresenceRoot, exclude: string[], notes: string[]): PresenceSection {
  const out: PresenceSection = { root: r.path, exists: false, listed: true, entries: {} }
  const unlisted = (why: string): PresenceSection => {
    notes.push(`${r.path}: could not be listed (${why}; detached or asleep); not compared`)
    return { ...out, listed: false }
  }
  let st: Stats
  try {
    st = lstatSync(r.path)
    if (st.isSymbolicLink()) {
      notes.push(`${r.path}: is a link; listed through it`)
      st = statSync(r.path)
    }
  } catch (e) {
    if (r.volume) return unlisted(codeOf(e))
    if (isMissing(e)) return out
    throw new ManifestError(`the protected folder ${r.path} cannot be read (${codeOf(e)})`)
  }
  if (!st.isDirectory()) {
    if (r.volume) return unlisted('not a folder')
    throw new ManifestError(`the protected folder ${r.path} exists but is not a folder`)
  }
  let listed: Dirent[]
  try {
    listed = readdirSync(r.path, { withFileTypes: true })
  } catch (e) {
    if (r.volume) return unlisted(codeOf(e))
    throw new ManifestError(`the protected folder ${r.path} cannot be listed (${codeOf(e)})`)
  }
  out.exists = true
  const realRoot = realPathOf(r.path, { quiet: true })
  const ex = excludesFor(realRoot, exclude)
  const excluded = (p: string) => ex.length > 0 && ex.some(x => isInside(x, p))
  const byNameOnly = new Set((Array.isArray(r.uncounted) ? r.uncounted : []).map(n => n.toLowerCase()))
  for (const dirent of listed.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const name = dirent.name
    if (r.dotOnly && !name.startsWith('.')) continue
    if (TRANSIENT_NAME.test(name)) continue
    if (r.volume && VOLUME_SKIP.test(name)) continue
    const realChild = join(realRoot, name)
    if (excluded(realChild)) continue
    let k: 'f' | 'd' | 'l'
    let looked = true
    try {
      k = kindOf(lstatSync(join(r.path, name)))
    } catch (e) {
      if (isMissing(e)) continue
      // Its existence is still a fact worth keeping: recorded with the kind the listing gave.
      notes.push(`${join(r.path, name)}: could not be looked at (${codeOf(e)}); recorded by its listed kind`)
      k = kindOf(dirent)
      looked = false
    }
    if (k === 'f' && (!r.files || (r.filesDotOnly === true && !name.startsWith('.')))) continue
    let n: number | null = null
    if (k === 'd' && looked && !byNameOnly.has(name.toLowerCase())) {
      try {
        n = r.counts
          ? readdirSync(join(r.path, name)).filter(c => !TRANSIENT_NAME.test(c) && !excluded(join(realChild, c))).length
          : (isEmptyDir(join(r.path, name), realChild, excluded) ? 0 : null)
      } catch (e) {
        notes.push(`${join(r.path, name)}: its children could not be ${r.counts ? 'counted' : 'listed'} (${codeOf(e)})`)
        n = null
      }
    }
    out.entries[name] = { k, n }
  }
  return out
}

/** Read-only: `lstat`, `readdir` and a directory handle only; never opens a file, never follows a link or junction. */
export function takeManifest(roots: Roots, o: {
  runId: string; by: string; home: string; exclude?: string[]; now?: () => Date
  holder?: { pid: number; host: string } | null; maxRunMs?: number | null
}): Manifest {
  const t = (o.now ?? (() => new Date()))()
  const takenAt = t.toISOString()
  const exclude = (o.exclude ?? []).map(p => realPathOf(p, { quiet: true }))
  const notes: string[] = []
  const frozen = roots.frozen.map(r => walkFrozen(r, exclude, notes))
  const presence = roots.presence.map(r => listPresence(r, exclude, notes))
  // holder and deadline come right after `by`: openBaselines reads them from the file's first kilobytes.
  const deadline = typeof o.maxRunMs === 'number' && Number.isFinite(o.maxRunMs) && o.maxRunMs > 0
    ? new Date(t.getTime() + o.maxRunMs).toISOString() : null
  return { schema: 1, runId: o.runId, takenAt, by: o.by, holder: o.holder ?? null, deadline, home: o.home, exclude, roots, frozen, presence, notes }
}

// ─── compareManifests ────────────────────────────────────────────────────────────────────────

const unreadableTarget = (t: string | undefined) => typeof t === 'string' && t.startsWith(UNREADABLE_TARGET)

function diffFrozen(before: Manifest, after: Manifest): Change[] {
  const changes: Change[] = []
  const afterBy = new Map(after.frozen.map(f => [keyOf(f.root), f]))
  for (const b of before.frozen) {
    const a = afterBy.get(keyOf(b.root)) ?? { root: b.root, exists: false, entries: [] }
    if (b.exists && !a.exists) { changes.push({ class: 'FROZEN', root: b.root, path: '', kind: 'root-gone' }); continue }
    if (!b.exists && a.exists) { changes.push({ class: 'FROZEN', root: b.root, path: '', kind: 'root-appeared' }); continue }
    if (!b.exists) continue
    const mutable = new Set(before.roots.frozen.find(r => keyOf(r.path) === keyOf(b.root))?.mutable ?? [])
    const bm = new Map(b.entries.map(e => [e[0], e]))
    const am = new Map(a.entries.map(e => [e[0], e]))
    for (const [rel, e] of bm) {
      const x = am.get(rel)
      if (!x) { changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'removed' }); continue }
      if (mutable.has(rel)) continue
      if (x[1] !== e[1]) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'kind-changed', detail: `${e[1]} -> ${x[1]}` })
      else if (e[1] === 'f' && x[2] !== e[2]) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'modified', detail: `size ${e[2]} -> ${x[2]}` })
      else if (e[1] === 'f' && x[3] !== e[3]) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'modified', detail: 'time' })
      else if (e[1] === 'l' && (unreadableTarget(e[4]) || unreadableTarget(x[4]))) {
        // A target that could not be read is never equal to anything: a retarget must not hide behind it.
        changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'modified', detail: 'link target cannot be read' })
      } else if (e[1] === 'l' && x[4] !== e[4]) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'modified', detail: 'link target' })
    }
    for (const rel of am.keys()) {
      if (!bm.has(rel) && !mutable.has(rel)) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'added' })
    }
  }
  return changes
}

/**
 * PRESENCE, loss only. P1 a root gone (never for a volume), P2 a recorded entry gone or of another
 * kind, P3 a counted folder down to none (from one child or more), or to fewer than half of its
 * children and by at least two, or whose children (two or more at the baseline) can no longer be
 * counted. Until the wave 8 review P3 needed two children at the baseline, and a one-child folder
 * emptied passed: 19 of the 35 top-level folders of AppData\Local here hold one child. One of two
 * gone is still not seen. A folder empty at the baseline is never compared. With `dirsOnly` (the
 * tripwire) P2 looks at folders only. In an application root, P2 and P3 together below
 * APPDATA_LOSS_AT are not changes: each goes to `allowed` and to `notes`.
 */
function diffPresence(before: PresenceSection[], after: PresenceSection[], roots: PresenceRoot[], notes: string[], dirsOnly = false, allowed: string[] = []): Change[] {
  const all: Change[] = []
  const afterBy = new Map(after.map(p => [keyOf(p.root), p]))
  const optsBy = new Map(roots.map(r => [keyOf(r.path), r]))
  for (const b of before) {
    if (!b.exists || !b.listed) continue
    const opts = optsBy.get(keyOf(b.root))
    const a = afterBy.get(keyOf(b.root))
    if (!a || !a.listed) { notes.push(`${b.root}: could not be listed at the compare; not compared`); continue }
    if (!a.exists) {
      if (opts?.volume) { notes.push(`${b.root}: is not attached at the compare; not compared`); continue }
      // A root gone whole is a loss in every root, an application root included.
      all.push({ class: 'PRESENCE', root: b.root, path: '', kind: 'root-gone' })
      continue
    }
    const changes: Change[] = []
    const vol = opts?.volume ? { volume: true } : {}
    const app = opts?.application === true ? { application: true } : {}
    for (const [name, e] of Object.entries(b.entries)) {
      if (e.k === 'd' && e.n === 0) continue
      if (dirsOnly && e.k !== 'd') continue
      const x = a.entries[name]
      if (!x || x.k !== e.k) {
        // On a volume the detail names what was there, for a sentence the owner can read.
        const noun = e.k === 'd' ? 'folder' : e.k === 'l' ? 'link' : 'file'
        changes.push({ class: 'PRESENCE', root: b.root, path: name, kind: 'gone', ...(opts?.volume ? { detail: noun, volume: true } : {}), ...app })
        continue
      }
      if (opts?.counts && e.k === 'd' && e.n !== null && e.n >= 1) {
        if (x.n === null) {
          if (e.n >= 2) changes.push({ class: 'PRESENCE', root: b.root, path: name, kind: 'emptied', detail: `${e.n} -> uncountable`, ...vol, ...app })
        } else if (x.n === 0 || (x.n < e.n / 2 && e.n - x.n >= 2)) {
          changes.push({ class: 'PRESENCE', root: b.root, path: name, kind: 'emptied', detail: `${e.n} -> ${x.n}`, ...vol, ...app })
        }
      }
    }
    if (opts?.application === true && changes.length > 0 && changes.length < APPDATA_LOSS_AT) {
      for (const c of changes) {
        const note = `${described(c)}: an application folder; fewer than ${APPDATA_LOSS_AT} lost in this root, so a note and not a loss`
        allowed.push(note)
        notes.push(note)
      }
      continue
    }
    all.push(...changes)
  }
  return all
}

type Diff = Pick<Compare, 'changed' | 'changes' | 'changeCount' | 'summary' | 'publicSummary' | 'firstClass' | 'firstRoot' | 'notes' | 'allowed'>

/** No kind: a path that differs from the baseline on both walks is a change in whatever form. */
const changeKey = (c: Change) => `${c.class}|${keyOf(c.root)}|${c.path}`
const sortKey = (c: Change) => `${c.class === 'FROZEN' ? 0 : 1}|${c.root}|${c.path}`

/** One change in words. A change at the top of a drive names the drive and the entry plainly. */
function described(c: Change): string {
  if (c.volume) {
    const drive = c.root.replace(/[\\/]+$/, '') + '\\'
    if (c.kind === 'gone') return `drive ${drive}, top-level ${c.detail ?? 'entry'} "${c.path}" gone`
    if (c.kind === 'emptied') return `drive ${drive}, top-level folder "${c.path}" emptied (${c.detail})`
  }
  const where = c.path ? `${c.root}/${c.path}` : c.root
  return `${c.class} ${where} ${c.kind}${c.detail ? ` (${c.detail})` : ''}`
}

/** Every change is known and is at the top of a drive integrity labels cannot protect. */
function onlyVolumeChanges(c: { changes: Change[]; changeCount: number }): boolean {
  return c.changes.length > 0 && c.changes.length === c.changeCount && c.changes.every(x => x.volume === true)
}

function finish(all: Change[], notes: string[], allowed: string[] = []): Diff {
  const sorted = [...all].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0))
  const first = sorted[0]
  if (!first) {
    return { changed: false, changes: [], changeCount: 0, summary: 'no change in protected folders', publicSummary: 'no change in protected folders', firstClass: null, firstRoot: null, notes, allowed }
  }
  const n = sorted.length
  const volumeOnly = sorted.every(c => c.volume === true)
  // The owner's own tidy-up or edit while a run was open latches like an attack; the page says so.
  const models = sorted.some(c => c.class === 'FROZEN' && keyOf(c.root) === keyOf(modelsDir()))
    ? '; a change in the models folder also needs: bun scripts/cynco-guard.mjs hash-models' : ''
  // The owner did not make an updater's change, so "your own change" does not fit there: say what
  // tells an application's own change from a walk (wave 8 review), when nothing else changed.
  const applicationOnly = sorted.every(c => c.application === true)
    ? `. Here every change is an application folder under AppData, beyond the ${APPDATA_LOSS_AT - 1} a run may lose from one of AppData\\Local, Roaming, LocalLow or Local\\Packages: an application's own updater or uninstaller can do that, a walk deletes many in alphabetical order; cynco-guard.mjs status lists the changes, and the run's tool-call audit (a file a day in the audit folder, by run id) shows whether a call of the run named them`
    : ''
  return {
    changed: true,
    changes: sorted.slice(0, MAX_CHANGES),
    changeCount: n,
    summary: volumeOnly
      ? `${n} change(s) in protected folders, all at the top of drives without integrity labels; first: ${described(first)}. If you removed or emptied it yourself while a run was open, this is your own change, not an attack: look at the drive, then clear the latch`
      : `${n} change(s) in protected folders; first: ${described(first)}. If you changed it yourself while a run was open (open runs: bun scripts/cynco-guard.mjs status), it is your own change: clear the latch, and the next run's baseline takes the folders as they are then${models}${applicationOnly}`,
    publicSummary: volumeOnly
      ? `${n} change(s) at the top of drives without integrity labels (first: ${first.class})`
      : `${n} change(s) in protected folders (first: ${first.class})`,
    firstClass: first.class,
    firstRoot: first.root,
    notes,
    allowed,
  }
}

function diffAll(before: Manifest, after: Manifest): { changes: Change[]; notes: string[]; allowed: string[] } {
  const notes = [...after.notes]
  const allowed: string[] = []
  const changes = [...diffFrozen(before, after), ...diffPresence(before.presence, after.presence, before.roots.presence, notes, false, allowed)]
  return { changes, notes, allowed }
}

/** Pure: what changed between two manifests of the same roots. */
export function compareManifests(before: Manifest, after: Manifest): Diff {
  const d = diffAll(before, after)
  return finish(d.changes, d.notes, d.allowed)
}

const entriesOf = (m: Manifest) =>
  m.frozen.reduce((n, f) => n + f.entries.length, 0) + m.presence.reduce((n, p) => n + Object.keys(p.entries).length, 0)

// ─── The baseline ────────────────────────────────────────────────────────────────────────────

/** The pre-step. Each failure is a `ManifestError` whose message is the reason the caller prints. */
export function takeBaseline(a: {
  runId: string; cwd?: string | null; also?: string[]; by: string
  guard?: string; home?: string; roots?: Roots; checkModels?: boolean
  volumes?: () => Volume[]; now?: () => Date
  /** The sandbox root the guard folder must not be inside; default `sandboxRoot()`. */
  sandboxRoot?: string | null
  /**
   * The process that will settle this baseline (an in-process starter passes its own pid). When it is
   * gone and the baseline is still open, the baseline is an orphan (`orphanedBaselines`).
   */
  holderPid?: number | null
  /** The run's longest life, its own time limit with a margin; a baseline still open after it is an orphan. Default a day. */
  maxRunMs?: number | null
  /**
   * The known folders' real places (wave 15): asked when the roots are derived here, and whenever a
   * caller hands a reader in; default `knownFolderPlaces`, with the registry and the environment read
   * only when the system says the home is this account's own profile (wave 15b).
   */
  knownFolders?: () => string[]
}): { runId: string; takenAt: string; frozenEntries: number; presenceEntries: number; ms: number; notes: string[] } {
  const t0 = Date.now()
  if (typeof a.runId !== 'string' || !RUN_ID_RE.test(a.runId)) throw new ManifestError(`${a.runId} is not a run id`)
  const guard = a.guard ?? guardDir()
  const home = resolve(a.home ?? homedir())
  const refusal = haltRefusal(a.guard, home, { missionCwd: a.cwd ?? null, sandboxRoot: a.sandboxRoot })
  if (refusal !== null) throw new ManifestError(refusal, 'refusal')
  // A run whose starter died before its compare is compared before anything new starts: its changes
  // would otherwise be folded into the next run's baseline and never be seen.
  const orphan = orphanRefusal(guard)
  if (orphan !== null) throw new ManifestError(orphan, 'refusal')
  if (a.checkModels !== false) {
    const models = checkModelsRecord({ guard })
    if (models !== null) throw new ManifestError(models, 'refusal')
  }
  const target = beforePath(guard, a.runId)
  if (existsSync(target)) throw new ManifestError(`a baseline for run ${a.runId} already exists; a run id is used once`)

  // The volumes are listed when the roots are derived here, and whenever a caller hands a listing in.
  let volumes: Volume[] | null = null
  if (!a.roots || a.volumes) {
    try {
      volumes = (a.volumes ?? listUnprotectedVolumes)().map(v => ({ root: v.root, kind: v.kind, serial: v.serial ?? null }))
    } catch (e) {
      // An unknown answer is never read as "no such volume".
      const msg = textOf(e)
      throw new ManifestError(msg.startsWith('the attached volumes could not be listed') ? msg : `the attached volumes could not be listed (${msg})`)
    }
    const onVolume = guardVolumeRefusal(guard, volumes.map(v => v.root))
    if (onVolume !== null) throw new ManifestError(onVolume, 'refusal')
  }
  let roots = a.roots ?? protectedRoots({ home, volumes: volumes ?? [] })
  const knownNotes: string[] = []
  if (!a.roots || a.knownFolders) {
    let places: string[] = []
    try {
      // Wave 15b (check P1-C2): whether this home is the account's own is the system's answer, never homedir(),
      // which follows USERPROFILE: a repointed rehearsal must not count the owner's real OneDrive in a fake baseline.
      places = (a.knownFolders ?? (() => knownFolderPlaces({ home, notes: knownNotes })))()
    } catch (e) {
      knownNotes.push(`the known folders could not be read (${textOf(e)}); the defaults are watched`)
    }
    roots = withKnownFolders(roots, places, home, knownNotes)
  }

  const exclude = [a.cwd, ...(a.also ?? [])]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map(p => realPathOf(p, { quiet: true }))
  const watched = [...roots.frozen.map(r => r.path), ...roots.presence.map(r => r.path), home]
  for (const x of exclude) {
    for (const r of watched) {
      if (isInside(x, realPathOf(r, { quiet: true }))) throw new ManifestError(`the mission folder ${x} contains the protected folder ${r}`)
    }
    for (const r of roots.frozen) {
      if (isInside(realPathOf(r.path, { quiet: true }), x)) throw new ManifestError(`the mission folder ${x} is inside the frozen folder ${r.path}`)
    }
  }

  const holder = typeof a.holderPid === 'number' && a.holderPid > 0 ? { pid: a.holderPid, host: hostname() } : null
  const m = takeManifest(roots, { runId: a.runId, by: a.by, home, exclude, now: a.now, holder, maxRunMs: a.maxRunMs ?? DEFAULT_MAX_RUN_MS })
  m.notes.push(...knownNotes)
  try {
    ensureSub(guard, 'manifests')
    if (existsSync(target)) throw new ManifestError(`a baseline for run ${a.runId} already exists; a run id is used once`)
    writeAtomic(target, JSON.stringify(m))
  } catch (e) {
    if (e instanceof ManifestError) throw e
    throw new ManifestError(`the baseline ${target} could not be written (${codeOf(e)})`)
  }
  return {
    runId: a.runId,
    takenAt: m.takenAt,
    frozenEntries: m.frozen.reduce((n, f) => n + f.entries.length, 0),
    presenceEntries: m.presence.reduce((n, p) => n + Object.keys(p.entries).length, 0),
    ms: Date.now() - t0,
    notes: m.notes,
  }
}

type Opened = { state: 'open'; manifest: Manifest } | { state: 'absent' } | { state: 'unreadable'; why: string }

function readBaseline(guard: string, runId: string): Opened {
  let text: string
  try {
    text = readFileSync(beforePath(guard, runId), 'utf-8')
  } catch (e) {
    if (isMissing(e)) return { state: 'absent' }
    return { state: 'unreadable', why: codeOf(e) }
  }
  try {
    const m = JSON.parse(text) as Manifest
    if (!m || m.schema !== 1 || !Array.isArray(m.frozen) || !Array.isArray(m.presence) || !m.roots) return { state: 'unreadable', why: 'not a baseline' }
    // A copied or misnamed baseline would settle against another run's roots and time.
    if (m.runId !== runId) return { state: 'unreadable', why: `it is the baseline of run ${String(m.runId)}` }
    return { state: 'open', manifest: m }
  } catch (e) {
    return { state: 'unreadable', why: textOf(e) }
  }
}

interface CheckLine {
  run: string; kind: 'reading' | 'settle'; baselineTakenAt: string | null; at: string; by: string
  changed: boolean; changeCount: number; publicSummary: string; ms: number
  firstClass?: 'FROZEN' | 'PRESENCE' | null; firstRoot?: string | null; entries?: number; error?: string
  /** The compare's `allowed` notes (application folders lost below APPDATA_LOSS_AT), when there are any. */
  allowed?: string[]
}

function appendCheck(guard: string, line: CheckLine): void {
  try {
    appendFileSync(join(guard, 'checks.jsonl'), JSON.stringify(line) + '\n')
  } catch (e) {
    console.error(`[guard] the integrity check log could not be written (${codeOf(e)})`)
  }
}

function readChecks(guard: string): CheckLine[] {
  let text: string
  try {
    text = readFileSync(join(guard, 'checks.jsonl'), 'utf-8')
  } catch (e) {
    if (!isMissing(e)) console.error(`[guard] the integrity check log could not be read (${codeOf(e)})`)
    return []
  }
  const out: CheckLine[] = []
  for (const l of text.split(/\r?\n/)) {
    if (l.trim() === '') continue
    try {
      out.push(JSON.parse(l) as CheckLine)
    } catch (e) {
      console.error(`[guard] a line of the integrity check log is not JSON (${textOf(e)}); skipped`)
    }
  }
  return out
}

/**
 * The recorded settle of a run. A change wins over a clean line (a second settle that found a change,
 * or a baseline that was moved to `tripped/`): a clean line written earlier is never the answer then.
 */
function recordedSettle(guard: string, runId: string): Compare | null {
  const lines = readChecks(guard).filter(c => c.run === runId && c.kind === 'settle')
  if (lines.length === 0) return null
  const l = lines.find(c => c.changed) ?? lines[lines.length - 1]!
  const tripped = existsSync(join(guard, 'manifests', 'tripped', `${runId}${BEFORE_SUFFIX}`))
  const changed = l.changed || tripped
  const publicSummary = changed && !l.changed ? 'a change was recorded for this run (its baseline was moved to tripped/)' : l.publicSummary
  return {
    run: runId, at: l.at, by: l.by, kind: 'settle', settled: true, from: 'recorded',
    changed, changes: [], changeCount: changed && !l.changed ? 1 : l.changeCount,
    summary: publicSummary, publicSummary,
    firstClass: l.firstClass ?? null, firstRoot: l.firstRoot ?? null,
    entries: l.entries ?? 0, ms: l.ms, notes: [], latchPath: null,
    ...(l.error ? { error: l.error } : {}),
  }
}

/** A compare that could not be done: a change, by rule 7. The reason (it can name a path) stays out of `publicSummary`. */
function failedCompare(runId: string, by: string, at: string, kind: 'reading' | 'settle', why: string, ms: number): Compare {
  return {
    run: runId, at, by, kind, settled: false, from: 'live', changed: true, changes: [], changeCount: 0,
    summary: `${COMPARE_FAILED_PUBLIC} (${why})`, publicSummary: COMPARE_FAILED_PUBLIC,
    firstClass: null, firstRoot: null, entries: 0, ms, notes: [], latchPath: null, error: why,
  }
}

/** The most walks one compare makes (wave 15, NOW.md:73). */
export const SETTLE_MAX_WALKS = 5
const WALK_ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth']

/**
 * Walk the baseline's own roots again and compare. When anything differs, or the walk throws,
 * wait `confirmMs` and walk once more: a change counts when two walks in a row see it. While a walk
 * sees a change the walk before it did not, another walk follows (wave 15; until then only one more,
 * the third, and a loss that first showed on the third was a note), up to `SETTLE_MAX_WALKS`. What
 * first showed on the last walk and so was seen once is a note; so is a change seen on one walk only.
 * A change seen on two walks in a row counts though a later walk no longer sees it.
 */
type WalkOpts = {
  by: string; confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date; volumes?: () => Volume[]
  serialAt?: (root: string) => string | null
}

/**
 * The serial number of the volume mounted at a volume root (`D:\`), as eight upper-case hex digits,
 * read from the volume itself: on Windows the device number `stat` gives is the volume's serial
 * (measured on 2026-11-24 under Node and Bun: `C:\` gave F67B405B, as Win32_LogicalDisk does). No
 * process, read-only. Null off Windows, for a path that is not the top of a volume, and when nothing
 * is mounted at the letter or it cannot be read. Null too for a device number that cannot be a volume
 * serial: 0, below 0, not whole, or over 32 bits (wave 19, check CC1-1: 0 was read as serial 00000000,
 * which skipped a volume still attached as another one; null keeps the rule by letter). `statOf` is
 * the read, a seam for the tests of those bounds.
 */
export function volumeSerialAt(root: string, statOf: (p: string) => { dev: number | bigint } = p => statSync(p)): string | null {
  if (process.platform !== 'win32') return null
  const r = resolve(root)
  if (dirname(r) !== r) return null
  try {
    const dev = Number(statOf(r).dev)
    if (!Number.isInteger(dev) || dev <= 0 || dev > 0xffffffff) return null
    return dev.toString(16).toUpperCase().padStart(8, '0')
  } catch {
    return null
  }
}

/** Two serial numbers as Windows writes them (hex, any case, with or without leading zeros) name the same volume. */
const sameSerial = (a: string, b: string) => {
  const x = Number.parseInt(a, 16), y = Number.parseInt(b, 16)
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a.toUpperCase() === b.toUpperCase()
}

/**
 * The volume roots of a baseline that are not the volume they were (wave 15, NOW.md:82): a root keyed
 * by a serial number is compared only while the volume at its letter has that serial. The volumes are
 * listed once per compare, and only when a root has a serial. Only ANOTHER serial at the letter skips
 * the root. A volume listed with no serial and a listing that fails keep the rule by letter, with a
 * note. A letter the listing does not name (wave 15b, check P1-C8: a row the listing drops must not let
 * a loss on an attached volume pass) is asked for its own serial at the letter (wave 15c, check
 * CB1-R2: `serialAt`, default `volumeSerialAt`; never for a network drive, whose read can hang): another
 * serial there, such as an NTFS drive the listing leaves out because integrity labels protect it, is
 * not compared, with a note; the same serial, none (a volume really detached is absent, which the
 * volume rule already notes and does not count) or a read that fails keeps the rule by letter, with a
 * note: fail-closed, its differences latch.
 */
function swappedVolumes(before: Manifest, list?: () => Volume[], serialAt?: (root: string) => string | null): { skip: Set<string>; notes: string[] } {
  const skip = new Set<string>()
  const notes: string[] = []
  const keyed = (before.roots?.presence ?? []).filter(r => r.volume && typeof r.serial === 'string' && r.serial !== '')
  if (keyed.length === 0) return { skip, notes }
  let now: Volume[]
  try {
    now = (list ?? listUnprotectedVolumes)()
  } catch (e) {
    notes.push(`the attached volumes could not be listed at the compare (${textOf(e)}); the volume roots are compared by their letters`)
    return { skip, notes }
  }
  for (const r of keyed) {
    const v = now.find(x => keyOf(resolve(x.root)) === keyOf(r.path))
    if (!v) {
      let there: string | null = null
      if (!r.network) {
        try { there = (serialAt ?? volumeSerialAt)(r.path) } catch { there = null }
      }
      if (typeof there === 'string' && there !== '' && !sameSerial(there, r.serial!)) {
        skip.add(keyOf(r.path))
        notes.push(`${r.path}: another volume (serial ${there}) is there now, not the one of the baseline (serial ${r.serial}), read at its letter (the listing does not name it); not compared`)
        continue
      }
      notes.push(`${r.path}: the volume of the baseline (serial ${r.serial}) is not listed at its letter now; compared by its letter`)
      continue
    }
    if (typeof v.serial !== 'string' || v.serial === '') continue
    if (sameSerial(v.serial, r.serial!)) continue
    skip.add(keyOf(r.path))
    notes.push(`${r.path}: another volume (serial ${v.serial}) is there now, not the one of the baseline (serial ${r.serial}); not compared`)
  }
  return { skip, notes }
}

function confirmedWalk(before: Manifest, o: WalkOpts): { diff: Diff | null; error: string | null; after: Manifest | null; entries: number } {
  const swap = swappedVolumes(before, o.volumes, o.serialAt)
  const roots = swap.skip.size === 0 ? before.roots
    : { frozen: before.roots.frozen, presence: before.roots.presence.filter(r => !swap.skip.has(keyOf(r.path))) }
  const w = walkUntilSettled(before, roots, o)
  if (w.diff && swap.notes.length > 0) w.diff.notes = [...w.diff.notes, ...swap.notes]
  return w
}

function walkUntilSettled(before: Manifest, roots: Roots, o: WalkOpts)
  : { diff: Diff | null; error: string | null; after: Manifest | null; entries: number } {
  const walk = () => takeManifest(roots, { runId: before.runId, by: o.by, home: before.home, exclude: before.exclude, now: o.now })
  const wait = () => (o.sleep ?? syncSleep)(o.confirmMs ?? DEFAULT_CONFIRM_MS)
  let a1: Manifest | null = null
  let e1: string | null = null
  try { a1 = walk() } catch (e) { e1 = textOf(e) }
  const d1 = a1 ? diffAll(before, a1) : null
  if (a1 && d1 && d1.changes.length === 0) return { diff: finish([], d1.notes, d1.allowed), error: null, after: a1, entries: entriesOf(a1) }
  wait()
  let a2: Manifest | null = null
  let e2: string | null = null
  try { a2 = walk() } catch (e) { e2 = textOf(e) }
  if (!a2 && !a1) return { diff: null, error: e2 ?? e1 ?? 'the walk failed twice', after: null, entries: 0 }
  if (!a2) {
    // The confirming walk failed; the first walk's changes stand (a change seen is not dropped).
    const notes = [...d1!.notes, `the confirming walk failed (${e2}); the first walk is reported`]
    return { diff: finish(d1!.changes, notes, d1!.allowed), error: null, after: a1, entries: entriesOf(a1!) }
  }
  const d2 = diffAll(before, a2)
  if (!d1) {
    const notes = [...d2.notes, `the first walk failed (${e1}); the second walk is reported`]
    return { diff: finish(d2.changes, notes, d2.allowed), error: null, after: a2, entries: entriesOf(a2) }
  }
  // A change a walk saw and the walk before it did not is not "seen twice" yet, and it is not nothing
  // either: a loss made during the wait, or application folders that crossed the allowance between
  // the walks (below it on one walk they are notes, not changes). Dropping it settled a run as
  // unchanged when the first walk's difference had come back and a new loss had taken its place. It
  // gets another walk, until a walk sees nothing new or the bound is reached.
  const counted = new Map<string, Change>()
  const lateOnce = new Map<string, Change>()
  const ever = new Set(d1.changes.map(changeKey))
  let prev = d1
  let d = d2
  let a: Manifest = a2
  let n = 2
  let late: Change[] = []
  for (;;) {
    const prevKeys = new Set(prev.changes.map(changeKey))
    for (const c of d.changes) if (prevKeys.has(changeKey(c))) counted.set(changeKey(c), c)
    late = d.changes.filter(c => !prevKeys.has(changeKey(c)))
    for (const c of late) if (!ever.has(changeKey(c))) lateOnce.set(changeKey(c), c)
    for (const c of d.changes) ever.add(changeKey(c))
    if (late.length === 0 || n >= SETTLE_MAX_WALKS) break
    wait()
    let next: Manifest | null = null
    let en: string | null = null
    try { next = walk() } catch (e) { en = textOf(e) }
    if (!next) {
      // As for a failed confirming walk above: a change seen is not dropped.
      const notes = [...d.notes, `the ${WALK_ORDINAL[n]} walk failed (${en}); the ${WALK_ORDINAL[n - 1]} walk is reported`]
      const all = new Map(counted)
      for (const c of d.changes) all.set(changeKey(c), c)
      return { diff: finish([...all.values()], notes, d.allowed), error: null, after: a, entries: entriesOf(a) }
    }
    prev = d
    d = diffAll(before, next)
    a = next
    n++
  }
  const lastOnly = n >= SETTLE_MAX_WALKS ? late.filter(c => !counted.has(changeKey(c))) : []
  const lastKeys = new Set(lastOnly.map(changeKey))
  const once = [...lateOnce.values()].filter(c => !counted.has(changeKey(c)) && !lastKeys.has(changeKey(c)))
  const notes = [
    ...d.notes,
    ...once.map(c => `seen on the confirming walk only, so not counted: ${c.class} ${join(c.root, c.path)} (${c.kind})`),
    ...lastOnly.map(c => `seen on the last of ${n} walks only, so not counted (the walks did not settle): ${c.class} ${join(c.root, c.path)} (${c.kind})`),
  ]
  return { diff: finish([...counted.values()], notes, d.allowed), error: null, after: a, entries: entriesOf(a) }
}

function compareFrom(runId: string, by: string, at: string, kind: 'reading' | 'settle', d: Diff, entries: number, ms: number, settled: boolean): Compare {
  return { run: runId, at, by, kind, settled, from: 'live', ...d, entries, ms, latchPath: null }
}

const lineOf = (c: Compare, baselineTakenAt: string | null): CheckLine => ({
  run: c.run, kind: c.kind, baselineTakenAt, at: c.at, by: c.by, changed: c.changed, changeCount: c.changeCount,
  publicSummary: c.publicSummary, ms: c.ms, firstClass: c.firstClass, firstRoot: c.firstRoot, entries: c.entries,
  ...(c.error ? { error: c.error } : {}),
  ...(c.allowed && c.allowed.length > 0 ? { allowed: c.allowed } : {}),
})

/**
 * The early reading (entry 4.B1): one `reading` line in `checks.jsonl`, the latch on a change, and
 * the baseline left open. Never throws.
 */
export async function compareRun(runId: string, o: {
  by: string; page: Pager; guard?: string
  context?: Context
  confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date
  /** The volume listing a compare asks when a volume root of the baseline has a serial (wave 15); default `listUnprotectedVolumes`. */
  volumes?: () => Volume[]
  /** The serial read at the letter of a volume root the listing does not name (wave 15c); default `volumeSerialAt`. */
  serialAt?: (root: string) => string | null
}): Promise<Compare> {
  const guard = o.guard ?? guardDir()
  const now = o.now ?? (() => new Date())
  const t0 = Date.now()
  const at = now().toISOString()
  const trip = (cmp: Compare, reason: LatchReason, detail?: string) =>
    tripHalt({ by: o.by, run: runId, reason, page: o.page, compare: cmp, detail, guard, ...o.context, now: o.now })
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    const cmp = failedCompare(String(runId), o.by, at, 'reading', `${runId} is not a run id`, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', cmp.error)).latchPath
    return cmp
  }
  try {
    const opened = readBaseline(guard, runId)
    if (opened.state === 'open') {
      const w = confirmedWalk(opened.manifest, o)
      const cmp = w.diff
        ? compareFrom(runId, o.by, at, 'reading', w.diff, w.entries, Date.now() - t0, false)
        : failedCompare(runId, o.by, at, 'reading', w.error ?? 'the walk failed', Date.now() - t0)
      appendCheck(guard, lineOf(cmp, opened.manifest.takenAt))
      if (cmp.changed) cmp.latchPath = (await trip(cmp, cmp.error ? 'manifest-error' : 'integrity-change', cmp.error)).latchPath
      return cmp
    }
    if (opened.state === 'absent') {
      const rec = recordedSettle(guard, runId)
      if (rec) return rec
    }
    const why = opened.state === 'unreadable'
      ? `the integrity baseline of run ${runId} cannot be read (${opened.why})`
      : `there is no baseline and no recorded compare for run ${runId}: the pre-step did not run, or the guard folder was changed`
    const cmp = failedCompare(runId, o.by, at, 'reading', why, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', why)).latchPath
    return cmp
  } catch (e) {
    const cmp = failedCompare(runId, o.by, at, 'reading', `the reading failed: ${textOf(e)}`, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', cmp.error)).latchPath
    return cmp
  }
}

/**
 * The settling compare (directive 15): the only compare that closes the baseline. Never throws.
 */
export async function settleRun(runId: string, o: {
  by: string; page: Pager; guard?: string; notConfirmedDead?: string
  /** The owner at the desk (`cynco-guard clear`): the compare is made and the baseline closed, but nothing latches or pages. */
  noLatch?: boolean
  context?: Context
  confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date
  /** The volume listing a compare asks when a volume root of the baseline has a serial (wave 15); default `listUnprotectedVolumes`. */
  volumes?: () => Volume[]
  /** The serial read at the letter of a volume root the listing does not name (wave 15c); default `volumeSerialAt`. */
  serialAt?: (root: string) => string | null
}): Promise<Compare> {
  const guard = o.guard ?? guardDir()
  const now = o.now ?? (() => new Date())
  const t0 = Date.now()
  const at = now().toISOString()
  const trip = async (cmp: Compare, reason: LatchReason, detail?: string): Promise<{ latchPath: string | null }> => o.noLatch
    ? { latchPath: null }
    : tripHalt({ by: o.by, run: runId, reason, page: o.page, compare: cmp, detail, guard, ...o.context, now: o.now })
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    const cmp = failedCompare(String(runId), o.by, at, 'settle', `${runId} is not a run id`, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', cmp.error)).latchPath
    return cmp
  }
  try {
    const opened = readBaseline(guard, runId)

    if (o.notConfirmedDead !== undefined) {
      let base: Compare
      if (opened.state === 'open') {
        const w = confirmedWalk(opened.manifest, o)
        base = w.diff
          ? compareFrom(runId, o.by, at, 'reading', w.diff, w.entries, Date.now() - t0, false)
          : failedCompare(runId, o.by, at, 'reading', w.error ?? 'the walk failed', Date.now() - t0)
        appendCheck(guard, lineOf(base, opened.manifest.takenAt))
      } else {
        base = (opened.state === 'absent' ? recordedSettle(guard, runId) : null)
          ?? failedCompare(runId, o.by, at, 'reading', opened.state === 'unreadable'
            ? `the integrity baseline of run ${runId} cannot be read (${opened.why})`
            : `no baseline and no recorded compare for run ${runId}`, Date.now() - t0)
      }
      const dead = `the engine is not confirmed dead (${o.notConfirmedDead})`
      const cmp: Compare = {
        ...base,
        summary: base.changed ? `${base.summary}; ${dead}` : dead,
        publicSummary: base.changed ? `${base.publicSummary}; ${dead}` : dead,
        notConfirmedDead: o.notConfirmedDead,
      }
      cmp.latchPath = (await trip(cmp, 'engine-not-confirmed-dead', o.notConfirmedDead)).latchPath
      return cmp
    }

    if (opened.state === 'open') {
      const w = confirmedWalk(opened.manifest, o)
      if (!w.diff) {
        // The baseline stays open, so a later `post` can retry once the cause is fixed.
        const cmp = failedCompare(runId, o.by, at, 'reading', w.error ?? 'the walk failed', Date.now() - t0)
        appendCheck(guard, lineOf(cmp, opened.manifest.takenAt))
        cmp.latchPath = (await trip(cmp, 'manifest-error', cmp.error)).latchPath
        return cmp
      }
      const cmp = compareFrom(runId, o.by, at, 'settle', w.diff, w.entries, Date.now() - t0, true)
      const from = beforePath(guard, runId)
      try {
        if (!cmp.changed) {
          renameSync(from, join(guard, 'manifests', 'last-clean.json'))
        } else {
          const tripped = ensureSub(join(guard, 'manifests'), 'tripped')
          renameSync(from, join(tripped, `${runId}.before.json`))
          try {
            writeFileSync(join(tripped, `${runId}.after.json`), JSON.stringify(w.after))
          } catch (e) {
            console.error(`[guard] the after-manifest of run ${runId} could not be written (${codeOf(e)})`)
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          // Another caller closed the baseline first. A change THIS walk saw is the answer (and latches)
          // whatever the other caller recorded; a clean walk returns the other caller's record.
          if (cmp.changed) {
            cmp.notes.push('another caller closed the baseline first; this walk found a change')
            appendCheck(guard, lineOf(cmp, opened.manifest.takenAt))
            cmp.latchPath = (await trip(cmp, 'integrity-change')).latchPath
            return cmp
          }
          const rec = recordedSettle(guard, runId)
          if (rec) return rec
        }
        // The baseline was not closed: this compare is not the settle the caller can rely on, and it is
        // logged as a reading, so the record answers with a later settle, never with this line.
        cmp.settled = false
        cmp.kind = 'reading'
        cmp.notes.push(`the baseline could not be closed (${codeOf(e)})`)
        console.error(`[guard] the baseline of run ${runId} could not be closed (${codeOf(e)})`)
      }
      // Written once the baseline is closed, or known not to be: a `settle` line means it was closed.
      appendCheck(guard, lineOf(cmp, opened.manifest.takenAt))
      if (cmp.changed) cmp.latchPath = (await trip(cmp, 'integrity-change')).latchPath
      return cmp
    }

    if (opened.state === 'absent') {
      const rec = recordedSettle(guard, runId)
      if (rec) return rec
    }
    const why = opened.state === 'unreadable'
      ? `the integrity baseline of run ${runId} cannot be read (${opened.why})`
      : `no baseline and no recorded compare for run ${runId}`
    const cmp = failedCompare(runId, o.by, at, 'settle', why, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', why)).latchPath
    return cmp
  } catch (e) {
    const cmp = failedCompare(runId, o.by, at, 'settle', `the compare failed: ${textOf(e)}`, Date.now() - t0)
    cmp.latchPath = (await trip(cmp, 'manifest-error', cmp.error)).latchPath
    return cmp
  }
}

type Head = { takenAt: string | null; by: string | null; holderPid: number | null; holderHost: string | null; deadline: string | null }

/** Reads the first few kilobytes of a baseline for its `takenAt`, `by`, holder and deadline (a baseline is about 3 MB). */
function headOf(file: string): Head {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf-8')
    const takenAt = /"takenAt":"([^"]*)"/.exec(head)?.[1] ?? null
    const by = /"by":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? null
    const holder = /"holder":\{"pid":(\d+),"host":"((?:[^"\\]|\\.)*)"\}/.exec(head)
    const deadline = /"deadline":"([^"]*)"/.exec(head)?.[1] ?? null
    return {
      takenAt, by: by === null ? null : (JSON.parse(`"${by}"`) as string),
      holderPid: holder ? Number(holder[1]) : null, holderHost: holder ? (JSON.parse(`"${holder[2]}"`) as string) : null, deadline,
    }
  } catch (e) {
    console.error(`[guard] the baseline ${file} could not be read (${codeOf(e)})`)
    return { takenAt: null, by: null, holderPid: null, holderHost: null, deadline: null }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface OpenBaseline {
  runId: string; takenAt: string; by: string; ageMs: number
  holderPid: number | null; holderHost: string | null; deadline: string | null
}

/** Every open baseline, oldest first. Throws when the manifests folder exists and cannot be listed. */
export function openBaselines(guard: string = guardDir()): OpenBaseline[] {
  const dir = join(guard, 'manifests')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (isMissing(e)) return []
    throw new Error(`the open integrity baselines could not be listed (${codeOf(e)})`)
  }
  const out: OpenBaseline[] = []
  for (const name of names.filter(n => n.endsWith(BEFORE_SUFFIX))) {
    const file = join(dir, name)
    const h = headOf(file)
    let takenAt = h.takenAt
    if (takenAt === null) {
      try { takenAt = statSync(file).mtime.toISOString() } catch (e) { takenAt = new Date(0).toISOString(); console.error(`[guard] ${file}: ${codeOf(e)}`) }
    }
    out.push({
      runId: name.slice(0, -BEFORE_SUFFIX.length), takenAt, by: h.by ?? '(unknown)', ageMs: Date.now() - Date.parse(takenAt),
      holderPid: h.holderPid, holderHost: h.holderHost, deadline: h.deadline,
    })
  }
  return out.sort((x, y) => (x.takenAt < y.takenAt ? -1 : x.takenAt > y.takenAt ? 1 : 0))
}

// ─── Orphaned baselines (review of wave 5, finding 1) ────────────────────────────────────────

export interface Orphan { runId: string; takenAt: string; by: string; why: string; restarted: boolean }

/**
 * Open baselines that nothing will ever settle: the machine restarted after one was taken (every
 * process of that run is dead), or its holder (the in-process starter that named itself) is gone, or
 * its time limit has passed. A baseline held by this process is never an orphan. Throws when the
 * manifests folder cannot be listed.
 */
export function orphanedBaselines(guard: string = guardDir(), o: {
  now?: number; bootTimeMs?: number; alive?: (pid: number) => boolean; host?: string
} = {}): Orphan[] {
  const now = o.now ?? Date.now()
  const boot = o.bootTimeMs ?? Date.now() - uptime() * 1000
  const alive = o.alive ?? processAlive
  const host = o.host ?? hostname()
  const out: Orphan[] = []
  for (const b of openBaselines(guard)) {
    const t = Date.parse(b.takenAt)
    const base = { runId: b.runId, takenAt: b.takenAt, by: b.by }
    if (b.holderPid === process.pid && b.holderHost === host) continue
    if (Number.isFinite(t) && t < boot - BOOT_SLACK_MS) {
      out.push({ ...base, why: 'the machine restarted after it was taken', restarted: true })
    } else if (b.holderPid !== null && b.holderHost === host && !alive(b.holderPid)) {
      out.push({ ...base, why: `its starter (${b.by}, pid ${b.holderPid}) is gone`, restarted: false })
    } else if (b.deadline !== null && Number.isFinite(Date.parse(b.deadline)) && now > Date.parse(b.deadline)) {
      out.push({ ...base, why: `its time limit passed at ${b.deadline}`, restarted: false })
    }
  }
  return out
}

/** A sentence while an orphaned baseline exists (or the open baselines cannot be listed), else null. */
export function orphanRefusal(guard: string = guardDir(), o: Parameters<typeof orphanedBaselines>[1] = {}): string | null {
  let orphans: Orphan[]
  try {
    orphans = orphanedBaselines(guard, o)
  } catch (e) {
    return `${textOf(e)}; a run that was never compared cannot be ruled out`
  }
  const first = orphans[0]
  if (!first) return null
  const more = orphans.length > 1 ? ` (and ${orphans.length - 1} more)` : ''
  return `run ${first.runId} was never compared (${first.why})${more}; nothing new starts until it is. The daemon compares it on its next tick; at the desk: bun scripts/cynco-guard.mjs post ${first.runId}`
}

/**
 * The daemon's answer to an orphan, once per tick while no latch stands: a run from before a restart
 * is settled normally (it is dead); any other orphan is settled as not confirmed dead, which latches
 * and pages. Stops at the first latch. Never throws.
 */
export async function settleOrphans(o: {
  by: string; page: Pager; guard?: string; home?: string
  now?: number; bootTimeMs?: number; alive?: (pid: number) => boolean; confirmMs?: number; sleep?: (ms: number) => void
}): Promise<Compare[]> {
  const guard = o.guard ?? guardDir()
  const out: Compare[] = []
  if (haltState(o.guard, o.home).state !== 'clear') return out
  let orphans: Orphan[]
  try {
    orphans = orphanedBaselines(guard, o)
  } catch (e) {
    console.error(`[guard] the open integrity baselines could not be looked at (${textOf(e)})`)
    return out
  }
  for (const orphan of orphans) {
    const c = await settleRun(orphan.runId, {
      by: o.by, page: o.page, guard: o.guard, confirmMs: o.confirmMs, sleep: o.sleep,
      ...(orphan.restarted ? {} : { notConfirmedDead: `${orphan.why}; the run was never compared` }),
    })
    out.push(c)
    if (c.latchPath !== null) break
  }
  return out
}

// ─── haltState, haltRefusal ──────────────────────────────────────────────────────────────────

/** `quiet`: a first read that is retried; its failure is not worth a line. */
function readLatch(path: string, o: { quiet?: boolean } = {}): Latch | null {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    if (!o.quiet) console.error(`[guard] the integrity latch ${path} could not be read (${codeOf(e)})`)
    return null
  }
  try {
    const l = JSON.parse(text) as Latch
    return l && typeof l === 'object' && typeof l.publicSummary === 'string' ? l : null
  } catch (e) {
    if (!o.quiet) console.error(`[guard] the integrity latch ${path} is not a latch record (${textOf(e)})`)
    return null
  }
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/
const UNC_PATH = /^(\\\\|\/\/)/

/**
 * The guard folder is on a drive `listUnprotectedVolumes` names (no integrity labels there, so a
 * contained process could change the latch, the baselines and the log): its sentence, else null.
 */
function guardVolumeRefusal(dir: string, volumes: string[], platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32' || volumes.length === 0) return null
  const driveOf = (p: string) => /^([A-Za-z]):/.exec(p)?.[1]?.toUpperCase() ?? null
  const drive = driveOf(realPathOf(dir, { quiet: true }))
  const hit = drive === null ? undefined : volumes.find(v => driveOf(v) === drive)
  return hit === undefined ? null
    : `the guard folder ${dir} is on ${hit}, which carries no integrity labels; set LOCALCODE_GUARD_DIR to a folder on a local NTFS drive, outside the home folder`
}

/**
 * Read-only and cheap: three `stat` calls, two `realpath`, one small read when latched. The guard
 * folder is judged first (form, existence, a real folder, where it resolves), then the latch, with
 * `lstat`: anything at that name, a dangling link included, is the latch.
 */
export function haltState(guard?: string, home?: string, o: { sandboxRoot?: string | null; missionCwd?: string | null; unprotectedVolumes?: string[] } = {})
  : { state: 'clear' } | { state: 'latched'; latchPath: string; latch: Latch | null; summary: string } | { state: 'unusable'; summary: string } {
  const source = guard === undefined ? guardDirSource() : null
  const dir = guard ?? source!.dir
  const unusable = (summary: string) => ({ state: 'unusable' as const, summary })
  if (!isAbsolute(dir)) {
    return unusable(`the guard folder ${dir} is not an absolute path on this system; set LOCALCODE_GUARD_DIR to a folder outside the home folder`)
  }
  if (process.platform === 'win32' && !DRIVE_PATH.test(dir)) {
    // `\cynco-guard` resolves against each process's own current drive; a share has no integrity labels.
    return unusable(`the guard folder ${dir} does not start with a drive letter; set LOCALCODE_GUARD_DIR to a folder on a local NTFS drive, such as C:/cynco-guard`)
  }
  let st: Stats
  try {
    st = lstatSync(dir)
    if (!st.isSymbolicLink()) st = statSync(dir)
  } catch (e) {
    if (!isMissing(e)) return unusable(`the guard folder ${dir} cannot be read (${codeOf(e)})`)
    if (source) {
      const how = source.setTo === null ? 'unset, so this is the default' : `set to ${source.setTo}`
      return unusable(`the guard folder ${dir} does not exist (LOCALCODE_GUARD_DIR is ${how}); scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
    }
    return unusable(`the guard folder ${dir} does not exist; scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
  }
  if (st.isSymbolicLink()) return unusable(`the guard folder ${dir} is a link; the guard folder must be a real folder`)
  if (!st.isDirectory()) return unusable(`the guard folder ${dir} is not a folder`)

  const real = realPathOf(dir, { quiet: true })
  if (process.platform === 'win32' && (UNC_PATH.test(real) || !DRIVE_PATH.test(real))) {
    return unusable(`the guard folder ${dir} resolves to ${real}, which is not on a local drive`)
  }
  const h = home ?? homedir()
  if (isInside(realPathOf(h, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the home folder ${h}`)
  const sb = o.sandboxRoot === undefined ? sandboxRoot() : o.sandboxRoot
  if (sb && isInside(realPathOf(sb, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the sandbox root ${sb}`)
  const cwd = o.missionCwd
  if (cwd && isInside(realPathOf(cwd, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the mission folder ${cwd}`)
  const onVolume = guardVolumeRefusal(dir, o.unprotectedVolumes ?? [])
  if (onVolume !== null) return unusable(onVolume)

  const latchPath = join(dir, LATCH_FILE)
  let entry: Stats | null = null
  try {
    entry = lstatSync(latchPath)
  } catch (e) {
    if (!isMissing(e)) return unusable(`the guard folder ${dir} cannot be read (${codeOf(e)})`)
  }
  if (entry === null) return { state: 'clear' }
  const latch = entry.isFile() ? readLatch(latchPath) : null
  const what = latch ? `${latch.publicSummary}, set ${latch.at} by ${latch.by}`
    : entry.isSymbolicLink() ? 'latch unreadable: it is a link' : 'latch unreadable'
  return {
    state: 'latched', latchPath, latch,
    summary: `the integrity latch is present at ${shown(dir, LATCH_FILE)} (${what}); only the owner clears it, at a terminal, with: ${GUARD_CLEAR_COMMAND}`,
  }
}

/** The latch as the desk, the phone, the widget and the box reporter show it (wave 15, NOW.md:57). */
export type DeskIntegrity = { state: 'clear'; summary: string } | { state: 'latched'; summary: string; at: string | null } | { state: 'unusable'; summary: string }

const DESK_STOPS = 'No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear'

/**
 * `haltState` in words a page off this machine may show: the latch's public summary, when and by whom
 * and why it was set, and what it stops; never a path (the guard folder, the latch file, the changes
 * are what `cynco-guard.mjs status` prints at the desk). Reads what `haltState` reads.
 */
export function deskIntegrity(guard?: string, home?: string, o: { sandboxRoot?: string | null; missionCwd?: string | null; unprotectedVolumes?: string[] } = {}): DeskIntegrity {
  const s = haltState(guard, home, o)
  if (s.state === 'clear') return { state: 'clear', summary: 'no integrity latch' }
  if (s.state === 'unusable') return { state: 'unusable', summary: 'the guard folder cannot be used, so no unattended run starts; bun scripts/cynco-guard.mjs status says why' }
  const l = s.latch
  if (!l) return { state: 'latched', at: null, summary: `the integrity latch is set, and its record cannot be read. ${DESK_STOPS}` }
  return { state: 'latched', at: l.at, summary: `${l.publicSummary}; set ${l.at} by ${l.by} (${l.reason}). ${DESK_STOPS}` }
}

/** Null only when the guard folder is usable and holds no latch; otherwise the reason sentence. */
export function haltRefusal(guard?: string, home?: string, o: { sandboxRoot?: string | null; missionCwd?: string | null; unprotectedVolumes?: string[] } = {}): string | null {
  const s = haltState(guard, home, o)
  return s.state === 'clear' ? null : s.summary
}

// ─── tripHalt, unsent pages, clearHalt ───────────────────────────────────────────────────────

function baselineOf(guard: string, run: string): string | null {
  const tripped = join(guard, 'manifests', 'tripped', `${run}.before.json`)
  if (existsSync(tripped)) return tripped
  const open = beforePath(guard, run)
  return existsSync(open) ? open : null
}

function keepUnsent(guard: string, page: Page, meta: { at: string; by: string; run: string }, stamp: string): string {
  const dir = ensureSub(guard, 'unsent')
  const body = JSON.stringify({ ...page, ...meta }, null, 2) + '\n'
  for (let i = 0; i < 1000; i++) {
    const file = join(dir, `${stamp}-${process.pid}${i ? `-${i}` : ''}.json`)
    try {
      writeFileSync(file, body, { flag: 'wx' })
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('no free name in the unsent folder')
}

/**
 * The latch, in order: create-exclusive `HALT.json` (the first writer wins), the latch log, one page
 * per run (kept in `unsent/` when it cannot be sent), then the unsent pages flushed. Steps 1 and 2
 * finish before the function first yields. Never throws.
 */
export async function tripHalt(a: {
  by: string; run: string; reason: LatchReason; page: Pager
  compare?: Compare; detail?: string; guard?: string
  campaignId?: string; wave?: number; cwd?: string; now?: () => Date
  /** The short wait before an existing latch is read a second time; tests inject it. */
  sleep?: (ms: number) => void
}): Promise<{ latched: boolean; alreadyLatched: boolean; paged: boolean; latchPath: string }> {
  const guard = a.guard ?? guardDir()
  const latchPath = join(guard, LATCH_FILE)
  let latched = false
  let alreadyLatched = false
  let notWritten: string | null = null
  let existingRun: string | null = null
  let delivered = false
  let flushed = 0
  try {
    const nowDate = (a.now ?? (() => new Date()))()
    const at = nowDate.toISOString()
    const cmp = a.compare
    const detail = a.detail ?? null
    // The detail can name a path, so only the owner's summary carries it (rule 15); the engine's
    // not-dead reason is a pid or a time, and its public form keeps it as the specification says.
    const fallback = a.reason === 'engine-not-confirmed-dead' ? `the engine is not confirmed dead (${detail ?? 'no reason given'})`
      : a.reason === 'manifest-error' ? `${COMPARE_FAILED_PUBLIC} (${detail ?? 'no reason given'})`
        : `a protected folder changed (${detail ?? 'no detail given'})`
    const publicFallback = a.reason === 'engine-not-confirmed-dead' ? fallback
      : a.reason === 'manifest-error' ? COMPARE_FAILED_PUBLIC : 'a protected folder changed'
    const summary = cmp?.summary ?? fallback
    const publicSummary = cmp?.publicSummary ?? publicFallback
    const latch: Latch = {
      schema: 1, at, by: a.by, pid: process.pid, host: hostname(),
      run: a.run, reason: a.reason, detail,
      campaignId: a.campaignId ?? null, wave: a.wave ?? null, cwd: a.cwd ?? null,
      summary, publicSummary,
      changeCount: cmp?.changeCount ?? 0, changes: (cmp?.changes ?? []).slice(0, LATCH_CHANGES),
      baseline: null,
    }
    try { latch.baseline = baselineOf(guard, a.run) } catch (e) { console.error(`[guard] the baseline of run ${a.run} could not be looked for (${codeOf(e)})`) }

    // 1. The latch. Anything already at that name is the latch, and nothing is opened through it:
    //    `wx` follows a dangling link on Windows and would create the link's target elsewhere.
    let fd: number | null = null
    let existing: Stats | null = null
    try {
      existing = lstatSync(latchPath)
    } catch (e) {
      if (!isMissing(e)) console.error(`[guard] the integrity latch ${latchPath} could not be looked at (${codeOf(e)}); creating it`)
    }
    if (existing === null) {
      try {
        fd = openSync(latchPath, 'wx')
        latched = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          latched = true
          alreadyLatched = true
          try { existing = lstatSync(latchPath) } catch (e2) { console.error(`[guard] the integrity latch ${latchPath} could not be looked at (${codeOf(e2)})`) }
        } else {
          notWritten = codeOf(e)
          console.error(`[guard] THE INTEGRITY LATCH COULD NOT BE WRITTEN (${notWritten})`)
        }
      }
    } else {
      latched = true
      alreadyLatched = true
    }
    if (alreadyLatched && existing !== null && existing.isFile()) {
      // A latch another process created a moment ago may not hold its record yet: one short re-read.
      existingRun = readLatch(latchPath, { quiet: true })?.run ?? null
      if (existingRun === null) {
        ;(a.sleep ?? syncSleep)(LATCH_REREAD_MS)
        existingRun = readLatch(latchPath)?.run ?? null
      }
    }
    if (fd !== null) {
      try {
        writeSync(fd, JSON.stringify(latch, null, 2) + '\n')
        fsyncSync(fd)
      } catch (e) {
        // The file exists, so the latch stands; its record is what is missing.
        console.error(`[guard] the integrity latch was created but its record could not be written (${codeOf(e)})`)
      } finally {
        closeSync(fd)
      }
    }

    // 2. The latch log.
    try {
      appendFileSync(join(guard, 'halt-log.jsonl'), JSON.stringify(latch) + '\n')
    } catch (e) {
      console.error(`[guard] the latch log could not be written (${codeOf(e)})`)
    }

    // 3. One page per run.
    const sameRun = alreadyLatched && existingRun === a.run
    if (!sameRun) {
      const lead = notWritten ? `THE INTEGRITY LATCH COULD NOT BE WRITTEN (${notWritten}). ` : ''
      // A loss only at the top of the owner's own drives (a tidy-up there is likely) still stops
      // everything, one step below the priority of a loss of the home or a frozen folder.
      const volumeOnly = (a.reason === 'integrity-change' || a.reason === 'presence-lost') && cmp !== undefined && onlyVolumeChanges(cmp)
      const page: Page = {
        title: PAGE_TITLE,
        message: `${lead}${a.by} ${a.run}: ${summary}. Nothing unattended runs until you clear it at the desk: ${GUARD_CLEAR_COMMAND}`,
        priority: volumeOnly && notWritten === null ? VOLUME_PAGE_PRIORITY : PAGE_PRIORITY,
      }
      let why: string | null = null
      try {
        delivered = (await a.page(page)) === true
        if (!delivered) why = NOT_SENT_FALSE
      } catch (e) {
        why = textOf(e)
      }
      if (!delivered) {
        const stands = latched ? 'The integrity latch stands.' : 'The integrity latch was not written either.'
        try {
          const file = keepUnsent(guard, page, { at, by: a.by, run: a.run }, stampOf(nowDate))
          console.error(`[guard] PAGE NOT SENT (${why}); kept at ${file}. ${stands}`)
        } catch (e) {
          console.error(`[guard] PAGE NOT SENT (${why}); it could not be kept either (${codeOf(e)}). ${stands}`)
        }
      }
    }

    // 4. A process with a working sender delivers what the others could not send.
    if (delivered || sameRun) flushed = (await flushUnsentPages(guard, a.page)).sent
  } catch (e) {
    console.error(`[guard] the integrity latch step failed (${textOf(e)})`)
  }
  return { latched, alreadyLatched, paged: delivered || flushed > 0, latchPath }
}

/** `<name>.json.<pid>` in `sending/`: a page one process has claimed and is sending. */
const CLAIM = /^(.+\.json)\.(\d+)$/

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists and belongs to someone else. Anything but ESRCH is read as alive (never re-sent twice).
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Claims left in `sending/` by a process that died mid-send go back to `unsent/`. */
function reclaimDeadClaims(guard: string): void {
  let names: string[]
  try {
    names = readdirSync(join(guard, 'sending'))
  } catch (e) {
    if (!isMissing(e)) console.error(`[guard] the pages being sent could not be listed (${codeOf(e)})`)
    return
  }
  for (const n of names) {
    const m = CLAIM.exec(n)
    if (!m) continue
    const pid = Number(m[2])
    if (pid === process.pid || processAlive(pid)) continue
    try {
      renameSync(join(guard, 'sending', n), join(ensureSub(guard, 'unsent'), m[1]!))
    } catch (e) {
      console.error(`[guard] the page ${n} left by process ${pid} could not be put back into unsent/ (${codeOf(e)})`)
    }
  }
}

/**
 * Oldest first; each delivered page (marked `(late) `) moves to `sent/`; stops at the first failure.
 * Each page is claimed (renamed into `sending/` under this process's id) before it is sent, so two
 * flushes at once, in one process or two, never deliver the same page twice.
 */
export async function flushUnsentPages(guard: string, send: Pager): Promise<{ sent: number; left: number }> {
  const dir = join(guard, 'unsent')
  reclaimDeadClaims(guard)
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch (e) {
    if (!isMissing(e)) console.error(`[guard] the unsent pages could not be listed (${codeOf(e)})`)
    return { sent: 0, left: 0 }
  }
  const items: Array<{ name: string; page: (Page & { at?: string }) | null; at: string }> = []
  for (const name of names) {
    try {
      const p = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Page & { at?: string }
      items.push({ name, page: p, at: typeof p.at === 'string' ? p.at : '' })
    } catch (e) {
      // Gone since the listing: another flush has it.
      if (isMissing(e)) continue
      console.error(`[guard] the unsent page ${name} cannot be read (${textOf(e)}); left in place`)
      items.push({ name, page: null, at: '' })
    }
  }
  items.sort((x, y) => (x.at === y.at ? (x.name < y.name ? -1 : 1) : x.at < y.at ? -1 : 1))
  let sent = 0
  let left = 0
  let stopped = false
  for (const it of items) {
    if (!it.page || stopped) { left++; continue }
    let claimed: string
    try {
      claimed = join(ensureSub(guard, 'sending'), `${it.name}.${process.pid}`)
      renameSync(join(dir, it.name), claimed)
    } catch (e) {
      if (isMissing(e)) continue
      console.error(`[guard] the unsent page ${it.name} could not be claimed (${codeOf(e)}); left in place`)
      left++
      stopped = true
      continue
    }
    let ok = false
    try {
      ok = (await send({ title: it.page.title, message: `(late) ${it.page.message}`, priority: it.page.priority })) === true
    } catch (e) {
      console.error(`[guard] an unsent page could not be sent again (${textOf(e)})`)
      ok = false
    }
    if (!ok) {
      try {
        renameSync(claimed, join(dir, it.name))
      } catch (e) {
        console.error(`[guard] the unsent page ${it.name} could not be put back into unsent/ (${codeOf(e)}); it waits in sending/`)
      }
      left++
      stopped = true
      continue
    }
    sent++
    try {
      renameSync(claimed, join(ensureSub(guard, 'sent'), it.name))
    } catch (e) {
      // Marked as delivered where it is, so no later flush sends it again.
      console.error(`[guard] the delivered page ${it.name} could not be moved to sent/ (${codeOf(e)})`)
      try {
        renameSync(claimed, `${claimed}.delivered`)
      } catch (e2) {
        console.error(`[guard] the delivered page ${it.name} could not be marked delivered either (${codeOf(e2)}); it may be sent again`)
      }
    }
  }
  return { sent, left }
}

/**
 * Moves the latch into `cleared/` and logs it. Only the guard command calls it, at a terminal, after
 * the owner typed the word: it refuses (throws, changing nothing) unless `terminal` is an interactive
 * terminal and `typed` is `CLEAR`. No other caller in the repository is allowed (a text pin in
 * engine/__tests__/integrity.test.ts).
 */
export function clearHalt(guard: string, o: { by: string; now?: () => Date; terminal: { isTTY?: boolean } | null | undefined; typed: string })
  : { cleared: boolean; latch: Latch | null; archivedTo: string | null; pagesWithdrawn?: number } {
  if (o.terminal?.isTTY !== true) throw new Error('the integrity latch is cleared only by a person at a terminal; nothing was changed')
  if (o.typed !== 'CLEAR') throw new Error('the integrity latch is cleared only after CLEAR is typed; nothing was changed')
  const latchPath = join(guard, LATCH_FILE)
  let entry: Stats | null = null
  try {
    entry = lstatSync(latchPath)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
  if (entry === null) return { cleared: false, latch: null, archivedTo: null }
  // A link at that name is moved as the link itself; nothing is read through it.
  const latch = entry.isFile() ? readLatch(latchPath) : null
  const nowDate = (o.now ?? (() => new Date()))()
  const dir = ensureSub(guard, 'cleared')
  let target = join(dir, `HALT-${stampOf(nowDate)}.json`)
  for (let i = 1; existsSync(target); i++) target = join(dir, `HALT-${stampOf(nowDate)}-${i}.json`)
  renameSync(latchPath, target)
  // Every page still waiting is about a latch the owner has just read and cleared at the desk: it is
  // withdrawn into cleared/pages/, so the daemon does not deliver it later as a top-priority "(late)" page.
  const withdrawn = withdrawUnsentPages(guard)
  try {
    appendFileSync(join(guard, 'halt-log.jsonl'), JSON.stringify({ cleared: true, at: nowDate.toISOString(), by: o.by, pagesWithdrawn: withdrawn }) + '\n')
  } catch (e) {
    console.error(`[guard] the latch log could not be written (${codeOf(e)})`)
  }
  return { cleared: true, latch, archivedTo: target, pagesWithdrawn: withdrawn }
}

/** Moves every unsent page (and any claim left by a dead process) into `cleared/pages/`. Never throws. */
function withdrawUnsentPages(guard: string): number {
  reclaimDeadClaims(guard)
  let names: string[]
  try {
    names = readdirSync(join(guard, 'unsent')).filter(n => n.endsWith('.json'))
  } catch (e) {
    if (!isMissing(e)) console.error(`[guard] the unsent pages could not be listed (${codeOf(e)}); none were withdrawn`)
    return 0
  }
  let moved = 0
  for (const n of names) {
    try {
      renameSync(join(guard, 'unsent', n), join(ensureSub(join(guard, 'cleared'), 'pages'), n))
      moved++
    } catch (e) {
      if (!isMissing(e)) console.error(`[guard] the unsent page ${n} could not be withdrawn (${codeOf(e)}); it may still be sent late`)
    }
  }
  return moved
}

// ─── frozenWriteRefusal (entry 4.M5) ─────────────────────────────────────────────────────────

/** For the harness's own writers into FROZEN folders: a sentence while any baseline is open. */
export function frozenWriteRefusal(guard?: string): string | null {
  const dir = join(guard ?? guardDir(), 'manifests')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (isMissing(e)) return null
    return `the open integrity baselines could not be listed (${codeOf(e)}); a protected folder is not changed blind`
  }
  const open: Array<{ runId: string; t: number }> = []
  for (const n of names.filter(x => x.endsWith(BEFORE_SUFFIX))) {
    try {
      open.push({ runId: n.slice(0, -BEFORE_SUFFIX.length), t: statSync(join(dir, n)).mtimeMs })
    } catch (e) {
      // Closed between the listing and the look: no longer open.
      if (!isMissing(e)) open.push({ runId: n.slice(0, -BEFORE_SUFFIX.length), t: 0 })
    }
  }
  if (open.length === 0) return null
  open.sort((x, y) => x.t - y.t || (x.runId < y.runId ? -1 : 1))
  const id = open[0]!.runId
  const more = open.length > 1 ? ` (and ${open.length - 1} more)` : ''
  return `a mission or daemon task is running (${id})${more}; this would change a protected folder and stop it. Try again when it has ended. If nothing is running, that run died before its compare: bun scripts/cynco-guard.mjs post ${id}`
}

// ─── The models record ───────────────────────────────────────────────────────────────────────

const recordPathOf = (guard: string) => join(guard, 'models-hashes.json')
const slashed = (p: string) => resolve(p).replace(/\\/g, '/')

function modelFiles(root: string): Array<{ rel: string; bytes: number; mtimeMs: number }> {
  const out: Array<{ rel: string; bytes: number; mtimeMs: number }> = []
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (TRANSIENT_NAME.test(name)) continue
      const childAbs = join(abs, name)
      const childRel = rel ? `${rel}/${name}` : name
      const s = lstatSync(childAbs)
      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) { if (!FROZEN_SKIP_DIRS.includes(name)) walk(childAbs, childRel); continue }
      out.push({ rel: childRel, bytes: s.size, mtimeMs: s.mtimeMs })
    }
  }
  walk(root, '')
  return out
}

/** The record in the guard folder, or null when there is none or it cannot be parsed. */
export function readModelsRecord(guard: string = guardDir()): ModelsRecord | null {
  const r = loadRecord(guard)
  return r.record
}

function loadRecord(guard: string): { record: ModelsRecord | null; missing: boolean; why: string | null } {
  let text: string
  try {
    text = readFileSync(recordPathOf(guard), 'utf-8')
  } catch (e) {
    if (isMissing(e)) return { record: null, missing: true, why: null }
    return { record: null, missing: false, why: codeOf(e) }
  }
  try {
    const r = JSON.parse(text) as ModelsRecord
    if (!r || r.schema !== 1 || typeof r.root !== 'string' || !Array.isArray(r.files)) return { record: null, missing: false, why: 'not a models record' }
    return { record: r, missing: false, why: null }
  } catch (e) {
    return { record: null, missing: false, why: textOf(e) }
  }
}

/**
 * Pure: the models folder against its record. Roots are compared after `path.resolve`, with
 * trailing separators stripped, slashes normalised and, for `win32`, case folded; then names,
 * sizes and times. `recordPath` only names the record in the sentence.
 */
export function compareModelsRecord(record: ModelsRecord, resolvedRoot: string,
  files: Array<{ rel: string; bytes: number; mtimeMs: number }>, platform: NodeJS.Platform = process.platform,
  recordPath = 'the models hash record'): string | null {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? r.toLowerCase() : r
  }
  if (norm(record.root) !== norm(resolvedRoot)) {
    return `this process resolves the models folder as ${resolve(resolvedRoot)} but ${recordPath} was taken for ${record.root}; set LOCALCODE_MODELS_DIR to the recorded folder, or take the record again with: bun scripts/cynco-guard.mjs hash-models`
  }
  const rec = new Map(record.files.map(f => [f.rel, f]))
  const now = new Map(files.map(f => [f.rel, f]))
  const diffs: Array<{ rel: string; what: string }> = []
  for (const [rel, f] of rec) {
    const x = now.get(rel)
    if (!x) diffs.push({ rel, what: 'removed' })
    else if (x.bytes !== f.bytes) diffs.push({ rel, what: 'size' })
    else if (x.mtimeMs !== f.mtimeMs) diffs.push({ rel, what: 'time' })
  }
  for (const rel of now.keys()) if (!rec.has(rel)) diffs.push({ rel, what: 'added' })
  if (diffs.length === 0) return null
  diffs.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
  return `the models folder differs from its hash record: ${diffs.length} file(s) (first: ${diffs[0]!.rel} ${diffs[0]!.what}); if you changed the models yourself: bun scripts/cynco-guard.mjs hash-models`
}

/** About fifteen `stat` calls and no hashing. Null, or the sentence that refuses the run. Writes nothing. */
export function checkModelsRecord(o: { root?: string; guard?: string; platform?: NodeJS.Platform } = {}): string | null {
  const guard = o.guard ?? guardDir()
  const resolved = resolve(o.root ?? modelsDir())
  let isDir = false
  try { isDir = statSync(resolved).isDirectory() } catch (e) { if (!isMissing(e)) console.error(`[guard] the models folder ${resolved} cannot be read (${codeOf(e)})`) }
  if (!isDir) {
    return `the models folder ${resolved} does not exist (it comes from LOCALCODE_MODELS_DIR, or is ${cyncoHome()}/models when that is unset); open a new terminal after scripts\\cynco-containment-setup.ps1, or see docs/containment-setup.md`
  }
  const recordPath = shown(guard, 'models-hashes.json')
  const r = loadRecord(guard)
  if (r.missing) return `there is no models hash record at ${recordPath}; take it once with: bun scripts/cynco-guard.mjs hash-models`
  if (!r.record) return `the models hash record ${recordPath} cannot be read (${r.why}); take it again with: bun scripts/cynco-guard.mjs hash-models`
  let files: Array<{ rel: string; bytes: number; mtimeMs: number }>
  try {
    files = modelFiles(resolved)
  } catch (e) {
    return `the models folder ${resolved} cannot be read (${codeOf(e)}); if you changed the models yourself: bun scripts/cynco-guard.mjs hash-models`
  }
  return compareModelsRecord(r.record, resolved, files, o.platform ?? process.platform, recordPath)
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((ok, fail) => {
    const s = createReadStream(file)
    s.on('data', chunk => h.update(chunk))
    s.on('error', fail)
    s.on('end', () => ok())
  })
  return h.digest('hex')
}

/**
 * Streams SHA-256 over every file of the models folder and writes the record (UTF-8, no
 * byte-order mark) through a temporary name. A file whose size and time match the existing record
 * keeps its recorded hash unless `all`. The guard folder must exist; it is never created here.
 */
export async function hashModels(o: { root?: string; guard?: string; all?: boolean; onFile?: (rel: string, bytes: number) => void } = {}): Promise<ModelsRecord> {
  const guard = o.guard ?? guardDir()
  const root = resolve(o.root ?? modelsDir())
  const folder = (p: string, what: string, how: string) => {
    let ok = false
    try { ok = statSync(p).isDirectory() } catch (e) { if (!isMissing(e)) throw new Error(`the ${what} ${p} cannot be read (${codeOf(e)})`) }
    if (!ok) throw new Error(`the ${what} ${p} does not exist or is not a folder; ${how}`)
  }
  folder(guard, 'guard folder', 'scripts\\cynco-containment-setup.ps1 creates it')
  folder(root, 'models folder', 'it comes from LOCALCODE_MODELS_DIR, or is the models folder of the state folder when that is unset')
  const prior = o.all ? null : loadRecord(guard).record
  const reuse = prior && keyOf(prior.root) === keyOf(root)
    ? new Map(prior.files.map(f => [f.rel, f])) : new Map<string, ModelsRecord['files'][number]>()
  const files: ModelsRecord['files'] = []
  for (const f of modelFiles(root)) {
    const old = reuse.get(f.rel)
    if (old && old.bytes === f.bytes && old.mtimeMs === f.mtimeMs) {
      files.push({ ...f, sha256: old.sha256 })
      continue
    }
    o.onFile?.(f.rel, f.bytes)
    files.push({ ...f, sha256: await sha256Of(join(root, ...f.rel.split('/'))) })
  }
  const record: ModelsRecord = { schema: 1, taken: new Date().toISOString(), root: slashed(root), files }
  writeAtomic(recordPathOf(guard), JSON.stringify(record, null, 2) + '\n')
  return record
}

/** Re-hashes every file and compares with the record. Writes nothing. */
export async function verifyModelsDeep(o: { root?: string; guard?: string } = {}): Promise<{ ok: boolean; mismatches: Array<{ rel: string; why: string }> }> {
  const guard = o.guard ?? guardDir()
  const root = resolve(o.root ?? modelsDir())
  const r = loadRecord(guard)
  if (!r.record) {
    return { ok: false, mismatches: [{ rel: '(record)', why: r.missing ? `there is no models hash record at ${shown(guard, 'models-hashes.json')}` : `the models hash record cannot be read (${r.why})` }] }
  }
  const mismatches: Array<{ rel: string; why: string }> = []
  let files: Array<{ rel: string; bytes: number; mtimeMs: number }>
  try {
    files = modelFiles(root)
  } catch (e) {
    return { ok: false, mismatches: [{ rel: '(folder)', why: `the models folder ${root} cannot be read (${codeOf(e)})` }] }
  }
  const now = new Map(files.map(f => [f.rel, f]))
  for (const f of r.record.files) {
    if (!now.has(f.rel)) { mismatches.push({ rel: f.rel, why: 'removed' }); continue }
    let sum: string
    try {
      sum = await sha256Of(join(root, ...f.rel.split('/')))
    } catch (e) {
      mismatches.push({ rel: f.rel, why: `cannot be read (${codeOf(e)})` })
      continue
    }
    if (sum !== f.sha256) mismatches.push({ rel: f.rel, why: 'content differs from the recorded hash' })
  }
  const recorded = new Set(r.record.files.map(f => f.rel))
  for (const f of files) if (!recorded.has(f.rel)) mismatches.push({ rel: f.rel, why: 'added' })
  return { ok: mismatches.length === 0, mismatches }
}

// ─── The presence tripwire (directive 17, entry 4.M2) ────────────────────────────────────────

type Loss = { kind: 'presence' | 'latch'; summary: string; publicSummary: string; compare: Compare | null }

interface Tripwire {
  ctx: RunContainment
  onLoss: (loss: Loss) => void
  roots: PresenceRoot[]
  before: PresenceSection[]
  exclude: string[]
  minGapMs: number
  confirmMs: number
  now: () => number
  last: number | null
  timer: ReturnType<typeof setInterval> | null
  /** The confirmed check under way, if any: a call made meanwhile waits for its answer (wave 15). */
  pending: Promise<string | null> | null
  /** One listing of the roots; `presenceTripwireListing` but in a test that makes one look fail (wave 15b). */
  listing: typeof presenceTripwireListing
}

/**
 * The shortest time between two looks. One look lists every PRESENCE root but the volumes, the home's
 * top level and since wave 15 the application roots counted: about 61 ms on this PC by the medians
 * measured in wave 8 (48 ms with the application roots by name only; not measured again since: the
 * integrity paragraph of the package document of engine/tools), so tool calls back to back spend up
 * to about 6% of the event loop on it. A model that
 * deletes and then keeps calling tools quickly gets at most about one second of further tools (review
 * of wave 5: it was ten). During one long call the only look is the timer (`TRIPWIRE_INTERVAL_MS`).
 */
export const TRIPWIRE_MIN_GAP_MS = 1_000

/**
 * The timer's interval (wave 15; 60 s until then). During one long tool call the timer is the only
 * look, so a call that deletes runs on for up to this long after its first loss. Six looks of about
 * 61 ms a minute (the application roots counted) are about 0.6% of the event loop the dashboard and
 * the phone are served from (F225).
 */
export const TRIPWIRE_INTERVAL_MS = 10_000

/**
 * How long the confirmed check waits before its second look (wave 15, F248). A loss counts only when
 * both looks see the same change: a folder another program removes and makes again at the moment of
 * a look, which latched a run on one look, does not. The wait is a timer, not a sleep: the event loop
 * goes on meanwhile, and a tool call made during it waits for the answer.
 */
export const TRIPWIRE_CONFIRM_MS = 1_000

let wire: Tripwire | null = null
/** A loss seen by this process. Kept for the life of the process: no stop and no second start clears it. */
let lostForProcess: Loss | null = null

const tripwireHalt = (ctx: RunContainment) =>
  haltRefusal(ctx.folders.guard, ctx.home, {
    sandboxRoot: dirname(ctx.sandbox.root), missionCwd: ctx.missionCwd, unprotectedVolumes: ctx.unprotectedVolumes,
  })

/**
 * The roots the in-run tripwire lists, from a baseline's PRESENCE roots: no volume root and no network
 * drive (see `startPresenceTripwire`); every other root as the baseline lists it. Since wave 15
 * (NOW.md:64, the owner's "do it") the application roots are counted here too, with the allowance
 * `diffPresence` applies to them at the settle (`APPDATA_LOSS_AT`), so an application folder emptied in
 * place stops the run instead of waiting for the settle; `Temp` and `D3DSCache` stay by name
 * (`uncounted`). Until then they were looked at by name only: counting them costs about 13 ms more a
 * look on this PC (61 ms against 48, the integrity paragraph of the package document of engine/tools).
 * Pure.
 */
export function presenceTripwireRoots(roots: PresenceRoot[]): PresenceRoot[] {
  return roots.filter(r => !r.volume && !r.network)
}

/**
 * One look of the tripwire over `presenceTripwireRoots`: each root as the baseline lists it. A root
 * that can no longer be listed is a root that is gone (P1). Read-only.
 */
export function presenceTripwireListing(roots: PresenceRoot[], exclude: string[], notes: string[]): PresenceSection[] {
  return roots.map(r => {
    try {
      return listPresence(r, exclude, notes)
    } catch (e) {
      notes.push(textOf(e))
      return { root: r.path, exists: false, listed: true, entries: {} } as PresenceSection
    }
  })
}

/**
 * Keeps the baseline's PRESENCE section and re-checks it on a timer and before tool calls. Volume
 * roots are left out (mapped network drives and every other volume): a synchronous listing of a
 * drive that sleeps or fails cannot be bounded and would hold the event loop; the baseline and the
 * settling compare, run by the starter in its own process, compare them. One tripwire per process;
 * starting again replaces the old one, unless a loss was already seen, which refuses the start and
 * leaves everything as it is.
 */
export function startPresenceTripwire(a: {
  ctx: RunContainment
  onLoss: (loss: { kind: 'presence' | 'latch'; summary: string; publicSummary: string; compare: Compare | null }) => void
  intervalMs?: number; minGapMs?: number; confirmMs?: number; now?: () => number; timer?: boolean
  /** The listing each look makes; default `presenceTripwireListing`. A test seam (wave 15b): a look whose listing throws has failed. */
  listing?: typeof presenceTripwireListing
}): { ok: true; stop: () => void; folders: number; roots: number } | { ok: false; reason: string } {
  if (lostForProcess !== null) return { ok: false, reason: INTEGRITY_LOSS_TO_MODEL }
  stopPresenceTripwire()
  if (!RUN_ID_RE.test(a.ctx.runId)) return { ok: false, reason: `${a.ctx.runId} is not a run id` }
  const refusal = tripwireHalt(a.ctx)
  if (refusal !== null) return { ok: false, reason: refusal }
  const file = beforePath(a.ctx.folders.guard, a.ctx.runId)
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (e) {
    if (isMissing(e)) return { ok: false, reason: `no integrity baseline exists for run ${a.ctx.runId}; the starter takes it before the engine starts` }
    return { ok: false, reason: `the integrity baseline of run ${a.ctx.runId} cannot be read (${codeOf(e)})` }
  }
  let m: Manifest
  try {
    m = JSON.parse(text) as Manifest
  } catch (e) {
    return { ok: false, reason: `the integrity baseline of run ${a.ctx.runId} cannot be read (${textOf(e)})` }
  }
  if (!m || !m.roots || !Array.isArray(m.roots.presence) || !Array.isArray(m.presence)
    || m.presence.some(p => !p || typeof p.entries !== 'object' || p.entries === null)) {
    return { ok: false, reason: `the integrity baseline of run ${a.ctx.runId} cannot be read (not a baseline)` }
  }
  if (m.runId !== a.ctx.runId) {
    return { ok: false, reason: `the integrity baseline of run ${a.ctx.runId} cannot be read (it is the baseline of run ${String(m.runId)})` }
  }
  const roots = presenceTripwireRoots(m.roots.presence)
  const kept = new Set(roots.map(r => keyOf(r.path)))
  const before = m.presence.filter(p => kept.has(keyOf(p.root)))
  const folders = before.reduce((n, p) => n + Object.values(p.entries).filter(e => e?.k === 'd').length, 0)
  const w: Tripwire = {
    ctx: a.ctx, onLoss: a.onLoss, roots, before, exclude: Array.isArray(m.exclude) ? m.exclude : [],
    minGapMs: a.minGapMs ?? TRIPWIRE_MIN_GAP_MS, confirmMs: a.confirmMs ?? TRIPWIRE_CONFIRM_MS,
    now: a.now ?? Date.now, last: null, timer: null, pending: null, listing: a.listing ?? presenceTripwireListing,
  }
  wire = w
  if (a.timer !== false) {
    w.timer = setInterval(() => { void presenceTripwireConfirmed() }, a.intervalMs ?? TRIPWIRE_INTERVAL_MS)
    w.timer.unref?.()
  }
  return { ok: true, stop: () => { if (wire === w) stopPresenceTripwire() }, folders, roots: roots.length }
}

/** One look of the tripwire: the latch first, then the listing against the baseline. Never throws. */
type Look =
  | { state: 'clean' }
  | { state: 'latch'; loss: Loss }
  | { state: 'changed'; changes: Change[]; notes: string[]; entries: number; t0: number }
  | { state: 'failed'; why: string }

function lookOnce(w: Tripwire): Look {
  try {
    const refusal = tripwireHalt(w.ctx)
    if (refusal !== null) {
      return { state: 'latch', loss: { kind: 'latch', summary: refusal, publicSummary: 'the integrity latch is present, or the guard folder can no longer be used', compare: null } }
    }
    const t0 = Date.now()
    const notes: string[] = []
    const after = w.listing(w.roots, w.exclude, notes)
    const changes = diffPresence(w.before, after, w.roots, notes, true)
    if (changes.length === 0) return { state: 'clean' }
    return { state: 'changed', changes, notes, entries: after.reduce((n, p) => n + Object.keys(p.entries).length, 0), t0 }
  } catch (e) {
    return { state: 'failed', why: textOf(e) }
  }
}

/** The loss a look (or two looks' common changes) amounts to. The reason of a failure can name a path: the owner's summary only. */
function lossOf(w: Tripwire, look: Exclude<Look, { state: 'clean' }>): Loss {
  if (look.state === 'latch') return look.loss
  const failed = (why: string): Loss => ({ kind: 'presence', summary: `${PRESENCE_FAILED_PUBLIC} (${why})`, publicSummary: PRESENCE_FAILED_PUBLIC, compare: null })
  if (look.state === 'failed') return failed(look.why)
  try {
    const d = finish(look.changes, look.notes)
    const compare = compareFrom(w.ctx.runId, 'tripwire', new Date().toISOString(), 'reading', d, look.entries, Date.now() - look.t0, false)
    return { kind: 'presence', summary: d.summary, publicSummary: d.publicSummary, compare }
  } catch (e) {
    return failed(textOf(e))
  }
}

/** Keeps the loss for the life of the process and reports it once. */
function latchLoss(w: Tripwire, loss: Loss): string {
  if (lostForProcess !== null) return INTEGRITY_LOSS_TO_MODEL
  lostForProcess = loss
  try {
    w.onLoss(loss)
  } catch (e) {
    console.log(`[integrity] onLoss failed: ${textOf(e)}`)
  }
  return INTEGRITY_LOSS_TO_MODEL
}

/** Whether it is time to look again; marks the look when it is. */
function lookDue(w: Tripwire, now?: number): boolean {
  const t = now ?? w.now()
  if (w.last !== null && t - w.last < w.minGapMs) return false
  w.last = t
  return true
}

/**
 * Null while nothing was lost (or it is not time to look again); `INTEGRITY_LOSS_TO_MODEL` once a
 * loss was seen, for the rest of the process, whether or not a tripwire is still running. Folders
 * only: a file replaced by delete-then-rename is absent for an instant. One look, no confirmation.
 * No caller in the engine or the acceptance asks it: the executor, the timer and the bypass sites (the
 * contract check, best-of-N, LSP, the daemon's precheck) ask `presenceTripwireConfirmed`, and the
 * acceptance's box was switched to it in wave 18. It stays for
 * the tests of the single look in engine/__tests__/integrity.test.ts.
 */
export function presenceTripwireCheck(now?: number): string | null {
  if (lostForProcess !== null) return INTEGRITY_LOSS_TO_MODEL
  const w = wire
  if (w === null) return null
  if (!lookDue(w, now)) return null
  const look = lookOnce(w)
  if (look.state === 'clean') return null
  return latchLoss(w, lossOf(w, look))
}

/**
 * The check the engine asks before a tool call and on its timer (wave 15, F248): as
 * `presenceTripwireCheck`, but a change counts only when a second look, `TRIPWIRE_CONFIRM_MS` later,
 * sees the same change (the same root and entry, as the settle's confirming walk keys it); a change
 * the second look no longer sees, or sees only there, is not counted now and is looked at again at
 * the next check. The latch needs no second look. A look that fails is a change: a failure at both
 * looks is a loss, and a change one look saw stands when the other failed (a change seen is not
 * dropped). While a confirmation is under way every call waits for its answer, inside the gap too.
 */
export function presenceTripwireConfirmed(now?: number): Promise<string | null> {
  if (lostForProcess !== null) return Promise.resolve(INTEGRITY_LOSS_TO_MODEL)
  const w = wire
  if (w === null) return Promise.resolve(null)
  if (w.pending !== null) return w.pending
  if (!lookDue(w, now)) return Promise.resolve(null)
  const first = lookOnce(w)
  if (first.state === 'clean') return Promise.resolve(null)
  if (first.state === 'latch') return Promise.resolve(latchLoss(w, first.loss))
  const p = confirmLoss(w, first).finally(() => { if (w.pending === p) w.pending = null })
  w.pending = p
  return p
}

async function confirmLoss(w: Tripwire, first: Extract<Look, { state: 'changed' | 'failed' }>): Promise<string | null> {
  await new Promise<void>(res => { setTimeout(res, w.confirmMs) })
  if (lostForProcess !== null) return INTEGRITY_LOSS_TO_MODEL
  // Wave 15b (check P1-C4): a tripwire stopped (or replaced) during the wait is not looked at again and reports to
  // no one; the starter's settle compares what is there after the stop.
  if (wire !== w) return null
  const second = lookOnce(w)
  if (second.state === 'latch') return latchLoss(w, second.loss)
  if (second.state === 'clean') {
    console.log(`[integrity] tripwire: ${first.state === 'failed' ? 'a look that failed' : `${first.changes.length} change(s)`} not seen again ${w.confirmMs} ms later; not counted`)
    return null
  }
  if (first.state === 'failed') return latchLoss(w, lossOf(w, second))
  if (second.state === 'failed') return latchLoss(w, lossOf(w, { ...first, notes: [...first.notes, `the confirming look failed (${second.why}); the first look is reported`] }))
  const seen = new Set(first.changes.map(changeKey))
  const confirmed = second.changes.filter(c => seen.has(changeKey(c)))
  if (confirmed.length === 0) {
    console.log(`[integrity] tripwire: ${first.changes.length} change(s) not seen again ${w.confirmMs} ms later (${second.changes.length} other change(s) seen then, looked at again at the next check); not counted`)
    return null
  }
  return latchLoss(w, lossOf(w, { ...second, changes: confirmed }))
}

/** Clears the timer and the running tripwire. A loss this process saw stays (`presenceTripwireConfirmed` and `presenceTripwireCheck` still answer it). */
export function stopPresenceTripwire(): void {
  if (wire?.timer) clearInterval(wire.timer)
  wire = null
}

/**
 * For the test suite only (a text pin in engine/__tests__/integrity.test.ts keeps every other caller
 * out): stops the tripwire AND forgets a loss. Refuses outside the test runner.
 */
export function resetPresenceTripwireForTests(): void {
  if (process.env.VITEST === undefined) throw new Error('resetPresenceTripwireForTests is for the test suite only')
  stopPresenceTripwire()
  lostForProcess = null
}
