import { afterEach, describe, expect, it, vi } from 'bun:test'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { OllamaProvider } from '../../ollama/client.js'
import { GenerationError, ModelNotFoundError } from '../../ollama/errors.js'
import type { CompletionRequest } from '../../provider.js'

/**
 * GLM review O1 + O3c (docs/reviews/2026-11-06-glm5-engineering-review-triage.md).
 *
 * O1: Ollama up, model missing. `/v1/chat/completions` answers 404 with an
 * OpenAI-shaped error body. `complete()` used to hand that body to
 * `fromOpenAIResponse` and `stream()` used to yield `message_start`, find no
 * `data:` lines, and yield `message_stop` — a silent empty reply on the first
 * turn after a fresh install, when the fix is one `ollama pull`. The llama path
 * learnt this on 2026-06-12 (`engine/llama/provider.ts`, "Errors must THROW").
 *
 * O3c: every streamed turn wrote `.cynco-http-debug.json` and
 * `.cynco-sse-debug.json` into `process.cwd()` — the user's project folder —
 * and `console.log`ged per call. The loop's own debug files go through
 * `debugDir()`, never the project folder; the client was the outlier.
 */

const MODEL = 'qwen3.6'
const NOT_FOUND_BODY = {
  error: { message: `model "${MODEL}" not found, try pulling it first`, type: 'api_error', param: null, code: null },
}
const TAGS_BODY = {
  models: [
    { name: 'gemma4:31b', size: 1, modified_at: '2026-01-01' },
    { name: 'nomic-embed-text:latest', size: 1, modified_at: '2026-01-01' },
  ],
}

function url(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

/** A fetch whose chat endpoint fails with `status`/`body` and whose /api/tags lists two models. */
function failingFetch(status: number, body: unknown, contentType = 'application/json') {
  return async (input: string | URL | Request) => {
    const u = url(input)
    if (u.includes('/v1/chat/completions')) {
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': contentType },
      })
    }
    if (u.includes('/api/tags')) {
      return new Response(JSON.stringify(TAGS_BODY), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('Not Found', { status: 404 })
  }
}

const request: CompletionRequest = {
  model: MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  max_tokens: 64,
}

async function drain(provider: OllamaProvider): Promise<{ events: Array<{ type: string }>; error: unknown }> {
  const events: Array<{ type: string }> = []
  try {
    for await (const event of provider.stream(request)) events.push(event)
    return { events, error: null }
  } catch (error) {
    return { events, error }
  }
}

describe('OllamaProvider surfaces a missing model instead of an empty reply (O1)', () => {
  it('complete(): a 404 throws ModelNotFoundError naming the model, the installed models and the pull command', async () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: failingFetch(404, NOT_FOUND_BODY) })
    const err = await provider.complete(request).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ModelNotFoundError)
    const message = (err as Error).message
    expect(message).toContain(`"${MODEL}"`)
    expect(message).toContain('gemma4:31b')
    expect(message).toContain(`ollama pull ${MODEL}`)
  })

  it('stream(): a 404 throws before any event — no message_start/message_stop pair around nothing', async () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: failingFetch(404, NOT_FOUND_BODY) })
    const { events, error } = await drain(provider)
    expect(error).toBeInstanceOf(ModelNotFoundError)
    expect((error as Error).message).toContain(`ollama pull ${MODEL}`)
    expect(events).toEqual([])
  })

  it('the pull hint survives /api/tags being unreadable', async () => {
    const fetchFn = async (input: string | URL | Request) => {
      if (url(input).includes('/api/tags')) throw new Error('ECONNRESET')
      return failingFetch(404, NOT_FOUND_BODY)(input)
    }
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn })
    const err = await provider.complete(request).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ModelNotFoundError)
    expect((err as Error).message).toContain(`ollama pull ${MODEL}`)
  })

  it('any other non-2xx throws GenerationError carrying the status and the server detail', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      fetchFn: failingFetch(500, { error: { message: 'llama runner process has terminated: exit status 2' } }),
    })
    const err = await provider.complete(request).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GenerationError)
    expect((err as Error).message).toContain('HTTP 500')
    expect((err as Error).message).toContain('llama runner process has terminated')
  })

  it('a 503 keeps the "HTTP 503" spelling callModel.isRetryableError keys on', async () => {
    // engine/engine/callModel.ts treats `HTTP 503` + `Loading model` as a load
    // window to wait out, not a fault. The Ollama path must spell it the same
    // way the llama path does or a model warming up ends the session.
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      fetchFn: failingFetch(503, { error: { message: 'Loading model', type: 'unavailable_error' } }),
    })
    const { error } = await drain(provider)
    expect((error as Error).message).toContain('HTTP 503')
    expect((error as Error).message).toContain('Loading model')
  })
})

describe('a streamed turn leaves nothing behind in the project folder (O3c)', () => {
  const stamps = new Map<string, number | null>()
  const files = ['.cynco-http-debug.json', '.cynco-sse-debug.json'].map(f => join(process.cwd(), f))
  for (const f of files) stamps.set(f, existsSync(f) ? statSync(f).mtimeMs : null)

  afterEach(() => vi.restoreAllMocks())

  it('writes no .cynco-http-debug.json / .cynco-sse-debug.json into process.cwd() and logs nothing per call', async () => {
    const sse = [
      'data: {"id":"c1","model":"qwen3.6","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"id":"c1","model":"qwen3.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchFn = async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn })
    const { events, error } = await drain(provider)
    expect(error).toBeNull()
    expect(events[0]?.type).toBe('message_start')
    expect(events[events.length - 1]?.type).toBe('message_stop')

    for (const f of files) {
      const before = stamps.get(f) ?? null
      const after = existsSync(f) ? statSync(f).mtimeMs : null
      expect(after, `${f} was written by stream()`).toBe(before)
    }
    const ollamaLines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[ollama]'))
    expect(ollamaLines).toEqual([])
  })
})
