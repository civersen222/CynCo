/**
 * F158: `governance.session_fidelity` (the regulator fidelity + IdentityGuard
 * reading the mission driver writes onto the ledger row) used to be emitted
 * only on runModelLoop's natural "no tool calls" branch. A mission that hit its
 * wall clock (abort), its iteration cap, a halt or an engine error left the
 * loop without passing there, so 279 of 280 ledger rows read
 * `identityGuard: null`. Every exit path now emits exactly one frame.
 *
 * The real ConversationLoop against a mock provider, as posiwidLiveWiring does.
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
const prevMax = process.env.LOCALCODE_MAX_ITERATIONS
afterEach(() => {
  if (prevMax === undefined) delete process.env.LOCALCODE_MAX_ITERATIONS; else process.env.LOCALCODE_MAX_ITERATIONS = prevMax
  globalContract.clear()
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
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
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { const gen = responses[idx++]; if (gen) yield* gen() },
  } as Provider
}

function read(cwd: string, onStart?: () => void): () => Generator<StreamEvent> {
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

function setup(responses: (cwd: string, abort: () => void) => Array<() => Generator<StreamEvent>>) {
  globalContract.clear()
  const cwd = mkdtempSync(join(tmpdir(), 'cynco-f158-'))
  dirs.push(cwd)
  writeFileSync(join(cwd, 'f.txt'), 'x\n')
  const frames: any[] = []
  const completes: any[] = []
  let loop: ConversationLoop | null = null
  loop = new ConversationLoop({
    cwd, config: config(),
    provider: mockProvider(responses(cwd, () => loop!.abort())),
    emit: (e: any) => {
      if (e.type === 'governance.session_fidelity') frames.push(e)
      if (e.type === 'message.complete') completes.push(e)
    },
    allowedTools: ['Read'],
  })
  return { loop, frames, completes }
}

function expectOneFrame(frames: any[]) {
  expect(frames).toHaveLength(1)
  expect(frames[0].identityGuard).not.toBeNull()
  expect(typeof frames[0].identityGuard.passed).toBe('boolean')
  expect(frames[0].fidelity).toBeDefined()
}

describe('F158: session_fidelity on every exit path', () => {
  it('a natural turn end still emits exactly one frame', async () => {
    const { loop, frames } = setup((cwd) => [read(cwd), done()])
    await loop.handleUserMessage('read f.txt')
    expectOneFrame(frames)
  }, 60000)

  it('an aborted run (the mission wall clock) emits exactly one frame with a non-null identityGuard', async () => {
    const { loop, frames } = setup((cwd, abort) => [read(cwd), read(cwd, abort), done()])
    await loop.handleUserMessage('read f.txt')
    expectOneFrame(frames)
  }, 60000)

  it('a run that hits the iteration cap emits exactly one frame', async () => {
    process.env.LOCALCODE_MAX_ITERATIONS = '2'
    const { loop, frames, completes } = setup((cwd) => [read(cwd), read(cwd), read(cwd), read(cwd)])
    await loop.handleUserMessage('read f.txt')
    expect(completes.some(c => c.stopReason === 'max_iterations')).toBe(true)
    expectOneFrame(frames)
  }, 60000)

  it('a second user message gets its own frame, not one left over from the first', async () => {
    const { loop, frames } = setup((cwd) => [read(cwd), done(), done()])
    await loop.handleUserMessage('read f.txt')
    await loop.handleUserMessage('again')
    expect(frames).toHaveLength(2)
  }, 60000)
})
