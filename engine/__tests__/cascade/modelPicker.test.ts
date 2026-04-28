import { describe, expect, it } from 'bun:test'
import { pickForComplexity, classifyComplexity } from '../../cascade/modelPicker.js'
import type { ModelProfile } from '../../cascade/types.js'

// ─── Shared model registry ────────────────────────────────────────

const profiles: ModelProfile[] = [
  { name: 'phi4-mini:3.8b', tier: 'fast', contextLength: 16384, estimatedTps: 60 },
  { name: 'qwen3:8b', tier: 'balanced', contextLength: 32768, estimatedTps: 30 },
  { name: 'qwen3:32b', tier: 'powerful', contextLength: 32768, estimatedTps: 10 },
]

// ─── pickForComplexity ────────────────────────────────────────────

describe('pickForComplexity', () => {
  it('picks fast tier for simple complexity', () => {
    const result = pickForComplexity('simple', profiles)
    expect(result?.tier).toBe('fast')
    expect(result?.name).toBe('phi4-mini:3.8b')
  })

  it('picks balanced tier for moderate complexity', () => {
    const result = pickForComplexity('moderate', profiles)
    expect(result?.tier).toBe('balanced')
    expect(result?.name).toBe('qwen3:8b')
  })

  it('picks powerful tier for complex complexity', () => {
    const result = pickForComplexity('complex', profiles)
    expect(result?.tier).toBe('powerful')
    expect(result?.name).toBe('qwen3:32b')
  })

  it('falls back to first model when no tier match', () => {
    const singleProfile: ModelProfile[] = [
      { name: 'only-model:latest', tier: 'balanced', contextLength: 4096, estimatedTps: 20 },
    ]
    // No 'fast' tier available — should fall back to first
    const result = pickForComplexity('simple', singleProfile)
    expect(result?.name).toBe('only-model:latest')
  })
})

// ─── classifyComplexity ───────────────────────────────────────────

describe('classifyComplexity', () => {
  it('classifies short simple-keyword message with no tools as simple', () => {
    const result = classifyComplexity('show list of files', 0)
    expect(result).toBe('simple')
  })

  it('classifies message with complex keywords as complex', () => {
    const result = classifyComplexity('refactor the auth module', 0)
    expect(result).toBe('complex')
  })

  it('classifies long message as complex regardless of keywords', () => {
    const long = 'a'.repeat(250)
    const result = classifyComplexity(long, 0)
    expect(result).toBe('complex')
  })

  it('classifies message with 3+ tools as complex', () => {
    const result = classifyComplexity('update the config file', 3)
    expect(result).toBe('complex')
  })

  it('classifies medium message with no strong signals as moderate', () => {
    const result = classifyComplexity('update the config file', 1)
    expect(result).toBe('moderate')
  })
})
