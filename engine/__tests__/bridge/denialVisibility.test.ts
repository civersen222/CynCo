// Denied tool calls must reach governance.
//
// Measured on the livelocked L3-3.2b run: engine.log recorded 202 × `[read-loop]
// DENY Read` and the governance report still said `tools=0.95 stuck=0` at model
// iteration 405. The cause was structural, not statistical — all six refusal
// paths in handleToolCall() return early, ahead of the single onToolResult() at
// the end of the method, so a turn in which every call was refused looked to
// governance exactly like a turn in which nothing happened. Nothing aborted the
// run; it looped to the iteration cap and produced a byte-identical repo.
//
// A refusal is the strongest evidence of no progress there is: the call provably
// did not run. These tests pin that it is recorded.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const loop = readFileSync('engine/bridge/conversationLoop.ts', 'utf-8')

const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-denial-cwd-'))
afterAll(() => {
  fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
})

describe('denial visibility (static)', () => {
  // The behavioural test below drives exactly one of the six paths. This guard
  // covers the other five and, more importantly, covers the seventh: a refusal
  // path added later. Every `'denied'` outcome marks a call that did not run, so
  // every one of them owes governance a record.
  it('every denial site records the refusal before marking the turn', () => {
    const sites = loop.match(/^[ \t]+this\.recordToolOutcome\(toolName, 'denied', toolResultsThisTurn\)\r?$/gm) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(6)

    const paired = loop.match(/recordDenial\(\)\r?\n[ \t]+this\.recordToolOutcome\(toolName, 'denied', toolResultsThisTurn\)/g) ?? []
    expect(paired.length).toBe(sites.length)
  })

  it('records zero latency rather than inventing a duration', () => {
    // Nothing executed, so there is no elapsed time to report. A plausible
    // number here would be a fabricated measurement in the success-rate window.
    expect(loop).toMatch(/const recordDenial = \(\) => this\.governance\.onToolResult\(\s*toolName, false, 0, undefined, toolInput/)
  })
})

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
  } as LocalCodeConfig
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function mockProvider(gens: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = gens[callIdx++]
      if (gen) yield* gen()
    },
  }
}

// A turn that calls Bash while the run is pinned to Read only. `stop_reason:
// 'tool_use'` is required — the loop only executes a recorded tool block when
// the turn stopped for one, so a trailing end_turn delta would record the call
// and never refuse it, making the assertion vacuous.
function* callsForbiddenTool(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_stop' } as any
}

// The follow-up model call. Yields nothing, so the loop has no tool block to
// execute and the run ends after the single refusal.
function* silence(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg2', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any
}

describe('denial visibility (behavioral)', () => {
  it('a refused call reaches onToolResult with success=false and its input', async () => {
    const spy = vi.spyOn(CyberneticsGovernance.prototype, 'onToolResult')
    try {
      const loopInstance = new ConversationLoop({
        cwd: TEST_CWD,
        config: { ...defaultConfig(), approveAll: true } as LocalCodeConfig,
        provider: mockProvider([callsForbiddenTool, silence]),
        emit: () => {},
        allowedTools: ['Read'],
      })
      await loopInstance.handleUserMessage('run ls')

      const bashCalls = spy.mock.calls.filter(c => c[0] === 'Bash')
      expect(bashCalls.length).toBe(1)
      const [, success, latencyMs, , input] = bashCalls[0]
      expect(success).toBe(false)
      expect(latencyMs).toBe(0)
      // The input matters: stuck detection fingerprints name+input, so a
      // refusal recorded without it cannot be told apart from any other
      // refusal of the same tool.
      expect((input as any)?.command).toBe('ls')
      // A refusal is evidence about the model, not the environment. Measured
      // 2026-07-28 on the Gilded L4.5 run: five read-loop denials armed the
      // algedonic kill switch and halted a session mid-edit. Governance must be
      // told this call was refused, not that it failed.
      expect((bashCalls[0] as any)[5]?.governanceDenial).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
