// engine/__tests__/daemon/ntfyChannel.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import http from 'node:http'
import { NtfyChannel } from '../../daemon/ntfyChannel.js'

type Captured = { path: string; body: any; auth?: string }

function startMockNtfy(): Promise<{
  url: string
  captured: Captured[]
  sendSse: (data: object) => void
  close: () => Promise<void>
}> {
  const captured: Captured[] = []
  let sseRes: http.ServerResponse | null = null
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\n')
        sseRes = res
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          body: body ? JSON.parse(body) : null,
          auth: req.headers['authorization'] as string | undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        sendSse: (data) => {
          sseRes?.write(`data: ${JSON.stringify(data)}\n\n`)
        },
        close: () => new Promise((r) => { sseRes?.end(); server.close(() => r()) }),
      })
    })
  })
}

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => { await cleanup?.(); cleanup = null })

describe('NtfyChannel', () => {
  it('publishes JSON with topic, title, message, and auth token', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, token: 'tk_secret', alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    const ok = await ch.publish({ title: 'Hi', message: 'Hello' })
    expect(ok).toBe(true)
    expect(mock.captured.length).toBe(1)
    expect(mock.captured[0].body.topic).toBe('cynco-alerts')
    expect(mock.captured[0].body.title).toBe('Hi')
    expect(mock.captured[0].auth).toBe('Bearer tk_secret')
  })

  it('attaches approve/reject http actions that POST to the command topic', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    await ch.publishRecommendation({ id: 'rec-9', actionType: 'waiver', summary: 'Claim X', detail: 'why' })
    const actions = mock.captured[0].body.actions
    expect(actions.length).toBe(2)
    expect(actions[0].action).toBe('http')
    expect(actions[0].url).toContain('cynco-commands')
    expect(JSON.parse(actions[0].body)).toEqual({ recId: 'rec-9', verdict: 'approve' })
    expect(JSON.parse(actions[1].body)).toEqual({ recId: 'rec-9', verdict: 'reject' })
  })

  it('http actions carry the auth token so the phone can POST to a deny-all server', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, token: 'tk_secret', alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    await ch.publishRecommendation({ id: 'rec-9', actionType: 'waiver', summary: 'Claim X', detail: 'why' })
    const actions = mock.captured[0].body.actions
    expect(actions[0].headers).toEqual({ Authorization: 'Bearer tk_secret' })
    expect(actions[1].headers).toEqual({ Authorization: 'Bearer tk_secret' })
  })

  it('queues failed publishes and flushes them on the next publish', async () => {
    const ch = new NtfyChannel({
      baseUrl: 'http://127.0.0.1:1', alertTopic: 'a', commandTopic: 'c', // nothing listening
    })
    const ok = await ch.publish({ title: 'queued', message: 'm' })
    expect(ok).toBe(false)
    expect(ch.queuedCount).toBe(1)

    const mock = await startMockNtfy()
    cleanup = mock.close
    ;(ch as any).baseUrl = mock.url // point at live server
    await ch.publish({ title: 'second', message: 'm' })
    expect(mock.captured.length).toBe(2) // queued one + new one
    expect(ch.queuedCount).toBe(0)
  })

  it('receives commands over SSE', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, alertTopic: 'a', commandTopic: 'cynco-commands',
    })
    const got: any[] = []
    const stop = ch.subscribe((cmd) => got.push(cmd))
    await new Promise((r) => setTimeout(r, 200)) // let SSE connect
    mock.sendSse({ message: JSON.stringify({ recId: 'rec-1', verdict: 'approve' }) })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got).toEqual([{ recId: 'rec-1', verdict: 'approve' }])
  })

  it('ignores malformed SSE messages', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({ baseUrl: mock.url, alertTopic: 'a', commandTopic: 'c' })
    const got: any[] = []
    const stop = ch.subscribe((cmd) => got.push(cmd))
    await new Promise((r) => setTimeout(r, 200))
    mock.sendSse({ message: 'not json' })
    mock.sendSse({ message: JSON.stringify({ nope: true }) })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got.length).toBe(0)
  })

  it('caps the offline queue at MAX_QUEUE (100) dropping oldest', async () => {
    const ch = new NtfyChannel({
      baseUrl: 'http://127.0.0.1:1', alertTopic: 'a', commandTopic: 'c',
    })
    for (let i = 0; i < 105; i++) {
      await ch.publish({ title: `msg-${i}`, message: 'm' })
    }
    expect(ch.queuedCount).toBe(100)
  })

  it('serializes concurrent publishes so the queue is not flushed twice', async () => {
    const ch = new NtfyChannel({
      baseUrl: 'http://127.0.0.1:1', alertTopic: 'a', commandTopic: 'c', // nothing listening
    })
    await ch.publish({ title: 'queued', message: 'm' })
    expect(ch.queuedCount).toBe(1)

    const mock = await startMockNtfy()
    cleanup = mock.close
    ;(ch as any).baseUrl = mock.url
    await Promise.all([
      ch.publish({ title: 'a1', message: 'm' }),
      ch.publish({ title: 'a2', message: 'm' }),
    ])
    // queued + a1 + a2, with the queued item sent exactly once
    expect(mock.captured.length).toBe(3)
    expect(mock.captured.filter((c) => c.body.title === 'queued').length).toBe(1)
  })

  it('backs off when SSE connections close cleanly right after connecting', async () => {
    let connectionCount = 0
    const server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.endsWith('/sse')) {
          connectionCount++
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(': bye\n\n') // clean close immediately — no error thrown client-side
          return
        }
        res.writeHead(404)
        res.end()
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })

    const port = (server.address() as any).port
    const ch = new NtfyChannel({
      baseUrl: `http://127.0.0.1:${port}`,
      alertTopic: 'a',
      commandTopic: 'c',
      idleTimeoutMs: 5000,
      reconnectBaseMs: 50,
    })
    let stop: (() => void) | null = null
    try {
      stop = ch.subscribe(() => {})
      await new Promise((r) => setTimeout(r, 500))
      // With backoff (50, 100, 200, 400ms) at most ~5 connects fit in 500ms.
      // A hot reconnect loop would produce dozens.
      expect(connectionCount).toBeGreaterThanOrEqual(2)
      expect(connectionCount).toBeLessThanOrEqual(6)
    } finally {
      stop?.()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('reconnects after idle timeout when SSE server sends no data', async () => {
    let connectionCount = 0
    const server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.endsWith('/sse')) {
          connectionCount++
          // Accept the connection, send headers only, never send data
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.flushHeaders()
          // hold connection open until client aborts
          req.on('close', () => { res.end() })
          return
        }
        res.writeHead(404)
        res.end()
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })

    const port = (server.address() as any).port
    const url = `http://127.0.0.1:${port}`

    const ch = new NtfyChannel({
      baseUrl: url,
      alertTopic: 'a',
      commandTopic: 'c',
      idleTimeoutMs: 100,
      reconnectBaseMs: 50,
    })
    let stop: (() => void) | null = null
    try {
      stop = ch.subscribe(() => {})
      // Wait long enough for: connect → idle timeout (100ms) → reconnect backoff (50ms) → second connect
      await new Promise((r) => setTimeout(r, 600))
      expect(connectionCount).toBeGreaterThanOrEqual(2)
    } finally {
      stop?.()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
