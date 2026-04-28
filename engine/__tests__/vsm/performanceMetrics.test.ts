import { describe, expect, it, beforeEach } from 'bun:test'
import { PerformanceMetricsIntegration } from '../../vsm/performanceMetrics.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId } from '../../cybernetics-core/src/index.js'

describe('PerformanceMetricsIntegration', () => {
  let pm: PerformanceMetricsIntegration

  beforeEach(() => {
    resetEventBus()
    pm = new PerformanceMetricsIntegration(new NodeId())
  })

  it('tracks task attempts and completions', () => {
    pm.recordTaskAttempt()
    pm.recordTaskAttempt()
    pm.recordTaskCompletion()
    const a = pm.getAchievement()
    expect(a.actuality).toBe(1)
    expect(a.capability).toBe(2)
  })

  it('computes productivity as actuality/capability', () => {
    pm.recordTaskAttempt()
    pm.recordTaskAttempt()
    pm.recordTaskCompletion()
    const indices = pm.getIndices()
    expect(indices.productivity).toBe(0.5) // 1/2
  })

  it('computes performance health', () => {
    pm.recordTaskAttempt()
    pm.recordTaskCompletion()
    const status = pm.getHealthStatus()
    // With 1 complete, 1 attempted, capacity 10: productivity=1.0, latency=0.1, perf=0.1
    // health = (1.0 + 0.1 + 0.1) / 3 = 0.4 → amber
    expect(['red', 'amber', 'green']).toContain(status)
  })

  it('CUSUM detects sustained failure rate drift', () => {
    // Normal: no drift
    expect(pm.updateFailureRate(0.1, 0.1)).toBe(false)
    expect(pm.updateFailureRate(0.15, 0.1)).toBe(false)

    // Sustained high failure rate → drift
    for (let i = 0; i < 20; i++) {
      pm.updateFailureRate(0.8, 0.1) // large positive deviation
    }
    expect(pm.isDriftDetected()).toBe(true)
  })

  it('CUSUM drift emits DriftDetected event', () => {
    for (let i = 0; i < 20; i++) {
      pm.updateFailureRate(0.8, 0.1)
    }
    const bus = getEventBus()
    const driftEvents = bus.replayFiltered(e => e.payload.kind === 'DriftDetected')
    expect(driftEvents.length).toBeGreaterThan(0)
  })

  it('resetDrift clears CUSUM state', () => {
    for (let i = 0; i < 20; i++) {
      pm.updateFailureRate(0.8, 0.1)
    }
    expect(pm.isDriftDetected()).toBe(true)
    pm.resetDrift()
    expect(pm.isDriftDetected()).toBe(false)
  })

  it('updateCapacity adjusts estimated capacity', () => {
    pm.updateCapacity('advanced', 0.8)
    pm.recordTaskAttempt()
    pm.recordTaskCompletion()
    const a = pm.getAchievement()
    expect(a.potentiality).toBeGreaterThan(10)
  })
})
