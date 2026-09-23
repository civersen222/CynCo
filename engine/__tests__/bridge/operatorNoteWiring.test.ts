/**
 * Proof that a message sent to a BUSY unattended mission survives.
 *
 * `ConversationLoop.handleUserMessage` is the single entry for both the mission
 * driver (bridge socket, 9160) and the 9161 dashboard's chat box. Its first
 * statement is a busy guard that returns silently — and during an unattended
 * mission the loop is busy for the entire run, so every note the operator typed
 * into the dashboard while the mission worked was dropped without a trace: no
 * alert, no ledger row, nothing in the transcript. The operator had no way to
 * learn their message had gone nowhere.
 *
 * What is pinned here is the whole path, on the REAL loop against a scripted
 * model: the note is queued and ACKNOWLEDGED while the mission runs, it is
 * delivered into `this.messages` at the top of the next model iteration (and
 * exactly once), the transcript says so, and the mission's own
 * `message.complete` still arrives. Interactive sessions are unchanged — there
 * is a person present, and today's drop-and-log is the right answer for them.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { EngineEvent } from '../../bridge/protocol.js'
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

/**
 * The scripted model, as MUTABLE state — the same shape
 * `verifyFirstWiring.test.ts` uses, and for a second reason here: a response is
 * a thunk, so a test can run arbitrary code INSIDE a model call. That is how
 * the note is injected mid-run (see `sendingNote` below), with no timers and no
 * promise plumbing: the loop is genuinely inside `stream()` — `processing` is
 * true and the mission's `unattended` flag is the live one — at the instant
 * `handleUserMessage` is re-entered.
 */
type Script = { responses: Array<() => Generator<StreamEvent>>; idx: number }

function mockProvider(script: Script, requests: CompletionRequest[]): Provider {
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
      const gen = script.responses[script.idx++]
      if (gen) yield* gen()
    },
  }
}

type Block = { name: string; input: Record<string, unknown> }

/** One assistant message carrying `blocks` tool calls, in order. */
function toolUse(...blocks: Block[]): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: b.name, input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } as any
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

/**
 * A model call that sends operator notes BEFORE it answers.
 *
 * `before()` runs on the generator's first `next()`, i.e. while the loop is
 * awaiting this very model call. This is the mid-run injection: the loop is
 * `processing`, and the running message's `unattended` flag decides what
 * happens to the note.
 */
function sendingNote(before: () => void, inner: () => Generator<StreamEvent>): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    before()
    yield* inner()
  }
}

const READ = (): Block => ({ name: 'Read', input: { file_path: 'seat.py' } })

function harness(prefix: string) {
  const cwd = tempDir(prefix)
  writeFileSync(join(cwd, 'seat.py'), 'VERSION = "v0"\n')
  // A contract exists so the loop does not try to auto-create one mid-test;
  // enforcement is off so a mock provider with nothing left to say is not
  // nudged for five extra iterations. Neither is what this file measures.
  globalContract.clear()
  globalContract.create('mission', '', ['File seat.py exists after changes'], 'harness')
  globalContract.setEnforcementEnabled(false)
  const events: EngineEvent[] = []
  const requests: CompletionRequest[] = []
  const script: Script = { responses: [], idx: 0 }
  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider(script, requests),
    emit: (e: EngineEvent) => { events.push(e) },
    allowedTools: ['Bash', 'Read', 'Edit'],
  })
  return { cwd, loop, events, script, requests }
}

