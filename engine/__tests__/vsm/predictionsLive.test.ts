import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// The ledger collector is a plain .mjs module used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { createMissionCollector } from '../../../scripts/cynco-ledger.mjs'

import type { StreamEvent } from '../../types.js'
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'

// ── Proving test: H4 opens, completes, and lands in a ledger turn ────────────
// A real loop driven by a scripted model; no live service is reached (the
// suite's setup refuses fetch to this machine's service ports).

describe('prediction plumbing — loop level', () => {
  let tempDir = ''
  let tempFile = ''

  beforeEach(() => {
    // Ablation env var must be absent so CyberneticsGovernance activates.
    delete process.env._ABLATION_VSM_DISABLED
    // Fresh event bus per test — the singleton accumulates otherwise.
    resetEventBus()
    // Hold an incomplete contract with enforcement off for the whole session.
    // Auto-created "pending" assertions can never be satisfied by the mock
    // provider, and enforcement would turn each done-text into another model
    // call, eating the next user turn's script. Disabling enforcement BEFORE
    // the first message does not hold: ContractState.create() re-enables it
    // (engine/tools/contract.ts, since 193299fe3) and the loop auto-creates a
    // contract on the first message. An active incomplete contract is kept by
    // maybeAutoCreateContract, so the switch-off holds for both turns.
    globalContract.clear()
    globalContract.create('predictions-live', '', ['scripted session ran to its end'])
    globalContract.setEnforcementEnabled(false)

    // Real temp file so the scripted Reads SUCCEED — 5 consecutive tool
    // failures would trip the algedonic kill switch and halt the loop.
    // Own temp DIR: passed as the loop cwd so the constructor's initSnapshot
    // never stages the repo root into the live .cynco-snapshots/ (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-predictions-live-'))
    tempFile = path.join(tempDir, 'predictions-target.txt')
    fs.writeFileSync(tempFile, 'hello prediction world\nsecond line for good measure\n')
  })

  afterEach(() => {
    globalContract.clear()
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('scripted session opens H4 (3 consecutive Reads) and a completed prediction lands in governance.status and the ledger turn record', async () => {
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
    // Spare done-texts follow: a governance nudge that added a model call would
    // fail on the call count below rather than on an exhausted script.
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
      cwd: tempDir,
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
    // The script and the loop stayed in step: the seven scripted calls of the
    // timeline above were made, each user turn ended on its done-text, and no
    // turn ended in an engine error (an exhausted script ends a turn as one).
    expect(provider.callCount()).toBe(7)
    expect(completes.map((e: any) => e.stopReason)).toEqual(['end_turn', 'end_turn'])
    expect(events.filter((e: any) => e.type === 'session.error')).toEqual([])

    // Every governance.status event carries the predictions snapshot.
    const statusEvents = events.filter((e: any) => e.type === 'governance.status')
    expect(statusEvents.length).toBeGreaterThan(0)
    for (const s of statusEvents) expect((s as any).predictions).toBeDefined()

    // The dashboard saw the prediction's whole life: none open in user turn 1,
    // one open from the second iteration of user turn 2 (H4 opening at turn 5),
    // and at the status where it closes, the one completion is H4's. Any other
    // hypothesis opening or completing, or H4 opening late or never, changes
    // this sequence of [open, completed, hypotheses with a completion].
    expect(statusEvents.map((s: any) => [
      s.predictions.open,
      s.predictions.completed,
      s.predictions.stats.filter((h: any) => h.total >= 1).map((h: any) => h.hypothesis),
    ])).toEqual([
      [0, 0, []], [0, 0, []], [0, 0, []], [0, 0, []],
      [1, 0, []], [1, 0, []],
      [0, 1, ['H4']],
    ])

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
