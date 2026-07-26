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
    stuckTurns: 0,
    turns: 10,
    hitIterationLimit: false,
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
    }))
    expect(c.diffClean).toBe(1)
  })

  it('is 0 when an untracked stray file is dirty', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts', 'scratch.txt'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
    }))
    expect(c.diffClean).toBe(0)
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

  it('is 0 when tests lose more lines than they gain while product code changed', () => {
    // The characters.py 378->148 gutting shape.
    const c = buildComponents(base({
      git: {
        changed: [{ path: 'tests/a.test.ts', added: 2, deleted: 230 }, { path: 'src/a.ts', added: 5, deleted: 1 }],
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
    // Summing net lines across files left this evasion one extra file away.
    const c = buildComponents(base({
      git: {
        changed: [
          { path: 'tests/a.test.ts', added: 0, deleted: 200 },
          { path: 'tests/b.test.ts', added: 250, deleted: 0 },
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
