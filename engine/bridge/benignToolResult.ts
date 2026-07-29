/**
 * Distinguish "a test runner reported failing tests" from "a command genuinely
 * errored." Both surface as a non-zero exit (isError=true) from the Bash tool,
 * but only the latter should count toward the per-tool circuit breaker and the
 * algedonic kill switch. A red pytest/jest/go-test run during a normal TDD loop
 * is expected signal, not a tool fault — counting it as "pain" halts the agent
 * mid-development (real incident: S4_DET2 HALTed at 5 consecutive red pytest
 * runs while it was legitimately fixing tests).
 *
 * Conservative by design: a result is benign ONLY when the command invoked a
 * recognized test runner AND the output proves tests actually executed (a
 * pass/fail summary is present) AND there is no hard-error marker (collection
 * failure, usage error, missing command). Broken imports, collection errors,
 * and syntax errors therefore still count — the agent must fix those.
 */

import { parseTestSummary } from './testSummary.js'
import { diagnoseError } from '../tools/errorDiagnosis.js'
import { assertionCheck } from '../tools/contractVerify.js'

/**
 * True when a non-zero Bash result is a test runner reporting failing tests
 * (expected TDD signal) rather than a genuine command/tool failure.
 */
export function isBenignTestFailure(toolName: string, toolInput: unknown, output: string): boolean {
  if (toolName !== 'Bash') return false
  const command = (toolInput as { command?: unknown })?.command
  if (typeof command !== 'string') return false
  return parseTestSummary(command, output ?? '') !== null
}

/** The command a Bash tool call actually ran, or null if there isn't one. */
function bashCommand(toolName: string, toolInput: unknown): string | null {
  if (toolName !== 'Bash') return null
  const command = (toolInput as { command?: unknown })?.command
  return typeof command === 'string' && command.trim().length > 0 ? command : null
}

/**
 * True when a non-zero Bash result is one of the contract's own verification
 * commands reporting that its check does not hold.
 *
 * A harness that runs correctly and answers "no" is doing its job. Counted as a
 * tool fault it is worse than useless: three consecutive red checks trip the
 * per-tool circuit breaker, which tells the agent to "STOP using Bash this way"
 * — i.e. to stop running the gate that decides whether it is finished. Measured
 * on Gilded L4.6: a red `verify_l46*.py <check>` came back as an error result
 * and raised a high-severity governance alert.
 *
 * The contract is what makes this knowable rather than guessed. A
 * `Verification command exits 0: X` assertion names X as the arbiter of the
 * task, so X exiting non-zero is by definition the arbiter's verdict, not a
 * broken tool.
 *
 * Conservative in the same shape as isBenignTestFailure: the exemption holds
 * only when the output carries NO recognized error marker. A harness that could
 * not be found, could not import, or crashed mid-check has not answered
 * anything, and the agent must fix it.
 */
export function isDeclaredVerificationCheck(
  toolName: string,
  toolInput: unknown,
  output: string,
  declaredAssertions: readonly string[],
): boolean {
  const command = bashCommand(toolName, toolInput)
  if (command === null) return false
  const declared = declaredAssertions
    .map(text => assertionCheck(text))
    .filter((check): check is { kind: 'command'; command: string } => check?.kind === 'command')
  // Containment, not equality: the agent legitimately wraps a check in a pipe
  // or a redirect. What must be verbatim is the declared command itself.
  if (!declared.some(({ command: declaredCommand }) => command.includes(declaredCommand))) return false
  return diagnoseError(output ?? '').type === 'unknown'
}
