import { describe, expect, it, beforeEach } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { HaltedError } from '../../cybernetics-core/src/algedonic/index.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

// ── Layer 2 gate ────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/algedonicLive.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

// Layer 2 imports (evaluated lazily so they don't blow up the un-gated suite)
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// ── Harness helpers (mirror conversationLoop.test.ts) ───────────────────────

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — the routing
    // pre-call would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume the mock provider's
    // scripted responses before the main loop runs.
    noScouts: true,
    approveAll: true,
  }
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

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      if (gen) yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function* failingRead(i: number): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: `m${i}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"file_path":"C:/nonexistent-algedonic-${i}.txt"}` } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

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
  beforeEach(() => {
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)
  })

  it.skipIf(SKIP)('Test A — 5 consecutive Read failures halt the loop with stopReason=halted', async () => {
    // Dynamically import to avoid blowing up the un-gated suite
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []
    let callCount = 0

    const responses: Array<() => Generator<StreamEvent>> = [
      () => failingRead(0),
      () => failingRead(1),
      () => failingRead(2),
      () => failingRead(3),
      () => failingRead(4),
      () => failingRead(5),
      () => failingRead(6),
      () => failingRead(7),
    ]

    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
        const gen = responses[callCount++]
        if (gen) yield* gen()
      },
    }

    const loop = new ConversationLoop({
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
    expect(callCount).toBeLessThanOrEqual(8)
  }, 60000)

  it.skipIf(SKIP)('Test B — 4 Read failures then text response does NOT halt', async () => {
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const events: any[] = []

    // 4 failing reads + successful text. The completion phrase "task complete"
    // satisfies the loop's modelSaysDone check, preventing nudge injection.
    const responses: Array<() => Generator<StreamEvent>> = [
      () => failingRead(10),
      () => failingRead(11),
      () => failingRead(12),
      () => failingRead(13),
      () => textResponse('task complete — no halt triggered; the four reads failed but the streak never reached five.'),
    ]

    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
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
