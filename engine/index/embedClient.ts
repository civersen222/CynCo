/**
 * Ollama /api/embed wrapper for generating code embeddings.
 * Auto-pulls the embedding model if not installed.
 */

export class EmbedClient {
  private baseUrl: string
  private model: string
  private fallbackModel = 'nomic-embed-text'
  private pullAttempted = false

  constructor(baseUrl = 'http://localhost:11434', model = 'jina-code-embeddings-0.5b') {
    this.baseUrl = process.env.LOCALCODE_EMBED_BASE_URL ?? baseUrl
    this.model = process.env.LOCALCODE_EMBED_MODEL ?? model
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  /**
   * Embed `text` but never block longer than `timeoutMs`. On timeout (or any
   * embed failure) resolves `undefined` so callers fall back to lexical recall.
   * The losing embed promise is detached with a swallow so a late rejection can
   * never surface as an unhandled rejection after the caller has moved on
   * (this is what produced vitest teardown noise on cold/absent embed servers).
   */
  async embedWithDeadline(
    text: string,
    timeoutMs = Number(process.env.LOCALCODE_RECALL_EMBED_TIMEOUT_MS ?? 4000),
  ): Promise<number[] | undefined> {
    const embedPromise = this.embed(text)
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
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedWith(this.model, texts)
    } catch (err) {
      if (this.model !== this.fallbackModel && this.isModelMissing(err)) {
        console.log(`[embed] "${this.model}" unavailable — falling back to ${this.fallbackModel}`)
        this.model = this.fallbackModel
        return await this.embedWith(this.model, texts)
      }
      throw err
    }
  }

  private isModelMissing(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('not found') || msg.includes('404')
  }

  private async embedWith(model: string, texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    })

    if (!resp.ok) {
      const errText = await resp.text()

      // If model not found, log instructions instead of auto-pulling
      if (errText.includes('not found') || resp.status === 404) {
        console.log(`[embed] Model "${model}" not installed. Run: ollama pull ${model}`)
        console.log(`[embed] Continuing without vector search — keyword fallback only.`)
      }

      throw new Error(`Ollama embed failed (${resp.status}): ${errText}`)
    }

    const data: any = await resp.json()
    return data.embeddings ?? []
  }

  get fallbackModelName(): string { return this.fallbackModel }

  /** Pull the embedding model from Ollama. */
  private async pullModel(): Promise<boolean> {
    try {
      console.log(`[embed] Pulling ${this.model}...`)
      const resp = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, stream: false }),
      })
      if (resp.ok) {
        console.log(`[embed] Successfully pulled ${this.model}`)
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
