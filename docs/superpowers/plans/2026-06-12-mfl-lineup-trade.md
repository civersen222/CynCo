# MFL Full Lineup + Trade Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full suggested-lineup delivery (richer weekly digest + on-demand phone command) and a weekly daemon-orchestrated league-wide trade scan, per spec `docs/superpowers/specs/2026-06-12-mfl-lineup-trade-design.md`.

**Architecture:** Three new MFL queries feed lineup/trade reasoning. Phone text commands (`lineup [N]`) ride the existing ntfy SSE long-poll as a new `CommandMessage` union member and queue on-demand runs drained by the daemon tick. The trade scan is one engine process (`taskType: 'trade-scan'`) that runs deterministic MFL fetches, 11 tool-free per-rival completions, then one governed ranking loop emitting the standard outcome contract.

**Tech Stack:** TypeScript (Bun), bun:test via `npx vitest run`, MFL export API, ntfy.

**Branch:** `liveness-layer` (continue on it — no new branch, per user decision).

**Conventions you must know:**
- Imports use `.js` extensions (`import { x } from './y.js'`).
- Tests run from repo root: `npx vitest run engine/__tests__/<path>`. Full suite baseline is **34 failing tests across 10 files** (governanceDb, config, dashboard/server EADDRINUSE flake, callModel, predictionDb, profiles/loader, treeSitterChunker, executor, glob, configHandlers) — any NEW failing file is a regression.
- `engine/` contains a nested git repo — never run git with cwd inside `engine/`; always commit from repo root.
- The spec file (committed) is the source of truth for requirements.
- `docs/superpowers/` is gitignored but specs/plans are tracked by precedent — use `git add -f` for plan/spec files only. Code/test files stage normally.

**File map (what each task touches):**

| File | Responsibility | Task |
|---|---|---|
| `engine/tools/impl/mfl.ts` | whitelist `projectedScores`, `playerRanks`, `nflSchedule` | 1 |
| `engine/daemon/types.ts` | `CommandMessage` union; `TriggerSpec.taskType`; `TaskFileInput.taskType/leagues`; `MissionConfig.commands` | 2, 3 |
| `engine/daemon/ntfyChannel.ts` | SSE parser emits approval OR text commands | 2 |
| `engine/daemon/missionRunner.ts` | `handleTextCommand`, on-demand queue + drain, taskType timeout/passthrough | 3 |
| `engine/daemon/main.ts` | route text commands to runners | 4 |
| `engine/daemon/oneShot.ts` | extract `runGovernedLoop`; dispatch `taskType: 'trade-scan'` | 5 |
| `engine/daemon/tradeScan.ts` (new) | multi-pass orchestrator | 6 |
| `C:\Users\civer\.cynco\missions\mfl-dynasty\mission.json` | digest prompt rewrite, `commands.lineup`, trade-scan trigger | 7 |

---

### Task 1: MFL whitelist — projectedScores, playerRanks, nflSchedule

**Files:**
- Modify: `engine/tools/impl/mfl.ts:6-23`
- Test: `engine/__tests__/tools/mfl.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('buildMflExportUrl', ...)` block in `engine/__tests__/tools/mfl.test.ts`:

```ts
  it('allows projectedScores with L (league scoring rules) and a week param', () => {
    const url = buildMflExportUrl({ query: 'projectedScores', league: '65042', year: 2026, extra: { W: '3' } })
    expect(url).toContain('TYPE=projectedScores')
    expect(url).toContain('L=65042')
    expect(url).toContain('W=3')
  })

  it('playerRanks and nflSchedule are global queries — no L param', () => {
    // Same 302-redirect failure mode as injuries (see GLOBAL_QUERIES comment).
    for (const q of ['playerRanks', 'nflSchedule']) {
      const url = buildMflExportUrl({ query: q, league: '65042', year: 2026 })
      expect(url).toContain(`TYPE=${q}`)
      expect(url).not.toContain('L=65042')
    }
  })
```

And inside `describe('Mfl tool', ...)`:

```ts
  it('accepts the new lineup/trade queries through the whitelist', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fakeFetch)
    for (const q of ['projectedScores', 'playerRanks', 'nflSchedule']) {
      const result = await mflTool.execute({ query: q, league: '65042', year: 2026 }, {} as any)
      expect(result.isError).toBe(false)
    }
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/tools/mfl.test.ts`
Expected: the 3 new tests FAIL — `accepts the new lineup/trade queries` gets `isError: true` ("not allowed"); the URL tests fail because `buildMflExportUrl` doesn't treat the new queries specially yet (the `playerRanks` test fails on `L=65042` being present). Existing tests PASS.

- [ ] **Step 3: Implement**

In `engine/tools/impl/mfl.ts`, extend the two sets:

```ts
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
  'projectedScores', // weekly projections under THIS league's scoring (W=week)
  'playerRanks',     // dynasty trade-value rankings (global)
  'nflSchedule',     // NFL matchups + byes for a week (global, W=week)
])

// Global (league-independent) queries. Sending L= makes api.myfantasyleague.com
// 302 to the league host, which rejects these TYPEs with "must go to
// api.myfantasyleague.com" (2026-06-12 weekly-digest incident). Omit L.
const GLOBAL_QUERIES = new Set(['injuries', 'playerRanks', 'nflSchedule'])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/tools/mfl.test.ts`
Expected: ALL tests PASS.

- [ ] **Step 5: Live-verify the global-vs-league split** (the spec requires this; the API is free/read-only)

```bash
curl -s "https://api.myfantasyleague.com/2026/export?TYPE=playerRanks&JSON=1" | head -c 300
curl -s "https://api.myfantasyleague.com/2026/export?TYPE=nflSchedule&W=1&JSON=1" | head -c 300
curl -s "https://api.myfantasyleague.com/2026/export?TYPE=projectedScores&L=65042&W=1&JSON=1" | head -c 300
```

Expected: each returns JSON (not an error string like "must go to api.myfantasyleague.com" or an HTML redirect page). If `projectedScores` errors without an APIKEY, re-run with `&APIKEY=<key from C:\Users\civer\.cynco\credentials\mfl.json>`. If a "global" query demands `L`, move it OUT of `GLOBAL_QUERIES`, flip the test expectation, and note why in the commit.

- [ ] **Step 6: Commit**

```bash
git add engine/tools/impl/mfl.ts engine/__tests__/tools/mfl.test.ts
git commit -m "feat: whitelist projectedScores/playerRanks/nflSchedule MFL queries"
```

---

### Task 2: CommandMessage union + ntfy text-command parsing

**Files:**
- Modify: `engine/daemon/types.ts:99-103` (CommandMessage)
- Modify: `engine/daemon/ntfyChannel.ts:104-126` (publishRecommendation body), `:170-183` (SSE parser)
- Test: `engine/__tests__/daemon/ntfyChannel.test.ts`

- [ ] **Step 1: Update the CommandMessage type**

In `engine/daemon/types.ts`, replace the existing `CommandMessage` interface (lines 99-103) with:

```ts
export interface ApprovalCommand {
  kind: 'approval'
  recId: string
  verdict: 'approve' | 'reject'
}

/** Free-text phone command (e.g. "lineup 5") published to the command topic. */
export interface TextCommand {
  kind: 'text'
  text: string
}

export type CommandMessage = ApprovalCommand | TextCommand
```

This will break compilation of `ntfyChannel.ts` and `missionRunner.ts` — expected; the next steps and Task 3 fix them.

- [ ] **Step 2: Write the failing tests**

In `engine/__tests__/daemon/ntfyChannel.test.ts`:

(a) Update the approve/reject button-body assertion in `'attaches approve/reject http actions...'` (button bodies now carry `kind`):

```ts
    expect(JSON.parse(actions[0].body)).toEqual({ kind: 'approval', recId: 'rec-9', verdict: 'approve' })
    expect(JSON.parse(actions[1].body)).toEqual({ kind: 'approval', recId: 'rec-9', verdict: 'reject' })
```

