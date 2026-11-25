/**
 * The suite's own temp folder: one folder per run, removed after a run in which no test failed.
 *
 * NOW.md (2026-11-24): the user temp folder held 294,021 entries, 112,212 of them `cynco-test-home-*` (one
 * per worker of every run, setup/cyncoHome.ts) and the rest the `mkdtemp` folders of test files that do not
 * remove what they make. This global setup runs once, in vitest's own process, before any worker starts:
 * it makes `<temp>\cynco-suite-runs\cv-<6 hex>` and points TEMP, TMP and TMPDIR at it, so every worker
 * (each is started with this process's environment) and every child a test starts makes its temp folders
 * there. cyncoHome.ts's home lands in it the same way.
 *
 * At the end of a run in which no test failed, nothing errored outside a test and the run was not
 * cancelled, the run folder is removed, and only by the listing-based walk below, which never enters a link.
 * lstat reads a junction made by a low-integrity process as a folder (decision record
 * docs/decisions/2026-11-23-mission-containment.md, F4; engine/realPath.ts `listEntries`), so a walk that
 * asks lstat would enter it and delete what it points at. fs.rmSync(recursive) did not enter one on Bun
 * 1.3.13 and Node 24 (F5 of the same record, re-measured in wave 15b and 15c), but that is the runtime's
 * choice, so this walk asks the listing and never calls a recursive remove. A failed or interrupted run
 * keeps its folder, as the evidence, and prints its path. A run killed outright keeps it too, unprinted.
 *
 * Outside its own `cynco-suite-runs` folder nothing in the temp folder is touched (the owner declined a sweep
 * of the old temp entries); inside it, only this run's folder at the end, by the path it was made at, and,
 * before the run, its own `cv-<6 hex>` folders older than KEEP_DAYS (below; check G19-3, wave 19b).
 * The parent `cynco-suite-runs` is never removed, so kept runs are found in one place.
 *
 * Kept runs are not kept for ever (wave 19: 140 were kept on 2026-11-24 and nothing pruned them): before the
 * run, the setup removes the suite's OWN kept run folders older than KEEP_DAYS, that is the `cv-<6 hex>`
 * folders of its own `cynco-suite-runs` folder and nothing else, by the same walk, and says how many. A folder
 * it cannot remove is named and left. A folder's age is taken from the later of its creation and its last
 * write, so a folder is pruned only when both are older than KEEP_DAYS.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isLinkEntry, listEntries, whyNotAtOwnPath } from '../../realPath.js'

/** The parent of every run folder, directly in the temp folder the suite was started with. */
export const RUNS_PARENT = 'cynco-suite-runs'
/** `cv-` and six hex characters: mkdtemp's suffix is six characters of [A-Za-z0-9], so the name is made here. */
export const RUN_NAME = /^cv-[0-9a-f]{6}$/
/** How long a kept run folder (a failed or interrupted run's) is kept before a later run removes it. */
export const KEEP_DAYS = 7

/** What the run's state says about its folder: `passed` removes it, anything else keeps it. */
export type RunOutcome = 'passed' | 'failed' | 'interrupted' | 'unknown'

/**
 * Read once the run has ended. `modules` are the run's test modules (each with `ok()`), `unhandled` the
 * errors raised outside a test. A run with no module, or whose state cannot be read, is `unknown` (kept).
 */
export function runOutcome(a: { cancelling: boolean; modules: Array<{ ok(): boolean }> | null; unhandled: unknown[] | null }): RunOutcome {
  if (a.cancelling) return 'interrupted'
  if (a.modules === null || a.unhandled === null || a.modules.length === 0) return 'unknown'
  if (a.unhandled.length > 0) return 'failed'
  return a.modules.every(m => m.ok()) ? 'passed' : 'failed'
}

