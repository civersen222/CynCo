/**
 * scripts/cynco-logs.mjs: the mission-log prune (F242, slice S8).
 *
 *   bun scripts/cynco-logs.mjs prune-mission-logs [--dir <absolute folder>] [--keep <path>]... [--dry-run]
 *
 * scripts/dispatch-mission.sh and the campaign runner leave engine_<stamp>.log, driver_<stamp>.log,
 * driver_<stamp>.pid and engine_idle_after_<stamp>.log in C:/tmp, the default folder. This deletes
 * the ones older than MISSION_LOG_KEEP_DAYS (90), never a name passed with --keep (a dispatch keeps
 * its own two logs). One retention, in one constant: there is no --days.
 *
 * WHAT IT CAN TOUCH, and nothing else: regular files directly in the one folder (never recursive,
 * never a folder, never a symbolic link or a junction, through pruneOldFiles in engine/logCap.ts)
 * whose name MISSION_LOG_RE matches (engine_*.log, driver_*.log, engine_*.pid, driver_*.pid) and
 * whose modification time is more than 90 days old. It refuses, deleting nothing, a folder that is
 * empty, relative, not below a drive letter (on Windows; a share is refused too), a volume root,
 * the home folder or a folder that contains it, or itself a link or a junction. It starts no process.
 *
 * Kept as well (review of wave 5): every log whose name, or whose stamp (the name without its
 * engine_ / driver_ / engine_idle_after_ prefix and its extension), is a word of
 * docs/cynco-failure-log.md, since those logs are the evidence behind its entries; when that file
 * cannot be read, nothing is deleted. Nothing is deleted when the newest file directly in the folder
 * is itself older than 90 days (a clock that runs ahead, or a folder nobody writes to); at most 200
 * are deleted in one run. `--dry-run` prints each name it would delete and deletes nothing.
 *
 * Prints `[logs] pruned <n> mission log(s) older than 90 days from <dir>` (with `--dry-run`:
 * `[logs] would prune <n> ...` and one `[logs] would delete: <name>` each) and one
 * `[logs] not pruned: <name>: <error>` per failure. Exit 0 always (a dispatch never fails on its old
 * logs), except 2 for an unknown verb, a refused --dir, or --keep without a value.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MISSION_LOG_KEEP_DAYS, MISSION_LOG_RE, pruneOldFiles } from '../engine/logCap.js'

export const DEFAULT_MISSION_LOG_DIR = 'C:/tmp'
/** The failure log whose cited logs are never pruned. */
export const FAILURE_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'cynco-failure-log.md')
/** At most this many mission logs go in one run. */
export const MAX_PRUNED_PER_RUN = 200
const DAY_MS = 24 * 60 * 60 * 1000
const EXIT_OK = 0
const EXIT_USAGE = 2
const USAGE = 'usage: bun scripts/cynco-logs.mjs prune-mission-logs [--dir <absolute folder>] [--keep <path>]... [--dry-run]'

const errText = (e) => (e instanceof Error ? (e.code ? `${e.code}: ${e.message}` : e.message) : String(e))
const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)

/** The real path of an existing path, else the resolved path, compared without case on Windows. */
function canon(p) {
  let r = resolve(p)
  try {
    r = realpathSync.native(r)
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e
  }
  return fold(r.replace(/[\\/]+$/, '') || r)
}

/** True when `a` is `b` or a folder above it. Both are canon() paths. */
function isOrContains(a, b) {
  if (a === b) return true
  let cur = b
  for (;;) {
    const up = fold(dirname(cur))
    if (up === cur) return false
    if (up === a || up.replace(/[\\/]+$/, '') === a) return true
    cur = up
  }
}

/**
 * Why `dir` may not be pruned, or null. `homes` are the home folders to keep out of reach (default:
 * the account's home and USERPROFILE / HOME when set).
 */
export function folderRefusal(dir, homes) {
  if (typeof dir !== 'string' || dir.trim() === '') return 'no folder was named'
  if (!isAbsolute(dir) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(dir))) {
    return 'the folder is not an absolute path below a drive letter'
  }
  if (dirname(resolve(dir)) === resolve(dir)) return 'the folder is a volume root'
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink()) return 'the folder is a link or a junction'
    if (!st.isDirectory()) return 'the path is not a folder'
  } catch (e) {
    if (e?.code !== 'ENOENT') return `the folder could not be examined (${errText(e)})`
  }
  let target
  try {
    target = canon(dir)
  } catch (e) {
    return `the folder could not be resolved (${errText(e)})`
  }
  const list = homes ?? [homedir(), process.env.USERPROFILE, process.env.HOME]
  for (const h of list) {
    if (typeof h !== 'string' || h.trim() === '') continue
    let home
    try {
      home = canon(h)
    } catch (e) {
      return `the home folder ${h} could not be resolved (${errText(e)})`
    }
    if (isOrContains(target, home)) return 'the folder is the home folder or contains it'
  }
  return null
}

/**
 * Deletes the mission logs older than 90 days directly in `dir`, except the bare names of `keep`.
 * A refused folder deletes nothing and is the one `failed` entry, with `refused: true`.
 */
