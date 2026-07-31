/**
 * Every S5 rule must have a reachable true branch, and the input it reads must
 * be real.
 *
 * The README advertises "21 tiered rules". Four of them read
 * `S5Input.recentToolResults`, and both production sites that construct an
 * S5Input hardcoded that field to `[]`:
 *
 *   conversationLoop.ts:1215   recentToolResults: [],   // pre-turn decision
 *   conversationLoop.ts:2150   recentToolResults: [],   // stuck-loop re-eval
 *
 * With an always-empty array:
 *   C2 "3+ failures — exclude the tool"     getFailingTools([], 3) → []      never fires
 *   C4 "doom loop — 3 identical failures"   results.length < 3 → null        never fires
 *   C6 "restrict to top-5 by success"       always took its read-only arm
 *   W4 "drift + degrading"                  never excluded anything
 *
 * Two rules with no reachable true branch, and two permanently stuck on their
 * degraded arm. The audit named C1/C2/C4/C5; C1 reads `governanceStatus` and C5
 * reads `performanceHealth`, so the four that actually depend on the dead field
 * are C2, C4, C6 and W4. Fixed by measurement, not by the report.
 *
 * The first block below is the invariant the audit asked for: every rule in the
 * shipped ruleset has at least one input that makes it fire. The rest pin the
 * wiring that makes those inputs occur in production.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ALL_RULES, RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const source = readFileSync('engine/bridge/conversationLoop.ts', 'utf-8')

/** An input on which nothing at all should fire. Without this the witnesses
 *  below prove nothing — a rule that fired unconditionally would pass them. */
function quiet(): S5Input {
  return {
    userMessage: 'hello',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.1,
    governanceStatus: 'healthy',
    s3s4Balance: 'balanced',
    modelLatencyTrend: 'stable',
    availableModels: ['only-one'],
    turnCount: 1,
    recentToolResults: [],
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    homeostatStable: true,
    homeostatConsecutiveUnstable: 0,
    driftDetected: false,
    driftDirection: null,
    performanceHealth: 'healthy',
    productivityRatio: 0.9,
    recommendedToolMode: 'full',
    heterarchyAuthority: null,
    agreementRatio: 1.0,
    observerDivergence: null,
    demotedTools: [],
    promptDifficulty: 'medium' as any,
    taskError: null,
    errorTrend: null,
    fingerprintAlarm: null,
    infoGain: null,
    progressRate: null,
    explorationState: null,
  }
}

const fail = (tool: string, n: number) =>
  Array.from({ length: n }, () => ({ tool, success: false }))

/** One input per rule that makes exactly that rule's condition true. */
const WITNESSES: Record<string, Partial<S5Input>> = {
  C1: { governanceStatus: 'halted' },
  C2: { recentToolResults: [...fail('Edit', 3), { tool: 'Read', success: true }] },
  C3: { contextUsagePercent: 0.95 },
  C4: { recentToolResults: fail('Bash', 3) },
  C5: { performanceHealth: 'critical', productivityRatio: 0.1 },
  C6: { varietyBalance: 'critical' },
  C7: { governance: { stuckTurns: 5, recentToolNames: ['Read'], activeToolNames: ['Read', 'Edit'] } },
  W1: { contextUsagePercent: 0.8 },
  W2: { modelLatencyTrend: 'rising', turnCount: 5, availableModels: ['a', 'b'] },
  W3: { governance: { stuckTurns: 5, toolSuccessRate: 0.2 } },
  W4: { driftDetected: true, driftDirection: 'degrading' },
  W5: { homeostatStable: false, homeostatConsecutiveUnstable: 3, s3s4Balance: 's3_dominant' },
  W6: { turnCount: 5, s3s4Balance: 's4_dominant' },
  W7: { recommendedToolMode: 'minimal', turnCount: 3 },
  W8: { agreementRatio: 0.2, turnCount: 3 },
  W9: { observerDivergence: 0.5, turnCount: 3 },
  I1: { varietyBalance: 'overload' },
  I2: { homeostatStable: false, homeostatConsecutiveUnstable: 1 },
  I3: { performanceHealth: 'warning' },
  I4: { heterarchyAuthority: 's5', turnCount: 2 },
  I5: { driftDetected: true, driftDirection: 'improving' },
}

