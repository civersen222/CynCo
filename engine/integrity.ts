/**
 * engine/integrity.ts: the integrity layer of unattended runs (F242).
 *
 * On 2026-11-22 an unattended mission deleted every dot-folder of the owner's home folder and ran
 * 108 more turns, for 2 hours 10 minutes, before anyone noticed; every record of the run lived in
 * the folder it deleted. This module is what notices, and what stops everything afterwards:
 *
 * - a manifest of the protected folders, in two classes. FROZEN folders (the models, the profiles,
 *   the held-out gates, `.ssh`, the local model store) must not change at all during a run; a
 *   recursive stat-only walk records every entry's kind, size and time. PRESENCE folders (the home
 *   folder's dot-entries, the desk tools' folder, the state folder and its authoring and campaign
 *   folders, the top of every volume integrity labels cannot protect) must not LOSE anything; one
 *   listing per folder records names and child counts.
 * - the baseline pair, keyed by a run id that is used once: the starter takes the baseline before
 *   its engine starts (`takeBaseline`), the early reading compares without closing it
 *   (`compareRun`), and the settling compare after the engine is confirmed dead closes it
 *   (`settleRun`). A compare that cannot be done is a change.
 * - the integrity latch, `<guard>/HALT.json`: written first, create-exclusive, on any change; then
 *   the latch log, then one page per run (kept in `<guard>/unsent/` when it cannot be sent). Every
 *   unattended starter refuses while it exists (`haltRefusal`), and only the owner clears it, at a
 *   terminal (`scripts/cynco-guard.mjs clear`).
 * - the models hash record, `<guard>/models-hashes.json`, and its cheap check before a run.
 * - the in-run tripwire: a contained engine re-lists its baseline's PRESENCE folders on a timer and
 *   before tool calls, and reports a lost folder once.
 *
 * Everything persisted is in the guard folder (`guardDir()`, outside the home folder), so nothing
 * that decides "may this run" is read from the home folder. The module creates the guard folder's
 * sub-folders and never the guard folder itself, never unlinks, makes no network call (every pager
 * is a parameter) and starts no process; the only child anything here can cause is the volume
 * listing of `listUnprotectedVolumes`, owned by engine/containment.ts.
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readlinkSync, readSync, renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
}
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
}

export interface Compare {
  run: string; at: string; by: string
  kind: 'reading' | 'settle'
  settled: boolean                    // true: the baseline is closed
  from: 'live' | 'recorded'
  changed: boolean
  changes: Change[]                   // at most 200, FROZEN first, each class sorted by path
  changeCount: number                 // the true total
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

type Volume = { root: string; kind: 'local' | 'removable' | 'network' }
type Context = { campaignId?: string; wave?: number; cwd?: string }

const MAX_CHANGES = 200
const LATCH_CHANGES = 50
const DEFAULT_CONFIRM_MS = 2000
const PAGE_TITLE = 'CynCo integrity latch'
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

/** Creates `<guard>/<sub>` when missing; never the guard folder itself. */
function ensureSub(guard: string, sub: string): string {
  const p = join(guard, sub)
  try {
    mkdirSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
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
  volumes?: Array<{ root: string; kind: 'local' | 'removable' | 'network' }>
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
  addF(join(home, '.ollama', 'models'))
  addP(home, { dotOnly: true, files: true, counts: true })
  // the desk tools' own folder: its sub-folders by name; its owner program prunes several of them by age, so no counts
  addP(join(home, '.claude'), {})
  for (const s of states) { addP(join(s, 'authoring'), { counts: true }); addP(join(s, 'campaigns'), { counts: true }) }
  for (const s of states) addP(s, {})
  for (const v of o.volumes ?? []) addP(v.root, { files: true, volume: true, network: v.kind === 'network' })
  return { frozen, presence }
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
    let target: string
    try { target = readlinkSync(r.path) } catch (e) { target = `(unreadable: ${codeOf(e)})` }
    notes.push(`${r.path}: is a link; recorded as a link, not entered`)
    out.exists = true
    out.entries.push(['', 'l', 0, 0, target])
    return out
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
        try { target = readlinkSync(childAbs) } catch (e) { target = `(unreadable: ${codeOf(e)})` }
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

function kindOf(s: Stats): 'f' | 'd' | 'l' {
  return s.isSymbolicLink() ? 'l' : s.isDirectory() ? 'd' : 'f'
}

/**
 * One listing of a PRESENCE root and, where `counts` is on, one per folder in it. A folder with no
 * children is recorded with `n: 0` and never compared, which is how "an empty folder at the
 * baseline is not recorded" is kept while a folder that is still there at the compare is still seen.
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
  let names: string[]
  try {
    names = readdirSync(r.path)
  } catch (e) {
    if (r.volume) return unlisted(codeOf(e))
    throw new ManifestError(`the protected folder ${r.path} cannot be listed (${codeOf(e)})`)
  }
  out.exists = true
  const realRoot = realPathOf(r.path, { quiet: true })
  const ex = excludesFor(realRoot, exclude)
  const excluded = (p: string) => ex.length > 0 && ex.some(x => isInside(x, p))
  for (const name of names.sort()) {
    if (r.dotOnly && !name.startsWith('.')) continue
    if (TRANSIENT_NAME.test(name)) continue
    if (r.volume && VOLUME_SKIP.test(name)) continue
    const realChild = join(realRoot, name)
    if (excluded(realChild)) continue
    let s: Stats
    try {
      s = lstatSync(join(r.path, name))
    } catch (e) {
      if (isMissing(e)) continue
      // Its existence is still a fact worth keeping; its kind is not known.
      notes.push(`${join(r.path, name)}: could not be looked at (${codeOf(e)})`)
      continue
    }
    const k = kindOf(s)
    if (k === 'f' && !r.files) continue
    let n: number | null = null
    if (r.counts && k === 'd') {
      try {
        n = readdirSync(join(r.path, name)).filter(c => !TRANSIENT_NAME.test(c) && !excluded(join(realChild, c))).length
      } catch (e) {
        notes.push(`${join(r.path, name)}: its children could not be counted (${codeOf(e)})`)
        n = null
      }
    }
    out.entries[name] = { k, n }
  }
  return out
}

/** Read-only: `lstat` and `readdir` only; never opens a file, never follows a link or junction. */
export function takeManifest(roots: Roots, o: { runId: string; by: string; home: string; exclude?: string[]; now?: () => Date }): Manifest {
  const takenAt = (o.now ?? (() => new Date()))().toISOString()
  const exclude = (o.exclude ?? []).map(p => realPathOf(p, { quiet: true }))
  const notes: string[] = []
  const frozen = roots.frozen.map(r => walkFrozen(r, exclude, notes))
  const presence = roots.presence.map(r => listPresence(r, exclude, notes))
  return { schema: 1, runId: o.runId, takenAt, by: o.by, home: o.home, exclude, roots, frozen, presence, notes }
}

// ─── compareManifests ────────────────────────────────────────────────────────────────────────

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
      else if (e[1] === 'l' && x[4] !== e[4]) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'modified', detail: 'link target' })
    }
    for (const rel of am.keys()) {
      if (!bm.has(rel) && !mutable.has(rel)) changes.push({ class: 'FROZEN', root: b.root, path: rel, kind: 'added' })
    }
  }
  return changes
}

