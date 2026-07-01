/**
 * C5 wiring tests — runAdvisors orchestrates firing VSM advisors and formats
 * their guidance for injection into the S4 reflection context.
 */

import { describe, expect, it } from 'vitest'
import { runAdvisors, getActiveAdvisors, type SystemState } from '../../agents/advisorRouter.js'

const baseState = (overrides: Partial<SystemState> = {}): SystemState => ({
  turnCount: 1,
  toolsUsedThisTurn: [],
  toolsUsedTotal: [],
  toolFailureRate: 0,
  varietyBalance: 'balanced',
  stuckTurns: 0,
  contextUtilization: 0,
  expertise: 'intermediate',
  lastUserMessage: 'add a feature',
  conversationLength: 1,
  ...overrides,
})

describe('runAdvisors', () => {
  it('S4 fires on the first turn and its guidance tag appears in the output', async () => {
    const fired = getActiveAdvisors(baseState())
    expect(fired.some(a => a.system === 'S4')).toBe(true)

    const out = await runAdvisors(baseState(), async () => 'Domain: coding. Use TDD.')
    expect(out).toContain('Intelligence (S4)')
    expect(out).toContain('Domain: coding')
  })

  it('returns empty string when no advisor fires', async () => {
    // Quiet mid-conversation turn: turnCount not on a 5-boundary, short message,
    // balanced variety, no stuck, low failure — nothing should fire.
    const quiet = baseState({
      turnCount: 3,
      conversationLength: 8,
      lastUserMessage: 'ok',
      expertise: 'advanced',
    })
    expect(getActiveAdvisors(quiet).length).toBe(0)
    expect(await runAdvisors(quiet, async () => 'unused')).toBe('')
  })

  it('skips advisors whose model response is blank', async () => {
    const out = await runAdvisors(baseState(), async () => '   ')
    expect(out).toBe('')
  })
})
