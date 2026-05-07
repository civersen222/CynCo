export interface SearchResult {
  title: string
  url: string
  snippet: string
  source: string
  relevance?: number
  score?: number  // quality score assigned by resultScorer
  metadata?: {
    authors?: string[]
    date?: string
    doi?: string
    repo?: string
    stars?: number
    language?: string
  }
}

export interface SearchEngine {
  name: string
  description: string
  domains: string[]
  search(query: string, maxResults?: number): Promise<SearchResult[]>
  healthCheck(): Promise<boolean>
}
