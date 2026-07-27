import { describe, it, expect } from 'vitest'
import { buildComponents } from '../../training/taskOutcome.js'
import type { TaskOutcomeInput } from '../../training/taskOutcome.js'

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
    endedInEngineError: false,
    ...overrides,
  }
}

describe('buildComponents — testsPass', () => {
  it('uses the last test observation as the ratio', () => {
    const c = buildComponents(base({
      testObservations: [{ passed: 1, total: 10 }, { passed: 9, total: 10 }],
    }))
    expect(c.testsPass).toBe(0.9)
  })

  it('is unknown when no test runner was observed', () => {
    expect(buildComponents(base()).testsPass).toBe('unknown')
  })
})

describe('buildComponents — a green suite that was already green measures nothing', () => {
  const testsWritten = {
    changed: [{ path: 'gilded/tests/test_grip.py', added: 180, deleted: 0 }],
    removed: [],
    dirty: [],
  }

  it('is UNKNOWN when the suite was green throughout and no test file was touched', () => {
    // The single highest-weighted component (2.0 of a 2.1 denominator) was
    // measuring the repository's health, not the task's outcome. In a repo whose
    // suite is already green, a run that types `pytest` and does nothing else
    // scored the same as one that did the work.
    const c = buildComponents(base({
      testObservations: [{ passed: 392, total: 392 }, { passed: 392, total: 392 }],
      git: { changed: [{ path: 'gilded/grip.py', added: 3, deleted: 1 }], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('is 1 when the suite is green and the task added passing tests', () => {
    const c = buildComponents(base({
      testObservations: [{ passed: 396, total: 396 }],
      git: testsWritten,
    }))
    expect(c.testsPass).toBe(1)
  })

  it('is 1 when the suite started red and ended green', () => {
    // Turning the suite green IS this task's outcome, whether or not it wrote tests.
    const c = buildComponents(base({
      testObservations: [{ passed: 390, total: 396 }, { passed: 396, total: 396 }],
      git: { changed: [{ path: 'gilded/grip.py', added: 3, deleted: 1 }], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe(1)
  })

  it('still reports a measured failure as a failure', () => {
    const c = buildComponents(base({
      testObservations: [{ passed: 9, total: 10 }],
      git: { changed: [], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe(0.9)
  })

  it('is UNKNOWN when the suite is green and there are no git facts to check', () => {
    // Without git we cannot tell whether tests were written, so a green run is
    // not attributable to this task.
    const c = buildComponents(base({ testObservations: [{ passed: 10, total: 10 }] }))
    expect(c.testsPass).toBe('unknown')
  })

  it('does not credit a merely-deleted test file as tests written', () => {
    const c = buildComponents(base({
      testObservations: [{ passed: 10, total: 10 }],
      git: { changed: [{ path: 'tests/test_a.py', added: 0, deleted: 40 }], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe('unknown')
  })

  it('leaves the reward denominator entirely, rather than scoring zero', () => {
    // 'unknown' must not be read as failure. With taskCompleted also unknown the
    // row has no outcome evidence at all and belongs out of the corpus.
    const c = buildComponents(base({
      testObservations: [{ passed: 392, total: 392 }],
      git: { changed: [{ path: 'gilded/grip.py', added: 3, deleted: 1 }], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe('unknown')
    expect(c.taskCompleted).toBe('unknown')
  })
})

describe('buildComponents — taskCompleted (decision D3)', () => {
  it('is 1 when the contract is complete AND a green test run corroborates it', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(1)
  })

  it('is UNKNOWN when the contract claims complete but no test ever ran', () => {
    // The S4_DET regression: agent reported "25/25 passed" with the suite never run.
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('is 0 when the contract has failed assertions', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: false, failed: 2, origin: 'harness' },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is 0 when the contract is complete but tests are red', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 4, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is unknown with no contract and no observation', () => {
    expect(buildComponents(base()).taskCompleted).toBe('unknown')
  })
})

/**
 * An auto-contract is not a specification. It is synthesized from surface
 * features of the user's message — which filenames it names, whether it sounds
 * like an edit — and it can only ever assert file mechanics: X was modified,
 * changes were committed. It cannot encode what was actually asked for.
 *
 * The L2b run is the proof. The brief's central instruction was "For each item:
 * write the test FIRST, run it, confirm it FAILS", and it ended "Do not commit".
 * The auto-contract asserted three files-touched claims and one commit claim.
 * CynCo wrote zero tests, committed three times, and fabricated a file to close
 * a phantom assertion — and scored 0.944, taskCompleted 1, because the contract
 * it was measured against had asked for none of the things the user asked for.
 *
 * The green-test corroboration does not save it: the suite was green before the
 * task began. A contract the engine wrote about itself proves nothing about the
 * task, so 'unknown' is the honest answer. Only a contract someone authored on
 * purpose — a harness brief's check script — is a specification.
 */
describe('buildComponents — an auto-contract cannot certify the task', () => {
  it('is unknown when a complete auto-contract is corroborated by green tests', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0, origin: 'auto' },
      testObservations: [{ passed: 392, total: 392 }],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('is unknown when an auto-contract has failed assertions', () => {
    // Failing a phantom assertion is the honest move. It must not be punished.
    const c = buildComponents(base({
      contract: { active: true, complete: false, failed: 1, origin: 'auto' },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('still scores a harness contract, which someone wrote on purpose', () => {
    expect(buildComponents(base({
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 10, total: 10 }],
    })).taskCompleted).toBe(1)
    expect(buildComponents(base({
      contract: { active: true, complete: false, failed: 2, origin: 'harness' },
      testObservations: [{ passed: 10, total: 10 }],
    })).taskCompleted).toBe(0)
  })
})

describe('buildComponents — a run that ran out of turns did not decide it was done', () => {
  it('scores taskCompleted 0 when the loop ended at the iteration limit', () => {
    const c = buildComponents(base({
      hitIterationLimit: true,
      testObservations: [{ passed: 396, total: 396 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('scores 0 for an auto-contract run that ran out of turns', () => {
    // The auto-contract still cannot certify completion, but exhausting the
    // budget is a measured non-completion that needs no yardstick.
    const c = buildComponents(base({
      hitIterationLimit: true,
      contract: { active: true, complete: false, failed: 3, origin: 'auto' },
      testObservations: [{ passed: 396, total: 396 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('does not overrule an authored contract that was satisfied', () => {
    const c = buildComponents(base({
      hitIterationLimit: true,
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(1)
  })

  it('leaves taskCompleted unknown when the model stopped on its own', () => {
    const c = buildComponents(base({
      hitIterationLimit: false,
      testObservations: [{ passed: 396, total: 396 }],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })
})

/**
 * Finding (m), measured on the L3-3.3b re-run (trajectory task-e952d4d8).
 *
 * That run is the best one this corpus has: the seat now consults the candidate
 * pool instead of re-deriving eligibility, the salary line names the amount that
 * actually moved, 30 of 30 independent harness checks print OK, the suite went
 * 429 -> 432 passed with 0 failed, and the whole thing is one 108-line commit.
 * I verified every one of those numbers by hand afterwards.
 *
 * It scored 0.662, with taskCompleted 0.
 *
 * The reason is that the run did not end. It was killed:
 *
 *   send_error: task id = 8902, error: request (67733 tokens) exceeds the
 *   available context size (65536 tokens), try increasing it
 *   [loop] ERROR: llama-server HTTP 400 ... exceed_context_size_error
 *
 * The model was partway through calling ContractAssertPass on 34 assertions when
 * the engine handed llama-server a request two thousand tokens too big for the
 * context it had opened. So the contract was still 'active and not complete',
 * and the branch above reads that as 0 — the assigned job not done.
 *
 * "Unmet" is doing two different jobs in that branch. An assertion the model had
 * every chance to satisfy and did not is a measurement OF THE MODEL. An assertion
 * left unresolved because the harness cut the run off mid-sentence is a
 * measurement of the harness, and scoring the model 0 for it is the same
 * fabrication as findings (f), (i), (k) and (l): a plausible default standing in
 * for a reading nobody took.
 *
 * The honest label is 'unknown' — and unknown leaves the denominator, which is
 * this module's whole thesis. Not degenerate: a crashed run is not an
 * information-free run, and every other component here (testsPass, diffClean,
 * testsUnmodified, stuckTurns) was really measured and really earned.
 */
describe('buildComponents — a run the engine killed is not a run the model failed', () => {
  it('leaves taskCompleted unknown when an engine error ended the run mid-contract', () => {
    const c = buildComponents(base({
      endedInEngineError: true,
      contract: { active: true, complete: false, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 432, total: 432 }],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('still scores 0 when the model simply left assertions unmet', () => {
    // The guard must not become a blanket amnesty. With no engine error, an
    // unsatisfied authored contract is exactly the measurement it always was.
    const c = buildComponents(base({
      endedInEngineError: false,
      contract: { active: true, complete: false, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 432, total: 432 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('still scores 0 for assertions the model recorded as failed', () => {
    // A ContractAssertFail is the model's own reading of its own work. The crash
    // does not un-fail it, and it is not the crash's to excuse.
    const c = buildComponents(base({
      endedInEngineError: true,
      contract: { active: true, complete: false, failed: 3, origin: 'harness' },
      testObservations: [{ passed: 432, total: 432 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('does not overrule a contract that was satisfied before the crash', () => {
    const c = buildComponents(base({
      endedInEngineError: true,
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
      testObservations: [{ passed: 432, total: 432 }],
    }))
    expect(c.taskCompleted).toBe(1)
  })

  it('does not let a crash be read as running out of turns', () => {
    // hitIterationLimit is a measurement of the model — it had its whole budget
    // and spent it. An engine error is not, so the iteration-limit fallback must
    // not fill in a 0 on its behalf.
    const c = buildComponents(base({
      endedInEngineError: true,
      hitIterationLimit: true,
      contract: null,
      testObservations: [{ passed: 432, total: 432 }],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('changes nothing except taskCompleted', () => {
    // The point of 'unknown' over exclusion: this trajectory still teaches
    // something, so the guard must be surgical. Comparing the two runs
    // component-by-component states that precisely, and catches a fix that
    // reached for the whole component set when only one reading was in doubt.
    const shared = {
      contract: { active: true, complete: false, failed: 0, origin: 'harness' as const },
      testObservations: [{ passed: 432, total: 432 }],
      stuckTurns: 2,
      turns: 79,
    }
    const crashed = buildComponents(base({ ...shared, endedInEngineError: true }))
    const clean = buildComponents(base({ ...shared, endedInEngineError: false }))

    expect(crashed.taskCompleted).toBe('unknown')
    expect(clean.taskCompleted).toBe(0)
    expect({ ...crashed, taskCompleted: null }).toEqual({ ...clean, taskCompleted: null })
  })
})

describe('buildComponents — typecheck and build', () => {
  it('are unknown when no such command ran', () => {
    const c = buildComponents(base())
    expect(c.typecheckPass).toBe('unknown')
    expect(c.buildPass).toBe('unknown')
  })

  it('reflect the observed exit status', () => {
    const c = buildComponents(base({
      commandObservations: [{ kind: 'typecheck', ok: true }, { kind: 'build', ok: false }],
    }))
    expect(c.typecheckPass).toBe(1)
    expect(c.buildPass).toBe(0)
  })
})

describe('buildComponents — diffClean', () => {
  it('is unknown without git', () => {
    expect(buildComponents(base()).diffClean).toBe('unknown')
  })

  it('is 1 when every dirty path was tracked as agent-modified', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
      baselineDirty: [],
    }))
    expect(c.diffClean).toBe(1)
  })

  it('is 0 when an untracked stray file is dirty', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts', 'scratch.txt'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
      baselineDirty: [],
    }))
    expect(c.diffClean).toBe(0)
  })

  // The live case this was written for: a run added one file, committed it, and
  // left nothing behind, but scored 0 because three unrelated untracked files had
  // been sitting in the tree for days.
  it('is 1 when the only stray files were already dirty before the task', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts', 'PLAN.md', 'notes.txt'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
      baselineDirty: ['PLAN.md', 'notes.txt'],
    }))
    expect(c.diffClean).toBe(1)
  })

  it('still charges for a stray the task itself introduced', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['PLAN.md', 'scratch.txt'] },
      trackedModifiedFiles: [],
      baselineDirty: ['PLAN.md'],
    }))
    expect(c.diffClean).toBe(0)
  })

  it('is unknown when the starting state was never measured', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['scratch.txt'] },
      trackedModifiedFiles: [],
      baselineDirty: null,
    }))
    expect(c.diffClean).toBe('unknown')
  })

  // `undefined` rather than null — what a plain-JS caller or an object rehydrated
  // from JSON without the field actually supplies. Left untreated it passes a
  // `!== null` guard and then behaves as an EMPTY baseline, asserting the tree
  // started clean without having looked.
  it('is unknown when the baseline is undefined rather than null', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['scratch.txt'] },
      trackedModifiedFiles: [],
      baselineDirty: undefined as unknown as null,
    }))
    expect(c.diffClean).toBe('unknown')
  })
})

describe('buildComponents — testsUnmodified safety gate', () => {
  it('is 1 when only tests were ADDED (legitimate TDD)', () => {
    const c = buildComponents(base({
      git: {
        changed: [{ path: 'tests/a.test.ts', added: 40, deleted: 0 }, { path: 'src/a.ts', added: 10, deleted: 2 }],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 0 when a test file is deleted outright', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: ['tests/a.test.ts'], dirty: [] },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 0 when a gutting takes test cases with it', () => {
    // The characters.py 378->148 shape, with the measurement that makes it a
    // gutting rather than a tidy-up: four named cases can no longer fail.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 2, deleted: 230, assertions: -40, casesLost: 4 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 1 when tests shrink but no product code changed (a pure test refactor)', () => {
    const c = buildComponents(base({
      git: { changed: [{ path: 'tests/a.test.ts', added: 2, deleted: 30 }], removed: [], dirty: [] },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 0 when one suite is gutted and another is padded to offset it', () => {
    // Judged per file. A summed net would leave this evasion one extra file away.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 0, deleted: 200, assertions: -30, casesLost: 6 },
          { path: 'tests/b.test.ts', added: 250, deleted: 0, assertions: 30, casesLost: 0 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('ignores binary test fixtures, whose line counts git cannot report', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/fixture.test.ts', added: 0, deleted: 0, binary: true },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is unknown when git is unavailable — the gate could not look', () => {
    // Previously 1: the only anti-reward-hacking check in the pipeline reported
    // "the agent did not weaken the tests" about a diff nobody read. diffClean,
    // thirty lines below, already degrades to 'unknown' on the identical input.
    expect(buildComponents(base()).testsUnmodified).toBe('unknown')
  })

  it('degrades to unknown on exactly the same input that makes diffClean unknown', () => {
    const c = buildComponents(base())
    expect(c.diffClean).toBe('unknown')
    expect(c.testsUnmodified).toBe('unknown')
  })

  it('is a measured 1 when git IS available and nothing weakened the tests', () => {
    const c = buildComponents(base({
      git: { changed: [{ path: 'src/a.ts', added: 10, deleted: 2 }], removed: [], dirty: [] },
    }))
    expect(c.testsUnmodified).toBe(1)
  })
})

/**
 * The gate counted LINES, and inferred from "this test file got shorter while
 * product code changed" that the tests had been weakened. Deleting dead code
 * from a test is not weakening it.
 *
 * Watched live on L2e: the brief's own Task 2 was "delete the abandoned first
 * half of this test". CynCo did exactly that — 114 lines to 50, both real
 * assertions kept, suite green at 397 passed, all five authored contract
 * assertions verified by real commands, taskCompleted a measured 1 — and the
 * line-count gate vetoed the whole run to **-1.0**. The corpus's first negative
 * was a false one, earned by following instructions.
 *
 * That is the worse failure direction here. A false positive inflates a mean; a
 * false negative of exactly this shape teaches the model not to touch tests,
 * which is the opposite of the behaviour the whole exercise is trying to build.
 *
 * So measure the thing actually feared: lines that CHECK something. Losing
 * assertions is weakening. Losing comments, dead fixtures and unused imports is
 * housekeeping.
 */
describe('buildComponents — the gate counts assertions, not lines', () => {
  it('is 1 when a test shrinks but keeps every assertion (the L2e shape)', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'gilded/tests/test_chassis.py', added: 12, deleted: 76, assertions: 0 },
          { path: 'gilded/society/realm.py', added: 8, deleted: 11 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 0 when a test loses its checks even while the file GROWS', () => {
    // The evasion a line count cannot see: pad with comments, delete the checks.
    // Three cases are left declared with nothing in them that can fail.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 120, deleted: 4, assertions: -3, casesLost: 3 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 0 when a skip marker is introduced', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 3, deleted: 1, assertions: 0, skips: 1 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 1 when assertions are rewritten one-for-one', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 9, deleted: 9, assertions: 0 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 1 when a deleted file under tests/ held no assertions (a debug scaffold)', () => {
    // gilded/tests/debug_grip.py, which a review asked to be deleted.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'gilded/tests/debug_grip.py', added: 0, deleted: 41, assertions: 0 },
          { path: 'gilded/grip.py', added: 2, deleted: 50 },
        ],
        removed: ['gilded/tests/debug_grip.py'], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 0 when a deleted test file did hold real test cases', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 0, deleted: 60, assertions: -14, casesLost: 5 },
          { path: 'src/a.ts', added: 2, deleted: 1 },
        ],
        removed: ['tests/a.test.ts'], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('declines to veto on net line loss alone — that was never the measurement', () => {
    // No per-file diff was available, so nothing here distinguishes a gutting
    // from a tidy-up. A -1.0 on that basis is the L2e/L2f false negative, and
    // it fired twice on real runs that had done exactly as they were told.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 2, deleted: 230 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe('unknown')
  })

  it('declines to veto when assertions fell but every named case survived', () => {
    // The real L2f measurement: assertions -3, cases 19 -> 19. The half the brief
    // ordered deleted was a copy-pasted duplicate of the half that stayed.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'gilded/tests/test_chassis.py', added: 24, deleted: 88, assertions: -3, casesLost: 0 },
          { path: 'gilded/society/realm.py', added: 7, deleted: 10 },
        ],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe('unknown')
  })
})

describe('buildComponents — an authored spec outranks the unverified suspicion', () => {
  // A brief may legitimately order a test removed — "delete the obsolete
  // test_legacy_grip case". That is a measured coverage loss, so the suspicion is
  // real, and only a person's specification can say it was asked for. The
  // deciding questions are who wrote the contract and whether their own commands
  // confirmed it.
  const caseDeleted = {
    changed: [
      { path: 'gilded/tests/test_chassis.py', added: 4, deleted: 40, assertions: -6, casesLost: 1 },
      { path: 'gilded/society/realm.py', added: 7, deleted: 10 },
    ],
    removed: [], dirty: [],
  }

  it('withholds the veto as unknown when a harness contract closed with no failures', () => {
    const c = buildComponents(base({
      git: caseDeleted,
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
    }))
    expect(c.testsUnmodified).toBe('unknown')
  })

  it('does not grant credit either — unknown is not 1', () => {
    const withSpec = buildComponents(base({
      git: caseDeleted,
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
    }))
    const clean = buildComponents(base({
      git: { changed: [{ path: 'src/a.ts', added: 3, deleted: 1 }], removed: [], dirty: [] },
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
    }))
    expect(withSpec.testsUnmodified).not.toBe(clean.testsUnmodified)
    expect(clean.testsUnmodified).toBe(1)
  })

  it('still vetoes when the contract was synthesized by the engine', () => {
    // An auto-contract asserts file mechanics, so satisfying it says nothing
    // about whether the deletion was asked for.
    const c = buildComponents(base({
      git: caseDeleted,
      contract: { active: true, complete: true, failed: 0, origin: 'auto' },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('still vetoes when an authored assertion failed', () => {
    const c = buildComponents(base({
      git: caseDeleted,
      contract: { active: true, complete: false, failed: 1, origin: 'harness' },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('does not need a contract when every named case survived', () => {
    // The override only ever covers a MEASURED loss. Where the assertion count
    // fell and no case can be shown to have gone, the answer is unknown on the
    // facts, and it does not matter who wrote the contract — which is what makes
    // the honest label independent of my dispatch tooling. L2f scored -1.0
    // because the cockpit lost the contract in a two-file write race; nothing
    // about the work changed, only whether a harness had spoken.
    const noContract = buildComponents(base({
      git: {
        changed: [
          { path: 'gilded/tests/test_chassis.py', added: 24, deleted: 88, assertions: -3, casesLost: 0 },
          { path: 'gilded/society/realm.py', added: 7, deleted: 10 },
        ],
        removed: [], dirty: [],
      },
      contract: { active: true, complete: true, failed: 0, origin: 'auto' },
    }))
    expect(noContract.testsUnmodified).toBe('unknown')
  })

  it('still vetoes a skip marker under a satisfied authored contract', () => {
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 3, deleted: 0, assertions: 0, skips: 1 },
          { path: 'src/a.ts', added: 5, deleted: 1 },
        ],
        removed: [], dirty: [],
      },
      contract: { active: true, complete: true, failed: 0, origin: 'harness' },
    }))
    expect(c.testsUnmodified).toBe(0)
  })
})

describe('buildComponents — testsPass clamping', () => {
  it('clamps a nonsense ratio above 1 rather than inflating the reward', () => {
    // git facts showing a written test are what make a green result attributable
    // to this task at all; without them the component is 'unknown' and the clamp
    // is never reached.
    const c = buildComponents(base({
      testObservations: [{ passed: 15, total: 10 }],
      git: { changed: [{ path: 'tests/test_a.py', added: 12, deleted: 0 }], removed: [], dirty: [] },
    }))
    expect(c.testsPass).toBe(1)
  })
})

describe('buildComponents — telemetry passthrough', () => {
  it('carries stuckTurns and derives iterFraction from turns/500', () => {
    const c = buildComponents(base({ stuckTurns: 4, turns: 250 }))
    expect(c.stuckTurns).toBe(4)
    expect(c.iterFraction).toBe(0.5)
    expect(c.userSatisfaction).toBe(0)
  })
})
