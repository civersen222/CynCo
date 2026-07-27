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
import { exec, execFile } from 'node:child_process'
import { getShellInfo, translateEnvPrefix } from './shellInfo.js'

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
  | { kind: 'command'; command: string }

/** Recover the machine-checkable claim from an engine-generated assertion. */
export function assertionCheck(text: string): AssertionCheck | null {
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
  /** Commits since `baseline` that touched `path`. */
  changedSince(baseline: string, path: string): Promise<boolean | null>
  exists(path: string): boolean
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

  if (check.kind === 'file_absent') {
    return probe.exists(check.path)
      ? { status: 'contradicted', detail: `${check.path} is still on disk.` }
      : { status: 'confirmed' }
  }

  // The only check that needs no git and no baseline: a person wrote the command
  // and the command answers for itself. This is what makes an authored contract
  // worth more than the agent's own account of it.
  if (check.kind === 'command') {
    switch (await probe.run(check.command)) {
      case 'passed':
        return { status: 'confirmed' }
      case 'failed':
        return { status: 'contradicted', detail: `the verification command did not exit 0: ${check.command}` }
      case 'timeout':
        return {
          status: 'contradicted',
          detail: `the verification command was still running after ${COMMAND_TIMEOUT_MS / 1000}s and was killed: ${check.command}`,
        }
      case 'unrunnable':
        return { status: 'unverifiable', detail: `could not run the verification command: ${check.command}` }
    }
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
  const runnable = translateEnvPrefix(command, info)
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
    changedSince: async (baseline, path) => {
      const out = await git(cwd, ['diff', '--name-only', `${baseline}..HEAD`, '--', path])
      return out === null ? null : out.trim().length > 0
    },
    exists: (path) => existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
    run: (command) => runCommand(cwd, command),
  }
}
