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
// Plain .mjs on node:child_process: it runs under Bun (the driver) and under
// vitest (the tests), and it imports the engine's own shellInfo rather than
// carrying a second copy of the shell-dialect rules.

import { getShellInfo, shellPreamble, translateEnvPrefix } from '../engine/tools/shellInfo.js'
import { runSync, runAsync, faultSummary } from './cynco-spawn.mjs'

const OUTPUT_TAIL_CHARS = 2000

/**
 * Phase 7 ruling 3: a FAILED marker check is fed back to the model once, as a
 * driver note, and the mission continues — but only when the clock left can
 * pay for a fix and a second whole-suite check. Under an hour, the first check
 * is the verdict. A spec may lower it (`markerRetryMinS`, through the driver's
 * CYNCO_MARKER_RETRY_MIN_S) — the one-hour smoke does, to reach the retry at all.
 */
export const MARKER_RETRY_MIN_S = 3600
/** How much of the check output the note carries. */
export const MARKER_NOTE_LINES = 40

/**
 * The driver's retry floor from its environment: MARKER_RETRY_MIN_S when
 * CYNCO_MARKER_RETRY_MIN_S is unset, the value when it is a positive integer,
 * and a refusal (`error`) otherwise — a floor nobody can read is not a default.
 */
export function markerRetryMinSFrom(env) {
  const raw = env?.CYNCO_MARKER_RETRY_MIN_S
  if (raw === undefined || raw === '') return { minS: MARKER_RETRY_MIN_S, error: null }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return { minS: null, error: `CYNCO_MARKER_RETRY_MIN_S must be a positive integer of seconds; got ${JSON.stringify(raw)}` }
  return { minS: n, error: null }
}

/**
 * The command the driver's marker verify runs — the first check between
 * turns, the retry, and the final verify — and its cap (Phase 7 final review
 * I1). The check-cmd argument is ALSO the engine's withheld contract assertion,
 * which the model's `ContractAssertPass` runs inside its own turn, so it stays
 * the fast keep-green subset; the marker check (the whole-suite gate, the
 * smoke's fail-once fixture) reaches the driver on its own channel,
 * `CYNCO_MARKER_CHECK` with its cap `CYNCO_MARKER_CHECK_TIMEOUT_MS`, which
 * nothing else reads. Without the channel the check-cmd is the marker check,
 * under `checkTimeoutMs`, as before Phase 7. A channel without a usable cap is
 * refused (`error`) — the caps above are refused the same way.
 *
 * Returns { command, timeoutMs, source: 'env' | 'check-cmd' | null, error }.
 */
export function markerCheckFrom(env, checkCmd, checkTimeoutMs) {
  const command = String(env?.CYNCO_MARKER_CHECK ?? '').trim()
  if (!command) {
    const fallback = String(checkCmd ?? '').trim()
    return { command: fallback || null, timeoutMs: checkTimeoutMs, source: fallback ? 'check-cmd' : null, error: null }
  }
  const raw = env?.CYNCO_MARKER_CHECK_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return { command, timeoutMs: null, source: 'env', error: 'CYNCO_MARKER_CHECK is set but CYNCO_MARKER_CHECK_TIMEOUT_MS is not — the marker check would run under a cap nobody chose' }
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    return { command, timeoutMs: null, source: 'env', error: `CYNCO_MARKER_CHECK_TIMEOUT_MS must be a positive integer of milliseconds; got ${JSON.stringify(raw)}` }
  }
  return { command, timeoutMs: n, source: 'env', error: null }
}

/**
 * F168 (re-review R1-I1): may a FAILED marker check be fed back to the model?
 * Never when the marker check is the check-cmd fallback on a mission that seals
 * instruments: on a hand-dispatched sealed mission the check-cmd IS the sealed
 * gate, and its output must never reach the model (the sealed-instrument rule).
 * Returns the refusal (`verify.noteFailed`) or null. The campaign channel
 * (`source: 'env'`) is the public suite gate, whose output may.
 */
export const SEALED_FEEDBACK_REFUSAL = 'sealed instrument'
export function markerFeedbackRefusal({ source, sealedCount }) {
  return source === 'check-cmd' && sealedCount > 0 ? SEALED_FEEDBACK_REFUSAL : null
}

/**
 * Phase 7 final review M9: how many seconds past the wave clock (`timeoutS`
 * from `startMs`) the wait has run at `nowMs`. The loop's bound is read only
 * at the top of the loop, so a marker check admitted with an hour left can
 * still end past the clock; never negative.
 */
