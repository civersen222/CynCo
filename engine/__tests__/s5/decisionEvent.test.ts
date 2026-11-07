import { describe, it, expect } from 'vitest'
import { s5DecisionEvent } from '../../s5/decisionEvent.js'
import type { S5Decision } from '../../s5/types.js'

/**
 * The `s5.decision` frame the dashboard and the ledger read carries
 * `toolRestriction` and `modelSwitch`. Both emit sites filled them from
 * `decision.toolRestriction` / `decision.modelSwitch`, which `S5Decision` has
 * never had (its fields are `tools` and `model`), so every frame said
 * "tools: none" and the ledger's `toolRestriction` column was always null.
 * Found by the strict type-check (A1). One builder, used by both sites.
 */
const decision = (over: Partial<S5Decision> = {}): S5Decision => ({
  workflow: null, advancePhase: null, model: null, tools: null,
  contextAction: 'none', spawnAgent: null, priority: 'balanced', reasoning: 'r', ...over,
})

describe('s5DecisionEvent', () => {
  it('carries the restriction and the switch the decision actually made', () => {
    const e = s5DecisionEvent(decision({ tools: ['Read', 'Grep'], model: 'fast', ruleIds: ['C7'] }), { enforced: true, authority: 'earned' })
    expect(e.type).toBe('s5.decision')
    expect(e.toolRestriction).toEqual(['Read', 'Grep'])
    expect(e.modelSwitch).toBe('fast')
    expect(e.ruleIds).toEqual(['C7'])
    expect(e.enforced).toBe(true)
    expect(e.authority).toBe('earned')
    expect(typeof e.timestamp).toBe('number')
  })

  it('says null, not undefined, when the decision restricted nothing', () => {
    const e = s5DecisionEvent(decision(), { enforced: false, authority: 'advisory' })
    expect(e.toolRestriction).toBeNull()
    expect(e.modelSwitch).toBeNull()
    expect(e.ruleIds).toEqual([])
    expect('source' in e).toBe(false)
  })

  it('names the stuck re-evaluation as its source when asked', () => {
    const e = s5DecisionEvent(decision(), { enforced: false, authority: 'advisory', source: 'stuck-reeval' })
    expect(e.source).toBe('stuck-reeval')
  })
})
