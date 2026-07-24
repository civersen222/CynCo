/**
 * Phase-aware enforcement nudge text.
 *
 * Real incident: the TDD workflow `write_test` phase restricts allowedTools to
 * authoring tools only (no Bash). The contract tool-floor was introduced to
 * restore Bash and the Contract tools whenever enforcement is active, making the
 * action structurally possible. That fix exposed a semantic contradiction: the
 * model now held Bash plus two opposed instructions — the phase said "write a
 * failing test, do not implement production code," while the nudge said "if tests
 * fail, fix the errors." A failing test is the *desired* state in that phase.
 * Over 115 iterations the model began implementing production code to turn the
 * red test green, violating the phase. This module emits a structurally different
 * nudge in authoring phases so the two instructions no longer conflict.
 */

export function enforcementNudgeText(opts: {
  pending: number
  failed: number
  /** Current workflow phase name, or null when no workflow is active. */
  phaseName: string | null
  /** True when the active phase's allowedTools excludes Bash — an authoring
   *  phase that was never meant to run tests. */
  authoringPhase: boolean
}): string {
  const { pending, failed, phaseName, authoringPhase } = opts

  if (authoringPhase) {
    const phaseLabel = phaseName ? `'${phaseName}'` : 'the current authoring'
    return (
      `[System] You are NOT done. Contract has ${pending} assertions pending, ${failed} failed. ` +
      `You are in the ${phaseLabel} phase, whose instruction is authoritative where it conflicts with this message. ` +
      `Bash has been restored for verification/observation only — do NOT implement production code ahead of the phase. ` +
      `A failing test is the expected result in this phase; do not attempt to make it green here. ` +
      `Mark any assertion you can genuinely confirm complete with ContractAssertPass. ` +
      `Record anything you cannot verify from this phase with ContractAssertFail. ` +
      `Then end your turn so the workflow can advance to the phase that runs tests. ` +
      `Do NOT keep reading files — ACT.`
    )
  }

  const runTests = 'Run the test suite NOW with Bash to verify your changes work. If tests fail, fix the errors.'
  return `[System] You are NOT done. Contract has ${pending} assertions pending, ${failed} failed. ${runTests} Then use ContractAssertPass to mark completed assertions. Do NOT keep reading files — ACT.`
}
