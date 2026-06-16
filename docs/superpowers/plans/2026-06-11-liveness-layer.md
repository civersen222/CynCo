# Liveness Layer + MFL Agent PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CynCo a persistent agent: an always-on slim daemon (scheduler + mission ledger + ntfy phone channel) that wakes the existing engine for one-shot tasks — proven by an MFL fantasy-football recommendation agent.

**Architecture:** A new `engine/daemon/` package holds a model-free sentinel process (scheduler, mission ledger, ntfy channel, task runner). When a trigger fires (and a cheap MFL-delta pre-check passes), it spawns `bun engine/main.ts --run-task <file>` — a new one-shot mode that boots the existing provider stack, runs a bounded tool loop, writes a structured outcome file, stops llama-server, and exits. Recommendations are pushed to the phone via self-hosted ntfy (Tailscale-only) with approve/reject buttons that feed a per-action-type trust ladder.

**Tech Stack:** TypeScript (Bun runtime, Node-compatible), vitest (`npx vitest run` — NEVER `bun test`, it segfaults), no new npm dependencies (JSON config, hand-rolled SSE client, node `child_process`).

**Spec:** `docs/superpowers/specs/2026-06-11-liveness-layer-design.md`

## Repo rules (read before any task)

- Run tests with `npx vitest run <path>` from the repo root. NEVER `bun test`.
- NEVER run git with cwd inside `engine/` (embedded divergent git repo). Always run git from repo root.
- A live CynCo session may be modifying `engine/` files concurrently. If `git status` shows modified engine files you did not touch, leave them alone — commit ONLY the files your task created/modified, by explicit path.
- Known pre-existing vitest failures (do NOT count as new): bun:sqlite-under-vitest family (governanceDb, predictionDb, executor, registry, approvalGate, conversationLoop, research/vibeIntegration), treeSitterChunker, profiles/loader, config.test, callModel 'passes system prompt to the provider', configHandlers 'validates correct YAML', glob 'finds files by pattern', bridge/server port contention in parallel runs.
- Imports use `.js` extensions (`import { foo } from './bar.js'`).
- Commit messages: conventional prefix (`feat:`, `fix:`, `docs:`, `test:`), 1-2 sentences, plus `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

## File structure

```
engine/daemon/
├── types.ts          # Shared types: TriggerSpec, MissionConfig, TaskFileInput, TaskOutcome, Recommendation, MissionState, RunRecord
├── taskFile.ts       # Task-file + outcome-file JSON contract (read/write/validate)
├── missionLedger.ts  # Mission dir: mission.json (config), state.json, runs.jsonl, trust ladder, pending approvals
├── scheduler.ts      # Pure trigger math: computeNextFire, evaluate (fire/skip/wait + missed-run policy)
├── ntfyChannel.ts    # Publish JSON notifications w/ action buttons; SSE subscribe to command topic; offline queue
├── oneShot.ts        # One-shot engine mode: bounded model+tool loop, outcome extraction (used by main.ts --run-task)
├── taskRunner.ts     # GPU guard + spawn one-shot engine process + timeout kill + outcome collection
└── main.ts           # Daemon entrypoint: wire missions × scheduler × ntfy × runner; MFL delta pre-check; approvals

engine/tools/impl/mfl.ts        # Read-only MFL API tool (registered in engine/tools/registry.ts)
engine/main.ts                  # + --run-task branch (after provider setup, before WS server)
docs/liveness-setup.md          # ntfy + Tailscale + Windows Task Scheduler + mission.json setup guide
engine/__tests__/daemon/*.test.ts, engine/__tests__/tools/mfl.test.ts
```

Module boundaries: `scheduler.ts` is pure functions (no I/O). `missionLedger.ts` owns all mission-dir I/O. `ntfyChannel.ts` owns all ntfy HTTP. `taskRunner.ts` owns process spawning. `daemon/main.ts` only wires them. `oneShot.ts` runs inside the *engine* process, not the daemon — it shares only `types.ts`/`taskFile.ts` with the daemon.

---

### Task 1: Shared types + task-file contract

**Files:**
- Create: `engine/daemon/types.ts`
- Create: `engine/daemon/taskFile.ts`
- Test: `engine/__tests__/daemon/taskFile.test.ts`

- [ ] **Step 1: Write `engine/daemon/types.ts`** (types only, no test needed)

```typescript
// engine/daemon/types.ts
// Shared types for the liveness layer. The daemon (engine/daemon/main.ts) and the
// one-shot engine mode (oneShot.ts) communicate ONLY via these contracts.

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface TriggerSpec {
  id: string
  /** interval: fire every `everyMinutes`. daily: fire at `at` (HH:MM local). weekly: fire on `day` at `at`. */
  kind: 'interval' | 'daily' | 'weekly'
  everyMinutes?: number
  at?: string
  day?: Weekday
  /** 'mfl-delta': skip the engine run if MFL transactions haven't changed. 'none': always run. */
  precheck: 'mfl-delta' | 'none'
  /** What to do when the daemon was down at fire time. */
  missedPolicy: 'skip' | 'run-once-on-startup'
  /** Task prompt for the engine run. */
  prompt: string
}

export interface MflLeagueRef {
  leagueId: string
  year: number
  /** Your franchise id within the league, e.g. '0005'. */
  franchiseId: string
}

export interface MissionConfig {
  id: string
  goal: string
  leagues: MflLeagueRef[]
  triggers: TriggerSpec[]
  /** Per action-type trust ladder. mode stays 'ask' in Phase B; 'auto' is Phase C. */
  trustLadder: Record<string, { mode: 'ask' | 'auto'; promoteAt: number }>
}

export interface Recommendation {
  id: string
  /** e.g. 'waiver' | 'trade' | 'lineup' | 'info' — must match a trustLadder key (or 'info'). */
  actionType: string
  summary: string
  detail: string
  deepLink?: string
}

export interface TaskFileInput {
  missionId: string
  triggerId: string
  prompt: string
  /** Mission goal + league refs + recent run summaries, prepended to the prompt. */
  context: string
  /** Tool names the one-shot run may use, e.g. ['Mfl', 'WebSearch', 'WebFetch', 'Read']. */
  allowedTools: string[]
  timeoutMs: number
  /** Where the engine writes the TaskOutcome JSON. */
  outcomePath: string
}

export interface TaskOutcome {
  ok: boolean
  summary: string
  recommendations: Recommendation[]
  error?: string
}

export interface RunRecord {
  ts: string
  triggerId: string
  ok: boolean
  summary: string
  recommendationIds: string[]
}

export interface PendingApproval {
  rec: Recommendation
  createdAt: string
}

export interface TrustState {
  mode: 'ask' | 'auto'
  approvedStreak: number
}

export interface MissionState {
  /** Per-league hash of last-seen MFL transactions (delta pre-check). Key = leagueId. */
  lastSeen: Record<string, string>
  /** triggerId → ISO timestamp of next fire. */
  nextFire: Record<string, string>
  /** recId → pending approval. */
  pending: Record<string, PendingApproval>
  /** actionType → trust state. */
  trust: Record<string, TrustState>
  failureStreak: number
}

export interface CommandMessage {
  recId: string
  verdict: 'approve' | 'reject'
}
```

- [ ] **Step 2: Write the failing test for the task-file contract**

```typescript
// engine/__tests__/daemon/taskFile.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeTaskFile, readTaskFile, writeOutcome, readOutcome,
} from '../../daemon/taskFile.js'
import type { TaskFileInput, TaskOutcome } from '../../daemon/types.js'

const input: TaskFileInput = {
  missionId: 'mfl-dynasty',
  triggerId: 'daily-news',
  prompt: 'Review injury news',
  context: 'goal: win the league',
  allowedTools: ['Mfl', 'WebSearch'],
  timeoutMs: 900000,
  outcomePath: 'replaced-below',
}

describe('taskFile contract', () => {
  it('round-trips a task file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'task.json')
      writeTaskFile(p, { ...input, outcomePath: join(dir, 'out.json') })
      const back = readTaskFile(p)
      expect(back.missionId).toBe('mfl-dynasty')
      expect(back.allowedTools).toEqual(['Mfl', 'WebSearch'])
      expect(back.timeoutMs).toBe(900000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a task file missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'bad.json')
      require('fs').writeFileSync(p, JSON.stringify({ missionId: 'x' }), 'utf-8')
      expect(() => readTaskFile(p)).toThrow(/missing|invalid/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('round-trips an outcome file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'out.json')
      const outcome: TaskOutcome = {
        ok: true,
        summary: '2 waiver targets found',
        recommendations: [{ id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'because Y' }],
      }
      writeOutcome(p, outcome)
      const back = readOutcome(p)
      expect(back.ok).toBe(true)
      expect(back.recommendations[0].actionType).toBe('waiver')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('readOutcome returns a failure outcome when the file is absent', () => {
    const back = readOutcome(join(tmpdir(), 'cynco-definitely-missing', 'out.json'))
    expect(back.ok).toBe(false)
    expect(back.error).toMatch(/missing/i)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/taskFile.test.ts`
Expected: FAIL — cannot resolve `../../daemon/taskFile.js`

- [ ] **Step 4: Write `engine/daemon/taskFile.ts`**

```typescript
// engine/daemon/taskFile.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { TaskFileInput, TaskOutcome } from './types.js'

const REQUIRED_INPUT_FIELDS: (keyof TaskFileInput)[] = [
  'missionId', 'triggerId', 'prompt', 'context', 'allowedTools', 'timeoutMs', 'outcomePath',
]

export function writeTaskFile(path: string, input: TaskFileInput): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(input, null, 2), 'utf-8')
}

export function readTaskFile(path: string): TaskFileInput {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (raw[field] === undefined) throw new Error(`Task file missing required field: ${field}`)
  }
  if (!Array.isArray(raw.allowedTools)) throw new Error('Task file invalid: allowedTools must be an array')
  return raw as TaskFileInput
}

export function writeOutcome(path: string, outcome: TaskOutcome): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(outcome, null, 2), 'utf-8')
}

export function readOutcome(path: string): TaskOutcome {
  if (!existsSync(path)) {
    return { ok: false, summary: '', recommendations: [], error: `Outcome file missing: ${path}` }
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  return {
    ok: raw.ok === true,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
    ...(raw.error ? { error: String(raw.error) } : {}),
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/taskFile.test.ts`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add engine/daemon/types.ts engine/daemon/taskFile.ts engine/__tests__/daemon/taskFile.test.ts
git commit -m "feat: daemon shared types + task/outcome file contract

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: MFL tool (read-only)

**Files:**
- Create: `engine/tools/impl/mfl.ts`
- Modify: `engine/tools/registry.ts` (import + add to `ALL_TOOLS`)
- Test: `engine/__tests__/tools/mfl.test.ts`

MFL's export API: `https://api.myfantasyleague.com/{year}/export?TYPE={query}&L={leagueId}&JSON=1[&APIKEY={key}]`. Read-only is enforced by a query whitelist — the `import` endpoint (writes) must be impossible to reach through this tool.

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/tools/mfl.test.ts
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { mflTool, buildMflExportUrl } from '../../tools/impl/mfl.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('buildMflExportUrl', () => {
  it('builds an export URL with JSON=1', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026 })
    expect(url).toBe('https://api.myfantasyleague.com/2026/export?TYPE=rosters&L=12345&JSON=1')
  })

  it('appends APIKEY when provided', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026, apiKey: 'sekret' })
    expect(url).toContain('APIKEY=sekret')
  })

  it('appends extra params', () => {
    const url = buildMflExportUrl({ query: 'players', league: '12345', year: 2026, extra: { DETAILS: '1' } })
    expect(url).toContain('DETAILS=1')
  })
})

