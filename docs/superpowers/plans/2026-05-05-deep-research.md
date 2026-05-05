# Deep Research Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iterative deep research capabilities to CynCo — multi-source search, researcher sub-agents, research workflow, vector store indexing, and vibe loop integration.

**Architecture:** A pluggable `SearchEngine` interface with 6 engine implementations routes queries to the best sources. A `research` workflow orchestrates 6 phases (scope→decompose→gather→synthesize→report→index). Researcher sub-agents (specialist tier, web tools) are spawned in parallel during the gather phase. Research findings are chunked, embedded, and stored in the existing code index for unified retrieval.

**Tech Stack:** TypeScript (Bun runtime), Ollama embeddings, SQLite vector store, public APIs (arXiv, Wikipedia, PubMed, GitHub, SearXNG, DuckDuckGo)

**Spec:** `docs/superpowers/specs/2026-05-04-deep-research-design.md`

---

## File Structure

### New files
```
engine/research/
├── types.ts                        # SearchResult, SearchEngine interface
├── engineRouter.ts                 # Query → engine routing by domain keywords
├── indexer.ts                      # indexResearchReport() — chunks + embeds reports
└── engines/
    ├── registry.ts                 # Engine map, register/get/getHealthy
    ├── duckduckgo.ts               # DuckDuckGo HTML scraping (extracted from webSearch.ts)
    ├── wikipedia.ts                # Wikipedia Action API (JSON)
    ├── arxiv.ts                    # arXiv Atom API (XML regex parsing)
    ├── pubmed.ts                   # PubMed E-utilities (JSON)
    ├── github.ts                   # GitHub REST API (JSON)
    └── searxng.ts                  # SearXNG self-hosted meta-search (JSON)

engine/index/researchChunker.ts     # Split markdown reports by headings into Chunk[]
engine/tools/impl/indexResearch.ts  # IndexResearch tool — embeds report into vector store
engine/workflows/definitions/research.ts  # 6-phase research workflow definition

engine/__tests__/research/
├── types.test.ts                   # SearchResult/SearchEngine interface contracts
├── engineRouter.test.ts            # Query → engine routing
├── indexer.test.ts                 # indexResearchReport with mock store/embed
├── engines/
│   ├── duckduckgo.test.ts          # HTML parsing
│   ├── wikipedia.test.ts           # JSON parsing
│   ├── arxiv.test.ts               # Atom XML parsing
│   ├── pubmed.test.ts              # JSON parsing
│   ├── github.test.ts              # JSON parsing
│   ├── searxng.test.ts             # JSON parsing
│   └── registry.test.ts           # Engine registration + health filtering
├── researchChunker.test.ts         # Markdown chunking
└── workflow.test.ts                # Research workflow structure + phase transitions
```

### Modified files
```
engine/agents/types.ts:5            # Add 'researcher' to AgentPersona union
engine/agents/types.ts:85           # Add RESEARCHER_TOOLS constant
engine/agents/types.ts:117          # Use tier-aware tool selection in makeSubAgentConfig
engine/agents/prism.ts:21-42        # Add researcher persona to AGENT_PERSONAS
engine/agents/vocabulary.ts:14-245  # Add researcher vocabulary entry
engine/tools/impl/spawnAgent.ts:4   # Add 'researcher' to VALID_PERSONAS
engine/tools/impl/webSearch.ts      # Add engine param, delegate to engine layer
engine/tools/registry.ts            # Import + register indexResearchTool
engine/index/types.ts:1             # Add 'research' to ChunkType union
engine/workflows/index.ts           # Import + register researchWorkflow
engine/vibe/controller.ts           # Add shouldResearch() + pre-build research trigger
```

---

### Task 1: Research Types

**Files:**
- Create: `engine/research/types.ts`
- Test: `engine/__tests__/research/types.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/types.test.ts
import { describe, it, expect } from 'bun:test'
import type { SearchResult, SearchEngine } from '../../research/types.js'

describe('Research types', () => {
  it('SearchResult has required fields', () => {
    const result: SearchResult = {
      title: 'Test Paper',
      url: 'https://example.com/paper',
      snippet: 'A test paper about testing',
      source: 'arxiv',
    }
    expect(result.title).toBe('Test Paper')
    expect(result.source).toBe('arxiv')
  })

  it('SearchResult supports optional metadata', () => {
    const result: SearchResult = {
      title: 'Test',
      url: 'https://example.com',
      snippet: 'Test snippet',
      source: 'pubmed',
      relevance: 0.95,
      metadata: {
        authors: ['Alice', 'Bob'],
        date: '2026-01-01',
        doi: '10.1234/test',
      },
    }
    expect(result.metadata?.authors).toEqual(['Alice', 'Bob'])
    expect(result.relevance).toBe(0.95)
  })

  it('SearchEngine interface can be implemented', () => {
    const engine: SearchEngine = {
      name: 'test',
      description: 'Test engine',
      domains: ['general'],
      search: async () => [],
      healthCheck: async () => true,
    }
    expect(engine.name).toBe('test')
    expect(engine.domains).toContain('general')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/types.test.ts`
Expected: FAIL — cannot resolve `../../research/types.js`

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/types.ts

export interface SearchResult {
  title: string
  url: string
  snippet: string
  source: string
  relevance?: number
  metadata?: {
    authors?: string[]
    date?: string
    doi?: string
    repo?: string
  }
}

export interface SearchEngine {
  name: string
  description: string
  domains: string[]
  search(query: string, maxResults?: number): Promise<SearchResult[]>
  healthCheck(): Promise<boolean>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/types.ts engine/__tests__/research/types.test.ts
git commit -m "feat(research): add SearchResult and SearchEngine interfaces"
```

---

### Task 2: DuckDuckGo Engine

**Files:**
- Create: `engine/research/engines/duckduckgo.ts`
- Test: `engine/__tests__/research/engines/duckduckgo.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/duckduckgo.test.ts
import { describe, it, expect } from 'bun:test'
import { DuckDuckGoEngine } from '../../../research/engines/duckduckgo.js'

const SAMPLE_HTML = `
<div class="results">
  <div class="result">
    <a class="result__a" href="https://example.com/page1">Example Page One</a>
    <a class="result__url" href="https://example.com/page1">example.com/page1</a>
    <a class="result__snippet" href="#">This is the first search result snippet with enough text to pass the filter.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://example.com/page2">Example Page Two</a>
    <a class="result__url" href="https://example.com/page2">example.com/page2</a>
    <a class="result__snippet" href="#">Second result snippet with &#x27;entities&#x27; and &amp; symbols decoded properly.</a>
  </div>
</div>
`

describe('DuckDuckGoEngine', () => {
  it('has correct metadata', () => {
    const engine = new DuckDuckGoEngine()
    expect(engine.name).toBe('duckduckgo')
    expect(engine.domains).toContain('general')
    expect(engine.domains).toContain('web')
  })

  it('parses HTML results', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 5)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Example Page One')
    expect(results[0].source).toBe('duckduckgo')
    expect(results[0].url).toBe('https://example.com/page1')
  })

