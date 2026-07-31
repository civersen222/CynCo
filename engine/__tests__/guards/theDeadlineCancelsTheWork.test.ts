/**
 * A deadline must cancel the work, not walk away from it.
 *
 * `embedWithDeadline` raced the embed against a timer, swallowed the loser's
 * rejection, and returned. Everything downstream kept running: the HTTP
 * request, the fallback-model probe, and the fire-and-forget `pullModel` — and
 * each of those narrates to the console. So a caller that had already given up
 * and fallen back to keyword recall still emitted, hundreds of milliseconds
 * later, lines like
 *
 *     [embed] "jina-code-embeddings-0.5b" unavailable — falling back to nomic-embed-text
 *     [embed] Pulling jina-code-embeddings-0.5b...
 *     [embed] Pull failed: {"error":"pull model manifest: file does not exist"}
 *
 * Under vitest that console traffic arrived after the worker had begun tearing
 * down, which vitest reports as `EnvironmentTeardownError: Closing rpc while
 * "onUserConsoleLog" was pending`. `engine/tools/impl/saveLearning.test.ts` sets
 * a 1ms deadline and so hit it every run: three passing tests, four errors, and
 * `npm test` exiting 1 on a clean tree with 3303 tests green. A suite that is
 * green in its own summary and red in its exit code is not a green suite.
 *
 * The docstring on `embedWithDeadline` already claimed this was handled. It had
 * handled the unhandled-rejection half and left the console half running, and
 * nothing measured the difference — so the comment stayed true-sounding for as
 * long as nobody checked.
 *
 * Silence after an abort is also the correct report, not merely a quiet one. A
 * cancelled request learned nothing about the server, so "no embedding endpoint
 * answered" is a claim this code is not entitled to make.
 *
 * Two of the cases below are anti-vacuity controls: a call that beats the
 * deadline still returns its vector, and a caller with no deadline still gets
 * the fallback and the narration. A client that had simply been gagged would
 * satisfy every other assertion here and would not be the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { EmbedClient, resetEmbedWarning } from '../../index/embedClient.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const realFetch = globalThis.fetch
const saved = {
  base: process.env.LOCALCODE_EMBED_BASE_URL,
  api: process.env.LOCALCODE_EMBED_API,
  model: process.env.LOCALCODE_EMBED_MODEL,
}

beforeEach(() => {
  delete process.env.LOCALCODE_EMBED_BASE_URL
  delete process.env.LOCALCODE_EMBED_API
  delete process.env.LOCALCODE_EMBED_MODEL
  resetEmbedWarning()
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of [
    ['LOCALCODE_EMBED_BASE_URL', saved.base],
    ['LOCALCODE_EMBED_API', saved.api],
    ['LOCALCODE_EMBED_MODEL', saved.model],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * The server that produced the original failure: it answers, but slowly, and
 * what it answers is "I do not have that model" — the one reply that sends the
 * client into the fallback-and-pull path that does all the talking.
 *
 * `delayMs` is how long every route takes. The stub honours `init.signal`,
 * because a stub that ignored cancellation could not tell a cancelled request
 * from a completed one, and that distinction is the whole subject here.
 */
function slowModelMissingServer(delayMs: number) {
  const seen: string[] = []
  const aborted: string[] = []
  globalThis.fetch = vi.fn((url: any, init: any) => {
    const u = String(url)
    // Tagged with the request's ordinal, because the first embed and the
    // fallback embed go to the same URL and "which one was cancelled" is the
    // question two of the cases below are asking.
    const id = `${seen.length}:${u}`
    seen.push(u)
    const signal: AbortSignal | undefined = init?.signal
    // Real fetch rejects immediately on a signal that is already aborted. A
    // stub that instead waited out its timer would let a cancelled client keep
    // probing and report that as success — the fixture would be answering for
    // the code under test.
    if (signal?.aborted) {
      aborted.push(id)
      return Promise.reject(new Error('The operation was aborted'))
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (u.endsWith('/api/pull')) return resolve(new Response('{"error":"pull model manifest: file does not exist"}', { status: 404 }))
        if (u.endsWith('/api/embed')) {
          const model = JSON.parse(init.body).model
          return model === 'jina-code-embeddings-0.5b'
            ? resolve(new Response('model "jina-code-embeddings-0.5b" not found', { status: 404 }))
            : resolve(new Response(JSON.stringify({ embeddings: [[0.4]] }), { status: 200 }))
        }
        resolve(new Response('no route', { status: 404 }))
      }, delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        aborted.push(id)
        reject(new Error('The operation was aborted'))
      })
    })
  }) as any
  return { seen, aborted }
}