describe('Mfl tool', () => {
  it('rejects non-whitelisted queries (read-only guard)', async () => {
    const result = await mflTool.execute({ query: 'import', league: '12345' }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not allowed/i)
  })

  it('rejects the calendar injection of write types via casing', async () => {
    const result = await mflTool.execute({ query: 'IMPORT', league: '12345' }, {} as any)
    expect(result.isError).toBe(true)
  })

  it('fetches and returns JSON for a whitelisted query', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ rosters: { franchise: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fakeFetch)
    const result = await mflTool.execute({ query: 'rosters', league: '12345', year: 2026 }, {} as any)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('rosters')
    const calledUrl = (fakeFetch.mock.calls[0] as any[])[0] as string
    expect(calledUrl).toContain('TYPE=rosters')
    expect(calledUrl).toContain('L=12345')
  })

  it('redacts the API key from error output', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('connect failed for APIKEY=sekret') })
    vi.stubGlobal('fetch', fakeFetch)
    const result = await mflTool.execute({ query: 'rosters', league: '12345', year: 2026 }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain('sekret')
  })
})
```

Note: `ToolImpl.execute` in this codebase is called as `execute(input)` in some tools — check `engine/tools/types.ts` for the exact signature before writing the impl; the second arg above is defensive. Match whatever `webFetchTool.execute` uses (`engine/tools/impl/webFetch.ts:52` uses `async (input)`), and drop the second test arg if the signature is single-parameter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/tools/mfl.test.ts`
Expected: FAIL — cannot resolve `../../tools/impl/mfl.js`

- [ ] **Step 3: Write `engine/tools/impl/mfl.ts`**

```typescript
// engine/tools/impl/mfl.ts
// Read-only MyFantasyLeague API tool. Write endpoints (TYPE=import) are
// deliberately unreachable — Phase C will add them behind S5 approval gates.
import type { ToolImpl } from '../types.js'

const ALLOWED_QUERIES = new Set([
  'league',          // league settings, franchises, deep links
  'rosters',         // all franchise rosters
  'players',         // player id → name/team/pos database
  'playerScores',    // weekly/season scores
  'transactions',    // waivers, trades, drops league-wide
  'leagueStandings', // standings
  'injuries',        // official injury report
  'pendingTrades',   // trades awaiting action
  'freeAgents',      // available players
  'futureDraftPicks',// dynasty draft pick ownership
  'assets',          // all tradeable assets per franchise
])

export function buildMflExportUrl(opts: {
  query: string
  league: string
  year: number
  apiKey?: string
  extra?: Record<string, string>
}): string {
  const params = new URLSearchParams({ TYPE: opts.query, L: opts.league, JSON: '1' })
  for (const [k, v] of Object.entries(opts.extra ?? {})) params.set(k, v)
  if (opts.apiKey) params.set('APIKEY', opts.apiKey)
  // URLSearchParams encodes; MFL accepts encoded params fine
  return `https://api.myfantasyleague.com/${opts.year}/export?${params.toString()}`
}

export function loadMflApiKey(): string | undefined {
  try {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')
    const p = path.join(os.homedir(), '.cynco', 'credentials', 'mfl.json')
    if (!fs.existsSync(p)) return undefined
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined
  } catch {
    return undefined
  }
}

function redact(text: string, secret?: string): string {
  return secret ? text.split(secret).join('***') : text
}

export const mflTool: ToolImpl = {
  name: 'Mfl',
  description:
    'Query the MyFantasyLeague (MFL) fantasy football API (read-only). ' +
    `Queries: ${[...ALLOWED_QUERIES].join(', ')}. ` +
    'Returns raw JSON. Use extra params like {"W": "3"} for week or {"FRANCHISE": "0005"} to filter.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'MFL export TYPE (e.g. rosters, transactions, injuries)' },
      league: { type: 'string', description: 'MFL league id' },
      year: { type: 'number', description: 'League year (default: current year)' },
      extra: { type: 'object', description: 'Extra query params, e.g. {"W": "3", "FRANCHISE": "0005"}' },
    },
    required: ['query', 'league'],
  },
  tier: 'auto',
  execute: async (input) => {
    const query = String(input.query ?? '')
    if (!ALLOWED_QUERIES.has(query)) {
      return {
        output: `Error: MFL query "${query}" is not allowed. Allowed (read-only): ${[...ALLOWED_QUERIES].join(', ')}`,
        isError: true,
      }
    }
    const league = String(input.league ?? '')
    const year = typeof input.year === 'number' ? input.year : new Date().getFullYear()
    const extra = (input.extra && typeof input.extra === 'object') ? input.extra as Record<string, string> : undefined
    const apiKey = loadMflApiKey()
    const url = buildMflExportUrl({ query, league, year, apiKey, extra })

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'CynCo/1.0' },
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return { output: redact(`MFL HTTP ${resp.status}: ${resp.statusText}`, apiKey), isError: true }
      let text = await resp.text()
      const maxLen = 50000
      if (text.length > maxLen) text = text.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`
      return { output: redact(text, apiKey), isError: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: redact(`MFL fetch error: ${msg}`, apiKey), isError: true }
    }
  },
}
```

- [ ] **Step 4: Register in `engine/tools/registry.ts`**

Add to the imports (after line 22, `replaceFunctionTool` import):

```typescript
import { mflTool } from './impl/mfl.js'
```

Add `mflTool` to the `ALL_TOOLS` array (engine/tools/registry.ts:30-36), e.g. after `replaceFunctionTool`:

```typescript
  spawnAgentTool, collectAgentTool, indexResearchTool, replaceFunctionTool, mflTool,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/tools/mfl.test.ts`
Expected: 8 passed

Also run the registry-adjacent suite to confirm no regression:
Run: `npx vitest run engine/__tests__/tools/`
Expected: only the known pre-existing failures (executor, registry bun:sqlite family), no NEW failures

- [ ] **Step 6: Commit**

```bash
git add engine/tools/impl/mfl.ts engine/tools/registry.ts engine/__tests__/tools/mfl.test.ts
git commit -m "feat: read-only MFL fantasy football API tool

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Mission ledger

**Files:**
- Create: `engine/daemon/missionLedger.ts`
- Test: `engine/__tests__/daemon/missionLedger.test.ts`

Owns all I/O under a mission directory: `mission.json` (config, read-only here), `state.json` (lastSeen, nextFire, pending, trust, failureStreak), `runs.jsonl` (append-only history).

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/daemon/missionLedger.test.ts
import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionLedger } from '../../daemon/missionLedger.js'
import type { MissionConfig, Recommendation } from '../../daemon/types.js'

const config: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Win the dynasty league',
  leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0005' }],
  triggers: [{
    id: 'daily-news', kind: 'daily', at: '08:00',
    precheck: 'none', missedPolicy: 'skip', prompt: 'Review news',
  }],
  trustLadder: { waiver: { mode: 'ask', promoteAt: 3 } },
}

const rec: Recommendation = { id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'why' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cynco-ml-'))
  writeFileSync(join(dir, 'mission.json'), JSON.stringify(config), 'utf-8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('MissionLedger', () => {
  it('loads config and creates default state', () => {
    const ml = MissionLedger.load(dir)
    expect(ml.config.id).toBe('mfl-dynasty')
    expect(ml.state.failureStreak).toBe(0)
    expect(ml.state.trust.waiver.approvedStreak).toBe(0)
  })

  it('persists state across reloads', () => {
    const ml = MissionLedger.load(dir)
    ml.setNextFire('daily-news', '2026-06-12T08:00:00.000Z')
    ml.setLastSeen('12345', 'hash-abc')
    ml.saveState()
    const ml2 = MissionLedger.load(dir)
    expect(ml2.state.nextFire['daily-news']).toBe('2026-06-12T08:00:00.000Z')
    expect(ml2.state.lastSeen['12345']).toBe('hash-abc')
  })

  it('appends run records and reads them back newest-last', () => {
    const ml = MissionLedger.load(dir)
    ml.recordRun({ ts: 't1', triggerId: 'daily-news', ok: true, summary: 'a', recommendationIds: [] })
    ml.recordRun({ ts: 't2', triggerId: 'daily-news', ok: false, summary: 'b', recommendationIds: [] })
    const runs = ml.recentRuns(5)
    expect(runs.length).toBe(2)
    expect(runs[1].ts).toBe('t2')
  })

  it('tracks pending approvals and resolves approve → streak++', () => {
    const ml = MissionLedger.load(dir)
    ml.addPending(rec)
    expect(ml.state.pending['rec-1']).toBeDefined()
    const res = ml.resolveApproval('rec-1', 'approve')
    expect(res?.rec.summary).toBe('Claim X')
    expect(ml.state.trust.waiver.approvedStreak).toBe(1)
    expect(ml.state.pending['rec-1']).toBeUndefined()
  })

  it('reject resets the streak', () => {
    const ml = MissionLedger.load(dir)
    ml.state.trust.waiver.approvedStreak = 2
    ml.addPending(rec)
    ml.resolveApproval('rec-1', 'reject')
    expect(ml.state.trust.waiver.approvedStreak).toBe(0)
  })

  it('flags promotion eligibility when streak reaches promoteAt', () => {
    const ml = MissionLedger.load(dir)
    ml.state.trust.waiver.approvedStreak = 2
    ml.addPending(rec)
    const res = ml.resolveApproval('rec-1', 'approve')
    expect(res?.promotionEligible).toBe(true)
    // Phase B: mode must NOT flip automatically
    expect(ml.state.trust.waiver.mode).toBe('ask')
  })

  it('resolveApproval returns null for unknown recId', () => {
    const ml = MissionLedger.load(dir)
    expect(ml.resolveApproval('nope', 'approve')).toBeNull()
  })

  it('unknown actionType (e.g. info) resolves without touching trust', () => {
    const ml = MissionLedger.load(dir)
    ml.addPending({ ...rec, id: 'rec-2', actionType: 'info' })
    const res = ml.resolveApproval('rec-2', 'approve')
    expect(res).not.toBeNull()
    expect(res?.promotionEligible).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/missionLedger.test.ts`
Expected: FAIL — cannot resolve `../../daemon/missionLedger.js`

- [ ] **Step 3: Write `engine/daemon/missionLedger.ts`**

