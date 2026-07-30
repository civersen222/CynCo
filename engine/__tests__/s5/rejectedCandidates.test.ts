/**
 * Rejected rule candidates: the negative examples the rule engine throws away.
 *
 * Every turn, several rules fire and `combineDecisions` merges them. The merge is
 * lossy by design — `model` takes the first non-null, `priority` the first
 * non-balanced, `tools` intersects — and until now the losers vanished inside the
 * loop. A corpus built from winners alone can only teach a model to imitate the
 * rule engine; it has nothing to discriminate against. The losers are the close
 * calls, and they are the only negatives available.
 *
 * A rule returning `null` is NOT a rejected candidate. Its condition was false —
 * it made no proposal, so there is nothing to have overridden.
 */
import { describe, expect, it } from 'bun:test'
import { combineDecisions, RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Decision, S5Input } from '../../s5/types.js'

const P = (d: Partial<S5Decision>) => d

describe('combineDecisions records fired-and-overridden proposals', () => {
  it('records the losing model proposal and names the winner', () => {
    const out = combineDecisions([P({ model: 'fast' }), P({ model: 'big' })], ['W2', 'W9'])
    expect(out.model).toBe('fast')
    expect(out.rejected).toEqual([
      { ruleId: 'W9', field: 'model', proposed: 'big', applied: 'fast', wonBy: 'W2' },
    ])
  })

  it('records the losing priority proposal', () => {
    const out = combineDecisions([P({ priority: 's3' }), P({ priority: 's4' })], ['C1', 'W4'])
    expect(out.priority).toBe('s3')
    expect(out.rejected).toEqual([
      { ruleId: 'W4', field: 'priority', proposed: 's4', applied: 's3', wonBy: 'C1' },
    ])
  })

  it('records the weaker contextAction, not the stronger one that was applied', () => {
    const out = combineDecisions([P({ contextAction: 'warn' }), P({ contextAction: 'compact' })], ['W5', 'C3'])
    expect(out.contextAction).toBe('compact')
    expect(out.rejected).toEqual([
      { ruleId: 'W5', field: 'contextAction', proposed: 'warn', applied: 'compact', wonBy: 'C3' },
    ])
  })

  it('leaves wonBy null when the intersection is narrower than any proposal', () => {
    const out = combineDecisions([P({ tools: ['Read', 'Edit'] }), P({ tools: ['Read', 'Bash'] })], ['C2', 'C4'])
    expect(out.tools).toEqual(['Read'])
    // Both rules lost: neither asked for ['Read'] alone. Naming a winner here
    // would be a fabrication — the applied value came from the merge policy, not
    // from any rule.
    expect(out.rejected).toHaveLength(2)
    expect(out.rejected!.every(r => r.wonBy === null)).toBe(true)
    expect(out.rejected!.map(r => r.ruleId).sort()).toEqual(['C2', 'C4'])
  })

  it('records one rule losing on one field while winning on another', () => {
    const out = combineDecisions(
      [P({ model: 'fast', priority: 's4' }), P({ model: 'big', priority: 's3' })],
      ['A', 'B'],
    )
    // A wins both (first non-null model, first non-balanced priority), so only B
    // appears — twice, once per contested field. Attribution is per (rule, field)
    // precisely because a rule can split.
    expect(out.rejected).toHaveLength(2)
    expect(out.rejected!.map(r => `${r.ruleId}.${r.field}`).sort()).toEqual(['B.model', 'B.priority'])
  })

  it('does not flag surfaceTools, which unions and so overrides nothing', () => {
    const out = combineDecisions(
      [P({ surfaceTools: ['Read'] }), P({ surfaceTools: ['Bash'] })],
      ['P1', 'P2'],
    )
    expect(out.surfaceTools).toEqual(['Read', 'Bash'])
    expect(out.rejected).toEqual([])
  })

  it('does not flag agreement', () => {
    const out = combineDecisions([P({ priority: 's3' }), P({ priority: 's3' })], ['X', 'Y'])
    expect(out.rejected).toEqual([])
  })

  it('omits the field entirely when no rule ids are supplied', () => {
    // Without ids a rejection cannot be attributed, so the scan is skipped and the
    // result is byte-identical to the pre-existing behaviour.
    const out = combineDecisions([P({ model: 'fast' }), P({ model: 'big' })])
    expect(out.rejected).toBeUndefined()
  })
})

function makeInput(over: Partial<S5Input> = {}): S5Input {
  return {
    userMessage: '', activeWorkflow: null, currentPhase: null, contextUsagePercent: 0.1,
    governanceStatus: 'healthy', s3s4Balance: 'balanced', modelLatencyTrend: 'stable',
    availableModels: ['primary'], turnCount: 1, recentToolResults: [],
    varietyBalance: 'balanced', varietyRatio: 1.0, homeostatStable: true,
    homeostatConsecutiveUnstable: 0, driftDetected: false, driftDirection: null,
    performanceHealth: 'healthy', productivityRatio: 0.8, recommendedToolMode: null,
    heterarchyAuthority: null, agreementRatio: 1.0, observerDivergence: null,
    demotedTools: [], promptDifficulty: 'unknown', taskError: null, errorTrend: null,
    fingerprintAlarm: null, infoGain: null, progressRate: null, explorationState: null,
    ...over,
  } as S5Input
}

describe('RuleBasedS5 carries the record through to the decision', () => {
  it('a quiet turn has an empty rejected list, not a missing one', async () => {
    const d = await new RuleBasedS5().decide(makeInput())
    // Present-and-empty, so the journal schema is stable and a reader never has
    // to guess whether absence means "no losers" or "an older engine wrote this".
    expect(d.rejected).toEqual([])
  })
})
