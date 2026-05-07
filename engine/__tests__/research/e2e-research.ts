#!/usr/bin/env bun
/**
 * End-to-end research test harness.
 *
 * Exercises every search engine with real HTTP calls, routes queries
 * through the engine router, scores/deduplicates results, and produces
 * a competitive analysis report.
 *
 * Usage:  bun engine/__tests__/research/e2e-research.ts
 */

import { DuckDuckGoEngine } from '../../research/engines/duckduckgo.js'
import { WikipediaEngine } from '../../research/engines/wikipedia.js'
import { ArXivEngine } from '../../research/engines/arxiv.js'
import { GitHubEngine } from '../../research/engines/github.js'
import { HuggingFaceEngine } from '../../research/engines/huggingface.js'
import { routeQuery, searchWithFallback } from '../../research/engineRouter.js'
import { scoreResults, deduplicateResults } from '../../research/resultScorer.js'
import type { SearchEngine, SearchResult } from '../../research/types.js'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

// ─── Config ───────────────────────────────────────────────────

const TOPIC = 'local AI coding agents'

// Keyword-based discovery queries
const KEYWORD_QUERIES = [
  { query: 'local LLM coding assistant open source', engines: ['github', 'duckduckgo'] },
  { query: 'AI code generation local models self-hosted', engines: ['duckduckgo', 'github'] },
  { query: 'autonomous coding agent local LLM', engines: ['arxiv', 'duckduckgo'] },
  { query: 'large language model software engineering agent', engines: ['arxiv'] },
  { query: 'terminal AI coding assistant self-hosted', engines: ['github', 'duckduckgo'] },
  { query: 'coding LLM fine-tuned model', engines: ['huggingface'] },
]

// #4: Curated seed queries — search known major projects by name
const SEED_QUERIES = [
  { query: 'aider ai coding assistant', engines: ['github'] },
  { query: 'cline coding agent vscode', engines: ['github'] },
  { query: 'opencode ai terminal agent', engines: ['github'] },
  { query: 'continue dev coding assistant', engines: ['github'] },
  { query: 'tabby self-hosted copilot', engines: ['github'] },
  { query: 'openhands opendevin coding', engines: ['github'] },
  { query: 'goose ai agent', engines: ['github'] },
  { query: 'swe-agent princeton', engines: ['github'] },
]

const ALL_QUERIES = [...KEYWORD_QUERIES, ...SEED_QUERIES]

// ─── Engine Setup ─────────────────────────────────────────────

const allEngines: SearchEngine[] = [
  new DuckDuckGoEngine(),
  new WikipediaEngine(),
  new ArXivEngine(),
  new GitHubEngine({ minStars: 10 }),  // #9: filter out weekend projects
  new HuggingFaceEngine(),             // #10: HuggingFace integration
]

const engineMap = new Map(allEngines.map(e => [e.name, e]))

