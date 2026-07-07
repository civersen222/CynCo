// benchmark/true/polyglot/report.test.ts
import { describe, it, expect } from 'vitest'
import { summarize, formatReport } from './report.js'
import type { ExerciseRecord } from './types.js'

const rec = (over: Partial<ExerciseRecord>): ExerciseRecord => ({
  language: 'python', exercise: 'x', passed: false, passedTry: null,
  durationMs: 1000, tryDurationsMs: [1000], testDurationMs: 100, ...over,
})

describe('summarize', () => {
  it('computes pass@1, pass@2, per-language breakdown, env failures, timeouts', () => {
    const records = [
      rec({ exercise: 'a', passed: true, passedTry: 1 }),
      rec({ exercise: 'b', passed: true, passedTry: 2 }),
      rec({ exercise: 'c' }),
      rec({ language: 'go', exercise: 'd', envFailure: true }),
      rec({ language: 'go', exercise: 'e', error: 'try timeout' }),
    ]
    const s = summarize(records)
    expect(s.total).toBe(5)
    expect(s.passed).toBe(2) // pass@2 headline
    expect(s.passedTry1).toBe(1) // pass@1
    expect(s.envFailures).toBe(1)
    expect(s.byLanguage.python).toEqual({ total: 3, passed: 2 })
    expect(s.byLanguage.go).toEqual({ total: 2, passed: 0 })
  })
})

describe('formatReport', () => {
  it('shows progress out of 225 and running pass@2', () => {
    const out = formatReport(summarize([rec({ passed: true, passedTry: 1 })]), 'test-model')
    expect(out).toContain('1/225')
    expect(out).toContain('pass@2')
    expect(out).toContain('test-model')
    expect(out).not.toContain('Leaderboard') // not complete yet
  })

  it('adds the leaderboard comparison once all 225 are recorded', () => {
    const records = Array.from({ length: 225 }, (_, i) =>
      rec({ exercise: `e${i}`, passed: i < 90, passedTry: i < 90 ? 1 : null }),
    )
    const out = formatReport(summarize(records), 'test-model')
    expect(out).toContain('Leaderboard')
    expect(out).toContain('40.0%')
  })
})
