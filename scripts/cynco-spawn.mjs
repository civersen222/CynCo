// scripts/cynco-spawn.mjs — the one synchronous spawn every grader uses.
//
// F155. Under bun 1.3.13 on Windows, `spawnSync`'s timeout deadline is measured
// from the PREVIOUS `spawnSync` in the same process rather than from this call:
// the first spawn after a long idle gap is killed almost immediately with
// `error.code === 'ETIMEDOUT'` and empty output, and the spawns right after it
// run normally. The reviewer's reproduction, one process:
//
//   warmup   36 ms   normal
//   A         7 ms   ETIMEDOUT, empty stdout   (12 s gap before it)
//   B        —       normal
//   C        —       normal
//
// The live C9 authoring runner had last spawned four hours earlier
// (`archiveBase` / `commitStaging`), so its first gate run — the gate at BASE —
// came back empty and "timed out after 7200000 ms" after a few milliseconds.
// Everything downstream believed it: a null terminator, zero parsed lines, and
// six MUST-FAIL comparisons against an empty BASE failure set.
//
// Two rules follow, and they are the whole of this module:
//
//   1. A TIMEOUT IS AN ELAPSED MEASUREMENT. `timedOut` is true only when the
//      call actually spent the time — `error.code === 'ETIMEDOUT'` AND
//      `elapsedMs >= timeoutMs * 0.9`. The 0.9 is slack for the clock, not for
//      a three-order-of-magnitude discrepancy.
//   2. ANYTHING ELSE spawnSync reports is a HARNESS FAULT, named as one.
//      `fault = { code, status, signal, elapsedMs }` and `timedOut: false`, so a
//      caller cannot mistake "the harness did not run this" for "the thing I was
//      measuring failed".
import { spawnSync } from 'node:child_process'

/**
 * The fraction of the cap a run must have actually spent before an ETIMEDOUT is
 * believed. Exported so the tests pin the same number the code uses.
 */
export const TIMEOUT_ELAPSED_FRACTION = 0.9

/**
 * `spawnSync`, with an elapsed-time check over its timeout claim.
 *
 * Returns `{ status, stdout, stderr, elapsedMs, timedOut, fault }`.
 * `timedOut` and `fault` are mutually exclusive, and both are absent-or-false
 * on a clean run, so `if (r.fault)` and `if (r.timedOut)` are both safe reads.
 *
 * `now` is injectable so a test can drive the elapsed measurement without
 * spending the time; `spawn` likewise, so a test can produce the early
 * ETIMEDOUT this module exists for without needing bun's bug to be present.
 */
export function runSync(cmd, args, opts = {}, hooks = {}) {
  const first = attempt(cmd, args, opts, hooks)
  // The stale deadline is not a condition of the machine, it is a condition of
  // the PREVIOUS call: in the reproduction the spawns right behind the killed one
  // run normally. So an ETIMEDOUT that provably did not spend its cap is retried
  // exactly once, immediately, and the retry is the reading. Retrying is safe
  // here and only here — a REAL timeout never reaches this branch, because it is
  // separated by elapsed time, and every other spawn error is reported unretried.
  //
  // Without this the fix only moved the victim. Live C9 attempt 5 refused
  // correctly instead of inventing nine problems — `harness fault: the re-check
  // subprocess did not run (code ETIMEDOUT, status null, signal SIGTERM, after
  // 15 ms)` — but the runner's first spawn after four idle hours was the spawn OF
  // the subprocess, so the triple still went ungraded.
  if (first.fault?.code === 'ETIMEDOUT') {
    const second = attempt(cmd, args, opts, hooks)
    return second.fault?.code === 'ETIMEDOUT' ? second : { ...second, staleDeadlineRetried: true }
  }
  return first
}

function attempt(cmd, args, { cwd, env, timeoutMs, shell } = {}, { spawn = spawnSync, now = () => Date.now() } = {}) {
  const t0 = now()
  const r = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell,
  })
  const elapsedMs = Math.max(0, now() - t0)
  const out = { status: r.status ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', elapsedMs, timedOut: false, fault: null }

  if (!r.error) return out

  const spentIt = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    && elapsedMs >= timeoutMs * TIMEOUT_ELAPSED_FRACTION
  if (r.error.code === 'ETIMEDOUT' && spentIt) {
    out.timedOut = true
    return out
  }
  out.fault = { code: r.error.code ?? null, status: r.status ?? null, signal: r.signal ?? null, elapsedMs }
  return out
}

/** One line naming a fault, for a problem list a person reads. */
export function faultSummary(fault) {
  if (!fault) return ''
  const bits = [`code ${fault.code ?? 'null'}`, `status ${fault.status ?? 'null'}`]
  if (fault.signal) bits.push(`signal ${fault.signal}`)
  bits.push(`after ${fault.elapsedMs} ms`)
  return bits.join(', ')
}