// ─── Utilities ────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().slice(11, 19)
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`)
}

// ─── Phase 1: Health Check ────────────────────────────────────

log('═══ CynCo Deep Research — E2E Test (v2) ═══')
log(`Topic: "${TOPIC}"`)
log('')
log('Phase 1: Engine Health Check')

const healthResults: { engine: string; ok: boolean }[] = []
for (const engine of allEngines) {
  const ok = await engine.healthCheck()
  healthResults.push({ engine: engine.name, ok })
  log(`  ${ok ? '✓' : '✗'} ${engine.name}`)
}

const healthyEngines = healthResults.filter(h => h.ok).map(h => h.engine)
log(`  ${healthyEngines.length}/${allEngines.length} engines healthy`)
log('')

// ─── Phase 2: Query Routing ──────────────────────────────────

log('Phase 2: Query Routing')
for (const sq of ALL_QUERIES.slice(0, 5)) {
  const routed = routeQuery(sq.query, allEngines)
  const routedNames = routed.map(e => e.name)
  log(`  "${sq.query.slice(0, 50)}..."`)
  log(`    → routed: [${routedNames.join(', ')}]`)
}
log(`  (${ALL_QUERIES.length} total queries: ${KEYWORD_QUERIES.length} keyword + ${SEED_QUERIES.length} seed)`)
log('')

// ─── Phase 3: Gather — Execute all searches ──────────────────

log('Phase 3: Gather — searching all queries')
const allResults: SearchResult[] = []
let totalRaw = 0

for (const sq of ALL_QUERIES) {
  log(`  Searching: "${sq.query.slice(0, 55)}"`)

  for (const engineName of sq.engines) {
    const engine = engineMap.get(engineName)
    if (!engine) {
      log(`    ⚠ Engine "${engineName}" not found`)
      continue
    }
    if (!healthyEngines.includes(engineName)) {
      log(`    ⚠ ${engineName} unhealthy, skipping`)
      continue
    }

    // #7: Use fallback chain
    const results = await searchWithFallback(sq.query, engine, allEngines, 5)
      .catch(err => {
        log(`    ✗ ${engine.name} failed: ${err instanceof Error ? err.message : String(err)}`)
        return [] as SearchResult[]
      })

    log(`    ${engine.name}: ${results.length} results${results[0]?.metadata?.stars ? ` (top: ${results[0].metadata.stars.toLocaleString()}★)` : ''}`)
    allResults.push(...results)
    totalRaw += results.length
  }
}

log(`  Total raw results: ${totalRaw}`)
log('')

// ─── Phase 4: Score + Deduplicate ────────────────────────────

log('Phase 4: Score, deduplicate, and rank')

// #5 + #6: Score with keyword density, recency, authority, corroboration
const scored = scoreResults(allResults, TOPIC)
const deduped = deduplicateResults(scored)

log(`  Raw: ${totalRaw} → Scored: ${scored.length} → Unique: ${deduped.length}`)

// Group by source
const bySource = new Map<string, SearchResult[]>()
for (const r of deduped) {
  const list = bySource.get(r.source) ?? []
  list.push(r)
  bySource.set(r.source, list)
}

for (const [source, results] of bySource) {
  log(`  ${source}: ${results.length} unique results`)
}
log('')

// ─── Phase 5: Report ─────────────────────────────────────────

log('Phase 5: Report — generating research output')

const date = new Date().toISOString().slice(0, 10)
const reportDir = join(process.cwd(), '.cynco', 'research')
if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true })
}

const githubResults = (bySource.get('github') ?? []).sort((a, b) => (b.metadata?.stars ?? 0) - (a.metadata?.stars ?? 0))
const ddgResults = bySource.get('duckduckgo') ?? []
const arxivResults = bySource.get('arxiv') ?? []
const wikiResults = bySource.get('wikipedia') ?? []
const hfResults = bySource.get('huggingface') ?? []

const report = `# Research: Local AI Coding Agents — Competitive Landscape (v2)

**Date:** ${date}
**Query:** ${TOPIC}
**Engines Used:** ${healthyEngines.join(', ')}
**Sub-queries:** ${ALL_QUERIES.length} (${KEYWORD_QUERIES.length} keyword + ${SEED_QUERIES.length} seed)
**Total Results:** ${deduped.length} unique (${totalRaw} raw)

---

## Summary

This research maps the landscape of local/self-hosted AI coding agents — tools that run
LLMs on local hardware (via Ollama, llama.cpp, etc.) to provide AI-assisted coding without
sending code to external APIs. CynCo is compared against discovered alternatives.

Results are scored by keyword relevance, recency, source authority (GitHub stars),
and cross-source corroboration.

---

## GitHub Repositories (by stars)

${githubResults.length > 0 ? githubResults.map((r, i) => `### ${i + 1}. [${r.title}](${r.url}) — ${(r.metadata?.stars ?? 0).toLocaleString()} ★
${r.snippet}
${r.metadata?.language ? `Language: ${r.metadata.language} | ` : ''}${r.metadata?.date ? `Updated: ${r.metadata.date.slice(0, 10)}` : ''} | Score: ${r.score ?? 'N/A'}
`).join('\n') : '*No GitHub results found*'}

---

## Web Search Results

${ddgResults.length > 0 ? ddgResults.map((r, i) => `${i + 1}. **${r.title || '(no title)'}** (score: ${r.score ?? 'N/A'})
   ${r.url ? `[Link](${r.url})` : ''}
   ${r.snippet}
`).join('\n') : '*No web results found*'}

---

## Academic Papers

${arxivResults.length > 0 ? arxivResults.map((r, i) => `${i + 1}. **${r.title}** (score: ${r.score ?? 'N/A'})
   ${r.url ? `[arXiv](${r.url})` : ''}
   ${r.snippet.slice(0, 300)}${r.snippet.length > 300 ? '...' : ''}
   ${r.metadata?.authors ? `Authors: ${r.metadata.authors.slice(0, 3).join(', ')}${r.metadata.authors.length > 3 ? ' et al.' : ''}` : ''}
   ${r.metadata?.date ? `Published: ${r.metadata.date}` : ''}
`).join('\n') : '*No arXiv results found (category filter: cs.SE, cs.AI, cs.CL, cs.LG, cs.MA, cs.PL)*'}

