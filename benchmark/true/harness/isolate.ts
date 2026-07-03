import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/**
 * Remove an isolated workdir, tolerating Windows' transient file locks.
 *
 * Right after pytest/git run against the clone, Windows can still hold a handle
 * for a moment (AV scan, the just-exited python process, .pyc handles), so a
 * plain rmSync throws EBUSY/EPERM. Node retries those exact errors with linear
 * backoff when given maxRetries/retryDelay. The score is already captured before
 * cleanup, so a leftover temp dir must never abort the suite — if it still can't
 * be removed, warn and continue; the OS will reap the temp dir later.
 */
export function removeWorkdir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (err) {
    console.warn(`[true-bench] could not remove workdir ${dir} (leaving for OS cleanup): ${err instanceof Error ? err.message : err}`)
  }
}

/** Clone `srcRepo` into `destDir` (must be empty/new) with a real working tree. */
export function cloneRepo(srcRepo: string, destDir: string): void {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', srcRepo, destDir], { stdio: 'pipe' })
}

/** Detach-checkout the given ref inside an existing clone. */
export function checkoutRef(dir: string, ref: string): void {
  git(dir, ['checkout', '--quiet', ref])
}

/** Apply a patch file to the working tree of an existing clone. */
export function applyPatch(dir: string, patchFile: string): void {
  git(dir, ['apply', patchFile])
}
