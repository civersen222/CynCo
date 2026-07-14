import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { HaltedError } from '../../cybernetics-core/src/algedonic/index.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

// ── Layer 2 gate ────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/algedonicLive.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

// Layer 2 imports (evaluated lazily so they don't blow up the un-gated suite)
import type { StreamEvent } from '../../types.js'
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'

// ── Layer 1: Un-gated governance-level tests ─────────────────────────────────

describe('algedonic live wiring — governance level (un-gated)', () => {
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

// ── Layer 2: Gated integration tests through a real ConversationLoop ─────────

describe('algedonic live wiring — loop level (gated: CYNCO_INTEGRATION=1)', () => {
  // Reset the global contract singleton between tests. It persists as a module-level
  // object; auto-creation in handleUserMessage creates a "pending" assertion that
  // the mock provider can never satisfy, causing contract enforcement to block exit.
  // Disabling enforcement lets end_turn propagate cleanly.
  let tempDir = ''

  beforeEach(() => {
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)
    // Loop cwd — the constructor initSnapshot()s its cwd; a temp dir keeps
    // tests from staging the repo root into the live .cynco-snapshots/ (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-algedonic-live-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
  })

  it.skipIf(SKIP)('Test A — 5 consecutive Read failures halt the loop with stopReason=halted', async () => {
    // Dynamically import to avoid blowing up the un-gated suite
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []

    const responses: Array<() => Generator<StreamEvent>> = [
      () => toolCall(0, 'Read', { file_path: 'C:/nonexistent-algedonic-0.txt' }),
      () => toolCall(1, 'Read', { file_path: 'C:/nonexistent-algedonic-1.txt' }),
      () => toolCall(2, 'Read', { file_path: 'C:/nonexistent-algedonic-2.txt' }),
      () => toolCall(3, 'Read', { file_path: 'C:/nonexistent-algedonic-3.txt' }),
      () => toolCall(4, 'Read', { file_path: 'C:/nonexistent-algedonic-4.txt' }),
      () => toolCall(5, 'Read', { file_path: 'C:/nonexistent-algedonic-5.txt' }),
      () => toolCall(6, 'Read', { file_path: 'C:/nonexistent-algedonic-6.txt' }),
      () => toolCall(7, 'Read', { file_path: 'C:/nonexistent-algedonic-7.txt' }),
    ]

    const provider = mockProvider(responses, { lenient: true })

    const loop = new ConversationLoop({
      cwd: tempDir,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('read those files')

    const completes = events.filter((e: any) => e.type === 'message.complete')
    expect(completes.length).toBe(1)
    expect(completes[0].stopReason).toBe('halted')
    // Kill switch trips after 5 pain signals; nudges or context checks may consume
    // a few extra scripted responses but should not need all 8.
    expect(provider.callCount()).toBeLessThanOrEqual(8)
  }, 60000)

  it.skipIf(SKIP)('Test B — 4 Read failures then text response does NOT halt', async () => {
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []

    // 4 failing reads + successful text. The completion phrase "task complete"
    // satisfies the loop's modelSaysDone check, preventing nudge injection.
    const responses: Array<() => Generator<StreamEvent>> = [
      () => toolCall(10, 'Read', { file_path: 'C:/nonexistent-algedonic-10.txt' }),
      () => toolCall(11, 'Read', { file_path: 'C:/nonexistent-algedonic-11.txt' }),
      () => toolCall(12, 'Read', { file_path: 'C:/nonexistent-algedonic-12.txt' }),
      () => toolCall(13, 'Read', { file_path: 'C:/nonexistent-algedonic-13.txt' }),
      () => textResponse('task complete — no halt triggered; the four reads failed but the streak never reached five.'),
    ]

    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      cwd: tempDir,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('read those files')

    const completes = events.filter((e: any) => e.type === 'message.complete')
    const halted = completes.filter((e: any) => e.stopReason === 'halted')
    expect(halted.length).toBe(0)
    // Positive: loop completed normally with exactly one end_turn completion
    expect(completes.length).toBe(1)
    expect(completes[0].stopReason).toBe('end_turn')
  }, 60000)
})
