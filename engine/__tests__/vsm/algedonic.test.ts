import { describe, expect, it } from 'bun:test'
import type { GovernanceAlert } from '../../vsm/types.js'
import { AlgedonicBridge } from '../../vsm/algedonic.js'

describe('AlgedonicBridge', () => {
  it('emits no alert on successful tool calls', () => {
    const alerts: GovernanceAlert[] = []
    const bridge = new AlgedonicBridge((a) => alerts.push(a))
    bridge.reportToolResult('read', true, 50)
    bridge.reportToolResult('write', true, 80)
    expect(alerts).toHaveLength(0)
    expect(bridge.unacknowledgedCount()).toBe(0)
  })

  it('emits high alert after 3 consecutive failures', () => {
    const alerts: GovernanceAlert[] = []
    const bridge = new AlgedonicBridge((a) => alerts.push(a))
    bridge.reportToolResult('bash', false, 100)
    bridge.reportToolResult('bash', false, 100)
    bridge.reportToolResult('bash', false, 100)
    expect(alerts.length).toBeGreaterThan(0)
    expect(alerts[0].severity).toBe('high')
    expect(alerts[0].type).toBe('governance.alert')
  })

  it('emits critical alert on model timeout', () => {
    const alerts: GovernanceAlert[] = []
    const bridge = new AlgedonicBridge((a) => alerts.push(a))
    bridge.reportModelTimeout(30000)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].message).toContain('30000')
  })

  it('tracks unacknowledged alerts and clears on acknowledgeAll', () => {
    const alerts: GovernanceAlert[] = []
    const bridge = new AlgedonicBridge((a) => alerts.push(a))
    bridge.reportModelTimeout(5000)
    bridge.reportModelError('connection refused')
    expect(bridge.unacknowledgedCount()).toBe(2)
    bridge.acknowledgeAll()
    expect(bridge.unacknowledgedCount()).toBe(0)
  })

  it('reports success rate drop when fewer than half succeed', () => {
    const alerts: GovernanceAlert[] = []
    const bridge = new AlgedonicBridge((a) => alerts.push(a))
    // Fill window: 20 calls, only 8 successes (40% success rate)
    for (let i = 0; i < 20; i++) {
      bridge.reportToolResult('tool', i < 8, 50)
    }
    const rate = bridge.getSuccessRate()
    expect(rate).toBeLessThan(0.5)
    const moderateAlerts = alerts.filter(a => a.severity === 'moderate')
    expect(moderateAlerts.length).toBeGreaterThan(0)
  })
})
