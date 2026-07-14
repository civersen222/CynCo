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

import type { StreamEvent } from '../../types.js'
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'

// ── Gated proving test: S4 reflection fires, scores land in ledger ─────────

describe('S4 reflection plumbing — loop level (gated: CYNCO_INTEGRATION=1)', () => {
  let tempDir = ''
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
    // Own temp DIR: passed as the loop cwd so the constructor's initSnapshot
    // never stages the repo root into the live .cynco-snapshots/ (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-s4-live-'))
    tempFile = path.join(tempDir, 's4-target.txt')
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
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
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
      cwd: tempDir,
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

    // P1.5 wire-proof: every per-turn status carries the windowed series.
    const govStatuses = events.filter((e: any) => e.type === 'governance.status')
    expect(govStatuses.length).toBeGreaterThanOrEqual(1)
    for (const g of govStatuses) expect(typeof g.varietyWindowed).toBe('number')

    // P1.6 wire-proof: every per-turn status carries the heterarchy state.
    for (const g of govStatuses) {
      expect(typeof g.heterarchy?.commander).toBe('string')
      expect(typeof g.heterarchy?.context).toBe('string')
      expect(typeof g.heterarchy?.shifted).toBe('boolean')
    }
  }, 60000)
})
