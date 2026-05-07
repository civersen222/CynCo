import type { SearchEngine, SearchResult } from './types.js'

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  academic: ['paper', 'research', 'study', 'journal', 'cite', 'citation', 'literature', 'review', 'preprint'],
  cs: ['algorithm', 'machine learning', 'neural', 'deep learning', 'nlp', 'computer science', 'transformer'],
  physics: ['quantum', 'particle', 'relativity', 'cosmology', 'astrophysics'],
  math: ['theorem', 'proof', 'algebra', 'topology', 'calculus'],
  biomedical: ['disease', 'drug', 'clinical', 'patient', 'treatment', 'medical', 'health', 'gene', 'therapy'],
  medicine: ['diagnosis', 'symptom', 'surgery', 'pharmaceutical'],
  code: ['library', 'framework', 'package', 'npm', 'pip', 'crate', 'implementation', 'github', 'repository', 'repo',
         'open source', 'self-hosted', 'tool', 'agent', 'assistant', 'coding', 'terminal', 'cli', 'llm', 'model', 'ollama', 'llama'],
  repos: ['open source', 'stars', 'fork', 'self-hosted'],
  technical: ['api', 'sdk', 'documentation', 'docs'],
  reference: ['what is', 'definition', 'overview', 'introduction', 'explain', 'history', 'meaning'],
  general: [],
  web: [],
  meta: [],
  encyclopedia: ['wiki', 'encyclopedia'],
  science: ['experiment', 'hypothesis', 'theory'],
  papers: ['arxiv', 'proceedings', 'conference'],
  models: ['fine-tune', 'gguf', 'lora', 'huggingface', 'weights', 'checkpoint', 'qlora'],
  datasets: ['dataset', 'benchmark', 'training data'],
  ml: ['machine learning', 'neural', 'deep learning', 'transformer', 'attention'],
  ai: ['ai', 'artificial intelligence', 'llm', 'language model', 'chatbot'],
}

export function routeQuery(query: string, engines: SearchEngine[]): SearchEngine[] {
  if (engines.length === 0) return []

  const q = query.toLowerCase()
  const scores = new Map<string, number>()

  for (const engine of engines) {
    let score = 0
    for (const domain of engine.domains) {
      const keywords = DOMAIN_KEYWORDS[domain]
      if (keywords) {
        for (const kw of keywords) {
          if (q.includes(kw)) score++
        }
      }
      if (domain === 'general' || domain === 'web' || domain === 'meta') {
        score = Math.max(score, 0.5)
      }
    }
    scores.set(engine.name, score)
  }

  return engines
    .filter(e => (scores.get(e.name) ?? 0) > 0)
    .sort((a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0))
}

/** Fallback engine chain: general-purpose engines to try when the primary returns 0 results. */
const GENERAL_FALLBACK_ORDER = ['searxng', 'duckduckgo', 'wikipedia']

/**
 * Search with fallback: if the primary engine returns 0 results,
 * try the next general-purpose engine in the chain.
 */
export async function searchWithFallback(
  query: string,
  primaryEngine: SearchEngine,
  allEngines: SearchEngine[],
  maxResults: number,
): Promise<SearchResult[]> {
  const results = await primaryEngine.search(query, maxResults).catch(() => [] as SearchResult[])
  if (results.length > 0) return results

  // Primary returned nothing — try fallback engines
  const fallbackNames = GENERAL_FALLBACK_ORDER.filter(n => n !== primaryEngine.name)
  const engineMap = new Map(allEngines.map(e => [e.name, e]))

  for (const name of fallbackNames) {
    const fallback = engineMap.get(name)
    if (!fallback) continue
    try {
      const fbResults = await fallback.search(query, maxResults)
      if (fbResults.length > 0) return fbResults
    } catch {
      continue
    }
  }
  return []
}
