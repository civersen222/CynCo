/**
 * F43: the mechanism that exists so an unverified run cannot report success was
 * erasing the failure it recorded.
 *
 * `resolveUnverified` forces every pending assertion to 'failed' — its whole
 * purpose, contract.ts:182 — and then sets `active = false` so the next task
 * does not inherit it. The reward path recorded the contract only when
 * `isActive()`, so the forced failures went to disk as `contract: null`, which
 * is what a task that never HAD a contract writes. `buildComponents` reads null
 * and answers 'unknown', and 'unknown' leaves the reward denominator while 0
 * does not. So the run that never verified anything scored higher than one that
 * honestly failed: Gilded Wave 9d, 115 turns, one assertion never satisfied,
 * reward 0.927.
 *
 * The two states conflated are the two furthest apart in the labeler: "there
 * was no specification" and "there was one and it was never met".
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ContractState } from '../../tools/contract.js'
import { contractFactsFrom, buildComponents, type TaskOutcomeInput } from '../../training/taskOutcome.js'

function base(overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput {
  return {
    testObservations: [],
    commandObservations: [],
    contract: null,
    git: null,
    trackedModifiedFiles: [],
    baselineDirty: [],
    stuckTurns: 0,
    turns: 10,
    hitIterationLimit: false,
    endedInEngineError: false,
    ...overrides,
  }
}

describe('contractFactsFrom — a resolved contract survives its own deactivation', () => {
  let c: ContractState

  beforeEach(() => {
    c = new ContractState()
  })

  it('reports nothing when the task ran under no contract', () => {
    expect(contractFactsFrom(c.snapshot())).toBeNull()
  })

  it('reports nothing after clear(), which empties the assertions too', () => {
    c.create('t', 'brief', ['Tests pass'], 'harness')
    c.clear()
    expect(contractFactsFrom(c.snapshot())).toBeNull()
  })

  it('keeps the forced failures after resolveUnverified deactivates the contract', () => {
    c.create('mission', 'brief', ['The held-out gate exits 0.'], 'harness')
    const forced = c.resolveUnverified()

    expect(forced).toHaveLength(1)
    expect(c.isActive()).toBe(false)

    const facts = contractFactsFrom(c.snapshot())
    expect(facts).not.toBeNull()
    expect(facts!.failed).toBe(1)
    // Reported as it truly is. The field exists precisely so a consumer can
    // tell a live contract from a resolved one without losing the resolution.
    expect(facts!.active).toBe(false)
    expect(facts!.origin).toBe('harness')
  })

  it('carries the assertions that really passed, alongside the forced ones', () => {
    c.create('mission', 'brief', ['Test file a.py declares at least 3 test cases', 'The held-out gate exits 0.'], 'harness')
    c.assertPass(0, 'a.py: 7 cases')
    c.resolveUnverified()

    const facts = contractFactsFrom(c.snapshot())!
    expect(facts.failed).toBe(1)
    expect(facts.passedAssertions).toEqual(['Test file a.py declares at least 3 test cases'])
    expect(facts.complete).toBe(false)
  })

  it('is what turns a never-verified run into a measured 0 instead of unknown', () => {
    c.create('mission', 'brief', ['The held-out gate exits 0.'], 'harness')
    c.resolveUnverified()

    // The whole cost of the bug, in one line: null was the old value here.
    const measured = buildComponents(base({
      contract: contractFactsFrom(c.snapshot()),
      testObservations: [{ passed: 1111, total: 1111, command: 'python -m pytest -q' }],
    }))
    expect(measured.taskCompleted).toBe(0)

    const erased = buildComponents(base({
      contract: null,
      testObservations: [{ passed: 1111, total: 1111, command: 'python -m pytest -q' }],
    }))
    expect(erased.taskCompleted).toBe('unknown')
  })

  it('still reports a live contract, so the pre-existing path is unchanged', () => {
    c.create('mission', 'brief', ['The held-out gate exits 0.'], 'harness')
    c.assertPass(0, 'exit 0')

    const facts = contractFactsFrom(c.snapshot())!
    expect(facts.active).toBe(true)
    expect(facts.complete).toBe(true)
    expect(facts.failed).toBe(0)
  })
})

/**
 * F40's rule: a function that is called by nothing measures nothing. The seam
 * above is only worth having if the reward path is what calls it, and the
 * reward path is a private method on a class that opens a WebSocket at import
 * time, so the call site is asserted at the source.
 */
describe('the reward path builds its contract facts through that seam', () => {
  const src = readFileSync(join(__dirname, '../../bridge/conversationLoop.ts'), 'utf-8')

  it('calls contractFactsFrom when it assembles the outcome', () => {
    expect(src).toMatch(/contract:\s*contractFactsFrom\(globalContract\.snapshot\(\)\)/)
  })

  it('no longer gates the record on isActive(), which is what dropped the failures', () => {
    expect(src).not.toMatch(/contract:\s*globalContract\.isActive\(\)/)
  })
})
