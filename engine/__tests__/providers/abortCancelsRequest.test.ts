/**
 * Stop reaches the inference server (F201).
 *
 * A provider's request used to carry no abort signal, so a Stop ended the
 * loop and left the HTTP request open: the server went on generating into a
 * socket nobody read. llama-server and Ollama both cancel a generation when
 * the client goes away, so the thing to pin is the connection: an aborted
 * `request.signal` closes it, while the server is still working on the prompt
 * (no response yet) and in the middle of a stream.
 *
 * A real HTTP server, not a stubbed fetch: the socket closing is the behaviour.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { LlamaCppProvider } from '../../llama/provider.js'
import { OllamaProvider } from '../../ollama/client.js'
import { OpenAICompatProvider } from '../../providers/openaiCompat.js'
import type { Provider } from '../../provider.js'

type Mode = 'before the first byte' | 'mid-stream'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
})

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** A chat-completions endpoint that never finishes: silent, or one delta and then silence. */
async function hangingServer(mode: Mode) {
  let requested!: () => void
  let closed!: () => void
  const gotRequest = new Promise<void>(r => { requested = r })
  const sawClose = new Promise<'closed'>(r => { closed = () => r('closed') })
  const open: ServerResponse[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
    req.resume()
    res.on('close', () => { if (!res.writableEnded) closed() })
    open.push(res)
    if (mode === 'mid-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n')
    }
    requested()
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, gotRequest, sawClose }
}

const PROVIDERS: Array<[string, (url: string) => Provider]> = [
  ['llama.cpp', url => new LlamaCppProvider({ primaryUrl: url, modelName: 'm', modelsDir: '/fake/models' })],
  ['Ollama', url => new OllamaProvider({ baseUrl: url })],
  ['OpenAI-compatible', url => new OpenAICompatProvider({ name: 'compat', baseUrl: url, apiKey: 'test-key' })],
]

describe('an aborted request.signal closes the provider request', () => {
  for (const [name, make] of PROVIDERS) {
    for (const mode of ['before the first byte', 'mid-stream'] as Mode[]) {
      it(`${name}: stream, ${mode}`, async () => {
        const srv = await hangingServer(mode)
        const ac = new AbortController()
        const iter = make(srv.url).stream({
          model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], signal: ac.signal,
        } as any)[Symbol.asyncIterator]()
        let sawText!: () => void
        const text = new Promise<void>(r => { sawText = r })
        // Reads until the stream ends or throws; either is an end.
        const pump = (async (): Promise<string> => {
          try {
            for (;;) {
              const r = await iter.next()
              if (r.done) return 'ended'
              if ((r.value as any)?.delta?.type === 'text_delta') sawText()
            }
          } catch { return 'ended' }
        })()

        await srv.gotRequest
        if (mode === 'mid-stream') await text
        ac.abort()

        expect(await Promise.race([srv.sawClose, sleep(3000).then(() => 'the request is still open')])).toBe('closed')
        expect(await Promise.race([pump, sleep(3000).then(() => 'the consumer is still reading')])).toBe('ended')
      })
    }

    it(`${name}: complete`, async () => {
      const srv = await hangingServer('before the first byte')
      const ac = new AbortController()
      const call = make(srv.url).complete({
        model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], signal: ac.signal,
      } as any).then(() => 'answered', () => 'ended')

      await srv.gotRequest
      ac.abort()

      expect(await Promise.race([srv.sawClose, sleep(3000).then(() => 'the request is still open')])).toBe('closed')
      expect(await Promise.race([call, sleep(3000).then(() => 'the caller is still waiting')])).toBe('ended')
    })
  }
})