/**
 * PRESENCE, loss only. P1 a root gone (never for a volume), P2 a recorded entry gone or of another
 * kind, P3 a counted folder down to fewer than half of its children and by at least two. With
 * `dirsOnly` (the tripwire) P2 looks at folders only.
 */
function diffPresence(before: PresenceSection[], after: PresenceSection[], roots: PresenceRoot[], notes: string[], dirsOnly = false): Change[] {
  const changes: Change[] = []
  const afterBy = new Map(after.map(p => [keyOf(p.root), p]))
  const optsBy = new Map(roots.map(r => [keyOf(r.path), r]))
  for (const b of before) {
    if (!b.exists || !b.listed) continue
    const opts = optsBy.get(keyOf(b.root))
    const a = afterBy.get(keyOf(b.root))
    if (!a || !a.listed) { notes.push(`${b.root}: could not be listed at the compare; not compared`); continue }
    if (!a.exists) {
      if (opts?.volume) { notes.push(`${b.root}: is not attached at the compare; not compared`); continue }
      changes.push({ class: 'PRESENCE', root: b.root, path: '', kind: 'root-gone' })
      continue
    }
    for (const [name, e] of Object.entries(b.entries)) {
      if (opts?.counts && e.k === 'd' && e.n === 0) continue
      if (dirsOnly && e.k !== 'd') continue
      const x = a.entries[name]
      if (!x || x.k !== e.k) { changes.push({ class: 'PRESENCE', root: b.root, path: name, kind: 'gone' }); continue }
      if (opts?.counts && e.k === 'd' && e.n !== null && x.n !== null && x.n < e.n / 2 && e.n - x.n >= 2) {
        changes.push({ class: 'PRESENCE', root: b.root, path: name, kind: 'emptied', detail: `${e.n} -> ${x.n}` })
      }
    }
  }
  return changes
}

