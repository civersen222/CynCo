import type { SearchResult } from './types.js'

/**
 * Score and rank search results by quality signals:
 * - keyword density (how many query words appear in title+snippet)
 * - recency (newer = higher)
 * - source authority (github with stars > generic web)
 * - cross-source corroboration (URL appears from multiple engines = boost)
 */
export function scoreResults(results: SearchResult[], query: string): SearchResult[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  // Build URL frequency map for corroboration
  const urlCounts = new Map<string, number>()
  for (const r of results) {
    const key = normalizeUrl(r.url)
    if (key) urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1)
  }

  return results.map(r => ({
    ...r,
    score: computeScore(r, keywords, urlCounts),
  })).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

function computeScore(
  r: SearchResult,
  keywords: string[],
  urlCounts: Map<string, number>,
): number {
  let score = 0

  // Keyword density (0–5 points)
  if (keywords.length > 0) {
    const text = `${r.title} ${r.snippet}`.toLowerCase()
    const matches = keywords.filter(kw => text.includes(kw)).length
    score += Math.min(5, (matches / keywords.length) * 5)
  }

  // Recency (0–2 points)
  const dateStr = r.metadata?.date
  if (dateStr) {
    const age = Date.now() - new Date(dateStr).getTime()
    const daysOld = age / (24 * 60 * 60 * 1000)
    if (daysOld < 90) score += 2
    else if (daysOld < 365) score += 1.5
    else if (daysOld < 730) score += 1
    else score += 0.5
  }

  // Source authority (0–3 points)
  const stars = r.metadata?.stars ?? 0
  if (r.source === 'github') {
    if (stars >= 10000) score += 3
    else if (stars >= 1000) score += 2.5
    else if (stars >= 100) score += 2
    else score += 1
  } else if (r.source === 'arxiv') {
    score += 1.5  // peer-adjacent
  } else if (r.source === 'wikipedia') {
    score += 1  // reference
  } else if (r.source === 'huggingface') {
    score += 1.5
  } else {
    score += 1  // general web
  }

  // Cross-source corroboration (0–2 points)
  const key = normalizeUrl(r.url)
  const appearances = key ? (urlCounts.get(key) ?? 1) : 1
  if (appearances >= 3) score += 2
  else if (appearances >= 2) score += 1

  return Math.round(score * 100) / 100
}

/** Normalize URL for dedup/corroboration: strip protocol, trailing slashes, www. */
function normalizeUrl(url: string): string {
  if (!url) return ''
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Deduplicate results by normalized URL, keeping highest-scored version. */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>()
  for (const r of results) {
    const key = normalizeUrl(r.url) || r.title
    if (!key) continue
    const existing = seen.get(key)
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, r)
    }
  }
  return [...seen.values()]
}
