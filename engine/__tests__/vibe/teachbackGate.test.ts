// engine/__tests__/vibe/teachbackGate.test.ts
// Phase 6a: teachback state + confidence/agreement build gate.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VibeController } from '../../vibe/controller.js'
import type { ConversationLoop } from '../../bridge/conversationLoop.js'

// ─── Harness (copied from controllerIntegration.test.ts) ─────────

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

function scriptedSideQuery(overrides: Record<string, string | ((p: string) => string)> = {}) {
  const calls: string[] = []
  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt)
    for (const [marker, reply] of Object.entries(overrides)) {
      if (prompt.includes(marker)) return typeof reply === 'function' ? reply(prompt) : reply
    }
    if (prompt.includes('Answer YES or NO')) return 'NO'
    if (prompt.includes('Verify 3 levels')) return 'PASS'
    if (prompt.includes('relatable analogy')) return 'Think of it like a new door on your house.'
    if (prompt.includes('next step')) return 'Add a lock to the door.'
    if (prompt.includes('got stuck')) return 'problem: The build hit a wall\ntried1: A\ntried2: B\nproposal: Try again'
    if (prompt.includes('clarifying question')) return 'READY'
    return 'READY'
  }
  return { fn, calls }
}

const prevCwd = process.cwd()
let tmpDir: string
let prevEmbedBaseUrl: string | undefined

beforeEach(() => {
  prevEmbedBaseUrl = process.env.LOCALCODE_EMBED_BASE_URL
  process.env.LOCALCODE_EMBED_BASE_URL = 'http://127.0.0.1:9'
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-teachback-'))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevEmbedBaseUrl === undefined) delete process.env.LOCALCODE_EMBED_BASE_URL
  else process.env.LOCALCODE_EMBED_BASE_URL = prevEmbedBaseUrl
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
})

describe('teachback gate', () => {
  it('emits teachback understanding before building', async () => {
    const { loop, calls } = fakeLoop()
    const events: any[] = []
    const { fn } = scriptedSideQuery({ 'Summarize what you understand': '- You want a hello file\n- Plain text' })
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })
    await ctrl.start('new', 'make a hello file')
    await ctrl.handleAnswer('q-1', 'Create hello.txt with the text hello world')
    const teachback = events.find(e => e.type === 'vibe.question' && e.questionId === 'teachback')
    expect(teachback).toBeDefined()
    expect(calls.handleUserMessage.length).toBe(0)
    expect(ctrl.state).toBe('teachback')
  })

  it('confirming teachback gates the build open', async () => {
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Summarize what you understand': '- hello file' })
    const ctrl = new VibeController({ emit: () => {}, sideQuery: fn, loop })
    await ctrl.start('new', 'make a hello file')
    await ctrl.handleAnswer('q-1', 'Create hello.txt with hello world')
    await ctrl.handleAnswer('teachback', 'yes that is right')
    expect(calls.handleUserMessage.length).toBeGreaterThan(0)
  })

  it('correcting teachback does not build', async () => {
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Summarize what you understand': '- wrong thing' })
    const ctrl = new VibeController({ emit: () => {}, sideQuery: fn, loop })
    await ctrl.start('new', 'make a hello file')
    await ctrl.handleAnswer('q-1', 'Create hello.txt with hello world')
    await ctrl.handleAnswer('teachback', 'no that is wrong, I meant a JSON file')
    expect(calls.handleUserMessage.length).toBe(0)
  })
})
