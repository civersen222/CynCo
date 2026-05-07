import type { SearchEngine, SearchResult } from '../types.js'

/** CS-related arXiv categories for coding/AI/SE queries. */
const CS_CATEGORIES = ['cs.SE', 'cs.AI', 'cs.CL', 'cs.LG', 'cs.MA', 'cs.PL']

/** Keywords that signal a CS/coding query (triggers category filtering). */
const CS_SIGNALS = ['code', 'coding', 'software', 'programming', 'agent', 'llm', 'model', 'ai',
  'developer', 'engineering', 'generation', 'assistant', 'autonomous', 'tool']

export class ArXivEngine implements SearchEngine {
  name = 'arxiv'
  description = 'arXiv preprint paper search'
  domains = ['academic', 'cs', 'physics', 'math', 'science', 'papers']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const searchQuery = this.buildQuery(query)
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&max_results=${maxResults * 2}&sortBy=relevance&sortOrder=descending`
    // arXiv API is slow — 30s timeout with one retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'CynCo/1.0' },
          signal: AbortSignal.timeout(30000),
        })
        const xml = await resp.text()
        const results = this.parseAtom(xml)
        return this.filterByRelevance(results, query).slice(0, maxResults)
      } catch (err) {
        if (attempt === 0) continue
        throw err
      }
    }
    return []
  }

  /** Build arXiv search query with category filters for CS-related queries. */
  private buildQuery(query: string): string {
    const q = query.toLowerCase()
    const isCSQuery = CS_SIGNALS.some(s => q.includes(s))
    if (isCSQuery) {
      const catFilter = CS_CATEGORIES.map(c => `cat:${c}`).join('+OR+')
      return `all:${query}+AND+(${catFilter})`
    }
    return `all:${query}`
  }

  /** Discard papers whose abstracts don't contain at least 2 query keywords. */
  private filterByRelevance(results: SearchResult[], query: string): SearchResult[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keywords.length === 0) return results

    return results.filter(r => {
      const text = `${r.title} ${r.snippet}`.toLowerCase()
      const matches = keywords.filter(kw => text.includes(kw)).length
      return matches >= Math.min(2, keywords.length)
    })
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
