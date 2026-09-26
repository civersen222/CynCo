/**
 * Proof that the retained-configuration store is on a live path (Phase 4 task 4).
 *
 * `RetainedConfigStore` and the two instances' import/export methods are pure
 * and unit-tested in engine/__tests__/vsm. A store nothing loads from and
 * nothing saves to passes all of those forever, so these tests run the real
 * ConversationLoop against a mock provider and assert:
 *  - session-feedback: imported at governance construction (a table seeded on
 *    disk reaches the `governance.status` frame's `ultrastable.retained` /
 *    `retainedVersion`), exported at session end with the loop's session id;
 *  - mission-invariants: imported when the invariants are armed, exported in
 *    the `handleUserMessage` finally — and a failing store is logged there,
 *    never thrown into the finally.
 */
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { FeedbackControlIntegration } from '../../vsm/feedbackControl.js'
import { MissionInvariants } from '../../vsm/missionInvariants.js'
import { RetainedConfigStore } from '../../vsm/retainedConfigStore.js'
import { cyncoHome } from '../../paths.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { EngineEvent } from '../../bridge/protocol.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

// CYNCO_HOME is the suite's temp home (engine/__tests__/setup/cyncoHome.ts),
// never the live ~/.cynco. The seeded table is removed by the test that seeds it.
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})
afterEach(() => { vi.restoreAllMocks() })

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test-model',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
    approveAll: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let idx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[idx++]
      if (gen) yield* gen()
    },
  }
}

function bashToolUse(command: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Bash', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function textResponse(text: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function harness(prefix: string, responses: Array<() => Generator<StreamEvent>>) {
  const cwd = tempDir(prefix)
  const events: EngineEvent[] = []
  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider(responses),
    emit: (e: EngineEvent) => { events.push(e) },
    allowedTools: ['Bash', 'Read', 'Grep'],
  })
  return { cwd, loop, events }
}

function lastStatus(events: EngineEvent[]): any {
  return events.filter(e => e.type === 'governance.status').at(-1)
}

const INVARIANTS = { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true }
const SEEDED = { ev0: { Continuous: [0.75, 8192, 0.3] } }

describe('retained-configuration store wiring', () => {
  it('session-feedback: a table on disk is imported at construction and rides governance.status', async () => {
    globalContract.clear()
    const retainedDir = join(cyncoHome(), 'retained')
    mkdirSync(retainedDir, { recursive: true })
    writeFileSync(join(retainedDir, 'session-feedback.json'), JSON.stringify({
      schema: 1, instance: 'session-feedback', version: 5, updatedAt: '2026-09-25T00:00:00.000Z',
      retained: SEEDED, history: [],
    }))
    try {
      const { loop, events } = harness('cynco-retained-sf-', [bashToolUse('echo hi'), textResponse('done')])
      await loop.handleUserMessage('do the thing', {})
      const status = lastStatus(events)
      expect(status, 'no governance.status frame was emitted').toBeTruthy()
      expect(status.ultrastable, 'ultrastable block missing from the frame').toBeTruthy()
      expect(status.ultrastable.retained).toEqual(SEEDED)
      expect(status.ultrastable.retainedVersion).toBe(5)
    } finally {
      rmSync(join(retainedDir, 'session-feedback.json'), { force: true })
      globalContract.clear()
    }
  }, 30000)

  it('session-feedback: exported at session end with the loop session id', async () => {
    globalContract.clear()
    const save = vi.spyOn(FeedbackControlIntegration.prototype, 'saveRetained')
    const { loop } = harness('cynco-retained-sf-end-', [textResponse('done')])
    await loop.handleUserMessage('do the thing', {})
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBeInstanceOf(RetainedConfigStore)
    expect(save.mock.calls[0][1]).toBe(loop.getSessionId())
    globalContract.clear()
  }, 30000)

  it('mission-invariants: imported when armed, exported at mission end', async () => {
    globalContract.clear()
    const load = vi.spyOn(RetainedConfigStore.prototype, 'load')
    const save = vi.spyOn(MissionInvariants.prototype, 'saveRetained')
    const { loop } = harness('cynco-retained-mi-', [bashToolUse('echo hi'), textResponse('done')])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })
    expect(load.mock.calls.map(c => c[0])).toContain('mission-invariants')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBeInstanceOf(RetainedConfigStore)
    expect(save.mock.calls[0][1]).toBe(loop.getSessionId())
    globalContract.clear()
  }, 30000)

  it('an interactive message exports no mission-invariants table', async () => {
    globalContract.clear()
    const save = vi.spyOn(MissionInvariants.prototype, 'saveRetained')
    const { loop } = harness('cynco-retained-int-', [textResponse('done')])
    await loop.handleUserMessage('do the thing', {})
    expect(save).not.toHaveBeenCalled()
    globalContract.clear()
  }, 30000)

  it('a failing store at mission end is logged, not thrown into the finally', async () => {
    globalContract.clear()
    vi.spyOn(MissionInvariants.prototype, 'saveRetained').mockImplementation(() => { throw new Error('disk full') })
    vi.spyOn(FeedbackControlIntegration.prototype, 'saveRetained').mockImplementation(() => { throw new Error('disk full') })
    const err = vi.spyOn(console, 'error')
    const { loop } = harness('cynco-retained-fail-', [textResponse('done')])
    await expect(loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })).resolves.not.toThrow()
    const lines = err.mock.calls.map(c => String(c[0]))
    expect(lines.some(l => l.includes('[retained]') && l.includes('mission-invariants') && l.includes('disk full'))).toBe(true)
    expect(lines.some(l => l.includes('[retained]') && l.includes('session-feedback') && l.includes('disk full'))).toBe(true)
    // The rest of the finally still ran.
    expect((loop as any).processing).toBe(false)
    expect((loop as any).unattendedActive).toBe(false)
    globalContract.clear()
  }, 30000)
})
