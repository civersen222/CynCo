/**
 * The dashboard's Mission panel shows "tool calls / max iterations" from
 * `loop.toolCallCount`. That getter used to return `toolHistory.length`, and
 * toolHistory is a 50-entry rolling window kept for the VSM advisors — so the
 * gauge climbed to 50 in the first minutes of a mission and then read
 * "50 / 1200 (4%)" for the remaining hours. C6 wave 12 was read as "nothing
 * happening" from the browser while the engine was 392 tool calls in.
 *
 * This runs the real ConversationLoop against a mock provider that makes more
 * than 50 tool calls and asserts the gauge keeps counting past the window,
 * while the window itself stays capped (the advisors still want recency, not
 * the whole session).
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => {
  // The loop leaves its .cynco stream log open on Windows; a cleanup EPERM
  // must not turn a green test into a red file.
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }) } catch { /* temp dir */ } }
})

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

/** One assistant message carrying `n` parallel Read calls on real files. */
function reads(cwd: string, n: number): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < n; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, `f-${i}.txt`) }) } } as any
      yield { type: 'content_block_stop', index: i } as any
    }
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function done(): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

describe('toolCallCount — the Mission panel gauge', () => {
  it('keeps counting past the 50-entry advisor window', async () => {
    globalContract.clear()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-gauge-'))
    dirs.push(cwd)
    for (let i = 0; i < 10; i++) writeFileSync(join(cwd, `f-${i}.txt`), `file ${i}
`)

    // 6 turns x 10 calls = 60 real executeOneTool passes, more than the window.
    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        reads(cwd, 10), reads(cwd, 10), reads(cwd, 10),
        reads(cwd, 10), reads(cwd, 10), reads(cwd, 10),
        done(),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    expect(loop.toolCallCount).toBe(0)
    await loop.handleUserMessage('read all of those files')

    expect(loop.toolCallCount).toBe(60)
    // The advisors' rolling window is a different instrument and stays capped.
    expect((loop as any).toolHistory.length).toBeLessThanOrEqual(50)
    globalContract.clear()
  }, 60000)
})
