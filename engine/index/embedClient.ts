/**
 * Embedding client for the semantic code index.
 *
 * Two things here were wrong, and they compounded.
 *
 * The first is the endpoint. `main.ts` built the project indexer with
 * `new ProjectIndexer(cwd, config.baseUrl)` — the *chat* base URL. Under the
 * Ollama provider that is `http://localhost:11434` and it happens to be right.
 * Under the llama.cpp direct provider it is the llama-server port, so the
 * indexer POSTed `/api/embed` at a server that has no such route and every
 * embed failed, while the other five construction sites (recall, saveLearning,
 * the conversation-loop health probe, indexResearch) used the built-in Ollama
 * default and pointed somewhere else entirely. The same engine embedded against
 * two different endpoints depending on which line of code asked.
 * `embedBaseUrlFor` is now the single answer to "where do embeddings come
 * from", and it forwards the chat URL only when the chat provider is the one
 * that also serves embeddings.
 *
 * The second is the dialect. This file spoke only Ollama's `/api/embed`, so
 * "automatic vector indexing" was unreachable for anyone not running Ollama,
 * and the failure was silent — retrieval quietly degraded to keyword search.
 * `llama-server --embeddings` and most other local servers expose the
 * OpenAI-shaped `/v1/embeddings`, so both are spoken now: the first one that
 * answers is remembered for the rest of the process, and `LOCALCODE_EMBED_API`
 * pins it when a server would rather not be probed.
 *
 * What is NOT claimed: that a chat model can embed. A generation server only
 * answers `/v1/embeddings` if it was started with `--embeddings`, and a
 * code-specialised embedding model is a better answer than a 27B generalist
 * either way. This makes the capability reachable and its absence audible; it
 * does not conjure an embedding model that isn't running.
 */

export type EmbedDialect = 'ollama' | 'openai'

/**
 * Where embeddings come from, given the chat configuration.
 *
 * `LOCALCODE_EMBED_BASE_URL` wins outright — it is the knob for "my embedding
 * server is somewhere else", which is the common case once the chat model is
 * llama.cpp. Otherwise the chat URL is reused only under the Ollama provider,
 * because that is the only provider whose URL is also an embedding endpoint.
 * Everything else falls back to the local Ollama default, which is a guess, but
 * a guess at a well-known port rather than at a port known to be wrong.
 */
export function embedBaseUrlFor(config?: { provider?: string; baseUrl?: string }): string {
  const explicit = process.env.LOCALCODE_EMBED_BASE_URL
  if (explicit) return explicit
  if (config?.provider === 'ollama' && config.baseUrl) return config.baseUrl
  return 'http://localhost:11434'
}

/** An HTTP-level failure from an embedding endpoint, with the body kept. */
class EmbedHttpError extends Error {
  constructor(readonly status: number, readonly body: string, url: string) {
    super(`Embed request failed (${status}) at ${url}: ${body.slice(0, 200)}`)
  }
}

let unavailableWarned = false

/**
 * Say once, out loud, that the semantic index is not available.
 *
 * The degradation was already published on `context.status`, which a dashboard
 * reader sees and a terminal user does not. A user who followed the README's
 * "automatic vector indexing" was getting ripgrep and no sentence anywhere told
 * them so.
 */
export function warnEmbedUnavailable(baseUrl: string, detail?: string): void {
  if (unavailableWarned) return
  unavailableWarned = true
  console.log(
    `[embed] No embedding endpoint answered at ${baseUrl}` +
    (detail ? ` (${detail})` : '') +
    `. Semantic code search is OFF for this session — retrieval falls back to keyword search.`
  )
  console.log(
    `[embed] Fix: run an embedding server and point LOCALCODE_EMBED_BASE_URL at it ` +
    `(Ollama: \`ollama pull ${'jina-code-embeddings-0.5b'}\`; llama.cpp: start llama-server with --embeddings). ` +
    `LOCALCODE_EMBED_API=ollama|openai pins the wire format.`
  )
}

/** Test seam: forget that the warning has been issued. */
export function resetEmbedWarning(): void {
  unavailableWarned = false
}

