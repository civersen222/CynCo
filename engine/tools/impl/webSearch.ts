import type { ToolImpl } from '../types.js'
import { getEngine, getAllEngines, initEngines } from '../../research/engines/registry.js'
import { routeQuery, searchWithFallback } from '../../research/engineRouter.js'
import { scoreResults, deduplicateResults } from '../../research/resultScorer.js'
import type { SearchResult } from '../../research/types.js'

let initialized = false

function ensureEngines(): void {
  if (!initialized) {
    initEngines()
    initialized = true
  }
}

export const webSearchTool: ToolImpl = {
  name: 'WebSearch',
  description: 'Search the web using multiple search engines. Returns relevant snippets from search results. Use this to research topics, find documentation, or look up how things work.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      num_results: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
      engine: {
        type: 'string',
        enum: ['auto', 'duckduckgo', 'searxng', 'arxiv', 'wikipedia', 'github', 'pubmed', 'huggingface'],
        default: 'auto',
        description: 'Search engine to use. "auto" routes to best engine(s) based on query.',
      },
    },
    required: ['query'],
  },
  tier: 'auto',
  execute: async (input) => {
    const query = input.query as string
    const numResults = Math.min((input.num_results as number) ?? 5, 10)
    const engineName = (input.engine as string) ?? 'auto'

    ensureEngines()

    try {
      let results: SearchResult[]

      if (engineName === 'auto') {
        const allEngines = getAllEngines()
        const engines = routeQuery(query, allEngines)
        if (engines.length === 0) {
          return { output: `No search engines available for: "${query}"`, isError: false }
        }
        // Search top 2 engines with fallback
        const searches = engines.slice(0, 2).map(e =>
          searchWithFallback(query, e, allEngines, numResults)
        )
        const allResults = (await Promise.allSettled(searches))
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => (r as PromiseFulfilledResult<SearchResult[]>).value)

        // Score, deduplicate, and rank
        const scored = scoreResults(allResults, query)
        results = deduplicateResults(scored).slice(0, numResults)
      } else {
        const allEngines = getAllEngines()
        const engine = getEngine(engineName)
        if (!engine) {
          const ddg = getEngine('duckduckgo')
          if (!ddg) return { output: `No search engines available`, isError: true }
          results = await searchWithFallback(query, ddg, allEngines, numResults)
        } else {
          results = await searchWithFallback(query, engine, allEngines, numResults)
        }
      }

      if (results.length === 0) {
        return { output: `No results found for: "${query}"`, isError: false }
      }

      const formatted = results.map((r, i) => {
        const meta = r.metadata
        const authorLine = meta?.authors?.length ? `\n   Authors: ${meta.authors.join(', ')}` : ''
        const dateLine = meta?.date ? `\n   Date: ${meta.date}` : ''
        const starsLine = meta?.stars != null && meta.stars > 0 ? `\n   Stars: ${meta.stars.toLocaleString()}` : ''
        const scoreLine = r.score != null ? ` (score: ${r.score})` : ''
        return `${i + 1}. ${r.title}${scoreLine}\n   ${r.url}\n   [${r.source}] ${r.snippet}${starsLine}${authorLine}${dateLine}`
      }).join('\n\n')

      return {
        output: `Search results for "${query}":\n\n${formatted}`,
        isError: false,
      }
    } catch (err) {
      return {
        output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
