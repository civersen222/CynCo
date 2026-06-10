#!/usr/bin/env bun
/**
 * E2E research: How does CynCo's architecture compare to competitors?
 * Focus on VSM governance vs standard agent loops, feature depth, uniqueness.
 *
 * Usage:  bun engine/__tests__/research/e2e-architecture-compare.ts
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

const TOPIC = 'CynCo architecture vs AI coding agent competitors'

const ALL_QUERIES = [
  // How do other agents handle governance/safety?
  { query: 'AI coding agent governance safety feedback loop self-correction', engines: ['duckduckgo'] },
  { query: 'harness engineering AI coding agent constraints 2026', engines: ['duckduckgo'] },
  { query: 'viable system model software agent cybernetics', engines: ['arxiv', 'duckduckgo'] },
  { query: 'autonomous agent self-governance feedback control loop', engines: ['arxiv'] },

  // Architecture patterns in competitors
  { query: 'aider architecture git integration multi-file editing how it works', engines: ['duckduckgo'] },
  { query: 'opencode terminal coding agent architecture LSP session', engines: ['duckduckgo'] },
  { query: 'cline plan act mode architecture how it works', engines: ['duckduckgo'] },
  { query: 'goose AI agent MCP architecture extensible', engines: ['duckduckgo', 'github'] },
  { query: 'openhands event stream architecture sandbox Docker multi-agent', engines: ['duckduckgo'] },

  // Unique CynCo features — what else exists?
  { query: 'AI coding assistant non-programmer guided mode vibe coding', engines: ['duckduckgo'] },
  { query: 'local AI agent sub-agent personas parallel execution', engines: ['duckduckgo', 'github'] },
  { query: 'AI agent context window compression management strategy', engines: ['duckduckgo', 'arxiv'] },
  { query: 'AI coding agent cross-session memory learning persistence', engines: ['duckduckgo'] },
  { query: 'cybernetics Stafford Beer software engineering agent', engines: ['arxiv', 'duckduckgo'] },
]

// ─── Engine Setup ─────────────────────────────────────────────

const allEngines: SearchEngine[] = [
  new DuckDuckGoEngine(),
  new WikipediaEngine(),
  new ArXivEngine(),
  new GitHubEngine({ minStars: 10 }),
  new HuggingFaceEngine(),
]

const engineMap = new Map(allEngines.map(e => [e.name, e]))

function timestamp(): string { return new Date().toISOString().slice(11, 19) }
function log(msg: string): void { console.log(`[${timestamp()}] ${msg}`) }

// ─── Phase 1: Health Check ────────────────────────────────────

log('═══ CynCo Research: Architecture Comparison ═══')
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
log('')

// ─── Phase 2: Gather ─────────────────────────────────────────

log(`Phase 2: Gather — ${ALL_QUERIES.length} queries`)
const allResults: SearchResult[] = []
let totalRaw = 0

for (const sq of ALL_QUERIES) {
  log(`  "${sq.query.slice(0, 60)}"`)
  for (const engineName of sq.engines) {
    const engine = engineMap.get(engineName)
    if (!engine || !healthyEngines.includes(engineName)) continue

    const results = await searchWithFallback(sq.query, engine, allEngines, 5)
      .catch(() => [] as SearchResult[])
    log(`    ${engine.name}: ${results.length} results`)
    allResults.push(...results)
    totalRaw += results.length
  }
}
log(`  Total raw: ${totalRaw}`)
log('')

// ─── Phase 3: Score + Deduplicate ────────────────────────────

log('Phase 3: Score and deduplicate')
const scored = scoreResults(allResults, TOPIC)
const deduped = deduplicateResults(scored)
log(`  ${totalRaw} raw → ${deduped.length} unique`)

const bySource = new Map<string, SearchResult[]>()
for (const r of deduped) {
  const list = bySource.get(r.source) ?? []
  list.push(r)
  bySource.set(r.source, list)
}
for (const [source, results] of bySource) {
  log(`  ${source}: ${results.length}`)
}
log('')

// ─── Phase 4: Report ─────────────────────────────────────────

log('Phase 4: Report')

const date = new Date().toISOString().slice(0, 10)
const reportDir = join(process.cwd(), '.cynco', 'research')
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true })

const topResults = deduped.slice(0, 40)

const report = `# Research: CynCo Architecture vs AI Coding Agent Competitors

**Date:** ${date}
**Engines:** ${healthyEngines.join(', ')}
**Queries:** ${ALL_QUERIES.length}
**Results:** ${deduped.length} unique (${totalRaw} raw)

---

## Top Results by Relevance Score

${topResults.map((r, i) => `${i + 1}. **${r.title || '(no title)'}** (score: ${r.score}, source: ${r.source})
   ${r.url}
   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? '...' : ''}
`).join('\n')}

---

## Results by Category

### Governance & Safety Controls
${deduped.filter(r => /govern|safety|harness|feedback|control|guard/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

### Agent Architecture Patterns
${deduped.filter(r => /architect|event.stream|sandbox|plan.act|git.integrat/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

### Cybernetics / VSM in Software
${deduped.filter(r => /cybernetic|viable.system|beer|ashby|homeosta|autopoie/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

### Non-Programmer / Guided Modes
${deduped.filter(r => /non.program|guided|vibe|beginner|wizard|no.code/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

### Context Management & Memory
${deduped.filter(r => /context.window|compress|memory|session|persist|cross.session/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

### Sub-Agent / Multi-Agent Systems
${deduped.filter(r => /sub.agent|multi.agent|parallel|persona|delegat|orchestrat/i.test(r.title + r.snippet)).slice(0, 10).map((r, i) =>
  `${i + 1}. [${r.title}](${r.url}) — ${r.snippet.slice(0, 150)}`
).join('\n') || '*None found*'}

---

## Raw Engine Health
${healthResults.map(h => `- ${h.engine}: ${h.ok ? 'healthy' : 'UNREACHABLE'}`).join('\n')}
`

const reportPath = join(reportDir, `${date}-architecture-comparison.md`)
writeFileSync(reportPath, report)
log(`  Written: ${reportPath}`)

// Summary
log('')
log('═══ Summary ═══')
log(`Total unique results: ${deduped.length}`)
const categories = {
  'Governance/Safety': deduped.filter(r => /govern|safety|harness|feedback|control|guard/i.test(r.title + r.snippet)).length,
  'Architecture': deduped.filter(r => /architect|event.stream|sandbox|plan.act|git.integrat/i.test(r.title + r.snippet)).length,
  'Cybernetics/VSM': deduped.filter(r => /cybernetic|viable.system|beer|ashby|homeosta|autopoie/i.test(r.title + r.snippet)).length,
  'Non-Programmer': deduped.filter(r => /non.program|guided|vibe|beginner|wizard|no.code/i.test(r.title + r.snippet)).length,
  'Context/Memory': deduped.filter(r => /context.window|compress|memory|session|persist|cross.session/i.test(r.title + r.snippet)).length,
  'Multi-Agent': deduped.filter(r => /sub.agent|multi.agent|parallel|persona|delegat|orchestrat/i.test(r.title + r.snippet)).length,
}
for (const [cat, count] of Object.entries(categories)) {
  log(`  ${cat}: ${count} results`)
}
log('')
log(`Full report: ${reportPath}`)
log('═══ Done ═══')
