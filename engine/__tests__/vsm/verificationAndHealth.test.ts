import { describe, it, expect, beforeEach } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { toPerformanceHealth } from '../../vsm/performanceMetrics.js'
import { resetEventBus } from '../../vsm/eventBus.js'

/**
 * Two small governance defects the strict type-check (A1) surfaced.
 *
 * 1. `onVerificationResult(false)` called `recordTaskCompletion(false)`, but the
 *    method takes no argument and only increments `tasksCompleted`: a FAILED
 *    verification counted as a completed task in Beer's achievement figure.
 * 2. The loop mapped `getHealthStatus()` to S5's `performanceHealth` by
 *    comparing with 'yellow'; the status is 'red' | 'amber' | 'green', so amber
 *    was reported as 'critical' and 'warning' could never be produced (rule I3
 *    reads it).
 */
describe('verification results and the achievement count', () => {
  let gov: CyberneticsGovernance
  beforeEach(() => { resetEventBus(); gov = new CyberneticsGovernance() })

  it('a passed verification counts as a completion', () => {
    const before = gov.getPerformanceMetrics().getAchievement().actuality
    gov.onVerificationResult(true)
    expect(gov.getPerformanceMetrics().getAchievement().actuality).toBe(before + 1)
  })

  it('a failed verification does not', () => {
    const before = gov.getPerformanceMetrics().getAchievement().actuality
    gov.onVerificationResult(false, 'tests red')
    expect(gov.getPerformanceMetrics().getAchievement().actuality).toBe(before)
  })
})

describe('toPerformanceHealth', () => {
  it('maps the three colours onto the three S5 levels', () => {
    expect(toPerformanceHealth('green')).toBe('healthy')
    expect(toPerformanceHealth('amber')).toBe('warning')
    expect(toPerformanceHealth('red')).toBe('critical')
  })
})
