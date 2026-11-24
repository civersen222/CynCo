import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { HaltedError } from '../../cybernetics-core/src/algedonic/index.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
import type { StreamEvent } from '../../types.js'
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'

// ── Layer 1: governance-level tests ──────────────────────────────────────────

describe('algedonic live wiring — governance level', () => {
  // Ensure ablation env var is absent so the constructor sees it as false.
  // resetEventBus() gives each test a fresh bus — the singleton is shared
  // across the module, so event counts would otherwise accumulate.
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
  })

  it('5 consecutive tool failures trip the kill switch; checkOrHalt throws', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Bash', false, 100, undefined, { command: `cmd-${i}` })
    }
    expect(() => gov.checkOrHalt()).toThrow(HaltedError)
  })

  it('4 failures + 1 success resets the streak; no halt', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 4; i++) {
      gov.onToolResult('Bash', false, 100, undefined, { command: `cmd-${i}` })
    }
    gov.onToolResult('Read', true, 50, undefined, { file_path: 'ok.txt' })
    gov.onToolResult('Bash', false, 100, undefined, { command: 'cmd-after' })
    expect(() => gov.checkOrHalt()).not.toThrow()
  })

  it('resetKillSwitch clears an active halt', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Bash', false, 100, undefined, { command: `cmd-${i}` })
    }
    expect(() => gov.checkOrHalt()).toThrow(HaltedError)
    gov.resetKillSwitch()
    expect(() => gov.checkOrHalt()).not.toThrow()
  })
})

// ── Layer 2: through a real ConversationLoop with a scripted model ───────────
//
// No service is involved: the loop writes to a temp folder and the suite's temp
// CYNCO_HOME, and the suite's setup refuses fetch to this machine's service
// ports. Until 2026-11-24 this layer sat behind CYNCO_INTEGRATION, where both
// tests had gone stale unseen.
//
// The scripted failures must be ones the loop still COUNTS, each in its own
// model call, and every call must still be offered by the gates in front of it:
// - a path that does not exist is no failure at all (F178, `benignWrongPath`),
//   so the failures are an Edit whose old_string is not in an existing file and
//   a Bash command that exits non-zero;
// - ToolGating withholds a tool used four calls in a row (Read is attenuable,
//   Bash is not) and the trust score withholds a tool after three scored
//   failures, and a withheld call is a governance denial, neutral for the kill
//   switch: so the two tools alternate and neither fails three times before
//   the fifth call.

/** One model call per scripted failure: [Bash, Edit, Bash, Edit, Bash, ...]. */
function countedFailure(i: number, target: string): () => Generator<StreamEvent> {
  return i % 2 === 0
    ? () => toolCall(i, 'Bash', { command: `exit ${3 + i}` })
    : () => toolCall(i, 'Edit', { file_path: target, old_string: `not in the file ${i}`, new_string: 'x' })
}

describe('algedonic live wiring — loop level', () => {
  const fileHome = process.env.CYNCO_HOME
  let tempDir = ''
  let target = ''
  let testHome = ''

  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    // A CynCo home of each test's own. The loop loads the trust score from
    // <home>/tool-scores.json when it is built and saves it after every
    // message, so with one home per file Test B's four failures reach Test A's
    // scorer whenever B runs first, and A's calls come back as governance
    // denials (the hazard bridge/batchDecision.test.ts guards the same way).
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-algedonic-home-'))
    process.env.CYNCO_HOME = testHome
    // Contract enforcement off for the whole turn. Switching it off on an empty
    // contract does not hold: the loop auto-creates a contract from the user
    // message and ContractState.create() switches enforcement back on
    // (193299fe), and its enforcement rounds then ask the scripted model for
    // more turns. The loop keeps a live, incomplete contract instead of
    // auto-creating one, so this one, with enforcement off after it was made,
    // holds (the pattern of bridge/operatorNoteWiring.test.ts).
    globalContract.clear()
    globalContract.create('algedonic live', 'algedonic live', ['never checked by this test'])
    globalContract.setEnforcementEnabled(false)
    // Loop cwd — the constructor initSnapshot()s its cwd; a temp dir keeps
    // tests from staging the repo root into the live .cynco-snapshots/ (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-algedonic-live-'))
    target = path.join(tempDir, 'algedonic-target.txt').replace(/\\/g, '/')
    fs.writeFileSync(target, 'alpha\nbeta\n')
  })

  afterEach(() => {
    globalContract.clear()
    vi.restoreAllMocks()
    process.env.CYNCO_HOME = fileHome
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
    // testHome is kept, like the suite's own home (setup/cyncoHome.ts): the
    // loop has no close, its governance database stays open in the home until
    // the worker exits, and removing the folder here fails with EPERM on Windows.
  })

  it('Test A — 5 consecutive counted tool failures halt the loop with stopReason=halted', async () => {
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []
    const responses: Array<() => Generator<StreamEvent>> = [0, 1, 2, 3, 4].map(i => countedFailure(i, target))
    // Spares: a halt that came late would consume these and fail on the call
    // count below, instead of failing on an exhausted script.
    for (let i = 5; i < 8; i++) responses.push(countedFailure(i, target))
    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      cwd: tempDir,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })
    const results = vi.spyOn(loop.getGovernance(), 'onToolResult')

    await loop.handleUserMessage('make those changes')

    // Each of the five calls ran and reached the kill switch as a counted
    // failure: not a denial, not a repeat within one call, not a wrong path.
    expect(results.mock.calls.map(c => [c[0], c[1], c[5]])).toEqual([
      ['Bash', false, undefined], ['Edit', false, undefined], ['Bash', false, undefined],
      ['Edit', false, undefined], ['Bash', false, undefined],
    ])
    const completes = events.filter((e: any) => e.type === 'message.complete')
    expect(completes.length).toBe(1)
    expect(completes[0].stopReason).toBe('halted')
    // The halt is checked at the top of the iteration after the fifth failure:
    // no sixth model call.
    expect(provider.callCount()).toBe(5)
  }, 60000)

  it('Test B — 4 counted tool failures then text response does NOT halt', async () => {
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []
    // 4 counted failures + text. The completion phrase "task complete"
    // satisfies the loop's modelSaysDone check, preventing nudge injection.
    const responses: Array<() => Generator<StreamEvent>> = [0, 1, 2, 3].map(i => countedFailure(i, target))
    responses.push(() => textResponse('task complete — no halt triggered; the four calls failed but the streak never reached five.'))
    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      cwd: tempDir,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })
    const results = vi.spyOn(loop.getGovernance(), 'onToolResult')

    await loop.handleUserMessage('make those changes')

    // Four counted failures reached the kill switch — one short of its threshold.
    expect(results.mock.calls.map(c => [c[0], c[1], c[5]])).toEqual([
      ['Bash', false, undefined], ['Edit', false, undefined],
      ['Bash', false, undefined], ['Edit', false, undefined],
    ])
    const completes = events.filter((e: any) => e.type === 'message.complete')
    const halted = completes.filter((e: any) => e.stopReason === 'halted')
    expect(halted.length).toBe(0)
    // Positive: loop completed normally with exactly one end_turn completion
    expect(completes.length).toBe(1)
    expect(completes[0].stopReason).toBe('end_turn')
    expect(provider.callCount()).toBe(5)
  }, 60000)
})