/** Make `<parent>\cv-<6 hex>`; the parent is made when it is missing. Returns the run folder's real path. */
export function makeRunFolder(tempRoot: string, rand: () => string = () => randomBytes(3).toString('hex')): string {
  const parent = join(realpathSync.native(tempRoot), RUNS_PARENT)
  mkdirSync(parent, { recursive: true })
  if (isLinkEntry(parent) !== false) throw new Error(`${parent} is a link or cannot be read as a folder; the suite makes no run folder in it`)
  for (let i = 0; i < 20; i++) {
    const p = join(parent, `cv-${rand()}`)
    try {
      mkdirSync(p)
      return realpathSync.native(p)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  // Twenty taken names in a row: fall back to mkdtemp under the same parent. Its six-character suffix is
  // usually not hex, so such a folder is usually kept at the end; when the suffix happens to be lowercase hex
  // the name is RUN_NAME and the folder, still this run's own, is removed like any other.
  return realpathSync.native(mkdtempSync(join(parent, 'cv-')))
}

/**
 * Remove the run folder `dir` (a direct child of `parent` named like RUN_NAME) and everything in it, never
 * following a link. The only deleting calls are `unlinkSync` on what a listing calls a file (a read-only
 * file is made writable first), `rmdirSync` on a folder this walk emptied, and `rmdirSync` / `unlinkSync`
 * on what a listing calls a link (removed as an entry, never entered). A folder is entered only when its
 * native real path is its parent's real path joined with its name (engine/realPath.ts `whyNotAtOwnPath`).
 * Returns what could not be removed; an empty list means the folder is gone.
 *
 * `list` is engine/realPath.ts `listEntries`; a test hands in a listing that calls a junction a folder, so
 * that the own-path check (the walk's second line, after the listing) is exercised (B5-3). It answers the
 * walk's first look too, whether `dir` itself is a link by its parent's listing (C5-1, wave 19).
 *
 * A folder entered at its own path is given its owner's permissions back first when it lacks them (C5-2, wave
 * 19): on POSIX a folder without write permission refuses the removal of what is in it. On Windows, Node 24
 * and Bun 1.3.13 remove a folder with the read-only attribute and the files in it as they are (measured
 * 2026-11-25), so there it changes nothing rmdir would not. The same rule is in calibration's `removeNoFollow`
 * (scripts/cynco-campaign-calibrate.mjs); scripts/__tests__/cynco-no-follow-walks.test.mjs runs one table of
 * cases against both.
 */
export function removeRunFolder(dir: string, parent: string, list: typeof listEntries = listEntries): string[] {
  const failed: string[] = []
  const parentReal = realpathSync.native(parent)
  if (!RUN_NAME.test(basename(dir))) return [`${dir}: not a run folder name (cv- and six hex characters); nothing was removed`]
  if (dirname(dir).toLowerCase() !== parentReal.toLowerCase() && dirname(dir) !== parentReal) return [`${dir}: not directly in ${parentReal}; nothing was removed`]
  const link = linkByListing(dir, list)
  if (link !== false) return [`${dir}: ${link === null ? 'not in its parent\'s listing' : 'is a link'}; nothing was removed`]
  const walk = (d: string, dReal: string): void => {
    try { ownerMayRemoveIn(d) } catch (e) { failed.push(`${d}: could not be given its owner's permissions (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); not entered`); return }
    let entries: ReturnType<typeof listEntries>
    try { entries = list(d) } catch (e) { failed.push(`${d}: could not be listed (${(e as Error).message})`); return }
    for (const e of entries) {
      const p = join(d, e.name)
      try {
        if (e.kind === 'link') {
          try { rmdirSync(p) } catch { unlinkSync(p) }
        } else if (e.kind === 'dir') {
          const why = whyNotAtOwnPath(dReal, e.name)
          if (why) { failed.push(`${p}: ${why}; not entered`); continue }
          walk(p, join(dReal, e.name))
          rmdirSync(p)
        } else {
          try { unlinkSync(p) } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err
            // A read-only file (git writes its objects read-only): made writable, then removed. Never a link:
            // the listing called it a file.
            chmodSync(p, 0o666)
            unlinkSync(p)
          }
        }
      } catch (err) {
        failed.push(`${p}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
      }
    }
  }
  const why = whyNotAtOwnPath(parentReal, basename(dir))
  if (why) return [`${dir}: ${why}; nothing was removed`]
  const st = lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) return [`${dir}: no longer a folder; nothing was removed`]
  walk(dir, join(parentReal, basename(dir)))
  if (failed.length === 0) {
    try { rmdirSync(dir) } catch (e) { failed.push(`${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`) }
  }
  return failed
}

/**
 * Is the entry `p` a link, by what `list` says of its parent (engine/realPath.ts `isLinkEntry`, with the listing
 * handed in)? `null` when that cannot be told: the parent cannot be listed, or lists no such name.
 */
function linkByListing(p: string, list: typeof listEntries): boolean | null {
  const full = resolve(p)
  const parent = dirname(full)
  if (parent === full) return false
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  let entries: ReturnType<typeof listEntries>
  try {
    entries = list(parent)
  } catch (e) {
    void e
    return null
  }
  const hit = entries.find(e => fold(e.name) === fold(basename(full)))
  return hit === undefined ? null : hit.kind === 'link'
}

/**
 * C5-2: a folder the walk entered at its own path (never a link: the caller checked it) gets its owner's
 * permissions back when it lacks them, so that what is in it and then the folder itself can be removed. On
 * Windows only the write bit means anything (the read-only attribute; a folder reads as 0o666 or 0o444).
 */
function ownerMayRemoveIn(d: string): void {
  const mode = statSync(d).mode
  const need = process.platform === 'win32' ? 0o200 : 0o700
  if ((mode & need) !== need) chmodSync(d, (mode & 0o7777) | 0o700)
}

/**
 * Remove the suite's own kept run folders older than KEEP_DAYS from `parent` (its `cynco-suite-runs` folder):
 * every entry its listing calls a folder, named like RUN_NAME, at its own path, other than `current` (this
 * run's), whose creation and last write are both older than KEEP_DAYS at `now`. Each is removed only by
 * `removeRunFolder`. Anything else in `parent` (a link, a file, another name) is not looked at. Returns how
 * many were removed and, for each one it could not remove, its path with the first thing it left. A folder
 * another run removed meanwhile is neither. Never throws.
 */
export function pruneKeptRunFolders(parent: string, current: string, now: number, list: typeof listEntries = listEntries): { removed: number; left: string[] } {
  const left: string[] = []
  let removed = 0
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  let parentReal: string
  let entries: ReturnType<typeof listEntries>
  try {
    parentReal = realpathSync.native(parent)
    entries = list(parentReal)
  } catch (e) {
    return { removed: 0, left: [`${parent}: could not be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was removed`] }
  }
  const limit = KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const e of entries) {
    if (e.kind !== 'dir' || !RUN_NAME.test(e.name) || fold(e.name) === fold(basename(current))) continue
    const p = join(parentReal, e.name)
    try {
      if (whyNotAtOwnPath(parentReal, e.name) !== null) continue
      const st = statSync(p)
      if (now - Math.max(st.birthtimeMs, st.mtimeMs) <= limit) continue
    } catch (err) {
      // Gone since the listing (another run pruned it), or not readable: not this run's to judge.
      void err
      continue
    }
    let failed: string[]
    try { failed = removeRunFolder(p, parentReal, list) } catch (err) { failed = [`${p}: ${(err as Error).message}`] }
    if (failed.length === 0) { removed++; continue }
    // Another run removed it while this one walked it: only lstat's ENOENT says so. A listing that no longer
    // shows the name, or that throws, is not proof, and a folder still there is named (check G19-6, wave 19b).
    if (goneFromDisk(p)) continue
    left.push(`${p} (${failed[0]})`)
  }
  return { removed, left }
}

/** True only when lstat says `p` no longer exists (ENOENT); any other answer, or none, is false. */
function goneFromDisk(p: string): boolean {
  try {
    lstatSync(p)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

interface ProjectLike {
  vitest: {
    isCancelling?: boolean
    state?: { getTestModules?: () => Array<{ ok(): boolean }>; getUnhandledErrors?: () => unknown[] }
  }
}

/**
 * vitest's global setup: make the run folder, prune the kept ones older than KEEP_DAYS, and redirect the temp
 * variables; the teardown decides the run folder's end. vitest hands only `project`; `opts.now` is a test seam.
 */
export default function setup(project: ProjectLike, opts: { now?: () => number } = {}): () => void {
  // Each of the three is put back as it was, and one that was unset is left unset (P5-C8).
  const before = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const dir = makeRunFolder(tmpdir())
  const parent = dirname(dir)
  const pruned = pruneKeptRunFolders(parent, dir, (opts.now ?? Date.now)())
  if (pruned.removed > 0) {
    console.error(`[suite] removed ${pruned.removed} kept run folder${pruned.removed === 1 ? '' : 's'} older than ${KEEP_DAYS} days from ${parent}`)
  }
  for (const l of pruned.left) console.error(`[suite] a kept run folder older than ${KEEP_DAYS} days could not be removed and is left: ${l}`)
  process.env.TEMP = dir
  process.env.TMP = dir
  process.env.TMPDIR = dir
  return () => {
    let outcome: RunOutcome = 'unknown'
    try {
      const v = project.vitest
      outcome = runOutcome({
        cancelling: v.isCancelling === true,
        modules: v.state?.getTestModules ? v.state.getTestModules() : null,
        unhandled: v.state?.getUnhandledErrors ? v.state.getUnhandledErrors() : null,
      })
    } catch (e) {
      console.error(`[suite] the run's outcome could not be read (${(e as Error).message}); its temp folder is kept`)
    }
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (outcome !== 'passed') {
      console.error(`[suite] ${outcome === 'unknown' ? 'the run\'s outcome is not known' : `the run ${outcome}`}: its temp folder is kept: ${dir}`)
      return
    }
    let failed: string[]
    try { failed = removeRunFolder(dir, parent) } catch (e) { failed = [`${dir}: ${(e as Error).message}`] }
    if (failed.length > 0) {
      console.error(`[suite] the run passed; its temp folder is kept, ${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} could not be removed (first: ${failed[0]}): ${dir}`)
    }
  }
}