```typescript
// engine/daemon/missionLedger.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type {
  MissionConfig, MissionState, Recommendation, RunRecord,
} from './types.js'

export interface ApprovalResolution {
  rec: Recommendation
  verdict: 'approve' | 'reject'
  promotionEligible: boolean
}

export class MissionLedger {
  readonly dir: string
  readonly config: MissionConfig
  state: MissionState

  private constructor(dir: string, config: MissionConfig, state: MissionState) {
    this.dir = dir
    this.config = config
    this.state = state
  }

  static load(dir: string): MissionLedger {
    const config = JSON.parse(readFileSync(join(dir, 'mission.json'), 'utf-8')) as MissionConfig
    const statePath = join(dir, 'state.json')
    let state: MissionState
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf-8')) as MissionState
    } else {
      state = { lastSeen: {}, nextFire: {}, pending: {}, trust: {}, failureStreak: 0 }
    }
    // Ensure every trustLadder action type has a state entry
    for (const [actionType, ladder] of Object.entries(config.trustLadder)) {
      if (!state.trust[actionType]) {
        state.trust[actionType] = { mode: ladder.mode, approvedStreak: 0 }
      }
    }
    return new MissionLedger(dir, config, state)
  }

  saveState(): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2), 'utf-8')
  }

  recordRun(run: RunRecord): void {
    appendFileSync(join(this.dir, 'runs.jsonl'), JSON.stringify(run) + '\n', 'utf-8')
  }

  recentRuns(n: number): RunRecord[] {
    const p = join(this.dir, 'runs.jsonl')
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim())
    return lines.slice(-n).map(l => JSON.parse(l) as RunRecord)
  }

  setNextFire(triggerId: string, iso: string): void {
    this.state.nextFire[triggerId] = iso
  }

  setLastSeen(leagueId: string, hash: string): void {
    this.state.lastSeen[leagueId] = hash
  }

  addPending(rec: Recommendation): void {
    this.state.pending[rec.id] = { rec, createdAt: new Date().toISOString() }
  }

  resolveApproval(recId: string, verdict: 'approve' | 'reject'): ApprovalResolution | null {
    const pending = this.state.pending[recId]
    if (!pending) return null
    delete this.state.pending[recId]

    const ladder = this.config.trustLadder[pending.rec.actionType]
    const trust = this.state.trust[pending.rec.actionType]
    let promotionEligible = false
    if (ladder && trust) {
      if (verdict === 'approve') {
        trust.approvedStreak += 1
        promotionEligible = trust.mode === 'ask' && trust.approvedStreak >= ladder.promoteAt
      } else {
        trust.approvedStreak = 0
      }
    }
    this.saveState()
    return { rec: pending.rec, verdict, promotionEligible }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/missionLedger.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/missionLedger.ts engine/__tests__/daemon/missionLedger.test.ts
git commit -m "feat: mission ledger — config, persisted state, run history, trust ladder

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Scheduler (pure trigger math)

**Files:**
- Create: `engine/daemon/scheduler.ts`
- Test: `engine/__tests__/daemon/scheduler.test.ts`

Pure functions only — all time passed in, no `Date.now()` calls inside. Local time (the daemon runs on the user's Windows box; lineup deadlines are local).

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/daemon/scheduler.test.ts
import { describe, expect, it } from 'bun:test'
import { computeNextFire, evaluateTrigger } from '../../daemon/scheduler.js'
import type { TriggerSpec } from '../../daemon/types.js'

const interval = (mins: number): TriggerSpec => ({
  id: 'i', kind: 'interval', everyMinutes: mins, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})
const daily = (at: string): TriggerSpec => ({
  id: 'd', kind: 'daily', at, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})
const weekly = (day: TriggerSpec['day'], at: string): TriggerSpec => ({
  id: 'w', kind: 'weekly', day, at, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})

describe('computeNextFire', () => {
  it('interval: from + everyMinutes', () => {
    const from = new Date(2026, 5, 11, 12, 0, 0) // Jun 11 2026 12:00 local
    expect(computeNextFire(interval(90), from).getTime()).toBe(from.getTime() + 90 * 60000)
  })

  it('daily: later today if at is still ahead', () => {
    const from = new Date(2026, 5, 11, 6, 0, 0)
    const next = computeNextFire(daily('08:00'), from)
    expect(next.getDate()).toBe(11)
    expect(next.getHours()).toBe(8)
  })

  it('daily: tomorrow if at already passed', () => {
    const from = new Date(2026, 5, 11, 9, 0, 0)
    const next = computeNextFire(daily('08:00'), from)
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(8)
  })

  it('weekly: next occurrence of day+at', () => {
    // Jun 11 2026 is a Thursday
    const from = new Date(2026, 5, 11, 12, 0, 0)
    const next = computeNextFire(weekly('tue', '03:00'), from)
    expect(next.getDay()).toBe(2) // Tuesday
    expect(next.getHours()).toBe(3)
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000)
  })

  it('weekly: same day fires today when at is ahead', () => {
    const from = new Date(2026, 5, 11, 1, 0, 0) // Thursday 01:00
    const next = computeNextFire(weekly('thu', '08:00'), from)
    expect(next.getDate()).toBe(11)
  })
})

describe('evaluateTrigger', () => {
  const t = interval(60)
  const now = new Date(2026, 5, 11, 12, 0, 0)

  it('wait when nextFire is in the future', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() + 60000).toISOString(), now)
    expect(r.action).toBe('wait')
  })

  it('fire when nextFire just passed (within grace)', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() - 30000).toISOString(), now)
    expect(r.action).toBe('fire')
    if (r.action === 'fire') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })

  it('missed long ago + skip policy → skip and reschedule', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() - 3 * 3600 * 1000).toISOString(), now)
    expect(r.action).toBe('skip')
    if (r.action === 'skip') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })

  it('missed long ago + run-once-on-startup policy → fire', () => {
    const t2: TriggerSpec = { ...t, missedPolicy: 'run-once-on-startup' }
    const r = evaluateTrigger(t2, new Date(now.getTime() - 3 * 3600 * 1000).toISOString(), now)
    expect(r.action).toBe('fire')
  })

  it('no persisted nextFire → initialize (wait with next set)', () => {
    const r = evaluateTrigger(t, undefined, now)
    expect(r.action).toBe('init')
    if (r.action === 'init') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/scheduler.test.ts`
Expected: FAIL — cannot resolve `../../daemon/scheduler.js`

- [ ] **Step 3: Write `engine/daemon/scheduler.ts`**

```typescript
// engine/daemon/scheduler.ts
// Pure trigger arithmetic — no I/O, no Date.now(). Local time semantics.
import type { TriggerSpec, Weekday } from './types.js'

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Grace window: a fire time missed by more than this is "missed" (missedPolicy applies). */
export const GRACE_MS = 10 * 60 * 1000

function parseAt(at: string): { h: number; m: number } {
  const [h, m] = at.split(':').map(Number)
  return { h: h || 0, m: m || 0 }
}

export function computeNextFire(t: TriggerSpec, from: Date): Date {
  if (t.kind === 'interval') {
    return new Date(from.getTime() + (t.everyMinutes ?? 60) * 60000)
  }
  const { h, m } = parseAt(t.at ?? '00:00')
  const next = new Date(from)
  next.setHours(h, m, 0, 0)
  if (t.kind === 'daily') {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
    return next
  }
  // weekly
  const targetDow = WEEKDAYS.indexOf(t.day ?? 'sun')
  let delta = (targetDow - next.getDay() + 7) % 7
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
  next.setDate(next.getDate() + delta)
  return next
}

export type TriggerEvaluation =
  | { action: 'wait' }
  | { action: 'init'; next: Date }
  | { action: 'fire'; next: Date }
  | { action: 'skip'; next: Date }

export function evaluateTrigger(t: TriggerSpec, nextFireIso: string | undefined, now: Date): TriggerEvaluation {
  if (!nextFireIso) {
    return { action: 'init', next: computeNextFire(t, now) }
  }
  const due = new Date(nextFireIso)
  if (now.getTime() < due.getTime()) return { action: 'wait' }

  const next = computeNextFire(t, now)
  const missedByMs = now.getTime() - due.getTime()
  if (missedByMs > GRACE_MS && t.missedPolicy === 'skip') {
    return { action: 'skip', next }
  }
  return { action: 'fire', next }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/scheduler.test.ts`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/scheduler.ts engine/__tests__/daemon/scheduler.test.ts
git commit -m "feat: pure trigger scheduler — interval/daily/weekly + missed-run policy

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: ntfy channel

**Files:**
- Create: `engine/daemon/ntfyChannel.ts`
- Test: `engine/__tests__/daemon/ntfyChannel.test.ts`

Publishes via ntfy's JSON API (`POST {baseUrl}/` with `{topic, title, message, actions, priority}` — the JSON body form, NOT the header form, because action bodies contain commas/JSON). Subscribes to the command topic via ntfy's SSE endpoint (`GET {baseUrl}/{topic}/sse`). Failed publishes queue in memory and flush on the next successful publish attempt.

The test uses a real `node:http` server on 127.0.0.1 (the bunShim setup already supports this pattern — see `engine/__tests__/bridge/serverBinding.test.ts` for precedent).

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/daemon/ntfyChannel.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import http from 'node:http'
import { NtfyChannel } from '../../daemon/ntfyChannel.js'

type Captured = { path: string; body: any; auth?: string }

function startMockNtfy(): Promise<{
  url: string
  captured: Captured[]
  sendSse: (data: object) => void
  close: () => Promise<void>
}> {
  const captured: Captured[] = []
  let sseRes: http.ServerResponse | null = null
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\n')
        sseRes = res
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          body: body ? JSON.parse(body) : null,
          auth: req.headers['authorization'] as string | undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        sendSse: (data) => {
          sseRes?.write(`data: ${JSON.stringify(data)}\n\n`)
        },
        close: () => new Promise((r) => { sseRes?.end(); server.close(() => r()) }),
      })
    })
  })
}

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => { await cleanup?.(); cleanup = null })

