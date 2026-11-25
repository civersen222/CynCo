/**
 * engine/logCap.ts: the bounds on what CynCo leaves on disk (F242).
 *
 * `pruneOldFiles` is the one function of the containment work's code that deletes files by age, and
 * its rules are its safety: an absolute folder only, entries directly in it only (never recursive),
 * regular files only (a directory, a symbolic link or a junction is never touched and never entered),
 * a name the caller's pattern matches, older than the caller's age, never a name the caller keeps.
 * Its two callers: the 90-day retention of the tool-call audit's day files
 * (engine/audit/toolAudit.ts), and the mission-log prune of scripts/cynco-logs.mjs, which
 * scripts/dispatch-mission.sh runs before it stops the phone engine. The one other deletion of the
 * logs slice is scripts/rotate-log.cmd replacing the <log>.1 beside the four service logs in the
 * CynCo home when it rotates one.
 *
 * `appendCapped` keeps a debug log that is appended to in process under a size, by restarting the
 * file in place (never a rotated sibling). `oversizedLogs` lists the service logs (and the one
 * previous file the rotation keeps) that grew past a size, so the daemon can page about them. Node
 * built-ins only.
 */
import fs, { constants as fsConstants, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

/** The stream debug log (`.cynco-stream.log`) is restarted in place past this size. */
export const STREAM_LOG_MAX_BYTES = 16 * 1024 * 1024
/** A service log over this size pages the owner once a day. */
export const LOG_PAGE_BYTES = 1024 * 1024 * 1024
/** Mission logs (`C:/tmp/engine_*.log` and the like) are kept this many days. */
export const MISSION_LOG_KEEP_DAYS = 90
/** The names of a dispatch's mission logs and pid files. */
export const MISSION_LOG_RE = /^(engine|driver)_.+\.(log|pid)$/

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}

/**
 * Delete the regular files directly in `dir` whose bare name `nameRe` matches and whose
 * modification time is more than `maxAgeDays` days before `opts.now` (default now), except the
 * names in `opts.keep` (compared case-insensitively on Windows).
 *
 * With `opts.nameTime`, a file also goes only when the time its NAME carries (a date) is itself
 * older than the limit, so a clock that runs ahead does not delete a file named for today; a name
 * the function cannot date is kept.
 *
 * Refuses, deleting nothing, when `dir` is not absolute (on Windows: a drive letter or a share, never
 * a path rooted on whichever drive is current), when it is a volume root, when `maxAgeDays` is not a
 * finite number of at least 1, or when the folder cannot be listed: the refusal is the one `failed`
 * entry, named after the folder. Never recursive; never follows or removes a link or a junction
 * (lstat, isFile). An entry that cannot be examined or removed is reported in `failed` and the rest
 * go on. Never throws.
 */
export function pruneOldFiles(
  dir: string, nameRe: RegExp, maxAgeDays: number,
  opts: {
    now?: number; keep?: string[]; nameTime?: (name: string) => number | null
    /** A name this answers true for is kept, like a name in `keep`. */
    keepIf?: (name: string) => boolean
    /** Lists what would go in `deleted` and deletes nothing. */
    dryRun?: boolean
    /** At most this many are deleted in one call; the others that would go are counted in `left`. */
    maxDeletes?: number
  } = {},
): { deleted: string[]; failed: Array<{ name: string; error: string }>; left: number } {
  const deleted: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  let left = 0
  const anchored = typeof dir === 'string' && dir !== '' && isAbsolute(dir)
    && (process.platform !== 'win32' || /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(dir))
  if (!anchored) {
    failed.push({ name: String(dir), error: 'the folder is not an absolute path; nothing was deleted' })
    return { deleted, failed, left }
  }
  if (dirname(resolve(dir)) === resolve(dir)) {
    failed.push({ name: dir, error: 'the folder is a volume root; nothing was deleted' })
    return { deleted, failed, left }
  }
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    failed.push({ name: dir, error: `the age limit ${String(maxAgeDays)} is not a finite number of at least 1 day; nothing was deleted` })
    return { deleted, failed, left }
  }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    failed.push({ name: dir, error: `the folder could not be listed (${errText(e)}); nothing was deleted` })
    return { deleted, failed, left }
  }
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const keep = new Set((opts.keep ?? []).map(fold))
  const cutoff = (opts.now ?? Date.now()) - maxAgeDays * DAY_MS
  for (const name of names) {
    // A fresh RegExp state per name: a caller's /g or /y pattern would otherwise carry lastIndex over.
    nameRe.lastIndex = 0
    if (!nameRe.test(name)) continue
    if (keep.has(fold(name))) continue
    if (opts.keepIf?.(name) === true) continue
    if (opts.nameTime) {
      const t = opts.nameTime(name)
      if (t === null || !Number.isFinite(t) || !(t < cutoff)) continue
    }
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      if (!st.isFile()) continue
      if (!(st.mtimeMs < cutoff)) continue
    } catch (e) {
      failed.push({ name, error: errText(e) })
      continue
    }
    if (opts.maxDeletes !== undefined && deleted.length >= opts.maxDeletes) { left++; continue }
    if (opts.dryRun) { deleted.push(name); continue }
    try {
      unlinkSync(path)
      deleted.push(name)
    } catch (e) {
      failed.push({ name, error: errText(e) })
    }
  }
  return { deleted, failed, left }
}

