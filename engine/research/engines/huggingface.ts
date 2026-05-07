import type { SearchEngine, SearchResult } from '../types.js'

export class HuggingFaceEngine implements SearchEngine {
  name = 'huggingface'
  description = 'Hugging Face model and dataset search'
  domains = ['models', 'datasets', 'ml', 'ai']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    // Search models API — returns models sorted by downloads
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${maxResults}&sort=downloads&direction=-1`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    return this.parseResponse(data)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('https://huggingface.co/api/models?limit=1', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any): SearchResult[] {
    if (!Array.isArray(data)) return []
    return data.map((model: any) => {
      const tags = model.tags ?? []
      const pipeline = model.pipeline_tag ?? ''
      const downloads = model.downloads ?? 0
      const likes = model.likes ?? 0

      return {
        title: model.modelId ?? model.id ?? '',
        url: `https://huggingface.co/${model.modelId ?? model.id}`,
        snippet: `${pipeline ? `[${pipeline}] ` : ''}Downloads: ${downloads.toLocaleString()}, Likes: ${likes}. Tags: ${tags.slice(0, 5).join(', ')}`,
        source: 'huggingface' as const,
        metadata: {
          date: model.lastModified ?? model.createdAt ?? '',
          stars: likes,
        },
      }
    })
  }
}
