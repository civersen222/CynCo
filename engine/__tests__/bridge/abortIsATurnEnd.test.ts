/**
 * Stop is a turn end, and "busy" is said on the wire.
 *
 * `abort()` used to clear `processing` the instant it was called while the
 * aborted turn went on unwinding — a Bash child still running, a stream that
 * had not yielded its next event. A message sent right after Esc therefore
 * started a second turn beside the first, and the first turn's `finally`
 * then wiped the second turn's flags: a third message ran in parallel and the
 * next Stop was a no-op. The aborted loop also returned without a terminal
 * frame, so every client guessed when the turn was over; and a message sent
 * while a turn ran was dropped with one stdout line that a phone cannot read.
 *
 * Now: `processing` holds until the turn has really ended; the loop issues no
 * further model call once stopped; the end is marked by
 * `message.complete { stopReason: 'aborted' }`; the busy guard answers
 * `session.error "busy: …"`; and the decisions the engine is waiting on are
 * listed by `pendingDecisions()` for `/api/session` to replay.
 *
 * The real ConversationLoop against a mock provider, as
 * sessionFidelityEveryExit does.
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { AskBroker } from '../../tools/askBroker.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => { globalContract.clear() })

function config(over: Partial<LocalCodeConfig> = {}): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
    ...over,
  } as LocalCodeConfig
}

type Script = () => Generator<StreamEvent>

function mockProvider(responses: Script[]): Provider & { calls: () => number } {
  let idx = 0
  return {
    name: 'mock',
    calls: () => idx,
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { const gen = responses[idx++]; if (gen) yield* gen() },
  } as Provider & { calls: () => number }
}

/** One Read call; `onStart` runs after message_start, i.e. mid-stream. */
function read(cwd: string, onStart?: () => void): Script {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    onStart?.()
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, 'f.txt') }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** One Write call — tier approval, so with approveAll off the executor asks. */
function write(cwd: string): Script {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Write', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, 'out.txt'), content: 'hello' }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function done(text = 'done'): Script {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function setup(
  responses: (cwd: string, loop: () => ConversationLoop) => Script[],
  opts: { config?: Partial<LocalCodeConfig>; allowedTools?: string[] } = {},
) {
  globalContract.clear()
  const cwd = mkdtempSync(join(tmpdir(), 'cynco-abort-end-'))
  dirs.push(cwd)
  writeFileSync(join(cwd, 'f.txt'), 'x\n')
  const events: any[] = []
  let loop: ConversationLoop | null = null
  const provider = mockProvider(responses(cwd, () => loop!))
  loop = new ConversationLoop({
    cwd, config: config(opts.config),
    provider,
    emit: (e: any) => { events.push(e) },
    allowedTools: opts.allowedTools ?? ['Read'],
  })
  return { loop, events, provider }
}

describe('Stop is a turn end', () => {
  it('holds `processing` until the aborted turn has unwound, ends it with message.complete(aborted), issues no further model call, and takes the next message', async () => {
    let processingRightAfterAbort: boolean | null = null
    const { loop, events, provider } = setup((cwd, L) => [
      read(cwd),
      read(cwd, () => { L().abort(); processingRightAfterAbort = L().isProcessing }),
      done('after'),
    ])

    await loop.handleUserMessage('read f.txt')

    expect(processingRightAfterAbort, 'abort() must not clear processing while the turn is still unwinding').toBe(true)
    expect(loop.isProcessing).toBe(false)
    const completes = events.filter(e => e.type === 'message.complete')
    expect(completes.map(c => c.stopReason)).toEqual(['aborted'])
    // The loop stopped at its signal check and never asked the model again.
    expect(provider.calls()).toBe(2)

    // The next message is taken, and it is a fresh turn: the third script runs.
    await loop.handleUserMessage('and now?')
    expect(provider.calls()).toBe(3)
    expect(events.filter(e => e.type === 'message.complete').map(c => c.stopReason)).toEqual(['aborted', 'end_turn'])
    expect(loop.isProcessing).toBe(false)
  }, 60000)

  it('a message sent while a turn runs is refused on the wire with a busy: session.error and never runs', async () => {
    let refusedPromise: Promise<void> | null = null
    const { loop, events, provider } = setup((cwd, L) => [
      read(cwd, () => { refusedPromise = L().handleUserMessage('while you are busy') }),
      done(),
    ])

    await loop.handleUserMessage('read f.txt')
    await refusedPromise

    const busy = events.filter(e => e.type === 'session.error' && /^busy:/.test(String(e.error)))
    expect(busy).toHaveLength(1)
    expect(busy[0].error).toMatch(/Stop/)
    // The refused text never became a turn: the conversation holds one user message, the first.
    // (The model-call count is not asserted: the natural end of a turn may add nudge calls.)
    expect(provider.calls()).toBeGreaterThanOrEqual(2)
    const texts = loop.getMessages().flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'text').map((b: any) => String(b.text)) : [String(m.content)])
    expect(texts.some(t => t.includes('read f.txt'))).toBe(true)
    expect(texts.some(t => t.includes('while you are busy'))).toBe(false)
  }, 60000)

  it('an approval the engine is waiting on is listed by pendingDecisions() until it is answered', async () => {
    let seen: any[] | null = null
    const { loop, events } = setup((cwd) => [write(cwd), done()], { config: { approveAll: false }, allowedTools: ['Write'] })
    const original = loop.handleApprovalResponse.bind(loop)
    // Answer each card a tick after it is raised, after reading the list.
    const unhook = (() => {
      const timer = setInterval(() => {
        const req = events.find(e => e.type === 'approval.request')
        if (!req) return
        seen = loop.pendingDecisions()
        clearInterval(timer)
        original(req.requestId, false)
      }, 10)
      return () => clearInterval(timer)
    })()
    try {
      await loop.handleUserMessage('write out.txt')
    } finally { unhook() }

    const req = events.find(e => e.type === 'approval.request')
    expect(req, 'the Write call must have asked for approval').toBeTruthy()
    expect(seen).toEqual([{ kind: 'approval', requestId: req.requestId, toolName: 'Write', description: req.description, risk: req.risk }])
    expect(loop.pendingDecisions()).toEqual([])
  }, 60000)

  it('Stop while an approval card is open denies the card and ends the turn with "aborted"', async () => {
    const { loop, events } = setup((cwd) => [write(cwd), done()], { config: { approveAll: false }, allowedTools: ['Write'] })
    const timer = setInterval(() => {
      if (events.some(e => e.type === 'approval.request')) { clearInterval(timer); loop.abort() }
    }, 10)
    try {
      await loop.handleUserMessage('write out.txt')
    } finally { clearInterval(timer) }
    expect(events.some(e => e.type === 'approval.request')).toBe(true)
    expect(events.filter(e => e.type === 'message.complete').map(c => c.stopReason)).toEqual(['aborted'])
    expect(loop.isProcessing).toBe(false)
    expect(loop.pendingDecisions()).toEqual([])
  }, 60000)

  it('AskBroker lists an open question until it is answered', async () => {
    const broker = new AskBroker({ timeoutMs: 5000 })
    const asked: any[] = []
    broker.setEmitter(r => asked.push(r))
    const answer = broker.ask('Which colour?', ['red', 'blue'])
    expect(broker.pendingRequests()).toEqual([{ requestId: asked[0].requestId, question: 'Which colour?', options: ['red', 'blue'] }])
    expect(broker.answer(asked[0].requestId, 'red')).toBe(true)
    expect(await answer).toBe('red')
    expect(broker.pendingRequests()).toEqual([])
  })
})