describe('NtfyChannel', () => {
  it('publishes JSON with topic, title, message, and auth token', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, token: 'tk_secret', alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    const ok = await ch.publish({ title: 'Hi', message: 'Hello' })
    expect(ok).toBe(true)
    expect(mock.captured.length).toBe(1)
    expect(mock.captured[0].body.topic).toBe('cynco-alerts')
    expect(mock.captured[0].body.title).toBe('Hi')
    expect(mock.captured[0].auth).toBe('Bearer tk_secret')
  })

  it('attaches approve/reject http actions that POST to the command topic', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    await ch.publishRecommendation({ id: 'rec-9', actionType: 'waiver', summary: 'Claim X', detail: 'why' })
    const actions = mock.captured[0].body.actions
    expect(actions.length).toBe(2)
    expect(actions[0].action).toBe('http')
    expect(actions[0].url).toContain('cynco-commands')
    expect(JSON.parse(actions[0].body)).toEqual({ recId: 'rec-9', verdict: 'approve' })
    expect(JSON.parse(actions[1].body)).toEqual({ recId: 'rec-9', verdict: 'reject' })
  })

  it('queues failed publishes and flushes them on the next publish', async () => {
    const ch = new NtfyChannel({
      baseUrl: 'http://127.0.0.1:1', alertTopic: 'a', commandTopic: 'c', // nothing listening
    })
    const ok = await ch.publish({ title: 'queued', message: 'm' })
    expect(ok).toBe(false)
    expect(ch.queuedCount).toBe(1)

    const mock = await startMockNtfy()
    cleanup = mock.close
    ;(ch as any).baseUrl = mock.url // point at live server
    await ch.publish({ title: 'second', message: 'm' })
    expect(mock.captured.length).toBe(2) // queued one + new one
    expect(ch.queuedCount).toBe(0)
  })

  it('receives commands over SSE', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({
      baseUrl: mock.url, alertTopic: 'a', commandTopic: 'cynco-commands',
    })
    const got: any[] = []
    const stop = ch.subscribe((cmd) => got.push(cmd))
    await new Promise((r) => setTimeout(r, 200)) // let SSE connect
    mock.sendSse({ message: JSON.stringify({ recId: 'rec-1', verdict: 'approve' }) })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got).toEqual([{ recId: 'rec-1', verdict: 'approve' }])
  })

  it('ignores malformed SSE messages', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({ baseUrl: mock.url, alertTopic: 'a', commandTopic: 'c' })
    const got: any[] = []
    const stop = ch.subscribe((cmd) => got.push(cmd))
    await new Promise((r) => setTimeout(r, 200))
    mock.sendSse({ message: 'not json' })
    mock.sendSse({ message: JSON.stringify({ nope: true }) })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/ntfyChannel.test.ts`
Expected: FAIL — cannot resolve `../../daemon/ntfyChannel.js`

- [ ] **Step 3: Write `engine/daemon/ntfyChannel.ts`**

```typescript
// engine/daemon/ntfyChannel.ts
// Self-hosted ntfy client. Publish: JSON API (POST {baseUrl}/). Subscribe: SSE.
// The ntfy server is expected to be bound to the Tailscale interface only —
// this client never opens a listening port.
import type { CommandMessage, Recommendation } from './types.js'

export interface NtfyOptions {
  baseUrl: string
  token?: string
  alertTopic: string
  commandTopic: string
}

interface NtfyAction {
  action: 'http' | 'view'
  label: string
  url: string
  method?: string
  body?: string
  clear?: boolean
}

interface PublishPayload {
  title: string
  message: string
  priority?: number
  actions?: NtfyAction[]
}

export class NtfyChannel {
  private baseUrl: string
  private token?: string
  private alertTopic: string
  private commandTopic: string
  private queue: PublishPayload[] = []
  private subscribed = false

  constructor(opts: NtfyOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.alertTopic = opts.alertTopic
    this.commandTopic = opts.commandTopic
  }

  get queuedCount(): number {
    return this.queue.length
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async post(payload: PublishPayload): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ topic: this.alertTopic, ...payload }),
        signal: AbortSignal.timeout(10000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  /** Publish a notification. On failure it is queued; queued items flush before the next publish. */
  async publish(payload: PublishPayload): Promise<boolean> {
    // Flush queue first (oldest first)
    while (this.queue.length > 0) {
      const queued = this.queue[0]
      if (await this.post(queued)) this.queue.shift()
      else break
    }
    const ok = await this.post(payload)
    if (!ok) this.queue.push(payload)
    return ok
  }

  /** Publish a recommendation with one-tap Approve/Reject buttons. */
  async publishRecommendation(rec: Recommendation): Promise<boolean> {
    const cmdUrl = `${this.baseUrl}/${this.commandTopic}`
    const action = (verdict: 'approve' | 'reject', label: string): NtfyAction => ({
      action: 'http',
      label,
      url: cmdUrl,
      method: 'POST',
      body: JSON.stringify({ recId: rec.id, verdict } satisfies CommandMessage),
      clear: true,
    })
    const actions: NtfyAction[] = [action('approve', 'Approve'), action('reject', 'Reject')]
    if (rec.deepLink) actions.push({ action: 'view', label: 'Open MFL', url: rec.deepLink })
    return this.publish({
      title: `[${rec.actionType}] ${rec.summary}`,
      message: rec.detail,
      priority: 4,
      actions,
    })
  }

  /**
   * Subscribe to the command topic via SSE. Reconnects with backoff until the
   * returned stop function is called.
   */
  subscribe(onCommand: (cmd: CommandMessage) => void): () => void {
    this.subscribed = true
    const loop = async () => {
      let backoffMs = 1000
      while (this.subscribed) {
        try {
          const resp = await fetch(`${this.baseUrl}/${this.commandTopic}/sse`, {
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
          })
          if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`)
          backoffMs = 1000
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (this.subscribed) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim()
              buffer = buffer.slice(idx + 1)
              if (!line.startsWith('data:')) continue
              try {
                const event = JSON.parse(line.slice(5).trim())
                const cmd = JSON.parse(event.message)
                if ((cmd.verdict === 'approve' || cmd.verdict === 'reject') && typeof cmd.recId === 'string') {
                  onCommand({ recId: cmd.recId, verdict: cmd.verdict })
                }
              } catch {
                // malformed event — ignore
              }
            }
          }
          try { reader.cancel() } catch {}
        } catch {
          // connection failed — back off and retry
          await new Promise((r) => setTimeout(r, backoffMs))
          backoffMs = Math.min(backoffMs * 2, 60000)
        }
      }
    }
    void loop()
    return () => { this.subscribed = false }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/ntfyChannel.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/ntfyChannel.ts engine/__tests__/daemon/ntfyChannel.test.ts
git commit -m "feat: ntfy channel — JSON publish with action buttons, SSE command subscription, offline queue

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: One-shot engine mode

**Files:**
- Create: `engine/daemon/oneShot.ts`
- Modify: `engine/main.ts` (insert `--run-task` branch right before `const port = parseInt(...)` — currently `engine/main.ts:218`)
- Test: `engine/__tests__/daemon/oneShot.test.ts`

`runOneShotTask` runs INSIDE the engine process. It reuses the bounded model+tool loop pattern from `engine/agents/subAgent.ts:188-360` (localCallModel stream → collect text + tool_use blocks → ToolExecutor.execute → tool_result feedback). It must NOT import or modify SubAgent (live CynCo sessions depend on it) — it has its own compact loop.

The model is instructed to end with a fenced ```json block containing `{summary, recommendations}`. Extraction takes the LAST fenced json block; if none parses, the outcome falls back to `ok: true` with the tail of the collected text as summary and zero recommendations.

- [ ] **Step 1: Write the failing test**

The test drives the loop with a fake provider (no llama-server). `localCallModel` accepts injected `deps.getProvider`, so the fake provider implements the `Provider` stream interface. Look at `engine/__tests__/engine/callModel.test.ts` for how existing tests fake a provider stream, and reuse that helper style. The key behaviors to pin:

```typescript
// engine/__tests__/daemon/oneShot.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractOutcome, buildOneShotSystemPrompt } from '../../daemon/oneShot.js'

describe('extractOutcome', () => {
  it('parses the last fenced json block', () => {
    const text = [
      'thinking...',
      '```json', '{"summary": "draft", "recommendations": []}', '```',
      'more...',
      '```json',
      JSON.stringify({ summary: 'final', recommendations: [{ actionType: 'waiver', summary: 'Claim X', detail: 'why' }] }),
      '```',
    ].join('\n')
    const outcome = extractOutcome(text)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe('final')
    expect(outcome.recommendations.length).toBe(1)
  })

  it('assigns ids to recommendations missing one', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations[0].id).toMatch(/^rec-/)
  })

  it('falls back to text tail when no json block parses', () => {
    const outcome = extractOutcome('I looked at the roster. Nothing to do this week.')
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain('Nothing to do')
    expect(outcome.recommendations).toEqual([])
  })

  it('drops malformed recommendation entries', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"bogus": true}, {"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations.length).toBe(1)
    expect(outcome.recommendations[0].actionType).toBe('waiver')
  })
})

describe('buildOneShotSystemPrompt', () => {
  it('includes the outcome format contract and mission context', () => {
    const p = buildOneShotSystemPrompt('goal: win the league')
    expect(p).toContain('goal: win the league')
    expect(p).toContain('```json')
    expect(p).toContain('recommendations')
  })
})
```

(The full loop is covered by the Task 9 integration test via a stub engine; unit-testing the stream loop itself would duplicate `subAgent`/`callModel` coverage.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/oneShot.test.ts`
Expected: FAIL — cannot resolve `../../daemon/oneShot.js`

- [ ] **Step 3: Write `engine/daemon/oneShot.ts`**

```typescript
// engine/daemon/oneShot.ts
// One-shot engine mode: read a task file, run a bounded model+tool loop,
// write a TaskOutcome, return an exit code. Runs INSIDE the engine process
// (invoked from main.ts when --run-task is passed). Loop pattern mirrors
// engine/agents/subAgent.ts but stays independent of it.
import { randomBytes } from 'crypto'
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import type { Message, ContentBlock, ToolUseBlock } from '../types.js'
import { asSystemPrompt } from '../types.js'
import { ToolExecutor } from '../tools/executor.js'
import { getToolByName } from '../tools/registry.js'
import { localCallModel } from '../engine/callModel.js'
import { readTaskFile, writeOutcome } from './taskFile.js'
import type { Recommendation, TaskOutcome } from './types.js'

const MAX_TURNS = 20

export function buildOneShotSystemPrompt(context: string): string {
  return [
    'You are CynCo running an unattended scheduled mission task. There is no user to ask — work autonomously with the tools provided, then stop.',
    '',
    'Mission context:',
    context,
    '',
    'When you are done, end your FINAL message with exactly one fenced code block in this format:',
    '```json',
    '{"summary": "<one-paragraph summary of what you found/did>",',
    ' "recommendations": [{"actionType": "waiver|trade|lineup|info", "summary": "<short>", "detail": "<why>", "deepLink": "<optional URL>"}]}',
    '```',
    'If there is nothing actionable, return an empty recommendations array. Do not invent recommendations.',
  ].join('\n')
}

export function extractOutcome(text: string): TaskOutcome {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(blocks[i])
      if (typeof raw.summary !== 'string') continue
      const recommendations: Recommendation[] = (Array.isArray(raw.recommendations) ? raw.recommendations : [])
        .filter((r: any) => r && typeof r.actionType === 'string' && typeof r.summary === 'string' && typeof r.detail === 'string')
        .map((r: any) => ({
          id: typeof r.id === 'string' && r.id ? r.id : `rec-${randomBytes(4).toString('hex')}`,
          actionType: r.actionType,
          summary: r.summary,
          detail: r.detail,
          ...(typeof r.deepLink === 'string' ? { deepLink: r.deepLink } : {}),
        }))
      return { ok: true, summary: raw.summary, recommendations }
    } catch {
      // try the previous block
    }
  }
  const tail = text.trim().slice(-1000)
  return { ok: true, summary: tail || '(no output)', recommendations: [] }
}

