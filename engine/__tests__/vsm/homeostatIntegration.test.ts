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

  it('update sets states to deviations from each pressure\'s running level (F165)', () => {
    hom.update(0.5, 0.3, 0.4, 1000)
    // Turn 1 has no running level: the observation is its own set point.
    expect(hom.ashby.states.every(s => Math.abs(s) < 1e-9)).toBe(true)
    hom.update(0.9, 0.3, 0.4, 1000)
    // S3 is 0.4 above its running level (0.5), twice the 0.2 band; step()
    // moved it a little toward the origin.
    expect(hom.ashby.states[0]).toBeGreaterThan(0.35)
    expect(hom.ashby.states[0]).toBeLessThan(0.4)
    expect(hom.isStable()).toBe(false)
  })

  it('a steady mission-level stream reads stable; the pre-F165 model never could (F165)', () => {
    // S3 at its 0.1 floor, S4 0.5, context 0.3: levels a mission holds for
    // turns on end. Before F165 the units held these levels and the only
    // equilibrium was the origin, so this read unstable forever.
    for (let i = 0; i < 5; i++) hom.update(0.1, 0.5, 0.3, 1000)
    expect(hom.isStable()).toBe(true)
  })

  it('calculates S3/S4 balance', () => {
    hom.update(0.7, 0.2, 0.3, 500)
    const balance = hom.getBalance()
    // After step(), states are modified by coupling, but ratio should reflect imbalance
    expect(balance.ratio).toBeGreaterThan(0)
    expect(['S3Dominant', 'Balanced', 'Critical']).toContain(balance.balance)
  })

  it('detects instability and perturbs weights (ultrastability)', () => {
    // Swing between extremes: since F165 instability is distance from the
    // running level, so a constant input (however extreme) settles, and a
    // pressure that keeps jumping does not.
    for (let i = 0; i < 10; i++) {
      const hot = i % 2 === 0
      hom.update(hot ? 0.9 : 0.1, hot ? 0.1 : 0.9, hot ? 0.8 : 0.1, 5000)
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
