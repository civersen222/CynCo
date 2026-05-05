import type { SearchEngine, SearchResult } from '../types.js'

export class WikipediaEngine implements SearchEngine {
  name = 'wikipedia'
  description = 'Wikipedia encyclopedia search'
  domains = ['reference', 'general', 'encyclopedia']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json&origin=*`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    const data = await resp.json()
    return this.parseResponse(data)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json&origin=*', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any): SearchResult[] {
    const items = data?.query?.search ?? []
    return items.map((item: any) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: (item.snippet ?? '').replace(/<[^>]+>/g, ''),
      source: 'wikipedia',
    }))
  }
}
