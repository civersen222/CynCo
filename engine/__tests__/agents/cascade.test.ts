import { describe, expect, it } from 'bun:test'
import { shouldCascade, type CascadeDecision } from '../../agents/cascade.js'

// ─── Simple tasks ─────────────────────────────────────────────

describe('simple tasks', () => {
  it('never cascade with 0 attempts', () => {
    const result = shouldCascade({
      previousAttempts: 0,
      taskComplexity: 'simple',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('never cascade with 1 attempt', () => {
    const result = shouldCascade({
      previousAttempts: 1,
      taskComplexity: 'simple',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('never cascade with many attempts', () => {
    const result = shouldCascade({
      previousAttempts: 5,
      taskComplexity: 'simple',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('never cascade even with an error', () => {
    const result = shouldCascade({
      previousAttempts: 3,
      lastError: 'Something failed',
      taskComplexity: 'simple',
    })
    expect(result.shouldEscalate).toBe(false)
  })
})

// ─── Moderate tasks ───────────────────────────────────────────

describe('moderate tasks', () => {
  it('do not cascade with 0 attempts', () => {
    const result = shouldCascade({
      previousAttempts: 0,
      taskComplexity: 'moderate',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('do not cascade with 1 attempt', () => {
    const result = shouldCascade({
      previousAttempts: 1,
      taskComplexity: 'moderate',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('cascade after 2 attempts', () => {
    const result = shouldCascade({
      previousAttempts: 2,
      taskComplexity: 'moderate',
    })
    expect(result.shouldEscalate).toBe(true)
  })

  it('cascade after more than 2 attempts', () => {
    const result = shouldCascade({
      previousAttempts: 4,
      taskComplexity: 'moderate',
    })
    expect(result.shouldEscalate).toBe(true)
  })
})

// ─── Complex tasks ────────────────────────────────────────────

describe('complex tasks', () => {
  it('do not cascade with 0 attempts', () => {
    const result = shouldCascade({
      previousAttempts: 0,
      taskComplexity: 'complex',
    })
    expect(result.shouldEscalate).toBe(false)
  })

  it('cascade after 1 attempt', () => {
    const result = shouldCascade({
      previousAttempts: 1,
      taskComplexity: 'complex',
    })
    expect(result.shouldEscalate).toBe(true)
  })

  it('cascade after more than 1 attempt', () => {
    const result = shouldCascade({
      previousAttempts: 3,
      taskComplexity: 'complex',
    })
    expect(result.shouldEscalate).toBe(true)
  })
})

// ─── Decision includes reason ─────────────────────────────────

describe('decision reason', () => {
  it('provides a non-empty reason string when not escalating', () => {
    const result = shouldCascade({
      previousAttempts: 0,
      taskComplexity: 'simple',
    })
    expect(result.reason).toBeTruthy()
    expect(typeof result.reason).toBe('string')
  })

  it('provides a non-empty reason string when escalating', () => {
    const result = shouldCascade({
      previousAttempts: 2,
      taskComplexity: 'moderate',
    })
    expect(result.reason).toBeTruthy()
    expect(typeof result.reason).toBe('string')
  })

  it('reason mentions the lastError when provided', () => {
    const result = shouldCascade({
      previousAttempts: 2,
      lastError: 'timeout exceeded',
      taskComplexity: 'moderate',
    })
    expect(result.reason).toContain('timeout exceeded')
  })
})
