import type { SearchEngine, SearchResult } from '../types.js'

export class ArXivEngine implements SearchEngine {
  name = 'arxiv'
  description = 'arXiv preprint paper search'
  domains = ['academic', 'cs', 'physics', 'math', 'science', 'papers']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    const xml = await resp.text()
    return this.parseAtom(xml)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('http://export.arxiv.org/api/query?search_query=all:test&max_results=1', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseAtom(xml: string): SearchResult[] {
    const entries = xml.split('<entry>').slice(1)
    return entries.map(entry => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? ''
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? ''
      const url = entry.match(/<id>(.*?)<\/id>/)?.[1]?.trim() ?? ''
      const authors = [...entry.matchAll(/<name>(.*?)<\/name>/g)].map(m => m[1].trim())
      const published = entry.match(/<published>(.*?)<\/published>/)?.[1]?.trim() ?? ''
      const doi = entry.match(/<arxiv:doi[^>]*>(.*?)<\/arxiv:doi>/)?.[1]?.trim()

      return {
        title,
        url,
        snippet: summary.slice(0, 300),
        source: 'arxiv' as const,
        metadata: {
          authors,
          date: published,
          ...(doi ? { doi } : {}),
        },
      }
    })
  }
}
