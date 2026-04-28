/**
 * WebSearch tool — search the web via DuckDuckGo and return results.
 *
 * Available to the model in any conversation, not just the wizard.
 * Uses DuckDuckGo HTML search (no API key required).
 */
import type { ToolImpl } from '../types.js'

export const webSearchTool: ToolImpl = {
  name: 'WebSearch',
  description: 'Search the web for information. Returns relevant snippets from search results. Use this to research topics, find documentation, or look up how things work.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      num_results: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
    },
    required: ['query'],
  },
  tier: 'auto',
  execute: async (input) => {
    const query = input.query as string
    const numResults = Math.min((input.num_results as number) ?? 5, 10)

    try {
      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalCode/0.1)' },
        signal: AbortSignal.timeout(15000),
      })
      const html = await resp.text()

      // Extract result titles and snippets
      const results: string[] = []

      // Extract snippets
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
        .slice(0, numResults)

      // Extract titles
      const titles = [...html.matchAll(/<a class="result__a"[^>]*>(.*?)<\/a>/gs)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim())
        .slice(0, numResults)

      // Extract URLs
      const urls = [...html.matchAll(/<a class="result__url"[^>]*href="([^"]*)"[^>]*>/gs)]
        .map(m => m[1].trim())
        .slice(0, numResults)

      for (let i = 0; i < snippets.length; i++) {
        const title = titles[i] ?? ''
        const resultUrl = urls[i] ?? ''
        results.push(`${i + 1}. ${title}\n   ${resultUrl}\n   ${snippets[i]}`)
      }

      if (results.length === 0) {
        return { output: `No results found for: "${query}"`, isError: false }
      }

      return {
        output: `Search results for "${query}":\n\n${results.join('\n\n')}`,
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
