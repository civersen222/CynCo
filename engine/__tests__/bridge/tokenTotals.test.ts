import { describe, expect, it } from 'bun:test'
import { emptyTokenTotals, addTurnCost } from '../../bridge/tokenTotals.js'
import type { TurnCost } from '../../types.js'

function cost(partial: Partial<TurnCost>): TurnCost {
  return {
    prefillTokens: null,
    cachedTokens: null,
    decodeTokens: null,
    prefillMs: null,
    decodeMs: null,
    wallMs: null,
    slot: null,
    source: 'server-timings',
    ...partial,
  }
}

describe('emptyTokenTotals', () => {
  it('starts every column at zero', () => {
    expect(emptyTokenTotals()).toEqual({
      prefillTokens: 0,
      cachedTokens: 0,
      decodeTokens: 0,
      measuredTurns: 0,
      unmeasuredTurns: 0,
    })
  })
})

describe('addTurnCost', () => {
  it('accumulates fully measured server-timings turns', () => {
    const totals = emptyTokenTotals()
    addTurnCost(totals, cost({ prefillTokens: 1500, cachedTokens: 40000, decodeTokens: 700 }))
    addTurnCost(totals, cost({ prefillTokens: 200, cachedTokens: 41500, decodeTokens: 300 }))
    expect(totals).toEqual({
      prefillTokens: 1700,
      cachedTokens: 81500,
      decodeTokens: 1000,
      measuredTurns: 2,
      unmeasuredTurns: 0,
    })
  })

  it('counts usage-only turns as measured but skips null fields instead of zeroing', () => {
    const totals = emptyTokenTotals()
    // usage-only: decode known, prefill/cache split unknown.
    addTurnCost(totals, cost({ source: 'usage-only', decodeTokens: 450 }))
    expect(totals).toEqual({
      prefillTokens: 0,
      cachedTokens: 0,
      decodeTokens: 450,
      measuredTurns: 1,
      unmeasuredTurns: 0,
    })
  })

  it('counts null cost as unmeasured and touches nothing else', () => {
    const totals = emptyTokenTotals()
    addTurnCost(totals, null)
    expect(totals).toEqual({
      prefillTokens: 0,
      cachedTokens: 0,
      decodeTokens: 0,
      measuredTurns: 0,
      unmeasuredTurns: 1,
    })
  })

  it("counts source 'none' as unmeasured even if fields are present", () => {
    const totals = emptyTokenTotals()
    addTurnCost(totals, cost({ source: 'none', prefillTokens: 999, decodeTokens: 999 }))
    expect(totals).toEqual({
      prefillTokens: 0,
      cachedTokens: 0,
      decodeTokens: 0,
      measuredTurns: 0,
      unmeasuredTurns: 1,
    })
  })

  it('mixes measured and unmeasured turns without cross-contamination', () => {
    const totals = emptyTokenTotals()
    addTurnCost(totals, cost({ prefillTokens: 100, cachedTokens: 50, decodeTokens: 25 }))
    addTurnCost(totals, null)
    addTurnCost(totals, cost({ source: 'usage-only', decodeTokens: 10 }))
    addTurnCost(totals, cost({ source: 'none' }))
    expect(totals).toEqual({
      prefillTokens: 100,
      cachedTokens: 50,
      decodeTokens: 35,
      measuredTurns: 2,
      unmeasuredTurns: 2,
    })
  })
})
