/**
 * Objective facts about what a task changed on disk.
 *
 * The only module in the reward stack that shells out; taskOutcome.ts stays
 * pure by consuming this structure rather than running git itself.
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * `binary: true` means git reported `-` for the line counts. Line counts are
 * meaningless for that file, so consumers must treat it as unmeasured rather
 * than reading `added: 0, deleted: 0` as "nothing changed".
 *
 * `assertions` and `skips` are net deltas over the same diff — populated only
 * for non-binary test paths, and left undefined when the per-file diff could
 * not be read. Undefined means "not measured", never zero.
 *
 * `casesLost` counts named test cases that existed before and cannot fail now:
 * gone entirely, or still present with nothing left that checks anything. It is
 * measured from the two file versions rather than the diff, because a net
 * assertion delta cannot tell deduplication from weakening and this can.
 *
 * `casesAdded` is its mirror: named cases that exist now and did not before. A
 * line added to a test file is not a test — a product change can force a
 * one-line rewrite of the assertion that pins it, and reading that as "the task
 * wrote tests" is finding (q). Both are counted from the same two file versions
 * and are left undefined together when neither could be read.
 */
export type ChangedFile = {
  path: string
  added: number
  deleted: number
  binary?: true
  assertions?: number
  skips?: number
  casesLost?: number
  casesAdded?: number
}

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

/**
 * A line that CHECKS something.
 *
 * The safety gate needs to tell "the agent deleted dead scaffolding" from "the
 * agent deleted the line that fails when the code is wrong", and line counts
 * cannot: a brief whose own instruction is "trim this file" makes a shrinking
 * test file the correct outcome.
 *
 * Deliberately loose, and safe for being loose: the same pattern is applied to
 * both sides of one diff, so a false positive on an added line cancels against
 * the removed line it replaced. Only the direction of the net delta is read.
 */
