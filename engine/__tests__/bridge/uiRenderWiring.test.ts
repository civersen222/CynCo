/**
 * Generative UI on a live path: the real ConversationLoop against a mock
 * provider. A RenderUI call that streams its arguments yields partial frames
 * keyed on the tool id and exactly one final frame under the surface the model
 * named; a call the model was never offered yields no frame at all; a click
 * is the next user turn whether the loop is idle or busy; an aborted stream
 * still closes the surface it opened. Without these the page would show a
 * half-drawn card forever, or draw the same card twice — the F170 failure
 * (a question the page never showed) in a new coat of paint.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { genuiExampleCall } from '../../genui/prompt.js'
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
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
    approveAll: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider & { calls: number } {
  const p = {
    name: 'mock',
    calls: 0,
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[p.calls++]
      if (gen) yield* gen()
    },
  }
  return p as Provider & { calls: number }
}

const start = (id: string) => ({ type: 'message_start', message: { id, model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any)
const stop = (reason: string) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } } as any, { type: 'message_stop' } as any]

/** One assistant message with one tool call whose JSON arguments arrive in `chunks`. */
function toolUse(id: string, name: string, chunks: string[]): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield start('m-' + id)
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } as any
    for (const c of chunks) yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: c } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield* stop('tool_use')
  }
}

function textResponse(text: string, before?: () => void): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    if (before) before()
    yield start('m-text')
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield* stop('end_turn')
  }
}

/** Cut a JSON string into chunks of `size` characters. */
function chunks(json: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size))
  return out
}

const loadRenderUi = toolUse('tu-load', 'load_tools', [JSON.stringify({ tools: ['RenderUI'] })])
const uiFrames = (events: any[]) => events.filter(e => e?.type === 'ui.render')

describe('RenderUI frames on the live loop', () => {
  it('a streamed call yields partial frames on the tool id and one final frame on the named surface', async () => {
    globalContract.clear()
    const events: any[] = []
    const args = JSON.stringify(genuiExampleCall())
    const loop = new ConversationLoop({
      cwd: tempDir('cynco-ui-wire-'),
      config: config(),
      provider: mockProvider([loadRenderUi, toolUse('tu-ui', 'RenderUI', chunks(args, 60)), textResponse('drawn')]),
      emit: (e: any) => { events.push(e) },
    })
    await loop.handleUserMessage('draw')

    const frames = uiFrames(events)
    const partials = frames.filter(f => f.partial)
    const finals = frames.filter(f => !f.partial)
    expect(partials.length).toBeGreaterThanOrEqual(1)
    for (const p of partials) {
      expect(p.toolId).toBe('tu-ui')
      expect(p.surfaceId).toBe('tu-ui')
      expect(p.spec?.elements?.[p.spec.root]).toBeDefined()
      expect(p.errors).toBeUndefined()
    }
    expect(finals).toHaveLength(1)
    expect(finals[0].toolId).toBe('tu-ui')
    expect(finals[0].surfaceId).toBe('plan')
    expect(Object.keys(finals[0].spec.elements)).toHaveLength(7)
    expect(finals[0].errors).toEqual([])
    // the final frame precedes tool.complete, whose result names the surface
    const completeIdx = events.findIndex(e => e?.type === 'tool.complete' && e.toolId === 'tu-ui')
    expect(events.indexOf(finals[0])).toBeLessThan(completeIdx)
    expect(events[completeIdx].result).toContain('(surface: plan)')
    expect(events[completeIdx].isError).toBe(false)
    expect((loop as any).pendingUiSurfaces.size).toBe(0)
    globalContract.clear()
  }, 30000)

  it('a call the model was not offered draws nothing and is refused like any other', async () => {
    globalContract.clear()
    const events: any[] = []
    const loop = new ConversationLoop({
      cwd: tempDir('cynco-ui-refused-'),
      config: config(),
      provider: mockProvider([toolUse('tu-x', 'RenderUI', chunks(JSON.stringify(genuiExampleCall()), 60)), textResponse('ok')]),
      emit: (e: any) => { events.push(e) },
    })
    await loop.handleUserMessage('draw')
    expect(uiFrames(events)).toEqual([])
    const complete = events.find(e => e?.type === 'tool.complete' && e.toolId === 'tu-x')
    expect(complete?.isError).toBe(true)
    expect(String(complete?.result)).toMatch(/not available/)
    globalContract.clear()
  }, 30000)

  it('an aborted stream closes the surface it opened with a terminal frame', async () => {
    globalContract.clear()
    const events: any[] = []
    const head = '{"surface":"plan","spec":{"root":"card","elements":{"card":{"type":"Card","props":{"title":"Plan"},"children":["t"]},"t":{"type":"Text","props":{"text":"hello'
    let loopRef: ConversationLoop | null = null
    const aborting = function* (): Generator<StreamEvent> {
      yield start('m-abort')
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-ab', name: 'RenderUI', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: head } } as any
      loopRef!.abort()
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' world"}}}}}' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield* stop('tool_use')
    }
    const loop = new ConversationLoop({
      cwd: tempDir('cynco-ui-abort-'),
      config: config(),
      provider: mockProvider([loadRenderUi, aborting, textResponse('never')]),
      emit: (e: any) => { events.push(e) },
    })
    loopRef = loop
    await loop.handleUserMessage('draw')
    const frames = uiFrames(events)
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames[0].partial).toBe(true)
    const last = frames[frames.length - 1]
    expect(last.partial).toBe(false)
    expect(last.spec).toBeNull()
    expect(last.toolId).toBe('tu-ab')
    expect(last.errors?.[0]).toMatch(/turn ended/)
    expect((loop as any).pendingUiSurfaces.size).toBe(0)
    globalContract.clear()
  }, 30000)
})

