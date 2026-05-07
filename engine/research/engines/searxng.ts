import type { SearchEngine, SearchResult } from '../types.js'

export class SearXNGEngine implements SearchEngine {
  name = 'searxng'
  description = 'SearXNG meta-search (self-hosted)'
  domains = ['general', 'web', 'meta']
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.LOCALCODE_SEARXNG_URL ?? ''
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!this.baseUrl) return []
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&pageno=1`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    const data = await resp.json()
    return this.parseResponse(data, maxResults)
  }

  async healthCheck(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const resp = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any, maxResults: number): SearchResult[] {
    return (data?.results ?? []).slice(0, maxResults).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      source: 'searxng' as const,
    }))
  }
}
