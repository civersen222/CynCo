// engine/__tests__/vibe/controllerIntegration.test.ts
// Integration tests for the VibeController chain with a fake ConversationLoop
// and a scripted sideQuery — no model, no network.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VibeController } from '../../vibe/controller.js'
import type { ConversationLoop } from '../../bridge/conversationLoop.js'

// ─── Harness ────────────────────────────────────────────────────

/** Fake ConversationLoop recording every call the controller makes. */
function fakeLoop(overrides: Record<string, any> = {}) {
  const calls = {
    handleUserMessage: [] as string[],
    setApproveAll: [] as boolean[],
    verifications: [] as boolean[],
  }
  const loop = {
    setApproveAll: (v: boolean) => { calls.setApproveAll.push(v) },
    handleUserMessage: async (text: string) => { calls.handleUserMessage.push(text) },
    getGovernanceReport: () => ({ stuckTurns: 0 }),
    buildHandoff: () => ({ files_modified: ['hello.py'] }),
    reportVerification: (passed: boolean) => { calls.verifications.push(passed) },
    ...overrides,
  }
  return { loop: loop as unknown as ConversationLoop, calls }
}

/** Scripted sideQuery dispatching on prompt markers used by controller.ts. */
function scriptedSideQuery(overrides: Record<string, string | ((p: string) => string)> = {}) {
  const calls: string[] = []
  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt)
    for (const [marker, reply] of Object.entries(overrides)) {
      if (prompt.includes(marker)) return typeof reply === 'function' ? reply(prompt) : reply
    }
    if (prompt.includes('Answer YES or NO')) return 'NO'          // shouldResearch
    if (prompt.includes('Verify 3 levels')) return 'PASS'          // goal verification
    if (prompt.includes('relatable analogy')) return 'Think of it like a new door on your house.'
    if (prompt.includes('next step')) return 'Add a lock to the door.'
    if (prompt.includes('got stuck')) return 'problem: The build hit a wall\ntried1: A\ntried2: B\nproposal: Try again'
    if (prompt.includes('clarifying question')) return 'READY'
    return 'READY'
  }
  return { fn, calls }
}

// Controller writes .cynco-plan.md / .cynco-state.md into process.cwd() and
// scanProject() walks it — every test MUST run inside an empty temp dir.
const prevCwd = process.cwd()
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-int-'))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
})

// ─── Timeout ────────────────────────────────────────────────────

describe('sideQuery timeout', () => {
  it('falls back to the generic question instead of hanging forever', async () => {
    const events: any[] = []
    const { loop } = fakeLoop()
    const hangingSideQuery = () => new Promise<string>(() => { /* never resolves */ })
    const ctrl = new VibeController({
      emit: (e) => events.push(e),
      sideQuery: hangingSideQuery,
      loop,
      timeoutMs: 50,
    })

    await ctrl.start('new')                    // empty dir: no sideQuery needed
    events.length = 0
    const started = Date.now()
    await ctrl.handleAnswer('q-1', 'B')        // short pick → generateQuestion → hang → timeout
    // Generous bound: proves the 50ms timeout fired (vs 120s default / infinite
    // hang) while absorbing cold-start transform/import cost on first run.
    expect(Date.now() - started).toBeLessThan(4000)

    const fallback = events.find(e => e.type === 'vibe.question')
    expect(fallback).toBeDefined()
    expect(fallback.text).toContain('Can you tell me more')
  })
})
