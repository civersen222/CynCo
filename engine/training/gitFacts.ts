/**
 * Objective facts about what a task changed on disk.
 *
 * The only module in the reward stack that shells out; taskOutcome.ts stays
 * pure by consuming this structure rather than running git itself.
 */

import { execSync } from 'child_process'

export type ChangedFile = { path: string; added: number; deleted: number }

export type GitFacts = {
  changed: ChangedFile[]
  removed: string[]
  dirty: string[]
}

const TEST_PATH =
  /(^|[\/\\])(tests?|__tests__|spec)[\/\\]|(^|[\/\\])test_[^\/\\]+\.py$|[._](test|spec)\.[jt]sx?$|_test\.(go|py|rb)$/i

/** True when a repo-relative path is a test file by any common convention. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
    .toString()
}

/**
 * Collect changes between `baseSha` and the current working tree.
 * Returns null when cwd is not a git repo or baseSha is not resolvable —
 * callers must degrade to `unknown` rather than guessing.
 */
export function collectGitFacts(cwd: string, baseSha: string | null): GitFacts | null {
  try {
    git(cwd, 'rev-parse --is-inside-work-tree')
  } catch {
    return null
  }

  const range = baseSha ?? 'HEAD'
  try {
    // git cat-file -t exits non-zero when the object is not found.
    // We use this instead of `rev-parse --verify <sha>^{commit}` because
    // the `^{commit}` suffix is eaten by cmd.exe on Windows when execSync
    // routes through the default shell (COMSPEC).
    const type = git(cwd, `cat-file -t ${range}`).trim()
    if (type !== 'commit') return null
  } catch {
    return null
  }

  try {
    const changed: ChangedFile[] = []
    for (const line of git(cwd, `diff --numstat ${range}`).split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      changed.push({
        path: m[3].replace(/\\/g, '/'),
        added: m[1] === '-' ? 0 : parseInt(m[1], 10),
        deleted: m[2] === '-' ? 0 : parseInt(m[2], 10),
      })
    }

    const removed = git(cwd, `diff --name-only --diff-filter=D ${range}`)
      .split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(Boolean)

    const dirty = git(cwd, 'status --porcelain')
      .split('\n')
      .map(l => l.slice(3).trim().replace(/\\/g, '/'))
      .filter(Boolean)

    return { changed, removed, dirty }
  } catch {
    return null
  }
}
