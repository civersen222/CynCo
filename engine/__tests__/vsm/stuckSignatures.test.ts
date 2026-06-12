import { describe, expect, it } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

// Real incident (2026-06-12 weekly-digest run): tool signatures were
// name-only, so a mission legitimately calling Mfl with DIFFERENT queries
// (standings -> picks -> rosters...) counted as "stuck", climbed to 15, and
// HALTed the loop mid-answer. Stuck means repeating the SAME call, not the
// same tool.

function turn(gov: CyberneticsGovernance, i: number, toolsCalled = 1): void {
  gov.onTurnComplete({
    toolsCalled, thinkingTokens: 10, totalTokens: 200, latencyMs: 500,
    response: `analysis step ${i}: looking at a different aspect each turn`,
  })
}

describe('param-aware stuck signatures', () => {
  it('same tool with varied params is progress, not stuck', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 8; i++) {
      gov.onToolResult('Mfl', true, 100, undefined, { query: `query-${i}` })
      turn(gov, i)
    }
    expect(gov.getStuckCount()).toBe(0)
  })

  it('same tool with identical params still counts as stuck', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 8; i++) {
      gov.onToolResult('Mfl', true, 100, undefined, { query: 'players' })
      turn(gov, i)
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)
  })

  it('callers that omit input (sub-agents) still detect repeated-tool loops', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 8; i++) {
      gov.onToolResult('Read', false, 100)
      turn(gov, i)
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)
  })

  it('getRecentToolNames still returns plain names for C7', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Mfl', true, 100, undefined, { query: 'rosters' })
    gov.onToolResult('WebSearch', true, 100, undefined, { q: 'injury news' })
    expect(gov.getRecentToolNames()).toEqual(['Mfl', 'WebSearch'])
  })
})