(b) Update `'receives commands over SSE'` — the emitted command now has `kind` (and the parser must accept legacy bodies without `kind`, since old notifications' buttons still send them):

```ts
    mock.sendSse({ message: JSON.stringify({ recId: 'rec-1', verdict: 'approve' }) }) // legacy body, no kind
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got).toEqual([{ kind: 'approval', recId: 'rec-1', verdict: 'approve' }])
```

(c) Replace `'ignores malformed SSE messages'` with:

```ts
  it('non-approval messages become text commands; empty messages are ignored', async () => {
    const mock = await startMockNtfy()
    cleanup = mock.close
    const ch = new NtfyChannel({ baseUrl: mock.url, alertTopic: 'a', commandTopic: 'c' })
    const got: any[] = []
    const stop = ch.subscribe((cmd) => got.push(cmd))
    await new Promise((r) => setTimeout(r, 200))
    mock.sendSse({ message: 'lineup 5' })                          // plain text → text command
    mock.sendSse({ message: JSON.stringify({ nope: true }) })      // JSON but not approval → text command
    mock.sendSse({ message: '   ' })                               // whitespace only → ignored
    mock.sendSse({})                                               // no message field (keepalive) → ignored
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(got).toEqual([
      { kind: 'text', text: 'lineup 5' },
      { kind: 'text', text: '{"nope":true}' },
    ])
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/daemon/ntfyChannel.test.ts`
Expected: FAIL — (a) bodies lack `kind`, (b) emitted commands lack `kind`, (c) plain text is currently dropped. (TypeScript errors from the union change may also surface.)

- [ ] **Step 4: Implement**

In `engine/daemon/ntfyChannel.ts`:

(a) `publishRecommendation` action body (line ~112) — add `kind`:

```ts
      body: JSON.stringify({ kind: 'approval', recId: rec.id, verdict } satisfies CommandMessage),
```

(b) Replace the SSE event-parsing block inside `subscribe` (currently lines 173-182, the `if (!line.startsWith('data:')) continue` block's body) with:

```ts
              if (!line.startsWith('data:')) continue
              try {
                const event = JSON.parse(line.slice(5).trim())
                const raw = typeof event.message === 'string' ? event.message : ''
                if (!raw.trim()) continue // keepalive/open events or blank messages
                let cmd: CommandMessage | null = null
                try {
                  const parsed = JSON.parse(raw)
                  // Accept approval bodies with or without kind — buttons on
                  // notifications published before this change carry no kind.
                  if ((parsed?.verdict === 'approve' || parsed?.verdict === 'reject') && typeof parsed?.recId === 'string') {
                    cmd = { kind: 'approval', recId: parsed.recId, verdict: parsed.verdict }
                  }
                } catch {
                  // not JSON — fall through to text command
                }
                if (!cmd) cmd = { kind: 'text', text: raw.trim() }
                onCommand(cmd)
              } catch {
                // malformed SSE event — ignore
              }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/daemon/ntfyChannel.test.ts`
Expected: ALL PASS. (`missionRunner.ts`/`main.ts` may still have type errors — fixed in Tasks 3-4; vitest compiles per-file so this test file runs.)

- [ ] **Step 6: Commit**

```bash
git add engine/daemon/types.ts engine/daemon/ntfyChannel.ts engine/__tests__/daemon/ntfyChannel.test.ts
git commit -m "feat: ntfy command channel carries text commands alongside approvals"
```

---

### Task 3: MissionRunner — text commands, on-demand queue, taskType plumbing

**Files:**
- Modify: `engine/daemon/types.ts` (TriggerSpec, MissionConfig, TaskFileInput)
- Modify: `engine/daemon/missionRunner.ts`
- Test: `engine/__tests__/daemon/missionRunner.test.ts`

- [ ] **Step 1: Extend the daemon types**

In `engine/daemon/types.ts`:

(a) Add to `TriggerSpec` (after the `prompt` field):

```ts
  /** 'prompt' (default): single governed run of `prompt`. 'trade-scan': multi-pass orchestrator (engine/daemon/tradeScan.ts). */
  taskType?: 'prompt' | 'trade-scan'
```

(b) Add to `MissionConfig` (after `trustLadder`):

```ts
  /** On-demand phone command prompt templates, e.g. { lineup: "...for {week}..." }. */
  commands?: Record<string, string>
```

(c) Add to `TaskFileInput` (after `outcomePath`):

```ts
  /** Mirrors TriggerSpec.taskType. Absent = 'prompt'. */
  taskType?: 'prompt' | 'trade-scan'
  /** League refs for orchestrated tasks (trade-scan needs structured ids, not just the context string). */
  leagues?: MflLeagueRef[]
```

- [ ] **Step 2: Write the failing tests**

In `engine/__tests__/daemon/missionRunner.test.ts`:

(a) The test `config` const gets a commands template and a trade-scan trigger (replace the existing const):

```ts
const config: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Win the league',
  leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0005' }],
  triggers: [
    { id: 'poll', kind: 'interval', everyMinutes: 60, precheck: 'mfl-delta', missedPolicy: 'skip', prompt: 'Check transactions' },
    { id: 'news', kind: 'interval', everyMinutes: 120, precheck: 'none', missedPolicy: 'skip', prompt: 'Check news' },
  ],
  trustLadder: { waiver: { mode: 'ask', promoteAt: 2 } },
  commands: { lineup: 'Produce a full suggested starting lineup for {week}.' },
}
```

(b) Update the two existing `handleCommand` tests to pass the union member:

```ts
    const handled = await runner.handleCommand({ kind: 'approval', recId: 'rec-7', verdict: 'approve' })
```
```ts
    expect(await runner.handleCommand({ kind: 'approval', recId: 'nope', verdict: 'approve' })).toBe(false)
```

(c) Append a new describe block:

```ts
describe('MissionRunner text commands + on-demand queue', () => {
  function freshRunner(overrides: Partial<any> = {}) {
    const made = makeDeps(overrides)
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    // Park both scheduled triggers in the future so only on-demand work fires
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    return { ...made, ledger, runner: new MissionRunner(ledger, made.deps as any) }
  }

  it('handleTextCommand("lineup") queues a request and publishes an ack', async () => {
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup')
    expect(ranTasks.length).toBe(0) // never runs a model from the command handler
    expect(published.length).toBe(1)
    expect(published[0].title).toMatch(/queued/i)
    expect(published[0].message).toContain('upcoming week')
  })

  it('handleTextCommand("lineup 5") parses the week; tick drains it through the fire path', async () => {
    const { runner, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup 5')
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('on-demand-lineup')
    expect(ranTasks[0].prompt).toBe('Produce a full suggested starting lineup for week 5.')
    // Drained: a second tick must not re-run it
    await runner.tick()
    expect(ranTasks.length).toBe(1)
  })

  it('"lineup" without a week substitutes "the upcoming week" into the template', async () => {
    const { runner, ranTasks } = freshRunner()
    await runner.handleTextCommand('LINEUP') // case-insensitive
    await runner.tick()
    expect(ranTasks[0].prompt).toBe('Produce a full suggested starting lineup for the upcoming week.')
  })

  it('unknown text publishes help and queues nothing', async () => {
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('make me a sandwich')
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(published.length).toBe(1)
    expect(published[0].message).toMatch(/lineup/)
  })

  it('missing commands.lineup template publishes an error and queues nothing', async () => {
    // Rewrite mission.json without commands, reload
    const noCmd = { ...config, commands: undefined }
    writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(noCmd), 'utf-8')
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup')
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(published[0].title).toMatch(/unavailable/i)
  })

  it('GPU busy keeps the request queued with a retry-at backoff, then runs when free', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    let busy = true
    let nowMs = new Date(2026, 5, 11, 12, 0, 0).getTime()
    const { runner, ranTasks } = freshRunner({
      runTask: async (input: any): Promise<TaskOutcome> => {
        if (busy) throw new GpuBusyError()
        ranTasks.push(input)
        return { ok: true, summary: 'ran', recommendations: [] }
      },
      now: () => new Date(nowMs),
    })
    await runner.handleTextCommand('lineup')
    await runner.tick() // GPU busy → deferred, still queued
    expect(ranTasks.length).toBe(0)
    await runner.tick() // before retry-at → still waiting, no run attempt
    expect(ranTasks.length).toBe(0)
    busy = false
    nowMs += 6 * 60000 // past the 5-min base defer
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('on-demand-lineup')
  })

  it('on-demand outcome with recommendations publishes them as pending', async () => {
    const { runner, ledger, published } = freshRunner()
    await runner.handleTextCommand('lineup')
    await runner.tick()
    // makeDeps default runTask returns rec-1
    expect(ledger.state.pending['rec-1']).toBeDefined()
    const recPublish = published.find((p) => p.id === 'rec-1')
    expect(recPublish).toBeDefined()
  })
})

describe('MissionRunner taskType plumbing', () => {
  it('trade-scan triggers get a 60-minute timeout and taskType/leagues passthrough', async () => {
    const scanConfig: MissionConfig = {
      ...config,
      triggers: [{ id: 'trade-scan', kind: 'weekly', day: 'tue', at: '09:00', precheck: 'none', missedPolicy: 'skip', prompt: 'Rank trades', taskType: 'trade-scan' }],
    }
    writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(scanConfig), 'utf-8')
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('trade-scan', new Date(2026, 5, 11, 11, 59).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].taskType).toBe('trade-scan')
    expect(ranTasks[0].timeoutMs).toBe(60 * 60 * 1000)
    expect(ranTasks[0].leagues).toEqual([{ leagueId: '12345', year: 2026, franchiseId: '0005' }])
  })

  it('plain prompt triggers keep the 15-minute timeout and carry leagues', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks[0].timeoutMs).toBe(15 * 60 * 1000)
    expect(ranTasks[0].taskType).toBeUndefined()
    expect(ranTasks[0].leagues).toEqual([{ leagueId: '12345', year: 2026, franchiseId: '0005' }])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/daemon/missionRunner.test.ts`
Expected: new tests FAIL (`handleTextCommand` is not a function; `taskType`/`leagues`/timeout assertions fail). The two updated `handleCommand` tests PASS only after Step 4 (type errors until then are fine).

- [ ] **Step 4: Implement**

In `engine/daemon/missionRunner.ts`:

(a) Update imports and constants:

```ts
import type { ApprovalCommand, MissionConfig, Recommendation, TaskFileInput, TaskOutcome, TriggerSpec } from './types.js'
```
(keep the other imports; `CommandMessage` is no longer referenced here)

```ts
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const TRADE_SCAN_TIMEOUT_MS = 60 * 60 * 1000
```

(b) Add the queue field and a fire-result type (above the class):

```ts
type FireResult = { status: 'ran' } | { status: 'gpu-deferred'; retryAtMs: number }
```

Inside the class, next to `gpuDefers`:

```ts
  /** Queued on-demand phone requests, drained by tick(). In-memory by design —
   *  a daemon restart drops them; the user just resends the command. */
  private onDemand: { week?: number; notBefore?: number }[] = []
```

(c) `tick()` drains on-demand work first:

```ts
  async tick(): Promise<void> {
    const now = this.deps.now()
    await this.drainOnDemand(now)
    for (const trigger of this.ledger.config.triggers) {
      const evaln = evaluateTrigger(trigger, this.ledger.state.nextFire[trigger.id], now)
      if (evaln.action === 'wait') continue
      this.ledger.setNextFire(trigger.id, evaln.next.toISOString())
      // Persist BEFORE firing: a crash mid-run must not re-fire the trigger
      // on restart with the old nextFire still on disk.
      this.ledger.saveState()
      if (evaln.action === 'init' || evaln.action === 'skip') continue
      await this.fire(trigger, now)
    }
    this.ledger.saveState()
  }

  private async drainOnDemand(now: Date): Promise<void> {
    while (this.onDemand.length > 0) {
      const req = this.onDemand[0]
      if (req.notBefore !== undefined && now.getTime() < req.notBefore) return
      const template = this.ledger.config.commands?.['lineup']
      if (!template) { this.onDemand.shift(); continue } // template vanished since queuing — drop
      const prompt = template.replace(/\{week\}/g, req.week !== undefined ? `week ${req.week}` : 'the upcoming week')
      const trigger: TriggerSpec = {
        id: 'on-demand-lineup', kind: 'daily', precheck: 'none', missedPolicy: 'skip', prompt,
      }
      const result = await this.fire(trigger, now)
      if (result.status === 'gpu-deferred') {
        req.notBefore = result.retryAtMs
        return
      }
      this.onDemand.shift()
    }
  }
```

(d) `fire()` — change the signature to return `FireResult`, select timeout by taskType, pass through `taskType`/`leagues`, and guard `setNextFire` against synthetic trigger ids. Full updated method (replacing the existing one; the precheck/context/outcome logic is unchanged except where noted):

```ts
  private async fire(trigger: TriggerSpec, now: Date): Promise<FireResult> {
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
      if (!anyDelta) return { status: 'ran' }
    }

    // Mission context (spec §3): goal + last 3 run summaries in the existing
    // handoff format (engine/memory/handoff.ts YAML), plus a roster snapshot
    // per league fetched by the daemon directly — no inference, one HTTP call.
    const handoffYaml = serializeHandoff({
      goal: this.ledger.config.goal,
      now: `Scheduled trigger "${trigger.id}" fired at ${now.toISOString()}`,
      status: 'in_progress',
      what_was_done: this.ledger.recentRuns(3).map(
        (r) => `[${r.ts}] ${r.triggerId} ${r.ok ? 'ok' : 'FAILED'}: ${r.summary.slice(0, 200)}`,
      ),
    })
    const rosterSections: string[] = []
    for (const league of this.ledger.config.leagues) {
      let snapshot: string
      try {
        snapshot = await this.deps.fetchRosterSnapshot(league.leagueId, league.year, league.franchiseId)
      } catch (err) {
        // Don't block the run — the model has the Mfl tool to fetch it itself
        snapshot = `(roster unavailable: ${err instanceof Error ? err.message : String(err)})`
      }
      rosterSections.push(
        `League ${league.leagueId} (year ${league.year}, your franchise ${league.franchiseId}) roster snapshot:\n${snapshot}`,
      )
    }
    const context = [handoffYaml.trimEnd(), ...rosterSections].join('\n\n')

    const input: TaskFileInput = {
      missionId: this.ledger.config.id,
      triggerId: trigger.id,
      prompt: trigger.prompt,
      context,
      allowedTools: DEFAULT_TOOLS,
      timeoutMs: trigger.taskType === 'trade-scan' ? TRADE_SCAN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      outcomePath: '', // TaskRunner fills this in
      ...(trigger.taskType ? { taskType: trigger.taskType } : {}),
      leagues: this.ledger.config.leagues,
    }

    let outcome: TaskOutcome
    try {
      outcome = await this.deps.runTask(input)
      this.gpuDefers.delete(trigger.id) // GPU was free — reset the backoff
    } catch (err) {
      if (err instanceof GpuBusyError) {
        // Defer with escalating backoff, don't count as failure
        const defers = this.gpuDefers.get(trigger.id) ?? 0
        const deferMs = Math.min(GPU_DEFER_BASE_MS * 2 ** defers, GPU_DEFER_MAX_MS)
        this.gpuDefers.set(trigger.id, defers + 1)
        console.log(`[mission:${this.ledger.config.id}] GPU busy — deferring trigger "${trigger.id}" by ${deferMs / 60000} min (defer #${defers + 1})`)
        // Synthetic (on-demand) triggers are not in config.triggers — keep
        // their bookkeeping out of state.json nextFire.
        if (this.ledger.config.triggers.some((t) => t.id === trigger.id)) {
          this.ledger.setNextFire(trigger.id, new Date(now.getTime() + deferMs).toISOString())
        }
        return { status: 'gpu-deferred', retryAtMs: now.getTime() + deferMs }
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
      // Persist before notifying: crash between saveState and publish is safe —
      // the streak survives and no notification is pending.
      this.ledger.saveState()
      if (this.ledger.state.failureStreak >= FAILURE_ALERT_THRESHOLD) {
        await this.deps.publish({
          title: `CynCo stuck on mission ${this.ledger.config.id}`,
          message: `${this.ledger.state.failureStreak} consecutive failures. Last error: ${outcome.error ?? 'unknown'}`,
          priority: 5,
        })
      }
      return { status: 'ran' }
    }

    this.ledger.state.failureStreak = 0
    for (const rec of outcome.recommendations) {
      this.ledger.addPending(rec)
    }
    // Persist all ledger mutations BEFORE any phone notifications.
    // If the daemon crashes after saveState but before a publish, the
    // pending is on disk and the user can re-check; the reverse would
    // produce an approve/reject button with no matching pending.
    this.ledger.saveState()
    for (const rec of outcome.recommendations) {
      await this.deps.publishRecommendation(rec)
    }
    if (outcome.recommendations.length === 0 && trigger.precheck === 'none') {
      // Digest-style runs report even when nothing is actionable
      await this.deps.publish({ title: `Mission ${this.ledger.config.id}: ${trigger.id}`, message: outcome.summary })
    }
    return { status: 'ran' }
  }
```

(e) `handleCommand` — retype to `ApprovalCommand` (body unchanged):

```ts
  /** Handle an approve/reject command from the phone. Returns false if the recId is unknown to this mission. */
  async handleCommand(cmd: ApprovalCommand): Promise<boolean> {
```

(f) New `handleTextCommand` (after `handleCommand`):

```ts
  /** Handle a free-text phone command. Recognized commands are queued for the
   *  next tick — a model run NEVER starts from the SSE callback. */
  async handleTextCommand(text: string): Promise<void> {
    const trimmed = text.trim()
    const m = /^lineup(?:\s+(\d{1,2}))?$/i.exec(trimmed)
    if (!m) {
      await this.deps.publish({
        title: 'Unknown command',
        message: `"${trimmed.slice(0, 80)}" — valid commands: "lineup" (upcoming week) or "lineup <week>"`,
      })
      return
    }
    if (!this.ledger.config.commands?.['lineup']) {
      await this.deps.publish({
        title: 'Lineup command unavailable',
        message: 'mission.json has no commands.lineup prompt template.',
      })
      return
    }
    const week = m[1] !== undefined ? parseInt(m[1], 10) : undefined
    this.onDemand.push({ week })
    await this.deps.publish({
      title: 'Lineup queued',
      message: `Suggested lineup for ${week !== undefined ? `week ${week}` : 'the upcoming week'} — report arrives in a few minutes.`,
    })
  }
```

Also import `MflLeagueRef` is NOT needed here (leagues come straight off `this.ledger.config.leagues`); remove `MissionConfig` from the import line if unused — final import line:

```ts
import type { ApprovalCommand, Recommendation, TaskFileInput, TaskOutcome, TriggerSpec } from './types.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/daemon/missionRunner.test.ts`
Expected: ALL PASS (existing scheduler/GPU/failure tests must still pass — `fire()`'s behavior for scheduled triggers is unchanged, only its return type is new).

- [ ] **Step 6: Commit**

```bash
git add engine/daemon/types.ts engine/daemon/missionRunner.ts engine/__tests__/daemon/missionRunner.test.ts
git commit -m "feat: on-demand lineup phone command + trade-scan taskType plumbing in MissionRunner"
```

---

### Task 4: Daemon entry — route text commands

**Files:**
- Modify: `engine/daemon/main.ts:79-89`

No unit test (main.ts is the untested composition root, consistent with the codebase); correctness is covered by the Task 3 unit tests + Task 9 live verification. Type-check instead.

- [ ] **Step 1: Implement**

Replace the subscribe callback (lines 79-89) with:

```ts
// Phone commands: approvals → first mission that knows the recId;
// text commands (e.g. "lineup 5") → every mission runner.
const stopSubscription = ntfy.subscribe(async (cmd) => {
  try {
    if (cmd.kind === 'text') {
      for (const runner of runners) await runner.handleTextCommand(cmd.text)
      return
    }
    for (const runner of runners) {
      if (await runner.handleCommand(cmd)) return
    }
    console.log(`[daemon] Command for unknown recId: ${cmd.recId}`)
  } catch (err) {
    console.error('[daemon] command handling failed:', err)
  }
})
```

- [ ] **Step 2: Type-check the daemon**

Run: `bun build engine/daemon/main.ts --target=bun --outdir=/tmp/cynco-typecheck 2>&1 | tail -5`
Expected: no TypeScript/resolution errors. (Delete `/tmp/cynco-typecheck` after.)

- [ ] **Step 3: Commit**

```bash
git add engine/daemon/main.ts
git commit -m "feat: daemon routes ntfy text commands to mission runners"
```

---

### Task 5: oneShot — extract runGovernedLoop + trade-scan dispatch

**Files:**
- Modify: `engine/daemon/oneShot.ts:81-136` (runOneShotTask)
- Test: `engine/__tests__/daemon/oneShot.test.ts`

`runGovernedLoop` is extracted so the trade scan's ranking pass (Task 6) reuses the exact loop construction instead of duplicating it. The dispatch takes an injectable `tradeScanImpl` so the unit test doesn't need the real orchestrator.

- [ ] **Step 1: Write the failing tests**

Append to `engine/__tests__/daemon/oneShot.test.ts` (top-level, after the existing describes — note these do NOT need `CYNCO_INTEGRATION`, they never construct a ConversationLoop):

```ts
describe('runOneShotTask trade-scan dispatch', () => {
  function makeConfig() {
    return {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto' as const,
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: undefined, tools: undefined,
    }
  }
  const noopProvider = {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { throw new Error('unused') },
    async complete() { throw new Error('unused') },
    async *stream() { throw new Error('unused') },
  } as unknown as Provider

  it("taskType 'trade-scan' routes to the injected orchestrator and writes its outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-ts-'))
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'trade-scan', prompt: 'Rank trades', context: 'ctx',
        allowedTools: ['Mfl'], timeoutMs: 60000, outcomePath: join(dir, 'out.json'),
        taskType: 'trade-scan',
        leagues: [{ leagueId: '65042', year: 2026, franchiseId: '0003' }],
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      const seen: TaskFileInput[] = []
      const fakeScan = async (t: TaskFileInput) => {
        seen.push(t)
        return { ok: true, summary: 'scan done', recommendations: [] }
      }
      const code = await runOneShotTask(taskPath, noopProvider, makeConfig() as any, fakeScan)
      expect(code).toBe(0)
      expect(seen.length).toBe(1)
      expect(seen[0].leagues?.[0]?.franchiseId).toBe('0003')
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.summary).toBe('scan done')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a failed scan outcome yields exit code 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-ts-'))
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'trade-scan', prompt: 'p', context: 'c',
        allowedTools: [], timeoutMs: 60000, outcomePath: join(dir, 'out.json'),
        taskType: 'trade-scan',
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      const fakeScan = async () => ({ ok: false, summary: '', recommendations: [], error: 'too few passes' })
      const code = await runOneShotTask(taskPath, noopProvider, makeConfig() as any, fakeScan)
      expect(code).toBe(1)
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.error).toBe('too few passes')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/daemon/oneShot.test.ts`
Expected: the 2 new tests FAIL (`runOneShotTask` has no 4th parameter; trade-scan task runs the normal loop path and blows up on the noop provider / wrong outcome). Existing extractOutcome/buildOneShotPrompt tests PASS.

- [ ] **Step 3: Implement**

In `engine/daemon/oneShot.ts`, replace `runOneShotTask` (lines 81-136) with the extracted helper + dispatching task runner. `collectAssistantText` stays as-is.

First, update the type import at the top of `oneShot.ts` (add `TaskFileInput`):

```ts
import type { Recommendation, TaskFileInput, TaskOutcome } from './types.js'
```

Then the replacement code:

```ts
export type TradeScanImpl = (
  task: TaskFileInput,
  provider: Provider,
  config: LocalCodeConfig,
) => Promise<TaskOutcome>

/** Run one prompt through the real S5/VSM-governed conversation loop and
 *  extract the outcome contract. Shared by plain one-shot tasks and the
 *  trade scan's ranking pass. */
export async function runGovernedLoop(opts: {
  prompt: string
  context: string
  allowedTools: string[]
  timeoutMs: number
  provider: Provider
  config: LocalCodeConfig
}): Promise<TaskOutcome> {
  // Same S5 selection as interactive startup (main.ts): LoRA-trained
  // decision model when configured, rule-based otherwise.
  const s5Impl = process.env.LOCALCODE_S5_MODEL
    ? new ModelS5({ model: process.env.LOCALCODE_S5_MODEL, baseUrl: opts.config.baseUrl })
    : new RuleBasedS5()
  const s5 = new S5Orchestrator(s5Impl)

  const loop = new ConversationLoop({
    // unattended: read-only mission tools, no TUI to ask; scouts disabled —
    // codebase scouting is irrelevant to mission tasks and burns GPU time
    config: { ...opts.config, approveAll: true, noScouts: true },
    provider: opts.provider,
    emit: () => {}, // headless — no TUI, no dashboard
    cwd: process.cwd(),
    s5,
    allowedTools: opts.allowedTools,
  })

  // Internal deadline backstop (the daemon also enforces a hard kill).
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; loop.abort() }, opts.timeoutMs)
  try {
    await loop.handleUserMessage(buildOneShotPrompt(opts.context, opts.prompt))
  } finally {
    clearTimeout(timer)
  }

  const collectedText = collectAssistantText(loop.getMessages())
  if (timedOut) {
    return { ok: false, summary: collectedText.slice(-1000), recommendations: [], error: 'Internal deadline exceeded' }
  }
  return extractOutcome(collectedText)
}

export async function runOneShotTask(
  taskFilePath: string,
  provider: Provider,
  config: LocalCodeConfig,
  tradeScanImpl?: TradeScanImpl,
): Promise<number> {
  let outcomePath = ''
  try {
    const task = readTaskFile(taskFilePath)
    outcomePath = task.outcomePath
    console.log(`[one-shot] Mission ${task.missionId} / trigger ${task.triggerId}`)

    let outcome: TaskOutcome
    if (task.taskType === 'trade-scan') {
      // Lazy import keeps oneShot ↔ tradeScan acyclic at load time
      const impl = tradeScanImpl ?? (await import('./tradeScan.js')).runTradeScan
      outcome = await impl(task, provider, config)
    } else {
      outcome = await runGovernedLoop({
        prompt: task.prompt,
        context: task.context,
        allowedTools: task.allowedTools,
        timeoutMs: task.timeoutMs,
        provider,
        config,
      })
    }

    writeOutcome(outcomePath, outcome)
    console.log(`[one-shot] Outcome written: ${outcomePath}`)
    return outcome.ok ? 0 : 1
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

Behavior note: exit code was previously 0-unless-throw/timeout; it is now `outcome.ok ? 0 : 1`. `extractOutcome` always returns `ok: true` and the timeout path returns `ok: false`, so existing behavior is preserved; only failed trade scans add a new `1`.

(Step 1's test file also needs `runOneShotTask`'s import — it's already imported at the top of the test file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/daemon/oneShot.test.ts`
Expected: ALL PASS (the gated integration test stays skipped without `CYNCO_INTEGRATION=1`).

Then run the integration test against the refactor (it exercises `runGovernedLoop` through `runOneShotTask`):

Run: `CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/daemon/oneShot.test.ts`
Expected: ALL PASS including `runs the task through the real conversation loop with restricted tools`.

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/oneShot.ts engine/__tests__/daemon/oneShot.test.ts
git commit -m "refactor: extract runGovernedLoop; dispatch trade-scan tasks to orchestrator"
```

---

### Task 6: tradeScan.ts — multi-pass orchestrator

**Files:**
- Create: `engine/daemon/tradeScan.ts`
- Test: `engine/__tests__/daemon/tradeScan.test.ts` (new)

All side effects (MFL fetches, model completions, ranking loop, intermediate files, logging) are injected via a deps object — the same pattern as MissionRunner — so the whole orchestration is testable without network/GPU.

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/daemon/tradeScan.test.ts`:

```ts
// engine/__tests__/daemon/tradeScan.test.ts
import { describe, expect, it } from 'bun:test'
import { parseCandidates, runTradeScan, type TradeScanDeps } from '../../daemon/tradeScan.js'
import type { TaskFileInput, TaskOutcome } from '../../daemon/types.js'

describe('parseCandidates', () => {
  it('parses the last fenced json block with a candidates array', () => {
    const text = [
      'reasoning...',
      '```json', '{"candidates": []}', '```',
      'wait, actually:',
      '```json',
      '{"candidates": [{"give": ["G. Pickens"], "get": ["B. Robinson"], "rationale": "RB need"}]}',
      '```',
    ].join('\n')
    const got = parseCandidates(text)
    expect(got).toEqual([{ give: ['G. Pickens'], get: ['B. Robinson'], rationale: 'RB need' }])
  })

  it('returns null when no block parses (pass failure, not empty result)', () => {
    expect(parseCandidates('no json here')).toBeNull()
    expect(parseCandidates('```json\n{"not": "candidates"}\n```')).toBeNull()
  })

  it('an empty candidates array is a SUCCESSFUL pass with no trades', () => {
    expect(parseCandidates('```json\n{"candidates": []}\n```')).toEqual([])
  })

  it('drops malformed entries and caps at 2 candidates', () => {
    const text = '```json\n' + JSON.stringify({
      candidates: [
        { give: 'not-an-array', get: ['x'], rationale: 'bad' },
        { give: ['a'], get: ['b'], rationale: 'ok1' },
        { give: ['c'], get: ['d'], rationale: 'ok2' },
        { give: ['e'], get: ['f'], rationale: 'ok3 — over the cap' },
      ],
    }) + '\n```'
    const got = parseCandidates(text)!
    expect(got.length).toBe(2)
    expect(got[0].rationale).toBe('ok1')
    expect(got[1].rationale).toBe('ok2')
  })
})

