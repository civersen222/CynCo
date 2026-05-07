import { describe, expect, it } from 'bun:test'
import type { HealthStatus, GovernanceReport } from '../../vsm/types.js'
import { GovernanceLayer } from '../../vsm/governance.js'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

// ─── Task 1: VSM Types ───────────────────────────────────────────

describe('VSM types', () => {
  it('GovernanceReport shape is correct', () => {
    const report: GovernanceReport = {
      status: 'healthy', varietyBalance: 'balanced', varietyRatio: 1.0, s3s4Balance: 'balanced',
      algedonicAlerts: 0, stuckTurns: 0, consecutiveUnstable: 0, modelLatencyTrend: 'stable', toolSuccessRate: 0.95,
    }
    expect(report.status).toBe('healthy')
  })
})

// ─── Task 5: GovernanceLayer ─────────────────────────────────────

describe('GovernanceLayer', () => {
  it('starts healthy with no events', () => {
    const gov = new GovernanceLayer()
    const report = gov.getReport()
    expect(report.status).toBe('healthy')
    expect(report.algedonicAlerts).toBe(0)
    expect(report.toolSuccessRate).toBe(1.0)
  })

  it('tracks tool results and success rate', () => {
    const gov = new GovernanceLayer()
    gov.onToolResult('read', true, 50)
    gov.onToolResult('write', true, 80)
    const report = gov.getReport()
    expect(report.toolSuccessRate).toBe(1.0)
    expect(report.status).toBe('healthy')
  })

  it('raises critical status on 3 consecutive failures', () => {
    const alerts: string[] = []
    const gov = new GovernanceLayer((a) => alerts.push(a.severity))
    gov.onToolResult('bash', false, 100)
    gov.onToolResult('bash', false, 100)
    gov.onToolResult('bash', false, 100)
    const report = gov.getReport()
    expect(report.status).toBe('critical')
    expect(report.algedonicAlerts).toBeGreaterThan(0)
  })

  it('records turn metrics through homeostasis and audit', () => {
    const gov = new GovernanceLayer()
    gov.onTurnComplete({ toolsCalled: 3, thinkingTokens: 100, totalTokens: 400, latencyMs: 200, response: 'ok' })
    const report = gov.getReport()
    // One turn with tools — not stuck
    expect(report.stuckTurns).toBe(0)
    expect(report.status).toBe('healthy')
  })

  it('reports stuck when no tools used for 3+ turns', () => {
    const gov = new GovernanceLayer()
    for (let i = 0; i < 3; i++) {
      gov.onTurnComplete({ toolsCalled: 0, thinkingTokens: 50, totalTokens: 200, latencyMs: 100, response: `response ${i}` })
    }
    const report = gov.getReport()
    expect(report.status).toBe('warning')
    expect(report.stuckTurns).toBeGreaterThan(0)
  })
})

// ─── CyberneticsGovernance: fresh session safety ────────────────

describe('CyberneticsGovernance', () => {
  it('starts with healthy status on fresh session', () => {
    const governance = new CyberneticsGovernance()
    const report = governance.getReport()
    expect(report.status).not.toBe('critical')
    expect(report.s3s4Balance).toBe('balanced')
  })

  it('does not go critical until stuck >= 5', () => {
    const governance = new CyberneticsGovernance()

    // Drive stuck count to 3-4 via repeated same responses
    for (let i = 0; i < 4; i++) {
      governance.onTurnComplete({
        toolsCalled: 0,
        thinkingTokens: 50,
        totalTokens: 200,
        latencyMs: 100,
        response: 'same',
      })
    }
    const report = governance.getReport()
    expect(report.status).not.toBe('critical')
  })

  it('resets stuck count on successful tool use', () => {
    const governance = new CyberneticsGovernance()

    // Simulate getting stuck (same response 5 times)
    for (let i = 0; i < 5; i++) {
      governance.onTurnComplete({
        toolsCalled: 0,
        thinkingTokens: 50,
        totalTokens: 200,
        latencyMs: 100,
        response: 'same response',
      })
    }
    expect(governance.getReport().stuckTurns).toBeGreaterThanOrEqual(2)

    // A successful Write should reset stuck
    governance.onToolResult('Write', true, 100, 'File written')
    expect(governance.getReport().stuckTurns).toBe(0)
  })

  it('resets stuck count when files change (onFileProgress)', () => {
    const governance = new CyberneticsGovernance()

    for (let i = 0; i < 6; i++) {
      governance.onTurnComplete({
        toolsCalled: 0,
        thinkingTokens: 50,
        totalTokens: 200,
        latencyMs: 100,
        response: 'same',
      })
    }
    expect(governance.getReport().stuckTurns).toBeGreaterThanOrEqual(3)
    governance.onFileProgress(2, 50, 10)
    expect(governance.getReport().stuckTurns).toBe(0)
  })

  it('getRecommendedToolMode returns full for fresh session', () => {
    const governance = new CyberneticsGovernance()
    const mode = governance.getRecommendedToolMode()
    expect(mode).toBe('full')
  })
})