/** Everything written to the console while `fn` ran, and for `graceMs` after. */
async function consoleDuring(fn: () => Promise<unknown>, graceMs: number): Promise<string[]> {
  const lines: string[] = []
  const push = (...a: any[]) => { lines.push(a.join(' ')) }
  const log = vi.spyOn(console, 'log').mockImplementation(push)
  const warn = vi.spyOn(console, 'warn').mockImplementation(push)
  try {
    await fn()
    // The defect was entirely in what happened AFTER the caller returned, so a
    // check that stopped at the return would have measured nothing.
    await sleep(graceMs)
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
  return lines
}

describe('a deadline cancels the request it gave up on', () => {
  it('aborts the in-flight embed instead of leaving it running', async () => {
    const { aborted } = slowModelMissingServer(400)
    const out = await new EmbedClient().embedWithDeadline('hello', 10)
    expect(out, 'the caller still falls back to lexical recall').toBeUndefined()
    await sleep(50)
    expect(aborted, 'the request the caller stopped waiting for must be cancelled')
      .toEqual(['0:http://localhost:11434/api/embed'])
  })

  it('stops asking once it has stopped waiting', async () => {
    // A cancelled first dialect is not evidence that the second one is worth
    // trying. Probing on regardless spends a request nobody is waiting for and
    // ends at the "no embedding endpoint answered" warning — a verdict on a
    // server that was never allowed to answer.
    const { seen } = slowModelMissingServer(400)
    await new EmbedClient().embedWithDeadline('hello', 10)
    await sleep(200)
    expect(seen, 'the client kept probing after its caller had gone')
      .toEqual(['http://localhost:11434/api/embed'])
  })

  it('cancels the fallback request too, not only the first one', async () => {
    // The deadline lands mid-fallback: the configured model came back missing
    // while the caller was still waiting, so the fallback and the pull are both
    // legitimate — and then the caller gives up. The second request has to be
    // cancellable for the same reason the first one was.
    const { seen, aborted } = slowModelMissingServer(10)
    await new EmbedClient().embedWithDeadline('hello', 25)
    await sleep(200)
    expect(seen.filter(u => u.endsWith('/api/embed')),
      'the fallback model should have been tried while the caller still waited').toHaveLength(2)
    expect(aborted.some(a => a.startsWith(`${seen.length - 1}:`)),
      'the fallback request outlived the deadline that was supposed to bound it').toBe(true)
  })

  it('never starts the background model pull after the caller has gone', async () => {
    const { seen } = slowModelMissingServer(20)
    await new EmbedClient().embedWithDeadline('hello', 5)
    await sleep(300)
    expect(seen.filter(u => u.endsWith('/api/pull')),
      'a pull whose completion log outlives every reader is work nobody can use')
      .toEqual([])
  })

  it('writes nothing to the console after the deadline has passed', async () => {
    const lines = await consoleDuring(async () => {
      slowModelMissingServer(20)
      await new EmbedClient().embedWithDeadline('hello', 5)
    }, 300)
    expect(lines, 'this console traffic is what vitest reported as EnvironmentTeardownError')
      .toEqual([])
  })

  it('does not report the server as unreachable when it was merely cancelled', async () => {
    const lines = await consoleDuring(async () => {
      slowModelMissingServer(400)
      await new EmbedClient().embedWithDeadline('hello', 5)
    }, 200)
    expect(lines.filter(l => l.includes('No embedding endpoint answered')),
      'a cancelled request learned nothing about the server').toEqual([])
  })
})

describe('the cancellation is scoped to callers who cancelled', () => {
  it('a call that beats its deadline still returns the vector', async () => {
    slowModelMissingServer(0)
    const out = await new EmbedClient().embedWithDeadline('hello', 2000)
    expect(out, 'a client that refused everything would satisfy every case above').toEqual([0.4])
  })

  it('a caller with no deadline still falls back and still says so', async () => {
    const lines = await consoleDuring(async () => {
      const { seen } = slowModelMissingServer(0)
      const out = await new EmbedClient().embedBatch(['hello'])
      expect(out).toEqual([[0.4]])
      await sleep(50)
      expect(seen.some(u => u.endsWith('/api/pull')),
        'the background pull is still wanted when nobody cancelled').toBe(true)
    }, 50)
    expect(lines.some(l => l.includes('unavailable — falling back')),
      'the narration must survive for callers who are still listening').toBe(true)
  })
})

describe('the cancellation reaches the wire', () => {
  it('the signal is handed to fetch rather than held at the top', () => {
    const src = readFileSync(join(repoRoot, 'engine/index/embedClient.ts'), 'utf-8')
    // A signal that is threaded through every internal call and then dropped at
    // the request would abort nothing at all.
    expect(src).toMatch(/body: JSON\.stringify\(\{ model, input: texts \}\),\r?\n\s*signal,/)
    expect(src, 'the deadline must actually fire the abort').toContain('abort.abort()')
  })
})
