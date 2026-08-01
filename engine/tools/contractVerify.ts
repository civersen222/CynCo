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
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { exec, execFile } from 'node:child_process'
import { getShellInfo, shellPreamble, translateEnvPrefix } from './shellInfo.js'
import { testCaseAssertions } from '../training/gitFacts.js'

// Templates are shared with contractAutoCreate so the producer of an assertion
// and the code that verifies it cannot drift apart.
export function fileModifiedAssertion(file: string): string {
  return `File ${file} was modified (git diff shows changes)`
}
export function fileExistsAssertion(file: string): string {
  return `File ${file} exists after changes`
}
/**
 * "Delete X" is a claim about absence, and git diff is the wrong instrument for
 * it: an untracked scratch file can never show a diff, and a deleted file has
 * nothing left to diff. The filesystem answers this one directly.
 */
export function fileAbsentAssertion(file: string): string {
  return `File ${file} no longer exists after changes`
}
export const COMMITTED_ASSERTION = 'Changes committed to git'

/**
 * A floor on how many named test cases a file still declares.
 *
 * Finding (w): every other assertion shape here describes the PRODUCT. A
 * contract made entirely of them is silent about whether the suite that
 * measures the product survived — and the cheapest way to keep a suite green is
 * to delete the tests that were not. On Gilded L4.2 that is exactly what
 * happened: 32 cases removed, 28 added, every product assertion confirmed, and
 * the reward's one anti-deletion veto stood down because a "complete" contract
 * was read as authorization for a loss it had never mentioned.
 *
 * So a harness contract can now say the thing directly, and the file answers.
 * A prose warning in the brief is not a measurement; this is.
 */
export function testCensusAssertion(file: string, min: number): string {
  return `Test file ${file} declares at least ${min} test cases`
}

/**
 * The form a harness-authored contract uses for a check the machine should run.
 * `scripts/cynco-mission-driver.mjs` emits it — in mission mode the brief's check
 * script IS the contract.
 */
export function commandAssertion(command: string): string {
  return `Verification command exits 0: ${command}`
}

