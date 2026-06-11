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
})
