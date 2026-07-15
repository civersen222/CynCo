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
    verificationDetails: [] as (string | undefined)[],
  }
  const loop = {
    setApproveAll: (v: boolean) => { calls.setApproveAll.push(v) },
    handleUserMessage: async (text: string) => { calls.handleUserMessage.push(text) },
    getGovernanceReport: () => ({ stuckTurns: 0 }),
    buildHandoff: () => ({ files_modified: ['hello.py'] }),
    reportVerification: (passed: boolean, detail?: string) => {
      calls.verifications.push(passed)
      calls.verificationDetails.push(detail)
    },
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
let prevEmbedBaseUrl: string | undefined

beforeEach(() => {
  // Stub embed endpoint to an unroutable port — instant connection refusal,
  // no live Ollama calls, truly hermetic.
  prevEmbedBaseUrl = process.env.LOCALCODE_EMBED_BASE_URL
  process.env.LOCALCODE_EMBED_BASE_URL = 'http://127.0.0.1:9'

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-int-'))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevEmbedBaseUrl === undefined) {
    delete process.env.LOCALCODE_EMBED_BASE_URL
  } else {
    process.env.LOCALCODE_EMBED_BASE_URL = prevEmbedBaseUrl
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
})

// ─── Full chain ─────────────────────────────────────────────────

describe('VibeController chain', () => {
  it('start in an empty dir transitions idle→understand and asks the opening question', async () => {
    const events: any[] = []
    const { loop } = fakeLoop()
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')

    const transition = events.find(e => e.type === 'vibe.state_changed')
    expect(transition).toMatchObject({ fromState: 'idle', to: 'understand' })
    const q = events.find(e => e.type === 'vibe.question')
    expect(q.text).toContain('What would you like to build')
    expect(ctrl.state).toBe('understand')
  })

  it('a substantive answer triggers BUILD: delegation, handoff files, verification, report', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')
    // Phase 6a: a substantive directive now confirms understanding first.
    expect(ctrl.state).toBe('teachback')
    expect(calls.handleUserMessage).toHaveLength(0)
    await ctrl.handleAnswer('teachback', 'yes, build it')

    // BUILD delegated exactly once, with the build-prompt contract
    expect(calls.handleUserMessage).toHaveLength(1)
    expect(calls.handleUserMessage[0]).toContain('Build the following')
    // Approvals: on at start (controller.ts:109), re-asserted for build
    // (:567), off after (:574) — exact sequence so a dropped re-assert
    // or missing reset fails loudly
    expect(calls.setApproveAll).toEqual([true, true, false])
    // Goal verification passed → pleasure signal
    expect(calls.verifications).toEqual([true])
    // State machine reached build then report
    const states = events.filter(e => e.type === 'vibe.state_changed').map(e => e.to)
    expect(states).toContain('build')
    expect(states).toContain('report')
    // Report carries buildHandoff().files_modified — the uncertain contract
    const report = events.find(e => e.type === 'vibe.task_complete')
    expect(report.filesChanged).toEqual(['hello.py'])
    expect(report.analogy).toContain('Think of it like')
    expect(report.suggestion).toBe('Add a lock to the door.')
    // State file persisted for cross-session continuity
    expect(fs.existsSync(path.join(tmpDir, '.cynco-state.md'))).toBe(true)
  })

  it('short picks continue Q&A with confidence updates until READY', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    let questionCalls = 0
    const { fn } = scriptedSideQuery({
      'clarifying question': () => {
        questionCalls++
        return questionCalls === 1
          ? 'What color should it be?\nA) Red\nB) Blue'
          : 'READY'
      },
    })
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'A')   // short pick → LLM question comes back

    const q = events.find(e => e.type === 'vibe.question' && e.text.includes('What color'))
    expect(q).toBeDefined()
    expect(q.options).toEqual(['Red', 'Blue', 'Something else (type below)'])
    expect(events.some(e => e.type === 'vibe.confidence_update')).toBe(true)
    expect(calls.handleUserMessage).toHaveLength(0)   // still understanding

    await ctrl.handleAnswer(q.questionId, 'B')        // → READY → teachback
    expect(ctrl.state).toBe('teachback')
    expect(calls.handleUserMessage).toHaveLength(0)
    await ctrl.handleAnswer('teachback', 'yes, build it')  // → build
    expect(calls.handleUserMessage).toHaveLength(1)
  })

  it('stuck governance escalates; escalation_response fix re-builds', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop({ getGovernanceReport: () => ({ stuckTurns: 3 }) })
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')
    await ctrl.handleAnswer('teachback', 'yes, build it')

    const esc = events.find(e => e.type === 'vibe.escalation')
    expect(esc).toBeDefined()
    expect(esc.problem).toBe('The build hit a wall')
    expect(esc.tried).toEqual(['A', 'B'])
    expect(esc.requestId).toMatch(/^esc-/)
    expect(events.some(e => e.type === 'vibe.task_complete')).toBe(false)

    const buildsBefore = calls.handleUserMessage.length
    await ctrl.handleEscalationResponse(esc.requestId, 'fix')
    expect(calls.handleUserMessage.length).toBeGreaterThan(buildsBefore)
    // The fix path reuses the build-prompt contract
    expect(calls.handleUserMessage[calls.handleUserMessage.length - 1]).toContain('Build the following')
  })

  it('verification FAIL steers a fix build and reports a pain signal', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Verify 3 levels': 'FAIL: hello.py never prints' })
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')
    await ctrl.handleAnswer('teachback', 'yes, build it')

    expect(calls.verifications).toEqual([false])
    // Build + steered fix build
    expect(calls.handleUserMessage).toHaveLength(2)
    expect(calls.handleUserMessage[1]).toContain('VERIFICATION FAILED')
  })
})

// ─── Timeout ────────────────────────────────────────────────────

describe('sideQuery timeout', () => {
  it('falls back to the generic question instead of hanging forever', async () => {
    const events: any[] = []
    const { loop } = fakeLoop()
    let invokedAt = 0
    const hangingSideQuery = () => {
      if (!invokedAt) invokedAt = Date.now()
      return new Promise<string>(() => { /* never resolves */ })
    }
    const ctrl = new VibeController({
      emit: (e) => events.push(e),
      sideQuery: hangingSideQuery,
      loop,
      timeoutMs: 50,
    })

    await ctrl.start('new')                    // empty dir: no sideQuery needed
    events.length = 0
    await ctrl.handleAnswer('q-1', 'B')        // short pick → generateQuestion → hang → timeout
    // Hermetic harness (embed endpoint stubbed to refuse instantly), so this
    // bound only has to absorb the 50ms timeout + test overhead.
    expect(invokedAt).toBeGreaterThan(0)
    expect(Date.now() - invokedAt).toBeLessThan(1500)

    const fallback = events.find(e => e.type === 'vibe.question')
    expect(fallback).toBeDefined()
    expect(fallback.text).toContain('Can you tell me more')
  })
})
