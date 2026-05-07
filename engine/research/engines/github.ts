import type { SearchEngine, SearchResult } from '../types.js'

export class GitHubEngine implements SearchEngine {
  name = 'github'
  description = 'GitHub repository and code search'
  domains = ['code', 'repos', 'technical', 'github', 'open-source']

  private minStars: number

  constructor(options?: { minStars?: number }) {
    this.minStars = options?.minStars ?? 0
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const starFilter = this.minStars > 0 ? `+stars:>=${this.minStars}` : ''
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}${starFilter}&per_page=${maxResults}&sort=stars&order=desc`
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'CynCo/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    return this.parseResponse(data)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('https://api.github.com/rate_limit', {
        headers: { 'User-Agent': 'CynCo/1.0' },
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any): SearchResult[] {
    return (data?.items ?? []).map((repo: any) => ({
      title: repo.full_name,
      url: repo.html_url,
      snippet: repo.description ?? '',
      source: 'github' as const,
      metadata: {
        date: repo.updated_at,
        repo: repo.full_name,
        stars: repo.stargazers_count ?? 0,
        language: repo.language ?? undefined,
      },
    }))
  }
}
