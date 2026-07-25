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

describe('buildComponents — taskCompleted (decision D3)', () => {
  it('is 1 when the contract is complete AND a green test run corroborates it', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(1)
  })

  it('is UNKNOWN when the contract claims complete but no test ever ran', () => {
    // The S4_DET regression: agent reported "25/25 passed" with the suite never run.
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('is 0 when the contract has failed assertions', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: false, failed: 2 },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is 0 when the contract is complete but tests are red', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [{ passed: 4, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is unknown with no contract and no observation', () => {
    expect(buildComponents(base()).taskCompleted).toBe('unknown')
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

  it('is 1 (not unknown) when git is unavailable — a gate must not degrade', () => {
    expect(buildComponents(base()).testsUnmodified).toBe(1)
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
