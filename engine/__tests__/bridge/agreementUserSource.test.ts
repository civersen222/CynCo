// Failure log F16. The Wave 2 Gilded mission halted at iteration 182 with
// `5 consecutive failures`, after 46 × `[vsm] Agreement ratio 0.00 < 0.5 —
// algedonic pain`. Measured: all 46 read exactly 0.00 and no other value.
//
// The 2026-06-12 fix (agreementPain.test.ts) already dealt with the same prompt
// being re-recorded every turn: dedupe on the previous recorded text, plus a
// `getDecidedCount() >= 2` floor so a single divergent sample cannot cause pain.
// Both guards were live in this run. What defeated them is that the text handed
// to the teachback heuristic was not the user's at all — it was the engine's own
// steering, and the engine writes a DIFFERENT nudge every time:
//
//   nudge 1  "Do not describe *what* you will do..."       -> \bwhat\b -> divergent
//   signal   "...act on *what* you already know."           -> \bwhat\b -> divergent
//
// Two distinct engine-authored strings are two distinct divergent exchanges,
// which is exactly the shape the floor was built to let through. Verified by
// probe: the classifier returns divergent for nudge 1 and for
// buildGovernanceSignal(3), so decided=2 / verified=0 / ratio=0.00 — latched,
// because nothing the engine says later can raise it.
//
// The fix is at the boundary, not in the classifier: agreement is a property of
// dialogue with a person, so only text the user actually supplied may be
// recorded as a user response.
import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { ConversationTheoryIntegration } from '../../vsm/conversationTheory.js'
import { buildGovernanceSignal } from '../../vsm/governanceSignal.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-agreement-cwd-'))
afterAll(() => {
  fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
})

const PROMPT = 'Refactor the HUD into a model and a layout, then commit.'

/** The literal the loop injects on the first stuck turn. */
const NUDGE_1 =
  'Do not describe what you will do. Call a tool now. If you need to read a file, ' +
  'call Read. If you need to write, call Write. If you need to search, call Grep. ' +
  'Act, do not narrate.'

describe('the classifier judges engine text as user confusion', () => {
  // Not the gate — the reason the gate below has to exist. If these two ever
  // stop being divergent the boundary fix is still right, but this comment
  // stops describing the run that motivated it.
  it('reads the engine as a confused user', () => {
    for (const engineText of [NUDGE_1, buildGovernanceSignal(3)!]) {
      const c = new ConversationTheoryIntegration()
      c.recordExchange('t', 'assistant text', engineText)
      expect(c.getDivergentCount(), engineText.slice(0, 40)).toBe(1)
    }
  })

  it('two distinct engine strings clear the >=2 decided floor at ratio 0.00', () => {
    const c = new ConversationTheoryIntegration()
    c.recordExchange('t1', 'a', NUDGE_1)
    c.recordExchange('t2', 'a', buildGovernanceSignal(3)!)
    expect(c.getDecidedCount()).toBeGreaterThanOrEqual(2)
    expect(c.getAgreementRatio()).toBe(0)
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

function mockProvider(count: number): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return {
        tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false,
        jsonMode: true, contextLength: 32768, streaming: true,
      }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      if (callIdx++ >= count) return
      // A text-only turn that ends without calling a tool: the exact condition
      // that makes the loop inject a nudge as a user-role message.
      yield { type: 'message_start', message: { id: `m${callIdx}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `considering the options, pass ${callIdx}` } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } } as any
      yield { type: 'message_stop' } as any
    },
  }
}

describe('agreement is measured against the user, not the engine', () => {
  it('every turn reports the user prompt, never an injected nudge', async () => {
    const spy = vi.spyOn(CyberneticsGovernance.prototype, 'onTurnComplete')
    try {
      const loopInstance = new ConversationLoop({
        cwd: TEST_CWD,
        config: { ...defaultConfig(), approveAll: true } as LocalCodeConfig,
        provider: mockProvider(4),
        emit: () => {},
      })
      await loopInstance.handleUserMessage(PROMPT)

      const seen = spy.mock.calls.map(c => (c[0] as any).userMessage)
      // More than one turn, or the nudge never got a chance to be recorded and
      // the assertion below is vacuous.
      expect(seen.length).toBeGreaterThan(1)
      for (const text of seen) expect(text).toBe(PROMPT)
    } finally {
      spy.mockRestore()
    }
  })
})
