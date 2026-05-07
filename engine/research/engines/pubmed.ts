import type { SearchEngine, SearchResult } from '../types.js'

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

export class PubMedEngine implements SearchEngine {
  name = 'pubmed'
  description = 'PubMed biomedical literature search'
  domains = ['academic', 'biomedical', 'health', 'medicine', 'biology']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    const searchData = await searchResp.json()
    const ids: string[] = searchData?.esearchresult?.idlist ?? []
    if (ids.length === 0) return []

    const summaryUrl = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`
    const summaryResp = await fetch(summaryUrl, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    const summaryData = await summaryResp.json()
    return this.parseSummary(ids, summaryData)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${EUTILS_BASE}/einfo.fcgi?db=pubmed&retmode=json`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseSummary(ids: string[], data: any): SearchResult[] {
    return ids
      .map(id => {
        const article = data?.result?.[id]
        if (!article || !article.title) return null
        const authors = article.authors?.map((a: any) => a.name) ?? []
        return {
          title: article.title,
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          snippet: article.title,
          source: 'pubmed' as const,
          metadata: {
            authors,
            date: article.pubdate ?? '',
            ...(article.elocationid ? { doi: article.elocationid } : {}),
          },
        }
      })
      .filter(Boolean) as SearchResult[]
  }
}
