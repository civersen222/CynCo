// Post-mission verification runner (STATE-AND-VISION Phase 2(b)).
//
// Each mission brief ships with a check command (pytest/smoke/grep) that the
// driver runs AFTER the outcome is determined, in the mission's cwd. Exit
// code 0 → verified:true; nonzero exit, timeout, or spawn failure →
// verified:false. Erring toward failure labels is deliberate: the Phase 2
// exit criterion needs genuine failures, and a broken check harness is
// visible in the recorded `verify` detail + the 1-in-5 human spot-audit.
//
// Plain .mjs on node:child_process so it runs under Bun (driver) AND under
// vitest/node (tests) unchanged.

import { spawnSync } from 'node:child_process'

const OUTPUT_TAIL_CHARS = 2000

/**
 * Run a shell check command in `cwd` with a hard timeout.
 * Returns { verified, exitCode, timedOut, durationMs, outputTail }.
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
    verified: exitCode === 0 && !timedOut && !spawnFailed,
    exitCode,
    timedOut,
    durationMs,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  }
}
