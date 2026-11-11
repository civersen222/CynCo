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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

/** One Bash call. */
function bash(command: string): Script {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tb0', name: 'Bash', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } } as any
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
  return { loop, events, provider, cwd }
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

  // F201: Stop reaches the GPU and the shell, not only the loop.
  for (const mode of ['before the first event', 'mid-stream'] as const) {
    it(`Stop while the model call is open (${mode}) cancels the provider request and ends the turn with "aborted", not an error`, async () => {
      globalContract.clear()
      const cwd = mkdtempSync(join(tmpdir(), 'cynco-abort-end-'))
      dirs.push(cwd)
      const events: any[] = []
      const signals: Array<AbortSignal | undefined> = []
      let loop: ConversationLoop | null = null
      // As a fetch does: rejects when the signal it was given aborts; given none, fails late and says so.
      const provider = {
        ...mockProvider([]),
        async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
          const signal = (r as any).signal as AbortSignal | undefined
          signals.push(signal)
          setTimeout(() => loop!.abort(), 100)
          if (mode === 'mid-stream') {
            yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } as any
          }
          await new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('the provider was never told to stop')), 4000)
            signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) })
          })
        },
      } as Provider
      loop = new ConversationLoop({ cwd, config: config(), provider, emit: (e: any) => { events.push(e) }, allowedTools: ['Read'] })

      const started = Date.now()
      await loop.handleUserMessage('hello')

      expect(signals.length, 'one model call, never retried').toBe(1)
      expect(signals[0]?.aborted, 'the provider must hold the turn signal').toBe(true)
      expect(Date.now() - started).toBeLessThan(3500)
      expect(events.filter(e => e.type === 'message.complete').map(c => c.stopReason)).toEqual(['aborted'])
      expect(events.filter(e => e.type === 'session.error')).toEqual([])
      expect(loop.isProcessing).toBe(false)
    }, 60000)
  }

  it('Stop while a Bash command runs kills it and ends the turn with "aborted"', async () => {
    // The command's child writes its pid at once and would run a minute. The
    // Stop is pressed once that child is running, not a fixed time after the
    // call began: 300 ms in is when the shell is starting it, and a kill that
    // finds the tree when it happens can miss a child started at that instant
    // (F209; under vitest the Bash tool has no Job Object). The survivor then
    // held this test's directory and the cleanup failed with EPERM.
    const LATE_MS = 60_000
    const { loop, events, provider, cwd } = setup(() => [bash('node late.js'), done()], { allowedTools: ['Bash'] })
    writeFileSync(join(cwd, 'late.js'), `require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, ${LATE_MS})\n`)
    const childPid = (): number => {
      if (!existsSync(join(cwd, 'pid.txt'))) return 0
      const n = Number(readFileSync(join(cwd, 'pid.txt'), 'utf-8'))
      return Number.isInteger(n) && n > 0 ? n : 0
    }
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    let stoppedAt = 0
    let pid = 0
    const timer = setInterval(() => {
      pid = childPid()
      if (pid) { clearInterval(timer); stoppedAt = Date.now(); loop.abort() }
    }, 10)
    try {
      await loop.handleUserMessage('wait a while')
    } finally { clearInterval(timer) }
    expect(stoppedAt, 'the command\'s child must have started').toBeGreaterThan(0)
    expect(Date.now() - stoppedAt, 'the turn waited for the command instead of killing it').toBeLessThan(LATE_MS / 2)
    expect(events.filter(e => e.type === 'message.complete').map(c => c.stopReason)).toEqual(['aborted'])
    expect(provider.calls()).toBe(1)
    expect(loop.isProcessing).toBe(false)
    const until = Date.now() + 10_000
    while (alive(pid) && Date.now() < until) await new Promise(r => setTimeout(r, 25))
    expect(alive(pid), 'the process the command started outlived the Stop').toBe(false)
  }, 60000)

  it('Stop while a sub-agent the turn started is on its model call ends the sub-agent and the turn (F209)', async () => {
    globalContract.clear()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-abort-end-'))
    dirs.push(cwd)
    const events: any[] = []
    const signals: Array<AbortSignal | undefined> = []
    let loop: ConversationLoop | null = null
    const provider = {
      ...mockProvider([]),
      // The first call is the turn's: it starts a blocking sub-agent. Every
      // later call is the sub-agent's and behaves as a fetch does: it ends
      // when the signal it was given aborts; given none, it fails late.
      async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
        const signal = (r as any).signal as AbortSignal | undefined
        signals.push(signal)
        if (signals.length === 1) {
          yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ts0', name: 'SubAgent', input: {} } } as any
          yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ persona: 'scout', task: 'look around' }) } } as any
          yield { type: 'content_block_stop', index: 0 } as any
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
          yield { type: 'message_stop' } as any
          return
        }
        setTimeout(() => loop!.abort(), 100)
        await new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('the sub-agent\'s model call was never told to stop')), 4000)
          const stop = () => { clearTimeout(t); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) }
          if (signal?.aborted) stop()
          else signal?.addEventListener('abort', stop, { once: true })
        })
      },
    } as Provider
    loop = new ConversationLoop({ cwd, config: config(), provider, emit: (e: any) => { events.push(e) }, allowedTools: ['SubAgent'] })

    const started = Date.now()
    await loop.handleUserMessage('send a scout')

    expect(signals.length, 'the turn\'s call, then the sub-agent\'s one call').toBe(2)
    expect(signals[1]?.aborted, 'the sub-agent\'s model call must hold a signal that Stop aborts').toBe(true)
    expect(Date.now() - started, 'the turn waited for the sub-agent instead of stopping it').toBeLessThan(3500)
    expect(events.filter(e => e.type === 'message.complete').map(c => c.stopReason)).toEqual(['aborted'])
    expect(loop.isProcessing).toBe(false)
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