const ASSERTION_LINE =
  /\bassert\w*|\bexpect\s*\(|\.to[A-Z]\w*\s*\(|\bshould\b|\bt\.(Error|Fatal)f?\b|\b(pytest\.)?raises\b|\btoThrow\b/

/** Introducing one of these disables a test without deleting a single line. */
const SKIP_MARKER =
  /\b(it|test|describe|context)\.(skip|todo|only)\b|\bx(it|describe)\s*\(|@pytest\.mark\.(skip|skipif|xfail)|@unittest\.skip|\bt\.Skip(Now)?\b|\bpytest\.skip\b/

/**
 * Net assertion and skip deltas for one file between `range` and the worktree,
 * or null when the diff could not be read — which is "not measured".
 */
function countTestSignals(cwd: string, range: string, path: string): { assertions: number; skips: number } | null {
  // The path is interpolated into a shell command, so anything that would need
  // real quoting is declined rather than guessed at. This also catches the
  // C-quoted paths numstat emits for non-ASCII names, which begin with `"`.
  if (/["`$\n]/.test(path)) return null
  let diff: string
  try {
    diff = git(cwd, `diff -U0 ${range} -- "${path}"`)
  } catch {
    return null
  }
  let assertions = 0
  let skips = 0
  for (const line of diff.split('\n')) {
    // `+++`/`---` are the file headers, not content.
    if (line.startsWith('+++') || line.startsWith('---')) continue
    const sign = line[0]
    if (sign !== '+' && sign !== '-') continue
    const body = line.slice(1)
    const delta = sign === '+' ? 1 : -1
    if (ASSERTION_LINE.test(body)) assertions += delta
    if (SKIP_MARKER.test(body)) skips += delta
  }
  return { assertions, skips }
}

/**
 * The declaration line of a single named test case.
 *
 * `describe`/`context` are deliberately absent: they group cases, and counting a
 * group as a case would report a loss every time a suite is reorganised.
 */
const TEST_CASE_DECL: RegExp[] = [
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
  /^\s*func\s+(Test\w+)\s*\(/,
  /^\s*(?:it|test)\s*(?:\.\w+)?\s*\(\s*(?:['"`])(.+?)(?:['"`])/,
]

function declaredCase(line: string): string | null {
  for (const re of TEST_CASE_DECL) {
    const m = re.exec(line)
    if (m) return m[m.length - 1]
  }
  return null
}

/**
 * Every named test case in `content`, mapped to how many lines inside it check
 * something.
 *
 * Attribution runs to the next declaration, so a helper defined between two
 * tests has its lines credited to the one above it. That is imprecise in the
 * absolute, and harmless here: the same rule is applied to both versions of the
 * file, and only cases that go from "checks something" to "checks nothing" are
 * read out.
 */
export function testCaseAssertions(content: string): Map<string, number> {
  const cases = new Map<string, number>()
  let current: string | null = null
  for (const line of content.split('\n')) {
    const name = declaredCase(line)
    if (name !== null) {
      current = name
      // A case redeclared under one name (a table-driven `it` in a loop, a
      // duplicate) is one case; keep whatever it has already accumulated.
      if (!cases.has(current)) cases.set(current, 0)
      continue
    }
    if (current !== null && ASSERTION_LINE.test(line)) {
      cases.set(current, (cases.get(current) as number) + 1)
    }
  }
  return cases
}

/**
 * How many named test cases in `path` went away and how many appeared, comparing
 * the version at `range` with the one in the worktree. Both null only when the
 * path itself cannot be safely handed to git.
 *
 * `lost` is the measurement that separates the two things a shrinking test file
 * can mean. Collapsing a copy-pasted second half of a test removes assertions
 * and loses no case; deleting a test that was failing, or replacing its body
 * with `pass`, loses one. Watched live twice: both times a brief said "trim
 * this file", the trim was correct, every case survived, and the net assertion
 * delta still read as weakening.
 *
 * `added` separates the mirror pair, and the same argument runs in reverse:
 * a line added to a test file can be a new case or a one-character edit to an
 * existing assertion, and only one of those is coverage.
 */
function countCaseDelta(
  cwd: string,
  range: string,
  path: string,
): { lost: number | null; added: number | null } {
  if (/["`$\n]/.test(path)) return { lost: null, added: null }
  let before: string
  try {
    before = git(cwd, `show ${range}:"${path}"`)
  } catch {
    // The file is in the diff against `range` but has no version there, so the
    // task created it. Nothing was lost — that stays unmeasured, as it always
    // was — but every case it now holds is one that did not exist before, and
    // writing a new test file is the most ordinary way there is to add coverage.
    before = ''
  }
  const wasThere = testCaseAssertions(before)

  let after: string
  try {
    after = readFileSync(resolve(cwd, path), 'utf-8')
  } catch {
    // Not on disk: the file was deleted, so every case it held is gone.
    after = ''
  }
  const isThere = testCaseAssertions(after)

  let gone = 0
  let gutted = 0
  for (const [name, asserted] of wasThere) {
    const now = isThere.get(name)
    if (now === undefined) gone++
    // Still declared, but nothing in it checks anything any more. A case that
    // cannot fail is not a case, however many lines it still has. Counted
    // separately from `gone` because a rename cannot disguise it.
    else if (asserted > 0 && now === 0) gutted++
  }

  let appeared = 0
  for (const name of isThere.keys()) if (!wasThere.has(name)) appeared++

  // Renaming a case makes its old name vanish, which is not a loss. Netting the
  // names that appeared against the ones that went is the same cancellation the
  // assertion count relies on: it costs the ability to see "deleted one test and
  // added a trivial one", and that case still falls through to 'unknown' rather
  // than earning credit.
  //
  // `added` nets the same way and for the same reason in the mirror: a rename
  // makes a name appear without adding an ounce of coverage, and crediting it
  // would let a run earn the heaviest component in the reward by renaming a test.
  return {
    lost: Math.max(0, gone - appeared) + gutted,
    added: Math.max(0, appeared - gone),
  }
}

/**
 * The paths git calls dirty right now.
 *
 * Exported so a caller can record the tree's state BEFORE a task runs and
 * compare it with the state after using one parser. Two lists built by two
 * different readers of `status --porcelain` would disagree on exactly the paths
 * that need care — renames, spaces, non-ASCII names.
 *
 * Null when git could not answer, which is "not measured". Never an empty
 * array on failure: an empty array is the positive claim that the tree is clean.
 */
export function collectDirtyPaths(cwd: string): string[] | null {
  try {
    return git(cwd, 'status --porcelain')
      .split('\n')
      .filter(l => l.length > 3)
      .map(porcelainPath)
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * A per-path signature of the tree's current content state: path -> a token
 * that changes whenever that path's content changes.
 *
 * Exists so a caller can tell which paths a single shell command touched, by
 * taking one of these before and one after and comparing. `status --porcelain`
 * alone cannot answer that: appending to a file that is ALREADY modified leaves
 * the porcelain line byte-identical, so a set-difference over paths sees
 * nothing. The numstat half supplies the magnitude that does change.
 *
 * Deliberately NOT derived from the command text. Scanning a shell string for
 * filenames would be a proxy for the thing actually wanted, and would be
 * confidently wrong on redirects, heredocs, interpreter one-liners and any
 * path the command computes for itself.
 *
 * Null when git could not answer — "not measured", never an empty map, which
 * would be the positive claim that nothing anywhere has changed.
 */
export function collectPathSignatures(cwd: string): Map<string, string> | null {
  try {
    const sig = new Map<string, string>()
    // Tracked content, including staged work: covers modification magnitude.
    for (const line of git(cwd, 'diff --numstat HEAD').split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      sig.set(m[3].replace(/\\/g, '/'), `${m[1]},${m[2]}`)
    }
    // Untracked paths have no diff against HEAD at all, so they need the
    // porcelain half or a newly created file would be invisible.
    for (const line of git(cwd, 'status --porcelain').split('\n')) {
      if (line.length <= 3) continue
      const p = porcelainPath(line)
      if (!p) continue
      const status = line.slice(0, 2)
      const key = p.replace(/\\/g, '/')
      sig.set(key, `${status}:${sig.get(key) ?? ''}`)
    }
    return sig
  } catch {
    return null
  }
}

/**
 * Paths whose content signature differs between two snapshots — i.e. the paths
 * that changed in between. Empty when either snapshot is missing, because an
 * unmeasured interval is not evidence that something changed.
 */
export function changedBetween(
  before: Map<string, string> | null,
  after: Map<string, string> | null,
): string[] {
  if (!before || !after) return []
  const touched: string[] = []
  for (const [p, s] of after) if (before.get(p) !== s) touched.push(p)
  // A path that vanished from the signature changed too: it was reverted,
  // committed, or deleted, and in every one of those cases the command did
  // something to it.
  for (const p of before.keys()) if (!after.has(p)) touched.push(p)
  return [...new Set(touched)]
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

  // No fallback to HEAD. Diffing HEAD against the working tree makes anything
  // the agent COMMITTED during the task invisible, so a run that gutted a test
  // suite and committed it reads as testsUnmodified: 1 — a fabricated pass on
  // the one gate that exists to catch it. A repo with no resolvable base has
  // nothing to diff against, and 'unknown' is the honest answer.
  if (baseSha === null) return null

  const range = baseSha
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
      const path = m[3].replace(/\\/g, '/')
      const entry: ChangedFile = {
        path,
        added: binary ? 0 : parseInt(m[1], 10),
        deleted: binary ? 0 : parseInt(m[2], 10),
        ...(binary ? { binary: true as const } : {}),
      }
      // One extra `git diff` per changed test file. Only test files, because
      // this is the only consumer's question and product diffs can be huge.
      if (!binary && isTestPath(path)) {
        const signals = countTestSignals(cwd, range, path)
        if (signals) {
          entry.assertions = signals.assertions
          entry.skips = signals.skips
        }
        const cases = countCaseDelta(cwd, range, path)
        if (cases.lost !== null) entry.casesLost = cases.lost
        if (cases.added !== null) entry.casesAdded = cases.added
      }
      changed.push(entry)
    }

    const removed = git(cwd, `diff --name-only --diff-filter=D ${range}`)
      .split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(Boolean)

    const dirty = collectDirtyPaths(cwd)
    if (dirty === null) return null

    return { changed, removed, dirty }
  } catch {
    return null
  }
}
