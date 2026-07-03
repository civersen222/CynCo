import { describe, test, expect } from 'bun:test'
import { ttftSlope, type TurnMetric } from './benchAgentic.js'

function row(promptTokens: number, ttftMs: number): TurnMetric {
  return { turn: 0, promptTokens, ttftMs, decodeTps: 0, completionTokens: 0, missed: false }
}

describe('ttftSlope', () => {
  test('returns 0 with fewer than 2 rows', () => {
    expect(ttftSlope([])).toBe(0)
    expect(ttftSlope([row(1000, 50)])).toBe(0)
  })

  test('perfectly linear growth: 100ms per 1000 prompt tokens', () => {
    const rows = [row(1000, 100), row(2000, 200), row(3000, 300), row(4000, 400)]
    // x is promptTokens/1000, so slope is ms per 1k tokens = 100
    expect(ttftSlope(rows)).toBeCloseTo(100, 6)
  })

  test('flat TTFT (good prefix caching) yields slope 0', () => {
    const rows = [row(1000, 80), row(5000, 80), row(20000, 80)]
    expect(ttftSlope(rows)).toBeCloseTo(0, 6)
  })

  test('identical prompt sizes (zero variance in x) yields slope 0', () => {
    const rows = [row(2000, 50), row(2000, 90)]
    expect(ttftSlope(rows)).toBe(0)
  })

  test('negative slope when TTFT shrinks as context grows', () => {
    const rows = [row(1000, 400), row(2000, 300), row(3000, 200)]
    expect(ttftSlope(rows)).toBeLessThan(0)
  })
})