/** Every user-role text in a request, flattened. */
function userTexts(req: CompletionRequest): string[] {
  const out: string[] = []
  for (const m of (req as any).messages ?? []) {
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') { out.push(c); continue }
    for (const b of c ?? []) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}

function operatorMessages(req: CompletionRequest): string[] {
  return userTexts(req).filter(t => t.startsWith('[operator]'))
}

function notes(events: EngineEvent[]): any[] {
  return events.filter(e => e.type === 'mission.operator_note') as any[]
}
function operatorAlerts(events: EngineEvent[]): any[] {
  return events.filter(e => e.type === 'governance.alert' && (e as any).source === 'operator') as any[]
}

describe('operator notes — a busy unattended mission', () => {
  it('queues, acknowledges, and delivers the note at the next iteration exactly once', async () => {
    const { loop, events, script, requests } = harness('cynco-op-deliver-')
    script.responses = [
      sendingNote(() => { void loop.handleUserMessage('stop editing app.py') }, toolUse(READ())),
      toolUse(READ()),
      textResponse('done'),
    ]
    await loop.handleUserMessage('do the thing', { unattended: true })

    // Acknowledged the instant it was queued — the operator is told, not ignored.
    const alerts = operatorAlerts(events)
    expect(alerts.length, 'no governance.alert acknowledged the note').toBeGreaterThanOrEqual(1)
    expect(alerts[0].severity).toBe('low')
    expect(alerts[0].message).toContain('queued for the next iteration')

    // Two frames for one note: queued, then delivered with the iteration index.
    const n = notes(events)
    expect(n).toHaveLength(2)
    expect(n[0].text).toBe('stop editing app.py')
    expect(n[0].deliveredAtIteration).toBeNull()
    expect(typeof n[0].queuedAt).toBe('string')
    expect(n[1].text).toBe('stop editing app.py')
    expect(n[1].queuedAt, 'the delivery frame must name the SAME queued note').toBe(n[0].queuedAt)
    // The note was sent during the first model call (iteration 0), so it is
    // delivered at the top of iteration 1 — the next one.
    expect(n[1].deliveredAtIteration).toBe(1)

    // The model actually saw it, on the call after the note was sent.
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(operatorMessages(requests[0]), 'delivered into the call that was already running').toEqual([])
    expect(operatorMessages(requests[1])).toEqual(['[operator]\nstop editing app.py'])
    // Delivered ONCE: still exactly one on every later call, never re-injected.
    expect(operatorMessages(requests[requests.length - 1])).toHaveLength(1)

    // The transcript says so.
    const tokens = events.filter(e => e.type === 'stream.token').map(e => (e as any).text)
    expect(tokens.some((t: string) => t.includes('[operator note delivered]'))).toBe(true)

    // And the mission's own turn still completed.
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
    globalContract.clear()
  }, 30000)

  it('drops the OLDEST note on overflow and says so', async () => {
    const { loop, events, script, requests } = harness('cynco-op-overflow-')
    script.responses = [
      sendingNote(() => {
        for (let k = 1; k <= 6; k++) void loop.handleUserMessage(`note ${k}`)
      }, toolUse(READ())),
      textResponse('done'),
    ]
    await loop.handleUserMessage('do the thing', { unattended: true })

    const dropAlert = operatorAlerts(events).find(a => /dropped the oldest/i.test(a.message))
    expect(dropAlert, 'an overflowing queue dropped a note silently').toBeTruthy()
    expect(dropAlert.severity).toBe('low')
    expect(dropAlert.message).toContain('note 1')

    // Cap 5: notes 2-6 survive, in order, as ONE user message.
    const delivered = notes(events).filter(f => f.deliveredAtIteration !== null)
    expect(delivered.map(f => f.text)).toEqual(['note 2', 'note 3', 'note 4', 'note 5', 'note 6'])
    expect(operatorMessages(requests[1])).toEqual(['[operator]\nnote 2\nnote 3\nnote 4\nnote 5\nnote 6'])

    // The alert is for a person; the ledger needs the note itself, and needs to
    // tell "pushed out by a newer note" from "the mission ended under it".
    const droppedFrames = notes(events).filter(f => f.dropped)
    expect(droppedFrames).toHaveLength(1)
    expect(droppedFrames[0].text).toBe('note 1')
    expect(droppedFrames[0].dropped).toBe('queue full')
    expect(droppedFrames[0].deliveredAtIteration).toBeNull()
    globalContract.clear()
  }, 30000)
})

/**
 * The note that arrives during the LAST model call.
 *
 * There is no next iteration to drain into, and the first cut let the queue
 * survive the mission — which meant a stale `[operator]` line was spliced into
 * whatever ran next, including an interactive session that never asked for it,
 * while the ledger showed the note as queued with nothing to say it had not
 * been delivered. The mission end is a boundary, and it has to report.
 */
describe('operator notes — the mission ends before the queue drains', () => {
  it('reports every undelivered note as dropped and leaks nothing into the next session', async () => {
    const { loop, events, script, requests } = harness('cynco-op-missionend-')
    script.responses = [
      // The FINAL model call of this message: nothing follows it, so there is
      // no iteration boundary left for the note to reach.
      sendingNote(() => { void loop.handleUserMessage('stop editing app.py') }, textResponse('done')),
    ]
    await loop.handleUserMessage('do the thing', { unattended: true })

    const stranded = notes(events).filter(f => f.dropped)
    expect(stranded, 'the stranded note was not reported').toHaveLength(1)
    expect(stranded[0].text).toBe('stop editing app.py')
    expect(stranded[0].dropped).toBe('mission ended')
    expect(stranded[0].deliveredAtIteration).toBeNull()
    expect(notes(events).some(f => f.deliveredAtIteration !== null), 'nothing was delivered').toBe(false)

    const endAlert = operatorAlerts(events).find(a => /undelivered/i.test(a.message))
    expect(endAlert, 'no alert named the undelivered notes').toBeTruthy()
    expect(endAlert.severity).toBe('low')
    expect(endAlert.message).toContain('1')

    // The queue is empty, and the next session — an INTERACTIVE one — is clean.
    expect((loop as any).operatorQueue).toHaveLength(0)
    const before = requests.length
    script.responses = [textResponse('second')]
    script.idx = 0
    await loop.handleUserMessage('a person types something', {})
    for (const r of requests.slice(before)) expect(operatorMessages(r)).toEqual([])
    globalContract.clear()
  }, 30000)
})

/**
 * Best-of-N runs `runModelLoop` once per candidate with `this.messages` saved
 * and restored around it and `emit` rebound to swallow stream tokens. A note
 * drained inside a candidate would be spliced out of the queue, reported
 * delivered, and then wiped with the candidate's messages — delivered to
 * nobody, and unrepeatable, because the queue no longer holds it.
 *
 * Rather than stand up worktrees and a test runner, this drives the seam
 * itself: the REAL arguments the real loop built for `runModelLoop`, captured
 * from a real message, replayed once as a candidate and once as the real loop.
 */
describe('operator notes — a best-of-N candidate never drains the queue', () => {
  it('leaves the note queued through a candidate run and delivers it once in the real loop', async () => {
    const { loop, events, script } = harness('cynco-op-candidate-')
    const captured: any[] = []
    const real = (loop as any).runModelLoop.bind(loop)
    ;(loop as any).runModelLoop = (...args: any[]) => { captured.push(args); return real(...args) }

    script.responses = [textResponse('warmup')]
    await loop.handleUserMessage('do the thing', { unattended: true })
    expect(captured.length, 'runModelLoop was never called').toBeGreaterThanOrEqual(1)
    const [systemPrompt, thinkingConfig, toolDefs, deps] = captured[0]

    ;(loop as any).operatorQueue.push({ text: 'stop editing app.py', queuedAt: '2026-09-22T10:00:00.000Z' })
    const before = notes(events).length

    // The candidate sweep: same loop, same arguments, `candidate: true`.
    script.responses = [textResponse('candidate')]
    script.idx = 0
    await real(systemPrompt, thinkingConfig, toolDefs, deps, 2, { candidate: true })
    expect((loop as any).operatorQueue, 'a candidate run drained the queue').toHaveLength(1)
    expect(notes(events).slice(before), 'a candidate run reported a delivery').toEqual([])

    // The real loop, immediately after, delivers it — exactly once.
    script.responses = [textResponse('real')]
    script.idx = 0
    await real(systemPrompt, thinkingConfig, toolDefs, deps, 2)
    expect((loop as any).operatorQueue).toHaveLength(0)
    const delivered = notes(events).slice(before).filter(f => f.deliveredAtIteration !== null)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe('stop editing app.py')
    globalContract.clear()
  }, 30000)
})

describe('operator notes — an interactive session is unchanged', () => {
  it('still ignores a message sent while it is busy, and emits nothing new', async () => {
    const { loop, events, script, requests } = harness('cynco-op-interactive-')
    script.responses = [
      sendingNote(() => { void loop.handleUserMessage('stop editing app.py') }, toolUse(READ())),
      textResponse('done'),
    ]
    await loop.handleUserMessage('do the thing', {})

    expect(notes(events)).toEqual([])
    expect(operatorAlerts(events)).toEqual([])
    for (const r of requests) expect(operatorMessages(r)).toEqual([])
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
    globalContract.clear()
  }, 30000)
})
