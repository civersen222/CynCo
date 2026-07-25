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