  it('decodes HTML entities in snippets', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 5)
    expect(results[1].snippet).toContain("'entities'")
    expect(results[1].snippet).toContain('& symbols')
  })

  it('respects maxResults limit', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 1)
    expect(results.length).toBe(1)
  })

  it('returns empty array for no results', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults('<html><body>No results</body></html>', 5)
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/duckduckgo.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/duckduckgo.ts
import type { SearchEngine, SearchResult } from '../types.js'

export class DuckDuckGoEngine implements SearchEngine {
  name = 'duckduckgo'
  description = 'General web search via DuckDuckGo'
  domains = ['general', 'web']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CynCo/1.0)' },
      signal: AbortSignal.timeout(15000),
    })
    const html = await resp.text()
    return this.parseResults(html, maxResults)
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
      .slice(0, maxResults)

    const titles = [...html.matchAll(/<a class="result__a"[^>]*>(.*?)<\/a>/gs)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .slice(0, maxResults)

    const urls = [...html.matchAll(/<a class="result__url"[^>]*href="([^"]*)"[^>]*>/gs)]
      .map(m => m[1].trim())
      .slice(0, maxResults)

    const results: SearchResult[] = []
    for (let i = 0; i < snippets.length; i++) {
      results.push({
        title: titles[i] ?? '',
        url: urls[i] ?? '',
        snippet: snippets[i],
        source: 'duckduckgo',
      })
    }
    return results
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/duckduckgo.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/duckduckgo.ts engine/__tests__/research/engines/duckduckgo.test.ts
git commit -m "feat(research): add DuckDuckGo search engine"
```

---

### Task 3: Wikipedia Engine

**Files:**
- Create: `engine/research/engines/wikipedia.ts`
- Test: `engine/__tests__/research/engines/wikipedia.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/wikipedia.test.ts
import { describe, it, expect } from 'bun:test'
import { WikipediaEngine } from '../../../research/engines/wikipedia.js'

const SAMPLE_RESPONSE = {
  query: {
    search: [
      {
        title: 'Machine learning',
        snippet: 'Machine learning is a <span class="searchmatch">subset</span> of artificial intelligence',
        pageid: 233488,
      },
      {
        title: 'Deep learning',
        snippet: '<span class="searchmatch">Deep</span> learning is part of machine learning',
        pageid: 32472,
      },
    ],
  },
}

describe('WikipediaEngine', () => {
  it('has correct metadata', () => {
    const engine = new WikipediaEngine()
    expect(engine.name).toBe('wikipedia')
    expect(engine.domains).toContain('reference')
  })

  it('parses JSON response', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Machine learning')
    expect(results[0].source).toBe('wikipedia')
    expect(results[0].url).toContain('en.wikipedia.org/wiki/Machine_learning')
  })

  it('strips HTML from snippets', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[0].snippet).not.toContain('<span')
    expect(results[0].snippet).toContain('subset')
  })

  it('handles empty response', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse({ query: { search: [] } })
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/wikipedia.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/wikipedia.ts
import type { SearchEngine, SearchResult } from '../types.js'

export class WikipediaEngine implements SearchEngine {
  name = 'wikipedia'
  description = 'Wikipedia encyclopedia search'
  domains = ['reference', 'general', 'encyclopedia']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json&origin=*`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    const data = await resp.json()
    return this.parseResponse(data)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json&origin=*', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any): SearchResult[] {
    const items = data?.query?.search ?? []
    return items.map((item: any) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: (item.snippet ?? '').replace(/<[^>]+>/g, ''),
      source: 'wikipedia',
    }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/wikipedia.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/wikipedia.ts engine/__tests__/research/engines/wikipedia.test.ts
git commit -m "feat(research): add Wikipedia search engine"
```

---

### Task 4: arXiv Engine

**Files:**
- Create: `engine/research/engines/arxiv.ts`
- Test: `engine/__tests__/research/engines/arxiv.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/arxiv.test.ts
import { describe, it, expect } from 'bun:test'
import { ArXivEngine } from '../../../research/engines/arxiv.js'

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>Attention Is All You Need Revisited</title>
    <summary>We revisit the transformer architecture and propose improvements for long-context scenarios.</summary>
    <published>2023-01-01T00:00:00Z</published>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/example</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00002v1</id>
    <title>Scaling Laws for
    Neural Language Models</title>
    <summary>We study the scaling behavior of language models across different sizes.</summary>
    <published>2023-01-02T00:00:00Z</published>
    <author><name>Carol Davis</name></author>
  </entry>
</feed>`

describe('ArXivEngine', () => {
  it('has correct metadata', () => {
    const engine = new ArXivEngine()
    expect(engine.name).toBe('arxiv')
    expect(engine.domains).toContain('academic')
    expect(engine.domains).toContain('cs')
  })

  it('parses Atom XML entries', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Attention Is All You Need Revisited')
    expect(results[0].url).toBe('http://arxiv.org/abs/2301.00001v1')
    expect(results[0].source).toBe('arxiv')
  })

  it('extracts authors and date', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[0].metadata?.authors).toEqual(['Alice Smith', 'Bob Jones'])
    expect(results[0].metadata?.date).toBe('2023-01-01T00:00:00Z')
  })

  it('extracts DOI when present', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[0].metadata?.doi).toBe('10.1234/example')
    expect(results[1].metadata?.doi).toBeUndefined()
  })

  it('normalizes multi-line titles', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[1].title).toBe('Scaling Laws for Neural Language Models')
  })

  it('handles empty feed', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom('<feed></feed>')
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/arxiv.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/arxiv.ts
import type { SearchEngine, SearchResult } from '../types.js'

export class ArXivEngine implements SearchEngine {
  name = 'arxiv'
  description = 'arXiv preprint paper search'
  domains = ['academic', 'cs', 'physics', 'math', 'science', 'papers']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    const xml = await resp.text()
    return this.parseAtom(xml)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch('http://export.arxiv.org/api/query?search_query=all:test&max_results=1', {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseAtom(xml: string): SearchResult[] {
    const entries = xml.split('<entry>').slice(1)
    return entries.map(entry => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? ''
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? ''
      const url = entry.match(/<id>(.*?)<\/id>/)?.[1]?.trim() ?? ''
      const authors = [...entry.matchAll(/<name>(.*?)<\/name>/g)].map(m => m[1].trim())
      const published = entry.match(/<published>(.*?)<\/published>/)?.[1]?.trim() ?? ''
      const doi = entry.match(/<arxiv:doi[^>]*>(.*?)<\/arxiv:doi>/)?.[1]?.trim()

      return {
        title,
        url,
        snippet: summary.slice(0, 300),
        source: 'arxiv' as const,
        metadata: {
          authors,
          date: published,
          ...(doi ? { doi } : {}),
        },
      }
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/arxiv.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/arxiv.ts engine/__tests__/research/engines/arxiv.test.ts
git commit -m "feat(research): add arXiv search engine"
```

---

### Task 5: PubMed Engine

**Files:**
- Create: `engine/research/engines/pubmed.ts`
- Test: `engine/__tests__/research/engines/pubmed.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/pubmed.test.ts
import { describe, it, expect } from 'bun:test'
import { PubMedEngine } from '../../../research/engines/pubmed.js'

const SAMPLE_SUMMARY = {
  result: {
    '12345': {
      title: 'Effects of exercise on cognitive function in older adults.',
      authors: [{ name: 'Smith J' }, { name: 'Jones A' }],
      pubdate: '2023 Jan',
      elocationid: 'doi: 10.1234/test.123',
    },
    '67890': {
      title: 'A meta-analysis of dietary interventions.',
      authors: [{ name: 'Davis C' }],
      pubdate: '2023 Mar',
    },
  },
}

describe('PubMedEngine', () => {
  it('has correct metadata', () => {
    const engine = new PubMedEngine()
    expect(engine.name).toBe('pubmed')
    expect(engine.domains).toContain('biomedical')
    expect(engine.domains).toContain('health')
  })

  it('parses summary response', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345', '67890'], SAMPLE_SUMMARY)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Effects of exercise on cognitive function in older adults.')
    expect(results[0].url).toBe('https://pubmed.ncbi.nlm.nih.gov/12345/')
    expect(results[0].source).toBe('pubmed')
  })

  it('extracts authors and date', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345'], SAMPLE_SUMMARY)
    expect(results[0].metadata?.authors).toEqual(['Smith J', 'Jones A'])
    expect(results[0].metadata?.date).toBe('2023 Jan')
  })

  it('extracts DOI when present', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345', '67890'], SAMPLE_SUMMARY)
    expect(results[0].metadata?.doi).toBe('doi: 10.1234/test.123')
    expect(results[1].metadata?.doi).toBeUndefined()
  })

  it('skips missing IDs', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['99999'], SAMPLE_SUMMARY)
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/pubmed.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/pubmed.ts
import type { SearchEngine, SearchResult } from '../types.js'

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

export class PubMedEngine implements SearchEngine {
  name = 'pubmed'
  description = 'PubMed biomedical literature search'
  domains = ['academic', 'biomedical', 'health', 'medicine', 'biology']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    // Step 1: Search for IDs
    const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    const searchData = await searchResp.json()
    const ids: string[] = searchData?.esearchresult?.idlist ?? []
    if (ids.length === 0) return []

    // Step 2: Fetch summaries
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/pubmed.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/pubmed.ts engine/__tests__/research/engines/pubmed.test.ts
git commit -m "feat(research): add PubMed search engine"
```

---

### Task 6: GitHub Engine

**Files:**
- Create: `engine/research/engines/github.ts`
- Test: `engine/__tests__/research/engines/github.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/github.test.ts
import { describe, it, expect } from 'bun:test'
import { GitHubEngine } from '../../../research/engines/github.js'

const SAMPLE_RESPONSE = {
  items: [
    {
      full_name: 'facebook/react',
      html_url: 'https://github.com/facebook/react',
      description: 'The library for web and native user interfaces.',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      full_name: 'vuejs/vue',
      html_url: 'https://github.com/vuejs/vue',
      description: null,
      updated_at: '2026-01-02T00:00:00Z',
    },
  ],
}

describe('GitHubEngine', () => {
  it('has correct metadata', () => {
    const engine = new GitHubEngine()
    expect(engine.name).toBe('github')
    expect(engine.domains).toContain('code')
    expect(engine.domains).toContain('repos')
  })

  it('parses JSON response', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('facebook/react')
    expect(results[0].url).toBe('https://github.com/facebook/react')
    expect(results[0].source).toBe('github')
  })

  it('handles null description', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[1].snippet).toBe('')
  })

  it('extracts repo metadata', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[0].metadata?.repo).toBe('facebook/react')
    expect(results[0].metadata?.date).toBe('2026-01-01T00:00:00Z')
  })

  it('handles empty items', () => {
    const engine = new GitHubEngine()
    expect(engine.parseResponse({ items: [] })).toEqual([])
    expect(engine.parseResponse({})).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/github.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/github.ts
import type { SearchEngine, SearchResult } from '../types.js'

export class GitHubEngine implements SearchEngine {
  name = 'github'
  description = 'GitHub repository and code search'
  domains = ['code', 'repos', 'technical', 'github', 'open-source']

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxResults}&sort=stars&order=desc`
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
      },
    }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/github.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/github.ts engine/__tests__/research/engines/github.test.ts
git commit -m "feat(research): add GitHub search engine"
```

---

### Task 7: SearXNG Engine

**Files:**
- Create: `engine/research/engines/searxng.ts`
- Test: `engine/__tests__/research/engines/searxng.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/engines/searxng.test.ts
import { describe, it, expect } from 'bun:test'
import { SearXNGEngine } from '../../../research/engines/searxng.js'

const SAMPLE_RESPONSE = {
  results: [
    { title: 'First Result', url: 'https://example.com/1', content: 'First result content text' },
    { title: 'Second Result', url: 'https://example.com/2', content: 'Second result content text' },
    { title: 'Third Result', url: 'https://example.com/3', content: 'Third result content text' },
  ],
}

describe('SearXNGEngine', () => {
  it('has correct metadata', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    expect(engine.name).toBe('searxng')
    expect(engine.domains).toContain('general')
    expect(engine.domains).toContain('meta')
  })

  it('parses JSON response', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    const results = engine.parseResponse(SAMPLE_RESPONSE, 5)
    expect(results.length).toBe(3)
    expect(results[0].title).toBe('First Result')
    expect(results[0].url).toBe('https://example.com/1')
    expect(results[0].source).toBe('searxng')
  })

  it('respects maxResults limit', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    const results = engine.parseResponse(SAMPLE_RESPONSE, 2)
    expect(results.length).toBe(2)
  })

  it('healthCheck returns false when no baseUrl', async () => {
    const engine = new SearXNGEngine('')
    expect(await engine.healthCheck()).toBe(false)
  })

  it('search returns empty when no baseUrl', async () => {
    const engine = new SearXNGEngine('')
    const results = await engine.search('test')
    expect(results).toEqual([])
  })

  it('handles empty results', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    expect(engine.parseResponse({ results: [] }, 5)).toEqual([])
    expect(engine.parseResponse({}, 5)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/engines/searxng.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

```typescript
// engine/research/engines/searxng.ts
import type { SearchEngine, SearchResult } from '../types.js'

export class SearXNGEngine implements SearchEngine {
  name = 'searxng'
  description = 'SearXNG meta-search (self-hosted)'
  domains = ['general', 'web', 'meta']
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.LOCALCODE_SEARXNG_URL ?? ''
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!this.baseUrl) return []
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&pageno=1`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    const data = await resp.json()
    return this.parseResponse(data, maxResults)
  }

  async healthCheck(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const resp = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  parseResponse(data: any, maxResults: number): SearchResult[] {
    return (data?.results ?? []).slice(0, maxResults).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      source: 'searxng' as const,
    }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/engines/searxng.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/research/engines/searxng.ts engine/__tests__/research/engines/searxng.test.ts
git commit -m "feat(research): add SearXNG meta-search engine"
```

---

### Task 8: Engine Registry + Router

**Files:**
- Create: `engine/research/engines/registry.ts`
- Create: `engine/research/engineRouter.ts`
- Test: `engine/__tests__/research/engines/registry.test.ts`
- Test: `engine/__tests__/research/engineRouter.test.ts`

- [ ] **Step 1: Write registry test**

```typescript
// engine/__tests__/research/engines/registry.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { registerEngine, getEngine, getAllEngines, getHealthyEngines, resetEngines } from '../../../research/engines/registry.js'
import type { SearchEngine } from '../../../research/types.js'

function mockEngine(name: string, healthy: boolean): SearchEngine {
  return {
    name,
    description: `Mock ${name}`,
    domains: ['test'],
    search: async () => [],
    healthCheck: async () => healthy,
  }
}

describe('Engine registry', () => {
  beforeEach(() => resetEngines())

  it('registers and retrieves engines', () => {
    const engine = mockEngine('test', true)
    registerEngine(engine)
    expect(getEngine('test')).toBe(engine)
  })

  it('returns undefined for unknown engine', () => {
    expect(getEngine('nonexistent')).toBeUndefined()
  })

  it('lists all registered engines', () => {
    registerEngine(mockEngine('a', true))
    registerEngine(mockEngine('b', true))
    expect(getAllEngines().length).toBe(2)
  })

  it('filters to healthy engines', async () => {
    registerEngine(mockEngine('healthy', true))
    registerEngine(mockEngine('unhealthy', false))
    const healthy = await getHealthyEngines()
    expect(healthy.length).toBe(1)
    expect(healthy[0].name).toBe('healthy')
  })
})
```

- [ ] **Step 2: Write router test**

```typescript
// engine/__tests__/research/engineRouter.test.ts
import { describe, it, expect } from 'bun:test'
import { routeQuery } from '../../../research/engineRouter.js'
import type { SearchEngine } from '../../../research/types.js'

function mockEngine(name: string, domains: string[]): SearchEngine {
  return {
    name,
    description: `Mock ${name}`,
    domains,
    search: async () => [],
    healthCheck: async () => true,
  }
}

describe('Engine router', () => {
  const engines = [
    mockEngine('arxiv', ['academic', 'cs', 'physics']),
    mockEngine('wikipedia', ['reference', 'general']),
    mockEngine('github', ['code', 'repos', 'technical']),
    mockEngine('duckduckgo', ['general', 'web']),
  ]

  it('routes academic queries to arxiv', () => {
    const result = routeQuery('machine learning research paper', engines)
    expect(result[0].name).toBe('arxiv')
  })

  it('routes code queries to github', () => {
    const result = routeQuery('typescript framework implementation', engines)
    expect(result[0].name).toBe('github')
  })

  it('routes definition queries to wikipedia', () => {
    const result = routeQuery('what is quantum computing', engines)
    const names = result.map(e => e.name)
    expect(names).toContain('wikipedia')
  })

  it('always includes general engines as fallback', () => {
    const result = routeQuery('obscure query with no domain match', engines)
    expect(result.length).toBeGreaterThan(0)
    const names = result.map(e => e.name)
    expect(names).toContain('duckduckgo')
  })

  it('returns empty for empty engine list', () => {
    expect(routeQuery('test', [])).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd engine && bun test __tests__/research/engines/registry.test.ts __tests__/research/engineRouter.test.ts`
Expected: FAIL — cannot resolve modules

- [ ] **Step 4: Write registry implementation**

```typescript
// engine/research/engines/registry.ts
import type { SearchEngine } from '../types.js'

let engines: Map<string, SearchEngine> = new Map()

export function registerEngine(engine: SearchEngine): void {
  engines.set(engine.name, engine)
}

export function getEngine(name: string): SearchEngine | undefined {
  return engines.get(name)
}

export function getAllEngines(): SearchEngine[] {
  return [...engines.values()]
}

export async function getHealthyEngines(): Promise<SearchEngine[]> {
  const checks = await Promise.all(
    [...engines.values()].map(async e => ({
      engine: e,
      healthy: await e.healthCheck(),
    }))
  )
  return checks.filter(c => c.healthy).map(c => c.engine)
}

export function resetEngines(): void {
  engines = new Map()
}

/** Register all built-in engines. Call once at startup. */
export function initEngines(): void {
  // Lazy imports to avoid circular deps and allow tree-shaking
  const { DuckDuckGoEngine } = require('./duckduckgo.js')
  const { WikipediaEngine } = require('./wikipedia.js')
  const { ArXivEngine } = require('./arxiv.js')
  const { PubMedEngine } = require('./pubmed.js')
  const { GitHubEngine } = require('./github.js')
  const { SearXNGEngine } = require('./searxng.js')

  registerEngine(new DuckDuckGoEngine())
  registerEngine(new WikipediaEngine())
  registerEngine(new ArXivEngine())
  registerEngine(new PubMedEngine())
  registerEngine(new GitHubEngine())
  registerEngine(new SearXNGEngine())
}
```

- [ ] **Step 5: Write router implementation**

```typescript
// engine/research/engineRouter.ts
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
      // General/web/meta engines get baseline score so they're always included
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd engine && bun test __tests__/research/engines/registry.test.ts __tests__/research/engineRouter.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add engine/research/engines/registry.ts engine/research/engineRouter.ts engine/__tests__/research/engines/registry.test.ts engine/__tests__/research/engineRouter.test.ts
git commit -m "feat(research): add engine registry and query router"
```

---

### Task 9: WebSearch Tool Update

**Files:**
- Modify: `engine/tools/impl/webSearch.ts`
- Test: `engine/__tests__/research/webSearchIntegration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/webSearchIntegration.test.ts
import { describe, it, expect } from 'bun:test'
import { webSearchTool } from '../../tools/impl/webSearch.js'

describe('WebSearch tool schema', () => {
  it('has engine parameter in schema', () => {
    const props = webSearchTool.inputSchema.properties as Record<string, any>
    expect(props.engine).toBeDefined()
    expect(props.engine.enum).toContain('auto')
    expect(props.engine.enum).toContain('arxiv')
    expect(props.engine.enum).toContain('wikipedia')
    expect(props.engine.enum).toContain('github')
    expect(props.engine.enum).toContain('pubmed')
    expect(props.engine.enum).toContain('searxng')
    expect(props.engine.enum).toContain('duckduckgo')
  })

  it('defaults engine to auto', () => {
    const props = webSearchTool.inputSchema.properties as Record<string, any>
    expect(props.engine.default).toBe('auto')
  })

  it('query is still required', () => {
    expect(webSearchTool.inputSchema.required).toContain('query')
  })

  it('engine is not required', () => {
    expect(webSearchTool.inputSchema.required).not.toContain('engine')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/webSearchIntegration.test.ts`
Expected: FAIL — `engine` property not in schema

- [ ] **Step 3: Rewrite webSearch.ts to delegate to engine layer**

```typescript
// engine/tools/impl/webSearch.ts
import type { ToolImpl } from '../types.js'
import { getEngine, getAllEngines, initEngines } from '../../research/engines/registry.js'
import { routeQuery } from '../../research/engineRouter.js'
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
        enum: ['auto', 'duckduckgo', 'searxng', 'arxiv', 'wikipedia', 'github', 'pubmed'],
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
        // Route to best engines based on query domain
        const engines = routeQuery(query, getAllEngines())
        if (engines.length === 0) {
          return { output: `No search engines available for: "${query}"`, isError: false }
        }
        // Search top 2 engines, merge results
        const searches = engines.slice(0, 2).map(e => e.search(query, numResults))
        const allResults = (await Promise.allSettled(searches))
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => (r as PromiseFulfilledResult<SearchResult[]>).value)
        // Deduplicate by URL
        const seen = new Set<string>()
        results = allResults.filter(r => {
          if (seen.has(r.url)) return false
          seen.add(r.url)
          return true
        }).slice(0, numResults)
      } else {
        const engine = getEngine(engineName)
        if (!engine) {
          // Fallback to duckduckgo
          const ddg = getEngine('duckduckgo')
          if (!ddg) return { output: `No search engines available`, isError: true }
          results = await ddg.search(query, numResults)
        } else {
          results = await engine.search(query, numResults)
        }
      }

      if (results.length === 0) {
        return { output: `No results found for: "${query}"`, isError: false }
      }

      const formatted = results.map((r, i) => {
        const meta = r.metadata
        const authorLine = meta?.authors?.length ? `   Authors: ${meta.authors.join(', ')}` : ''
        const dateLine = meta?.date ? `   Date: ${meta.date}` : ''
        return `${i + 1}. ${r.title}\n   ${r.url}\n   [${r.source}] ${r.snippet}${authorLine}${dateLine}`
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/webSearchIntegration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run existing tests to verify no regression**

Run: `cd engine && bun test`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add engine/tools/impl/webSearch.ts engine/__tests__/research/webSearchIntegration.test.ts
git commit -m "feat(research): route WebSearch through pluggable engine layer"
```

---

### Task 10: Researcher Agent

**Files:**
- Modify: `engine/agents/types.ts:5,85,106-124`
- Modify: `engine/agents/prism.ts:21-42`
- Modify: `engine/agents/vocabulary.ts:14-245`
- Modify: `engine/tools/impl/spawnAgent.ts:4`
- Test: update existing tests in `engine/__tests__/agents/`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/researcherAgent.test.ts
import { describe, it, expect } from 'bun:test'
import { makeSubAgentConfig, type AgentPersona } from '../../agents/types.js'
import { AGENT_PERSONAS, validatePersona } from '../../agents/prism.js'
import { getVocabulary } from '../../agents/vocabulary.js'

describe('Researcher agent', () => {
  it('researcher is a valid AgentPersona', () => {
    const persona: AgentPersona = 'researcher'
    expect(persona).toBe('researcher')
  })

  it('makeSubAgentConfig gives researcher specialist tools', () => {
    const config = makeSubAgentConfig({
      task: 'Research WebSocket patterns',
      persona: 'researcher',
      trustTier: 'specialist',
    })
    expect(config.trustTier).toBe('specialist')
    expect(config.policyConstraints.allowedTools).toContain('WebSearch')
    expect(config.policyConstraints.allowedTools).toContain('WebFetch')
    expect(config.policyConstraints.allowedTools).toContain('Read')
    expect(config.policyConstraints.maxIterations).toBe(25)
    expect(config.policyConstraints.maxTokenBudget).toBe(16384)
  })

  it('readonly tier still gets only READONLY_TOOLS', () => {
    const config = makeSubAgentConfig({
      task: 'Explore codebase',
      persona: 'scout',
    })
    expect(config.policyConstraints.allowedTools).not.toContain('WebSearch')
    expect(config.policyConstraints.allowedTools).not.toContain('WebFetch')
  })

  it('researcher persona passes PRISM validation', () => {
    const persona = AGENT_PERSONAS['researcher']
    expect(persona).toBeDefined()
    const { valid, issues } = validatePersona(persona)
    expect(valid).toBe(true)
    expect(issues).toEqual([])
  })

  it('researcher has vocabulary', () => {
    const vocab = getVocabulary('researcher')
    expect(vocab).toBeDefined()
    expect(vocab!.agentType).toBe('researcher')
    expect(vocab!.clusters.length).toBeGreaterThanOrEqual(3)
  })

  it('researcher vocabulary has source evaluation terms', () => {
    const vocab = getVocabulary('researcher')!
    const sourceCluster = vocab.clusters.find(c => c.name === 'source evaluation')
    expect(sourceCluster).toBeDefined()
    expect(sourceCluster!.terms).toContain('peer-reviewed')
    expect(sourceCluster!.terms).toContain('citation')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/researcherAgent.test.ts`
Expected: FAIL — 'researcher' not in AgentPersona, no persona, no vocab

- [ ] **Step 3: Update `engine/agents/types.ts`**

Add `'researcher'` to the AgentPersona union (line 5):
```typescript
export type AgentPersona = 'scout' | 'oracle' | 'kraken' | 'spark' | 'architect' | 'researcher'
```

Add `SPECIALIST_TOOLS` constant after `READONLY_TOOLS` (after line 85):
```typescript
const SPECIALIST_TOOLS: string[] = [...READONLY_TOOLS, 'WebSearch', 'WebFetch']
```

Update `makeSubAgentConfig` (line 117) to use tier-aware tool selection:
```typescript
      allowedTools: trustTier === 'readonly'
        ? READONLY_TOOLS
        : trustTier === 'specialist'
          ? SPECIALIST_TOOLS
          : [...SPECIALIST_TOOLS, 'Write', 'Edit', 'Bash'],
```

- [ ] **Step 4: Update `engine/agents/prism.ts`**

Add researcher persona to `AGENT_PERSONAS` (after line 41):
```typescript
  researcher: {
    role: 'research analyst',
    focus: 'multi-source information gathering, evidence evaluation, and synthesis with citations',
  },
```

- [ ] **Step 5: Update `engine/agents/vocabulary.ts`**

Add researcher vocabulary entry (after the architect entry, before the closing `}` of VOCABULARIES):
```typescript
  researcher: {
    agentType: 'researcher',
    clusters: [
      {
        name: 'source evaluation',
        terms: [
          'primary source',
          'secondary source',
          'peer-reviewed',
          'preprint',
          'citation',
          'credibility',
          'methodology',
          'sample size',
          'replication',
        ],
      },
      {
        name: 'synthesis',
        terms: [
          'corroboration',
          'contradiction',
          'gap',
          'consensus',
          'dissent',
          'meta-analysis',
          'weight of evidence',
          'systematic review',
        ],
      },
      {
        name: 'academic',
        terms: [
          'arXiv',
          'PubMed',
          'DOI',
          'abstract',
          'related work',
          'prior art',
          'state of the art',
          'literature review',
        ],
      },
    ],
  },
```

- [ ] **Step 6: Update `engine/tools/impl/spawnAgent.ts`**

Change line 4 to include 'researcher':
```typescript
const VALID_PERSONAS: AgentPersona[] = ['scout', 'oracle', 'kraken', 'spark', 'architect', 'researcher']
```

Auto-set specialist tier for researcher — update the execute function body, after the validation check:
```typescript
    const trustTier = persona === 'researcher' ? 'specialist' as const : undefined
    const config = makeSubAgentConfig({ task, persona: persona as AgentPersona, trustTier })
```

Also update the tool description to include researcher:
```typescript
  description:
    'Spawn an autonomous sub-agent to work on a task. Agent runs independently with its own context and tools. Personas: scout (explore codebase), oracle (deep analysis), kraken (testing), spark (refactoring), architect (design), researcher (multi-source research with web access).',
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/researcherAgent.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 8: Run existing agent tests to verify no regression**

Run: `cd engine && bun test __tests__/agents/`
Expected: All existing agent tests still pass

- [ ] **Step 9: Commit**

```bash
git add engine/agents/types.ts engine/agents/prism.ts engine/agents/vocabulary.ts engine/tools/impl/spawnAgent.ts engine/__tests__/research/researcherAgent.test.ts
git commit -m "feat(research): add researcher agent persona with specialist tier web tools"
```

---

### Task 11: Research Workflow + Registration

**Files:**
- Create: `engine/workflows/definitions/research.ts`
- Modify: `engine/workflows/index.ts`
- Test: `engine/__tests__/research/workflow.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/workflow.test.ts
import { describe, it, expect } from 'bun:test'
import { researchWorkflow } from '../../workflows/definitions/research.js'
import { WorkflowEngine } from '../../workflows/engine.js'
import { getWorkflow } from '../../workflows/index.js'

describe('Research workflow', () => {
  it('has correct structure', () => {
    expect(researchWorkflow.name).toBe('research')
    expect(researchWorkflow.displayName).toBe('Deep Research')
    expect(researchWorkflow.initialPhase).toBe('scope')
    expect(Object.keys(researchWorkflow.phases)).toEqual([
      'scope', 'decompose', 'gather', 'synthesize', 'report', 'index',
    ])
  })

  it('follows happy path: scope → decompose → gather → synthesize → report → index → done', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    expect(engine.currentPhase?.name).toBe('scope')
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('index')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('supports synthesize → gather loop', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('gather')  // loop back for more research
    engine.advance('synthesize')
    engine.advance('report')
    expect(engine.currentPhase?.name).toBe('report')
  })

  it('scope phase allows CodeIndex and WebSearch', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('CodeIndex')
    expect(tools).toContain('WebSearch')
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Write')
  })

  it('gather phase allows SubAgent and CollectAgent', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('SubAgent')
    expect(tools).toContain('CollectAgent')
    expect(tools).toContain('WebSearch')
    expect(tools).toContain('WebFetch')
  })

  it('report phase allows Write', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('Write')
    expect(tools).toContain('Read')
  })

  it('index phase allows IndexResearch', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('index')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('IndexResearch')
  })

  it('report can skip directly to done', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('is registered as /research workflow', () => {
    const wf = getWorkflow('/research')
    expect(wf).toBeDefined()
    expect(wf!.name).toBe('research')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/workflow.test.ts`
Expected: FAIL — cannot resolve modules

- [ ] **Step 3: Write the workflow definition**

```typescript
// engine/workflows/definitions/research.ts
import type { WorkflowDefinition } from '../types.js'

export const researchWorkflow: WorkflowDefinition = {
  name: 'research',
  displayName: 'Deep Research',
  description: 'Iterative multi-source research with evidence synthesis and citations.',
  initialPhase: 'scope',
  phases: {
    scope: {
      name: 'scope',
      instruction: [
        'Understand the research goal and clarify boundaries.',
        'Check the code index for existing research on this topic (use CodeIndex).',
        'If prior research exists with high relevance, summarize what is known.',
        'State the research question clearly and confirm scope with the user.',
      ].join('\n'),
      allowedTools: ['Read', 'Glob', 'Grep', 'CodeIndex', 'WebSearch'],
      gate: { type: 'model_done' },
      transitions: ['decompose'],
    },
    decompose: {
      name: 'decompose',
      instruction: [
        'Break the research question into 3-7 specific sub-queries.',
        'For each sub-query, note which search engine is most appropriate:',
        '- arxiv: academic papers (CS, physics, math)',
        '- pubmed: biomedical/health literature',
        '- wikipedia: background/definitions/overviews',
        '- github: code implementations, libraries, frameworks',
        '- duckduckgo/searxng: general web results',
        '',
        'Output a numbered list of sub-queries with recommended engines.',
      ].join('\n'),
      gate: { type: 'model_done' },
      transitions: ['gather'],
    },
    gather: {
      name: 'gather',
      instruction: [
        'For each sub-query from the decompose phase, spawn a researcher agent:',
        '- Set persona to "researcher"',
        '- Include the sub-query and preferred engine in the task',
        '- Use blocking=false for parallel execution',
        'Then collect all results with CollectAgent.',
        '',
        'Each researcher agent will search, fetch promising sources, and return findings.',
      ].join('\n'),
      allowedTools: ['SubAgent', 'CollectAgent', 'WebSearch', 'WebFetch', 'Read'],
      gate: { type: 'model_done' },
      transitions: ['synthesize'],
    },
    synthesize: {
      name: 'synthesize',
      instruction: [
        'Analyze all gathered evidence:',
        '1. Identify corroborating findings across sources',
        '2. Flag contradictions between sources',
        '3. Identify gaps where information is missing',
        '',
        'If critical gaps exist and this is not the 3rd iteration,',
        'generate follow-up queries and transition back to gather.',
        'Otherwise, proceed to report.',
      ].join('\n'),
      allowedTools: ['Read', 'Glob', 'Grep'],
      gate: { type: 'model_done' },
      transitions: ['gather', 'report'],
    },
    report: {
      name: 'report',
      instruction: [
        'Produce two outputs:',
        '',
        '1. INLINE SUMMARY (in your response, max 500 tokens):',
        '## Research: [Topic]',
        '**Key Findings:**',
        '1. [Finding] — [Source](url)',
        '**Gaps/Uncertainties:**',
        '- [What was not found]',
        '**Recommendation:**',
        '[How this applies to the current task]',
        '',
        '2. FULL REPORT (save to .cynco/research/YYYY-MM-DD-<topic-slug>.md):',
        '# Research: [Topic]',
        'Date, Query, Engines used, Iterations',
        '## Summary, ## Findings (by sub-query), ## Sources, ## Gaps',
      ].join('\n'),
      allowedTools: ['Write', 'Read'],
      gate: { type: 'model_done' },
      transitions: ['index', 'done'],
    },
    index: {
      name: 'index',
      instruction: [
        'Index the research report into the project vector store using IndexResearch.',
        'Pass the report file path from the previous phase.',
        'This makes findings discoverable via CodeIndex in future sessions.',
      ].join('\n'),
      allowedTools: ['IndexResearch'],
      gate: { type: 'model_done' },
      transitions: ['done'],
    },
  },
}
```

- [ ] **Step 4: Register the workflow in `engine/workflows/index.ts`**

Add import at the top (after line 6):
```typescript
export { researchWorkflow } from './definitions/research.js'
```

Add import (after line 17):
```typescript
import { researchWorkflow } from './definitions/research.js'
```

Add to WORKFLOWS record (after line 27):
```typescript
  '/research': researchWorkflow,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/workflow.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Run existing workflow tests to verify no regression**

Run: `cd engine && bun test __tests__/workflows/`
Expected: All existing workflow tests still pass

- [ ] **Step 7: Commit**

```bash
git add engine/workflows/definitions/research.ts engine/workflows/index.ts engine/__tests__/research/workflow.test.ts
git commit -m "feat(research): add 6-phase research workflow with /research command"
```

---

### Task 12: Research Chunk Type + Chunker

**Files:**
- Modify: `engine/index/types.ts:1`
- Create: `engine/index/researchChunker.ts`
- Test: `engine/__tests__/research/researchChunker.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/researchChunker.test.ts
import { describe, it, expect } from 'bun:test'
import { chunkResearchReport } from '../../index/researchChunker.js'

const SAMPLE_REPORT = `# Research: WebSocket Patterns
Date: 2026-05-05
Query: WebSocket connection pooling in Bun

## Summary
WebSocket pooling is essential for high-performance servers. Multiple approaches exist with different trade-offs for memory and throughput.

## Findings

### Connection Pooling Strategies
- Round-robin pooling distributes connections evenly — Source: [Pool Patterns](https://example.com/pools)
- Least-connections routing minimizes latency — Source: [Load Balancing](https://example.com/lb)

### Bun-Specific Implementation
- Bun's native WebSocket API supports per-message compression — Source: [Bun Docs](https://bun.sh/docs/ws)
- Connection backpressure is handled via the drain event — Source: [Bun WS](https://bun.sh/docs/ws)

## Sources
1. [Pool Patterns](https://example.com/pools) — duckduckgo
2. [Load Balancing](https://example.com/lb) — github

## Gaps
- No benchmarks found for Bun vs Node.js WebSocket performance
`

describe('Research chunker', () => {
  it('splits report into chunks by headings', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(c => c.chunkType === 'research')).toBe(true)
  })

  it('assigns heading names to chunks', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    const names = chunks.map(c => c.name).filter(Boolean)
    expect(names).toContain('Summary')
    expect(names).toContain('Connection Pooling Strategies')
    expect(names).toContain('Bun-Specific Implementation')
  })

  it('preserves file path on all chunks', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    expect(chunks.every(c => c.filePath === '.cynco/research/test.md')).toBe(true)
  })

  it('sets consistent fileHash', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    const hashes = new Set(chunks.map(c => c.fileHash))
    expect(hashes.size).toBe(1)
  })

  it('skips tiny sections under 50 chars', () => {
    const tiny = `# Title\n\n## Big Section\nThis section has enough content to pass the minimum length threshold for chunking.\n\n## Tiny\nNo.`
    const chunks = chunkResearchReport('test.md', tiny)
    const names = chunks.map(c => c.name)
    expect(names).not.toContain('Tiny')
  })

  it('handles empty content', () => {
    const chunks = chunkResearchReport('test.md', '')
    expect(chunks).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/researchChunker.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Update `engine/index/types.ts`**

Change line 1 from:
```typescript
export type ChunkType = 'function' | 'class' | 'module' | 'import_block'
```
to:
```typescript
export type ChunkType = 'function' | 'class' | 'module' | 'import_block' | 'research'
```

- [ ] **Step 4: Write the chunker**

```typescript
// engine/index/researchChunker.ts
import { createHash } from 'crypto'
import type { Chunk } from './types.js'

export function chunkResearchReport(filePath: string, content: string): Chunk[] {
  if (!content.trim()) return []

  const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const lines = content.split('\n')
  const chunks: Chunk[] = []

  let currentHeading = ''
  let currentStart = 0
  let currentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^#{1,3}\s+(.+)/)

    if (headingMatch && currentLines.length > 0) {
      // Flush previous section
      const sectionContent = currentLines.join('\n').trim()
      if (sectionContent.length > 50) {
        chunks.push({
          filePath,
          chunkType: 'research',
          name: currentHeading || null,
          startLine: currentStart + 1,
          endLine: i,
          content: sectionContent,
          fileHash,
        })
      }
      currentHeading = headingMatch[1].trim()
      currentStart = i
      currentLines = [lines[i]]
    } else {
      if (!currentHeading && headingMatch) {
        currentHeading = headingMatch[1].trim()
        currentStart = i
      }
      currentLines.push(lines[i])
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n').trim()
    if (sectionContent.length > 50) {
      chunks.push({
        filePath,
        chunkType: 'research',
        name: currentHeading || null,
        startLine: currentStart + 1,
        endLine: lines.length,
        content: sectionContent,
        fileHash,
      })
    }
  }

  return chunks
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/researchChunker.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add engine/index/types.ts engine/index/researchChunker.ts engine/__tests__/research/researchChunker.test.ts
git commit -m "feat(research): add research chunk type and markdown chunker"
```

---

### Task 13: Research Indexer + IndexResearch Tool

**Files:**
- Create: `engine/research/indexer.ts`
- Create: `engine/tools/impl/indexResearch.ts`
- Modify: `engine/tools/registry.ts`
- Test: `engine/__tests__/research/indexer.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/indexer.test.ts
import { describe, it, expect } from 'bun:test'
import { indexResearchReport } from '../../research/indexer.js'
import type { Chunk } from '../../index/types.js'

// Mock IndexStore
class MockStore {
  chunks: { chunk: Chunk; embedding: number[] }[] = []
  insertChunk(chunk: Chunk, embedding: number[]): number {
    this.chunks.push({ chunk, embedding })
    return this.chunks.length
  }
  close() {}
}

// Mock EmbedClient
class MockEmbedClient {
  callCount = 0
  async embed(text: string): Promise<number[]> {
    this.callCount++
    return [0.1, 0.2, 0.3] // fake embedding
  }
}

describe('indexResearchReport', () => {
  it('chunks and embeds a research report', async () => {
    const store = new MockStore()
    const embedClient = new MockEmbedClient()
    const report = `# Research: Test Topic\n\n## Summary\nThis is a test research report with enough content to pass the minimum chunk size threshold.\n\n## Findings\nWe found that testing is important and should always be done with sufficient detail and context.\n`

    const count = await indexResearchReport(
      report,
      '.cynco/research/test.md',
      store as any,
      embedClient as any,
    )

    expect(count).toBeGreaterThan(0)
    expect(store.chunks.length).toBe(count)
    expect(embedClient.callCount).toBe(count)
    expect(store.chunks[0].chunk.chunkType).toBe('research')
  })

  it('returns 0 for empty content', async () => {
    const store = new MockStore()
    const embedClient = new MockEmbedClient()
    const count = await indexResearchReport('', 'test.md', store as any, embedClient as any)
    expect(count).toBe(0)
  })

  it('continues indexing if one chunk fails', async () => {
    const store = new MockStore()
    let callIdx = 0
    const embedClient = {
      async embed(text: string) {
        callIdx++
        if (callIdx === 1) throw new Error('Embedding failed')
        return [0.1, 0.2, 0.3]
      },
    }
    const report = `# Research: Test\n\n## Section A\nFirst section with enough content to be chunked properly by the research chunker.\n\n## Section B\nSecond section also with enough content to be chunked properly by the research chunker.\n`

    const count = await indexResearchReport(report, 'test.md', store as any, embedClient as any)
    // One chunk fails, one succeeds
    expect(count).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/indexer.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the indexer**

```typescript
// engine/research/indexer.ts
import { chunkResearchReport } from '../index/researchChunker.js'
import type { IndexStore } from '../index/store.js'
import type { EmbedClient } from '../index/embedClient.js'

/**
 * Chunk a research report and embed it into the vector store.
 * Takes content as a string (caller reads the file).
 * Returns the number of successfully indexed chunks.
 */
export async function indexResearchReport(
  content: string,
  filePath: string,
  store: IndexStore,
  embedClient: EmbedClient,
): Promise<number> {
  const chunks = chunkResearchReport(filePath, content)
  let indexed = 0

  for (const chunk of chunks) {
    try {
      const embedding = await embedClient.embed(chunk.content)
      store.insertChunk(chunk, embedding)
      indexed++
    } catch (err) {
      console.log(`[research] Failed to embed chunk "${chunk.name}": ${err}`)
    }
  }

  return indexed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/indexer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the IndexResearch tool**

```typescript
// engine/tools/impl/indexResearch.ts
import type { ToolImpl } from '../types.js'
import { indexResearchReport } from '../../research/indexer.js'
import { EmbedClient } from '../../index/embedClient.js'
import { IndexStore } from '../../index/store.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

export const indexResearchTool: ToolImpl = {
  name: 'IndexResearch',
  description: 'Index a research report into the project vector store for future retrieval via CodeIndex.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the research report markdown file (relative to project root)',
      },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const filePath = input.file_path as string
    const fullPath = resolve(cwd, filePath)

    if (!existsSync(fullPath)) {
      return { output: `File not found: ${filePath}`, isError: true }
    }

    const dbPath = resolve(cwd, '.cynco/index/project.db')
    const dbDir = dirname(dbPath)
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    let store: IndexStore | null = null
    try {
      const content = readFileSync(fullPath, 'utf-8')
      store = new IndexStore(dbPath)
      const embedClient = new EmbedClient()
      const count = await indexResearchReport(content, filePath, store, embedClient)
      return {
        output: `Indexed ${count} research chunk${count !== 1 ? 's' : ''} from ${filePath}`,
        isError: false,
      }
    } catch (err) {
      return {
        output: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    } finally {
      store?.close()
    }
  },
}
```

- [ ] **Step 6: Register in `engine/tools/registry.ts`**

Add import (after existing imports, around line 20):
```typescript
import { indexResearchTool } from './impl/indexResearch.js'
```

Add to `ALL_TOOLS` array (after `collectAgentTool`):
```typescript
  indexResearchTool,
```

- [ ] **Step 7: Run all tests**

Run: `cd engine && bun test __tests__/research/indexer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add engine/research/indexer.ts engine/tools/impl/indexResearch.ts engine/tools/registry.ts engine/__tests__/research/indexer.test.ts
git commit -m "feat(research): add research indexer and IndexResearch tool"
```

---

### Task 14: Vibe Loop Integration

**Files:**
- Modify: `engine/vibe/controller.ts`
- Test: `engine/__tests__/research/vibeIntegration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// engine/__tests__/research/vibeIntegration.test.ts
import { describe, it, expect } from 'bun:test'
import { VibeController } from '../../vibe/controller.js'

describe('Vibe loop research integration', () => {
  // VibeController requires a full ConversationLoop, so we test the shouldResearch
  // method exists and the class has the expected interface
  it('VibeController class exists and can be imported', () => {
    expect(VibeController).toBeDefined()
    expect(typeof VibeController).toBe('function')
  })

  // The actual integration is tested by verifying the method exists on the prototype
  it('has shouldResearch method', () => {
    // shouldResearch is private, so we check it exists via prototype inspection
    const proto = VibeController.prototype as any
    expect(typeof proto.shouldResearch).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/research/vibeIntegration.test.ts`
Expected: FAIL — `shouldResearch` not found on prototype

- [ ] **Step 3: Add shouldResearch method to VibeController**

In `engine/vibe/controller.ts`, add this method after the `queryProjectIndex` method (around line 456):

```typescript
  /** Check if the user's task description warrants external research before building. */
  private async shouldResearch(description: string): Promise<boolean> {
    if (!description || description.trim().length < 10) return false

    // Check if research already exists in the index for this topic
    const existing = await this.queryProjectIndex(description, 3)
    if (existing) {
      // Check if any results are research chunks (contain citation-like patterns)
      const hasResearch = existing.includes('[Source:') || existing.includes('— Source:')
      if (hasResearch) {
        console.log('[vibe] Existing research found in index — skipping research phase')
        return false
      }
    }

    try {
      const prompt = [
        'Does this task require external research (unfamiliar APIs, libraries, patterns,',
        'best practices, academic references) before implementation?',
        'Consider: if a developer has never worked with the technologies mentioned,',
        'would they need to look things up first?',
        '',
        `Task: "${description}"`,
        '',
        'Answer YES or NO only.',
      ].join('\n')
      const answer = await this.sideQuery(prompt)
      return answer.trim().toUpperCase().startsWith('YES')
    } catch {
      return false
    }
  }
```

- [ ] **Step 4: Modify executeBuild to check for research first**

In `engine/vibe/controller.ts`, modify the `executeBuild` method (line 484). Add research check at the top of the method, before `this.engine.transitionToBuild()`:

```typescript
  async executeBuild(buildPromptOverride?: string): Promise<void> {
    // Check if research would help before building
    if (!buildPromptOverride && this.userDescription) {
      const needsResearch = await this.shouldResearch(this.userDescription)
      if (needsResearch) {
        console.log(`[vibe] Research needed — injecting research context before build`)
        const researchPrompt = [
          `Before implementing, research the following topic using WebSearch:`,
          `"${this.userDescription}"`,
          '',
          `Search for relevant libraries, APIs, patterns, and best practices.`,
          `Use the engine parameter to target specific search engines:`,
          `- engine:"arxiv" for academic papers`,
          `- engine:"github" for code examples and libraries`,
          `- engine:"wikipedia" for background concepts`,
          '',
          `Summarize your findings, then proceed to implementation.`,
        ].join('\n')
        // Inject research as a pre-build step in the conversation
        await this.loop.handleUserMessage(researchPrompt)
      }
    }

    this.engine.transitionToBuild()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bun test __tests__/research/vibeIntegration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run existing vibe tests to verify no regression**

Run: `cd engine && bun test __tests__/vibe/`
Expected: All existing vibe tests still pass

- [ ] **Step 7: Commit**

```bash
git add engine/vibe/controller.ts engine/__tests__/research/vibeIntegration.test.ts
git commit -m "feat(research): integrate shouldResearch into vibe loop pre-build phase"
```

---

### Task 15: Integration Wire Check

**BLOCKING:** This task verifies every new symbol is actually imported, called, and used. No dead code allowed.

- [ ] **Step 1: Verify all new types are imported somewhere**

```bash
cd engine && grep -r "SearchResult\|SearchEngine" --include="*.ts" -l | grep -v __tests__ | grep -v node_modules
```

Expected: `research/types.ts` (definition) + at least `research/engines/*.ts`, `research/engineRouter.ts`, `tools/impl/webSearch.ts` (imports)

- [ ] **Step 2: Verify all engines are registered**

```bash
cd engine && grep -r "DuckDuckGoEngine\|WikipediaEngine\|ArXivEngine\|PubMedEngine\|GitHubEngine\|SearXNGEngine" --include="*.ts" -l | grep -v __tests__
```

Expected: Each engine file + `research/engines/registry.ts` (where `initEngines()` creates instances)

- [ ] **Step 3: Verify initEngines is called**

```bash
cd engine && grep -r "initEngines" --include="*.ts" -l | grep -v __tests__
```

Expected: `research/engines/registry.ts` (definition) + `tools/impl/webSearch.ts` (called in `ensureEngines()`)

- [ ] **Step 4: Verify researcher persona is wired end-to-end**

```bash
cd engine && grep -r "'researcher'" --include="*.ts" -l | grep -v __tests__
```

Expected: `agents/types.ts`, `agents/prism.ts`, `agents/vocabulary.ts`, `tools/impl/spawnAgent.ts`

- [ ] **Step 5: Verify research workflow is registered**

```bash
cd engine && grep -r "researchWorkflow" --include="*.ts" -l | grep -v __tests__
```

Expected: `workflows/definitions/research.ts` (definition) + `workflows/index.ts` (import + registration in WORKFLOWS)

- [ ] **Step 6: Verify IndexResearch tool is registered**

```bash
cd engine && grep -r "indexResearchTool\|IndexResearch" --include="*.ts" -l | grep -v __tests__
```

Expected: `tools/impl/indexResearch.ts` (definition) + `tools/registry.ts` (import + in ALL_TOOLS) + `workflows/definitions/research.ts` (in allowedTools)

- [ ] **Step 7: Verify 'research' chunk type is used**

```bash
cd engine && grep -r "'research'" --include="*.ts" index/ research/ | grep -v __tests__
```

Expected: `index/types.ts` (in ChunkType), `index/researchChunker.ts` (sets chunkType)

- [ ] **Step 8: Verify SPECIALIST_TOOLS is used in makeSubAgentConfig**

```bash
cd engine && grep -r "SPECIALIST_TOOLS" --include="*.ts" -l
```

Expected: `agents/types.ts` (defined and used in makeSubAgentConfig)

- [ ] **Step 9: Verify shouldResearch is called in vibe controller**

```bash
cd engine && grep -r "shouldResearch" --include="*.ts" -l
```

Expected: `vibe/controller.ts` (defined and called in executeBuild)

- [ ] **Step 10: Run full test suite**

```bash
cd engine && bun test
```

Expected: ALL tests pass — no regressions, all new tests green

- [ ] **Step 11: Commit wire check results**

If any wiring gaps were found and fixed:
```bash
git add -A && git commit -m "fix(research): wire check — fix integration gaps"
```

If all clean:
```bash
echo "Wire check passed — all symbols imported and used"
```
