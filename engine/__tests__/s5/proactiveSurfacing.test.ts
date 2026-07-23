import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  PROACTIVE_SURFACING,
  TASK_TOOL_HINTS,
  classifyTaskClass,
} from '../../s5/proactiveSurfacing.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

// Full S5Input with benign defaults so no other rule fires — isolates P1.
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

describe('classifyTaskClass', () => {
  it('classifies test-related messages', () => {
    expect(classifyTaskClass('write a unit test for the parser')).toBe('test')
    expect(classifyTaskClass('run pytest and check tdd cycle')).toBe('test')
  })

  it('classifies debug-related messages', () => {
    expect(classifyTaskClass('fix this crash with a stacktrace')).toBe('debug')
    expect(classifyTaskClass('the build is broken, error TS2345')).toBe('debug')
  })

  it('classifies research-related messages', () => {
    expect(classifyTaskClass('investigate how the API works, look up the docs')).toBe('research')
  })

  it('classifies refactor-related messages', () => {
    expect(classifyTaskClass('refactor this to extract a helper')).toBe('refactor')
  })

  it('falls back to general when nothing matches', () => {
    expect(classifyTaskClass('hello there')).toBe('general')
  })
})

describe('PROACTIVE_SURFACING rule', () => {
  it('returns null when taskClass is absent', () => {
    expect(PROACTIVE_SURFACING.evaluate(makeS5Input())).toBeNull()
  })

  it('returns null for general (no hints)', () => {
    expect(PROACTIVE_SURFACING.evaluate(makeS5Input({ taskClass: 'general' }))).toBeNull()
  })

  it('surfaces the hint tools not yet loaded', () => {
    const out = PROACTIVE_SURFACING.evaluate(makeS5Input({ taskClass: 'debug', loadedTools: [] }))
    expect(out?.surfaceTools).toEqual(TASK_TOOL_HINTS.debug)
  })

  it('excludes tools already loaded', () => {
    const out = PROACTIVE_SURFACING.evaluate(
      makeS5Input({ taskClass: 'debug', loadedTools: ['Read', 'Grep'] }),
    )
    expect(out?.surfaceTools).toEqual(['Bash'])
  })

  it('returns null when every hint tool is already loaded', () => {
    const out = PROACTIVE_SURFACING.evaluate(
      makeS5Input({ taskClass: 'research', loadedTools: ['WebFetch', 'WebSearch'] }),
    )
    expect(out).toBeNull()
  })
})

describe('RuleBasedS5 flag gating', () => {
  const prev = process.env.LOCALCODE_S5_PROACTIVE_TOOLS
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    else process.env.LOCALCODE_S5_PROACTIVE_TOOLS = prev
  })

  it('does not surface tools when the flag is off', async () => {
    delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    const s5 = new RuleBasedS5()
    const d = await s5.decide(makeS5Input({ taskClass: 'debug', loadedTools: [] }))
    expect(d.surfaceTools).toBeNull()
    expect(d.ruleIds).not.toContain('P1')
  })

  it('surfaces tools when the flag is on', async () => {
    process.env.LOCALCODE_S5_PROACTIVE_TOOLS = 'true'
    const s5 = new RuleBasedS5()
    const d = await s5.decide(makeS5Input({ taskClass: 'debug', loadedTools: ['Read'] }))
    expect(d.surfaceTools).toEqual(['Bash', 'Grep'])
    expect(d.ruleIds).toContain('P1')
  })
})