export async function runOneShotTask(
  taskFilePath: string,
  provider: Provider,
  config: LocalCodeConfig,
): Promise<number> {
  let outcomePath = ''
  try {
    const task = readTaskFile(taskFilePath)
    outcomePath = task.outcomePath
    console.log(`[one-shot] Mission ${task.missionId} / trigger ${task.triggerId}`)

    const tools = task.allowedTools
      .map((name) => getToolByName(name))
      .filter((t): t is NonNullable<typeof t> => t != null)
    const allowedNames = new Set(tools.map((t) => t.name))
    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputJSONSchema: t.inputSchema,
    }))

    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval: async () => true,
      approveAll: true,
    })

    const systemPrompt = asSystemPrompt([buildOneShotSystemPrompt(task.context)])
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: task.prompt }] },
    ]
    const deps = { getProvider: () => provider, loadConfig: () => config }
    const abort = new AbortController()
    const deadline = Date.now() + task.timeoutMs
    let collectedText = ''

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (Date.now() > deadline) {
        writeOutcome(outcomePath, { ok: false, summary: collectedText.slice(-1000), recommendations: [], error: 'Internal deadline exceeded' })
        return 1
      }

      const stream = localCallModel({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: toolDefs,
        signal: abort.signal,
        options: { model: config.model ?? 'unknown' },
        deps,
      })

      // Collect text and tool_use blocks (same event shapes as subAgent.ts)
      let turnText = ''
      const turnToolUses: ToolUseBlock[] = []
      let currentBlock: any = null
      for await (const event of stream) {
        if (event.type !== 'stream_event') continue
        const inner = (event as any).event
        switch (inner.type) {
          case 'content_block_start': {
            const block = inner.content_block
            if (block.type === 'text') currentBlock = { type: 'text', text: '' }
            else if (block.type === 'tool_use') currentBlock = { type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }
            break
          }
          case 'content_block_delta': {
            if (!currentBlock) break
            const delta = inner.delta
            if (delta.type === 'text_delta' && currentBlock.type === 'text') currentBlock.text += delta.text
            else if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
              currentBlock._partialJson = (currentBlock._partialJson ?? '') + delta.partial_json
            }
            break
          }
          case 'content_block_stop': {
            if (!currentBlock) break
            if (currentBlock.type === 'text') turnText += currentBlock.text
            else {
              if (currentBlock._partialJson) {
                try { currentBlock.input = JSON.parse(currentBlock._partialJson) } catch {}
                delete currentBlock._partialJson
              }
              turnToolUses.push({ type: 'tool_use', id: currentBlock.id, name: currentBlock.name, input: currentBlock.input })
            }
            currentBlock = null
            break
          }
        }
      }

      const assistantContent: ContentBlock[] = []
      if (turnText) { assistantContent.push({ type: 'text', text: turnText }); collectedText += turnText + '\n' }
      for (const tu of turnToolUses) assistantContent.push(tu)
      if (assistantContent.length > 0) messages.push({ role: 'assistant', content: assistantContent })

      if (turnToolUses.length === 0) break // model is done

      const toolResults: ContentBlock[] = []
      for (const tu of turnToolUses) {
        if (!allowedNames.has(tu.name)) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: tool "${tu.name}" not allowed for this task`, is_error: true })
          continue
        }
        const result = await executor.execute(tu.name, tu.input)
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.output ?? '', is_error: result.isError === true })
      }
      messages.push({ role: 'user', content: toolResults })
    }

    writeOutcome(outcomePath, extractOutcome(collectedText))
    console.log(`[one-shot] Outcome written: ${outcomePath}`)
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[one-shot] Failed: ${msg}`)
    if (outcomePath) {
      try { writeOutcome(outcomePath, { ok: false, summary: '', recommendations: [], error: msg }) } catch {}
    }
    return 1
  }
}
```

NOTE: Before finalizing, verify the exact `ToolExecutor.execute` return shape (`engine/tools/executor.ts`) — subAgent uses `result.isError` and the content fed back; if the result field is named differently (e.g. `result.output` vs `result.content`), match it. Also verify `localCallModel`'s options/deps parameter names against `engine/agents/subAgent.ts:196-206` — the code above mirrors subAgent exactly, so any drift means subAgent changed and you should match the current subAgent.

- [ ] **Step 4: Insert the `--run-task` branch in `engine/main.ts`**

Find this line (currently `engine/main.ts:217-218`):

```typescript
console.log(`[localcode] Context budget: ${contextLength} tokens`)
const port = parseInt(process.env.LOCALCODE_WS_PORT ?? '9160', 10)
```

Insert between those two lines:

```typescript
// ─── One-shot mode (daemon-scheduled task; no WS server, no TUI) ──
const runTaskIdx = process.argv.indexOf('--run-task')
if (runTaskIdx !== -1) {
  const taskFilePath = process.argv[runTaskIdx + 1]
  if (!taskFilePath) {
    console.error('[one-shot] --run-task requires a task file path')
    process.exit(1)
  }
  const { runOneShotTask } = await import('./daemon/oneShot.js')
  const exitCode = await runOneShotTask(taskFilePath, provider, config)
  // process.exit() skips beforeExit — stop llama-server explicitly
  const pm = (globalThis as any).__llamaProcessManager
  if (pm) { try { await pm.stop() } catch {} }
  process.exit(exitCode)
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run engine/__tests__/daemon/oneShot.test.ts`
Expected: 6 passed

Run: `npx vitest run engine/__tests__/engine/ engine/__tests__/agents/ 2>/dev/null` (regression check on neighboring suites)
Expected: only known pre-existing failures

- [ ] **Step 6: Type-check the main.ts change compiles**

Run: `bun build engine/main.ts --target bun --outdir /tmp/cynco-build-check 2>&1 | tail -5`
Expected: no errors (warnings OK). Delete `/tmp/cynco-build-check` after.

- [ ] **Step 7: Commit**

```bash
git add engine/daemon/oneShot.ts engine/main.ts engine/__tests__/daemon/oneShot.test.ts
git commit -m "feat: one-shot engine mode (--run-task) — bounded tool loop, structured outcome, llama-server stopped on exit

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

CAUTION: `engine/main.ts` may have concurrent modifications from a live CynCo session. `git add engine/main.ts` stages the whole file — before committing, run `git diff --cached engine/main.ts` and verify the diff contains ONLY your `--run-task` branch. If unrelated hunks appear, stop and ask the user.

---

### Task 7: TaskRunner + GPU guard

**Files:**
- Create: `engine/daemon/taskRunner.ts`
- Test: `engine/__tests__/daemon/taskRunner.test.ts`
- Test fixture: `engine/__tests__/daemon/fixtures/stubEngine.mjs`

Spawns the one-shot engine as a child process with a hard timeout. Tests never spawn the real engine — they use a stub script run with `process.execPath` (node under vitest).

- [ ] **Step 1: Write the stub engine fixture**

```javascript
// engine/__tests__/daemon/fixtures/stubEngine.mjs
// Mimics `bun engine/main.ts --run-task <file>`: reads the task file,
// writes a canned outcome. Behavior switches on the task prompt.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const taskPath = process.argv[process.argv.indexOf('--run-task') + 1]
const task = JSON.parse(readFileSync(taskPath, 'utf-8'))

if (task.prompt.includes('HANG')) {
  // never exits — used to test the timeout kill
  setInterval(() => {}, 1000)
} else if (task.prompt.includes('CRASH')) {
  process.exit(1)
} else {
  mkdirSync(dirname(task.outcomePath), { recursive: true })
  writeFileSync(task.outcomePath, JSON.stringify({
    ok: true,
    summary: `stub ran for ${task.missionId}`,
    recommendations: [{ id: 'rec-stub', actionType: 'waiver', summary: 'Claim X', detail: 'stub' }],
  }), 'utf-8')
  process.exit(0)
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// engine/__tests__/daemon/taskRunner.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskRunner, isGpuBusy } from '../../daemon/taskRunner.js'
import type { TaskFileInput } from '../../daemon/types.js'

const STUB = join(import.meta.dirname, 'fixtures', 'stubEngine.mjs')

function makeInput(dir: string, prompt: string): TaskFileInput {
  return {
    missionId: 'm1', triggerId: 't1', prompt, context: 'ctx',
    allowedTools: ['Mfl'], timeoutMs: 3000, outcomePath: join(dir, 'out.json'),
  }
}

describe('TaskRunner', () => {
  it('runs the engine and returns the outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(true)
      expect(outcome.summary).toContain('stub ran for m1')
      expect(outcome.recommendations.length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('kills a hung engine at timeoutMs and reports failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const input = { ...makeInput(dir, 'HANG please'), timeoutMs: 1500 }
      const started = Date.now()
      const outcome = await runner.run(input)
      expect(Date.now() - started).toBeLessThan(10000)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/timeout/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 15000)

  it('reports failure when the engine crashes without an outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const outcome = await runner.run(makeInput(dir, 'CRASH now'))
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/exit|missing/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('throws GpuBusyError when the GPU is busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => true,
      })
      await expect(runner.run(makeInput(dir, 'x'))).rejects.toThrow(/gpu busy/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('isGpuBusy', () => {
  it('detects llama-server in the process list', async () => {
    expect(await isGpuBusy(async () => 'bun.exe\nllama-server.exe\n')).toBe(true)
  })
  it('returns false when no llama-server is running', async () => {
    expect(await isGpuBusy(async () => 'explorer.exe\ncode.exe\n')).toBe(false)
  })
  it('returns false when the process list is unavailable', async () => {
    expect(await isGpuBusy(async () => { throw new Error('no tasklist') })).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/taskRunner.test.ts`
Expected: FAIL — cannot resolve `../../daemon/taskRunner.js`

- [ ] **Step 4: Write `engine/daemon/taskRunner.ts`**

```typescript
// engine/daemon/taskRunner.ts
// Spawns one-shot engine runs with a GPU guard and a hard timeout.
import { spawn } from 'child_process'
import { join } from 'path'
import { writeTaskFile, readOutcome } from './taskFile.js'
import type { TaskFileInput, TaskOutcome } from './types.js'

export class GpuBusyError extends Error {
  constructor() { super('GPU busy: an interactive llama-server is running') }
}

/**
 * Heuristic: if llama-server is already running, an interactive CynCo session
 * owns the GPU — a scheduled task must not fight it for VRAM.
 */
export async function isGpuBusy(
  listProcesses?: () => Promise<string>,
): Promise<boolean> {
  const list = listProcesses ?? (async () => {
    const { execSync } = require('child_process')
    return execSync('tasklist', { timeout: 10000, encoding: 'utf-8' }) as string
  })
  try {
    const out = await list()
    return out.toLowerCase().includes('llama-server')
  } catch {
    return false // can't tell — let the run proceed; engine startup will fail loudly if truly contended
  }
}

export interface TaskRunnerOptions {
  /** Directory for task/outcome files (per-mission tmp). */
  workDir: string
  /** Command to launch the one-shot engine. Default: ['bun', '<repoRoot>/engine/main.ts']. */
  spawnCmd?: string[]
  /** Repo root (cwd for the engine process). Default: process.cwd(). */
  repoRoot?: string
  isGpuBusyImpl?: () => Promise<boolean>
}

export class TaskRunner {
  private opts: TaskRunnerOptions

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts
  }

  async run(input: TaskFileInput): Promise<TaskOutcome> {
    const busy = await (this.opts.isGpuBusyImpl ?? isGpuBusy)()
    if (busy) throw new GpuBusyError()

    const repoRoot = this.opts.repoRoot ?? process.cwd()
    const stamp = Date.now()
    const taskPath = join(this.opts.workDir, `task-${input.triggerId}-${stamp}.json`)
    const finalInput: TaskFileInput = {
      ...input,
      outcomePath: input.outcomePath || join(this.opts.workDir, `outcome-${input.triggerId}-${stamp}.json`),
    }
    writeTaskFile(taskPath, finalInput)

    const cmd = this.opts.spawnCmd ?? ['bun', join(repoRoot, 'engine', 'main.ts')]
    const child = spawn(cmd[0], [...cmd.slice(1), '--run-task', taskPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
    child.stdout?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), input.timeoutMs)),
    ])

    if (timedOut) {
      try { child.kill() } catch {}
      if (process.platform === 'win32' && child.pid) {
        // kill the whole tree (bun → llama-server)
        try {
          const { execSync } = require('child_process')
          execSync(`taskkill /F /T /PID ${child.pid}`, { timeout: 5000 })
        } catch {}
      }
      return { ok: false, summary: '', recommendations: [], error: `Task timeout after ${input.timeoutMs}ms` }
    }

    const code = await exited
    const outcome = readOutcome(finalInput.outcomePath)
    if (!outcome.ok && !outcome.error && code !== 0) {
      outcome.error = `Engine exited with code ${code}`
    }
    return outcome
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/taskRunner.test.ts`
Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
git add engine/daemon/taskRunner.ts engine/__tests__/daemon/taskRunner.test.ts engine/__tests__/daemon/fixtures/stubEngine.mjs
git commit -m "feat: task runner — GPU guard, one-shot engine spawn, hard timeout with process-tree kill

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Daemon main (wiring)

**Files:**
- Create: `engine/daemon/main.ts`
- Create: `engine/daemon/missionRunner.ts` (the per-tick logic, separated from process bootstrap so it's testable)
- Test: `engine/__tests__/daemon/missionRunner.test.ts`

`daemon/main.ts` is a thin bootstrap (env parsing, load missions, start tick interval + ntfy subscription, signal handling). All decision logic lives in `missionRunner.ts` with injected dependencies so tests need no real ntfy/engine/MFL.

Env vars (document in Task 9): `CYNCO_NTFY_URL` (e.g. `http://100.x.y.z:8090`), `CYNCO_NTFY_TOKEN`, `CYNCO_NTFY_ALERT_TOPIC` (default `cynco-alerts`), `CYNCO_NTFY_COMMAND_TOPIC` (default `cynco-commands`), `CYNCO_MISSIONS_DIR` (default `~/.cynco/missions`).

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/daemon/missionRunner.test.ts
import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionRunner } from '../../daemon/missionRunner.js'
import { MissionLedger } from '../../daemon/missionLedger.js'
import type { MissionConfig, TaskOutcome, Recommendation } from '../../daemon/types.js'

const config: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Win the league',
  leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0005' }],
  triggers: [
    { id: 'poll', kind: 'interval', everyMinutes: 60, precheck: 'mfl-delta', missedPolicy: 'skip', prompt: 'Check transactions' },
    { id: 'news', kind: 'interval', everyMinutes: 120, precheck: 'none', missedPolicy: 'skip', prompt: 'Check news' },
  ],
  trustLadder: { waiver: { mode: 'ask', promoteAt: 2 } },
}