/** What a look at an own file found: a regular file with no other name (its lstat), or nothing yet (null). */
function ownFileLook(path: string): Stats | null {
  let st
  try {
    st = fs.lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  if (!st.isFile()) throw new Error(`${path} is not a regular file (a link, a junction or a folder); it is not written`)
  if (st.nlink > 1) throw new Error(`${path} has ${st.nlink} names (a hard link); it is not written`)
  return st
}

/**
 * Open `path` for writing only as a file of its own, the rule for a file the engine writes in a
 * folder a run controls (the stream log and the per-iteration debug file in the mission folder):
 * a regular file with one name (lstat; never a symbolic link, a junction or a hard link, through
 * which a write or a truncation would reach whatever the name points at), opened without following
 * a final link where the system can (O_NOFOLLOW), and judged again on the open handle, which must be
 * the very file the look found (Windows has no O_NOFOLLOW). A name that was free at the look is
 * created exclusively (O_EXCL, check C4-7 of wave 15b): whatever was made under it in between fails
 * the open with EEXIST, as there is nothing to compare it with. The caller closes the descriptor.
 * Throws what `fs` throws, and an Error naming the path for a file it will not write. Goes through
 * the `fs` object, not named imports, so a test can stand between the look and the open.
 */
function openOwnFile(path: string): { fd: number; size: number } {
  const named = ownFileLook(path)
  const noFollow = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0
  // No O_APPEND: Windows refuses to truncate a handle opened for appending, so an append is a
  // positioned write at the size read from the same handle (one writer per file).
  const fd = fs.openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | (named === null ? fsConstants.O_EXCL : 0) | noFollow)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink > 1) throw new Error(`${path} is not a regular file with one name; it is not written`)
    if (named !== null && (st.dev !== named.dev || st.ino !== named.ino)) {
      throw new Error(`${path} changed between the look and the open; it is not written`)
    }
    return { fd, size: st.size }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

/**
 * Replace the whole content of `path` with `text`, as a file of its own (`openOwnFile`'s rule): the
 * loop's per-iteration `.cynco-debug.json`. Never creates a sibling file.
 */
export function writeOwnFile(path: string, text: string): void {
  const { fd } = openOwnFile(path)
  try {
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, text, 0)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Append `text` to `path`; when the append would take the file past `maxBytes`, restart the file
 * in place with one header line instead. A missing file counts as empty and is created. It never
 * creates a sibling file, so no repository's `.gitignore` is involved.
 *
 * The path may lie in a folder a run controls, so it is written only as a file of its own
 * (`openOwnFile`: restarting a file reached through a link would empty whatever the name points at).
 */
export function appendCapped(path: string, text: string, maxBytes: number): void {
  const { fd, size } = openOwnFile(path)
  try {
    if (size + Buffer.byteLength(text) > maxBytes) {
      // Restart in place on the handle already judged: truncate it, then write from its start.
      const header = `--- log restarted ${new Date().toISOString()}: it passed ${maxBytes} bytes ---\n`
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, header + text, 0)
    } else {
      fs.writeSync(fd, text, size)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The regular files directly in `dir` whose name ends `.log` (or `.log.1`, the one previous file the
 * rotation keeps, which nothing replaces until the log passes its cap again) and whose size is over
 * `minBytes`. Read-only. A folder or an entry that cannot be read is skipped with one `[log-cap]`
 * line; it never throws.
 */
export function oversizedLogs(dir: string, minBytes: number): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    console.error(`[log-cap] ${dir}: ${errText(e)}`)
    return out
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.log') && !name.toLowerCase().endsWith('.log.1')) continue
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      if (st.isFile() && st.size > minBytes) out.push({ path, bytes: st.size })
    } catch (e) {
      console.error(`[log-cap] ${path}: ${errText(e)}`)
    }
  }
  return out
}
