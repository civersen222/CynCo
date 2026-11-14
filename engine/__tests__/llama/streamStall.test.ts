/**
 * F235: a streamed request that llama-server stops answering is cut.
 *
 * 2026-11-14, the t5 wave: the model finished its thinking, sent one token of
 * its answer, and llama-server sent nothing more for 73 minutes while holding
 * its only slot. The provider's read had no clock, so nothing timed out.
 *
 * A real HTTP server, not a stubbed fetch, as in abortCancelsRequest.test.ts:
 * what must be pinned is that the CONNECTION closes (that is what makes
 * llama-server cancel the task and free the slot), in both silences the
 * server has: before the first byte (prompt processing) and mid-reply.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { LlamaCppProvider, StreamStalledError, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS } from '../../llama/provider.js'
import { ProcessManager } from '../../llama/processManager.js'
import { isRetryableError } from '../../engine/callModel.js'
import { readFileSync } from 'fs'
import { join } from 'path'

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

function provider(url: string, opts: { firstByteMs?: number; idleMs?: number; stalls?: StreamStalledError[] } = {}) {
  return new LlamaCppProvider({
    primaryUrl: url, modelName: 'qwen', modelsDir: '/fake/models', uncertaintyTrace: false,
    streamFirstByteMs: opts.firstByteMs ?? 60_000, streamIdleMs: opts.idleMs ?? 60_000,
    onStreamStall: (e) => { opts.stalls?.push(e) },
  })
}

async function collect(p: LlamaCppProvider, signal?: AbortSignal, perEventMs = 0) {
  const events: any[] = []
  try {
    for await (const e of p.stream({ model: 'qwen', messages: [], signal } as any)) {
      events.push(e)
      if (perEventMs) await sleep(perEventMs)
    }
    return { events, error: null as unknown }
  } catch (error) {
    return { events, error }
  }
}

describe('a stream llama-server stops answering is cut (F235)', () => {
  it('mid-reply: the text that came is delivered, then the silence is cut and the connection closed', async () => {
    const srv = await scriptedServer([{ afterMs: 0, data: chunk('The answer') }])
    const stalls: StreamStalledError[] = []
    const t0 = Date.now()
    const { events, error } = await collect(provider(srv.url, { idleMs: 300, stalls }))
    expect(error).toBeInstanceOf(StreamStalledError)
    expect((error as StreamStalledError).phase).toBe('mid-stream')
    expect(String((error as Error).message)).toMatch(/stopped sending mid-reply: nothing for 0s; the request was cancelled \(F235\)/)
    expect(events.some(e => e.type === 'content_block_delta' && e.delta?.text === 'The answer')).toBe(true)
    expect(events.some(e => e.type === 'message_stop')).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(await Promise.race([srv.sawClose, sleep(2000).then(() => 'still open')])).toBe('closed')
    expect(stalls).toHaveLength(1)
  })

  it('before the first byte (prompt processing never ends): cut by the first-byte limit', async () => {
    // llama-server answers a streamed request only once its first token exists: no headers, no bytes.
    const srv = await scriptedServer([], { headersFirst: false })
    const stalls: StreamStalledError[] = []
    const { events, error } = await collect(provider(srv.url, { firstByteMs: 300, idleMs: 60_000, stalls }))
    expect(error).toBeInstanceOf(StreamStalledError)
    expect((error as StreamStalledError).phase).toBe('first-byte')
    expect(String((error as Error).message)).toMatch(/sent nothing for 0s after the request \(no first token\)/)
    expect(events).toEqual([])
    expect(await Promise.race([srv.sawClose, sleep(2000).then(() => 'still open')])).toBe('closed')
    expect(stalls.map(s => s.phase)).toEqual(['first-byte'])
  })

  it('headers but no body is the first-byte phase too', async () => {
    const srv = await scriptedServer([], { headersFirst: true })
    const { error } = await collect(provider(srv.url, { firstByteMs: 300, idleMs: 60_000 }))
    expect((error as StreamStalledError).phase).toBe('first-byte')
  })

  it('a slow prompt under the first-byte limit, then a steady stream with gaps under the idle limit, is never cut', async () => {
    const srv = await scriptedServer([
      { afterMs: 400, data: chunk('a') },
      { afterMs: 150, data: chunk('b') },
      { afterMs: 150, data: chunk('c') },
      { afterMs: 150, data: 'data: [DONE]\n\n', end: true },
    ], { headersFirst: false })
    const stalls: StreamStalledError[] = []
    const { events, error } = await collect(provider(srv.url, { firstByteMs: 1000, idleMs: 300, stalls }))
    expect(error).toBeNull()
    expect(events.filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join('')).toBe('abc')
    expect(events.at(-1)?.type).toBe('message_stop')
    expect(stalls).toEqual([])
  })

  it('time the caller spends on the events is not the server\'s silence', async () => {
    const srv = await scriptedServer([
      { afterMs: 0, data: chunk('a') + chunk('b') + chunk('c') },
      { afterMs: 50, data: 'data: [DONE]\n\n', end: true },
    ])
    const { error, events } = await collect(provider(srv.url, { idleMs: 200 }), undefined, 150)
    expect(error).toBeNull()
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  it('a Stop during the silence is a Stop, not a stall: nothing is reported or recovered', async () => {
    const srv = await scriptedServer([{ afterMs: 0, data: chunk('x') }])
    const stalls: StreamStalledError[] = []
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 150)
    const { error } = await collect(provider(srv.url, { idleMs: 2000, stalls }), ctrl.signal)
    expect(error).not.toBeInstanceOf(StreamStalledError)
    expect(stalls).toEqual([])
    expect(await Promise.race([srv.sawClose, sleep(2000).then(() => 'still open')])).toBe('closed')
  })

  it('the cut is never retried by callModel: re-issuing a stalled request would only wait again', () => {
    expect(isRetryableError(new StreamStalledError('mid-stream', 600_000))).toBe(false)
    expect(isRetryableError(new StreamStalledError('first-byte', 1_200_000))).toBe(false)
  })

  it('the limits: twenty minutes for the first byte, ten between bytes', () => {
    expect(STREAM_FIRST_BYTE_MS).toBe(20 * 60_000)
    expect(STREAM_IDLE_MS).toBe(10 * 60_000)
  })
})

describe('ProcessManager.recoverFromStall (F235)', () => {
  const pmWith = (calls: string[], fail = false) => {
    const pm = new ProcessManager({ binaryPath: '/bin/llama-server', modelPath: '/models/qwen.gguf', port: 8081 })
    ;(pm as any).stop = async () => { calls.push('stop'); await sleep(20) }
    ;(pm as any).startProcess = async () => { calls.push('start'); if (fail) throw new Error('refused: low memory') }
    ;(pm as any).restoreSlot = async () => { calls.push('restore'); return { ok: true, detail: '' } }
    return pm
  }
  it('a lazy engine stops the server; the next request loads it fresh', async () => {
    const calls: string[] = []
    await pmWith(calls).recoverFromStall(true)
    expect(calls).toEqual(['stop'])
  })
  it('an eager engine restarts it and restores the slot snapshot, in that order', async () => {
    const calls: string[] = []
    await pmWith(calls).recoverFromStall(false)
    expect(calls).toEqual(['stop', 'start', 'restore'])
  })
  it('a second cut while one recovery runs joins it; a failed restart is logged, never thrown', async () => {
    const calls: string[] = []
    const pm = pmWith(calls, true)
    await Promise.all([pm.recoverFromStall(false), pm.recoverFromStall(false)])
    expect(calls).toEqual(['stop', 'start'])
    await pm.recoverFromStall(true)
    expect(calls).toEqual(['stop', 'start', 'stop'])
  })
  it('the bootstrap hands every cut to it, lazy or eager as the engine is', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'bootstrapProvider.ts'), 'utf-8')
    expect(src).toContain('onStreamStall: () => { void processManager.recoverFromStall(lazy.lazy) },')
  })
})
