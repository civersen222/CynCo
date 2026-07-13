import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// @ts-ignore — untyped harness module
import { createMissionCollector } from '../../../scripts/cynco-ledger.mjs'

// ── Gate ─────────────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/s4Live.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// ── Harness helpers (mirror predictionsLive.test.ts) ─────────────────────────

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — routing pre-call
    // would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume scripted responses
    // before the main loop runs.
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
      // Crisp failure instead of silent empty stream — script exhaustion must
      // be loud so alignment errors are surfaced immediately.
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

// ── Gated proving test: S4 reflection fires, scores land in ledger ─────────

describe('S4 reflection plumbing — loop level (gated: CYNCO_INTEGRATION=1)', () => {
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
    tempFile = path.join(os.tmpdir(), `cynco-s4-live-${Date.now()}.txt`)
    fs.writeFileSync(tempFile, 'hello s4 reflection world\nsecond line for good measure\n')

    // Stub global fetch so the S4 sideQuery (which calls Ollama /api/chat
    // directly, bypassing the mock provider) returns a parseable score
    // response instead of failing with a network error.
    // Shape mirrors Ollama /api/chat non-streaming response. Any URL other
    // than the sideQuery chat call or S2's harmless /api/ps poll throws —
    // accidental interceptions must fail loudly, not pass vacuously.
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url)
      if (u.includes('/api/chat')) {
        return new Response(
          JSON.stringify({
            message: { content: 'Progress: 7\nConfidence: 6\nTool Quality: 8\nStuckness: 2' },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/api/ps')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      throw new Error(`s4Live fetch stub intercepted unexpected URL: ${u}`)
    })
  })

  afterEach(() => {
    fs.rmSync(tempFile, { force: true })
    vi.unstubAllGlobals()
  })

  it.skipIf(SKIP)('scripted session fires S4 reflection at turn 3, scores land in governance.status and the ledger turn record', async () => {
    // Dynamically import to avoid blowing up the un-gated suite.
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const filePath = tempFile.replace(/\\/g, '/')
    const events: any[] = []

    // Timeline (S4 reflection fires at the TOP of the iteration, before the
    // model call; frequency is set to 3 so it fires at iteration 3, i.e. i=2,
    // i+1=3, 3%3===0):
    //
    //   iter 1 (i=0): no reflection; provider call → toolCall Read → execute → governance.status
    //   iter 2 (i=1): no reflection; provider call → toolCall Read → execute → governance.status
    //   iter 3 (i=2): REFLECTION fires → sideQuery hits stubbed fetch → scores recorded;
    //                 provider call → textResponse done → governance.status (WITH scores)
    //
    // The sideQuery consumes the stubbed fetch, NOT a scripted provider response.
    // Spare done-texts follow in case governance nudges add extra model calls.
    const doneText = 'task complete — the file was read and the s4 reflection has been verified; all done.'
    const responses: Array<() => Generator<StreamEvent>> = [
      () => toolCall(1, 'Read', { file_path: filePath }),
      () => toolCall(2, 'Read', { file_path: filePath }),
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

    // Lower reflector frequency to 3 (minimum) so the reflection fires at
    // iteration 3 within a single handleUserMessage call.
    // getGovernance() → CyberneticsGovernance; getReflector() → S4Reflector.
    loop.getGovernance().getReflector().setFrequency(3)

    // User message classifies as file_operation (contains "read" and "file").
    await loop.handleUserMessage('please read that file and report what you find')

    // The loop must not have been halted by the kill switch — if it was, the
    // scripted Reads are failing (temp file setup broken).
    const halted = events.filter((e: any) => e.type === 'message.complete' && e.stopReason === 'halted')
    expect(halted.length).toBe(0)

    // Every governance.status event must carry the s4 snapshot (Task 2 wired it).
    const statusEvents = events.filter((e: any) => e.type === 'governance.status')
    expect(statusEvents.length).toBeGreaterThan(0)
    for (const s of statusEvents) expect((s as any).s4).toBeDefined()

    // The last status event should carry scores from the reflection that fired
    // at iteration 3. The stub is deterministic, so assert the exact values —
    // this pins the fetch→parseResponse path (a deriveFromMetrics fallback
    // would record different scores and fail here, as it should).
    const last = statusEvents[statusEvents.length - 1] as any
    expect(last.s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })
    expect(last.s4.composite).toBeCloseTo(7.25) // (7+6+8+(10-2))/4
    expect(last.s4.reflectionCount).toBeGreaterThanOrEqual(1)
    // classifyTask: "read"/"file" → file_operation, complexity 2 (deterministic).
    expect(last.s4.taskType).toBe('file_operation')
    expect(last.s4.taskComplexity).toBe(2)

    // And it lands in a ledger turn record via the real collector.
    const collector = createMissionCollector(() => 1000)
    for (const e of events) collector.ingest(e)
    const lastTurn = collector.turns[collector.turns.length - 1]
    expect(lastTurn.s4).not.toBeNull()
    expect(lastTurn.s4.scores).not.toBeNull()
  }, 60000)
})
