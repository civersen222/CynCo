import { describe, it, expect } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

// Real incident (2026-06-12 morning-brief replay): the mission prompt contains
// the word "what", the teachback heuristic marked it "confused", and the SAME
// prompt was re-recorded as a user response every internal turn — agreement
// ratio pinned at 0.00, one pain signal per turn, kill switch after 5
// text-only turns. Agreement is a property of dialogue: it needs real,
// distinct user replies before it can punish anyone.

const MISSION_PROMPT =
  'You are running an unattended scheduled mission task. Review what happened ' +
  'and summarize what you found. If nothing is actionable return an empty array.'

describe('agreement divergence pain gating', () => {
  it('one user message repeated across turns never accumulates pain to a halt', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 12; i++) {
      gov.onTurnComplete({
        toolsCalled: 0, thinkingTokens: 50, totalTokens: 200, latencyMs: 500,
        response: 'working on it, attempt ' + i,
        userMessage: MISSION_PROMPT,
      })
    }
    expect(() => gov.checkOrHalt()).not.toThrow()
  })

  it('same user message is recorded as one exchange, not one per turn', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 6; i++) {
      gov.onTurnComplete({
        toolsCalled: 0, thinkingTokens: 50, totalTokens: 200, latencyMs: 500,
        response: 'response ' + i,
        userMessage: MISSION_PROMPT,
      })
    }
    expect(gov.getConversationTheory().getDecidedCount()).toBe(1)
  })

  it('genuine repeated user confusion still trips the kill switch', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 12; i++) {
      gov.onTurnComplete({
        toolsCalled: 0, thinkingTokens: 50, totalTokens: 200, latencyMs: 500,
        response: 'response ' + i,
        userMessage: `no that is wrong, I don't understand attempt ${i}`,
      })
    }
    expect(() => gov.checkOrHalt()).toThrow()
  })
})
