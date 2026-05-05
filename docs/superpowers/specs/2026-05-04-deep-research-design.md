# Deep Research Engine Design

**Date:** 2026-05-04
**Inspiration:** [local-deep-research](https://github.com/LearningCircuit/local-deep-research) (MIT, LearningCircuit)
**Approach:** Native TypeScript reimplementation of concepts — no code ported, no licensing obligations

## Overview

Add iterative deep research capabilities to CynCo: multi-source search, evidence aggregation, knowledge synthesis with citations. Research operates both standalone (user asks a research question) and as a feed-into-coding pipeline (vibe loop auto-triggers research before building).

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│  Research Workflow (engine/workflows/definitions/research.ts)     │
│                                                                   │
│  SCOPE → DECOMPOSE → GATHER → SYNTHESIZE → REPORT → INDEX       │
│                         │            │                            │
│                         └────────────┘ (iterate if gaps, max 3x) │
└────────────────────────┬──────────────────────────────────────────┘
                         │ spawns
                         ▼
┌─────────────────────────────────────────────────┐
│  Researcher Sub-Agents (persona: 'researcher')   │
│  Trust: specialist | Budget: 25 iter, 16K tokens │
│  Tools: WebSearch, WebFetch, Read, Glob, Grep    │
│                                                   │
│  S2 Coordinator manages concurrency/GPU          │
└────────────────────────┬─────────────────────────┘
                         │ calls
                         ▼
┌─────────────────────────────────────────────────┐
│  Search Engine Layer (engine/research/engines/)   │
│                                                   │
│  DuckDuckGo | SearXNG | arXiv | Wikipedia        │
│  GitHub     | PubMed  | (extensible)             │
│                                                   │
│  Engine Router: LLM/heuristic query→engine map   │
└──────────────────────────────────────────────────┘
```

## 1. Search Engine Layer

### New directory: `engine/research/`

```
engine/research/
├── types.ts              # SearchResult, SearchEngine interface
├── engineRouter.ts       # Query → engine routing
└── engines/
    ├── registry.ts       # Engine registration + health checking
    ├── duckduckgo.ts     # Existing logic extracted
    ├── searxng.ts        # HTTP to self-hosted SearXNG
    ├── arxiv.ts          # arXiv API (Atom feed)
    ├── wikipedia.ts      # Wikipedia REST API
    ├── github.ts         # GitHub search via gh CLI or API
    └── pubmed.ts         # PubMed E-utilities API
```

### Core interface

```typescript
interface SearchResult {
  title: string
  url: string
  snippet: string
  source: string           // engine name
  relevance?: number       // 0-1
  metadata?: {
    authors?: string[]
    date?: string
    doi?: string
    repo?: string
  }
}

interface SearchEngine {
  name: string
  description: string
  domains: string[]        // e.g., ['academic', 'physics', 'cs'] for routing
  search(query: string, maxResults?: number): Promise<SearchResult[]>
  healthCheck(): Promise<boolean>
}
```

### Engine details

| Engine | API | Key Required | Domains |
|--------|-----|--------------|---------|
| DuckDuckGo | HTML scraping | No | general, web |
| SearXNG | HTTP REST | No (self-hosted) | general, web, meta |
| arXiv | Atom API | No | academic, cs, physics, math |
| Wikipedia | REST API | No | reference, general |
| GitHub | gh CLI / REST | No (public) | code, repos, technical |
| PubMed | E-utilities | No | academic, biomedical, health |

### Engine router

```typescript
// engine/research/engineRouter.ts
function routeQuery(query: string, engines: SearchEngine[]): SearchEngine[]
```

Selects engines by matching query keywords/domain against `engine.domains`. Falls back to DuckDuckGo if no domain match. Returns ranked list.

### Health-based fallback

Engines that fail `healthCheck()` (e.g., SearXNG not running) are silently excluded. The router always has DuckDuckGo as a baseline.

### Configuration

```
LOCALCODE_SEARXNG_URL=http://localhost:8080   # Optional, enables SearXNG
```

No other config required — all other engines are public APIs.

## 2. Research Workflow

### Definition: `engine/workflows/definitions/research.ts`

```typescript
const researchWorkflow: WorkflowDefinition = {
  name: 'research',
  displayName: 'Deep Research',
  description: 'Iterative multi-source research with synthesis and citations',
  initialPhase: 'scope',
  phases: {
    scope: { ... },
    decompose: { ... },
    gather: { ... },
    synthesize: { ... },
    report: { ... },
    index: { ... },
  }
}
```

### Phase details

#### `scope`
- **Purpose:** Understand research goal, clarify boundaries, check if prior research exists in index
- **Instruction:** "Understand what the user wants to research. Check the code index for existing research on this topic. Clarify scope if ambiguous. State the research question clearly."
- **Allowed tools:** Read, Glob, Grep, CodeIndex, WebSearch
- **Gate:** `model_done`
- **Transitions:** `decompose`

#### `decompose`
- **Purpose:** Break question into 3-7 sub-queries, assign preferred engines to each
- **Instruction:** "Decompose the research question into 3-7 specific sub-queries. For each, suggest which search engines are most appropriate (arxiv for papers, wikipedia for background, github for implementations, etc.). Output as a numbered list."
- **Allowed tools:** — (LLM reasoning only)
- **Gate:** `model_done`
- **Transitions:** `gather`

#### `gather`
- **Purpose:** Spawn researcher agents per sub-query, collect evidence
- **Instruction:** "For each sub-query, spawn a researcher agent with the sub-query as its task and preferred engines noted. Use non-blocking agents for parallel execution. Collect all results."
- **Allowed tools:** SubAgent, CollectAgent, WebSearch, WebFetch, Read
- **Gate:** `model_done`
- **Transitions:** `synthesize`

#### `synthesize`
- **Purpose:** Aggregate findings, identify gaps, assess confidence
- **Instruction:** "Analyze all gathered evidence. Identify: (1) corroborating findings across sources, (2) contradictions, (3) gaps where information is missing. If critical gaps exist and iteration count < 3, generate follow-up queries and return to gather. Otherwise, proceed to report."
- **Allowed tools:** Read, Glob, Grep
- **Gate:** `model_done`
- **Transitions:** `gather` (if gaps, max 3 iterations), `report`

#### `report`
- **Purpose:** Generate inline summary + full report file
- **Instruction:** "Produce two outputs: (1) An inline summary for the conversation (max 500 tokens) with key findings, citations, gaps, and recommendation. (2) A full markdown report saved to .cynco/research/YYYY-MM-DD-<topic>.md with all findings, sources, and future research directions."
- **Allowed tools:** Write, Read
- **Gate:** `model_done`
- **Transitions:** `index`, `done`

#### `index`
- **Purpose:** Embed research findings into vector store
- **Instruction:** "Index the research report into the project's vector store so future queries can find these findings alongside code."
- **Allowed tools:** CodeIndex
- **Gate:** `model_done`
- **Transitions:** `done`

### Iteration tracking

Workflow metadata tracks iteration count:
```typescript
metadata: {
  iterations: 0,        // incremented on synthesize→gather loop
  maxIterations: 3,
  subQueries: [],       // from decompose phase
  gatherResults: [],    // from gather phase
}
```

## 3. Researcher Agent

### Persona addition (`engine/agents/prism.ts`)

```typescript
researcher: {
  role: 'research analyst',
  focus: 'multi-source information gathering, evidence evaluation, and synthesis with citations'
}
```

### Type update (`engine/agents/types.ts`)

```typescript
type AgentPersona = 'scout' | 'oracle' | 'kraken' | 'spark' | 'architect' | 'researcher'
```

### Trust tier: `specialist`

- **Allowed tools:** WebSearch, WebFetch, Read, Glob, Grep, CodeIndex
- **Max iterations:** 25
- **Max token budget:** 16384

### Vocabulary (`engine/agents/vocabulary.ts`)

```typescript
researcher: {
  agentType: 'researcher',
  clusters: [
    {
      name: 'source evaluation',
      terms: ['primary source', 'secondary source', 'peer-reviewed', 'preprint',
              'citation', 'credibility', 'methodology', 'sample size', 'replication']
    },
    {
      name: 'synthesis',
      terms: ['corroboration', 'contradiction', 'gap', 'consensus', 'dissent',
              'meta-analysis', 'weight of evidence', 'systematic review']
    },
    {
      name: 'academic',
      terms: ['arXiv', 'PubMed', 'DOI', 'abstract', 'related work',
              'prior art', 'state of the art', 'literature review', 'methodology']
    }
  ]
}
```

### Agent behavior

Each researcher agent receives a task like:
```
Research: "What are the best practices for WebSocket connection pooling in Bun?"
Preferred engines: github, duckduckgo
Return: Findings with source URLs, key quotes, and relevance assessment (1-5).
Format each finding as: [FINDING] ... [SOURCE: title](url) [RELEVANCE: N/5]
```

The agent:
1. Calls `WebSearch` with `engine` param set to preferred engines
2. Reads promising results via `WebFetch`
3. Evaluates source quality (recency, authorship, peer review status)
4. Returns structured findings

## 4. Search Engine Tool Extension

### Updated `WebSearch` tool (`engine/tools/impl/webSearch.ts`)

```typescript
{
  name: 'WebSearch',
  description: 'Search the web using multiple search engines. Returns results with titles, URLs, and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num_results: { type: 'number', default: 5, minimum: 1, maximum: 10 },
      engine: {
        type: 'string',
        enum: ['auto', 'duckduckgo', 'searxng', 'arxiv', 'wikipedia', 'github', 'pubmed'],
        default: 'auto',
        description: 'Search engine to use. "auto" routes based on query domain.'
      }
    },
    required: ['query']
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const engine = input.engine || 'auto'
    if (engine === 'auto') {
      const engines = routeQuery(input.query, getHealthyEngines())
      // Search top 2 engines, merge and deduplicate results
    } else {
      const eng = getEngine(engine)
      if (!eng || !(await eng.healthCheck())) {
        // Fallback to DuckDuckGo
      }
    }
  }
}
```

### Backward compatibility

- Default `engine: 'auto'` preserves existing behavior (DuckDuckGo is always available)
- Existing callers pass no `engine` param → works exactly as before
- No breaking changes to tool interface

## 5. Vector Store Integration

### New chunk type

```typescript
// engine/index/types.ts
type ChunkType = 'function' | 'class' | 'module' | 'import_block' | 'research'
```

### Research chunker

```typescript
// engine/index/researchChunker.ts
function chunkResearchReport(filePath: string, content: string): Chunk[]
```

Splits markdown report by `##` and `###` headings. Each section becomes a chunk with:
- `chunkType: 'research'`
- `name`: heading text (e.g., "React Server Components - Data Fetching Patterns")
- `content`: section body including citations

