/**
 * README claim guard: model switching.
 *
 * The README used to say "CynCo's S2 coordinator routes simple tasks to the fast
 * model and complex tasks to your primary." Nothing did that. `classifyComplexity`
 * in `engine/cascade/` had exactly one caller — the `/cascade` slash command, which
 * printed a word and routed nothing — while the switching that DOES happen comes
 * from somewhere else entirely: S5 rule W2, on measured rising latency, applied by
 * the conversation loop. The claim was wrong about the system, the trigger, and the
 * moment, and stayed wrong for months because no test could see it.
 *
 * So the claim now has to hold a live path open. These tests fail if the wiring is
 * removed, and fail if the prose starts describing a router again.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
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
    availableModels: ['primary'],
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

const RISING = { modelLatencyTrend: 'rising' as const, turnCount: 5, availableModels: ['primary', 'fast'] }

describe('the model-switch claim is wired', () => {
  it('W2 proposes the alternative when latency is measurably rising', async () => {
    const d = await new RuleBasedS5().decide(makeS5Input(RISING))
    expect(d.model).toBe('fast')
    expect(d.ruleIds).toContain('W2')
  })

  it('the conversation loop applies decision.model rather than only logging it', () => {
    // Without this call the rule fires into the void, which is the exact failure
    // mode being guarded against.
    expect(read('engine/bridge/conversationLoop.ts')).toContain('this.updateModel(decision.model)')
  })
})

describe('nothing routes by guessed task complexity', () => {
  it('the cascade module stays deleted', () => {
    // It was a substring match over the user's wording. S5Input.promptDifficulty
    // is derived from turn telemetry and is the measured signal that replaced it;
    // reintroducing the guess would create a second routing authority with no
    // arbitration against W2.
    expect(existsSync(join(repoRoot, 'engine/cascade'))).toBe(false)
    expect(read('engine/main.ts')).not.toContain('classifyComplexity')
  })

  it.each([
    ['README.md', 'cascade'],
    ['README.md', 'routes simple tasks'],
    ['docs/MANUAL.md', 'classifies task complexity'],
  ])('%s no longer claims %s', (file, claim) => {
    expect(read(file).toLowerCase()).not.toContain(claim.toLowerCase())
  })
})
