// Post-mission verification runner (STATE-AND-VISION Phase 2(b)).
//
// Each mission brief ships with a check command (pytest/smoke/grep) that the
// driver runs AFTER the outcome is determined, in the mission's cwd.
//
//   exit 0        → verified: true    the check ran and answered "yes"
//   nonzero exit  → verified: false   the check ran and answered "no"
//   timeout       → verified: null    the check NEVER ANSWERED
//   spawn failure → verified: null    the check never started
//   harness fault → verified: null    the check ran, but the failure is
//                                     about the HARNESS, not the delivery
//                                     (F146: wrong shell, pytest usage error)
//
// The null cases used to be recorded as `false`, on the reasoning that erring
// toward failure is safe. It is not. `verified` is a claim about the DELIVERY;
// a timeout is a fact about the HARNESS. Labeling "my instrument ran out of
// time" as "the work is broken" puts a measurement in the ledger that was
// never taken, and the training corpus reads that record as a real failure.
// Measured, or absent — never a plausible default. A null is loud: the driver
// prints UNMEASURED and the 1-in-5 spot-audit sees an unlabeled record.
//
// F146: `spawnSync(..., { shell: true })` is cmd.exe on Windows — not the
// shell the model runs commands in (PowerShell/bash, engine/tools/shellInfo.ts)
// and not the shell the engine's own contract runner uses
// (engine/tools/contractVerify.ts:323-343). cmd.exe does not expand a glob
// like `test_c8_*.py`, so a check written the way every other command in the
// session is written failed on shell dialect, not on the work — and the
// ledger recorded `verified: false` for a check that never ran. runCheck now
// uses getShellInfo()/shellPreamble()/translateEnvPrefix() exactly like
// contractVerify.ts, so the check runs in the SAME shell as everything else
// measuring the mission. A pytest usage error (exit 4, "file or directory not
// found") or "no tests collected" (exit 5) is the same class of problem one
// layer up: the check command itself is wrong, not the delivery, so it is a
// harnessFault with verified:null rather than a false failure.
//
// Plain .mjs on node:child_process so it runs under Bun (driver) AND under
// vitest/node (tests) unchanged.

import { spawnSync } from 'node:child_process'
import { getShellInfo, shellPreamble, translateEnvPrefix } from '../engine/tools/shellInfo.js'

const OUTPUT_TAIL_CHARS = 2000

const PYTEST_USAGE_ERROR = 4
const PYTEST_NO_TESTS = 5

/**
 * Run a shell check command in `cwd` with a hard timeout, in the SAME shell
 * the model and the engine's contract runner use.
 * Returns { verified, exitCode, timedOut, spawnFailed, harnessFault, durationMs, outputTail }.
 * `verified` is true | false | null; null means the check never answered
 * about the DELIVERY — because it never finished, never started, or answered
 * about the HARNESS instead (`harnessFault` is set whenever `verified` is
 * null for one of those reasons).
 */
export function runCheck(command, cwd, timeoutMs) {
  const start = Date.now()
  const info = getShellInfo()
  // PowerShell (5.1 and 7) does not make an external program's exit code its
  // OWN process exit code — `-Command "pytest ..."` returns 1 for ANY nonzero
  // exit, collapsing 3 and 4 alike, and only $LASTEXITCODE carries the real
  // number. That is invisible to a zero/nonzero check (contractVerify.ts's
  // runCommand only asks "did it fail"), but this function must tell a real
  // pytest failure (exit 1-3) apart from a pytest usage error (exit 4/5), so
  // it has to recover the real code. `exit N` (a PowerShell statement, not an
  // external command) already terminates before this suffix runs, so it never
  // overrides one; $LASTEXITCODE is $null when nothing external ran, so the
  // guard leaves that case alone too.
  const exitPropagation = info.isPowerShell ? '; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }' : ''
  const runnable = shellPreamble(info) + translateEnvPrefix(String(command ?? ''), info) + exitPropagation
  const result = spawnSync(runnable, {
    shell: info.shell,
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  })
  const durationMs = Date.now() - start
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const spawnFailed = Boolean(result.error) && !timedOut
  const exitCode = typeof result.status === 'number' ? result.status : null
  const mentionsPytest = /\bpytest\b/.test(String(command ?? ''))
  let harnessFault = null
  if (timedOut) harnessFault = `timed out after ${timeoutMs}ms`
  else if (spawnFailed) harnessFault = `spawn failed: ${result.error.message}`
  else if (mentionsPytest && exitCode === PYTEST_USAGE_ERROR) {
    harnessFault = 'pytest usage error (exit 4): the check command itself is wrong — a path did not resolve'
  } else if (mentionsPytest && exitCode === PYTEST_NO_TESTS) {
    harnessFault = 'pytest collected no tests (exit 5): the check measured nothing'
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}` +
    (harnessFault ? `\n[check] HARNESS FAULT: ${harnessFault}` : '')
  return {
    // null, not false: the check never produced an answer about the delivery.
    verified: harnessFault ? null : exitCode === 0,
    exitCode,
    timedOut,
    spawnFailed,
    harnessFault,
    durationMs,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  }
}
