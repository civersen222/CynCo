import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
// @ts-ignore — untyped harness module
import { createMissionCollector, buildMissionRecord } from '../../../scripts/cynco-ledger.mjs'
import { defaultConfig, mockProvider, textResponse, toolCall, rawToolCall } from '../harness/liveHarness.js'
import type { StreamEvent } from '../../types.js'

// ── Gate ─────────────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/phase1Exit.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

// ── Phase 1 exit criterion (STATE-AND-VISION-2026-07-12.md, Phase 1 Exit) ────
// "a scripted 12-turn test session produces a ledger record containing:
//  ≥1 algedonic signal, ≥1 opened-and-evaluated prediction, persisted S4
//  scores, ≥1 snapshot hash, windowed-variety series, heterarchy context
//  series; plus a tool-call transport test where a deliberately malformed
//  call is repaired or retried, never silently discarded."
// The four per-item live tests prove each nerve separately; this test proves
// they coexist in ONE session and land in ONE buildMissionRecord() record.

describe('Phase 1 exit gate — combined scripted session (gated: CYNCO_INTEGRATION=1)', () => {
  let tempDir = ''
  let tempFile = ''
  let outFile = ''

  beforeEach(() => {
    // Ablation env var must be absent so CyberneticsGovernance activates.
    delete process.env._ABLATION_VSM_DISABLED
    // Fresh event bus per test — the singleton accumulates otherwise.
    resetEventBus()
    // Reset the global contract singleton: auto-created "pending" assertions
    // can never be satisfied by the mock provider and would block end_turn.
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)

    // Real temp file so scripted Reads SUCCEED (5 consecutive failures would
    // halt the loop). Own temp DIR as loop cwd so the constructor's
    // initSnapshot never stages the repo root (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-phase1-exit-'))
    tempFile = path.join(tempDir, 'exit-target.txt')
    outFile = path.join(tempDir, 'exit-output.txt')
    fs.writeFileSync(tempFile, 'hello phase 1 exit gate\nsecond line for good measure\n')

    // Loud URL-guard fetch stub: the S4 sideQuery calls Ollama /api/chat
    // directly (bypassing the mock provider); S2 polls /api/ps. Anything else
    // must fail loudly, not pass vacuously.
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
      throw new Error(`phase1Exit fetch stub intercepted unexpected URL: ${u}`)
    })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
    vi.unstubAllGlobals()
  })

  it.skipIf(SKIP)('one 12-turn session lands all six signals plus a retried malformed call in a single mission record', async () => {
    // Dynamically import to avoid blowing up the un-gated suite.
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const filePath = tempFile.replace(/\\/g, '/')
    const outPath = outFile.replace(/\\/g, '/')
    const missingPath = `${tempDir.replace(/\\/g, '/')}/nonexistent-exit.txt`
    const events: any[] = []

    // Timeline (turn = governance turnCount, increments at each message_stop;
    // S4 reflector frequency set to 3 below):
    //
    //   User turn 1 ("read that file..."):
    //     t1: Read tempFile            → consecutiveReads=1
    //     t2: Read tempFile (warn)     → consecutiveReads=2 (gate denies a 3rd
    //         same-file Read within one user turn — predictionsLive timeline)
    //     t3: done-text; S4 REFLECTION fires at iteration 3 (freq 3) via the
    //         stubbed fetch → scores persist into governance.status
    //   User turn 2 ("read once more then edit") — gate reset, counter persists:
    //     t4: Read tempFile            → consecutiveReads=3
    //     t5: Edit tempFile            → H4 OPENS (trigger=5, window=2, due t7)
    //     t6: Read tempFile            → keeps loop alive, H4 still open
    //     t7: done-text               → evaluateOpen COMPLETES H4
    //   User turn 3 ("write the summary; check the other file"):
    //     t8: Write outFile            → after-batch snapshot → snapshot.taken
    //     t9: Read missingPath FAILS   → AlgedonicFired severity=Warning
    //         (streak=1 — nowhere near the 5-failure halt)
    //     t10: Read with raw args '[1,2,3]' — valid JSON but not an object, so
    //          JSON.parse AND jsonrepair both reject it → callModel marks the
    //          block __malformed → conversationLoop emits toolcall.transport
    //          stage 'retried' and feeds an error-feedback tool result
    //     t11: done-text (the "re-issued" call after the retry feedback)
    //   User turn 4 ("confirm complete"):
    //     t12: done-text               → 12-turn session
    // Spare done-texts follow in case governance nudges add extra model calls.
    const doneText = 'task complete — everything requested has been read, edited, and written; all done.'
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
      // user turn 3
      () => toolCall(6, 'Write', { file_path: outPath, content: 'summary of findings\n' }),
      () => toolCall(7, 'Read', { file_path: missingPath }),
      () => rawToolCall(8, 'Read', '[1,2,3]'),
      () => textResponse(doneText),
      // user turn 4
      () => textResponse(doneText),
      // spares (nudges/context checks may consume extra scripted responses)
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
    // Production re-root path (main.ts user.message handler) — snapshot,
    // executor, and LSP all point at the temp project dir.
    loop.setCwd(tempDir)
    // Minimum reflector frequency so S4 fires within the session.
    loop.getGovernance().getReflector().setFrequency(3)

    await loop.handleUserMessage('please read that file and report what you find')
    await loop.handleUserMessage('read it once more then edit it')
    await loop.handleUserMessage('now write the summary to the output file and check the other one')
    await loop.handleUserMessage('confirm the task is complete')

    // The session must never halt — the single deliberate failure and the
    // malformed call are both below every kill-switch threshold.
    const halted = events.filter((e: any) => e.type === 'message.complete' && e.stopReason === 'halted')
    expect(halted.length).toBe(0)

    // The Write actually landed (the snapshot hash is of a real change).
    expect(fs.readFileSync(outFile, 'utf8')).toBe('summary of findings\n')

    // ── Build the ONE ledger record the exit criterion demands ──────────────
    const collector = createMissionCollector(() => 1000)
    for (const e of events) collector.ingest(e)
    const record = buildMissionRecord(collector, {
      missionId: 'phase1-exit-gate',
      briefFile: null,
      marker: null,
      cwd: tempDir,
      dispatchedAt: 0,
      durationS: 0,
      outcome: 'landed',
    })

    expect(record.turns.length).toBeGreaterThanOrEqual(6) // a real series, not a point
    const lastTurn = record.turns[record.turns.length - 1]

    // 1. ≥1 algedonic signal (cumulative non-Info AlgedonicFired count).
    expect(lastTurn.algedonicAlerts).toBeGreaterThanOrEqual(1)

    // 2. ≥1 opened-and-evaluated prediction — H4 specifically, so an unrelated
    //    hypothesis completing cannot mask an H4 miss.
    expect(lastTurn.predictions.completed).toBeGreaterThanOrEqual(1)
    expect(lastTurn.predictions.stats.some((s: any) => s.hypothesis === 'H4' && s.total >= 1)).toBe(true)

    // 3. Persisted S4 scores (freq-3 reflection through the stubbed sideQuery).
    const s4Turn = record.turns.find((t: any) => t.s4 && t.s4.scores)
    expect(s4Turn).toBeDefined()
    expect(s4Turn.s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })

    // 4. ≥1 snapshot hash (after-batch snapshot of the Write).
    expect(record.turns.some((t: any) => t.snapshot && typeof t.snapshot.hash === 'string')).toBe(true)

    // 5. Windowed-variety series — every turn record carries the number.
    for (const t of record.turns) expect(typeof t.varietyWindowed).toBe('number')

    // 6. Heterarchy context series — every turn record carries the snapshot.
    for (const t of record.turns) {
      expect(typeof t.heterarchy?.context).toBe('string')
      expect(typeof t.heterarchy?.commander).toBe('string')
      expect(typeof t.heterarchy?.shifted).toBe('boolean')
    }

    // 7. Transport: the deliberately malformed call was RETRIED — surfaced to
    //    the ledger, never silently discarded, and never escalated to discard
    //    (a single malformed call is within the one-bounded-retry budget).
    expect(record.toolTransport.some((x: any) => x.stage === 'retried' && x.toolName === 'Read')).toBe(true)
    expect(record.toolTransport.some((x: any) => x.stage === 'discarded')).toBe(false)
  }, 60000)
})
