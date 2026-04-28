/**
 * Ollama /api/embed wrapper for generating code embeddings.
 * Auto-pulls the embedding model if not installed.
 */

export class EmbedClient {
  private baseUrl: string
  private model: string
  private pullAttempted = false

  constructor(baseUrl = 'http://localhost:11434', model = 'nomic-embed-text') {
    this.baseUrl = baseUrl
    this.model = process.env.LOCALCODE_EMBED_MODEL ?? model
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })

    if (!resp.ok) {
      const errText = await resp.text()

      // If model not found, log instructions instead of auto-pulling
      if (errText.includes('not found') || resp.status === 404) {
        console.log(`[embed] Model "${this.model}" not installed. Run: ollama pull ${this.model}`)
        console.log(`[embed] Continuing without vector search — keyword fallback only.`)
      }

      throw new Error(`Ollama embed failed (${resp.status}): ${errText}`)
    }

    const data: any = await resp.json()
    return data.embeddings ?? []
  }

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
}
