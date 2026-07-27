import { describe, it, expect } from 'vitest'
import { buildComponents } from '../../training/taskOutcome.js'
import type { TaskOutcomeInput } from '../../training/taskOutcome.js'

/**
 * Finding (h), measured on the L3-3.3 run (trajectory task-17656b4b).
 *
 * The engine recorded exactly two test observations across 426 turns:
 *
 *   turn 37 — total=11, failing=10   (its own new tests, an honest TDD red)
 *   turn 39 — total=1,  failing=0    (one test, run alone)
 *
 * assessTestsPass took the ratio of the LAST observation (1/1 = green), found
 * that the FIRST was red, and returned 1 on the "the suite was red and the task
 * fixed it" branch. The two observations are not about the same body of tests.
 * At the moment the reward was written the repository stood at 10 failed / 422
 * passed — and all 10 failures were tests this run had authored.
 *
 * testsPass carries 2.0 of the positive weight, so that single wrong component
 * is most of the 0.56 the run scored for adding one line of product code and
 * hitting the iteration cap.
 *
 * The rule these tests pin: a green run may only certify a suite it actually
 * covered. Scope is not comparable across observations, so the only honest
 * comparison is against the broadest run the task itself made.
 */

function base(overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput {
  return {
    testObservations: [],
    commandObservations: [],
    contract: null,
    git: null,
    trackedModifiedFiles: [],
    baselineDirty: null,
    stuckTurns: 0,
    turns: 10,
    hitIterationLimit: false,
    ...overrides,
  }
}

/** A test file with lines added, so the testsWritten branch is live. */
const WROTE_TESTS = {
  changed: [{ path: 'gilded/tests/test_docket.py', added: 193, deleted: 0, binary: false }],
  dirty: [],
  removed: [],
} as unknown as TaskOutcomeInput['git']

describe('buildComponents — testsPass may not be certified by a narrower run', () => {
  it('does not read a one-test green run as fixing an 11-test red one', () => {
    // The measured incident, exactly.
    const c = buildComponents(base({
      testObservations: [{ passed: 1, total: 11 }, { passed: 1, total: 1 }],
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('does not let a narrow green stand in for the suite when tests were written', () => {
    // The other branch, which returned 1 for the same run on different grounds:
    // 193 lines were added to a test file and something, somewhere, was green.
    const c = buildComponents(base({
      testObservations: [{ passed: 1, total: 11 }, { passed: 1, total: 1 }],
      git: WROTE_TESTS,
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('still credits red to green when the green run is at least as broad', () => {
    // The branch is right, it was only unguarded. A task that saw 11 tests with
    // 10 failing and then saw all 11 pass did fix them.
    const c = buildComponents(base({
      testObservations: [{ passed: 1, total: 11 }, { passed: 11, total: 11 }],
    }))
    expect(c.testsPass).toBe(1)
  })

  it('credits a broad green that follows a narrow red', () => {
    // Narrowness only disqualifies the CERTIFYING run. A single failing test
    // followed by a green full suite is honest evidence of a fix.
    const c = buildComponents(base({
      testObservations: [{ passed: 0, total: 1 }, { passed: 432, total: 432 }],
    }))
    expect(c.testsPass).toBe(1)
  })

  it('reports a measured failure as a failure regardless of scope', () => {
    // Guard: the ratio branch must stay ahead of the scope check. A red run is
    // information the corpus needs and narrowness does not excuse it.
    const c = buildComponents(base({
      testObservations: [{ passed: 432, total: 432 }, { passed: 1, total: 11 }],
    }))
    expect(c.testsPass).toBeCloseTo(1 / 11)
  })

  it('a single green run with no broader run to compare against still counts', () => {
    // Guard, not a gate: it passes at HEAD. The scope rule must not turn every
    // one-observation task into 'unknown' — with nothing broader observed, the
    // broadest run IS the one that happened.
    const c = buildComponents(base({
      testObservations: [{ passed: 432, total: 432 }],
      git: WROTE_TESTS,
    }))
    expect(c.testsPass).toBe(1)
  })
})