function makeDeps(overrides: Partial<any> = {}) {
  const published: any[] = []
  const ranTasks: any[] = []
  return {
    published,
    ranTasks,
    deps: {
      runTask: async (input: any): Promise<TaskOutcome> => {
        ranTasks.push(input)
        return {
          ok: true, summary: 'found stuff',
          recommendations: [{ id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'why' } as Recommendation],
        }
      },
      publish: async (p: any) => { published.push(p); return true },
      publishRecommendation: async (r: Recommendation) => { published.push(r); return true },
      fetchMflSnapshot: async (_league: string, _year: number) => 'hash-1',
      now: () => new Date(2026, 5, 11, 12, 0, 0),
      ...overrides,
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cynco-mr-'))
  mkdirSync(join(dir, 'mfl-dynasty'))
  writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(config), 'utf-8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('MissionRunner.tick', () => {
  it('initializes nextFire on first tick without firing', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(ledger.state.nextFire['poll']).toBeDefined()
  })

  it('fires a due trigger, records the run, publishes recommendations as pending', async () => {
    const { deps, ranTasks, published } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString()) // not due
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('news')
    expect(published.length).toBe(1) // the recommendation
    expect(ledger.state.pending['rec-1']).toBeDefined()
    expect(ledger.recentRuns(5).length).toBe(1)
    // nextFire advanced
    expect(new Date(ledger.state.nextFire['news']).getTime()).toBeGreaterThan(deps.now().getTime())
  })

  it('mfl-delta precheck: skips the engine when the snapshot is unchanged', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setLastSeen('12345', 'hash-1') // matches fetchMflSnapshot
    ledger.setNextFire('poll', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    // nextFire still advanced (we checked, found nothing)
    expect(new Date(ledger.state.nextFire['poll']).getTime()).toBeGreaterThan(deps.now().getTime())
  })

  it('mfl-delta precheck: fires when the snapshot changed and updates lastSeen', async () => {
    const { deps, ranTasks } = makeDeps({ fetchMflSnapshot: async () => 'hash-2' })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setLastSeen('12345', 'hash-1')
    ledger.setNextFire('poll', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ledger.state.lastSeen['12345']).toBe('hash-2')
  })

  it('GPU busy defers: nextFire pushed 10 minutes, no failure recorded', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    const { deps, ranTasks } = makeDeps({ runTask: async () => { throw new GpuBusyError() } })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ledger.state.failureStreak).toBe(0)
    const next = new Date(ledger.state.nextFire['news'])
    expect(next.getTime()).toBe(deps.now().getTime() + 10 * 60000)
  })

  it('3 consecutive failures publish an algedonic alert', async () => {
    const { deps, published } = makeDeps({
      runTask: async (): Promise<TaskOutcome> => ({ ok: false, summary: '', recommendations: [], error: 'boom' }),
    })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    for (let i = 0; i < 3; i++) {
      ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
      ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
      await runner.tick()
    }
    expect(ledger.state.failureStreak).toBe(3)
    const alert = published.find((p) => p.title?.match(/stuck/i))
    expect(alert).toBeDefined()
  })

  it('handleCommand resolves approval and confirms via publish; promotion proposal at threshold', async () => {
    const { deps, published } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    ledger.state.trust.waiver.approvedStreak = 1 // promoteAt: 2 → next approve hits it
    ledger.addPending({ id: 'rec-7', actionType: 'waiver', summary: 'Claim Z', detail: 'd' })
    const handled = await runner.handleCommand({ recId: 'rec-7', verdict: 'approve' })
    expect(handled).toBe(true)
    expect(ledger.state.pending['rec-7']).toBeUndefined()
    const promo = published.find((p) => p.title?.match(/promot/i))
    expect(promo).toBeDefined()
  })

  it('handleCommand returns false for an unknown recId', async () => {
    const { deps } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    expect(await runner.handleCommand({ recId: 'nope', verdict: 'approve' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/daemon/missionRunner.test.ts`
Expected: FAIL — cannot resolve `../../daemon/missionRunner.js`

- [ ] **Step 3: Write `engine/daemon/missionRunner.ts`**

```typescript
// engine/daemon/missionRunner.ts
// Per-mission tick logic. All side effects are injected (runTask, publish,
// fetchMflSnapshot, now) so this is fully testable without ntfy/engine/MFL.
import type { MissionLedger } from './missionLedger.js'
import { evaluateTrigger, computeNextFire } from './scheduler.js'
import { GpuBusyError } from './taskRunner.js'
import type { CommandMessage, Recommendation, TaskFileInput, TaskOutcome, TriggerSpec } from './types.js'

const GPU_DEFER_MS = 10 * 60 * 1000
const FAILURE_ALERT_THRESHOLD = 3
const DEFAULT_TOOLS = ['Mfl', 'WebSearch', 'WebFetch', 'Read']
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface MissionRunnerDeps {
  runTask: (input: TaskFileInput) => Promise<TaskOutcome>
  publish: (p: { title: string; message: string; priority?: number }) => Promise<boolean>
  publishRecommendation: (rec: Recommendation) => Promise<boolean>
  /** Returns a stable hash of the league's current MFL transactions. */
  fetchMflSnapshot: (leagueId: string, year: number) => Promise<string>
  now: () => Date
}

export class MissionRunner {
  constructor(
    private ledger: MissionLedger,
    private deps: MissionRunnerDeps,
  ) {}

  /** One scheduler tick: evaluate every trigger, fire due ones sequentially. */
  async tick(): Promise<void> {
    const now = this.deps.now()
    for (const trigger of this.ledger.config.triggers) {
      const evaln = evaluateTrigger(trigger, this.ledger.state.nextFire[trigger.id], now)
      if (evaln.action === 'wait') continue
      this.ledger.setNextFire(trigger.id, evaln.next.toISOString())
      if (evaln.action === 'init' || evaln.action === 'skip') {
        this.ledger.saveState()
        continue
      }
      await this.fire(trigger, now)
    }
    this.ledger.saveState()
  }

  private async fire(trigger: TriggerSpec, now: Date): Promise<void> {
    // Cheap pre-check: skip the model entirely when MFL hasn't changed
    if (trigger.precheck === 'mfl-delta') {
      let anyDelta = false
      for (const league of this.ledger.config.leagues) {
        try {
          const hash = await this.deps.fetchMflSnapshot(league.leagueId, league.year)
          if (this.ledger.state.lastSeen[league.leagueId] !== hash) {
            anyDelta = true
            this.ledger.setLastSeen(league.leagueId, hash)
          }
        } catch {
          anyDelta = true // can't check — let the engine look
        }
      }
      if (!anyDelta) return
    }

    const context = [
      `Mission goal: ${this.ledger.config.goal}`,
      `Leagues: ${this.ledger.config.leagues.map((l) => `${l.leagueId} (year ${l.year}, your franchise ${l.franchiseId})`).join('; ')}`,
      'Recent runs:',
      ...this.ledger.recentRuns(3).map((r) => `- [${r.ts}] ${r.ok ? 'ok' : 'FAILED'}: ${r.summary.slice(0, 200)}`),
    ].join('\n')

    const input: TaskFileInput = {
      missionId: this.ledger.config.id,
      triggerId: trigger.id,
      prompt: trigger.prompt,
      context,
      allowedTools: DEFAULT_TOOLS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      outcomePath: '', // TaskRunner fills this in
    }

    let outcome: TaskOutcome
    try {
      outcome = await this.deps.runTask(input)
    } catch (err) {
      if (err instanceof GpuBusyError) {
        // Defer, don't count as failure
        this.ledger.setNextFire(trigger.id, new Date(now.getTime() + GPU_DEFER_MS).toISOString())
        return
      }
      outcome = { ok: false, summary: '', recommendations: [], error: err instanceof Error ? err.message : String(err) }
    }

    this.ledger.recordRun({
      ts: now.toISOString(),
      triggerId: trigger.id,
      ok: outcome.ok,
      summary: outcome.ok ? outcome.summary : (outcome.error ?? 'failed'),
      recommendationIds: outcome.recommendations.map((r) => r.id),
    })

    if (!outcome.ok) {
      this.ledger.state.failureStreak += 1
      if (this.ledger.state.failureStreak >= FAILURE_ALERT_THRESHOLD) {
        await this.deps.publish({
          title: `CynCo stuck on mission ${this.ledger.config.id}`,
          message: `${this.ledger.state.failureStreak} consecutive failures. Last error: ${outcome.error ?? 'unknown'}`,
          priority: 5,
        })
      }
      return
    }

    this.ledger.state.failureStreak = 0
    for (const rec of outcome.recommendations) {
      this.ledger.addPending(rec)
      await this.deps.publishRecommendation(rec)
    }
    if (outcome.recommendations.length === 0 && trigger.precheck === 'none') {
      // Digest-style runs report even when nothing is actionable
      await this.deps.publish({ title: `Mission ${this.ledger.config.id}: ${trigger.id}`, message: outcome.summary })
    }
  }

  /** Handle an approve/reject command from the phone. Returns false if the recId is unknown to this mission. */
  async handleCommand(cmd: CommandMessage): Promise<boolean> {
    const res = this.ledger.resolveApproval(cmd.recId, cmd.verdict)
    if (!res) return false
    await this.deps.publish({
      title: `${cmd.verdict === 'approve' ? 'Approved' : 'Rejected'}: ${res.rec.summary}`,
      message: cmd.verdict === 'approve' ? 'Noted — execute it in MFL when ready.' : 'Noted — streak reset.',
    })
    if (res.promotionEligible) {
      await this.deps.publish({
        title: `Trust promotion available: ${res.rec.actionType}`,
        message: `You have approved the last ${this.ledger.state.trust[res.rec.actionType]?.approvedStreak} ${res.rec.actionType} recommendations without edits. Phase C (autonomous ${res.rec.actionType}) is now justifiable — this remains informational until Phase C ships.`,
        priority: 3,
      })
    }
    return true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/daemon/missionRunner.test.ts`
Expected: 8 passed

- [ ] **Step 5: Write `engine/daemon/main.ts`** (thin bootstrap — no test; covered by Task 9 integration)

```typescript
// engine/daemon/main.ts
// CynCo liveness daemon: tiny always-on sentinel. No model is ever loaded here.
//
// Usage:
//   CYNCO_NTFY_URL=http://100.x.y.z:8090 CYNCO_NTFY_TOKEN=tk_... bun engine/daemon/main.ts
import { existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { MissionLedger } from './missionLedger.js'
import { MissionRunner } from './missionRunner.js'
import { NtfyChannel } from './ntfyChannel.js'
import { TaskRunner } from './taskRunner.js'
import { buildMflExportUrl, loadMflApiKey } from '../tools/impl/mfl.js'
import { createHash } from 'crypto'

const TICK_MS = 30000

const missionsDir = process.env.CYNCO_MISSIONS_DIR ?? join(homedir(), '.cynco', 'missions')
const ntfyUrl = process.env.CYNCO_NTFY_URL
if (!ntfyUrl) {
  console.error('[daemon] CYNCO_NTFY_URL is required (e.g. http://<tailscale-ip>:8090)')
  process.exit(1)
}

const ntfy = new NtfyChannel({
  baseUrl: ntfyUrl,
  token: process.env.CYNCO_NTFY_TOKEN,
  alertTopic: process.env.CYNCO_NTFY_ALERT_TOPIC ?? 'cynco-alerts',
  commandTopic: process.env.CYNCO_NTFY_COMMAND_TOPIC ?? 'cynco-commands',
})

async function fetchMflSnapshot(leagueId: string, year: number): Promise<string> {
  const url = buildMflExportUrl({ query: 'transactions', league: leagueId, year, apiKey: loadMflApiKey() })
  const resp = await fetch(url, { headers: { 'User-Agent': 'CynCo/1.0' }, signal: AbortSignal.timeout(30000) })
  if (!resp.ok) throw new Error(`MFL HTTP ${resp.status}`)
  return createHash('sha256').update(await resp.text()).digest('hex')
}

// Load all missions
mkdirSync(missionsDir, { recursive: true })
const runners: MissionRunner[] = []
for (const entry of readdirSync(missionsDir)) {
  const dir = join(missionsDir, entry)
  if (!existsSync(join(dir, 'mission.json'))) continue
  const ledger = MissionLedger.load(dir)
  const taskRunner = new TaskRunner({ workDir: join(dir, 'tasks') })
  runners.push(new MissionRunner(ledger, {
    runTask: (input) => taskRunner.run(input),
    publish: (p) => ntfy.publish(p),
    publishRecommendation: (rec) => ntfy.publishRecommendation(rec),
    fetchMflSnapshot,
    now: () => new Date(),
  }))
  console.log(`[daemon] Loaded mission: ${ledger.config.id} (${ledger.config.triggers.length} triggers)`)
}

if (runners.length === 0) {
  console.log(`[daemon] No missions found in ${missionsDir} — create <mission-id>/mission.json. Idling.`)
}

// Phone commands → first mission that knows the recId
const stopSubscription = ntfy.subscribe(async (cmd) => {
  for (const runner of runners) {
    if (await runner.handleCommand(cmd)) return
  }
  console.log(`[daemon] Command for unknown recId: ${cmd.recId}`)
})

let ticking = false
const interval = setInterval(async () => {
  if (ticking) return // a long engine run is in progress — skip overlapping ticks
  ticking = true
  try {
    for (const runner of runners) await runner.tick()
  } catch (err) {
    console.error(`[daemon] Tick error: ${err instanceof Error ? err.message : err}`)
  } finally {
    ticking = false
  }
}, TICK_MS)

const shutdown = () => {
  console.log('[daemon] Shutting down')
  clearInterval(interval)
  stopSubscription()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`[daemon] CynCo liveness daemon up — ${runners.length} mission(s), tick every ${TICK_MS / 1000}s`)
```

- [ ] **Step 6: Verify daemon boots and idles cleanly**

Run: `CYNCO_NTFY_URL=http://127.0.0.1:9 CYNCO_MISSIONS_DIR=$(mktemp -d) timeout 5 bun engine/daemon/main.ts; echo "exit: $?"`
Expected: prints "No missions found ... Idling." and "daemon up — 0 mission(s)", then killed by timeout (exit 124). No crash.

- [ ] **Step 7: Commit**

```bash
git add engine/daemon/missionRunner.ts engine/daemon/main.ts engine/__tests__/daemon/missionRunner.test.ts
git commit -m "feat: liveness daemon — mission tick loop, MFL delta precheck, approvals, algedonic alerts

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end integration test

**Files:**
- Test: `engine/__tests__/daemon/integration.test.ts`

Full chain with zero real dependencies: mission on disk → tick → delta precheck → stub engine spawn (real `TaskRunner` + real child process) → outcome → ntfy publish (real `NtfyChannel` + mock HTTP server) → SSE approve command → ledger trust update.

- [ ] **Step 1: Write the integration test**

```typescript
// engine/__tests__/daemon/integration.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionLedger } from '../../daemon/missionLedger.js'
import { MissionRunner } from '../../daemon/missionRunner.js'
import { NtfyChannel } from '../../daemon/ntfyChannel.js'
import { TaskRunner } from '../../daemon/taskRunner.js'
import type { MissionConfig } from '../../daemon/types.js'

const STUB = join(import.meta.dirname, 'fixtures', 'stubEngine.mjs')

// Reuse the mock ntfy pattern from ntfyChannel.test.ts
function startMockNtfy(): Promise<{ url: string; captured: any[]; sendSse: (d: object) => void; close: () => Promise<void> }> {
  const captured: any[] = []
  let sseRes: http.ServerResponse | null = null
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\n')
        sseRes = res
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push(body ? JSON.parse(body) : null)
        res.writeHead(200).end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      captured,
      sendSse: (d) => { sseRes?.write(`data: ${JSON.stringify(d)}\n\n`) },
      close: () => new Promise((r) => { sseRes?.end(); server.close(() => r()) }),
    }))
  })
}

let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.reverse()) await c(); cleanups = [] })

