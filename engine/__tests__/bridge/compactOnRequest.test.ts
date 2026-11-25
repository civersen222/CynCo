/**
 * `/compact` compacts through the loop's one public door (wave 15b, NOW.md:249, P1-C1).
 *
 * The command used to reach the private `compactNow` from engine/main.ts after
 * reading `isProcessing`: nothing held the loop while the side query ran, so a
 * message sent during it started a turn on the message list the compaction was
 * about to replace, and the compaction then threw that turn's new messages away.
 *
 * `compactOnRequest(label)` refuses while a turn runs, and otherwise holds the
 * busy state `handleUserMessage` checks (`processing`) for the whole compaction
 * and clears it in a `finally`. A typed message meets the same busy guard a
 * running turn gives it (interactive: `session.error "busy: ..."` on the wire,
 * so the page keeps the text and nothing is dropped unsaid); a click queues as
 * it does behind a turn and is dispatched when the compaction ends; a Stop
 * pressed during it does not carry into the next turn.
 *
 * The real ConversationLoop against a mock provider and a stubbed side query.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'
import { activity } from '../../power/activity.js'
import { JSONLStore } from '../../session/jsonlStore.js'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => { globalContract.clear(); setProjectToolContext(null); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
}

/** A provider whose every call answers one line of text, after `before()` (if given) resolves. */
function textProvider(before?: () => Promise<void>): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    name: 'mock',
    requests,
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
      requests.push(r)
      if (before) await before()
      yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done.' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } as any
      yield { type: 'message_stop' } as any
    },
  } as Provider & { requests: CompletionRequest[] }
}

function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void
  const p = new Promise<void>(r => { open = r })
  return { wait: () => p, open }
}

/**
 * The side query compaction makes: counted, and held until `held` (if given)
 * opens. A request whose signal aborts rejects as fetch does (wave 15c, B4-6);
 * a request sent without a signal waits for the gate however long it takes.
 */
function stubSideQuery(held?: Promise<void>, opts: { ignoreSignal?: boolean } = {}): { calls: () => number; signalled: () => number } {
  let n = 0
  let signalled = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: { signal?: AbortSignal }) => {
    // Only the side query is held and counted; anything else the loop asks (an embedding) is
    // answered at once that nothing is there, so a held gate never stalls a turn elsewhere.
    if (!String(url).endsWith('/api/chat')) return new Response('', { status: 404 })
    n++
    const signal = opts.ignoreSignal ? undefined : init?.signal
    if (signal) signalled++
    if (held) {
      await Promise.race([
        held,
        new Promise<never>((_, reject) => {
          if (!signal) return
          if (signal.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'))
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
      ])
    }
    return new Response(JSON.stringify({ message: { content: 'summary of earlier turns' } }), { status: 200 })
  })
  return { calls: () => n, signalled: () => signalled }
}

/** The open activities a compaction a person asked for holds (engine/power/activity). */
const compactionActivities = (): number => activity.snapshot().filter(a => a.kind === 'request' && a.label === 'compaction').length

function makeLoop(provider: Provider): { loop: ConversationLoop; events: any[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'compact-on-request-'))
  dirs.push(cwd)
  const events: any[] = []
  const loop = new ConversationLoop({ cwd, config: config(), provider, emit: e => events.push(e) })
  return { loop, events }
}

