import { describe, expect, it } from 'bun:test'
import { HomeostasisMonitor } from '../../vsm/homeostasis.js'

describe('HomeostasisMonitor', () => {
  it('returns balanced with no turns', () => {
    const monitor = new HomeostasisMonitor()
    const result = monitor.getBalance()
    expect(result.balance).toBe('balanced')
    expect(result.s3Pressure).toBe(0)
    expect(result.s4Pressure).toBe(0)
  })

  it('detects S3 dominance when many tools called with no thinking', () => {
    const monitor = new HomeostasisMonitor()
    // High tool usage, zero thinking tokens
    for (let i = 0; i < 10; i++) {
      monitor.recordTurn({ toolsCalled: 10, thinkingTokens: 0, totalTokens: 500, latencyMs: 100 })
    }
    const result = monitor.getBalance()
    // s3Pressure = min(10/5, 1) = 1.0, s4Pressure = 0, ratio = 0 → s3_dominant or critical
    expect(['s3_dominant', 'critical']).toContain(result.balance)
    expect(result.s3Pressure).toBe(1.0)
  })

  it('detects S4 dominance when mostly thinking tokens', () => {
    const monitor = new HomeostasisMonitor()
    // No tool usage, high thinking ratio
    for (let i = 0; i < 10; i++) {
      monitor.recordTurn({ toolsCalled: 0, thinkingTokens: 900, totalTokens: 1000, latencyMs: 500 })
    }
    const result = monitor.getBalance()
    // s4Pressure = min(0.9 * 2, 1) = 1.0, s3Pressure ≈ 0 → ratio very large → s4_dominant or critical
    expect(['s4_dominant', 'critical']).toContain(result.balance)
  })

  it('detects rising latency trend', () => {
    const monitor = new HomeostasisMonitor()
    // Steadily increasing latencies
    for (let i = 0; i < 10; i++) {
      monitor.recordTurn({ toolsCalled: 1, thinkingTokens: 100, totalTokens: 400, latencyMs: 100 + i * 100 })
    }
    const trend = monitor.getLatencyTrend()
    expect(trend).toBe('rising')
  })

  it('detects stable latency when values are constant', () => {
    const monitor = new HomeostasisMonitor()
    for (let i = 0; i < 10; i++) {
      monitor.recordTurn({ toolsCalled: 1, thinkingTokens: 100, totalTokens: 400, latencyMs: 200 })
    }
    const trend = monitor.getLatencyTrend()
    expect(trend).toBe('stable')
  })
})