// ─── Orchestration ───────────────────────────────────────────────

const TASK: TaskFileInput = {
  missionId: 'mfl-dynasty', triggerId: 'trade-scan',
  prompt: 'Rank the candidate trades and report the top 2-3.',
  context: 'goal: Win the league',
  allowedTools: ['Mfl', 'WebSearch', 'WebFetch'], timeoutMs: 3600000, outcomePath: '/tmp/out.json',
  taskType: 'trade-scan',
  leagues: [{ leagueId: '65042', year: 2026, franchiseId: '0001' }],
}

/** 4-team league: my 0001 plus rivals 0002-0004. MFL-shaped JSON. */
function mflFixtures(): Record<string, any> {
  return {
    league: { league: { franchises: { franchise: [
      { id: '0001', name: 'Mine' }, { id: '0002', name: 'Rival Two' },
      { id: '0003', name: 'Rival Three' }, { id: '0004', name: 'Rival Four' },
    ] } } },
    rosters: { rosters: { franchise: [
      { id: '0001', player: [{ id: 'p1' }, { id: 'p2' }] },
      { id: '0002', player: [{ id: 'p3' }] },
      { id: '0003', player: [{ id: 'p4' }] },
      { id: '0004', player: { id: 'p5' } }, // MFL quirk: single element is an object, not array
    ] } },
    players: { players: { player: [
      { id: 'p1', name: 'Hurts, Jalen', position: 'QB', team: 'PHI' },
      { id: 'p2', name: 'Aiyuk, Brandon', position: 'WR', team: 'SFO' },
      { id: 'p3', name: 'Robinson, Bijan', position: 'RB', team: 'ATL' },
      { id: 'p4', name: 'Chase, Ja\'Marr', position: 'WR', team: 'CIN' },
      { id: 'p5', name: 'Allen, Josh', position: 'QB', team: 'BUF' },
    ] } },
    playerRanks: { playerRanks: { player: [
      { id: 'p1', rank: '3' }, { id: 'p2', rank: '40' }, { id: 'p3', rank: '5' },
      { id: 'p4', rank: '1' }, { id: 'p5', rank: '2' },
    ] } },
    leagueStandings: { leagueStandings: { franchise: [
      { id: '0001', h2hw: '0', h2hl: '0' }, { id: '0002', h2hw: '0', h2hl: '0' },
      { id: '0003', h2hw: '0', h2hl: '0' }, { id: '0004', h2hw: '0', h2hl: '0' },
    ] } },
    injuries: { injuries: { injury: [{ id: 'p3', status: 'Questionable' }] } },
  }
}

