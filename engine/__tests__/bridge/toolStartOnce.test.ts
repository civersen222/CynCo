/**
 * One tool call must produce exactly one `tool.start`.
 *
 * The loop used to emit the event twice for every call: once from
 * `content_block_start` the moment the tool block began streaming, carrying
 * `input: {}` because none of the arguments had arrived yet, and again from
 * `executeOneTool` with the real arguments. Nothing downstream could tell the
 * two apart, because they share a type AND a toolId, so every consumer counted
 * each call twice:
 *
 *   - the mission driver's `toolCount`, hence every `toolCalls` figure in
 *     benchmark/cynco-ledger/missions.0002.jsonl
 *   - `AuditLogger.trackToolCall`, hence session-outcomes
 *   - the TUI, which printed "Running tool: X" and logged a sidebar row twice
 *     per call
 *
 * That last one is the tell: the doubling was visible on screen the whole time
 * and read as the model being repetitive rather than as an instrument fault.
 *
 * The measured consequence: a mission whose driver log showed 714 tool calls
 * had in fact made 357. Every pacing threshold compared against a driver-log
 * count was therefore compared against a number twice the truth — which is the
 * F89 mistake (a requirement set against an unmeasured base) arriving through
 * the instrument instead of through the gate.
 *
 * The preview carried no information a consumer could use: the TUI reads
 * `input.file_path` from `tool.start` to caption `tool.complete`, and the
 * preview's input is always `{}`. Deleting it costs nothing and is what these
 * tests hold in place.
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
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test-model',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold, so the routing pre-call does
    // not consume the mock provider's scripted responses.
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

/** One assistant message carrying `paths.length` parallel Read calls. */
function readToolUse(...paths: string[]): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < paths.length; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: paths[i] }) } } as any
      yield { type: 'content_block_stop', index: i } as any
    }
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

/** Every `tool.start` the loop emitted, in order. */
function toolStarts(events: any[]): any[] {
  return events.filter(e => e?.type === 'tool.start')
}

describe('tool.start is emitted once per tool call', () => {
  it('emits one event for one call, not two', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-ts-one-')
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    const events: any[] = []

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'a.txt')),
        textResponse('done'),
      ]),
      emit: (e: any) => { events.push(e) },
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read a.txt')

    // The engine-side commit counter already counts one. The emitted event
    // stream must agree with it; when they disagree, every consumer downstream
    // of `emit` is wrong and the counter looks fine.
    expect((loop as any).callsSinceCommit).toBe(1)
    expect(toolStarts(events)).toHaveLength(1)
    globalContract.clear()
  }, 30000)

  it('emits one event per call in a parallel batch', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-ts-batch-')
    writeFileSync(join(cwd, 'a.txt'), 'a\n')
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    writeFileSync(join(cwd, 'c.txt'), 'c\n')
    const events: any[] = []

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'a.txt'), join(cwd, 'b.txt'), join(cwd, 'c.txt')),
        textResponse('done'),
      ]),
      emit: (e: any) => { events.push(e) },
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read all three')

    // Three calls in one assistant turn. The doubling was worst here: the
    // stream announced all three blocks up front and execution announced them
    // again, so a batch of 3 read as 6 and a run looked twice as busy as it was.
    expect((loop as any).callsSinceCommit).toBe(3)
    expect(toolStarts(events)).toHaveLength(3)
    globalContract.clear()
  }, 30000)

  it('carries the real arguments, which the preview never had', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-ts-input-')
    const target = join(cwd, 'a.txt')
    writeFileSync(target, 'hello\n')
    const events: any[] = []

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(target),
        textResponse('done'),
      ]),
      emit: (e: any) => { events.push(e) },
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read a.txt')

    // The TUI captions `tool.complete` with the path it stashed from
    // `tool.start`. If the surviving event were the streaming preview, this
    // would be `{}` and every completed tool would render without its file.
    const [start] = toolStarts(events)
    expect(start.input?.file_path).toBe(target)
    expect(start.toolName).toBe('Read')
    globalContract.clear()
  }, 30000)

  it('pairs one start with one complete for the same toolId', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-ts-pair-')
    writeFileSync(join(cwd, 'a.txt'), 'a\n')
    writeFileSync(join(cwd, 'b.txt'), 'b\n')
    const events: any[] = []

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'a.txt'), join(cwd, 'b.txt')),
        textResponse('done'),
      ]),
      emit: (e: any) => { events.push(e) },
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read both')

    // A duplicated start leaves the TUI's tool_id -> path map holding an entry
    // that `tool.complete` pops only once, so ids must appear exactly once on
    // each side of the pair.
    const startIds = toolStarts(events).map(e => e.toolId)
    const completeIds = events.filter(e => e?.type === 'tool.complete').map((e: any) => e.toolId)
    expect(new Set(startIds).size).toBe(startIds.length)
    expect(startIds.length).toBe(2)
    expect([...startIds].sort()).toEqual([...completeIds].sort())
    globalContract.clear()
  }, 30000)
})