describe('every shipped S5 rule has a reachable true branch', () => {
  it('the quiet input fires nothing, so a witness means something', () => {
    const fired = ALL_RULES.filter(r => r.evaluate(quiet()) !== null).map(r => r.id)
    expect(fired, 'a rule firing on a healthy system makes its witness vacuous').toEqual([])
  })

  it('the witness table covers the ruleset exactly', () => {
    // Set equality both ways: a rule added without a witness fails here rather
    // than shipping unmeasured, and a witness for a deleted rule is cleaned up.
    expect(Object.keys(WITNESSES).sort()).toEqual(ALL_RULES.map(r => r.id).sort())
  })

  it.each(ALL_RULES.map(r => [r.id, r.name] as const))('%s (%s) fires on its witness', (id) => {
    const rule = ALL_RULES.find(r => r.id === id)!
    expect(rule.evaluate({ ...quiet(), ...WITNESSES[id] })).not.toBeNull()
  })

  it('C2 and C4 are unreachable without real tool results', () => {
    // The exact pre-fix condition, stated as a test so the regression is named.
    const empty = { ...quiet(), recentToolResults: [] }
    for (const id of ['C2', 'C4']) {
      expect(ALL_RULES.find(r => r.id === id)!.evaluate(empty), `${id} needs tool history`).toBeNull()
    }
  })

  it('C6 restricts to the tools that actually work, not to read-only', async () => {
    const decision = await new RuleBasedS5().decide({
      ...quiet(),
      varietyBalance: 'critical',
      recentToolResults: [
        { tool: 'Read', success: true }, { tool: 'Read', success: true },
        { tool: 'Edit', success: false }, { tool: 'Edit', success: false },
      ],
    })
    // Read outranks Edit by success rate; with an empty history C6 fell back to
    // the fixed read-only list and this ordering could never be observed.
    expect(decision.tools).toContain('Read')
    expect(decision.tools!.indexOf('Read')).toBeLessThan(decision.tools!.indexOf('Edit'))
  })
})