type Diff = Pick<Compare, 'changed' | 'changes' | 'changeCount' | 'summary' | 'publicSummary' | 'firstClass' | 'firstRoot' | 'notes'>

const changeKey = (c: Change) => `${c.class}|${keyOf(c.root)}|${c.path}|${c.kind}`
const sortKey = (c: Change) => `${c.class === 'FROZEN' ? 0 : 1}|${c.root}|${c.path}`

function finish(all: Change[], notes: string[]): Diff {
  const sorted = [...all].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0))
  const first = sorted[0]
  if (!first) {
    return { changed: false, changes: [], changeCount: 0, summary: 'no change in protected folders', publicSummary: 'no change in protected folders', firstClass: null, firstRoot: null, notes }
  }
  const where = first.path ? `${first.root}/${first.path}` : first.root
  return {
    changed: true,
    changes: sorted.slice(0, MAX_CHANGES),
    changeCount: sorted.length,
    summary: `${sorted.length} change(s) in protected folders; first: ${first.class} ${where} ${first.kind}${first.detail ? ` (${first.detail})` : ''}`,
    publicSummary: `${sorted.length} change(s) in protected folders (first: ${first.class})`,
    firstClass: first.class,
    firstRoot: first.root,
    notes,
  }
}

function diffAll(before: Manifest, after: Manifest): { changes: Change[]; notes: string[] } {
  const notes = [...after.notes]
  const changes = [...diffFrozen(before, after), ...diffPresence(before.presence, after.presence, before.roots.presence, notes)]
  return { changes, notes }
}

/** Pure: what changed between two manifests of the same roots. */
export function compareManifests(before: Manifest, after: Manifest): Diff {
  const d = diffAll(before, after)
  return finish(d.changes, d.notes)
}

const entriesOf = (m: Manifest) =>
  m.frozen.reduce((n, f) => n + f.entries.length, 0) + m.presence.reduce((n, p) => n + Object.keys(p.entries).length, 0)

// ─── The baseline ────────────────────────────────────────────────────────────────────────────

/** The pre-step. Each failure is a `ManifestError` whose message is the reason the caller prints. */
export function takeBaseline(a: {
  runId: string; cwd?: string | null; also?: string[]; by: string
  guard?: string; home?: string; roots?: Roots; checkModels?: boolean
  volumes?: () => Array<{ root: string; kind: 'local' | 'removable' | 'network' }>; now?: () => Date
  /** The sandbox root the guard folder must not be inside; default `sandboxRoot()`. */
  sandboxRoot?: string | null
}): { runId: string; takenAt: string; frozenEntries: number; presenceEntries: number; ms: number; notes: string[] } {
  const t0 = Date.now()
  if (typeof a.runId !== 'string' || !RUN_ID_RE.test(a.runId)) throw new ManifestError(`${a.runId} is not a run id`)
  const guard = a.guard ?? guardDir()
  const home = resolve(a.home ?? homedir())
  const refusal = haltRefusal(a.guard, home, { missionCwd: a.cwd ?? null, sandboxRoot: a.sandboxRoot })
  if (refusal !== null) throw new ManifestError(refusal, 'refusal')
  if (a.checkModels !== false) {
    const models = checkModelsRecord({ guard })
    if (models !== null) throw new ManifestError(models, 'refusal')
  }
  const target = beforePath(guard, a.runId)
  if (existsSync(target)) throw new ManifestError(`a baseline for run ${a.runId} already exists; a run id is used once`)

  let roots = a.roots
  if (!roots) {
    let volumes: Volume[]
    try {
      volumes = (a.volumes ?? listUnprotectedVolumes)().map(v => ({ root: v.root, kind: v.kind }))
    } catch (e) {
      // An unknown answer is never read as "no such volume".
      const msg = textOf(e)
      throw new ManifestError(msg.startsWith('the attached volumes could not be listed') ? msg : `the attached volumes could not be listed (${msg})`)
    }
    roots = protectedRoots({ home, volumes })
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

  const m = takeManifest(roots, { runId: a.runId, by: a.by, home, exclude, now: a.now })
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
    return { state: 'open', manifest: m }
  } catch (e) {
    return { state: 'unreadable', why: textOf(e) }
  }
}

