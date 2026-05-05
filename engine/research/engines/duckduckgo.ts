import type { SearchEngine, SearchResult } from '../types.js'

export class DuckDuckGoEngine implements SearchEngine {
  name = 'duckduckgo'
  description = 'General web search via DuckDuckGo'
  domains = ['general', 'web']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CynCo/1.0)' },
      signal: AbortSignal.timeout(15000),
    })
    const html = await resp.text()
    return this.parseResults(html, maxResults)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('https://html.duckduckgo.com/html/', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResults(html: string, maxResults: number): SearchResult[] {
    const snippets = [...html.matchAll(/<a class="result__snippet"[^>]*>(.*?)<\/a>/gs)]
      .map(m => m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim()
      )
      .filter(s => s.length > 20)
      .slice(0, maxResults)

    const titles = [...html.matchAll(/<a class="result__a"[^>]*>(.*?)<\/a>/gs)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .slice(0, maxResults)

    const urls = [...html.matchAll(/<a class="result__url"[^>]*href="([^"]*)"[^>]*>/gs)]
      .map(m => m[1].trim())
      .slice(0, maxResults)

    const results: SearchResult[] = []
    for (let i = 0; i < snippets.length; i++) {
      results.push({
        title: titles[i] ?? '',
        url: urls[i] ?? '',
        snippet: snippets[i],
        source: 'duckduckgo',
      })
    }
    return results
  }
}