describe('liveness layer end-to-end', () => {
  it('trigger → delta → engine run → recommendation push → phone approval → trust streak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-e2e-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const mock = await startMockNtfy()
    cleanups.push(mock.close)

    const config: MissionConfig = {
      id: 'e2e', goal: 'win', leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0001' }],
      triggers: [{ id: 'poll', kind: 'interval', everyMinutes: 60, precheck: 'mfl-delta', missedPolicy: 'skip', prompt: 'check stuff' }],
      trustLadder: { waiver: { mode: 'ask', promoteAt: 1 } },
    }
    const missionDir = join(dir, 'e2e')
    mkdirSync(missionDir)
    writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(config), 'utf-8')

    const ledger = MissionLedger.load(missionDir)
    ledger.setNextFire('poll', new Date(Date.now() - 1000).toISOString()) // due now
    const ntfy = new NtfyChannel({ baseUrl: mock.url, alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands' })
    const taskRunner = new TaskRunner({
      workDir: join(missionDir, 'tasks'),
      spawnCmd: [process.execPath, STUB],
      isGpuBusyImpl: async () => false,
    })
    const runner = new MissionRunner(ledger, {
      runTask: (input) => taskRunner.run(input),
      publish: (p) => ntfy.publish(p),
      publishRecommendation: (rec) => ntfy.publishRecommendation(rec),
      fetchMflSnapshot: async () => 'delta-hash', // differs from empty lastSeen → fires
      now: () => new Date(),
    })

    // 1. Tick: fires, stub engine runs, recommendation published
    await runner.tick()
    expect(ledger.recentRuns(5).length).toBe(1)
    expect(ledger.recentRuns(5)[0].ok).toBe(true)
    expect(ledger.state.pending['rec-stub']).toBeDefined()
    const recPush = mock.captured.find((c) => c?.actions?.length === 2)
    expect(recPush).toBeDefined()
    expect(recPush.title).toContain('Claim X')

    // 2. Phone approval arrives over SSE → trust streak + promotion (promoteAt: 1)
    const stop = ntfy.subscribe(async (cmd) => { await runner.handleCommand(cmd) })
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300)) // SSE connect
    mock.sendSse({ message: JSON.stringify({ recId: 'rec-stub', verdict: 'approve' }) })
    await new Promise((r) => setTimeout(r, 500))

    expect(ledger.state.pending['rec-stub']).toBeUndefined()
    expect(ledger.state.trust.waiver.approvedStreak).toBe(1)
    const promo = mock.captured.find((c) => c?.title?.match(/promot/i))
    expect(promo).toBeDefined()

    // 3. Second tick with unchanged snapshot → engine NOT spawned again
    ledger.setNextFire('poll', new Date(Date.now() - 1000).toISOString())
    await runner.tick()
    expect(ledger.recentRuns(5).length).toBe(1) // still one run
  }, 30000)
})
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run engine/__tests__/daemon/integration.test.ts`
Expected: 1 passed

- [ ] **Step 3: Run the whole daemon + tools suite**

Run: `npx vitest run engine/__tests__/daemon/ engine/__tests__/tools/mfl.test.ts`
Expected: all new tests pass (taskFile 4, missionLedger 8, scheduler 10, ntfyChannel 5, oneShot 6, taskRunner 7, missionRunner 8, integration 1, mfl 8)

- [ ] **Step 4: Commit**

```bash
git add engine/__tests__/daemon/integration.test.ts
git commit -m "test: liveness layer end-to-end integration (stub engine + mock ntfy)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Setup docs + example mission