interface CheckLine {
  run: string; kind: 'reading' | 'settle'; baselineTakenAt: string | null; at: string; by: string
  changed: boolean; changeCount: number; publicSummary: string; ms: number
  firstClass?: 'FROZEN' | 'PRESENCE' | null; firstRoot?: string | null; entries?: number; error?: string
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

function recordedSettle(guard: string, runId: string): Compare | null {
  const l = readChecks(guard).find(c => c.run === runId && c.kind === 'settle')
  if (!l) return null
  return {
    run: runId, at: l.at, by: l.by, kind: 'settle', settled: true, from: 'recorded',
    changed: l.changed, changes: [], changeCount: l.changeCount,
    summary: l.publicSummary, publicSummary: l.publicSummary,
    firstClass: l.firstClass ?? null, firstRoot: l.firstRoot ?? null,
    entries: l.entries ?? 0, ms: l.ms, notes: [], latchPath: null,
    ...(l.error ? { error: l.error } : {}),
  }
}

/** A compare that could not be done: a change, by rule 7. */
function failedCompare(runId: string, by: string, at: string, kind: 'reading' | 'settle', why: string, ms: number): Compare {
  const s = `the integrity check could not be completed (${why})`
  return {
    run: runId, at, by, kind, settled: false, from: 'live', changed: true, changes: [], changeCount: 0,
    summary: s, publicSummary: s, firstClass: null, firstRoot: null, entries: 0, ms, notes: [], latchPath: null, error: why,
  }
}

/**
 * Walk the baseline's own roots again and compare. When anything differs, or the walk throws,
 * wait `confirmMs` and walk once more, keeping only changes present both times.
 */
function confirmedWalk(before: Manifest, o: { by: string; confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date })
  : { diff: Diff | null; error: string | null; after: Manifest | null; entries: number } {
  const walk = () => takeManifest(before.roots, { runId: before.runId, by: o.by, home: before.home, exclude: before.exclude, now: o.now })
  let a1: Manifest | null = null
  let e1: string | null = null
  try { a1 = walk() } catch (e) { e1 = textOf(e) }
  const d1 = a1 ? diffAll(before, a1) : null
  if (a1 && d1 && d1.changes.length === 0) return { diff: finish([], d1.notes), error: null, after: a1, entries: entriesOf(a1) }
  ;(o.sleep ?? syncSleep)(o.confirmMs ?? DEFAULT_CONFIRM_MS)
  let a2: Manifest | null = null
  let e2: string | null = null
  try { a2 = walk() } catch (e) { e2 = textOf(e) }
  if (!a2 && !a1) return { diff: null, error: e2 ?? e1 ?? 'the walk failed twice', after: null, entries: 0 }
  if (!a2) {
    // The confirming walk failed; the first walk's changes stand (a change seen is not dropped).
    const notes = [...d1!.notes, `the confirming walk failed (${e2}); the first walk is reported`]
    return { diff: finish(d1!.changes, notes), error: null, after: a1, entries: entriesOf(a1!) }
  }
  const d2 = diffAll(before, a2)
  if (!d1) {
    const notes = [...d2.notes, `the first walk failed (${e1}); the second walk is reported`]
    return { diff: finish(d2.changes, notes), error: null, after: a2, entries: entriesOf(a2) }
  }
  const seen = new Set(d1.changes.map(changeKey))
  return { diff: finish(d2.changes.filter(c => seen.has(changeKey(c))), d2.notes), error: null, after: a2, entries: entriesOf(a2) }
}

function compareFrom(runId: string, by: string, at: string, kind: 'reading' | 'settle', d: Diff, entries: number, ms: number, settled: boolean): Compare {
  return { run: runId, at, by, kind, settled, from: 'live', ...d, entries, ms, latchPath: null }
}

const lineOf = (c: Compare, baselineTakenAt: string | null): CheckLine => ({
  run: c.run, kind: c.kind, baselineTakenAt, at: c.at, by: c.by, changed: c.changed, changeCount: c.changeCount,
  publicSummary: c.publicSummary, ms: c.ms, firstClass: c.firstClass, firstRoot: c.firstRoot, entries: c.entries,
  ...(c.error ? { error: c.error } : {}),
})

/**
 * The early reading (entry 4.B1): one `reading` line in `checks.jsonl`, the latch on a change, and
 * the baseline left open. Never throws.
 */
export async function compareRun(runId: string, o: {
  by: string; page: Pager; guard?: string
  context?: Context
  confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date
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
  context?: Context
  confirmMs?: number; sleep?: (ms: number) => void; now?: () => Date
}): Promise<Compare> {
  const guard = o.guard ?? guardDir()
  const now = o.now ?? (() => new Date())
  const t0 = Date.now()
  const at = now().toISOString()
  const trip = (cmp: Compare, reason: LatchReason, detail?: string) =>
    tripHalt({ by: o.by, run: runId, reason, page: o.page, compare: cmp, detail, guard, ...o.context, now: o.now })
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
      appendCheck(guard, lineOf(cmp, opened.manifest.takenAt))
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
          // Another caller settled first: its record is the answer. A change this walk saw still latches.
          const rec = recordedSettle(guard, runId)
          if (rec) {
            if (cmp.changed) rec.latchPath = (await trip(cmp, 'integrity-change')).latchPath
            return rec
          }
        }
        cmp.notes.push(`the baseline could not be closed (${codeOf(e)})`)
        console.error(`[guard] the baseline of run ${runId} could not be closed (${codeOf(e)})`)
      }
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