function makeDeps(overrides: Partial<TradeScanDeps> = {}) {
  const fixtures = mflFixtures()
  const completions: string[] = []
  const intermediates: Record<string, string> = {}
  const rankingCalls: { prompt: string; context: string }[] = []
  const deps: TradeScanDeps = {
    fetchMfl: async (query) => {
      if (!(query in fixtures)) throw new Error(`unexpected query ${query}`)
      return fixtures[query]
    },
    completeText: async (prompt) => {
      completions.push(prompt)
      return '```json\n{"candidates": [{"give": ["Aiyuk, Brandon"], "get": ["Robinson, Bijan"], "rationale": "they need WR"}]}\n```'
    },
    runRanking: async (prompt, context) => {
      rankingCalls.push({ prompt, context })
      return {
        ok: true, summary: 'ranked',
        recommendations: [{ id: 'rec-x', actionType: 'trade', summary: 'Trade Aiyuk for Bijan', detail: 'why' }],
      } satisfies TaskOutcome
    },
    writeIntermediate: (name, content) => { intermediates[name] = content },
    log: () => {},
    ...overrides,
  }
  return { deps, completions, intermediates, rankingCalls }
}

describe('runTradeScan', () => {
  it('runs one pass per rival, then the ranking loop, and returns its outcome', async () => {
    const { deps, completions, intermediates, rankingCalls } = makeDeps()
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(completions.length).toBe(3) // rivals 0002-0004, never my own 0001
    // Each rival prompt carries my roster and that rival's roster
    expect(completions[0]).toContain('Hurts, Jalen')
    expect(completions[0]).toContain('Robinson, Bijan')
    // Injury annotation made it into the roster text
    expect(completions[0]).toContain('Questionable')
    expect(Object.keys(intermediates).sort()).toEqual(['pass-0002', 'pass-0003', 'pass-0004'])
    // Ranking got the task prompt and all candidates (tagged with rivalId)
    expect(rankingCalls.length).toBe(1)
    expect(rankingCalls[0].prompt).toBe(TASK.prompt)
    expect(rankingCalls[0].context).toContain('"rivalId": "0002"')
    expect(rankingCalls[0].context).toContain('goal: Win the league')
    expect(outcome.ok).toBe(true)
    expect(outcome.recommendations[0].actionType).toBe('trade')
  })

  it('a failed pass is skipped; the scan continues with the rest', async () => {
    let call = 0
    const { deps, rankingCalls } = makeDeps({
      completeText: async () => {
        call++
        if (call === 2) throw new Error('llama-server HTTP 500')
        return '```json\n{"candidates": []}\n```'
      },
    })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    // 2 of 3 passes succeeded with zero candidates → success, nothing to rank
    expect(rankingCalls.length).toBe(0)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toMatch(/no mutually beneficial trades/i)
  })

  it('unparsable model output counts as a failed pass', async () => {
    const { deps } = makeDeps({ completeText: async () => 'I refuse to emit JSON' })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/0\/3 rival passes/)
  })

  it('fewer than 2 successful passes fails the scan', async () => {
    let call = 0
    const { deps } = makeDeps({
      completeText: async () => {
        call++
        if (call <= 2) throw new Error('boom')
        return '```json\n{"candidates": []}\n```'
      },
    })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/1\/3 rival passes/)
  })

  it('a task without leagues fails fast', async () => {
    const { deps } = makeDeps()
    const outcome = await runTradeScan({ ...TASK, leagues: undefined }, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/leagues/)
  })

  it('MFL fetch failure in pass 0 fails the scan with the error', async () => {
    const { deps } = makeDeps({ fetchMfl: async () => { throw new Error('MFL HTTP 503') } })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('MFL HTTP 503')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/daemon/tradeScan.test.ts`
Expected: FAIL — module `../../daemon/tradeScan.js` does not exist.

- [ ] **Step 3: Implement**

Create `engine/daemon/tradeScan.ts`:

```ts
// engine/daemon/tradeScan.ts
// League-wide trade scan orchestrator (spec §3, 2026-06-12-mfl-lineup-trade).
// Runs INSIDE the one-shot engine process (dispatched from oneShot.ts when
// taskType === 'trade-scan') so all passes share one model load:
//   pass 0      deterministic MFL fetches — no model
//   pass 1..N   one tool-free completion per rival roster → candidate trades
//   final pass  one governed ConversationLoop ranks candidates → outcome contract
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import type { MflLeagueRef, TaskFileInput, TaskOutcome } from './types.js'
import { buildMflExportUrl, loadMflApiKey } from '../tools/impl/mfl.js'
import { runGovernedLoop } from './oneShot.js'

const PASS_MAX_TOKENS = 2048
const RANKING_TIMEOUT_MS = 15 * 60 * 1000
const MIN_SUCCESSFUL_PASSES = 2

export interface TradeCandidate {
  rivalId: string
  give: string[]
  get: string[]
  rationale: string
}

/** All side effects injected — tests run the full orchestration offline. */
export interface TradeScanDeps {
  /** MFL export fetch, parsed JSON. League/year/key are baked in by the factory. */
  fetchMfl: (query: string, extra?: Record<string, string>) => Promise<any>
  /** One tool-free model completion (per-rival pass). */
  completeText: (prompt: string) => Promise<string>
  /** The governed ranking loop (oneShot.runGovernedLoop with mission tools). */
  runRanking: (prompt: string, context: string) => Promise<TaskOutcome>
  /** Persist raw per-pass model output next to the outcome file (debugging). */
  writeIntermediate: (name: string, content: string) => void
  log: (msg: string) => void
}

// ─── MFL JSON helpers ────────────────────────────────────────────

/** MFL quirk: single-element collections arrive as an object, not an array. */
function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return []
  return Array.isArray(x) ? x : [x]
}

interface FranchiseData {
  id: string
  name: string
  standing: string
  rosterText: string
}

async function buildLeagueData(deps: TradeScanDeps): Promise<FranchiseData[]> {
  const [leagueResp, rostersResp, ranksResp, standingsResp, injuriesResp] = [
    await deps.fetchMfl('league'),
    await deps.fetchMfl('rosters'),
    await deps.fetchMfl('playerRanks'),
    await deps.fetchMfl('leagueStandings'),
    await deps.fetchMfl('injuries'),
  ]

  const franchises = asArray(leagueResp?.league?.franchises?.franchise)
    .map((f: any) => ({ id: String(f.id), name: String(f.name ?? `franchise ${f.id}`) }))

  const rosterIds = new Map<string, string[]>()
  for (const fr of asArray<any>(rostersResp?.rosters?.franchise)) {
    rosterIds.set(String(fr.id), asArray<any>(fr.player).map((p) => String(p.id)))
  }

  const allIds = [...new Set([...rosterIds.values()].flat())]
  const playersResp = await deps.fetchMfl('players', { PLAYERS: allIds.join(',') })
  const playerInfo = new Map<string, { name: string; position: string; team: string }>()
  for (const p of asArray<any>(playersResp?.players?.player)) {
    playerInfo.set(String(p.id), {
      name: String(p.name ?? p.id),
      position: String(p.position ?? '?'),
      team: String(p.team ?? '?'),
    })
  }

  const rankOf = new Map<string, string>()
  for (const p of asArray<any>(ranksResp?.playerRanks?.player)) {
    rankOf.set(String(p.id), String(p.rank))
  }

  const standingOf = new Map<string, string>()
  for (const f of asArray<any>(standingsResp?.leagueStandings?.franchise)) {
    standingOf.set(String(f.id), `${f.h2hw ?? '0'}-${f.h2hl ?? '0'}`)
  }

  const injuryOf = new Map<string, string>()
  for (const i of asArray<any>(injuriesResp?.injuries?.injury)) {
    injuryOf.set(String(i.id), String(i.status ?? 'listed'))
  }

  return franchises.map((f) => {
    const lines = (rosterIds.get(f.id) ?? []).map((pid) => {
      const info = playerInfo.get(pid)
      const rank = rankOf.get(pid)
      const injury = injuryOf.get(pid)
      const base = info ? `${info.position} ${info.name} (${info.team})` : `player ${pid}`
      return `  ${base}${rank ? ` — rank ${rank}` : ''}${injury ? ` — INJURY: ${injury}` : ''}`
    })
    return {
      id: f.id,
      name: f.name,
      standing: standingOf.get(f.id) ?? '0-0',
      rosterText: lines.join('\n') || '  (roster unavailable)',
    }
  })
}

// ─── Per-rival pass ──────────────────────────────────────────────

function buildRivalPrompt(me: FranchiseData, rival: FranchiseData): string {
  return [
    'You are a dynasty fantasy football trade analyst. Find trades where BOTH sides plausibly say yes.',
    'Lower rank number = more valuable player.',
    '',
    `MY TEAM "${me.name}" (record ${me.standing}):`,
    me.rosterText,
    '',
    `RIVAL TEAM "${rival.name}" (record ${rival.standing}):`,
    rival.rosterText,
    '',
    'Propose 0-2 mutually beneficial trades between MY TEAM and this RIVAL only.',
    'A good trade exchanges my surplus for my need and fits the rival\'s roster shape too.',
    'If no fair trade exists, return an empty array — do NOT force one.',
    '',
    'Respond with ONLY one fenced code block in exactly this format:',
    '```json',
    '{"candidates": [{"give": ["<player I send>"], "get": ["<player I receive>"], "rationale": "<one sentence: why both sides accept>"}]}',
    '```',
  ].join('\n')
}

/** Parse candidate trades from a per-rival pass. null = pass FAILED (no
 *  parsable block); [] = pass succeeded, no trades found. */
export function parseCandidates(text: string): { give: string[]; get: string[]; rationale: string }[] | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(blocks[i])
      if (!Array.isArray(raw.candidates)) continue
      return raw.candidates
        .filter((c: any) => c
          && Array.isArray(c.give) && c.give.every((g: any) => typeof g === 'string')
          && Array.isArray(c.get) && c.get.every((g: any) => typeof g === 'string')
          && typeof c.rationale === 'string')
        .slice(0, 2)
        .map((c: any) => ({ give: c.give, get: c.get, rationale: c.rationale }))
    } catch {
      // try the previous block
    }
  }
  return null
}