### Indexing in the `index` phase

```typescript
// Called by the workflow's index phase
async function indexResearchReport(reportPath: string, store: IndexStore, embedClient: EmbedClient): Promise<void> {
  const content = await readFile(reportPath, 'utf-8')
  const chunks = chunkResearchReport(reportPath, content)
  for (const chunk of chunks) {
    const embedding = await embedClient.embed(chunk.content)
    store.insertChunk(chunk, embedding)
  }
}
```

### Unified retrieval

Existing `CodeIndex` tool queries the same store — research findings appear alongside code results. The `chunkType` field allows filtering if needed:
- `CodeIndex` with no filter → returns both code and research
- Future: optional `type` param on CodeIndex to filter

### Storage location

Research reports saved to `.cynco/research/`:
```
.cynco/research/
├── 2026-05-04-websocket-pooling-bun.md
├── 2026-05-04-react-server-components.md
└── ...
```

## 6. Vibe Loop Integration

### Research-awareness in UNDERSTAND phase

```typescript
// engine/vibe/controller.ts — new method
private async shouldResearch(description: string): Promise<boolean> {
  // sideQuery to LLM:
  // "Given this task description and the existing project, does this require
  //  external research (unfamiliar APIs, libraries, patterns, best practices)
  //  before implementation? Answer YES or NO."
  //
  // Also checks vector store: if relevant research chunks already exist
  // with score > 0.8, skip research.
}
```

