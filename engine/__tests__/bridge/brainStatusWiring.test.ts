/**
 * Phase 2 wire check for the brain frame (2a-ii): the real ConversationLoop
 * against a mock provider must carry `brain` on every governance.status —
 * the consumer's tier, its layer-convergence window, and this turn's tool
 * entropy — and must reset the convergence window at each model call so the
 * frame describes the turn it rides on rather than the whole session.
 *
 * Data only: nothing in the loop branches on `brain`. The frame is validated
 * on the ledger (`--signals`) before anything reads it.
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
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

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

/** A coin-flip over two candidates: H = ln 2. */
const flip = (token: string) => [{
  token, logprob: Math.log(0.5),
  top: [{ token, logprob: Math.log(0.5) }, { token: 'other', logprob: Math.log(0.5) }],
}]

function reads(cwd: string, n: number, logprobs = false): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < n; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
      yield {
        type: 'content_block_delta', index: i,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ file_path: join(cwd, `f-${i}.txt`) }),
          ...(logprobs ? { logprobs: flip('Read') } : {}),
        },
      } as any
      yield { type: 'content_block_stop', index: i } as any
    }
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

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'cynco-brain-status-'))
  dirs.push(cwd)
  for (let i = 0; i < 3; i++) writeFileSync(join(cwd, `f-${i}.txt`), `file ${i}\n`)
  return cwd
}

describe('governance.status carries the brain frame', () => {
  it('reports the consumer tier and its layer convergence, and resets the window per model call', async () => {
    globalContract.clear()
    const cwd = workspace()
    const statuses: any[] = []
    let resets = 0

    const loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([reads(cwd, 1), done()]),
      emit: (e: any) => { if (e.type === 'governance.status') statuses.push(e) },
      allowedTools: ['Read'],
      getBrain: () => ({
        tier: 'live',
        layerConvergence: { n: 3, meanAgree: 0.5, meanDepth: 40, byLayer: {} },
        reset: () => { resets++ },
      }),
    })
    await loop.handleUserMessage('read one file then stop')

    expect(statuses.length).toBeGreaterThanOrEqual(2)     // one per model call
    const last = statuses.at(-1)
    expect(last.brain).not.toBeNull()
    expect(last.brain.tier).toBe('live')
    expect(last.brain.layerConvergence.meanAgree).toBe(0.5)
    expect(last.brain.layerConvergence.n).toBe(3)
    // Two model calls, and the window is cleared at the start of each.
    expect(resets).toBeGreaterThanOrEqual(2)
    globalContract.clear()
  }, 60000)

  it('reports null convergence when the window is empty, and null tool entropy with no tool tokens', async () => {
    globalContract.clear()
    const cwd = workspace()
    const statuses: any[] = []

    const loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([done()]),
      emit: (e: any) => { if (e.type === 'governance.status') statuses.push(e) },
      getBrain: () => ({
        tier: 'record-only',
        layerConvergence: { n: 0, meanAgree: null, meanDepth: null, byLayer: { '24': null } },
        reset: () => {},
      }),
    })
    await loop.handleUserMessage('say done')

    const last = statuses.at(-1)
    expect(last.brain.tier).toBe('record-only')
    // n === 0 is not a measurement — it must not read as "converged on nothing".
    expect(last.brain.layerConvergence).toBeNull()
    // The mock provider streams no logprobs, so there is no entropy to digest.
    expect(last.brain.toolEntropy).toBeNull()
    globalContract.clear()
  }, 60000)

  it('carries the turn tool-entropy digest, which the per-call uncertainty reset would otherwise have erased', async () => {
    // The loop resets `uncertainty` before it emits governance.status, so the
    // digest has to be captured at the reset or the field is null forever.
    globalContract.clear()
    const cwd = workspace()
    const statuses: any[] = []

    const loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([reads(cwd, 1, true), done()]),
      emit: (e: any) => { if (e.type === 'governance.status') statuses.push(e) },
      allowedTools: ['Read'],
      getBrain: () => ({ tier: 'live', layerConvergence: null, reset: () => {} }),
    })
    await loop.handleUserMessage('read one file then stop')

    // The frame for the tool-calling model call, not the text-only one after it.
    const withEntropy = statuses.filter(s => s.brain?.toolEntropy)
    expect(withEntropy.length).toBeGreaterThanOrEqual(1)
    expect(withEntropy[0].brain.toolEntropy.mean).toBeCloseTo(Math.log(2), 5)
    expect(withEntropy[0].brain.toolEntropy.spikeCount).toBe(0)
    globalContract.clear()
  }, 60000)

  it('is null when no brain dep is wired (Ollama, or the consumer never started)', async () => {
    globalContract.clear()
    const cwd = workspace()
    const statuses: any[] = []

    const loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([done()]),
      emit: (e: any) => { if (e.type === 'governance.status') statuses.push(e) },
    })
    await loop.handleUserMessage('say done')

    expect(statuses.at(-1).brain).toBeNull()
    globalContract.clear()
  }, 60000)
})
