/**
 * Integration smoke tests for all six ultrareview security/bug fixes.
 *
 * One describe block per fix. These are sanity checks that each fix is
 * present and wired correctly — detailed edge-case coverage lives in the
 * per-feature test files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// ─── Fix 1: Git command injection ────────────────────────────────────────────

import { gitTool, tokenizeArgs } from '../../tools/impl/git.js'

describe('Fix 1 — git command injection guard', () => {
  it('tokenizeArgs: -m "feat(scope): add parser" splits to two tokens', () => {
    expect(tokenizeArgs('-m "feat(scope): add parser"')).toEqual([
      '-m',
      'feat(scope): add parser',
    ])
  })

  it('tokenizeArgs is exported from git.ts', () => {
    expect(typeof tokenizeArgs).toBe('function')
  })

  it('blocks shell metacharacter injection in args (unquoted semicolon)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'status', args: '; rm -rf /' },
      process.cwd(),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/dangerous.*command.*blocked/i)
    expect(result.output).toContain('Shell metacharacters not allowed')
  })

  it('blocks push with quoted --force (tokenized-form check)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'push', args: '"--force"' },
      process.cwd(),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous')
  })
})

// ─── Fix 2: Prediction flag lifecycle (consume-on-read) ──────────────────────

import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

const minTurn = () => ({
  toolsCalled: 0,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 1000,
  response: '',
  userMessage: 'test',
})

describe('Fix 2 — prediction flag lifecycle (consume-on-read)', () => {
  it('setContractCreated() then onTurnComplete() opens H3 prediction', () => {
    const governance = new CyberneticsGovernance()

    governance.setContractCreated()
    governance.onTurnComplete(minTurn())

    const tracker = governance.getPredictionTracker()
    const h3Open = tracker.openPredictions.some(p => p.hypothesis === 'H3')
    expect(h3Open).toBe(true)
  })

  it('H3 flag is consumed after onTurnComplete — does not open a second H3 after dedup window', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: flag set → H3 opens (dedup window = 20 turns)
    governance.setContractCreated()
    governance.onTurnComplete(minTurn())

    // Advance 21 more turns with no flag set — beyond the dedup window
    for (let i = 0; i < 21; i++) {
      governance.onTurnComplete(minTurn())
    }

    const tracker = governance.getPredictionTracker()
    const h3All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H3')
    expect(h3All.length).toBe(1)
  })
})

// ─── Fix 3: Dashboard localhost binding ──────────────────────────────────────

import { DashboardServer } from '../../dashboard/server.js'

describe('Fix 3 — dashboard localhost binding', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.LOCALCODE_DASHBOARD_HOST
  })

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LOCALCODE_DASHBOARD_HOST = savedEnv
    } else {
      delete process.env.LOCALCODE_DASHBOARD_HOST
    }
  })

  it('getHostname() returns 127.0.0.1 when LOCALCODE_DASHBOARD_HOST is unset', () => {
    delete process.env.LOCALCODE_DASHBOARD_HOST
    const server = new DashboardServer({ port: 19281 })
    try {
      expect(server.getHostname()).toBe('127.0.0.1')
    } finally {
      server.stop()
    }
  })

  it('getHostname() reflects LOCALCODE_DASHBOARD_HOST override', () => {
    process.env.LOCALCODE_DASHBOARD_HOST = '0.0.0.0'
    const server = new DashboardServer({ port: 19282 })
    try {
      expect(server.getHostname()).toBe('0.0.0.0')
    } finally {
      server.stop()
    }
  })
})

// ─── Fix 4: Workflow turnCount reset on phase advance ────────────────────────

import { WorkflowEngine } from '../../workflows/engine.js'
import type { WorkflowDefinition } from '../../workflows/types.js'

const twoPhaseWf: WorkflowDefinition = {
  name: 'ultrareview-turncount-wf',
  displayName: 'Ultrareview Turn Count Test',
  description: 'Smoke test that turnCount resets on advance()',
  initialPhase: 'phaseA',
  phases: {
    phaseA: {
      name: 'phaseA',
      instruction: 'Phase A work',
      gate: { type: 'model_done' },
      transitions: ['phaseB'],
      maxTurns: 10,
    },
    phaseB: {
      name: 'phaseB',
      instruction: 'Phase B work',
      gate: { type: 'user_confirm' },
      transitions: ['done'],
      maxTurns: 10,
    },
  },
}

describe('Fix 4 — workflow turnCount reset on phase advance', () => {
  it('turnCount is 0 after advance() to next phase', () => {
    const engine = new WorkflowEngine()
    engine.start(twoPhaseWf)

    for (let i = 0; i < 4; i++) engine.incrementTurn()
    expect(engine.state?.turnCount).toBe(4)

    engine.advance('phaseB')
    expect(engine.state?.turnCount).toBe(0)
    expect(engine.state?.currentPhase).toBe('phaseB')
  })
})

// ─── Fix 5: --cache-ram configurable via env ──────────────────────────────────

import { buildServerArgs } from '../../llama/processManager.js'

describe('Fix 5 — cache-ram configurable via LOCALCODE_CACHE_RAM', () => {
  let savedCacheRam: string | undefined
  let savedReasoningBudget: string | undefined

  beforeEach(() => {
    savedCacheRam = process.env.LOCALCODE_CACHE_RAM
    savedReasoningBudget = process.env.LOCALCODE_REASONING_BUDGET
  })

  afterEach(() => {
    if (savedCacheRam === undefined) {
      delete process.env.LOCALCODE_CACHE_RAM
    } else {
      process.env.LOCALCODE_CACHE_RAM = savedCacheRam
    }
    if (savedReasoningBudget === undefined) {
      delete process.env.LOCALCODE_REASONING_BUDGET
    } else {
      process.env.LOCALCODE_REASONING_BUDGET = savedReasoningBudget
    }
  })

  it('LOCALCODE_CACHE_RAM=1024 is reflected in buildServerArgs output', () => {
    process.env.LOCALCODE_CACHE_RAM = '1024'
    const args = buildServerArgs({ modelPath: '/models/test.gguf', port: 8081 })
    const idx = args.indexOf('--cache-ram')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('1024')
  })

  it('defaults cache-ram to 0 and reasoning-budget to 256 when env vars unset', () => {
    delete process.env.LOCALCODE_CACHE_RAM
    delete process.env.LOCALCODE_REASONING_BUDGET
    const args = buildServerArgs({ modelPath: '/models/test.gguf', port: 8081 })
    const cacheIdx = args.indexOf('--cache-ram')
    expect(cacheIdx).toBeGreaterThanOrEqual(0)
    expect(args[cacheIdx + 1]).toBe('0')
    const budgetIdx = args.indexOf('--reasoning-budget')
    expect(budgetIdx).toBeGreaterThanOrEqual(0)
    expect(args[budgetIdx + 1]).toBe('256')
  })
})

// ─── Fix 6: Image placeholder in simulated mode ───────────────────────────────

import { convertMessages } from '../../engine/messageConvert.js'
import type { Message } from '../../types.js'

describe('Fix 6 — image placeholder in simulated tool mode', () => {
  it('convertMessages with simulatedToolUse replaces image block with em-dash placeholder', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          { type: 'text', text: 'What do you see?' },
        ],
      },
    ]

    const result = convertMessages(messages, { simulatedToolUse: true })
    expect(result[0].content).toHaveLength(1)
    const text = (result[0].content[0] as any).text
    expect(text).toBe(
      'Look at this:\n\n[Image omitted \u2014 not supported in simulated tool mode]\n\nWhat do you see?'
    )
  })
})