export class EmbedClient {
  private baseUrl: string
  private model: string
  private fallbackModel = 'nomic-embed-text'
  private pullAttempted = false
  /** The wire format that last answered. Null until one has. */
  private dialect: EmbedDialect | null = null

  // LOCALCODE_EMBED_API is deliberately NOT read here. Seeding `dialect` from it
  // would make `dialectUsed` claim a server had answered before one had, and it
  // would leave the pin enforced in two places — `dialectOrder` is the one that
  // actually stops the probe when the pinned dialect *fails*, so it holds the
  // rule alone.
  constructor(baseUrl = 'http://localhost:11434', model = 'jina-code-embeddings-0.5b') {
    this.baseUrl = process.env.LOCALCODE_EMBED_BASE_URL ?? baseUrl
    this.model = process.env.LOCALCODE_EMBED_MODEL ?? model
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal)
    return results[0]
  }

  /**
   * Embed a QUERY (asymmetric retrieval). nomic-embed-text documents
   * `search_query:` as required on the query side; jina-code-embeddings uses a
   * task instruction. Documents keep their raw embedding — the query-side
   * prefix is the documented usage for these models, and the eval
   * before/after (benchmark/codeindex-eval/) catches regressions empirically.
   */
  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.embed(this.queryPrefix() + text, signal)
  }

  private queryPrefix(): string {
    if (this.model.startsWith('nomic-')) return 'search_query: '
    if (this.model.includes('jina-code')) return 'Find the most relevant code snippet given the following query:\n'
    return ''
  }

  /**
   * Embed `text` but never block longer than `timeoutMs`. On timeout (or any
   * embed failure) resolves `undefined` so callers fall back to lexical recall.
   *
   * The deadline CANCELS the work; it does not walk away from it. The previous
   * version raced the embed against a timer, swallowed the loser's rejection,
   * and left everything downstream of it running: the HTTP request, the
   * fallback-model probe, and the fire-and-forget `pullModel` — each of which
   * narrates to the console. Under vitest that console traffic arrived after the
   * worker had begun tearing down, which vitest reports as
   * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
   * and which made `npm test` exit 1 with every test passing. The old comment
   * here claimed the detach had settled it; it had settled the rejection half
   * only, and the measurement disagreed with the comment.
   *
   * Silence after an abort is also the honest report. A cancelled request did
   * not fail — nothing was learned about the server — so "no embedding endpoint
   * answered" would be a claim this code is not entitled to make.
   */
  async embedWithDeadline(
    text: string,
    timeoutMs = Number(process.env.LOCALCODE_RECALL_EMBED_TIMEOUT_MS ?? 4000),
  ): Promise<number[] | undefined> {
    const abort = new AbortController()
    const embedPromise = this.embed(text, abort.signal)
    embedPromise.catch(() => { /* detach: swallow a late rejection from the losing race side */ })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
    try {
      return await Promise.race([embedPromise, timeout])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
      // On the success path the request has already settled and this is a
      // no-op; on the timeout path it is the whole point.
      abort.abort()
    }
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    try {
      return await this.embedWith(this.model, texts, signal)
    } catch (err) {
      // No abort check here, deliberately. `embedWith` refuses to go on once
      // the signal is aborted, so what reaches this catch after a cancellation
      // is an abort error — not a missing model — and falls through to the
      // rethrow below without narrating or starting a pull. A second check for
      // the same rule would be a mechanism no test could observe failing, and
      // an unfalsifiable guard is worse than none: it looks like protection.
      if (this.model !== this.fallbackModel && this.isModelMissing(err)) {
        const wanted = this.model
        console.log(`[embed] "${wanted}" unavailable — falling back to ${this.fallbackModel}`)
        this.model = this.fallbackModel
        if (!this.pullAttempted && this.dialectOrder()[0] === 'ollama') {
          this.pullAttempted = true
          // Fire-and-forget: pull the configured model in the background so a
          // later session gets it. THIS call is served by the fallback below.
          // Only Ollama has a pull API; there is nothing to call on an
          // OpenAI-shaped server, and inventing one would be a fabricated fix.
          this.pullModel(wanted).then((ok) => {
            if (ok) console.log(`[embed] "${wanted}" pulled — future sessions will use it`)
          })
        }
        return await this.embedWith(this.model, texts, signal)
      }
      throw err
    }
  }

  /**
   * Did the server answer "I do not have that model", as opposed to "I do not
   * have that route"?
   *
   * The distinction is the whole reason both dialects can be probed. A bare
   * status check would read llama-server's 404 for `/api/embed` as a missing
   * model, swap to the fallback model, and fail again the same way — never
   * reaching the endpoint that would have worked.
   */
  private isModelMissing(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /model/i.test(msg) && /not found|does not exist|unknown model/i.test(msg)
  }

  /** The dialects to try, in order, for this call. */
  private dialectOrder(): EmbedDialect[] {
    const pinned = process.env.LOCALCODE_EMBED_API
    if (pinned === 'ollama' || pinned === 'openai') return [pinned]
    if (this.dialect) return [this.dialect, this.dialect === 'ollama' ? 'openai' : 'ollama']
    return ['ollama', 'openai']
  }

  private async embedWith(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    let lastErr: unknown
    for (const dialect of this.dialectOrder()) {
      try {
        const out = await this.post(dialect, model, texts, signal)
        this.dialect = dialect
        return out
      } catch (err) {
        // The single place cancellation is honoured above the wire, and so the
        // one that has to carry the whole rule: stop probing, do not narrate,
        // do not fall back, do not start a background pull. A cancelled request
        // also taught us nothing about the server, so continuing to the
        // "no embedding endpoint answered" verdict below would be a judgement
        // on a server that was never allowed to answer.
        if (signal?.aborted) throw err
        // A server that answered about the model is the right server; do not
        // go looking for another one, let the fallback-model path handle it.
        if (this.isModelMissing(err)) {
          if (dialect === 'ollama') {
            console.log(`[embed] Model "${model}" not installed. Run: ollama pull ${model}`)
            console.log(`[embed] Continuing without vector search — keyword fallback only.`)
          }
          throw err
        }
        lastErr = err
      }
    }
    // No abort check here either: the loop above throws on the first cancelled
    // dialect, so a cancelled call never reaches this line.
    warnEmbedUnavailable(this.baseUrl, lastErr instanceof Error ? lastErr.message : undefined)
    throw lastErr
  }

  /** One request in one wire format. Throws EmbedHttpError on a non-2xx. */
  private async post(dialect: EmbedDialect, model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const url = dialect === 'ollama' ? `${this.baseUrl}/api/embed` : `${this.baseUrl}/v1/embeddings`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal,
    })

    if (!resp.ok) throw new EmbedHttpError(resp.status, await resp.text(), url)

    const data: any = await resp.json()
    if (dialect === 'ollama') return data.embeddings ?? []
    // OpenAI returns [{ index, embedding }]; the order is not guaranteed to
    // match the input, and the index is there precisely to say so.
    const rows: any[] = data.data ?? []
    const out: number[][] = []
    rows.forEach((r, i) => { out[typeof r.index === 'number' ? r.index : i] = r.embedding ?? [] })
    return out
  }

  get fallbackModelName(): string { return this.fallbackModel }

  /** The wire format that answered, or null if nothing has been asked yet. */
  get dialectUsed(): EmbedDialect | null { return this.dialect }

  /** Pull an embedding model from Ollama. Never throws — logs and returns false. */
  private async pullModel(model: string): Promise<boolean> {
    try {
      console.log(`[embed] Pulling ${model}...`)
      const resp = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false }),
      })
      if (resp.ok) {
        console.log(`[embed] Successfully pulled ${model}`)
        return true
      }
      const err = await resp.text()
      console.log(`[embed] Pull failed: ${err}`)
      return false
    } catch (e) {
      console.log(`[embed] Pull error: ${e}`)
      return false
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.embed('test')
      return result.length > 0
    } catch {
      return false
    }
  }

  get modelName(): string {
    return this.model
  }

  get baseUrlUsed(): string {
    return this.baseUrl
  }
}