**Files:**
- Create: `docs/liveness-setup.md`
- Modify: `README.md` (add a short "Always-on missions" section pointing at the doc — place it after the dashboard/browser section)

- [ ] **Step 1: Write `docs/liveness-setup.md`**

```markdown
# CynCo Liveness Daemon — Setup

The liveness daemon (`engine/daemon/main.ts`) keeps CynCo alive when no session is open:
it schedules mission triggers, polls MFL for changes, wakes the engine for one-shot tasks,
and pushes recommendations to your phone via self-hosted ntfy over Tailscale.
No public ports are opened anywhere in this setup.

## 1. ntfy server (on the CynCo box)

1. Download the Windows binary from https://github.com/binwiederhier/ntfy/releases (or `scoop install ntfy`).
2. Find your Tailscale IP: `tailscale ip -4` (e.g. `100.101.102.103`).
3. Create `ntfy.yml`:

   ```yaml
   listen-http: "100.101.102.103:8090"   # Tailscale interface ONLY — never 0.0.0.0
   auth-file: "C:/cynco/ntfy/auth.db"
   auth-default-access: "deny-all"
   ```

4. Create a user + access tokens:

   ```
   ntfy user add --role=admin cynco
   ntfy token add cynco          # token for the daemon (CYNCO_NTFY_TOKEN)
   ntfy access cynco "cynco-*" rw
   ```

5. Run `ntfy serve --config ntfy.yml` (register it with Task Scheduler the same way as the daemon below).

## 2. Phone

1. Install Tailscale on your phone and join your tailnet.
2. Install the ntfy app, add server `http://100.101.102.103:8090` with the token.
3. Subscribe to `cynco-alerts`. Approve/Reject buttons on recommendations publish back to
   `cynco-commands` automatically — the daemon hears them over its outbound SSE connection.

## 3. MFL credentials (optional but recommended)

Create `~/.cynco/credentials/mfl.json`:

```json
{ "apiKey": "<your MFL API key from League Settings → API>" }
```

Public league data works without a key; the key adds franchise-scoped data and higher rate limits.
The key never appears in prompts, outcomes, or notifications (redacted by the Mfl tool).

## 4. Mission

Create `~/.cynco/missions/mfl-dynasty/mission.json`:

```json
{
  "id": "mfl-dynasty",
  "goal": "Manage my MFL dynasty teams: spot waiver targets, evaluate trades, flag injury risks. Recommend, never act — the user executes approved moves.",
  "leagues": [
    { "leagueId": "12345", "year": 2026, "franchiseId": "0005" }
  ],
  "triggers": [
    {
      "id": "transaction-watch", "kind": "interval", "everyMinutes": 120,
      "precheck": "mfl-delta", "missedPolicy": "skip",
      "prompt": "League transactions changed since the last check. Review what happened (Mfl tool: transactions, rosters, pendingTrades). If anything affects my franchise — a player I should claim, a trade I should consider or counter — produce recommendations. Otherwise return an empty recommendations array."
    },
    {
      "id": "morning-brief", "kind": "daily", "at": "08:00",
      "precheck": "none", "missedPolicy": "run-once-on-startup",
      "prompt": "Morning dynasty brief: check injuries (Mfl tool: injuries) and search the web for news on my rostered players (Mfl: rosters with FRANCHISE filter, then WebSearch). Summarize anything that changes my roster outlook. Recommendations only for actionable items."
    },
    {
      "id": "weekly-digest", "kind": "weekly", "day": "mon", "at": "09:00",
      "precheck": "none", "missedPolicy": "skip",
      "prompt": "Weekly state-of-the-roster digest: standings (Mfl: leagueStandings), roster strengths/weaknesses, future draft picks (Mfl: futureDraftPicks), and 1-3 strategic suggestions for the coming week."
    }
  ],
  "trustLadder": {
    "waiver": { "mode": "ask", "promoteAt": 10 },
    "trade":  { "mode": "ask", "promoteAt": 10 },
    "lineup": { "mode": "ask", "promoteAt": 5 }
  }
}
```

## 5. Daemon autostart (Windows Task Scheduler)

```powershell
schtasks /Create /TN "CynCo Liveness Daemon" /SC ONLOGON /RL LIMITED `
  /TR "cmd /c set CYNCO_NTFY_URL=http://100.101.102.103:8090&& set CYNCO_NTFY_TOKEN=tk_yourtoken&& set LOCALCODE_MODEL=qwen3.6&& set LOCALCODE_PROVIDER=llama-cpp&& cd /d C:\Users\civer\localcode&& bun engine\daemon\main.ts >> %USERPROFILE%\.cynco\daemon.log 2>&1"
```

In Task Scheduler GUI, open the task → Settings → check "If the task fails, restart every 1 minute".
The daemon never loads a model — it spawns `bun engine/main.ts --run-task <file>` per task,
which starts llama-server, runs, and stops it again. If you have an interactive CynCo session
open (llama-server already running), scheduled tasks defer 10 minutes and retry.

## 6. Smoke test

```bash
# Terminal 1: ntfy serve --config ntfy.yml
# Terminal 2:
CYNCO_NTFY_URL=http://100.101.102.103:8090 CYNCO_NTFY_TOKEN=tk_... \
LOCALCODE_MODEL=qwen3.6 LOCALCODE_PROVIDER=llama-cpp \
bun engine/daemon/main.ts
```

Set a trigger's `everyMinutes` to 1 temporarily; within ~90 seconds your phone should get
either recommendations or a digest. Check `~/.cynco/missions/mfl-dynasty/runs.jsonl` for the run record.

## Security posture

- ntfy listens only on the Tailscale interface; phone access requires tailnet membership + token.
- The daemon makes outbound connections only (MFL API, ntfy publish, ntfy SSE).
- The Mfl tool is read-only by whitelist; MFL write endpoints (TYPE=import) are unreachable until Phase C.
- Phone commands are limited to `{recId, verdict}` — free-text commands are not parsed in Phase B.
```

- [ ] **Step 2: Add README section**

In `README.md`, after the dashboard/browser interaction paragraph, add:

```markdown
### Always-on missions (experimental)

CynCo can run as a persistent agent: a tiny daemon schedules mission triggers (e.g. "watch my
fantasy league"), wakes the engine on-demand for one-shot tasks, and pushes recommendations to
your phone via self-hosted [ntfy](https://ntfy.sh) over Tailscale — approve or reject with one tap,
no public ports. See [docs/liveness-setup.md](docs/liveness-setup.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/liveness-setup.md README.md
git commit -m "docs: liveness daemon setup guide (ntfy + Tailscale + Task Scheduler) and README section

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: Wire-check + full suite (BLOCKING)

**Files:** none created — verification only.

- [ ] **Step 1: Grep every new exported symbol and verify it is imported/called somewhere real**

Run each; every symbol must show at least one consumer outside its own file and tests:

```bash
grep -rn "from './taskFile.js'\|from '../taskFile.js'\|daemon/taskFile" engine --include="*.ts" | grep -v __tests__
grep -rn "MissionLedger" engine --include="*.ts" | grep -v __tests__ | grep -v missionLedger.ts
grep -rn "evaluateTrigger\|computeNextFire" engine --include="*.ts" | grep -v __tests__ | grep -v scheduler.ts
grep -rn "NtfyChannel" engine --include="*.ts" | grep -v __tests__ | grep -v ntfyChannel.ts
grep -rn "runOneShotTask" engine --include="*.ts" | grep -v __tests__ | grep -v oneShot.ts
grep -rn "TaskRunner\|isGpuBusy\|GpuBusyError" engine --include="*.ts" | grep -v __tests__ | grep -v taskRunner.ts
grep -rn "MissionRunner" engine --include="*.ts" | grep -v __tests__ | grep -v missionRunner.ts
grep -rn "mflTool" engine --include="*.ts" | grep -v __tests__ | grep -v "impl/mfl.ts"
grep -rn "buildMflExportUrl\|loadMflApiKey" engine --include="*.ts" | grep -v __tests__ | grep -v "impl/mfl.ts"
```

Expected consumers: `taskFile` ← oneShot.ts + taskRunner.ts; `MissionLedger`/`MissionRunner`/`NtfyChannel`/`TaskRunner` ← daemon/main.ts; `evaluateTrigger`/`computeNextFire` ← missionRunner.ts; `runOneShotTask` ← engine/main.ts; `mflTool` ← tools/registry.ts; `buildMflExportUrl`/`loadMflApiKey` ← daemon/main.ts. Any symbol with zero consumers = wiring bug — fix before proceeding.

- [ ] **Step 2: Verify the `--run-task` flag is reachable**

Run: `grep -n "run-task" engine/main.ts engine/daemon/taskRunner.ts docs/liveness-setup.md`
Expected: main.ts parses it, taskRunner passes it, docs mention it.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run 2>&1 | tail -30`
Expected: all daemon/mfl tests pass; ONLY the known pre-existing failures listed in "Repo rules" appear. Any NEW failure must be fixed before the plan is complete.

- [ ] **Step 4: Manual smoke (with the user)**

This step needs the user's real league id + ntfy/Tailscale setup, so coordinate with them:
1. Follow docs/liveness-setup.md §1-§4 with a real league id.
2. Run the daemon with a 1-minute interval trigger.
3. Confirm: phone notification arrives, Approve tap updates `state.json` trust streak, `runs.jsonl` has the run.
4. Restore the trigger to its real cadence.

- [ ] **Step 5: Final commit + report**

```bash
git status   # verify nothing unexpected; commit any stragglers by explicit path
```

Report completion to the user with: test counts, the wire-check table, and what the manual smoke test still needs from them (league id, ntfy install, Tailscale on phone).

---

## Self-review notes (already applied)

- Spec coverage: daemon (§2→Tasks 8), ledger (§3→Task 3), one-shot (§4→Task 6), MFL tool (§5→Task 2), ntfy/approvals (§6→Tasks 5, 8), error handling (§7→Tasks 7, 8: timeout kill, failure streak alert, GPU defer, ntfy offline queue, Task Scheduler restart documented), testing (§8→every task + Task 9 + Task 11 wire-check), trust ladder Phase C preview (→Task 3 promotionEligible + Task 8 promotion notification, mode never auto-flips).
- Type consistency: `TaskFileInput.outcomePath` is filled by `TaskRunner.run` when empty (missionRunner passes `''`); `ApprovalResolution.promotionEligible` used by both Task 3 tests and Task 8.
- Deliberate scope cuts (out of scope per spec): Phase C writes, Sleeper, free-text commands, dashboard visibility of missions.
- Spec-compliance fixes landed after final review: one-shot mode runs the real S5/VSM-governed conversation loop (§4), task context = handoff-format YAML + roster snapshot (§3), nvidia-smi in the GPU guard + escalating defer backoff (§2/§7), cron expression triggers (§2).
