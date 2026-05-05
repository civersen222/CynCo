import type { SearchEngine } from './types.js'

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  academic: ['paper', 'research', 'study', 'journal', 'cite', 'citation', 'literature', 'review', 'preprint'],
  cs: ['algorithm', 'machine learning', 'neural', 'deep learning', 'nlp', 'computer science', 'ai', 'transformer'],
  physics: ['quantum', 'particle', 'relativity', 'cosmology', 'astrophysics'],
  math: ['theorem', 'proof', 'algebra', 'topology', 'calculus'],
  biomedical: ['disease', 'drug', 'clinical', 'patient', 'treatment', 'medical', 'health', 'gene', 'therapy'],
  medicine: ['diagnosis', 'symptom', 'surgery', 'pharmaceutical'],
  code: ['library', 'framework', 'package', 'npm', 'pip', 'crate', 'implementation', 'github', 'repository', 'repo'],
  repos: ['open source', 'stars', 'fork'],
  technical: ['api', 'sdk', 'documentation', 'docs'],
  reference: ['what is', 'definition', 'overview', 'introduction', 'explain', 'history', 'meaning'],
  general: [],
  web: [],
  meta: [],
  encyclopedia: ['wiki', 'encyclopedia'],
  science: ['experiment', 'hypothesis', 'theory'],
  papers: ['arxiv', 'proceedings', 'conference'],
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