/** Twelve turns of history, enough for compactNow to compact. */
function seed(loop: ConversationLoop): void {
  const msgs = (loop as any).messages as any[]
  for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i}: ${'x'.repeat(400)}` }] })
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('ConversationLoop.compactOnRequest', () => {
  it('refuses while a turn is running, and compacts nothing', async () => {
    const g = gate()
    const provider = textProvider(g.wait)
    const { loop } = makeLoop(provider)
    seed(loop)
    const side = stubSideQuery()
    const turn = loop.handleUserMessage('look at the standings')
    await until(() => provider.requests.length === 1, 'the turn\'s model call')
    const before = loop.getMessages().length
    const answer = await loop.compactOnRequest('/compact')
    expect(answer.refused).toMatch(/a turn is running/)
    expect(answer.compacted).toBe(false)
    expect(side.calls()).toBe(0)
    expect(loop.getMessages().length).toBe(before)
    g.open()
    await turn
    expect(loop.isProcessing).toBe(false)
  })

  it('compacts when the loop is free and answers what it freed', async () => {
    const { loop } = makeLoop(textProvider())
    seed(loop)
    const side = stubSideQuery()
    const answer = await loop.compactOnRequest('/compact')
    expect(answer.refused).toBeNull()
    expect(answer.compacted).toBe(true)
    expect(side.calls()).toBe(1)
    expect(answer.messagesBefore).toBe(12)
    expect(answer.messagesAfter).toBe(loop.getMessages().length)
    expect(answer.messagesAfter).toBeLessThan(12)
    expect(answer.tokensAfter).toBeLessThan(answer.tokensBefore)
    expect(loop.isProcessing).toBe(false)
  })

  it('answers "nothing compacted" for a conversation too short to compact, and holds nothing', async () => {
    const { loop } = makeLoop(textProvider())
    const side = stubSideQuery()
    const answer = await loop.compactOnRequest('/compact')
    expect(answer).toMatchObject({ refused: null, compacted: false, messagesBefore: 0, messagesAfter: 0 })
    expect(side.calls()).toBe(0)
    expect(loop.isProcessing).toBe(false)
  })

  it('a message typed during a compaction meets the busy guard and is answered on the wire; it starts no turn', async () => {
    const g = gate()
    const provider = textProvider()
    const { loop, events } = makeLoop(provider)
    seed(loop)
    stubSideQuery(g.wait())
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    await loop.handleUserMessage('a new question')
    expect(provider.requests.length).toBe(0)
    expect(events.some(e => e.type === 'session.error' && /^busy:/.test(e.error))).toBe(true)
    // A second compaction asked for meanwhile is refused too, by the same rule.
    expect((await loop.compactOnRequest('/compact')).refused).toMatch(/running/)
    g.open()
    const answer = await compaction
    expect(answer.compacted).toBe(true)
    expect(JSON.stringify(loop.getMessages())).not.toContain('a new question')
    expect(loop.isProcessing).toBe(false)
    // Sent again once the compaction has ended, it is a turn.
    await loop.handleUserMessage('a new question')
    expect(provider.requests.length).toBe(1)
    expect(JSON.stringify(loop.getMessages())).toContain('a new question')
  })

  it('a click during a compaction is queued and becomes the next turn when the compaction ends', async () => {
    const g = gate()
    const provider = textProvider()
    const { loop } = makeLoop(provider)
    seed(loop)
    stubSideQuery(g.wait())
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    loop.handleUiAction({ type: 'ui.action', surfaceId: 'path-options', action: 'choose', label: 'Choose A', context: { option: 'A' } } as any)
    expect(provider.requests.length).toBe(0)
    g.open()
    await compaction
    await until(() => provider.requests.length === 1, 'the queued click\'s turn')
    await until(() => !loop.isProcessing, 'the click\'s turn to end')
    expect(JSON.stringify(loop.getMessages())).toContain('Choose A')
  })

  it('a Stop pressed during a compaction does not stop the next turn', async () => {
    const g = gate()
    const provider = textProvider()
    const { loop, events } = makeLoop(provider)
    seed(loop)
    stubSideQuery(g.wait())
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    loop.abort()
    g.open()
    await compaction
    await loop.handleUserMessage('carry on')
    expect(provider.requests.length).toBe(1)
    expect(events.some(e => e.type === 'message.complete' && e.stopReason === 'aborted')).toBe(false)
  })

  it('clears the busy state when the compaction throws', async () => {
    const provider = textProvider()
    const { loop } = makeLoop(provider)
    seed(loop)
    stubSideQuery()
    ;(loop as any).compactNow = async () => { throw new Error('the summary store faulted') }
    await expect(loop.compactOnRequest('/compact')).rejects.toThrow('the summary store faulted')
    expect(loop.isProcessing).toBe(false)
    await loop.handleUserMessage('still there?')
    expect(provider.requests.length).toBe(1)
  })

  // ── wave 15c, check B4-1: a compaction is the loop's current turn ──────────

  it('a project or chat switch during a compaction waits for it, and the compaction writes nothing into the new conversation', async () => {
    const g = gate()
    const { loop } = makeLoop(textProvider())
    seed(loop)
    stubSideQuery(g.wait())
    const appended = vi.spyOn(JSONLStore.prototype, 'appendCompaction')
    const home = mkdtempSync(join(tmpdir(), 'compact-switch-home-'))
    dirs.push(home)
    const slug = createProject(home, { name: 'Switch', instructions: 'Metric.' }).slug
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    let compactionSettled = false
    const compaction = loop.compactOnRequest('/compact').finally(() => { compactionSettled = true })
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    let switched = false
    const sw = loop.startProjectSession(b.binding, b.messages).then(() => { switched = true })
    // The switch must not swap the conversation while the compaction holds it.
    await new Promise(r => setTimeout(r, 50))
    if (switched) expect(compactionSettled).toBe(true)
    g.open()
    await sw
    const answer = await compaction
    expect(compactionSettled).toBe(true)
    expect(answer.compacted).toBe(false)
    // The project chat holds the project's messages, not the coding conversation's summary.
    expect(loop.getMessages()).toEqual(b.messages.map(m => ({ role: m.role, content: m.content })))
    expect(JSON.stringify(loop.getMessages())).not.toContain('summary of earlier turns')
    const newJournal = (loop as any).journal
    expect(appended.mock.contexts.filter(c => c === newJournal)).toHaveLength(0)
    expect(loop.isProcessing).toBe(false)
  })

  it('a switch waits for a compaction whose side query does not stop when asked, and the compaction writes nothing into the new conversation', async () => {
    const g = gate()
    const { loop } = makeLoop(textProvider())
    seed(loop)
    // A model server that ignores the request's abort: only the gate ends the side query.
    stubSideQuery(g.wait(), { ignoreSignal: true })
    const home = mkdtempSync(join(tmpdir(), 'compact-switch-home-'))
    dirs.push(home)
    const slug = createProject(home, { name: 'Switch late', instructions: 'Metric.' }).slug
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    let compactionSettled = false
    const compaction = loop.compactOnRequest('/compact').finally(() => { compactionSettled = true })
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    let switched = false
    const sw = loop.startProjectSession(b.binding, b.messages).then(() => { switched = true })
    await new Promise(r => setTimeout(r, 150))
    expect(switched, 'the switch went ahead while the compaction held the conversation').toBe(false)
    g.open()
    await sw
    expect(compactionSettled).toBe(true)
    expect((await compaction).compacted).toBe(false)
    expect(loop.getMessages()).toEqual(b.messages.map(m => ({ role: m.role, content: m.content })))
  })

  it('a compaction whose conversation was replaced under it writes nothing and says so', async () => {
    const g = gate()
    const { loop } = makeLoop(textProvider())
    seed(loop)
    stubSideQuery(g.wait())
    const appended = vi.spyOn(JSONLStore.prototype, 'appendCompaction')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    // A conversation swapped in without the busy check (resume() has none).
    const other = [{ role: 'user', content: [{ type: 'text', text: 'another conversation' }] }]
    ;(loop as any).messages = other
    g.open()
    const answer = await compaction
    expect(answer.compacted).toBe(false)
    expect((loop as any).messages).toBe(other)
    expect(appended).not.toHaveBeenCalled()
    expect(logs.some(l => l.includes('[compact] /compact: the conversation changed during the compaction; nothing replaced'))).toBe(true)
  })

  // ── wave 15c, check B4-6: a compaction can be stopped, and says what it is ──

  it('a Stop during a held compaction ends it: nothing compacted, the loop free, the conversation as it was', async () => {
    const g = gate()
    const { loop, events } = makeLoop(textProvider())
    seed(loop)
    const side = stubSideQuery(g.wait())
    const before = loop.getMessages()
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    expect(side.signalled()).toBe(1)
    loop.abort()
    let settled = false
    void compaction.then(() => { settled = true })
    await until(() => settled, 'the stopped compaction to end')
    const answer = await compaction
    expect(answer).toMatchObject({ refused: null, compacted: false, messagesBefore: 12, messagesAfter: 12 })
    expect(loop.getMessages()).toEqual(before)
    expect(loop.isProcessing).toBe(false)
    expect(events.some(e => e.type === 'message.complete' && e.stopReason === 'aborted')).toBe(false)
    g.open()
  })

  it('a compaction that outlives its cap is ended at the cap', async () => {
    const g = gate()
    const { loop } = makeLoop(textProvider())
    seed(loop)
    stubSideQuery(g.wait())
    ;(loop as any).compactRequestCapMs = 200
    const t0 = Date.now()
    const answer = await loop.compactOnRequest('/compact')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(answer.compacted).toBe(false)
    expect(loop.getMessages()).toHaveLength(12)
    expect(loop.isProcessing).toBe(false)
    g.open()
  })

  it('a message typed during a compaction is told a compaction is running, not a turn', async () => {
    const g = gate()
    const { loop, events } = makeLoop(textProvider())
    seed(loop)
    stubSideQuery(g.wait())
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    await loop.handleUserMessage('a new question')
    const busy = events.filter(e => e.type === 'session.error').map(e => String(e.error))
    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatch(/^busy: a compaction is running/)
    expect(busy[0]).not.toMatch(/a turn is still running/)
    g.open()
    await compaction
  })

  // ── wave 15c, found beside B4-6: a compaction inside a turn hears the turn's Stop ──

  it('a Stop during a compaction a turn makes (pre-turn) ends the turn without waiting for the side query', async () => {
    const g = gate()
    const provider = textProvider()
    const cwd = mkdtempSync(join(tmpdir(), 'compact-in-turn-'))
    dirs.push(cwd)
    const events: any[] = []
    // A small window, so the seeded history is over the pre-turn threshold (0.4 of it).
    const loop = new ConversationLoop({ cwd, config: { ...config(), contextLength: 2000 } as LocalCodeConfig, provider, emit: e => events.push(e) })
    seed(loop)
    const side = stubSideQuery(g.wait())
    const turn = loop.handleUserMessage('carry on')
    await until(() => side.calls() === 1, 'the pre-turn compaction\'s side query')
    expect(side.signalled()).toBe(1)
    loop.abort()
    let ended = false
    void turn.then(() => { ended = true })
    await until(() => ended, 'the stopped turn to end')
    expect(provider.requests.length).toBe(0)
    expect(loop.isProcessing).toBe(false)
    expect(events.some(e => e.type === 'message.complete' && e.stopReason === 'aborted')).toBe(true)
    g.open()
  })

  // ── wave 15c, check B4-7: the activity it holds ends on every exit ─────────

  it('holds one compaction activity while it runs and none after a compaction, a refusal or a throw', async () => {
    const g = gate()
    const provider = textProvider()
    const { loop } = makeLoop(provider)
    seed(loop)
    stubSideQuery(g.wait())
    const start = compactionActivities()
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    expect(compactionActivities()).toBe(start + 1)
    g.open()
    await compaction
    expect(compactionActivities()).toBe(start)
    // A refusal begins none.
    const tg = gate()
    const turnProvider = textProvider(tg.wait)
    const t = makeLoop(turnProvider)
    seed(t.loop)
    const turn = t.loop.handleUserMessage('look at the standings')
    await until(() => turnProvider.requests.length === 1, 'the turn\'s model call')
    expect((await t.loop.compactOnRequest('/compact')).refused).not.toBeNull()
    expect(compactionActivities()).toBe(start)
    tg.open()
    await turn
    // A throw ends it.
    ;(loop as any).compactNow = async () => { throw new Error('the summary store faulted') }
    await expect(loop.compactOnRequest('/compact')).rejects.toThrow('the summary store faulted')
    expect(compactionActivities()).toBe(start)
  })

  // ── wave 15c: the click re-dispatch moved into redispatchQueuedClick ───────

  it('a click queued behind a turn that is stopped is dispatched exactly once, and one queued behind a compaction exactly once', async () => {
    const click = (label: string) => ({ type: 'ui.action', surfaceId: 'path-options', action: 'choose', label, context: { option: label } } as any)
    const userTexts = (loop: ConversationLoop): string[] => loop.getMessages().filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content))
    // Behind a turn that a Stop ends (the natural end did not drain it, so runTurn's finally dispatches it).
    const tg = gate()
    let held = true
    const provider = textProvider(() => held ? tg.wait() : Promise.resolve())
    const { loop } = makeLoop(provider)
    const turn = loop.handleUserMessage('first')
    await until(() => provider.requests.length === 1, 'the turn\'s model call')
    loop.handleUiAction(click('Turn A'))
    loop.abort()
    held = false
    tg.open()
    await turn
    await until(() => provider.requests.length === 2 && !loop.isProcessing && !(loop as any).currentTurn, 'the click\'s turn')
    await new Promise(r => setTimeout(r, 100))
    expect(userTexts(loop).filter(t => t.includes('Turn A'))).toHaveLength(1)
    expect(provider.requests.length).toBe(2)
    // Behind a compaction.
    const g = gate()
    seed(loop)
    stubSideQuery(g.wait())
    const compaction = loop.compactOnRequest('/compact')
    await until(() => loop.isProcessing, 'the compaction to hold the loop')
    loop.handleUiAction(click('Compaction B'))
    g.open()
    await compaction
    await until(() => provider.requests.length === 3 && !loop.isProcessing && !(loop as any).currentTurn, 'the click\'s turn after the compaction')
    await new Promise(r => setTimeout(r, 100))
    expect(userTexts(loop).filter(t => t.includes('Compaction B'))).toHaveLength(1)
    expect(provider.requests.length).toBe(3)
    expect((loop as any).pendingUiActions).toEqual([])
  })
})
