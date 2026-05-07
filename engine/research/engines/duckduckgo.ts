import type { SearchEngine, SearchResult } from '../types.js'

/** Decode common HTML entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export class DuckDuckGoEngine implements SearchEngine {
  name = 'duckduckgo'
  description = 'General web search via DuckDuckGo'
  domains = ['general', 'web']

  private lastRequestMs = 0
  private minDelayMs = 2500  // minimum 2.5s between requests to avoid CAPTCHAs

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    // Rate-limit: wait if too soon since last request
    const elapsed = Date.now() - this.lastRequestMs
    if (elapsed < this.minDelayMs) {
      await sleep(this.minDelayMs - elapsed)
    }

    // Retry with exponential backoff on empty results (CAPTCHA)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(this.minDelayMs * (attempt + 1))

      this.lastRequestMs = Date.now()
      try {
        const resp = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://html.duckduckgo.com/',
          },
          body: `q=${encodeURIComponent(query)}&b=`,
          signal: AbortSignal.timeout(15000),
        })
        const html = await resp.text()
        const results = this.parseResults(html, maxResults)
        if (results.length > 0) return results
        // Empty results likely means CAPTCHA — retry
      } catch {
        // Network error — retry
      }
    }
    return []
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
    const results: SearchResult[] = []

    // Strategy 1: Parse full result blocks
    const blocks = html.split(/class="result\s/)
    for (const block of blocks.slice(1)) {
      if (results.length >= maxResults) break

      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/s)
        ?? block.match(/class='result__a'[^>]*>([\s\S]*?)<\/a>/s)
      const title = titleMatch ? decodeEntities(titleMatch[1]) : ''

      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]*)"/)
        ?? block.match(/href="([^"]*)"[^>]*class="result__a"/)
      const url = urlMatch ? urlMatch[1] : ''

      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/s)
      const snippet = snippetMatch ? decodeEntities(snippetMatch[1]) : ''

      if (snippet.length > 20) {
        results.push({ title: title || '(no title)', url, snippet, source: 'duckduckgo' })
      }
    }

    // Strategy 2: Fallback flat regex
    if (results.length === 0) {
      const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gs)]
        .map(m => decodeEntities(m[1]))
        .filter(s => s.length > 20)
        .slice(0, maxResults)

      const urls = [...html.matchAll(/class="result__url"[^>]*href="([^"]*)"[^>]*/gs)]
        .map(m => m[1].trim())
        .slice(0, maxResults)

      for (let i = 0; i < snippets.length; i++) {
        results.push({
          title: '',
          url: urls[i] ?? '',
          snippet: snippets[i],
          source: 'duckduckgo',
        })
      }
    }

    return results
  }
}
