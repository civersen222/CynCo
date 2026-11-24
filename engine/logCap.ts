/**
 * engine/logCap.ts: the bounds on what CynCo leaves on disk (F242).
 *
 * `pruneOldFiles` is the one function of the containment work that deletes files, and its rules
 * are its safety: an absolute folder only, entries directly in it only (never recursive), regular
 * files only (a directory, a symbolic link or a junction is never touched and never entered), a
 * name the caller's pattern matches, older than the caller's age, never a name the caller keeps.
 * Its first caller is the 90-day retention of the tool-call audit's day files
 * (engine/audit/toolAudit.ts); the daemon's mission-log prune is the second.
 *
 * `appendCapped` keeps a debug log that is appended to in process under a size, by restarting the
 * file in place (never a rotated sibling). `oversizedLogs` lists the service logs that grew past a
 * size between starts, so the daemon can page about them. Node built-ins only.
 */
import { appendFileSync, lstatSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

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
 * Refuses, deleting nothing, when `dir` is not absolute, when `maxAgeDays` is not a finite number of
 * at least 1, or when the folder cannot be listed: the refusal is the one `failed` entry, named
 * after the folder. Never recursive; never follows or removes a link or a junction (lstat, isFile).
 * An entry that cannot be examined or removed is reported in `failed` and the rest go on. Never
 * throws.
 */
export function pruneOldFiles(
  dir: string, nameRe: RegExp, maxAgeDays: number,
  opts: { now?: number; keep?: string[] } = {},
): { deleted: string[]; failed: Array<{ name: string; error: string }> } {
  const deleted: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
    failed.push({ name: String(dir), error: 'the folder is not an absolute path; nothing was deleted' })
    return { deleted, failed }
  }
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    failed.push({ name: dir, error: `the age limit ${String(maxAgeDays)} is not a finite number of at least 1 day; nothing was deleted` })
    return { deleted, failed }
  }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    failed.push({ name: dir, error: `the folder could not be listed (${errText(e)}); nothing was deleted` })
    return { deleted, failed }
  }
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const keep = new Set((opts.keep ?? []).map(fold))
  const cutoff = (opts.now ?? Date.now()) - maxAgeDays * DAY_MS
  for (const name of names) {
    // A fresh RegExp state per name: a caller's /g or /y pattern would otherwise carry lastIndex over.
    nameRe.lastIndex = 0
    if (!nameRe.test(name)) continue
    if (keep.has(fold(name))) continue
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      if (!st.isFile()) continue
      if (!(st.mtimeMs < cutoff)) continue
    } catch (e) {
      failed.push({ name, error: errText(e) })
      continue
    }
    try {
      unlinkSync(path)
      deleted.push(name)
    } catch (e) {
      failed.push({ name, error: errText(e) })
    }
  }
  return { deleted, failed }
}

/**
 * Append `text` to `path`; when the append would take the file past `maxBytes`, restart the file
 * in place with one header line instead. A missing file counts as empty and is created. It never
 * creates a sibling file, so no repository's `.gitignore` is involved. Throws what `fs` throws.
 */
export function appendCapped(path: string, text: string, maxBytes: number): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    size = 0
  }
  if (size + Buffer.byteLength(text) > maxBytes) {
    const header = `--- log restarted ${new Date().toISOString()}: it passed ${maxBytes} bytes ---\n`
    writeFileSync(path, header + text)
  } else {
    appendFileSync(path, text)
  }
}

/**
 * The regular files directly in `dir` whose name ends `.log` and whose size is over `minBytes`.
 * Read-only. A folder or an entry that cannot be read is skipped with one `[log-cap]` line; it never
 * throws.
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
    if (!name.toLowerCase().endsWith('.log')) continue
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
