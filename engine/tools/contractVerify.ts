/**
 * Ground truth for the assertions the engine writes itself.
 *
 * Contract assertions are synthesized from the user's message (see
 * contractAutoCreate.ts), and until now `ContractAssertPass` recorded whatever
 * evidence string the model supplied without ever checking it. That is a
 * degenerate success signal: a run that made zero edits marked
 * "File grip.py was modified" as PASSED on the evidence "grip.py refers to
 * gilded/grip.py", and the task reported four of four assertions green.
 *
 * The assertions the engine generates are not opinions — "this file changed",
 * "this file exists", "the work was committed" are all things the repository can
 * answer. So the engine answers them, and the model's say-so is not accepted
 * over the repository's.
 *
 * Where the repository genuinely cannot answer (no git, no baseline), the result
 * is `unverifiable` — recorded as unverified rather than quietly counted as
 * measured. Absent is a legitimate answer; a plausible default is not.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { execFile } from 'node:child_process'

// Templates are shared with contractAutoCreate so the producer of an assertion
// and the code that verifies it cannot drift apart.
export function fileModifiedAssertion(file: string): string {
  return `File ${file} was modified (git diff shows changes)`
}
export function fileExistsAssertion(file: string): string {
  return `File ${file} exists after changes`
}
export const COMMITTED_ASSERTION = 'Changes committed to git'

export type AssertionCheck =
  | { kind: 'file_modified'; path: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'committed' }

/** Recover the machine-checkable claim from an engine-generated assertion. */
export function assertionCheck(text: string): AssertionCheck | null {
  const modified = /^File (.+) was modified \(git diff shows changes\)$/.exec(text)
  if (modified) return { kind: 'file_modified', path: modified[1] }
  const exists = /^File (.+) exists after changes$/.exec(text)
  if (exists) return { kind: 'file_exists', path: exists[1] }
  if (text === COMMITTED_ASSERTION) return { kind: 'committed' }
  return null
}

export type Verification =
  | { status: 'confirmed' }
  | { status: 'contradicted'; detail: string }
  | { status: 'unverifiable'; detail: string }

/**
 * The repository facts a check needs. Each method returns null when the
 * question cannot be answered here (not a git repo, git missing), which is
 * distinct from answering "no".
 */
export type RepoProbe = {
  head(): Promise<string | null>
  /** Uncommitted changes to `path` in the working tree or index. */
  isDirty(path: string): Promise<boolean | null>
  /** Commits since `baseline` that touched `path`. */
  changedSince(baseline: string, path: string): Promise<boolean | null>
  exists(path: string): boolean
}

export async function verifyAssertion(
  check: AssertionCheck,
  probe: RepoProbe,
  baseline: string | null,
): Promise<Verification> {
  if (check.kind === 'file_exists') {
    return probe.exists(check.path)
      ? { status: 'confirmed' }
      : { status: 'contradicted', detail: `${check.path} does not exist on disk.` }
  }

  if (check.kind === 'committed') {
    if (!baseline) return { status: 'unverifiable', detail: 'no baseline commit was recorded for this task' }
    const head = await probe.head()
    if (head === null) return { status: 'unverifiable', detail: 'not a git repository' }
    return head !== baseline
      ? { status: 'confirmed' }
      : { status: 'contradicted', detail: `HEAD is still ${baseline.slice(0, 8)} — no commit was made during this task.` }
  }

  // file_modified — changed in the working tree, or committed since the baseline.
  const dirty = await probe.isDirty(check.path)
  if (dirty === null) return { status: 'unverifiable', detail: 'not a git repository' }
  if (dirty) return { status: 'confirmed' }
  if (!baseline) return { status: 'unverifiable', detail: 'no baseline commit was recorded for this task' }
  const committed = await probe.changedSince(baseline, check.path)
  if (committed === null) return { status: 'unverifiable', detail: 'not a git repository' }
  return committed
    ? { status: 'confirmed' }
    : {
        status: 'contradicted',
        detail: `${check.path} is unchanged: no uncommitted edits, and no commit since ${baseline.slice(0, 8)} touched it.`,
      }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(resolvePromise => {
    execFile('git', args, { cwd, encoding: 'utf-8' }, (err, stdout) => {
      resolvePromise(err ? null : stdout)
    })
  })
}

export function gitProbe(cwd: string): RepoProbe {
  return {
    head: async () => (await git(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null,
    isDirty: async (path) => {
      const out = await git(cwd, ['status', '--porcelain', '--', path])
      return out === null ? null : out.trim().length > 0
    },
    changedSince: async (baseline, path) => {
      const out = await git(cwd, ['diff', '--name-only', `${baseline}..HEAD`, '--', path])
      return out === null ? null : out.trim().length > 0
    },
    exists: (path) => existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
  }
}
