// P4.3/4(d): classifyExploration — variety-high regime named by errorTrend.
// Pure function; measurement only, no authority.
import { describe, expect, it } from 'vitest'
import { classifyExploration } from '../../vsm/explorationState.js'

describe('classifyExploration', () => {
  // variety gate: turnsObserved >= 4 AND varietyWindowed / min(turnsObserved,10) >= 0.6
  it('gates out under 4 turns even with high variety', () => {
    expect(classifyExploration(3, 3, 'falling')).toBeNull()
  })

  it('gates out on low variety (ratio below 0.6)', () => {
    // 5 distinct / min(10,10)=10 = 0.5 < 0.6
    expect(classifyExploration(5, 10, 'falling')).toBeNull()
  })

  it('falling errorTrend under high variety → healthy_exploration', () => {
    // 6 / min(8,10)=8 = 0.75 >= 0.6, turns >= 4
    expect(classifyExploration(6, 8, 'falling')).toBe('healthy_exploration')
  })

  it('flat errorTrend under high variety → thrashing', () => {
    expect(classifyExploration(6, 8, 'flat')).toBe('thrashing')
  })

  it('rising errorTrend under high variety → floundering', () => {
    expect(classifyExploration(6, 8, 'rising')).toBe('floundering')
  })

  it('null errorTrend (no active contract) → null even under high variety', () => {
    expect(classifyExploration(6, 8, null)).toBeNull()
  })

  it('boundary: exactly 4 turns and exactly 0.6 ratio passes the gate', () => {
    // 3 distinct over 4 turns: 3/4 = 0.75 >= 0.6 at the 4-turn floor
    expect(classifyExploration(3, 4, 'flat')).toBe('thrashing')
  })

  it('boundary: exactly 0.6 ratio at the 10-turn window passes', () => {
    expect(classifyExploration(6, 10, 'flat')).toBe('thrashing')
  })

  it('boundary: just under 0.6 (window capped at 10) gates out', () => {
    // 11 turns → min(11,10)=10; 5/10 = 0.5 < 0.6
    expect(classifyExploration(5, 11, 'flat')).toBeNull()
  })
})
