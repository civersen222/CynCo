/**
 * cynco-work-snapshot.mjs — keep what the loop was holding when it stopped.
 *
 * Eight consecutive CivKings missions ended with an uncommitted tree. 11N held
 * the correct `tick_loyalty` mechanism, unsaved, when the iteration cap closed
 * on it; 11M held two measured-at-zero lines. In every case the next run had to
 * be told about the work in prose, by hand, because nothing had kept it.
 *
 * This writes a patch OUTSIDE the workspace. It deliberately does not commit:
 * the driver grades "any commit past the baseline" as delivery, so a harness
 * commit would forge the very number the ledger exists to measure. It also
 * cannot use `git stash` — the mission rules ban stash for good reason, and a
 * stash would remove the work from the tree the grader is about to measure.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Write a patch of the workspace's uncommitted tracked changes to `outDir`.
 * Returns what was found, and never throws: this runs on the exit path of a
 * six-hour mission and must not be the reason a record goes unwritten. Every
 * failure comes back as `error` on the result so the caller can print it —
 * a swallowed failure here looks exactly like a clean tree, which is the one
 * answer this function must never give wrongly.
 */
export function snapshotUncommittedWork(cwd, outDir, missionId) {
  const result = { written: false, patchPath: '', untracked: [], error: null }
  try {
    const diff = spawnSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8' })
    result.untracked = (untracked.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean)

    const patch = diff.stdout ?? ''
    result.patchPath = join(outDir, `${missionId}.uncommitted.patch`)
    if (patch.trim() === '') {
      // `git diff` failing (not a repo, git missing) also yields empty stdout.
      // Say which of the two it was, so "nothing to save" is never a guess.
      if (diff.error || (diff.status ?? 0) !== 0) {
        result.error = String(diff.error ?? (diff.stderr ?? '').trim() ?? 'git diff failed')
      }
      return result
    }

    // outDir is somewhere outside the workspace by contract, so it is not
    // guaranteed to exist. Creating it here keeps a missing directory from
    // costing the mission its only copy of the work.
    mkdirSync(outDir, { recursive: true })
    writeFileSync(result.patchPath, patch, 'utf-8')
    result.written = true
    return result
  } catch (err) {
    result.error = String(err)
    return result
  }
}
