import { describe, expect, it, afterAll } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// Integration tests — create real ConversationLoop instances (filesystem,
// JSONL sessions, snapshots). Run with CYNCO_INTEGRATION=1.
const SKIP = !process.env.CYNCO_INTEGRATION

const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-coredefault-'))
afterAll(() => { fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 }) })

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
  }
}

function capabilities(): ModelCapabilities {
  return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
}

function* loadToolsCall(names: string[]): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'load_tools', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ tools: names }) } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

describe('core-by-default tool loading', () => {
  it.skipIf(SKIP)('turn 1 offers core tools only; load_tools surfaces an extended tool; system prompt is byte-identical', async () => {
    const captured: CompletionRequest[] = []
    const responses = [
      () => loadToolsCall(['WebFetch']),
      () => textResponse('done'),
      () => textResponse('done'),
    ]
    let idx = 0
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return capabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        const gen = responses[idx++]
        if (gen) yield* gen()
      },
    }
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: () => {},
    })
    await loop.handleUserMessage('please load the web fetch tool')

    expect(captured.length).toBeGreaterThanOrEqual(2)

    // Turn 1: core-only. The system prompt <TOOLS> block lists core tools
    // (Read, load_tools) but NOT extended tools (WebFetch).
    const sys0 = String(captured[0].system ?? '')
    const tools0 = sys0.slice(sys0.indexOf('<TOOLS>'), sys0.indexOf('</TOOLS>'))
    expect(tools0).toContain('- Read:')
    expect(tools0).toContain('- load_tools:')
    expect(tools0).not.toContain('- WebFetch:')

    // Option B invariant: no surface event mutates the system prompt.
    const sysLast = String(captured[captured.length - 1].system ?? '')
    expect(sysLast).toBe(sys0)

    // After load_tools, an availability block was appended to the message tail.
    const laterMsgs = (captured[captured.length - 1] as any).messages as any[]
    const flat = JSON.stringify(laterMsgs)
    expect(flat).toContain('[tool-availability')
    expect(flat).toContain('WebFetch')
  })
})