// ─── Orchestration ───────────────────────────────────────────────

export async function runTradeScan(
  task: TaskFileInput,
  provider: Provider,
  config: LocalCodeConfig,
  depsOverride?: TradeScanDeps,
): Promise<TaskOutcome> {
  const league = task.leagues?.[0]
  if (!league) {
    return { ok: false, summary: '', recommendations: [], error: 'trade-scan task carries no leagues — missionRunner must pass them through' }
  }
  const deps = depsOverride ?? makeRealDeps(task, league, provider, config)
  try {
    return await scan(task, league, deps)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log(`[trade-scan] failed: ${msg}`)
    return { ok: false, summary: '', recommendations: [], error: msg }
  }
}

async function scan(task: TaskFileInput, league: MflLeagueRef, deps: TradeScanDeps): Promise<TaskOutcome> {
  const franchises = await buildLeagueData(deps)
  const me = franchises.find((f) => f.id === league.franchiseId)
  if (!me) {
    return { ok: false, summary: '', recommendations: [], error: `franchise ${league.franchiseId} not found in league ${league.leagueId}` }
  }
  const rivals = franchises.filter((f) => f.id !== league.franchiseId)

  const candidates: TradeCandidate[] = []
  let successes = 0
  for (const rival of rivals) {
    try {
      const text = await deps.completeText(buildRivalPrompt(me, rival))
      deps.writeIntermediate(`pass-${rival.id}`, text)
      const parsed = parseCandidates(text)
      if (parsed === null) {
        deps.log(`[trade-scan] pass ${rival.id} (${rival.name}): no parsable candidates block — skipped`)
        continue
      }
      successes++
      candidates.push(...parsed.map((c) => ({ ...c, rivalId: rival.id })))
      deps.log(`[trade-scan] pass ${rival.id} (${rival.name}): ${parsed.length} candidate(s)`)
    } catch (err) {
      deps.log(`[trade-scan] pass ${rival.id} (${rival.name}) failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (successes < MIN_SUCCESSFUL_PASSES) {
    return { ok: false, summary: '', recommendations: [], error: `trade scan: only ${successes}/${rivals.length} rival passes succeeded` }
  }
  if (candidates.length === 0) {
    return { ok: true, summary: `Scanned ${successes} rival rosters — no mutually beneficial trades found this week.`, recommendations: [] }
  }

  const context = [
    task.context,
    '',
    'Candidate trades from the per-rival scan (rivalId = the rival franchise id):',
    '```json',
    JSON.stringify({ candidates }, null, 1),
    '```',
  ].join('\n')
  return deps.runRanking(task.prompt, context)
}

// ─── Real deps ───────────────────────────────────────────────────

function makeRealDeps(
  task: TaskFileInput,
  league: MflLeagueRef,
  provider: Provider,
  config: LocalCodeConfig,
): TradeScanDeps {
  const apiKey = loadMflApiKey()
  const stamp = Date.now()
  const outDir = dirname(task.outcomePath)
  return {
    fetchMfl: async (query, extra) => {
      const url = buildMflExportUrl({ query, league: league.leagueId, year: league.year, apiKey, extra })
      const resp = await fetch(url, { headers: { 'User-Agent': 'CynCoMFL/1.0' }, signal: AbortSignal.timeout(30000) })
      if (!resp.ok) throw new Error(`MFL HTTP ${resp.status} for ${query}`)
      return resp.json()
    },
    completeText: async (prompt) => {
      const resp = await provider.complete({
        model: config.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: PASS_MAX_TOKENS,
        temperature: 0.7,
      })
      return resp.content
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
    },
    runRanking: (prompt, context) => runGovernedLoop({
      prompt, context,
      allowedTools: ['Mfl', 'WebSearch', 'WebFetch'],
      timeoutMs: RANKING_TIMEOUT_MS,
      provider, config,
    }),
    writeIntermediate: (name, content) => {
      try {
        writeFileSync(join(outDir, `tradescan-${stamp}-${name}.txt`), content, 'utf-8')
      } catch { /* debugging aid only — never fail the scan over it */ }
    },
    log: (msg) => console.log(msg),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/daemon/tradeScan.test.ts`
Expected: ALL PASS.

Also re-run the neighbors that import from touched modules:
Run: `npx vitest run engine/__tests__/daemon/ engine/__tests__/tools/mfl.test.ts`
Expected: ALL PASS (oneShot integration test skipped without the gate).

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/tradeScan.ts engine/__tests__/daemon/tradeScan.test.ts
git commit -m "feat: league-wide multi-pass trade scan orchestrator"
```

---

### Task 7: mission.json — digest prompt, lineup command template, trade-scan trigger

**Files:**
- Modify: `C:\Users\civer\.cynco\missions\mfl-dynasty\mission.json` (live user config — NOT in the repo, no git commit for this task)

- [ ] **Step 1: Read the live file first** (`C:\Users\civer\.cynco\missions\mfl-dynasty\mission.json`) — do not blind-overwrite; other fields (goal, leagues, trustLadder, other triggers) must be preserved exactly.

- [ ] **Step 2: Replace the `weekly-digest` trigger's `prompt` value** with:

```
Produce the weekly dynasty digest for my franchise. Steps: (1) Pull projectedScores (with W for the upcoming week), injuries, and nflSchedule (same W) via the Mfl tool; pull anything else you need (rosters, leagueStandings, transactions). (2) For borderline start/sit calls or unclear injury situations, use WebSearch for current expert consensus and injury news. (3) Your recommendations MUST include exactly ONE recommendation with actionType "lineup" whose detail is my complete suggested starting lineup for the upcoming week, one slot per line in the form "POS: Player Name (opponent, proj X.X)" — fill every starting slot the league requires, and end with a short "Bench notes:" line for key sit decisions. (4) Additionally report waiver targets (actionType "waiver"), urgent injury/news items (actionType "info"), and standings/roster observations as usual. Recommend only — never execute anything.
```

- [ ] **Step 3: Add the `commands` top-level field** (sibling of `triggers`):

```json
"commands": {
  "lineup": "Produce my full suggested starting lineup for {week}. Steps: (1) Pull projectedScores, injuries, and nflSchedule for {week} via the Mfl tool, plus rosters if the snapshot is unclear. (2) Use WebSearch for borderline start/sit calls and breaking injury news. (3) Emit exactly ONE recommendation with actionType \"lineup\" whose detail is the complete lineup, one slot per line in the form \"POS: Player Name (opponent, proj X.X)\" — fill every starting slot the league requires, ending with a short \"Bench notes:\" line. No other recommendations unless something urgent surfaced. Recommend only — never execute anything."
}
```

- [ ] **Step 4: Append the trade-scan trigger** to the `triggers` array:

```json
{
  "id": "trade-scan",
  "kind": "weekly",
  "day": "tue",
  "at": "09:00",
  "precheck": "none",
  "missedPolicy": "skip",
  "taskType": "trade-scan",
  "prompt": "You are given candidate trades collected by scanning every rival roster (in the mission context below). Sanity-check the strongest candidates: verify current injury status and recent news via WebSearch and Mfl (injuries, playerScores) — discard any candidate built on stale assumptions. Then rank the survivors by expected value to my franchise (dynasty window, positional need, value gap) and report the TOP 2-3 as recommendations with actionType \"trade\". Each detail must state exactly what I give, what I get, which franchise, and a two-sentence rationale covering why BOTH sides accept. If no candidate survives scrutiny, return an empty recommendations array. Recommend only — never execute or propose trades in MFL yourself."
}
```

- [ ] **Step 5: Validate the JSON**

Run: `python -c "import json; json.load(open(r'C:\Users\civer\.cynco\missions\mfl-dynasty\mission.json')); print('valid')"`
Expected: `valid`

- [ ] **Step 6: No git commit** (file lives outside the repo). The daemon reads mission.json at startup — config takes effect at the Task 9 daemon restart.

---

### Task 8: Wire-check + full suite vs baseline

**BLOCKING requirement** (user rule: every plan's last implementation step greps all new symbols and verifies they're actually imported/called/used).

- [ ] **Step 1: Wire-check every new symbol**

Run each grep from the repo root and confirm the expected usage sites exist (definition alone is NOT enough — there must be a caller/consumer):

| Symbol | Defined in | Must be used by |
|---|---|---|
| `projectedScores` / `playerRanks` / `nflSchedule` | mfl.ts ALLOWED_QUERIES | mission.json prompts (Task 7), tradeScan.ts (`playerRanks`) |
| `ApprovalCommand` / `TextCommand` | types.ts | ntfyChannel.ts (construct), missionRunner.ts (`handleCommand` param), main.ts (route) |
| `kind: 'text'` | ntfyChannel.ts subscribe | main.ts (`cmd.kind === 'text'`) |
| `handleTextCommand` | missionRunner.ts | main.ts subscribe callback |
| `drainOnDemand` / `onDemand` | missionRunner.ts | `tick()` |
| `taskType` | types.ts | missionRunner.ts (timeout + passthrough), oneShot.ts (dispatch), mission.json trigger |
| `leagues` (TaskFileInput) | types.ts | missionRunner.ts (set), tradeScan.ts (read) |
| `commands` (MissionConfig) | types.ts | missionRunner.ts (`handleTextCommand`, `drainOnDemand`), mission.json |
| `runGovernedLoop` | oneShot.ts | oneShot.ts `runOneShotTask`, tradeScan.ts `runRanking` |
| `runTradeScan` | tradeScan.ts | oneShot.ts dispatch (dynamic import) |
| `parseCandidates` / `buildRivalPrompt` / `buildLeagueData` / `makeRealDeps` | tradeScan.ts | `scan()` / `runTradeScan` |
| `TRADE_SCAN_TIMEOUT_MS` | missionRunner.ts | `fire()` |

```bash
grep -rn "projectedScores\|playerRanks\|nflSchedule" engine/ --include="*.ts" | grep -v __tests__
grep -rn "handleTextCommand\|TextCommand\|ApprovalCommand" engine/ --include="*.ts" | grep -v __tests__
grep -rn "taskType\|runGovernedLoop\|runTradeScan\|drainOnDemand" engine/ --include="*.ts" | grep -v __tests__
grep -n "taskType\|commands\|trade-scan" "C:\Users\civer\.cynco\missions\mfl-dynasty\mission.json"
```

Any symbol that is defined but has no consumer = wiring bug → fix before proceeding.

- [ ] **Step 2: Full suite vs baseline**

Run: `npx vitest run` (from repo root; expect several minutes)
Expected: failing tests confined to the **10 known-broken baseline files** (governanceDb, config, dashboard/server EADDRINUSE flake, callModel, predictionDb, profiles/loader, treeSitterChunker, executor, glob, configHandlers) — roughly 34 failures, EADDRINUSE flake may wobble the count. ANY new failing file = regression: stop and fix (systematic-debugging skill) before Task 9.

- [ ] **Step 3: Commit any wire-check fixes**

```bash
git add -A engine/
git commit -m "fix: wire-check fixes for lineup/trade-scan feature"
```
(Skip if nothing needed fixing.)

---

### Task 9: Live verification — all three reports on the phone

The acceptance bar (same as the liveness layer): the reports arrive on the user's phone. Daemon launch env (from prior sessions): `CYNCO_NTFY_URL=http://100.101.69.46:8090`, `CYNCO_NTFY_TOKEN=$(python "\tmp\extract_token.py")`, `LOCALCODE_MODEL=qwen3.6`, `LOCALCODE_PROVIDER=llama-cpp`, logging appended to `~/.cynco/daemon.log`. Re-fire helper: `python "\tmp\rewind_digest.py"` rewinds the weekly-digest nextFire.

- [ ] **Step 1: Restart the daemon with the new code**

```bash
taskkill //F //IM bun.exe
# then relaunch (background) from the repo root:
CYNCO_NTFY_URL=http://100.101.69.46:8090 CYNCO_NTFY_TOKEN=$(python "\tmp\extract_token.py") \
LOCALCODE_MODEL=qwen3.6 LOCALCODE_PROVIDER=llama-cpp \
bun engine/daemon/main.ts >> ~/.cynco/daemon.log 2>&1 &
```
Confirm in `~/.cynco/daemon.log`: mission loaded with **4 triggers** (transaction-watch, morning-brief, weekly-digest, trade-scan).

- [ ] **Step 2: Verify the richer digest** — run `python "\tmp\rewind_digest.py"`, restart the daemon (step 1 again), wait for the run (give it 15+ min). Check `~/.cynco/missions/mfl-dynasty/tasks/outcome-weekly-digest-*.json` (newest): recommendations include exactly one `actionType: "lineup"` whose detail lists every starting slot. **User confirms the lineup card arrived on the phone as ONE notification with Approve/Reject.**

- [ ] **Step 3: Verify the on-demand command** — user sends the text `lineup` to the `cynco-commands` topic from the ntfy app. Expect: ack notification within ~30s ("Lineup queued"), then the lineup card after the run. Check daemon.log for `on-demand-lineup` task lines and the new outcome file. **User confirms both notifications.**

- [ ] **Step 4: Verify the trade scan** — force-fire: stop the daemon, set the trigger due shortly, restart, watch:

```bash
python - <<'EOF'
import json, datetime
p = r'C:\Users\civer\.cynco\missions\mfl-dynasty\state.json'
s = json.load(open(p))
s['nextFire']['trade-scan'] = (datetime.datetime.now().astimezone() + datetime.timedelta(seconds=60)).isoformat()
json.dump(s, open(p, 'w'), indent=2)
print('trade-scan due at', s['nextFire']['trade-scan'])
EOF
```

Then restart the daemon (Step 1) and wait — the scan takes 15-25+ min (11 passes + ranking). Watch daemon.log for `[trade-scan] pass NNNN` lines; intermediates land in `tasks/tradescan-*-pass-*.txt`. Expect 2-3 `trade` recommendations in the outcome and on the phone. **User confirms the trade notifications with real give/get proposals.**

- [ ] **Step 5: Sanity-check pass health** — in daemon.log confirm ≥2 rival passes succeeded and the VSM stayed healthy in the ranking pass (stuck counter not climbing). Any HALT → root-cause per standing rule (systematic-debugging), never shrug it off.

- [ ] **Step 6: Commit the plan checkboxes + any verification fixes, then STOP**

Do not push. Report results to the user and use superpowers:finishing-a-development-branch for the wrap-up decision.

---

## Self-review notes (already applied)

- Spec coverage: §1 MFL data → Task 1; §2a digest → Task 7 (prompt-only, per spec); §2b on-demand → Tasks 2-4, 7; §3 trade scan → Tasks 3, 5, 6, 7; error handling → embedded per task; testing table → Tasks 1-6; wire-check → Task 8; live verification → Task 9.
- Legacy approve/reject button bodies (published before this change) carry no `kind` — the Task 2 parser accepts them; covered by test (b).
- `TaskFileInput.leagues` is an addition the spec implies but does not name — the trade scan needs structured league/franchise ids, and the context string is prose. Called out in Task 3.
- Type consistency: `TradeScanDeps`/`runTradeScan(task, provider, config, depsOverride)` signatures match between Tasks 5 (dispatch + injectable impl) and 6 (implementation); `FireResult`/`drainOnDemand` are internal to missionRunner.ts.




