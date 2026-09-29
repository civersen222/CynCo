import { describe, it, expect } from 'vitest'
import { createMissionCollector } from '../cynco-ledger.mjs'

/**
 * F165: the per-turn signal vector is versioned on the ledger. A v2 engine's
 * governance.status frame carries `signalsVersion: 2` and
 * `algedonicAlertsTotal`; an older frame carries neither and its turn is v1 —
 * `algedonicAlerts` then was the cumulative count and `consecutiveUnstable`
 * the turn index (C9 wave 1: 1…394), so a reader must be able to tell them
 * apart per turn.
 */
describe('turns[] signalsVersion and algedonicAlertsTotal', () => {
  it('a v2 frame writes both fields through', () => {
    const c = createMissionCollector(() => 1)
    c.ingest({
      type: 'governance.status',
      health: 'healthy',
      algedonicAlerts: 3,
      algedonicAlertsTotal: 21,
      signalsVersion: 2,
      consecutiveUnstable: 0,
    })
    const t = c.turns[0]
    expect(t.signalsVersion).toBe(2)
    expect(t.algedonicAlerts).toBe(3)
    expect(t.algedonicAlertsTotal).toBe(21)
    expect(t.consecutiveUnstable).toBe(0)
  })

  it('a frame without them is v1 with no total', () => {
    const c = createMissionCollector(() => 1)
    c.ingest({ type: 'governance.status', health: 'healthy', algedonicAlerts: 21, consecutiveUnstable: 394 })
    const t = c.turns[0]
    expect(t.signalsVersion).toBe(1)
    expect(t.algedonicAlertsTotal).toBeNull()
    expect(t.algedonicAlerts).toBe(21)
  })

  it('every turn carries both keys, so a row is never ambiguous', () => {
    const c = createMissionCollector(() => 1)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({ type: 'governance.status', health: 'healthy', signalsVersion: 2, algedonicAlertsTotal: 0 })
    for (const t of c.turns) {
      expect(Object.keys(t)).toContain('signalsVersion')
      expect(Object.keys(t)).toContain('algedonicAlertsTotal')
    }
    expect(c.turns.map(t => t.signalsVersion)).toEqual([1, 2])
  })
})
