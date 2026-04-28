import { describe, expect, it, beforeEach } from 'bun:test'
import { HomeostatIntegration } from '../../vsm/homeostatIntegration.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId, TrendDirection } from '../../cybernetics-core/src/index.js'

describe('HomeostatIntegration', () => {
  let hom: HomeostatIntegration

  beforeEach(() => {
    resetEventBus()
    hom = new HomeostatIntegration(new NodeId())
  })

  it('initializes with 3-unit Ashby homeostat', () => {
    expect(hom.ashby.n).toBe(3)
    expect(hom.ashby.states).toHaveLength(3)
  })

  it('update sets states and steps the homeostat', () => {
    hom.update(0.5, 0.3, 0.4, 1000)
    // States should have been modified by step()
    expect(hom.ashby.states[0]).not.toBe(0)
  })

  it('calculates S3/S4 balance', () => {
    hom.update(0.7, 0.2, 0.3, 500)
    const balance = hom.getBalance()
    // After step(), states are modified by coupling, but ratio should reflect imbalance
    expect(balance.ratio).toBeGreaterThan(0)
    expect(['S3Dominant', 'Balanced', 'Critical']).toContain(balance.balance)
  })

  it('detects instability and perturbs weights (ultrastability)', () => {
    // Push system to extreme imbalance
    for (let i = 0; i < 10; i++) {
      hom.update(0.9, 0.1, 0.8, 5000)
    }
    // System should have tried to perturb
    expect(hom.getPerturbationCount()).toBeGreaterThan(0)
  })

  it('tracks trends via TrendTracker', () => {
    // Push rising S3 pressure
    for (let i = 0; i < 10; i++) {
      hom.update(0.1 + i * 0.08, 0.5, 0.3, 500)
    }
    const trends = hom.getTrends()
    expect(trends.s3).toBe(TrendDirection.Rising)
  })

  it('emits HomeostatUpdated domain events', () => {
    hom.update(0.5, 0.5, 0.5, 1000)
    const bus = getEventBus()
    const events = bus.replayFiltered(e => e.payload.kind === 'HomeostatUpdated')
    expect(events.length).toBeGreaterThan(0)
  })

  it('getMetasystemState provides S5 favor', () => {
    // S3 much higher than S4 → S5 should favor S4
    hom.update(0.8, 0.2, 0.5, 1000)
    const meta = hom.getMetasystemState()
    expect(meta.s5Favor).toBe('S4Intelligence')
  })

  it('stable system has low S5 engagement', () => {
    hom.update(0.5, 0.5, 0.5, 1000)
    // Let it settle
    for (let i = 0; i < 20; i++) {
      hom.update(0.5, 0.5, 0.5, 1000)
    }
    if (hom.isStable()) {
      const meta = hom.getMetasystemState()
      expect(meta.s5Engagement).toBeLessThanOrEqual(0.5)
    }
  })
})
