import { describe, it, expect } from 'vitest'
import { ObserverEffectsIntegration } from '../vsm/observerEffects.js'
import { NodeId } from '../cybernetics-core/src/index.js'

describe('observer effects wiring', () => {
  it('detects divergence when S3 and S4 disagree', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    obs.recordMeasurement('success_rate', 0.9, 'S3')
    obs.recordMeasurement('success_rate', 0.4, 'S4') // std dev = 0.25 > threshold 0.2
    const result = obs.checkDivergence('success_rate', 0.2)
    expect(result.exceeds).toBe(true)
  })

  it('low divergence when observers agree', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    obs.recordMeasurement('success_rate', 0.8, 'S3')
    obs.recordMeasurement('success_rate', 0.8, 'S4')
    const result = obs.checkDivergence('success_rate', 0.2)
    expect(result.exceeds).toBe(false)
  })

  it('eigenform converges for stable function', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    const result = obs.findSelfAssessmentEigenform(x => 0.5 + 0.3 * x, 0.5)
    expect(result.converged).toBe(true)
    expect(result.value).toBeCloseTo(0.714, 2)
  })
})
