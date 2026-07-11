// engine/__tests__/vibe/vibeModeSuppression.test.ts
// Regression guard: in vibe mode the raw token stream is suppressed
// (the TUI shows plain-language reports instead), but tool.start /
// tool.complete intentionally still flow — the TUI renders them as
// activity lines and drives the worker animation. Gated like other
// real-loop tests:
//   CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vibe/vibeModeSuppression.test.ts
import { describe, expect, it } from 'bun:test'

const SKIP = !process.env.CYNCO_INTEGRATION

import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto',
    temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
    contextLength: 131072, tools: undefined, noScouts: true,
  }
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false,
    jsonMode: true, contextLength: 32768, streaming: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
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

// Read of a nonexistent file: executes without approval, emits
// tool.start + tool.complete (isError) — same pattern as
// engine/__tests__/tools/conversationLoop.test.ts:315.
function* readToolUse(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"C:/nonexistent-vibe-test.txt"}' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

describe('vibe mode event suppression', () => {
  it.skipIf(SKIP)('suppresses stream.token but still completes the message', async () => {
    const events: any[] = []
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([() => textResponse('Built it.')]),
      emit: (e) => events.push(e),
    })
    loop.setVibeMode(true)
    await loop.handleUserMessage('build something')

    expect(events.some(e => e.type === 'stream.token')).toBe(false)
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
  })

  it.skipIf(SKIP)('tool.start/tool.complete still flow in vibe mode (TUI activity lines)', async () => {
    // Amended spec: tool events intentionally reach the TUI in vibe mode —
    // app.py:228-263 renders them as plain-language activity + worker animation.
    // approveAll: true — without it the loop emits approval.request and waits
    // indefinitely for handleApprovalResponse (same pattern as line 182-194 in
    // conversationLoop.test.ts for the Bash-blocked test).
    const events: any[] = []
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      // 'The task is complete.' must match the completionSignals regex
      // (conversationLoop.ts ~1998) or the mid-plan nudge fires and exhausts
      // the 2-response mock. If this test starts failing slowly with empty
      // streams, check that regex first.
      provider: mockProvider([() => readToolUse(), () => textResponse('The task is complete.')]),
      emit: (e) => events.push(e),
    })
    loop.setVibeMode(true)
    await loop.handleUserMessage('build something')

    expect(events.some(e => e.type === 'tool.start' && e.toolName === 'Read')).toBe(true)
    expect(events.some(e => e.type === 'tool.complete' && e.toolName === 'Read')).toBe(true)
    expect(events.some(e => e.type === 'stream.token')).toBe(false)
  })

  it.skipIf(SKIP)('normal mode still streams tokens (control)', async () => {
    const events: any[] = []
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([() => textResponse('Hello!')]),
      emit: (e) => events.push(e),
    })
    await loop.handleUserMessage('hi')

    expect(events.some(e => e.type === 'stream.token')).toBe(true)
  })

  it('setVibeMode toggles the isVibeMode getter', () => {
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([]),
      emit: () => {},
    })
    expect(loop.isVibeMode).toBe(false)
    loop.setVibeMode(true)
    expect(loop.isVibeMode).toBe(true)
  })
})
