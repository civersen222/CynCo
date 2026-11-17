/**
 * F235, the re-prompt (decision sheet 2026-11-17, row 11): a turn that ends
 * because the model server stopped answering says so on its `session.error`
 * frame in a field of its own (`stall`), and every other error leaves the field
 * out. The mission driver re-prompts once on that field and never reads the
 * error's text (`scripts/cynco-stall.mjs`), so what has to be true here is that
 * the field is there for a cut stream, absent for a crash, a refused spawn and
 * a cut transport, and that the loop is free and holds the same conversation
 * when the re-prompt arrives.
 *
 * The real ConversationLoop against a mock provider, as sessionFidelityEveryExit does.
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { globalAskBroker } from '../../tools/askBroker.js'
import { StreamStalledError, stallOf, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS } from '../../providers/streamWatchdog.js'
import { ServerStartError } from '../../llama/errors.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
const prevMax = process.env.LOCALCODE_MAX_ITERATIONS
afterEach(() => {
  if (prevMax === undefined) delete process.env.LOCALCODE_MAX_ITERATIONS; else process.env.LOCALCODE_MAX_ITERATIONS = prevMax
  globalContract.clear()
  globalAskBroker.setUnattended(false)
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
}

type Reply = (req: CompletionRequest) => Generator<StreamEvent>

function mockProvider(replies: Reply[], requests: CompletionRequest[]): Provider {
  let idx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
      requests.push(r)
      const reply = replies[idx++]
      if (reply) yield* reply(r)
    },
  } as Provider
}

/** A reply that reads f.txt: one complete tool call. */
function read(cwd: string): Reply {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${Math.random()}`, name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, 'f.txt') }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** A reply that ends the turn with text. */
function done(): Reply {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** The 2026-11-14 shape: one token of the answer, then the stall clock cuts the request. */
function stallsMidReply(): Reply {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm3', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I' } } as any
    throw new StreamStalledError('mid-stream', STREAM_IDLE_MS)
  }
}

/** A request the server never began to answer. */
function stallsBeforeFirstByte(): Reply {
  // eslint-disable-next-line require-yield
  return function* (): Generator<StreamEvent> { throw new StreamStalledError('first-byte', STREAM_FIRST_BYTE_MS) }
}

function throws(err: Error): Reply {
  // eslint-disable-next-line require-yield
  return function* (): Generator<StreamEvent> { throw err }
}

/** A reply that starts and ends without message_stop: the loop's own "stream cut" error. */
function cutWithoutStop(): Reply {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm4', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } as any
  }
}

function setup(replies: (cwd: string) => Reply[]) {
  globalContract.clear()
  const cwd = mkdtempSync(join(tmpdir(), 'cynco-stall-'))
  dirs.push(cwd)
  writeFileSync(join(cwd, 'f.txt'), 'x\n')
  const events: any[] = []
  const requests: CompletionRequest[] = []
  const loop = new ConversationLoop({
    cwd, config: config(),
    provider: mockProvider(replies(cwd), requests),
    emit: (e: any) => { events.push(e) },
    allowedTools: ['Read'],
  })
  const errors = () => events.filter(e => e.type === 'session.error')
  return { loop, events, errors, requests }
}

/** Every text the provider was sent, flattened: user text, tool results and all. */
function sentText(req: CompletionRequest): string {
  return JSON.stringify((req as any).messages ?? [])
}

describe('a cut stream names itself on session.error (F235)', () => {
  it('a reply that stalls mid-stream ends the turn with one session.error carrying stall { mid-stream, the idle limit }', async () => {
    const { loop, errors, events } = setup((cwd) => [read(cwd), stallsMidReply()])
    await loop.handleUserMessage('the mission brief', { unattended: true })
    expect(errors()).toHaveLength(1)
    expect(errors()[0].stall).toEqual({ phase: 'mid-stream', silentMs: STREAM_IDLE_MS })
    // The text is still the engine's own sentence; the field is beside it, not instead of it.
    expect(errors()[0].error).toMatch(/stopped sending mid-reply: nothing for 600s; the request was cancelled \(F235\)/)
    // A stall is not a finished message: nothing closes the turn but the error.
    expect(events.filter(e => e.type === 'message.complete')).toEqual([])
    expect(loop.isProcessing).toBe(false)
  }, 60000)

  it('a request the server never began to answer carries stall { first-byte, the first-byte limit }', async () => {
    const { loop, errors } = setup(() => [stallsBeforeFirstByte()])
    await loop.handleUserMessage('the mission brief', { unattended: true })
    expect(errors()).toHaveLength(1)
    expect(errors()[0].stall).toEqual({ phase: 'first-byte', silentMs: STREAM_FIRST_BYTE_MS })
  }, 60000)
})

describe('no other error carries the field', () => {
  const others: Array<[string, (cwd: string) => Reply[]]> = [
    ['a crashed model server', () => [throws(new Error('llama-server exited with code 9'))]],
    ['a refused spawn', () => [throws(new ServerStartError(8081, 'refused: 2.1 GiB of commit charge free, 21 GiB needed (F140)'))]],
    // The text alone must never make a stall: this is the sentence the driver used to match on.
    ['an error whose text merely quotes the stall', () => [throws(new Error('llama-server stopped sending mid-reply: nothing for 600s; the request was cancelled (F235)'))]],
    ['a reply cut without message_stop', () => [cutWithoutStop()]],
  ]
  for (const [name, replies] of others) {
    it(`${name}: session.error has no stall key at all`, async () => {
      const { loop, errors } = setup(replies)
      await loop.handleUserMessage('the mission brief', { unattended: true })
      expect(errors()).toHaveLength(1)
      expect('stall' in errors()[0]).toBe(false)
      expect(typeof errors()[0].error).toBe('string')
    }, 60000)
  }

  it('stallOf answers for the error class only, never for a look-alike', () => {
    expect(stallOf(new StreamStalledError('mid-stream', 600_000))).toEqual({ phase: 'mid-stream', silentMs: 600_000 })
    expect(stallOf(new StreamStalledError('first-byte', 1_200_000, 'Ollama'))).toEqual({ phase: 'first-byte', silentMs: 1_200_000 })
    expect(stallOf(new Error('the request was cancelled (F235)'))).toBeNull()
    expect(stallOf(Object.assign(new Error('x'), { name: 'StreamStalledError', phase: 'mid-stream', silentMs: 1 }))).toBeNull()
    expect(stallOf('StreamStalledError')).toBeNull()
    expect(stallOf(undefined)).toBeNull()
  })
})

describe('the turn after a stall', () => {
  it('the loop is free, and a re-prompt runs on in the same conversation: the brief and the work before the stall are still in the request', async () => {
    const { loop, errors, events, requests } = setup((cwd) => [read(cwd), stallsMidReply(), done()])
    await loop.handleUserMessage('MISSION-BRIEF-TEXT', { unattended: true })
    expect(errors()).toHaveLength(1)
    expect(loop.isProcessing).toBe(false)

    await loop.handleUserMessage('RE-PROMPT-TEXT', { unattended: true })
    // The second turn ended as a turn does, with no second error.
    expect(errors()).toHaveLength(1)
    expect(events.filter(e => e.type === 'message.complete').map(e => e.stopReason)).toEqual(['end_turn'])
    // Third request = the re-prompted turn's first model call.
    expect(requests).toHaveLength(3)
    const sent = sentText(requests[2])
    expect(sent).toContain('MISSION-BRIEF-TEXT')
    expect(sent).toContain('RE-PROMPT-TEXT')
    // The Read that ran before the stall, and its result, were kept...
    expect(sent).toContain('f.txt')
    expect(sent.indexOf('MISSION-BRIEF-TEXT')).toBeLessThan(sent.indexOf('RE-PROMPT-TEXT'))
    // ...and the half-reply the stall cut was not: its one token is in no message.
    const assistantTexts = loop.getMessages().filter(m => m.role === 'assistant')
      .flatMap(m => (m.content as any[]).filter(b => b.type === 'text').map(b => b.text))
    expect(assistantTexts).not.toContain('I')
  }, 60000)

  it('the iteration cap is the same setting, counted per message: the re-prompted turn starts its own count', async () => {
    process.env.LOCALCODE_MAX_ITERATIONS = '2'
    const { loop, events } = setup((cwd) => [read(cwd), stallsMidReply(), read(cwd), read(cwd), read(cwd)])
    await loop.handleUserMessage('MISSION-BRIEF-TEXT', { unattended: true })
    expect(events.some(e => e.type === 'message.complete')).toBe(false)
    await loop.handleUserMessage('RE-PROMPT-TEXT', { unattended: true })
    // Two iterations were spent before the stall; the turn after it still gets two of its own.
    expect(events.filter(e => e.type === 'tool.start')).toHaveLength(3)
    expect(events.filter(e => e.type === 'message.complete').map(e => e.stopReason)).toEqual(['max_iterations'])
  }, 60000)
})