/** Reads the first few kilobytes of a baseline for its `takenAt` and `by` (a baseline is about 3 MB). */
function headOf(file: string): { takenAt: string | null; by: string | null } {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf-8')
    const takenAt = /"takenAt":"([^"]*)"/.exec(head)?.[1] ?? null
    const by = /"by":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? null
    return { takenAt, by: by === null ? null : (JSON.parse(`"${by}"`) as string) }
  } catch (e) {
    console.error(`[guard] the baseline ${file} could not be read (${codeOf(e)})`)
    return { takenAt: null, by: null }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Every open baseline, oldest first. Throws when the manifests folder exists and cannot be listed. */
export function openBaselines(guard: string = guardDir()): Array<{ runId: string; takenAt: string; by: string; ageMs: number }> {
  const dir = join(guard, 'manifests')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (isMissing(e)) return []
    throw new Error(`the open integrity baselines could not be listed (${codeOf(e)})`)
  }
  const out: Array<{ runId: string; takenAt: string; by: string; ageMs: number }> = []
  for (const name of names.filter(n => n.endsWith(BEFORE_SUFFIX))) {
    const file = join(dir, name)
    const h = headOf(file)
    let takenAt = h.takenAt
    if (takenAt === null) {
      try { takenAt = statSync(file).mtime.toISOString() } catch (e) { takenAt = new Date(0).toISOString(); console.error(`[guard] ${file}: ${codeOf(e)}`) }
    }
    out.push({ runId: name.slice(0, -BEFORE_SUFFIX.length), takenAt, by: h.by ?? '(unknown)', ageMs: Date.now() - Date.parse(takenAt) })
  }
  return out.sort((x, y) => (x.takenAt < y.takenAt ? -1 : x.takenAt > y.takenAt ? 1 : 0))
}

