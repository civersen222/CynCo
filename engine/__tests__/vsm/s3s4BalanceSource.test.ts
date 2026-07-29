import { describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

/**
 * Finding (af), measured across three watched runs.
 *
 *   watch_l45.log   103 governance reports, 103 of them s3s4Balance=critical
 *   watch_l46d.log  124 reports, 113 critical
 *   watch_l46e.log   81 reports,  71 critical
 *
 * 287 of 308. A signal that says the same thing 93% of the time is not
 * reporting a state, it is reporting its own construction.
 *
 * The construction: `s3s4Balance` is typed 'balanced' | 's3_dominant' |
 * 's4_dominant' | 'critical' — the four states of HomeostatBalance, which is
 * what the name says it carries. getReport() fed it from the VARIETY engine
 * instead, whose enum is Critical | Overload | Underload | Balanced. The two
 * share two names and measure different things: variety is environment against
 * regulator, the homeostat is S3 operations against S4 intelligence. A variety
 * ratio outside [0.5, 2.0] reads Critical, and the observed ratios were 5.5 and
 * 7.0, because tool entropy and task complexity are not on one scale.
 *
 * Two consequences, both live:
 *
 *   - 's3_dominant' and 's4_dominant' could not be produced by any code path.
 *     ruleBasedS5's W6 branches on nothing else, so W6 could never fire; W5's
 *     two specific cases could never fire; modelS5's priority was always
 *     'balanced'. S5's whole S3/S4 rebalancing was inert, with tests that
 *     construct the unreachable values by hand and pass.
 *   - heterarchyIntegration.classifyContext was handed "critical" as its crisis
 *     flag on 93% of turns.
 *
 * And the real reading was already being taken. cyberneticsGovernance computes
 * s3Pressure and s4Pressure every turn, hands them to the homeostat, which
 * classifies them, stores the result in lastBalance and emits it as a domain
 * event — and nothing ever read it.
 *
 * The rule these tests pin: the field named for the S3/S4 balance carries the
 * S3/S4 balance.
 */

function turn(gov: CyberneticsGovernance, toolsCalled: number, thinkingTokens: number, totalTokens: number) {
  gov.onTurnComplete({
    toolsCalled,
    thinkingTokens,
    totalTokens,
    latencyMs: 500,
    response: 'turn',
    contextUtilization: 0.2,
  })
}

/**
 * The pressures, from cyberneticsGovernance:
 *   s3 = toolsCalled > 0 ? min(toolsCalled / 5, 1) : 0.1
 *   s4 = thinkingTokens > 0 ? min(thinking / total, 1) : 0.3
 * and classifyHomeostatBalance on (s3 + 0.01) / (s4 + 0.01):
 *   < 0.25 or > 4.0 -> Critical,  < 0.5 -> S4Dominant,  > 2.0 -> S3Dominant.
 */
describe('getReport().s3s4Balance is the homeostat reading, not the variety reading', () => {
  it('reports s3_dominant when tools ran and nothing was thought', () => {
    // s3 = 1.0, s4 = 0.3 -> 1.01 / 0.31 = 3.26
    const gov = new CyberneticsGovernance()
    turn(gov, 5, 300, 1000)
    expect(gov.getReport().s3s4Balance).toBe('s3_dominant')
  })

  it('reports s4_dominant when the turn thought and did nothing', () => {
    // s3 = 0.1, s4 = 0.25 -> 0.11 / 0.26 = 0.42
    const gov = new CyberneticsGovernance()
    turn(gov, 0, 250, 1000)
    expect(gov.getReport().s3s4Balance).toBe('s4_dominant')
  })

  it('reports critical only on a genuine extreme', () => {
    // s3 = 0.1, s4 = 0.9 -> 0.11 / 0.91 = 0.12
    const gov = new CyberneticsGovernance()
    turn(gov, 0, 900, 1000)
    expect(gov.getReport().s3s4Balance).toBe('critical')
  })

  it('reports balanced on an ordinary turn', () => {
    // s3 = 0.2, s4 = 0.3 -> 0.21 / 0.31 = 0.68. One tool call, no thinking:
    // the shape of most turns in every run measured, and it is not a crisis.
    const gov = new CyberneticsGovernance()
    turn(gov, 1, 0, 1000)
    expect(gov.getReport().s3s4Balance).toBe('balanced')
  })

  it('does not let a lopsided variety ratio read as an S3/S4 crisis', () => {
    // The measured defect itself. Enough tool history for the variety snapshot
    // to exist, wide tool diversity so its ratio leaves [0.5, 2.0] and it
    // classifies Critical — while the pressures stay ordinary.
    const gov = new CyberneticsGovernance()
    const tools = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Ls', 'Git', 'WebFetch', 'MultiEdit', 'ApplyPatch', 'CodeIndex']
    for (const name of tools) gov.onToolResult(name, true, 10)
    turn(gov, 1, 0, 1000)
    expect(gov.getReport().varietyBalance).toBe('overload')
    expect(gov.getReport().s3s4Balance).toBe('balanced')
  })

  it('reads balanced before any turn has been measured', () => {
    // Guard: no turn, no pressures, no reading. Balanced is the resting value
    // and must not become a crisis by default.
    const gov = new CyberneticsGovernance()
    expect(gov.getReport().s3s4Balance).toBe('balanced')
  })
})
