/**
 * A streamed request that Ollama stops answering is cut, by the same clock as
 * llama-server's (F235).
 *
 * The clock was the llama.cpp provider's only. A mission on the Ollama path
 * (the default profile's provider, and the busy fallback on the other box) had
 * no engine-side limit at all: its stream read with the caller's signal and
 * nothing else, so a server that went quiet was only ever noticed by the
 * mission driver's thirty-minute backstop, and an interactive chat by nobody.
 *
 * A real HTTP server, as in the llama test: what must be pinned is that the
 * connection closes, in both silences a server has.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { OllamaProvider } from '../../ollama/client.js'
import { StreamStalledError, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS } from '../../providers/streamWatchdog.js'
import { StreamStalledError as FromLlama } from '../../llama/provider.js'
import { isRetryableError } from '../../engine/callModel.js'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
})
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`

type Script = Array<{ afterMs: number; data?: string; end?: boolean }>

/** A chat-completions endpoint that plays `script` (data at times; silence when it runs out without `end`). */
async function scriptedServer(script: Script, { headersFirst = true } = {}) {
  let closed!: () => void
  const sawClose = new Promise<'closed'>(r => { closed = () => r('closed') })
  const server = createServer(async (req, res: ServerResponse) => {
    req.resume()
    res.on('close', () => { if (!res.writableEnded) closed() })
    if (headersFirst) res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const step of script) {
      await sleep(step.afterMs)
      if (res.destroyed) return
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (step.data) res.write(step.data)
      if (step.end) { res.end(); return }
    }
    // Out of script without `end`: silence, holding the connection open.
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, sawClose }
}

function provider(url: string, opts: { firstByteMs?: number; idleMs?: number } = {}) {
  return new OllamaProvider({ baseUrl: url, streamFirstByteMs: opts.firstByteMs ?? 60_000, streamIdleMs: opts.idleMs ?? 60_000 })
}

/** Every event of one stream, or the error that ended it; `gaveUp` when neither came within `capMs`. */
async function collect(p: OllamaProvider, { signal, perEventMs = 0, capMs = 4000 }: { signal?: AbortSignal; perEventMs?: number; capMs?: number } = {}) {
  const events: any[] = []
  const run = (async () => {
    try {
      for await (const e of p.stream({ model: 'qwen3', messages: [], signal } as any)) {
        events.push(e)
        if (perEventMs) await sleep(perEventMs)
      }
      return { events, error: null as unknown, gaveUp: false }
    } catch (error) {
      return { events, error, gaveUp: false }
    }
  })()
  const cap = sleep(capMs).then(() => ({ events, error: null as unknown, gaveUp: true }))
  return Promise.race([run, cap])
}

describe('a stream Ollama stops answering is cut', () => {
  it('mid-reply: one chunk, then silence past the idle limit', async () => {
    const { url, sawClose } = await scriptedServer([{ afterMs: 0, data: chunk('Hel') }])
    const { events, error, gaveUp } = await collect(provider(url, { idleMs: 150 }))
    expect(gaveUp, 'the stream was still open four seconds after a 150 ms limit').toBe(false)
    expect(error).toBeInstanceOf(StreamStalledError)
    expect((error as StreamStalledError).phase).toBe('mid-stream')
    expect((error as Error).message).toMatch(/^Ollama stopped sending mid-reply: nothing for 0s; the request was cancelled \(F235\)$/)
    expect(events.some(e => e.type === 'content_block_delta')).toBe(true)
    // The connection is closed, which is what lets the server stop generating.
    expect(await Promise.race([sawClose, sleep(2000).then(() => 'still open')])).toBe('closed')
  })

  it('before the first byte: headers, then nothing', async () => {
    const { url, sawClose } = await scriptedServer([])
    const { error, gaveUp } = await collect(provider(url, { firstByteMs: 150 }))
    expect(gaveUp).toBe(false)
    expect(error).toBeInstanceOf(StreamStalledError)
    expect((error as StreamStalledError).phase).toBe('first-byte')
    expect((error as Error).message).toMatch(/^Ollama sent nothing for 0s after the request \(no first token\)/)
    expect(await Promise.race([sawClose, sleep(2000).then(() => 'still open')])).toBe('closed')
  })

  it('before the first byte: not even headers (the model is still loading, or the server is wedged)', async () => {
    const { url } = await scriptedServer([], { headersFirst: false })
    const { error, gaveUp } = await collect(provider(url, { firstByteMs: 150 }))
    expect(gaveUp).toBe(false)
    expect((error as StreamStalledError).phase).toBe('first-byte')
  })

  it('a reply that keeps arriving is never cut, however long the whole of it takes', async () => {
    const script: Script = [0, 80, 80, 80, 80].map((afterMs, i) => ({ afterMs, data: chunk(`t${i}`) }))
    script.push({ afterMs: 80, data: 'data: [DONE]\n\n', end: true })
    const { url } = await scriptedServer(script)
    const { events, error } = await collect(provider(url, { idleMs: 250, firstByteMs: 250 }))
    expect(error).toBeNull()
    expect(events.filter(e => e.type === 'content_block_delta')).toHaveLength(5)
    expect(events.at(-1)).toEqual({ type: 'message_stop' })
  })

  it('the time the caller spends on each event is not the server\'s silence', async () => {
    const { url } = await scriptedServer([{ afterMs: 0, data: chunk('a') + chunk('b') + chunk('c') + 'data: [DONE]\n\n', end: true }])
    const { events, error } = await collect(provider(url, { idleMs: 120 }), { perEventMs: 200 })
    expect(error).toBeNull()
    expect(events.at(-1)).toEqual({ type: 'message_stop' })
  })

  it('a Stop is a Stop, not a stall', async () => {
    const { url } = await scriptedServer([{ afterMs: 0, data: chunk('Hel') }])
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error('stopped by the owner')), 100)
    const { error, gaveUp } = await collect(provider(url, { idleMs: 60_000 }), { signal: ctrl.signal })
    expect(gaveUp).toBe(false)
    expect(error).not.toBeNull()
    expect(error).not.toBeInstanceOf(StreamStalledError)
  })

  it('a cut is not retried, and it is one error class whichever provider threw it', () => {
    expect(isRetryableError(new StreamStalledError('mid-stream', 600_000, 'Ollama'))).toBe(false)
    expect(FromLlama).toBe(StreamStalledError)
    expect(new StreamStalledError('first-byte', 1_200_000).message).toMatch(/^llama-server sent nothing for 1200s/)
  })

  it('the limits are the llama path\'s: twenty minutes to a first byte, ten between bytes', () => {
    expect(STREAM_FIRST_BYTE_MS).toBe(20 * 60_000)
    expect(STREAM_IDLE_MS).toBe(10 * 60_000)
  })
})
