import { describe, it, expect } from 'vitest'
import { wilsonInterval, pairedBootstrapLift, meanBootstrap } from './stats.js'

describe('wilsonInterval', () => {
  it('computes the 95% interval for 8/10', () => {
    const r = wilsonInterval(8, 10)
    expect(r.point).toBeCloseTo(0.8, 5)
    expect(r.lower).toBeCloseTo(0.490, 2)
    expect(r.upper).toBeCloseTo(0.943, 2)
  })

  it('handles n=0 as the maximally-uncertain interval', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 })
  })

  it('clamps to [0,1] at the extremes', () => {
    const r = wilsonInterval(3, 3)
    expect(r.point).toBe(1)
    expect(r.upper).toBeLessThanOrEqual(1)
    expect(r.lower).toBeGreaterThan(0)
  })
})

describe('pairedBootstrapLift', () => {
  it('returns the exact value when all task lifts are equal (rng-independent)', () => {
    const r = pairedBootstrapLift([0.5, 0.5, 0.5], 100)
    expect(r.meanLift).toBeCloseTo(0.5, 5)
    expect(r.lower).toBeCloseTo(0.5, 5)
    expect(r.upper).toBeCloseTo(0.5, 5)
  })

  it('computes the mean lift correctly', () => {
    const r = pairedBootstrapLift([1, 0, 1, 0], 100)
    expect(r.meanLift).toBeCloseTo(0.5, 5)
  })

  it('uses the injected rng deterministically', () => {
    // rng always returns 0 -> every resample picks index 0 -> mean = lifts[0]
    const r = pairedBootstrapLift([0.2, 0.9], 50, 0.95, () => 0)
    expect(r.lower).toBeCloseTo(0.2, 5)
    expect(r.upper).toBeCloseTo(0.2, 5)
  })

  it('handles the empty case', () => {
    expect(pairedBootstrapLift([], 10)).toEqual({ meanLift: 0, lower: 0, upper: 0 })
  })
})

describe('meanBootstrap', () => {
  it('computes the exact mean on a known array', () => {
    const r = meanBootstrap([0.25, 0.5, 0.75], 100)
    expect(r.point).toBeCloseTo(0.5, 5)
  })

  it('collapses the CI to the first value when rng always returns 0', () => {
    // rng always returns 0 -> every resample picks index 0 -> mean = values[0]
    const r = meanBootstrap([0.2, 0.9], 50, 0.95, () => 0)
    expect(r.point).toBeCloseTo(0.55, 5)
    expect(r.lower).toBeCloseTo(0.2, 5)
    expect(r.upper).toBeCloseTo(0.2, 5)
  })

  it('handles the empty case', () => {
    expect(meanBootstrap([], 10)).toEqual({ point: 0, lower: 0, upper: 0 })
  })
})
