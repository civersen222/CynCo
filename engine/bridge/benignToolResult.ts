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

const TEST_RUNNER =
  /\b(pytest|py\.test|python[0-9.]*\s+-m\s+(pytest|unittest)|jest|vitest|mocha|go\s+test|cargo\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|rspec|phpunit|ctest|gradle\s+test|mvn\s+test)\b/i

/** Output proves a suite ran and produced pass/fail counts. */
const RAN_WITH_RESULTS = [
  /\b\d+\s+failed\b/i,          // pytest / jest / vitest: "46 failed, 8 passed"
  /\b\d+\s+passed\b/i,
  /test result:\s+(ok|FAILED)\./i, // cargo: "test result: FAILED. 3 passed; 1 failed"
  /^--- FAIL:/m,                // go test
  /^FAIL\b/m,                   // go test package line
]

/**
 * Hard-error markers: the command did NOT cleanly run a test suite. These are
 * genuine faults the agent must resolve, so they must NOT be treated as benign
 * even if a stray pass/fail count appears elsewhere in the output.
 */
const HARD_ERROR =
  /errors? during collection|Interrupted:\s|INTERNALERROR|usage:\s*pytest|unrecognized arguments|no tests ran|command not found|No such file|not recognized as|ENOENT|ModuleNotFoundError:|cannot import name/i

/**
 * True when a non-zero Bash result is a test runner reporting failing tests
 * (expected TDD signal) rather than a genuine command/tool failure.
 */
export function isBenignTestFailure(toolName: string, toolInput: unknown, output: string): boolean {
  if (toolName !== 'Bash') return false
  const command = (toolInput as { command?: unknown })?.command
  if (typeof command !== 'string' || !TEST_RUNNER.test(command)) return false
  const o = output ?? ''
  if (HARD_ERROR.test(o)) return false
  return RAN_WITH_RESULTS.some(re => re.test(o))
}