export type AssertionCheck =
  | { kind: 'file_modified'; path: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_absent'; path: string }
  | { kind: 'committed' }
  /**
   * `withheld` marks a command the model is not allowed to see — the held-out
   * gate. It is set at the construction site in contract.ts, never by
   * `assertionCheck`, because a visible `Verification command exits 0: <cmd>`
   * assertion names its command in its own text and hiding it would help nobody.
   */
  | { kind: 'command'; command: string; withheld?: true }
  | { kind: 'test_census'; path: string; min: number }

/** Recover the machine-checkable claim from an engine-generated assertion. */
export function assertionCheck(text: string): AssertionCheck | null {
  const census = /^Test file (.+) declares at least (\d+) test cases$/.exec(text)
  if (census) return { kind: 'test_census', path: census[1], min: Number(census[2]) }
  const modified = /^File (.+) was modified \(git diff shows changes\)$/.exec(text)
  if (modified) return { kind: 'file_modified', path: modified[1] }
  // Before the existence pattern, whose greedy capture would otherwise read the
  // absence template as a path ending in "no longer".
  const absent = /^File (.+) no longer exists after changes$/.exec(text)
  if (absent) return { kind: 'file_absent', path: absent[1] }
  const exists = /^File (.+) exists after changes$/.exec(text)
  if (exists) return { kind: 'file_exists', path: exists[1] }
  if (text === COMMITTED_ASSERTION) return { kind: 'committed' }
  // `[\s\S]` rather than `.` — a check script may span lines.
  const command = /^Verification command exits 0: ([\s\S]+)$/.exec(text)
  if (command?.[1].trim()) return { kind: 'command', command: command[1].trim() }
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
/**
 * What running a verification command actually established.
 *
 * Deliberately NOT an exit code. Every check runs through a shell, and a shell
 * does not always pass a program's status through: measured on Windows
 * PowerShell 5.1, `python -c "sys.exit(3)"` arrives as 1. Reporting "exit code
 * 1" therefore names a number nobody measured — the program's real code was 3
 * and the shell invented the 1. The pass/fail verdict survives (0 stays 0), so
 * this was only ever a message-honesty defect, but "never report a number you
 * did not measure" is the rule the whole reward pipeline rests on.
 *
 * `timeout` is separate because it IS measured: the engine killed the process
 * itself and knows why it stopped.
 */
export type CommandOutcome = 'passed' | 'failed' | 'timeout' | 'unrunnable'

export type RepoProbe = {
  head(): Promise<string | null>
  /** Uncommitted changes to `path` in the working tree or index. */
  isDirty(path: string): Promise<boolean | null>
  /**
   * Every TRACKED path with uncommitted changes, staged or not.
   *
   * Untracked paths are deliberately excluded. A workspace accumulates scratch
   * that predates the task and belongs to nobody; failing on it would fire on
   * every task forever, and a check that always fires teaches nothing.
   */
  dirtyPaths(): Promise<string[] | null>
  /** Commits since `baseline` that touched `path`. */
  changedSince(baseline: string, path: string): Promise<boolean | null>
  exists(path: string): boolean
  /** Contents of `path`, or null when it cannot be read. */
  read(path: string): string | null
  /** What running `command` in the workspace established. */
  run(command: string): Promise<CommandOutcome>
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

  if (check.kind === 'test_census') {
    const content = probe.read(check.path)
    if (content === null) {
      return { status: 'contradicted', detail: `${check.path} could not be read, so it declares no test cases.` }
    }
    const count = testCaseAssertions(content).size
    return count >= check.min
      ? { status: 'confirmed' }
      : {
          status: 'contradicted',
          detail: `${check.path} declares ${count} test cases, ${check.min - count} fewer than the ${check.min} required.`,
        }
  }

  if (check.kind === 'file_absent') {
    return probe.exists(check.path)
      ? { status: 'contradicted', detail: `${check.path} is still on disk.` }
      : { status: 'confirmed' }
  }

  // The only check that needs no git and no baseline: a person wrote the command
  // and the command answers for itself. This is what makes an authored contract
  // worth more than the agent's own account of it.
  if (check.kind === 'command') {
    // F34. The detail is the only thing the model reads about why it was
    // refused, and it interpolated the command into all three non-passing
    // outcomes. For the held-out gate that hands over a path, and the gate is a
    // file: Wave 8b's lists all 22 mutation anchors with their replacements, so
    // a model that reads it can pin those 22 strings and satisfy nothing else.
    // Naming it is not what makes the message useful — saying it ran and
    // answered no is.
    const named = check.withheld ? '' : `: ${check.command}`
    switch (await probe.run(check.command)) {
      case 'passed':
        return { status: 'confirmed' }
      case 'failed':
        return { status: 'contradicted', detail: `the verification command did not exit 0${named}` }
      case 'timeout':
        return {
          status: 'contradicted',
          detail: `the verification command was still running after ${COMMAND_TIMEOUT_MS / 1000}s and was killed${named}`,
        }
      case 'unrunnable':
        return { status: 'unverifiable', detail: `could not run the verification command${named}` }
    }
  }

  if (check.kind === 'committed') {
    if (!baseline) return { status: 'unverifiable', detail: 'no baseline commit was recorded for this task' }
    const head = await probe.head()
    if (head === null) return { status: 'unverifiable', detail: 'not a git repository' }
    if (head === baseline) {
      return { status: 'contradicted', detail: `HEAD is still ${baseline.slice(0, 8)} — no commit was made during this task.` }
    }
    // A moved HEAD proves a commit happened. It does not prove the work is in
    // it. Measured on Gilded L4.6d: two commits landed, one edited test file
    // was left behind, and the assertion confirmed — the published gate scored
    // 12/12 on the working tree and 10/12 at the commit anyone else would get.
    const dirty = await probe.dirtyPaths()
    // A probe that cannot answer must not manufacture a negative. Absent is a
    // legitimate answer; a plausible default is not.
    if (dirty === null || dirty.length === 0) return { status: 'confirmed' }
    const named = dirty.slice(0, 5).join(', ')
    const rest = dirty.length > 5 ? ` (and ${dirty.length - 5} more)` : ''
    return {
      status: 'contradicted',
      detail: `a commit was made, but tracked files still have uncommitted changes: ${named}${rest}. The work is not all in the commit.`,
    }
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

/** Long enough for a real test suite, short enough that a hung check ends the turn. */
const COMMAND_TIMEOUT_MS = 300_000

function runCommand(cwd: string, command: string): Promise<CommandOutcome> {
  // The same shell the Bash tool uses. `exec` would otherwise default to
  // cmd.exe on Windows, so a check script written in the dialect the brief and
  // every other command in the session use — PowerShell here — would fail on
  // syntax and be reported as the work being wrong.
  const info = getShellInfo()
  const shell = info.shell
  // Finding (o): a contract check is authored alongside the brief, and briefs
  // are written POSIX-style. `NAME=value command` is a parse error in every
  // PowerShell, so the shell rejected the line before the program started and
  // the engine scored an unrun command as the work failing. The engine already
  // knows this translation — it hands the model the same rewrite when the model
  // makes this mistake — so it applies it to its own command too.
  // Finding (ab), same reasoning one level down: a check that redirects to a
  // file and then reads it back gets UTF-16LE under Windows PowerShell 5.1 and
  // answers "no" about its own scratch file. The model's shell and the engine's
  // shell must be configured alike or the engine is verifying under conditions
  // the work was never done in.
  const runnable = shellPreamble(info) + translateEnvPrefix(command, info)
  return new Promise(resolvePromise => {
    exec(runnable, { cwd, shell, encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, err => {
      if (!err) return resolvePromise('passed')
      const e = err as Error & { code?: number | string; killed?: boolean }
      if (e.killed) return resolvePromise('timeout')
      // A shell that ran the command reports its status as a number — including
      // 127 for "not found", which is a real failing answer. Anything else
      // (the shell would not start, output overran the buffer) is no answer.
      if (typeof e.code === 'number') return resolvePromise('failed')
      return resolvePromise('unrunnable')
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
    dirtyPaths: async () => {
      // `--untracked-files=no` is the whole point: scratch that predates the
      // task is not the task's fault. Porcelain v1 lines are `XY <path>`, and a
      // rename reads `R  old -> new` — the new name is the one that is dirty.
      const out = await git(cwd, ['status', '--porcelain', '--untracked-files=no'])
      if (out === null) return null
      return out
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          const path = line.slice(3).trim()
          const arrow = path.lastIndexOf(' -> ')
          return arrow === -1 ? path : path.slice(arrow + 4)
        })
    },
    changedSince: async (baseline, path) => {
      const out = await git(cwd, ['diff', '--name-only', `${baseline}..HEAD`, '--', path])
      return out === null ? null : out.trim().length > 0
    },
    exists: (path) => existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
    read: (path) => {
      try {
        return readFileSync(isAbsolute(path) ? path : resolve(cwd, path), 'utf-8')
      } catch {
        return null
      }
    },
    run: (command) => runCommand(cwd, command),
  }
}
