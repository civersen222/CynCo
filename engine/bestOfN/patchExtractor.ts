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
 * Returns the diff byte-for-byte (NOT trimmed: `git apply` needs the newline
 * after the last hunk line, F162), or an empty string if there are no changes
 * or if any git command fails.
 */
export function extractPatch(cwd: string): string {
  const run = (cmd: string, opts: { trim?: boolean } = {}): string => {
    const out = execSync(cmd, { cwd, stdio: 'pipe', maxBuffer: MAX_BUFFER }).toString()
    return opts.trim === false ? out : out.trim()
  }

  try {
    run('git add -A')
    const diff = run('git diff --cached HEAD', { trim: false })
    run('git reset HEAD')
    // A diff with no changes is empty; one with changes starts with "diff --git"
    // and ends with the newline git apply requires — never trim it (F162).
    return diff.trim().length ? diff : ''
  } catch {
    // Any git failure (not a repo, no commits, etc.) → return empty
    return ''
  }
}