export function pruneMissionLogs({ dir = DEFAULT_MISSION_LOG_DIR, keep = [], now, homes, keepIf, dryRun = false } = {}) {
  const refusal = folderRefusal(dir, homes)
  if (refusal !== null) {
    return { dir, deleted: [], failed: [{ name: String(dir), error: `${refusal}; nothing was deleted` }], refused: true, left: 0 }
  }
  // A clock far ahead makes every log look old; a folder written by every dispatch never has only old files.
  const t = now ?? Date.now()
  const newest = newestFileTime(dir)
  if (newest !== null && newest < t - MISSION_LOG_KEEP_DAYS * DAY_MS) {
    return { dir, deleted: [], failed: [{ name: String(dir), error: `the newest file in it is more than ${MISSION_LOG_KEEP_DAYS} days older than now (the clock may be wrong, or nothing writes here); nothing was deleted` }], refused: false, left: 0 }
  }
  const names = keep.map(k => basename(String(k).replace(/\\/g, '/')))
  const r = pruneOldFiles(dir, MISSION_LOG_RE, MISSION_LOG_KEEP_DAYS, {
    keep: names, maxDeletes: MAX_PRUNED_PER_RUN, dryRun, ...(keepIf ? { keepIf } : {}), ...(now === undefined ? {} : { now }),
  })
  return { dir, deleted: r.deleted, failed: r.failed, refused: false, left: r.left }
}

/** The newest modification time of a regular file directly in `dir`, or null (none, or not listable). */
function newestFileTime(dir) {
  let names
  try { names = readdirSync(dir) } catch { return null }
  let newest = null
  for (const n of names) {
    try {
      const st = lstatSync(resolve(dir, n))
      if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs
    } catch (e) {
      if (e?.code !== 'ENOENT') console.error(`[logs] ${n}: ${errText(e)}`)
    }
  }
  return newest
}

/** The words of the failure log's text, lower-cased, for `citedKeep`. */
export function citedWords(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9_-]+/).filter(w => w.length >= 3))
}

/** True when a mission log's name (without extension) or its stamp is a word of the failure log. */
export function citedKeep(words) {
  return (name) => {
    const base = name.replace(/\.(log|pid)$/i, '').toLowerCase()
    const stem = base.replace(/^(engine_idle_after_|engine_|driver_)/, '')
    return words.has(base) || words.has(stem)
  }
}

/** Parses the command line; `{ error }` for a usage fault. */
export function parseArgs(argv) {
  const [verb, ...rest] = argv
  if (verb !== 'prune-mission-logs') return { error: verb === undefined ? 'no verb' : `unknown verb "${verb}"` }
  let dir = DEFAULT_MISSION_LOG_DIR
  const keep = []
  let dryRun = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const v = rest[i + 1]
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--dir' || a === '--keep') {
      if (v === undefined || v === '' || v.startsWith('--')) return { error: `${a} needs a value` }
      if (a === '--dir') dir = v
      else keep.push(v)
      i++
    } else {
      return { error: `unknown argument "${a}"` }
    }
  }
  return { dir, keep, dryRun }
}

/** The command line; `io` is injected by the test. Returns the exit code. */
export function main(argv, io = {}) {
  const out = io.out ?? ((l) => console.log(l))
  const err = io.err ?? ((l) => console.error(l))
  const args = parseArgs(argv)
  if (args.error) {
    err(`[logs] ${args.error}`)
    err(USAGE)
    return EXIT_USAGE
  }
  // The failure log's words: `io.cited` (its text) is the test seam.
  let cited = io.cited
  if (cited === undefined) {
    try {
      cited = readFileSync(FAILURE_LOG, 'utf8')
    } catch (e) {
      err(`[logs] not pruned: ${args.dir}: the failure log ${FAILURE_LOG} could not be read (${errText(e)}), so the logs it cites cannot be kept; nothing was deleted`)
      return EXIT_OK
    }
  }
  const r = pruneMissionLogs({ dir: args.dir, keep: args.keep, now: io.now, homes: io.homes, keepIf: citedKeep(citedWords(cited)), dryRun: args.dryRun })
  if (r.refused) {
    err(`[logs] not pruned: ${r.failed[0].name}: ${r.failed[0].error}`)
    return EXIT_USAGE
  }
  if (args.dryRun) {
    out(`[logs] would prune ${r.deleted.length} mission log(s) older than ${MISSION_LOG_KEEP_DAYS} days from ${r.dir}; nothing was deleted`)
    for (const n of r.deleted) out(`[logs] would delete: ${n}`)
  } else {
    out(`[logs] pruned ${r.deleted.length} mission log(s) older than ${MISSION_LOG_KEEP_DAYS} days from ${r.dir}`)
  }
  if (r.left > 0) out(`[logs] ${r.left} more ${args.dryRun ? 'would go' : 'go'} on a later run (at most ${MAX_PRUNED_PER_RUN} a run)`)
  for (const f of r.failed) err(`[logs] not pruned: ${f.name}: ${f.error}`)
  return EXIT_OK
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  process.exitCode = main(process.argv.slice(2))
}
