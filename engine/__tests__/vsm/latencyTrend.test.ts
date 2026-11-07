import { describe, it, expect, beforeEach } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { ALL_RULES } from '../../s5/ruleBasedS5.js'

/**
 * `GovernanceReport.modelLatencyTrend` is typed 'stable' | 'rising' | 'falling'
 * and S5 rule W2 fires on `=== 'rising'`. The report used to fill it with a
 * NUMBER (the mean tool latency in ms), so W2 could never fire in production;
 * the reachability guard passed because it hand-fed the string. Found by the
 * strict type-check (A1).
 *
 * The only model-timing signal governance holds is tok/s from the loop
 * (`setTokPerSec`), so the trend is derived from it: decode speed falling by a
 * fifth or more over the recent window is latency rising.
 */
describe('governance reports the model latency trend as a word', () => {
  let gov: CyberneticsGovernance
  beforeEach(() => {
    resetEventBus()
    gov = new CyberneticsGovernance()
  })

  const feed = (samples: number[]) => { for (const tps of samples) gov.setTokPerSec(tps, 100) }

  it('is stable before any model call has been measured', () => {
    expect(gov.getReport().modelLatencyTrend).toBe('stable')
  })

  it('is stable while tok/s holds', () => {
    feed([40, 41, 39, 40, 40, 41])
    expect(gov.getReport().modelLatencyTrend).toBe('stable')
  })

  it('is rising when tok/s drops across the window', () => {
    feed([40, 40, 40, 20, 20, 20])
    expect(gov.getReport().modelLatencyTrend).toBe('rising')
  })

  it('is falling when tok/s recovers across the window', () => {
    feed([20, 20, 20, 40, 40, 40])
    expect(gov.getReport().modelLatencyTrend).toBe('falling')
  })

  it('needs more than three samples before it says anything but stable', () => {
    feed([40, 20, 20])
    expect(gov.getReport().modelLatencyTrend).toBe('stable')
  })

  it('a live report with rising latency reaches W2', () => {
    feed([40, 40, 40, 20, 20, 20])
    const w2 = ALL_RULES.find(r => r.id === 'W2')!
    const report = gov.getReport()
    const fired = w2.evaluate({
      userMessage: 'x', activeWorkflow: null, currentPhase: null, contextUsagePercent: 0.1,
      governanceStatus: 'healthy', s3s4Balance: 'balanced',
      modelLatencyTrend: report.modelLatencyTrend,
      availableModels: ['a', 'b'], turnCount: 5, recentToolResults: [],
      varietyBalance: 'balanced', varietyRatio: 1, homeostatStable: true, homeostatConsecutiveUnstable: 0,
      driftDetected: false, driftDirection: null, performanceHealth: 'healthy', productivityRatio: 0.9,
      recommendedToolMode: null, heterarchyAuthority: null, agreementRatio: 1, observerDivergence: null,
      demotedTools: [], promptDifficulty: 'unknown', taskError: null, errorTrend: null,
      fingerprintAlarm: null, infoGain: null, progressRate: null, explorationState: null,
    })
    expect(fired, 'W2 must fire from a measured trend, not only from a hand-written one').not.toBeNull()
  })
})
