import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// The ledger collector is a plain .mjs module used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { createMissionCollector } from '../../../scripts/cynco-ledger.mjs'

// ── Gate ─────────────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/predictionsLive.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// ── Harness helpers (mirror algedonicLive.test.ts / conversationLoop.test.ts) ─

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — the routing
    // pre-call would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume the mock provider's
    // scripted responses before the main loop runs.
    noScouts: true,
    approveAll: true,
  }
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      // Crisp failure instead of a silent empty stream → nudge spiral: this
      // test's script length is load-bearing, so exhaustion must be loud.
      if (!gen) throw new Error(`mock provider script exhausted at call ${callIdx}`)
      yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function* toolCall(i: number, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: `m${i}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${i}`, name, input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

// ── Gated proving test: H4 opens, completes, and lands in a ledger turn ──────

describe('prediction plumbing — loop level (gated: CYNCO_INTEGRATION=1)', () => {
  let tempFile = ''

  beforeEach(() => {
    // Ablation env var must be absent so CyberneticsGovernance activates.
    delete process.env._ABLATION_VSM_DISABLED
    // Fresh event bus per test — the singleton accumulates otherwise.
    resetEventBus()
    // Reset the global contract singleton: auto-created "pending" assertions
    // can never be satisfied by the mock provider and would block end_turn.
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)

    // Real temp file so the scripted Reads SUCCEED — 5 consecutive tool
    // failures would trip the algedonic kill switch and halt the loop.
    tempFile = path.join(os.tmpdir(), `cynco-predictions-live-${Date.now()}.txt`)
    fs.writeFileSync(tempFile, 'hello prediction world\nsecond line for good measure\n')
  })

  afterEach(() => {
    fs.rmSync(tempFile, { force: true })
  })

  it.skipIf(SKIP)('scripted session opens H4 (3 consecutive Reads) and a completed prediction lands in governance.status and the ledger turn record', async () => {
    // Dynamically import to avoid blowing up the un-gated suite
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const filePath = tempFile.replace(/\\/g, '/')
    const events: any[] = []

    // The read-loop gate DENIES a third same-file Read within one user turn
    // (the deny path returns before trackReadPattern), so consecutiveReads
    // caps at 2 inside a single handleUserMessage. handleUserMessage resets
    // the gate but governance (turnCount, read counter, PredictionTracker)
    // persists — so a two-user-turn session reaches 3 legitimately.
    //
    // Timeline (onTurnComplete runs at each message_stop BEFORE that
    // iteration's tool executes; turnCount increments there):
    //   User turn 1:
    //     iter 1: turn=1, then Read tempFile          → consecutiveReads=1
    //     iter 2: turn=2, then Read tempFile (warn)   → consecutiveReads=2
    //     iter 3: turn=3, done-text ends the turn
    //   User turn 2 (gate reset; counter persists at 2):
    //     iter 1: turn=4, then Read tempFile          → consecutiveReads=3
    //     iter 2: turn=5 → H4 OPENS (trigger=5, window=2, due turn 7); then Edit
    //     iter 3: turn=6 (6 < 7, still open); then Read keeps the loop alive
    //     iter 4: turn=7 → evaluateOpen COMPLETES H4; done-text ends the turn
    // Spare done-texts follow in case governance nudges add extra model calls.
    const doneText = 'task complete — the file was read three times and edited; the prediction window has elapsed.'
    const responses: Array<() => Generator<StreamEvent>> = [
      // user turn 1
      () => toolCall(1, 'Read', { file_path: filePath }),
      () => toolCall(2, 'Read', { file_path: filePath }),
      () => textResponse(doneText),
      // user turn 2
      () => toolCall(3, 'Read', { file_path: filePath }),
      () => toolCall(4, 'Edit', { file_path: filePath, old_string: 'hello', new_string: 'hola' }),
      () => toolCall(5, 'Read', { file_path: filePath }),
      () => textResponse(doneText),
      () => textResponse(doneText),
      () => textResponse(doneText),
    ]

    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('read that file a couple of times')
    await loop.handleUserMessage('read it once more then edit it')

    // The loop must not have been halted by the kill switch — if it was, the
    // scripted Reads are failing (temp file setup broken).
    const completes = events.filter((e: any) => e.type === 'message.complete')
    const halted = completes.filter((e: any) => e.stopReason === 'halted')
    expect(halted.length).toBe(0)

    // Every governance.status event carries the predictions snapshot.
    const statusEvents = events.filter((e: any) => e.type === 'governance.status')
    expect(statusEvents.length).toBeGreaterThan(0)
    for (const s of statusEvents) expect((s as any).predictions).toBeDefined()

    // H4 specifically completed (evaluated either way — correctness is not
    // asserted): an unrelated hypothesis completing must not mask an H4 miss.
    const last = statusEvents[statusEvents.length - 1] as any
    expect(last.predictions.completed).toBeGreaterThanOrEqual(1)
    expect(last.predictions.stats.some((s: any) => s.hypothesis === 'H4' && s.total >= 1)).toBe(true)

    // And it lands in a ledger turn record via the real collector.
    const collector = createMissionCollector(() => 1000)
    for (const e of events) collector.ingest(e)
    expect(collector.turns.length).toBeGreaterThan(0)
    const lastTurn = collector.turns[collector.turns.length - 1]
    expect(lastTurn.predictions).toBeDefined()
    expect(lastTurn.predictions.completed).toBeGreaterThanOrEqual(1)
  }, 60000)
})
