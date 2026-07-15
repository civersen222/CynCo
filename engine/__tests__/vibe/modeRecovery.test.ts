// engine/__tests__/vibe/modeRecovery.test.ts
// Phase 6b: mode-aware build constraints (fix reproduce-first, explain read-only).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VibeController } from '../../vibe/controller.js'
import type { ConversationLoop } from '../../bridge/conversationLoop.js'

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

function scriptedSideQuery(overrides: Record<string, string | ((p: string) => string)> = {}) {
  const calls: string[] = []
  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt)
    for (const [marker, reply] of Object.entries(overrides)) {
      if (prompt.includes(marker)) return typeof reply === 'function' ? reply(prompt) : reply
    }
    if (prompt.includes('Answer YES or NO')) return 'NO'
    if (prompt.includes('Verify 3 levels')) return 'PASS'
    if (prompt.includes('relatable analogy')) return 'Think of it like a new door.'
    if (prompt.includes('next step')) return 'Add a lock.'
    if (prompt.includes('got stuck')) return 'problem: wall\ntried1: A\ntried2: B\nproposal: retry'
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mode-'))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevEmbedBaseUrl === undefined) delete process.env.LOCALCODE_EMBED_BASE_URL
  else process.env.LOCALCODE_EMBED_BASE_URL = prevEmbedBaseUrl
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
})

describe('mode-aware build constraints', () => {
  it('fix mode prepends a reproduce-first instruction to the build prompt', async () => {
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Summarize what you understand': '- a bug' })
    const ctrl = new VibeController({ emit: () => {}, sideQuery: fn, loop })
    await ctrl.start('fix', 'the login button crashes')
    await ctrl.handleAnswer('q-1', 'Fix the crash when clicking login on mobile')
    await ctrl.handleAnswer('teachback', 'yes')
    const buildMsg = calls.handleUserMessage.join('\n')
    expect(buildMsg.toLowerCase()).toContain('reproduce')
  })

  it('explain mode injects a read-only constraint', async () => {
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Summarize what you understand': '- explain code' })
    const ctrl = new VibeController({ emit: () => {}, sideQuery: fn, loop })
    await ctrl.start('explain', 'explain how the router works')
    await ctrl.handleAnswer('q-1', 'Explain the request routing flow')
    await ctrl.handleAnswer('teachback', 'yes')
    const buildMsg = calls.handleUserMessage.join('\n')
    expect(buildMsg.toLowerCase()).toContain('do not write')
  })
})