export function verifyOverrunS({ startMs, nowMs, timeoutS }) {
  return Math.max(0, Math.round((nowMs - startMs) / 1000 - timeoutS))
}

/**
 * Retry a marker check? Only a FAIL (`ok === false`) — a null check measured
 * nothing about the delivery, so there is nothing for the model to fix —
 * with no retry spent and at least `minS` of the clock left.
 */
export function shouldRetryMarkerCheck({ ok, remainingS, retries, minS = MARKER_RETRY_MIN_S }) {
  return ok === false && retries === 0 && Number.isFinite(remainingS) && remainingS >= minS
}

/**
 * The lines of a check's output the model may read. Phase 7 review I1/M2:
 * never a line naming the sealed tree (`heldout`) or any path in `redact`
 * (the check's withheld instruments — the suite baseline among them), and
 * never the suite gate's REPAIRED block, whose node ids are baseline members.
 */
export function noteLines(output, redact = []) {
  const hidden = redact.map(p => String(p).replace(/\\/g, '/').toLowerCase()).filter(Boolean)
  const out = []
  let inRepaired = false
  for (const line of String(output ?? '').replace(/\s+$/, '').split(/\r?\n/)) {
    if (/^\s*REPAIRED \d+/.test(line)) { inRepaired = true; continue }
    if (inRepaired && /^\s+\+ /.test(line)) continue
    inRepaired = false
    const n = line.replace(/\\/g, '/').toLowerCase()
    if (n.includes('heldout') || hidden.some(p => n.includes(p))) continue
    out.push(line)
  }
  return out
}

/**
 * The driver note for a FAILED marker check: the prefix, then the last
 * MARKER_NOTE_LINES model-readable lines of the check's output (noteLines).
 * When the driver reset an uncommitted tree so the check graded the commit
 * (F132), the note says so, where the work went and how to bring it back —
 * otherwise the model returns to files that changed under it.
 */
export function markerCheckNote(output, { resetFiles = 0, patchPath = null, redact = [] } = {}) {
  const out = ['[driver] marker check FAILED — fix and re-mark:', ...noteLines(output, redact).slice(-MARKER_NOTE_LINES)]
  if (resetFiles > 0) {
    out.push(`[driver] ${resetFiles} uncommitted tracked file(s) were reset so the check graded your commit; the changes are preserved at ${patchPath}`
      + ` — restore them with: git apply --3way "${patchPath}"`)
  }
  return out.join('\n')
}

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
  const { info, runnable } = checkRunnable(command)
  // Through runSync (scripts/cynco-spawn.mjs), not a bare spawnSync. F155: an
  // impossible ETIMEDOUT is retried once instead of filed as UNMEASURED.
  // F166: the suite gate parses pytest's plain `FAILED ` lines, so the check
  // gets the colourless instrument environment rather than whatever
  // colour-forcing the operator's shell exported.
  const result = runSync(runnable, [], { shell: info.shell, cwd, timeoutMs, retryImpossibleTimeout: true })
  return checkResult(command, result, Date.now() - start, timeoutMs)
}

/**
 * runCheck without blocking the event loop (Phase 7 review C1): the marker
 * check and the final verify run the suite gate for minutes while the driver
 * must keep answering the bridge's keep-alive. Same shell, same environment,
 * same result shape, through runAsync. `env` is laid over the instrument
 * environment — the driver hands each marker check its CYNCO_CHECK_ORDINAL
 * (final review I1), so a fixture can tell the driver's call from any other.
 */
export async function runCheckAsync(command, cwd, timeoutMs, { env } = {}) {
  const start = Date.now()
  const { info, runnable } = checkRunnable(command)
  const result = await runAsync(runnable, [], { shell: info.shell, cwd, timeoutMs, ...(env ? { env } : {}) })
  return checkResult(command, result, Date.now() - start, timeoutMs)
}

function checkRunnable(command) {
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
  return { info, runnable }
}

function checkResult(command, result, durationMs, timeoutMs) {
  const timedOut = result.timedOut
  const spawnFailed = Boolean(result.fault)
  const exitCode = typeof result.status === 'number' ? result.status : null
  const mentionsPytest = /\bpytest\b/.test(String(command ?? ''))
  let harnessFault = null
  if (timedOut) harnessFault = `timed out after ${timeoutMs}ms`
  else if (spawnFailed) harnessFault = `spawn failed: ${faultSummary(result.fault)}`
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
    // The whole output, for the marker-check note's last MARKER_NOTE_LINES
    // lines (a 2000-char tail can hold fewer). Never written to the ledger:
    // the driver builds `verify` field by field.
    output,
  }
}
