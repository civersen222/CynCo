/**
 * F41: a governance guarantee is only as live as the process serving it.
 *
 * Gilded Wave 9b was served by a daemon started seven hours before F37 sealed
 * the held-out gate. The seal was written, tested, wired and on disk; the
 * process had never loaded it. The mission read and ran its own grading gate
 * four times, the driver graded the result, and every component involved
 * reported success, because each of them was correct about the thing it could
 * see. Nothing compared the running build against the guarantee being relied on.
 *
 * This module is that comparison, and it is deliberately a MEASUREMENT rather
 * than a declaration. A hardcoded `['sealed-gates']` would be a claim, and a
 * claim is exactly what a broken build makes convincingly — see F40, where
 * `checkBashSafety` was called and nothing measured that it was called. So the
 * probe below seals a fabricated path and asks the real guard whether a real
 * command naming it is refused. If the answer is no, the word is not said.
 *
 * The other half of the guarantee is on the driver's side and is about ABSENCE.
 * A build predating F37 cannot fail this probe, because it does not contain it;
 * it simply emits a `session.ready` with no `capabilities` field at all. That
 * absence is the Wave 9b signature, and it must read as UNKNOWN, never as
 * permission. `sealedDispatchRefusal` in scripts/cynco-contract.mjs refuses on
 * absence, and that is the whole reason this field is optional in the protocol
 * rather than required: an old engine has to be able to be silent, so that its
 * silence can be caught.
 */
import { callTouchesSealed, setTaskSealedPaths } from '../tools/sealedPaths.js'
import { isS5EnforcementEnabled } from '../config.js'

/** The engine can hide a held-out gate from the mission it is grading (F37). */
export const CAP_SEALED_GATES = 'sealed-gates'

/**
 * F59: S5 is capped at recommend in this process, so the governor cannot
 * restrict a mission's tools mid-run (F7) and cannot confound its ledger labels.
 *
 * A word for the SAFE state, not for the hazard, and that direction is the whole
 * design. The driver used to learn enforcement was live from the first
 * `s5.decision` frame that carried `enforced: true` — after dispatch, and only
 * if some decision happened to enforce. Naming the hazard here would preserve
 * that hole one level up: an engine too old to say either word would be
 * indistinguishable from a capped one, and silence would read as permission.
 */
export const CAP_S5_ADVISORY = 's5-advisory'

/**
 * A path that cannot collide with a real instrument, and says what it is to
 * anyone who finds it in a log. The probe must never seal a file that exists:
 * `setTaskSealedPaths` reads the parent directory to decide whether to seal it
 * (layer 3), and pointing that at a real gates directory during startup would
 * be a side effect on the very thing this module exists to protect.
 */
const PROBE_PATH = '/__localcode_capability_probe__/capability-probe.gate'

type Wiring = {
  seal: (paths: string[], listDir?: (d: string) => string[]) => void
  probe: (command: string) => boolean
  unseal: () => void
  s5Enforcing: () => boolean
}

const LIVE: Wiring = {
  seal: (paths, listDir) => setTaskSealedPaths(paths, listDir ?? (() => [])),
  probe: (command) => callTouchesSealed('Bash', { command }, '/'),
  unseal: () => setTaskSealedPaths([], () => []),
  // The same predicate `conversationLoop` calls to decide whether to APPLY an S5
  // decision. F42: a limit read in one place and enforced in another is two
  // limits, and the one the operator sets is whichever is not the enforcing one.
  s5Enforcing: () => isS5EnforcementEnabled(),
}

/**
 * What this build can actually enforce, proved one guarantee at a time.
 *
 * Runs at startup, before any task exists, and clears the task-scoped seal on
 * the way out. `conversationLoop` re-registers the seal at the head of every
 * task regardless, so even a leak here could not reach a mission — but a
 * measurement that leaves state behind is a measurement that changed what it
 * measured, and the cost of the `finally` is nothing.
 */
export function governanceCapabilities(wiring: Wiring = LIVE): string[] {
  const caps: string[] = []
  try {
    wiring.seal([PROBE_PATH])
    if (wiring.probe(`cat ${PROBE_PATH}`)) caps.push(CAP_SEALED_GATES)
  } catch (e) {
    // A guarantee that throws while being asked whether it works does not work,
    // and the capability is correctly withheld — but silence here would make an
    // engine that is merely broken indistinguishable from one that is old, and
    // those need different repairs.
    console.log(`[capability] ${CAP_SEALED_GATES} probe threw, not advertised: ${(e as Error)?.message ?? e}`)
  } finally {
    try {
      wiring.unseal()
    } catch (e) {
      console.log(`[capability] could not clear the probe seal: ${(e as Error)?.message ?? e}`)
    }
  }
  // F59. Separate try, because a seal probe that throws must not decide this
  // one: two guarantees sharing a failure path is one guarantee.
  try {
    if (!wiring.s5Enforcing()) caps.push(CAP_S5_ADVISORY)
  } catch (e) {
    console.log(`[capability] ${CAP_S5_ADVISORY} probe threw, not advertised: ${(e as Error)?.message ?? e}`)
  }
  return caps
}