### Modified flow in `VibeController.start()`

```typescript
async start(mode: VibeMode, description?: string): Promise<void> {
  // ... existing project scan ...

  if (description && await this.shouldResearch(description)) {
    // Trigger research workflow inline
    await this.runResearchPhase(description)
    // Research findings now in vector store + available as context
  }

  // ... continue with normal Q&A flow ...
  // generateQuestion() now has research context available via index
}
```

### Research context in questions

`generateQuestion()` already queries the project index. Since research findings are now in the same index, the vibe loop's questions become research-informed automatically — no additional wiring needed.

### Confidence dimension

Add `research` to the confidence scoring:
```typescript
// engine/vibe/confidence.ts
interface ConfidenceDimensions {
  purpose: number
  mechanics: number
  integration: number
  ambiguity: number
  research: number    // NEW: how well-informed is the plan about external patterns/APIs?
}
```

## 7. Report Output

### Inline summary (conversation)

```markdown
## Research: [Topic]

**Key Findings:**
1. [Finding] — [Source](url)
2. [Finding] — [Source](url)
3. [Finding] — [Source](url)

**Gaps/Uncertainties:**
- [What wasn't found or remains unclear]

**Recommendation:**
[How this applies to the current task]

---
Full report: `.cynco/research/YYYY-MM-DD-<topic>.md`
```