---

## Hugging Face Models

${hfResults.length > 0 ? hfResults.map((r, i) => `${i + 1}. **[${r.title}](${r.url})**
   ${r.snippet}
`).join('\n') : '*No Hugging Face results found*'}

---

## Encyclopedia / Background

${wikiResults.length > 0 ? wikiResults.map((r, i) => `${i + 1}. **[${r.title}](${r.url})**
   ${r.snippet}
`).join('\n') : '*No Wikipedia results found*'}

---

## How CynCo Compares

| Feature | CynCo | Top OSS Alternatives |
|---------|-------|---------------------|
| Runtime | Local only (Ollama/llama.cpp) | Aider, OpenCode, Goose: local+cloud hybrid |
| Privacy | Code never leaves machine | Tabby: self-hosted; Others: configurable |
| Architecture | VSM cybernetics (S1-S5) | Flat agent loop (most), multi-agent (OpenHands) |
| Multi-source research | ${healthyEngines.length} search engines | Usually single web search |
| Sub-agents | Parallel personas (scout/oracle/kraken/researcher) | OpenHands: multi-agent; SWE-agent: single ACI |
| Workflow system | Structured phases with gates | Ad-hoc (most), Plan/Act modes (Cline) |
| TUI | Rich Textual UI via WebSocket | CLI-only (Aider, OpenCode) or web UI (OpenHands) |
| Vibe mode | Guided non-programmer mode | Developer-only (all competitors) |
| Git integration | Built-in | Aider: git-native; Others: manual |

---

## Improvements Applied (v2)

- ✓ GitHub results include star counts, sorted by popularity
- ✓ DuckDuckGo rate-limit mitigation (2.5s delays, 3 retries with backoff)
- ✓ arXiv category filters (cs.SE, cs.AI, cs.CL, cs.LG, cs.MA, cs.PL)
- ✓ arXiv relevance filter (2+ keyword matches required)
- ✓ Curated seed queries for known major projects
- ✓ Result quality scoring (keyword density, recency, authority, corroboration)
- ✓ Cross-source corroboration boosting
- ✓ Fallback engine chain (DDG → SearXNG → Wikipedia)
- ✓ GitHub minimum star filter (>= 10)
- ✓ Hugging Face model search
- ✓ SearXNG as DDG fallback (when configured)

---

## Gaps / Uncertainties

- GitHub rate limits may suppress some repos (unauthenticated: 10 req/min)
- DuckDuckGo may CAPTCHA on heavy use despite mitigations
- SearXNG not tested (requires self-hosted instance via LOCALCODE_SEARXNG_URL)
- Hugging Face search is model-only (datasets API not integrated)
- Star counts reflect current state, not historical trajectory

---

## Raw Data

### Engine Health
${healthResults.map(h => `- ${h.engine}: ${h.ok ? 'healthy' : 'UNREACHABLE'}`).join('\n')}

### Top 20 Results by Score
${deduped.slice(0, 20).map((r, i) => `${i + 1}. [${r.source}] ${r.title} — score: ${r.score}${r.metadata?.stars ? ` (${r.metadata.stars.toLocaleString()}★)` : ''}`).join('\n')}
`

const reportPath = join(reportDir, `${date}-local-ai-coding-agents.md`)
writeFileSync(reportPath, report)
log(`  Report written: ${reportPath}`)

// Print inline summary
log('')
log('═══ Inline Summary ═══')
log(`GitHub projects found: ${githubResults.length}`)
log(`Web results: ${ddgResults.length}`)
log(`Academic papers: ${arxivResults.length}`)
log(`HuggingFace models: ${hfResults.length}`)
log(`Wikipedia articles: ${wikiResults.length}`)
log('')

if (githubResults.length > 0) {
  log('Top GitHub repos by stars:')
  for (const r of githubResults.slice(0, 15)) {
    const stars = r.metadata?.stars ?? 0
    log(`  ${stars >= 1000 ? '★' : '☆'} ${r.title} — ${stars.toLocaleString()}★ — ${r.snippet.slice(0, 70)}`)
  }
}

if (hfResults.length > 0) {
  log('')
  log('Top HuggingFace models:')
  for (const r of hfResults.slice(0, 5)) {
    log(`  🤗 ${r.title} — ${r.snippet.slice(0, 80)}`)
  }
}

log('')
log(`Full report: ${reportPath}`)
log('═══ Done ═══')
