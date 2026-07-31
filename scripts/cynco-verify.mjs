// Post-mission verification runner (STATE-AND-VISION Phase 2(b)).
//
// Each mission brief ships with a check command (pytest/smoke/grep) that the
// driver runs AFTER the outcome is determined, in the mission's cwd.
//
//   exit 0        → verified: true    the check ran and answered "yes"
//   nonzero exit  → verified: false   the check ran and answered "no"
//   timeout       → verified: null    the check NEVER ANSWERED
//   spawn failure → verified: null    the check never started
//
// The null cases used to be recorded as `false`, on the reasoning that erring
// toward failure is safe. It is not. `verified` is a claim about the DELIVERY;
// a timeout is a fact about the HARNESS. Labeling "my instrument ran out of
// time" as "the work is broken" puts a measurement in the ledger that was
// never taken, and the training corpus reads that record as a real failure.
// Measured, or absent — never a plausible default. A null is loud: the driver
// prints UNMEASURED and the 1-in-5 spot-audit sees an unlabeled record.
//
// Plain .mjs on node:child_process so it runs under Bun (driver) AND under
// vitest/node (tests) unchanged.

import { spawnSync } from 'node:child_process'

const OUTPUT_TAIL_CHARS = 2000

/**
 * Run a shell check command in `cwd` with a hard timeout.
 * Returns { verified, exitCode, timedOut, spawnFailed, durationMs, outputTail }.
 * `verified` is true | false | null; null means the check never answered.
 */
export function runCheck(command, cwd, timeoutMs) {
  const start = Date.now()
  const result = spawnSync(command, {
    shell: true, // cmd.exe on Windows, /bin/sh elsewhere
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  })
  const durationMs = Date.now() - start
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const spawnFailed = Boolean(result.error) && !timedOut
  const exitCode = typeof result.status === 'number' ? result.status : null
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}` +
    (timedOut ? `\n[check] TIMED OUT after ${timeoutMs}ms` : '') +
    (spawnFailed ? `\n[check] SPAWN FAILED: ${result.error.message}` : '')
  return {
    // null, not false: the check never produced an answer about the delivery.
    verified: (timedOut || spawnFailed) ? null : exitCode === 0,
    exitCode,
    timedOut,
    spawnFailed,
    durationMs,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  }
}
