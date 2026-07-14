/**
 * Shared harness for gated live-wiring tests (CYNCO_INTEGRATION=1).
 *
 * Extracted from the four Phase 1 live tests (algedonicLive, predictionsLive,
 * s4Live, snapshotLive), which each carried an identical copy. NOT named
 * *.test.ts on purpose — vitest.config.ts collects engine/__tests__/**\/*.test.ts.
 */
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

export function defaultConfig(): LocalCodeConfig {
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

export function defaultCapabilities(): ModelCapabilities {
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

export type ScriptedProvider = Provider & { callCount(): number }

/**
 * Provider that replays a scripted response per model call.
 * Default: throws on script exhaustion — misalignment must be loud.
 * `lenient: true`: yields an empty stream instead (algedonicLive Test A relies
 * on this — the halt path stops consuming mid-script).
 */
export function mockProvider(
  responses: Array<() => Generator<StreamEvent>>,
  opts: { lenient?: boolean } = {},
): ScriptedProvider {
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
      if (!gen) {
        if (opts.lenient) return
        throw new Error(`mock provider script exhausted at call ${callIdx}`)
      }
      yield* gen()
    },
    callCount() { return callIdx },
  }
}

export function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

/**
 * Tool call whose arguments arrive as a RAW partial_json string — callModel's
 * repair ladder (JSON.parse → jsonrepair → malformed marker) sees exactly this
 * text. Pass deliberately unparseable-as-object payloads (e.g. '[1,2,3]') to
 * exercise the P1.8 malformed path end-to-end.
 */
export function* rawToolCall(i: number, name: string, partialJson: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: `m${i}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${i}`, name, input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

export function* toolCall(i: number, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield* rawToolCall(i, name, JSON.stringify(input))
}
