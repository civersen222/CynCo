import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

// BLOCKING flag guard (per CLAUDE.md): proactive tool surfacing is opt-in. With
// LOCALCODE_S5_PROACTIVE_TOOLS unset the P1 rule must not fire, no surfaceTools
// may be produced, and the presence of the new STATE fields (taskClass,
// loadedTools) must not change the decision — byte-identical to pre-feature.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

function makeS5Input(overrides: Partial<S5Input> = {}): S5Input {
  return {
    userMessage: '',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.1,
    governanceStatus: 'healthy',
    s3s4Balance: 'balanced',
    modelLatencyTrend: 'stable',
    availableModels: ['m'],
    turnCount: 1,
    recentToolResults: [],
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    homeostatStable: true,
    homeostatConsecutiveUnstable: 0,
    driftDetected: false,
    driftDirection: null,
    performanceHealth: 'healthy',
    productivityRatio: 0.8,
    recommendedToolMode: null,
    heterarchyAuthority: null,
    agreementRatio: 1.0,
    observerDivergence: null,
    demotedTools: [],
    promptDifficulty: 'unknown',
    taskError: null,
    errorTrend: null,
    fingerprintAlarm: null,
    infoGain: null,
    progressRate: null,
    explorationState: null,
    ...overrides,
  }
}

// decisionId is a random UUID — strip it before comparing structural output.
function stripVolatile(d: any) {
  const { decisionId, ...rest } = d
  return rest
}

describe('proactive tools flag guard', () => {
  const prev = process.env.LOCALCODE_S5_PROACTIVE_TOOLS
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    else process.env.LOCALCODE_S5_PROACTIVE_TOOLS = prev
  })

  it('flag off: new STATE fields do not change the decision (byte-identity)', async () => {
    delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    const s5 = new RuleBasedS5()
    // Baseline: no taskClass/loadedTools at all.
    const baseline = await s5.decide(makeS5Input())
    // Same input but WITH the new state that WOULD surface tools if flag were on.
    const withState = await s5.decide(makeS5Input({ taskClass: 'debug', loadedTools: [] }))
    expect(stripVolatile(withState)).toEqual(stripVolatile(baseline))
  })

  it('flag off: surfaceTools is null and P1 never fires', async () => {
    delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    const s5 = new RuleBasedS5()
    const d = await s5.decide(makeS5Input({ taskClass: 'debug', loadedTools: [] }))
    expect(d.surfaceTools ?? null).toBeNull()
    expect(d.ruleIds ?? []).not.toContain('P1')
  })

  it('flag on: the same input DOES surface (proves the guard is meaningful)', async () => {
    process.env.LOCALCODE_S5_PROACTIVE_TOOLS = 'true'
    const s5 = new RuleBasedS5()
    const d = await s5.decide(makeS5Input({ taskClass: 'debug', loadedTools: [] }))
    expect(d.surfaceTools).toEqual(['Bash', 'Grep', 'Read'])
    expect(d.ruleIds).toContain('P1')
  })

  it('ruleBasedS5 registers PROACTIVE_SURFACING behind the flag on a live path', () => {
    const src = read('engine/s5/ruleBasedS5.ts')
    expect(src).toContain("from './proactiveSurfacing.js'")
    expect(src).toContain("from '../config.js'")
    expect(src).toContain('isProactiveToolsEnabled()')
    expect(src).toContain('PROACTIVE_SURFACING')
  })

  it('conversationLoop threads state and applies surfaceTools behind the flag', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toContain("from '../s5/proactiveSurfacing.js'")
    expect(src).toContain('classifyTaskClass(text)')
    expect(src).toContain('loadedTools: this.loadedTools.names()')
    expect(src).toContain('this.loadedTools.surface(decision.surfaceTools)')
    expect(src).toContain('isProactiveToolsEnabled()')
  })
})