describe('the loop feeds S5 the tool results it has', () => {
  it('neither S5 construction site hardcodes an empty history', () => {
    expect(
      source.match(/recentToolResults:\s*\[\]/g) ?? [],
      'a rule reading a literal [] has no reachable true branch',
    ).toEqual([])
  })

  it('both S5 construction sites read the rolling window', () => {
    expect(
      (source.match(/recentToolResults:\s*this\.getRecentToolResults\(\)/g) ?? []).length,
      'the pre-turn decision and the stuck-loop re-eval must see the same history',
    ).toBe(2)
  })

  it('the per-turn array cannot be written without the session window', () => {
    // One write path on purpose. Seven separate `push` sites next to seven
    // separate window appends would drift the first time an eighth was added —
    // which is how the field came to be empty in the first place.
    expect(source.match(/toolResultsThisTurn\.push\(/g) ?? []).toHaveLength(0)
    expect(source).toMatch(/private recordToolOutcome\(/)
    // …and the one write path writes both, in the same statement pair.
    expect(source).toMatch(/turnResults\.push\(outcome\)\r?\n\s*this\.recentToolOutcomes\.push\(/)
  })
})

// ─── Behavioural: a real loop, a real refusal, a real restriction ───

const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-s5-reach-'))
afterAll(() => {
  fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
})

function defaultCapabilities(): ModelCapabilities {
  return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
}

function mockProvider(gens: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = gens[callIdx++]
      if (gen) yield* gen()
    },
  }
}

/** A turn that calls Bash while the run is pinned to Read — refused before it runs. */
function callsBash(n: number) {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: `m${n}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${n}`, name: 'Bash', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"command":"ls ${n}"}` } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_stop' } as any
  }
}

/** One turn carrying `n` Bash calls at once, so the window fills inside a turn. */
function callsBashNTimes(n: number) {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'many', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < n; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `many${i}`, name: 'Bash', input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: `{"command":"ls ${i}"}` } } as any
      yield { type: 'content_block_stop', index: i } as any
    }
    yield { type: 'message_stop' } as any
  }
}

/** A turn that calls Read on a file that exists — the call runs and succeeds. */
function readsFile(file: string) {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'ok', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ok1', name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: file }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_stop' } as any
  }
}

function* silence(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'end', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any
}

function testLoop(gens: Array<() => Generator<StreamEvent>>): ConversationLoop {
  return new ConversationLoop({
    cwd: TEST_CWD,
    config: {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto', temperature: 0.7,
      maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, noScouts: true,
      approveAll: true,
    } as LocalCodeConfig,
    provider: mockProvider(gens),
    emit: () => {},
    allowedTools: ['Read'],
  })
}

describe('a doom loop in a real session reaches the rules that name it', () => {
  it('three refused Bash calls become three failures S5 can read', async () => {
    const loop = testLoop([callsBash(1), callsBash(2), callsBash(3), silence])
    await loop.handleUserMessage('run ls')

    const history = loop.getRecentToolResults()
    expect(history.filter(r => r.tool === 'Bash' && !r.success)).toHaveLength(3)

    // The point of recording it: the rules that were unreachable now fire.
    const decision = await new RuleBasedS5().decide({ ...quiet(), recentToolResults: history })
    expect(decision.ruleIds).toContain('C2')
    expect(decision.ruleIds).toContain('C4')
    expect(decision.tools, 'the tool that failed three times must be excluded').not.toContain('Bash')
  })

  it('a call that worked is recorded as one, so success is evidence too', async () => {
    // Without this, `success: false` for every outcome is indistinguishable from
    // the truth — a history of nothing but failures satisfies C2 and C4 just as
    // well. C6 ranks BY success rate, so a window that cannot record a success
    // ranks every tool equally and is back on the degraded arm it started on.
    const file = path.join(TEST_CWD, 'note.txt')
    fs.writeFileSync(file, 'hello\n')
    const loop = testLoop([readsFile(file), silence])
    await loop.handleUserMessage('read the note')

    const reads = loop.getRecentToolResults().filter(r => r.tool === 'Read')
    expect(reads, 'the Read call never reached the window at all').toHaveLength(1)
    expect(reads[0].success, 'a call that succeeded was recorded as a failure').toBe(true)
  })

  it('the window is bounded by the size it declares', async () => {
    // The field is read every turn for the life of the process. Unbounded, it
    // holds evidence about a tool the model fixed hundreds of calls ago — the
    // failure mode RECENT_TOOL_WINDOW's own comment claims to prevent.
    const declared = Number(source.match(/const RECENT_TOOL_WINDOW = (\d+)/)?.[1])
    expect(declared, 'the window size must be declared in one named place').toBeGreaterThan(0)

    const loop = testLoop([callsBashNTimes(declared + 5), silence])
    await loop.handleUserMessage('run ls a lot')

    expect(loop.getRecentToolResults()).toHaveLength(declared)
  })

  it('the window is a copy, so a rule cannot rewrite the loop\'s history', () => {
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { baseUrl: 'http://x', model: 'test', tier: 'auto', temperature: 0.7, maxOutputTokens: 10, timeout: 1000, contextLength: 1000, noScouts: true } as LocalCodeConfig,
      provider: mockProvider([silence]),
      emit: () => {},
    })
    const a = loop.getRecentToolResults()
    a.push({ tool: 'Injected', success: true })
    expect(loop.getRecentToolResults()).toHaveLength(0)
  })
})
