/**
 * Objective facts about what a task changed on disk.
 *
 * The only module in the reward stack that shells out; taskOutcome.ts stays
 * pure by consuming this structure rather than running git itself.
 */

import { execSync } from 'child_process'

/**
 * `binary: true` means git reported `-` for the line counts. Line counts are
 * meaningless for that file, so consumers must treat it as unmeasured rather
 * than reading `added: 0, deleted: 0` as "nothing changed".
 */
export type ChangedFile = { path: string; added: number; deleted: number; binary?: true }

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

/**
 * Extract the on-disk path from one `git status --porcelain` line.
 *
 * The format is two status characters, a space, then the path. Two cases need
 * more than a slice: renames and copies are written `R  old -> new` (we want
 * `new`, the path that exists now), and paths with spaces, quotes, or
 * non-ASCII characters are C-quoted. A naive slice turns both into strings
 * that match no real file, which would make an exact-path dirty check miss.
 */
function porcelainPath(line: string): string {
  const status = line.slice(0, 2)
  let rest = line.slice(3)
  if (status.includes('R') || status.includes('C')) {
    const arrow = rest.lastIndexOf(' -> ')
    if (arrow !== -1) rest = rest.slice(arrow + 4)
  }
  rest = rest.trim()
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    rest = unquote(rest.slice(1, -1))
  }
  return rest.replace(/\\/g, '/')
}

const SIMPLE_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }

/**
 * Decode git's C-quoting. Non-ASCII bytes come back as octal escapes
 * (`caf\303\251.txt`), so the escapes are decoded to bytes and the whole path
 * is then read as UTF-8 — decoding them one character at a time would produce
 * mojibake.
 */
function unquote(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      for (const b of Buffer.from(s[i], 'utf-8')) bytes.push(b)
      continue
    }
    const octal = s.slice(i + 1, i + 4)
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8))
      i += 3
      continue
    }
    const next = s[i + 1] ?? ''
    bytes.push(SIMPLE_ESCAPES[next] ?? next.charCodeAt(0))
    i += 1
  }
  return Buffer.from(bytes).toString('utf-8')
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
      const binary = m[1] === '-' || m[2] === '-'
      changed.push({
        path: m[3].replace(/\\/g, '/'),
        added: binary ? 0 : parseInt(m[1], 10),
        deleted: binary ? 0 : parseInt(m[2], 10),
        ...(binary ? { binary: true as const } : {}),
      })
    }

    const removed = git(cwd, `diff --name-only --diff-filter=D ${range}`)
      .split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(Boolean)

    const dirty = git(cwd, 'status --porcelain')
      .split('\n')
      .filter(l => l.length > 3)
      .map(porcelainPath)
      .filter(Boolean)

    return { changed, removed, dirty }
  } catch {
    return null
  }
}
