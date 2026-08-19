import { describe, it, expect } from 'vitest'
import { commitPressureNotice, commitPressureDue, COMMIT_PRESSURE_PERIOD } from '../../bridge/commitPressure.js'

describe('commitPressureNotice', () => {
  it('is silent inside the observed normal band', () => {
    // p90 of the call-gap between source edits is 44-69 across four runs, so a
    // quiet stretch of 60 is ordinary work, not a stall.
    expect(commitPressureNotice(59)).toBeNull()
  })

  it('fires at 150 calls with no commit', () => {
    const n = commitPressureNotice(150)
    expect(n).toContain('150')
    expect(n).toContain('commit')
  })

  it('fires once per threshold, not on every call after it', () => {
    expect(commitPressureNotice(151)).toBeNull()
    expect(commitPressureNotice(300)).not.toBeNull()
    expect(commitPressureNotice(301)).toBeNull()
  })

  it('escalates at the second threshold', () => {
    expect(commitPressureNotice(300)).toContain('second time')
  })

  it('keeps firing at every further multiple', () => {
    expect(commitPressureNotice(450)).not.toBeNull()
    expect(commitPressureNotice(600)).not.toBeNull()
  })

  it('says nothing at zero', () => {
    expect(commitPressureNotice(0)).toBeNull()
  })
})

/**
 * The loop consults this signal once per ITERATION, but the counter advances
 * once per TOOL CALL, and this model issues parallel tool batches — 11N ran 1805
 * tool calls across ~900 turns, so the counter typically steps by 2 and
 * sometimes more. Matching on an exact multiple, the way iterationBudget.ts
 * safely can because its iteration index steps by exactly 1, would step over
 * 150 roughly half the time and the notice would silently never fire. That is
 * the failure mode this plan exists to avoid: a signal that reads as "healthy"
 * because it is broken.
 */
describe('commitPressureDue', () => {
  it('reports the threshold just crossed', () => {
    expect(commitPressureDue(150, 0)).toBe(150)
  })

  it('reports a threshold that was stepped over, not skipped', () => {
    // 148 -> 152 in one iteration: 150 was crossed and must still be reported.
    expect(commitPressureDue(152, 0)).toBe(150)
  })

  it('reports nothing below the first threshold', () => {
    expect(commitPressureDue(149, 0)).toBe(0)
    expect(commitPressureDue(0, 0)).toBe(0)
  })

  it('reports nothing for a threshold already notified', () => {
    expect(commitPressureDue(151, 150)).toBe(0)
    expect(commitPressureDue(299, 150)).toBe(0)
  })

  it('reports the next threshold once it is reached', () => {
    expect(commitPressureDue(300, 150)).toBe(300)
    expect(commitPressureDue(305, 150)).toBe(300)
  })

  it('reports the highest crossed threshold when several are jumped at once', () => {
    // Not expected in practice, but the counter must never be able to leave a
    // notice permanently pending.
    expect(commitPressureDue(460, 0)).toBe(450)
  })

  it('always returns a value the notice will speak to', () => {
    for (let calls = 0; calls <= 1000; calls++) {
      const due = commitPressureDue(calls, 0)
      if (due > 0) expect(commitPressureNotice(due)).not.toBeNull()
    }
  })

  it('agrees with the exported period', () => {
    expect(COMMIT_PRESSURE_PERIOD).toBe(150)
    expect(commitPressureDue(COMMIT_PRESSURE_PERIOD, 0)).toBe(COMMIT_PRESSURE_PERIOD)
  })
})
