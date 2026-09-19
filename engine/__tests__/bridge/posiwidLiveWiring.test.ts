/**
 * Phase 0 wire check for the live POSIWID reading and the IdentityGuard
 * record: the real ConversationLoop against a mock provider that makes 60
 * Read calls (49 of them denied by the read-loop gate) must put
 * `posiwidLive` on the governance.status frame with the session-long support
 * count, and `identityGuard` on the session_fidelity frame with the error
 * count that used to be 0 by construction.
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

function reads(cwd: string, n: number): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < n; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, `f-${i}.txt`) }) } } as any
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

describe('posiwidLive + identityGuard reach the wire', () => {
  it('status carries the session-long POSIWID reading; session_fidelity carries the guard with real error counts', async () => {
    globalContract.clear()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-posiwid-'))
    dirs.push(cwd)
    for (let i = 0; i < 10; i++) writeFileSync(join(cwd, `f-${i}.txt`), `file ${i}\n`)

    const statuses: any[] = []
    const fidelity: any[] = []
    const alerts: any[] = []
    const loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([reads(cwd, 10), reads(cwd, 10), reads(cwd, 10), reads(cwd, 10), reads(cwd, 10), reads(cwd, 10), done()]),
      emit: (e: any) => {
        if (e.type === 'governance.status') statuses.push(e)
        if (e.type === 'governance.session_fidelity') fidelity.push(e)
        if (e.type === 'governance.alert') alerts.push(e)
      },
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('read all of those files')

    const last = statuses.at(-1)
    expect(last.posiwidLive).not.toBeNull()
    expect(last.posiwidLive.support).toBe(60)
    expect(typeof last.posiwidLive.divergence).toBe('number')
    expect(['Consistent', 'Drifting', 'Contradicted', 'Insufficient']).toContain(last.posiwidLive.verdict)
    // The first frame is emitted before any call executes (null by design);
    // the second has 10 calls, under the 50-call support floor, and must say
    // so rather than invent a verdict.
    expect(statuses[0].posiwidLive).toBeNull()
    expect(statuses[1].posiwidLive.support).toBe(10)
    expect(statuses[1].posiwidLive.verdict).toBe('Insufficient')

    expect(fidelity).toHaveLength(1)
    const guard = fidelity[0].identityGuard
    expect(guard).not.toBeNull()
    expect(typeof guard.passed).toBe('boolean')
    expect(typeof guard.posiwidPass).toBe('boolean')
    // 49 of the 60 reads were denied by the read-loop gate: the guard now
    // sees them as errors (the old expression was 0 by construction), so a
    // gate-dominated session reads as POSIWID-failing here — recorded, not
    // enforced: `passed` is unchanged by it.
    expect(guard.posiwidPass).toBe(false)
    expect(guard.passed).toBe(true)

    // Denials dominate → the live reading is Contradicted, and the transition
    // raised exactly one warn alert from the posiwid source.
    expect(last.posiwidLive.verdict).toBe('Contradicted')
    expect(last.posiwidLive.dominantObserved).toBe('denied-or-error')
    expect(alerts.filter(a => a.source === 'posiwid')).toHaveLength(1)
    expect(alerts.find(a => a.source === 'posiwid').severity).toBe('warn')
    globalContract.clear()
  }, 60000)
})
