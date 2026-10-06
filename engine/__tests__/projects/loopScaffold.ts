/**
 * Test scaffold for the projects-mode loop tests: the real ConversationLoop
 * against a scripted mock provider (the toolCallCountGauge /
 * sessionFidelityEveryExit approach). Each script entry is one model call's
 * assistant message; a call past the end of the script answers "done".
 * `hold` parks one call after its first text delta until released, so a test
 * can act while that turn is mid-stream. The mock's model family is unknown
 * to the capability table, so no native tool array reaches the provider —
 * read the offered tool set off the loop, not off the request.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

export type ScriptBlock =
  | { type: 'text'; text: string | string[] }  // an array streams as separate deltas
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

export type RecordedCall = { systemPrompt: string | undefined; messages: unknown[]; tools: { name: string }[] }

export type Hold = { call: number; reached: () => void; release: Promise<void> }

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
}

/**
 * The wire shape the real providers (llama.cpp, Ollama) produce: deltas and
 * block starts, no `content_block_stop` — streamTranslator synthesizes the
 * stops and the closing `message_delta` at `message_stop`. A mock that sends
 * its own stops gets every assistant message assembled twice.
 */
async function* streamOf(blocks: ScriptBlock[], id: string, hold: Hold | null): AsyncGenerator<StreamEvent> {
  yield { type: 'message_start', message: { id, model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  let held = false
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'text') {
      for (const chunk of Array.isArray(b.text) ? b.text : [b.text]) {
        yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: chunk } } as any
        if (hold && !held) { held = true; hold.reached(); await hold.release }
      }
    } else {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu-${id}-${i}`, name: b.name, input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } as any
    }
  }
  yield { type: 'message_stop' } as any
}

export function makeLoop(opts: { script: ScriptBlock[][]; hold?: Hold; cwd?: string }) {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'cynco-loop-code-'))
  const calls: RecordedCall[] = []
  const events: any[] = []
  let idx = 0
  const provider: Provider = {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const n = idx++
      calls.push({ systemPrompt: r.system, messages: r.messages as unknown[], tools: (r.tools ?? []) as { name: string }[] })
      const blocks = opts.script[n] ?? [{ type: 'text', text: 'done' }]
      yield* streamOf(blocks, `m${n}`, opts.hold && opts.hold.call === n ? opts.hold : null)
    },
  } as Provider
  const loop = new ConversationLoop({ cwd, config: config(), provider, emit: (e: any) => { events.push(e) } })
  return { loop, events, calls, cwd }
}
