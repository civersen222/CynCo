import { describe, expect, it, beforeEach } from 'bun:test'
import { DifficultyClassifier } from '../../vsm/difficultyClassifier.js'

describe('DifficultyClassifier', () => {
  let dc: DifficultyClassifier
  beforeEach(() => { dc = new DifficultyClassifier() })

  it('starts as unknown', () => {
    expect(dc.getLevel()).toBe('unknown')
  })

  it('classifies as easy after quick completion', () => {
    dc.recordTurn({ toolCalls: 2, errors: 0, tokens: 100 })
    dc.recordTurn({ toolCalls: 0, errors: 0, tokens: 50 })
    expect(dc.getLevel()).toBe('easy')
  })

  it('classifies as medium with moderate tool use', () => {
    for (let i = 0; i < 5; i++) dc.recordTurn({ toolCalls: 2, errors: 0, tokens: 200 })
    expect(dc.getLevel()).toBe('medium')
  })

  it('classifies as hard when errors appear', () => {
    for (let i = 0; i < 3; i++) dc.recordTurn({ toolCalls: 3, errors: 1, tokens: 500 })
    expect(dc.getLevel()).toBe('hard')
  })

  it('classifies as expert with many tools + errors', () => {
    for (let i = 0; i < 8; i++) dc.recordTurn({ toolCalls: 4, errors: 2, tokens: 1000 })
    expect(dc.getLevel()).toBe('expert')
  })

  it('getGovernanceIntensity scales with difficulty', () => {
    expect(dc.getGovernanceIntensity('easy')).toBe(0)
    expect(dc.getGovernanceIntensity('medium')).toBe(1)
    expect(dc.getGovernanceIntensity('hard')).toBe(2)
    expect(dc.getGovernanceIntensity('expert')).toBe(3)
  })

  it('shouldInjectSignals false for easy', () => {
    dc.recordTurn({ toolCalls: 2, errors: 0, tokens: 100 })
    dc.recordTurn({ toolCalls: 0, errors: 0, tokens: 50 })
    expect(dc.shouldInjectSignals()).toBe(false)
  })

  it('shouldInjectSignals true for hard', () => {
    for (let i = 0; i < 5; i++) dc.recordTurn({ toolCalls: 3, errors: 1, tokens: 500 })
    expect(dc.shouldInjectSignals()).toBe(true)
  })
})
