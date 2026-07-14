// P4.2: vibe BUILD synthesizes the DoD contract from locked D-XX decisions
// (STATE doc Phase 4(a)) — same numbering scheme as writePlanFile.
import { describe, expect, it } from 'vitest'
import { synthesizeDecisionAssertions } from '../../vibe/controller.js'

describe('synthesizeDecisionAssertions (P4.2)', () => {
  it('one assertion per answered decision, D-XX numbered in order', () => {
    const out = synthesizeDecisionAssertions([
      { question: 'Support dark mode?', answer: 'Yes, via CSS vars' },
      { question: 'Persist settings?', answer: 'localStorage' },
    ])
    expect(out).toEqual([
      'D-01 implemented as decided: Support dark mode? → Yes, via CSS vars',
      'D-02 implemented as decided: Persist settings? → localStorage',
    ])
  })

  it('skips unanswered decisions and keeps numbering sequential', () => {
    const out = synthesizeDecisionAssertions([
      { question: 'Q1?', answer: '' },
      { question: 'Q2?', answer: 'A2' },
    ])
    expect(out).toEqual(['D-01 implemented as decided: Q2? → A2'])
  })

  it('no answered decisions → empty (auto-create then covers the build prompt)', () => {
    expect(synthesizeDecisionAssertions([])).toEqual([])
    expect(synthesizeDecisionAssertions([{ question: 'Q?', answer: '' }])).toEqual([])
  })
})
