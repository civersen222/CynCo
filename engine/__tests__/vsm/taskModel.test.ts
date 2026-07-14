// P4.1: taskError = unmet-assertion fraction from the global contract,
// computed by the governor (never a model self-estimate — VI.3 rule (a));
// errorTrend = CUSUM alarm state over the series. Null when no contract:
// absence of a contract is not zero error.
import { describe, expect, it } from 'vitest'
import { TaskModel } from '../../vsm/taskModel.js'
import type { ContractSnapshot } from '../../tools/contract.js'

function snap(statuses: ('pending' | 'passed' | 'failed' | 'skipped')[], active = true): ContractSnapshot {
  return {
    title: 't',
    brief: 'b',
    active,
    complete: statuses.length > 0 && statuses.every(s => s === 'passed' || s === 'skipped'),
    assertions: statuses.map((status, i) => ({ text: `a${i}`, status })),
  }
}

describe('TaskModel (P4.1)', () => {
  it('no active contract → taskError and errorTrend are null', () => {
    const tm = new TaskModel(() => snap([], false))
    tm.onTurnComplete()
    expect(tm.snapshot()).toEqual({ taskError: null, errorTrend: null })
  })

  it('unmet fraction: pending and failed are unmet; passed is met', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['pending', 'pending', 'failed', 'passed']
    const tm = new TaskModel(() => snap(statuses))
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0.75)
    statuses = ['passed', 'passed', 'failed', 'passed']
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0.25)
    statuses = ['passed', 'passed', 'passed', 'passed']
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0)
  })

  it('skipped assertions leave the denominator; all-skipped → null', () => {
    const tm = new TaskModel(() => snap(['skipped', 'pending']))
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(1) // 1 unmet of 1 countable
    const allSkipped = new TaskModel(() => snap(['skipped', 'skipped']))
    allSkipped.onTurnComplete()
    expect(allSkipped.snapshot().taskError).toBeNull()
  })

  it('sustained error jump drives errorTrend to rising', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['passed', 'passed']
    const tm = new TaskModel(() => snap(statuses))
    for (let i = 0; i < 3; i++) tm.onTurnComplete() // baseline settles at 0
    expect(tm.snapshot().errorTrend).toBe('flat')
    statuses = ['failed', 'failed'] // error jumps 0 → 1; deviation ~1 > threshold
    tm.onTurnComplete()
    expect(tm.snapshot().errorTrend).toBe('rising')
  })

  it('sustained error drop drives errorTrend to falling', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['pending', 'pending']
    const tm = new TaskModel(() => snap(statuses))
    for (let i = 0; i < 3; i++) tm.onTurnComplete() // baseline settles at 1
    expect(tm.snapshot().errorTrend).toBe('flat')
    statuses = ['passed', 'passed'] // error drops 1 → 0
    tm.onTurnComplete()
    expect(tm.snapshot().errorTrend).toBe('falling')
  })

  it('contractless turns do not feed the CUSUM and later turns resume cleanly', () => {
    let current: ContractSnapshot = snap([], false)
    const tm = new TaskModel(() => current)
    tm.onTurnComplete()
    tm.onTurnComplete()
    expect(tm.snapshot()).toEqual({ taskError: null, errorTrend: null })
    current = snap(['pending'])
    tm.onTurnComplete() // first observation seeds the EMA — deviation 0, no alarm
    expect(tm.snapshot()).toEqual({ taskError: 1, errorTrend: 'flat' })
  })
})
