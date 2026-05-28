/**
 * Tests for variety-driven control signals.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { computeControlSignals } from '../../vsm/controlSignals.js'
import { resetParams, setParam } from '../../vsm/governanceParams.js'

beforeEach(() => {
  resetParams()
})

describe('computeControlSignals', () => {
  it('raises temperature when entropy is low (hammering)', () => {
    // Default low threshold is 0.5 — entropy 0.1 is clearly below it
    const result = computeControlSignals({
      toolEntropy: 0.1,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(result.temperatureAdjust).toBe(0.1)
    expect(result.temperature).toBeGreaterThan(0.7)
    expect(result.widenToolSet).toBe(true)
  })

  it('lowers temperature when entropy is high (thrashing)', () => {
    // With 5 tools: maxEntropy = log2(5) ≈ 2.32
    // highThreshold = 2.32 - 0.2 = 2.12
    // entropy 2.2 > 2.12  → thrashing
    const result = computeControlSignals({
      toolEntropy: 2.2,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(result.temperatureAdjust).toBe(-0.1)
    expect(result.temperature).toBeLessThan(0.7)
    expect(result.widenToolSet).toBe(false)
  })

  it('makes no adjustment when entropy is balanced', () => {
    // entropy 1.0 — between low threshold (0.5) and high threshold (~2.12)
    const result = computeControlSignals({
      toolEntropy: 1.0,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(result.temperatureAdjust).toBe(0)
    expect(result.temperature).toBe(0.7)
  })

  it('clamps temperature to floor', () => {
    // floor = 0.3 by default; base=0.35, adjust=-0.1 → raw=0.25 → clamped to 0.3
    const result = computeControlSignals({
      toolEntropy: 2.2,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.35,
    })
    expect(result.temperature).toBeCloseTo(0.3, 5)
  })

  it('clamps temperature to ceiling', () => {
    // ceiling = 1.0 by default; base=0.95, adjust=+0.1 → raw=1.05 → clamped to 1.0
    const result = computeControlSignals({
      toolEntropy: 0.1,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.95,
    })
    expect(result.temperature).toBeCloseTo(1.0, 5)
  })

  it('raises bestOfN budget when stuck >= 3', () => {
    const result = computeControlSignals({
      toolEntropy: 1.0,
      activeToolCount: 5,
      stuckTurns: 3,
      baseTemperature: 0.7,
    })
    expect(result.bestOfNBudget).toBe(4)
  })

  it('raises bestOfN budget when entropy is low', () => {
    const result = computeControlSignals({
      toolEntropy: 0.1,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(result.bestOfNBudget).toBe(4)
  })

  it('default bestOfN budget is 2', () => {
    const result = computeControlSignals({
      toolEntropy: 1.0,
      activeToolCount: 5,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(result.bestOfNBudget).toBe(2)
  })
})
