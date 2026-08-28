// Stage 1 of docs/cynco-self-orchestration-spec.md: the S3* audit channel.
//
// GVS5H's finding, transplanted: the manager cannot be trusted to declare
// "done" — only a check that actually ran can close the loop. Here the
// "manager" is the mission itself: F133's 142 broken tests rode a green run
// because "suite green" was prose. The probe is the assertion.
//
// Every function is pure. The driver (untested by policy) only wires them.

/**
 * Fail-closed, same shape as the check-cmd guard (driver:125): a probe with no
 * operator-chosen cap would inherit a default nobody chose, and a probe killed
 * at that cap reports UNMEASURED at the exact moment it was needed.
 * Returns an error string, or null when the configuration is dispatchable.
 */
export function probeConfigError(probeCmd, timeoutEnv) {
  if (!probeCmd) return null
  if (timeoutEnv === undefined) {
    return 'a probe command was given but CYNCO_PROBE_TIMEOUT_MS is unset — set it explicitly, e.g. CYNCO_PROBE_TIMEOUT_MS=600000'
  }
  const n = parseInt(timeoutEnv, 10)
  if (!Number.isFinite(n) || n <= 0 || String(n) !== String(timeoutEnv).trim()) {
    return `CYNCO_PROBE_TIMEOUT_MS must be a positive integer of milliseconds — got "${timeoutEnv}"`
  }
  return null
}

/**
 * Does this turn boundary get a probe? Only a landed mission at a quiescent
 * exit: an unlanded probe would grade the pre-mission repo and file the verdict
 * under this mission's id, and a dead harness (engine_error / engine_gone)
 * cannot be asked to continue whatever the probe finds.
 */
export function shouldProbe({ probeCmd, landed, exitReason }) {
  if (!probeCmd || !landed) return false
  return exitReason === 'engine_closed_the_turn' || exitReason === 'quiet_heuristic'
}

/**
 * The hard override, as a decision with a name. GVS5H multiagent.py line 583:
 * sample tests FAILED overrides the manager's "done". `verified: null`
 * (timeout/spawn-fail) never overrides — a probe that said nothing about the
 * delivery cannot keep the mission alive on its say-so.
 */
export function overrideDecision({ verified, overridesUsed, maxOverrides, socketOpen }) {
  if (verified === true) return { inject: false, why: 'probe PASS — the exit stands' }
  if (verified === null) return { inject: false, why: 'probe UNMEASURED — it said nothing, and nothing overrides nothing' }
  if (!socketOpen) return { inject: false, why: 'probe FAIL but the mission socket is closed — cannot inject, the exit stands' }
  if (overridesUsed >= maxOverrides) return { inject: false, why: `probe FAIL but the override budget is exhausted (${overridesUsed}/${maxOverrides})` }
  return { inject: true, why: `probe FAIL — overriding the exit (${overridesUsed + 1}/${maxOverrides})` }
}

/**
 * The injection text. Verbatim tail, never a paraphrase — the standing
 * brief-authoring rule applies to machine-authored messages too: MISS briefs
 * that quote the gate verbatim turn a 600-turn flail into a 40-turn fix.
 */
export function probeMessage({ sha, exitCode, timedOut, spawnFailed, outputTail }) {
  const status = timedOut ? 'TIMED OUT' : spawnFailed ? 'FAILED TO SPAWN' : `FAILED (exit=${exitCode})`
  return [
    `[PROBE] An automated check just ran against your work at commit ${sha} and ${status}.`,
    'Verbatim output tail:',
    '```',
    outputTail,
    '```',
    'The mission is NOT done. Fix exactly what this output shows, commit the fix, and finish.',
    'Committing your marker does not end the mission while this check fails — it will run again.',
  ].join('\n')
}
