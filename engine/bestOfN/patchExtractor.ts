import { execSync } from 'child_process'

const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB

/**
 * Captures a unified diff of all changes (tracked modifications + untracked
 * new files) in the given working directory.
 *
 * The sequence is:
 *  1. `git add -A`           — stage everything, including untracked files
 *  2. `git diff --cached HEAD` — produce the staged diff vs HEAD
 *  3. `git reset HEAD`       — unstage so the worktree is left as-is
 *
 * Returns the trimmed diff string, or an empty string if there are no changes
 * or if any git command fails.
 */
export function extractPatch(cwd: string): string {
  const run = (cmd: string): string =>
    execSync(cmd, { cwd, stdio: 'pipe', maxBuffer: MAX_BUFFER })
      .toString()
      .trim()

  try {
    run('git add -A')
    const diff = run('git diff --cached HEAD')
    run('git reset HEAD')
    return diff
  } catch {
    // Any git failure (not a repo, no commits, etc.) → return empty
    return ''
  }
}
