import { describe, it, expect } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

describe('stuck detection', () => {
  it('detects stuck via repeated tool signatures', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 100)
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 50, totalTokens: 200,
        latencyMs: 500, response: 'Different response text ' + i,
      })
    }
    expect(gov.getStuckCount()).toBeGreaterThanOrEqual(2)
  })

  it('does not mark as stuck when tools vary', () => {
    const gov = new CyberneticsGovernance()
    const tools = ['Read', 'Grep', 'Edit', 'Write', 'Bash']
    for (let i = 0; i < 5; i++) {
      gov.onToolResult(tools[i], true, 100)
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 50, totalTokens: 200,
        latencyMs: 500, response: 'Response ' + i,
      })
    }
    expect(gov.getStuckCount()).toBe(0)
  })

  it('exposes recent tool names', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 100)
    gov.onToolResult('Grep', true, 100)
    const names = gov.getRecentToolNames()
    expect(names).toContain('Read')
    expect(names).toContain('Grep')
  })

  it('includes recentToolNames in report', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 100)
    const report = gov.getReport()
    expect(report).toHaveProperty('recentToolNames')
    expect(Array.isArray(report.recentToolNames)).toBe(true)
  })

  it('resets stuck on successful write/edit', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 100)
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 50, totalTokens: 200,
        latencyMs: 500, response: 'same response',
      })
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)
    gov.onToolResult('Edit', true, 100)
    expect(gov.getStuckCount()).toBe(0)
  })
})
