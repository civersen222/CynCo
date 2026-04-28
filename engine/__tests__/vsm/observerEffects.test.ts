import { describe, expect, it, beforeEach } from 'bun:test'
import { ObserverEffectsIntegration } from '../../vsm/observerEffects.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId } from '../../cybernetics-core/src/index.js'

describe('ObserverEffectsIntegration', () => {
  let obs: ObserverEffectsIntegration

  beforeEach(() => {
    resetEventBus()
    obs = new ObserverEffectsIntegration(new NodeId())
  })

  it('records measurements with observer metadata', () => {
    obs.recordMeasurement('failure_rate', 0.1, 'S3')
    obs.recordMeasurement('failure_rate', 0.15, 'S4')
    const s3 = obs.getMeasurementsByObserver('S3')
    expect(s3).toHaveLength(1)
    expect(s3[0].value).toBe(0.1)
  })

  it('detects observer divergence when perspectives differ', () => {
    obs.recordMeasurement('health', 0.8, 'S3') // S3 thinks healthy
    obs.recordMeasurement('health', 0.3, 'S4') // S4 thinks unhealthy
    const { divergence, exceeds } = obs.checkDivergence('health', 0.1)
    expect(divergence).toBeGreaterThan(0.1)
    expect(exceeds).toBe(true)
  })

  it('no divergence when observers agree', () => {
    obs.recordMeasurement('health', 0.8, 'S3')
    obs.recordMeasurement('health', 0.8, 'S4')
    const { divergence, exceeds } = obs.checkDivergence('health', 0.1)
    expect(divergence).toBe(0)
    expect(exceeds).toBe(false)
  })

  it('findSelfAssessmentEigenform converges for contractive function', () => {
    // f(x) = 0.5*x + 0.3 → fixed point at x = 0.6
    const result = obs.findSelfAssessmentEigenform(x => 0.5 * x + 0.3, 0.0)
    expect(result.converged).toBe(true)
    expect(result.value).toBeCloseTo(0.6, 2)
  })

  it('eigenform convergence emits domain event', () => {
    obs.findSelfAssessmentEigenform(x => 0.5 * x + 0.3, 0.0)
    const bus = getEventBus()
    const events = bus.replayFiltered(e => e.payload.kind === 'EigenformConverged')
    expect(events.length).toBe(1)
  })

  it('non-convergent eigenform returns converged=false', () => {
    // f(x) = 2*x (divergent)
    const result = obs.findSelfAssessmentEigenform(x => 2 * x + 1, 1.0)
    expect(result.converged).toBe(false)
  })

  it('isStableFixedPoint checks contraction mapping', () => {
    // f(x) = 0.5*x + 0.3 at x=0.6: f'(0.6) = 0.5 < 1 → stable
    expect(obs.isStableFixedPoint(x => 0.5 * x + 0.3, 0.6)).toBe(true)
    // f(x) = 2*x at x=0: f'(0) = 2 > 1 → unstable
    expect(obs.isStableFixedPoint(x => 2 * x, 0)).toBe(false)
  })
})