describe('ui.action on the live loop', () => {
  const click = { type: 'ui.action' as const, surfaceId: 'plan', action: 'recalc', label: 'Recalculate', state: { kg: 3 } }

  it('idle: the click is the next user turn and creates no DoD contract', async () => {
    globalContract.clear()
    const events: any[] = []
    const loop = new ConversationLoop({
      cwd: tempDir('cynco-ui-click-'),
      config: config(),
      provider: mockProvider([textResponse('recalculated — all done.')]),
      emit: (e: any) => { events.push(e) },
    })
    loop.handleUiAction(click)
    await (loop as any).currentTurn
    const users = (loop as any).messages.filter((m: any) => m.role === 'user')
    const text = users[users.length - 1].content[0].text as string
    expect(text.startsWith('▶ Recalculate\n[UI action] "Recalculate" → action "recalc" on surface "plan"')).toBe(true)
    expect(text).toContain('input values: {"kg":3}')
    expect(globalContract.isActive()).toBe(false)
    expect(events.some(e => e?.type === 'message.complete')).toBe(true)
    globalContract.clear()
  }, 30000)

  it('busy: the click waits for the turn\'s natural end and then drives the next one', async () => {
    globalContract.clear()
    const events: any[] = []
    let loopRef: ConversationLoop | null = null
    const provider = mockProvider([
      textResponse('first, all done.', () => { loopRef!.handleUiAction(click) }),
      textResponse('second, all done.'),
    ])
    const loop = new ConversationLoop({ cwd: tempDir('cynco-ui-busy-'), config: config(), provider, emit: (e: any) => { events.push(e) } })
    loopRef = loop
    await loop.handleUserMessage('hi')
    expect(provider.calls).toBe(2)
    const roles: string[] = (loop as any).messages.map((m: any) => m.role + ':' + String(m.content?.[0]?.text ?? ''))
    const at = (prefix: string) => roles.findIndex(r => r.startsWith(prefix))
    expect(at('assistant:first, all done.')).toBeGreaterThanOrEqual(0)
    expect(at('user:\u25B6 Recalculate\n[UI action]')).toBeGreaterThan(at('assistant:first, all done.'))
    expect(at('assistant:second, all done.')).toBeGreaterThan(at('user:\u25B6 Recalculate\n[UI action]'))
    expect((loop as any).pendingUiActions).toEqual([])
    globalContract.clear()
  }, 30000)
})
