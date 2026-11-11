// Semantic search being off is said where the owner looks (F214).
//
// 2026-11-11: the embedding service was down for hours. The engine wrote
// "No embedding endpoint answered … Semantic code search is OFF for this
// session" to its log at every project open, once per process, and nothing
// reached the dashboard or the phone: the owner found out by asking why
// answers had got worse.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EmbedClient, embedOutage, embedOutageNotice, EMBED_BACK_NOTICE, resetEmbedWarning } from '../../index/embedClient.js'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { closeAllIndexers } from '../../index/indexer.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const realFetch = globalThis.fetch
let embedUp = false
/** An embedding server at 127.0.0.1:9165 that is down or up; everything else goes to the suite's fetch. */
function stubEmbedServer() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input)
    if (!url.startsWith('http://127.0.0.1:9165')) return realFetch(input, init)
    if (!embedUp) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9165'), { code: 'ECONNREFUSED' }) })
    const n = (JSON.parse(String(init?.body ?? '{}')).input ?? ['']).length
    return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) }), { status: 200 })
  }) as typeof fetch
}

beforeEach(() => {
  process.env.LOCALCODE_EMBED_BASE_URL = 'http://127.0.0.1:9165'
  process.env.LOCALCODE_EMBED_API = 'openai'
  embedUp = false
  resetEmbedWarning()
  stubEmbedServer()
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.LOCALCODE_EMBED_BASE_URL
  delete process.env.LOCALCODE_EMBED_API
  resetEmbedWarning()
  globalContract.clear()
})

describe('the embedding outage is a state, not a log line', () => {
  it('no outage before anything was asked', () => {
    expect(embedOutage()).toBeNull()
  })

  it('a server that does not answer opens an outage that names the address and the reason', async () => {
    await expect(new EmbedClient().embed('hello')).rejects.toThrow()
    const o = embedOutage()
    expect(o?.baseUrl).toBe('http://127.0.0.1:9165')
    expect(String(o?.detail)).toMatch(/fetch failed|ECONNREFUSED/)
  })

  it('the first answer closes it, and a later failure opens a new one', async () => {
    await expect(new EmbedClient().embed('hello')).rejects.toThrow()
    embedUp = true
    expect((await new EmbedClient().embed('hello')).length).toBe(3)
    expect(embedOutage()).toBeNull()
    embedUp = false
    await expect(new EmbedClient().embed('hello')).rejects.toThrow()
    expect(embedOutage()).not.toBeNull()
  })

  it('a cancelled request is not an outage: nothing was learned about the server', async () => {
    embedUp = true
    const stopped = new AbortController(); stopped.abort()
    globalThis.fetch = (async () => { throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }) }) as typeof fetch
    await expect(new EmbedClient().embed('hello', stopped.signal)).rejects.toThrow()
    expect(embedOutage()).toBeNull()
  })

  it('the notice says what is off, where, what still works, and on this PC how to start it', () => {
    const local = embedOutageNotice({ baseUrl: 'http://127.0.0.1:9165', detail: 'Unable to connect', since: 0 })
    expect(local).toBe('Semantic search is off: the embedding server at http://127.0.0.1:9165 does not answer (Unable to connect). Search uses keywords until it is back. To start it on this PC: scripts\\cynco-services.ps1 start embed')
    const remote = embedOutageNotice({ baseUrl: 'http://192.168.0.47:11434', since: 0 })
    expect(remote).toBe('Semantic search is off: the embedding server at http://192.168.0.47:11434 does not answer. Search uses keywords until it is back.')
  })
})

describe('the chat is told once when semantic search is off, and once when it is back', () => {
  const dirs: string[] = []
  afterEach(() => {
    closeAllIndexers()
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
  })

  function done(): () => Generator<StreamEvent> {
    return function* (): Generator<StreamEvent> {
      yield { type: 'message_start', message: { id: 'm', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
  }

  function makeLoop() {
    globalContract.clear()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-embed-outage-'))
    dirs.push(cwd)
    writeFileSync(join(cwd, 'f.txt'), 'x\n')
    const broadcasts: any[] = []
    const provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities(): Promise<ModelCapabilities> {
        return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
      },
      async complete() { throw new Error('not implemented') },
      async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { yield* done()() },
    } as Provider
    const config = {
      baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
      maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
    } as LocalCodeConfig
    const loop = new ConversationLoop({ cwd, config, provider, emit: () => {}, dashboardBroadcast: (m: any) => broadcasts.push(m), allowedTools: ['Read'] })
    const notices = () => broadcasts.filter(b => b.type === 'governance.alert' && /Semantic search/.test(String(b.message)))
    return { loop, notices }
  }

  it('one line in the chat on the turn that finds the server down, on the channel the page shows as a chat line; not again on the next turn', async () => {
    const { loop, notices } = makeLoop()
    await loop.handleUserMessage('where is the parser?')
    expect(notices().length).toBe(1)
    // source 'llama-cpp' + severity 'info' is what the dashboard page turns into a `model:` chat line (alertChatLine).
    expect(notices()[0]).toMatchObject({ type: 'governance.alert', severity: 'info', source: 'llama-cpp' })
    expect(notices()[0].message).toMatch(/^Semantic search is off: the embedding server at http:\/\/127\.0\.0\.1:9165 does not answer/)
    expect(notices()[0].message).toMatch(/cynco-services\.ps1 start embed/)

    await loop.handleUserMessage('and the lexer?')
    expect(notices().length).toBe(1)
  }, 60_000)

  it('when the server answers again the chat is told once, and a new outage is said again', async () => {
    const { loop, notices } = makeLoop()
    await loop.handleUserMessage('where is the parser?')
    embedUp = true
    await loop.handleUserMessage('and the lexer?')
    expect(notices().map(n => n.message)).toEqual([expect.stringMatching(/^Semantic search is off/), EMBED_BACK_NOTICE])
    await loop.handleUserMessage('and the printer?')
    expect(notices().length).toBe(2)
    embedUp = false
    await loop.handleUserMessage('and the emitter?')
    expect(notices().length).toBe(3)
    expect(notices()[2].message).toMatch(/^Semantic search is off/)
  }, 60_000)

  it('a chat opened while the outage lasts hears it on its first turn too', async () => {
    const first = makeLoop()
    await first.loop.handleUserMessage('where is the parser?')
    const second = makeLoop()
    await second.loop.handleUserMessage('hello')
    expect(second.notices().length).toBe(1)
  }, 60_000)

  it('a server that answers from the start says nothing', async () => {
    embedUp = true
    const { loop, notices } = makeLoop()
    await loop.handleUserMessage('where is the parser?')
    expect(notices()).toEqual([])
  }, 60_000)
})
