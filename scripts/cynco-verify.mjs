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

// `NAME=value ` repeated at the head of the command, value optionally quoted.
const ENV_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/

/**
 * Lift a leading POSIX env prefix out of the command and into the child's env.
 *
 * `spawnSync(..., { shell: true })` uses cmd.exe on Windows, which does not
 * understand `FOO=1 prog` and answers `'FOO' is not recognized as an internal
 * or external command` in ~20ms. The engine's own contract runner accepts that
 * prefix (translateEnvPrefix, engine/tools/shellInfo.ts) — so the SAME command
 * ran as an assertion and refused as a check, and the ledger recorded
 * `verified: false` for a gate that never executed. A harness disagreeing with
 * itself about what is runnable writes false failures into the training corpus.
 *
 * Returns { command, env } with the prefix removed and applied.
 */
export function liftEnvPrefix(command, baseEnv) {
  let rest = String(command ?? '')
  let env = null
  let m
  while ((m = ENV_PREFIX.exec(rest)) !== null) {
    const [, name, rawValue] = m
    const quoted = /^(".*"|'.*')$/s.test(rawValue)
    env = env ?? { ...baseEnv }
    env[name] = quoted ? rawValue.slice(1, -1) : rawValue
    rest = rest.slice(m[0].length)
  }
  return { command: rest, env }
}

/**
 * Run a shell check command in `cwd` with a hard timeout.
 * Returns { verified, exitCode, timedOut, spawnFailed, durationMs, outputTail }.
 * `verified` is true | false | null; null means the check never answered.
 */
export function runCheck(command, cwd, timeoutMs) {
  const start = Date.now()
  const lifted = liftEnvPrefix(command, process.env)
  const result = spawnSync(lifted.command, {
    shell: true, // cmd.exe on Windows, /bin/sh elsewhere
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    ...(lifted.env ? { env: lifted.env } : {}),
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
