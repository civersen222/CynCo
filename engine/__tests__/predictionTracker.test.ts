import { describe, it, expect } from 'vitest'
import { PredictionTracker, wilsonScore, HYPOTHESES } from '../vsm/predictionTracker.js'

describe('PredictionTracker — redesigned H1-H8', () => {
  it('H1: triggers on stuck >= 5 with tools restricted', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.length).toBe(1)
    expect(t.openPredictions[0].hypothesis).toBe('H1')
  })

  it('H1: does NOT trigger when stuck < 5', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(3, { stuckTurns: 3, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.length).toBe(0)
  })

  it('H2: triggers on nudge injection', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 0, toolsRestricted: false, nudgeInjected: true, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.some(p => p.hypothesis === 'H2')).toBe(true)
  })

  it('H4: triggers on 3+ consecutive reads', () => {
    const t = new PredictionTracker('test')
    t.checkExtendedTriggers(5, { contractCreated: false, consecutiveReadsSameFile: 3, thinkingTokensLastTurn: 0, s4ReflectionRan: false })
    expect(t.openPredictions.some(p => p.hypothesis === 'H4')).toBe(true)
  })

  it('H5: triggers on thinking tokens > 100', () => {
    const t = new PredictionTracker('test')
    t.checkExtendedTriggers(5, { contractCreated: false, consecutiveReadsSameFile: 0, thinkingTokensLastTurn: 150, s4ReflectionRan: false })
    expect(t.openPredictions.some(p => p.hypothesis === 'H5')).toBe(true)
  })

  it('H1 evaluates correctly when Edit follows restriction', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    const report = { status: 'healthy', stuckTurns: 0, toolSuccessRate: 0.9 } as any
    t.evaluateOpen(8, report, ['Read', 'Read', 'Edit'])
    expect(t.completedPredictions.length).toBe(1)
    expect(t.completedPredictions[0].correct).toBe(true)
  })

  it('H1 evaluates false when only Read after restriction', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    const report = { status: 'warning', stuckTurns: 8, toolSuccessRate: 0.5 } as any
    t.evaluateOpen(8, report, ['Read', 'Read', 'Read'])
    expect(t.completedPredictions.length).toBe(1)
    expect(t.completedPredictions[0].correct).toBe(false)
  })

  it('does not duplicate predictions in same window', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    t.checkTriggers(6, { stuckTurns: 6, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.filter(p => p.hypothesis === 'H1').length).toBe(1)
  })

  it('HYPOTHESES has names for all 8', () => {
    expect(Object.keys(HYPOTHESES).length).toBe(8)
    for (const h of Object.values(HYPOTHESES)) {
      expect(h.name.length).toBeGreaterThan(0)
      expect(h.nullBaseline).toBeGreaterThan(0)
      expect(h.evalWindow).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('wilsonScore', () => {
  it('returns CI for 70% with 100 samples', () => {
    const [lo, hi] = wilsonScore(70, 100, 0.05)
    expect(lo).toBeGreaterThan(0.5)
    expect(hi).toBeLessThan(0.85)
  })

  it('returns [0,1] for empty data', () => {
    const [lo, hi] = wilsonScore(0, 0, 0.05)
    expect(lo).toBe(0)
    expect(hi).toBe(1)
  })
})