// ─── haltState, haltRefusal ──────────────────────────────────────────────────────────────────

function readLatch(path: string): Latch | null {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    console.error(`[guard] the integrity latch ${path} could not be read (${codeOf(e)})`)
    return null
  }
  try {
    const l = JSON.parse(text) as Latch
    return l && typeof l === 'object' && typeof l.publicSummary === 'string' ? l : null
  } catch (e) {
    console.error(`[guard] the integrity latch ${path} is not a latch record (${textOf(e)})`)
    return null
  }
}

/** Read-only and cheap: two `stat` calls, one `realpath`, one small read when latched. */
export function haltState(guard?: string, home?: string, o: { sandboxRoot?: string | null; missionCwd?: string | null } = {})
  : { state: 'clear' } | { state: 'latched'; latchPath: string; latch: Latch | null; summary: string } | { state: 'unusable'; summary: string } {
  const source = guard === undefined ? guardDirSource() : null
  const dir = guard ?? source!.dir
  const unusable = (summary: string) => ({ state: 'unusable' as const, summary })
  if (!isAbsolute(dir)) {
    return unusable(`the guard folder ${dir} is not an absolute path on this system; set LOCALCODE_GUARD_DIR to a folder outside the home folder`)
  }
  let st: Stats
  try {
    st = statSync(dir)
  } catch (e) {
    if (!isMissing(e)) return unusable(`the guard folder ${dir} cannot be read (${codeOf(e)})`)
    if (source) {
      const how = source.setTo === null ? 'unset, so this is the default' : `set to ${source.setTo}`
      return unusable(`the guard folder ${dir} does not exist (LOCALCODE_GUARD_DIR is ${how}); scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
    }
    return unusable(`the guard folder ${dir} does not exist; scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
  }
  if (!st.isDirectory()) return unusable(`the guard folder ${dir} is not a folder`)

  const latchPath = join(dir, LATCH_FILE)
  let latched = false
  try {
    statSync(latchPath)
    latched = true
  } catch (e) {
    if (!isMissing(e)) return unusable(`the guard folder ${dir} cannot be read (${codeOf(e)})`)
  }
  if (latched) {
    const latch = readLatch(latchPath)
    const what = latch ? `${latch.publicSummary}, set ${latch.at} by ${latch.by}` : 'latch unreadable'
    return {
      state: 'latched', latchPath, latch,
      summary: `the integrity latch is present at ${shown(dir, LATCH_FILE)} (${what}); only the owner clears it, at a terminal, with: ${GUARD_CLEAR_COMMAND}`,
    }
  }

  const real = realPathOf(dir, { quiet: true })
  const h = home ?? homedir()
  if (isInside(realPathOf(h, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the home folder ${h}`)
  const sb = o.sandboxRoot === undefined ? sandboxRoot() : o.sandboxRoot
  if (sb && isInside(realPathOf(sb, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the sandbox root ${sb}`)
  const cwd = o.missionCwd
  if (cwd && isInside(realPathOf(cwd, { quiet: true }), real)) return unusable(`the guard folder ${dir} resolves inside the mission folder ${cwd}`)
  return { state: 'clear' }
}

/** Null only when the guard folder is usable and holds no latch; otherwise the reason sentence. */
export function haltRefusal(guard?: string, home?: string, o: { sandboxRoot?: string | null; missionCwd?: string | null } = {}): string | null {
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
    const fallback = a.reason === 'engine-not-confirmed-dead' ? `the engine is not confirmed dead (${detail ?? 'no reason given'})`
      : a.reason === 'manifest-error' ? `the integrity check could not be completed (${detail ?? 'no reason given'})`
        : `a protected folder changed (${detail ?? 'no detail given'})`
    const summary = cmp?.summary ?? fallback
    const publicSummary = cmp?.publicSummary ?? fallback
    const latch: Latch = {
      schema: 1, at, by: a.by, pid: process.pid, host: hostname(),
      run: a.run, reason: a.reason, detail,
      campaignId: a.campaignId ?? null, wave: a.wave ?? null, cwd: a.cwd ?? null,
      summary, publicSummary,
      changeCount: cmp?.changeCount ?? 0, changes: (cmp?.changes ?? []).slice(0, LATCH_CHANGES),
      baseline: null,
    }
    try { latch.baseline = baselineOf(guard, a.run) } catch (e) { console.error(`[guard] the baseline of run ${a.run} could not be looked for (${codeOf(e)})`) }

    // 1. The latch.
    let fd: number | null = null
    try {
      fd = openSync(latchPath, 'wx')
      latched = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        latched = true
        alreadyLatched = true
        existingRun = readLatch(latchPath)?.run ?? null
      } else {
        notWritten = codeOf(e)
        console.error(`[guard] THE INTEGRITY LATCH COULD NOT BE WRITTEN (${notWritten})`)
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
      const page: Page = {
        title: PAGE_TITLE,
        message: `${lead}${a.by} ${a.run}: ${summary}. Nothing unattended runs until you clear it at the desk: ${GUARD_CLEAR_COMMAND}`,
        priority: 5,
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

/** Oldest first; each delivered page (marked `(late) `) moves to `sent/`; stops at the first failure. */
export async function flushUnsentPages(guard: string, send: Pager): Promise<{ sent: number; left: number }> {
  const dir = join(guard, 'unsent')
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch (e) {
    if (!isMissing(e)) console.error(`[guard] the unsent pages could not be listed (${codeOf(e)})`)
    return { sent: 0, left: 0 }
  }
  const items = names.map(name => {
    try {
      const p = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Page & { at?: string }
      return { name, page: p, at: typeof p.at === 'string' ? p.at : '' }
    } catch (e) {
      console.error(`[guard] the unsent page ${name} cannot be read (${textOf(e)}); left in place`)
      return { name, page: null, at: '' }
    }
  }).sort((x, y) => (x.at === y.at ? (x.name < y.name ? -1 : 1) : x.at < y.at ? -1 : 1))
  let sent = 0
  for (const it of items) {
    if (!it.page) continue
    let ok = false
    try {
      ok = (await send({ title: it.page.title, message: `(late) ${it.page.message}`, priority: it.page.priority })) === true
    } catch (e) {
      console.error(`[guard] an unsent page could not be sent again (${textOf(e)})`)
      ok = false
    }
    if (!ok) break
    sent++
    try {
      renameSync(join(dir, it.name), join(ensureSub(guard, 'sent'), it.name))
    } catch (e) {
      console.error(`[guard] the delivered page ${it.name} could not be moved to sent/ (${codeOf(e)})`)
    }
  }
  return { sent, left: items.length - sent }
}

/** Moves the latch into `cleared/` and logs it. The terminal check and the typed confirmation live in the CLI. */
export function clearHalt(guard: string, o: { by: string; now?: () => Date }): { cleared: boolean; latch: Latch | null; archivedTo: string | null } {
  const latchPath = join(guard, LATCH_FILE)
  if (!existsSync(latchPath)) return { cleared: false, latch: null, archivedTo: null }
  const latch = readLatch(latchPath)
  const nowDate = (o.now ?? (() => new Date()))()
  const dir = ensureSub(guard, 'cleared')
  let target = join(dir, `HALT-${stampOf(nowDate)}.json`)
  for (let i = 1; existsSync(target); i++) target = join(dir, `HALT-${stampOf(nowDate)}-${i}.json`)
  renameSync(latchPath, target)
  try {
    appendFileSync(join(guard, 'halt-log.jsonl'), JSON.stringify({ cleared: true, at: nowDate.toISOString(), by: o.by }) + '\n')
  } catch (e) {
    console.error(`[guard] the latch log could not be written (${codeOf(e)})`)
  }
  return { cleared: true, latch, archivedTo: target }
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
  now: () => number
  last: number | null
  lost: boolean
  timer: ReturnType<typeof setInterval> | null
}

let wire: Tripwire | null = null

const tripwireHalt = (ctx: RunContainment) =>
  haltRefusal(ctx.folders.guard, ctx.home, { sandboxRoot: dirname(ctx.sandbox.root), missionCwd: ctx.missionCwd })

/**
 * Keeps the baseline's PRESENCE section (mapped network drives left out) and re-checks it on a
 * timer and before tool calls. One tripwire per process; starting again replaces the old one.
 */
export function startPresenceTripwire(a: {
  ctx: RunContainment
  onLoss: (loss: { kind: 'presence' | 'latch'; summary: string; publicSummary: string; compare: Compare | null }) => void
  intervalMs?: number; minGapMs?: number; now?: () => number; timer?: boolean
}): { ok: true; stop: () => void; folders: number; roots: number } | { ok: false; reason: string } {
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
  if (!m || !m.roots || !Array.isArray(m.roots.presence) || !Array.isArray(m.presence)) {
    return { ok: false, reason: `the integrity baseline of run ${a.ctx.runId} cannot be read (not a baseline)` }
  }
  const roots = m.roots.presence.filter(r => !r.network)
  const kept = new Set(roots.map(r => keyOf(r.path)))
  const before = m.presence.filter(p => kept.has(keyOf(p.root)))
  const folders = before.reduce((n, p) => n + Object.values(p.entries).filter(e => e.k === 'd').length, 0)
  const w: Tripwire = {
    ctx: a.ctx, onLoss: a.onLoss, roots, before, exclude: Array.isArray(m.exclude) ? m.exclude : [],
    minGapMs: a.minGapMs ?? 10_000, now: a.now ?? Date.now, last: null, lost: false, timer: null,
  }
  wire = w
  if (a.timer !== false) {
    w.timer = setInterval(() => { presenceTripwireCheck() }, a.intervalMs ?? 60_000)
    w.timer.unref?.()
  }
  return { ok: true, stop: () => { if (wire === w) stopPresenceTripwire() }, folders, roots: roots.length }
}

/**
 * Null while nothing was lost (or it is not time to look again); `INTEGRITY_LOSS_TO_MODEL` once a
 * loss was seen, for the rest of the process. Folders only: a file replaced by delete-then-rename
 * is absent for an instant, and this check has no confirmation wait.
 */
export function presenceTripwireCheck(now?: number): string | null {
  const w = wire
  if (w === null) return null
  if (w.lost) return INTEGRITY_LOSS_TO_MODEL
  const t = now ?? w.now()
  if (w.last !== null && t - w.last < w.minGapMs) return null
  w.last = t
  let loss: Loss | null = null
  try {
    const refusal = tripwireHalt(w.ctx)
    if (refusal !== null) {
      loss = { kind: 'latch', summary: refusal, publicSummary: 'the integrity latch is present, or the guard folder can no longer be used', compare: null }
    } else {
      const t0 = Date.now()
      const notes: string[] = []
      const after = w.roots.map(r => {
        try {
          return listPresence(r, w.exclude, notes)
        } catch (e) {
          // A root that can no longer be listed is a root that is gone (P1).
          notes.push(textOf(e))
          return { root: r.path, exists: false, listed: true, entries: {} } as PresenceSection
        }
      })
      const changes = diffPresence(w.before, after, w.roots, notes, true)
      if (changes.length > 0) {
        const d = finish(changes, notes)
        const compare = compareFrom(w.ctx.runId, 'tripwire', new Date().toISOString(), 'reading', d,
          after.reduce((n, p) => n + Object.keys(p.entries).length, 0), Date.now() - t0, false)
        loss = { kind: 'presence', summary: d.summary, publicSummary: d.publicSummary, compare }
      }
    }
  } catch (e) {
    const s = `the presence check could not be completed (${textOf(e)})`
    loss = { kind: 'presence', summary: s, publicSummary: s, compare: null }
  }
  if (loss === null) return null
  w.lost = true
  try {
    w.onLoss(loss)
  } catch (e) {
    console.log(`[integrity] onLoss failed: ${textOf(e)}`)
  }
  return INTEGRITY_LOSS_TO_MODEL
}

/** Clears the timer and the state (tests' `afterEach`). */
export function stopPresenceTripwire(): void {
  if (wire?.timer) clearInterval(wire.timer)
  wire = null
}
