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

/** A test file with named cases that did not exist before, so the testsWritten
 * branch is live. Lines alone do not light it — see finding (q). */
const WROTE_TESTS = {
  changed: [{ path: 'gilded/tests/test_docket.py', added: 193, deleted: 0, binary: false, casesAdded: 14 }],
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

/**
 * Finding (cc), measured on two persisted reward records.
 *
 *   task-df75bf1b  ended 552/552 green, widest total observed 562  -> 'unknown'
 *   task-aac2741c  ended 576/576 green, widest total observed 577  -> 'unknown'
 *                  and so scored 0.9192 where the components say ~0.99
 *
 * Neither run narrowed its scope. Both ran the full suite at the end and the
 * full suite at the start; what moved was how many cases the same command
 * collected, because the task itself was adding and reorganising tests. A total
 * is a property of the run, not of the suite, and finding (h)'s guard was built
 * to compare scopes with nothing but totals to compare them by.
 *
 * The rule these tests pin: scope is compared by what was RUN. Two observations
 * from the same command cover the same body of tests however many cases each
 * happened to collect, and the later one is the authoritative verdict.
 */
const SUITE = 'python -m pytest gilded/tests -q'
const ONE = 'python -m pytest gilded/tests/test_docket.py::test_one -q'

describe('buildComponents — scope is what ran, not how much it collected', () => {
  it('credits a final full-suite green that collected fewer cases than an earlier run of the same command', () => {
    // task-df75bf1b, exactly: 562 collected early, 552 collected at the end.
    const c = buildComponents(base({
      testObservations: [
        { passed: 107, total: 110, command: 'python -m pytest gilded/tests/test_ui_broadsheet.py -q' },
        { passed: 555, total: 562, command: SUITE },
        { passed: 552, total: 552, command: SUITE },
      ],
    }))
    expect(c.testsPass).toBe(1)
  })

  it('still refuses a narrow green run from a DIFFERENT command', () => {
    // Finding (h) intact: the two runs are not about the same body of tests, and
    // now that is said by the commands rather than inferred from the totals.
    const c = buildComponents(base({
      testObservations: [
        { passed: 1, total: 11, command: 'python -m pytest gilded/tests/test_docket.py -q' },
        { passed: 1, total: 1, command: ONE },
      ],
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('falls back to comparing totals when the commands were not recorded', () => {
    // Records written before the command was carried, and any path that cannot
    // supply one. Unchanged behaviour is the right default: the fix may only
    // ever add information, never remove the guard.
    const c = buildComponents(base({
      testObservations: [{ passed: 555, total: 562 }, { passed: 552, total: 552 }],
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('does not let a recorded command excuse a genuinely narrower run', () => {
    // The last run names a different command AND is narrower. Both signals agree.
    const c = buildComponents(base({
      testObservations: [
        { passed: 550, total: 562, command: SUITE },
        { passed: 1, total: 1, command: ONE },
      ],
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('ignores surrounding whitespace when deciding two runs are the same command', () => {
    const c = buildComponents(base({
      testObservations: [
        { passed: 555, total: 562, command: `  ${SUITE}  ` },
        { passed: 552, total: 552, command: SUITE },
      ],
    }))
    expect(c.testsPass).toBe(1)
  })
})
