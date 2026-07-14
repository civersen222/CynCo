// engine/__tests__/vsm/varietyWindowedReport.test.ts
// P1.5: GovernanceReport carries the windowed distinguishable-state count
// ALONGSIDE the monotone varietyRatio (both series must be visible so
// Phase 3 can compare discrimination power). The measure must survive
// ablation — it is a measurement organ, not an authority organ, and the
// Phase 3 A/B needs the series from ablated runs too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'

describe('GovernanceReport.varietyWindowed (P1.5)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
  })
  afterEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
  })

  it('reports the windowed count alongside the monotone series', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 10, undefined, { file_path: 'a.ts' })
    gov.onToolResult('Read', true, 10, undefined, { file_path: 'b.ts' })
    gov.onToolResult('Read', true, 10, undefined, { file_path: 'a.ts' }) // repeat
    const report = gov.getReport()
    expect(report.varietyWindowed).toBe(2)
    expect(typeof report.varietyRatio).toBe('number') // monotone series untouched
  })

  it('still measures when ablated (_ABLATION_VSM_DISABLED=1)', () => {
    process.env._ABLATION_VSM_DISABLED = '1'
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Grep', true, 10, undefined, { pattern: 'x' })
    gov.onToolResult('Write', true, 10, undefined, { file_path: 'y.ts' })
    // Ablated onTurnComplete returns early — but only AFTER the meter seals.
    gov.onTurnComplete({ toolsCalled: 2, thinkingTokens: 0, totalTokens: 100, latencyMs: 500, response: 'a sufficiently long response so no summary machinery misfires.' })
    expect(gov.getReport().varietyWindowed).toBe(2)
  })
})
