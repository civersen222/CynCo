/**
 * localCallModel hands the turn's abort signal to the provider and treats the
 * abort as an end, not a fault (F201).
 *
 * It took `signal` and never read it: the provider request could not be
 * cancelled, and while the loop waited for the first event (prompt
 * processing, the longest silent stretch of a call) a Stop was not seen at
 * all. Once the signal is forwarded the provider's fetch rejects on Stop —
 * and that rejection must not be retried as a transport failure or surface
 * as an error.
 *
 * The mock provider behaves as a fetch does: it rejects when the signal it
 * was given aborts. Given none, it fails after HANG_MS with a message that
 * says so.
 */
import { describe, expect, it } from 'vitest'
import type { Provider, CompletionRequest } from '../../provider.js'
import { localCallModel } from '../../engine/callModel.js'
import { LlamaCppProvider } from '../../llama/provider.js'
import { ProcessManager } from '../../llama/processManager.js'
import { createLazyEnsureReady } from '../../llama/lazyLoad.js'

const caps = { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true } as any
const config = { baseUrl: 'http://localhost:11434', model: 'x', tier: 'auto', temperature: 0.7, maxOutputTokens: 8192, timeout: 120000 } as any
const HANG_MS = 1500

function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('the provider was never told to stop')), HANG_MS)
    const stop = () => { clearTimeout(t); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) }
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop)
  })
}

function provider(mode: 'before the first event' | 'mid-stream') {
  const seen: Array<AbortSignal | undefined> = []
  const p = {
    name: 'mock',
    async *stream(request: CompletionRequest) {
      seen.push((request as any).signal)
      if (mode === 'mid-stream') {
        yield { type: 'message_start', message: { id: 'm1', model: 'x', usage: { input_tokens: 0, output_tokens: 0 } } } as any
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } as any
      }
      await untilAborted((request as any).signal)
    },
    async complete() { throw new Error('not implemented') },
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { return caps },
  } as unknown as Provider
  return { p, seen }
}

async function run(mode: 'before the first event' | 'mid-stream') {
  const { p, seen } = provider(mode)
  const ac = new AbortController()
  const gen = localCallModel({
    messages: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }] as any,
    systemPrompt: ['You are a helpful assistant.'] as any,
    thinkingConfig: { type: 'disabled' } as any,
    tools: [] as any,
    signal: ac.signal,
    options: { model: 'x' } as any,
    deps: { getProvider: () => p, loadConfig: () => config, resolveCapabilities: () => caps },
  })
  const yielded: any[] = []
  setTimeout(() => ac.abort(), 60)
  const started = Date.now()
  for await (const y of gen) yielded.push(y)
  return { yielded, seen, ms: Date.now() - started, signal: ac.signal }
}

describe('localCallModel and the turn abort signal', () => {
  // F204: the call counts the context's tokens before it asks the model, and on a lazy engine that count
  // waits for the model port too. The real provider, loader and process manager; a one-shot holds the GPU.
  it('a Stop while the call still waits for the model port ends it: neither the token count nor the request holds the turn', async () => {
    const pm = new ProcessManager({ binaryPath: '/bin/llama-server', modelPath: '/models/qwen.gguf', port: 8081 })
    let starts = 0
    ;(pm as any).startProcess = async () => { starts++ }
    const busy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: new Date().toISOString(), timeoutMs: 600_000, pid: 7 }
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081', modelName: 'x', modelsDir: '/fake',
      ensureReady: createLazyEnsureReady(pm, { readBusy: () => busy, maxWaitMs: 60_000, pollMs: 10_000 }),
    })
    const ac = new AbortController()
    const gen = localCallModel({
      messages: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }] as any,
      systemPrompt: ['You are a helpful assistant.'] as any,
      thinkingConfig: { type: 'disabled' } as any,
      tools: [] as any,
      signal: ac.signal,
      options: { model: 'x' } as any,
      deps: { getProvider: () => p, loadConfig: () => config, resolveCapabilities: () => caps },
    })
    const yielded: any[] = []
    let waitedOnThePort = false
    setTimeout(() => { waitedOnThePort = pm.modelState() === 'waiting'; ac.abort() }, 60)
    const outcome = await Promise.race([
      (async () => { for await (const y of gen) yielded.push(y); return 'ended' })(),
      new Promise<string>(r => setTimeout(() => r('still waiting for the model port'), 1500)),
    ])
    expect(outcome).toBe('ended')
    expect(waitedOnThePort).toBe(true)
    expect(yielded.filter(y => y.type === 'system' && y.subtype === 'api_retry')).toEqual([])
    expect(starts).toBe(0)
    expect(pm.modelState()).toBe('cold')
  })

  for (const mode of ['before the first event', 'mid-stream'] as const) {
    it(`a Stop ${mode} ends the call: the provider holds the signal, nothing is retried, nothing is thrown`, async () => {
      const { yielded, seen, ms, signal } = await run(mode)
      expect(seen).toEqual([signal])
      expect(yielded.filter(y => y.type === 'system' && y.subtype === 'api_retry')).toEqual([])
      expect(ms).toBeLessThan(HANG_MS)
    })
  }

  it('a Stop during the transport-retry backoff ends the call instead of waiting the backoff out and asking again', async () => {
    let calls = 0
    const p = {
      name: 'mock',
      async *stream() { calls++; throw new Error('fetch failed') },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return caps },
    } as unknown as Provider
    const ac = new AbortController()
    const gen = localCallModel({
      messages: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }] as any,
      systemPrompt: ['You are a helpful assistant.'] as any,
      thinkingConfig: { type: 'disabled' } as any,
      tools: [] as any,
      signal: ac.signal,
      options: { model: 'x' } as any,
      deps: { getProvider: () => p, loadConfig: () => config, resolveCapabilities: () => caps },
    })
    setTimeout(() => ac.abort(), 60)
    const started = Date.now()
    const outcome = await Promise.race([
      (async () => { for await (const _ of gen) { /* drain */ } return 'ended' })(),
      new Promise<string>(r => setTimeout(() => r('still backing off'), 1500)),
    ])
    expect(outcome).toBe('ended')
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(1500)
  })
})