Max ~500 tokens. Concise, actionable, cited.

### Full report file

```markdown
# Research: [Topic]
Date: YYYY-MM-DD
Query: [Original question]
Engines: [engines used]
Iterations: [N]
Duration: [time]

## Summary
[2-3 paragraph synthesis]

## Findings

### [Sub-query 1]
- [Finding] — Source: [title](url)
- [Finding] — Source: [title](url)

### [Sub-query 2]
- ...

## Sources
1. [Title](url) — [engine], accessed YYYY-MM-DD
2. [Title](url) — [engine], accessed YYYY-MM-DD

## Gaps & Future Research
- [Topics to investigate further]
- [Contradictions requiring resolution]
```

## File Changes Summary

### New files
```
engine/research/
├── types.ts
├── engineRouter.ts
├── indexer.ts              # indexResearchReport()
└── engines/
    ├── registry.ts
    ├── duckduckgo.ts       # extracted from existing webSearch.ts
    ├── searxng.ts
    ├── arxiv.ts
    ├── wikipedia.ts
    ├── github.ts
    └── pubmed.ts

engine/workflows/definitions/research.ts
engine/index/researchChunker.ts
```

### Modified files
```
engine/agents/types.ts          # Add 'researcher' to AgentPersona
engine/agents/prism.ts          # Add researcher persona config
engine/agents/vocabulary.ts     # Add researcher vocabulary clusters
engine/tools/impl/webSearch.ts  # Add engine param, use engine layer
engine/tools/registry.ts        # (no change if WebSearch stays same name)
engine/index/types.ts           # Add 'research' to ChunkType
engine/vibe/controller.ts       # Add shouldResearch() + research trigger
engine/vibe/confidence.ts       # Add 'research' dimension (if file exists)
engine/workflows/index.ts       # Register research workflow
```

## Non-Goals (v1)

- No web UI for research (TUI shows inline results)
- No encrypted database (CynCo doesn't have this pattern)
- No journal quality scoring (LDR's OpenAlex integration — too complex for v1)
- No research scheduling/cron
- No multi-user isolation
- No PDF export (markdown is sufficient)

## Dependencies

- No new runtime dependencies (all engines use fetch/HTTP)
- Optional: SearXNG Docker container for meta-search
- Existing: Ollama for embeddings (already required)

## Licensing

This is a clean-room TypeScript implementation inspired by local-deep-research's architecture and concepts. No code is ported or adapted from LDR. The MIT license of LDR is noted for attribution of architectural inspiration only. No licensing obligations apply.
