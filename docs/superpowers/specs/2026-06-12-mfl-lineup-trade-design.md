# MFL Full Lineup + Trade Scan Design

**Date:** 2026-06-12
**Branch:** `liveness-layer` (continues on this branch per user decision — no merge first)
**Status:** Approved by user

## Goal

Deepen the MFL dynasty mission's outputs in two ways:

1. **Full suggested lineup** — a complete starting lineup for the upcoming (or any requested) week, delivered (a) inside the Monday weekly digest and (b) on demand from the phone.
2. **League-wide trade scan** — a weekly multi-pass scan of every rival franchise for mutually beneficial trades, reporting the top 2-3 as recommendations.

Everything stays Phase B: recommend-only, outbound-only ntfy, no MFL writes.

## Requirements (user-confirmed)

- Lineup delivery: richer weekly digest **and** on-demand phone command (no separate weekly lineup trigger).
- Player-value data: new MFL endpoints **and** web search for expert/injury consensus.
- Trade scan: multi-pass (one pass per rival), thorough over fast.
- Trade scan cadence: its own weekly trigger (Tuesday, after waivers clear) — not part of the digest, not on-demand.
- Lineup format: **one** consolidated lineup card per run — single notification, single Approve/Reject pair. Whole-lineup approvals feed the `lineup` trust ladder (promotes at 5).

## Architecture overview

```
phone (ntfy app)
  │  plain text "lineup [N]"            ── cynco-commands topic (SSE long-poll, outbound-only)
  ▼
daemon (engine/daemon/main.ts)
  ├─ ntfyChannel.subscribe ──► CommandMessage union: approval | text
  ├─ missionRunner.handleTextCommand ──► on-demand queue + ack notification
  ├─ tick(): drain on-demand queue, then evaluate triggers
  │     └─ fire(trigger) ──► TaskRunner.run (one engine process per task)
  ▼
engine one-shot (--run-task)
  ├─ taskType 'prompt'      ──► existing ConversationLoop path (unchanged)
  └─ taskType 'trade-scan'  ──► engine/daemon/tradeScan.ts orchestrator
        1. deterministic MFL fetches (no model)
        2. 11 tool-free per-rival completions (candidate trades as JSON)
        3. 1 governed ranking loop (Mfl + WebSearch) → standard outcome contract
```

One engine process per task means one model load per task — the trade scan's passes all run inside a single process/GPU window.

## Section 1: MFL data layer

File: `engine/tools/impl/mfl.ts`

Add to `ALLOWED_QUERIES`:

| Query | Purpose | League-specific? |
|---|---|---|
| `projectedScores` | Weekly projections under the league's scoring rules (`W` param) | Yes (`L` required) |
| `playerRanks` | Dynasty trade-value rankings | No → add to `GLOBAL_QUERIES` |
| `nflSchedule` | Week's NFL matchups + byes (`W` param) | No → add to `GLOBAL_QUERIES` |

The global-vs-league split for each MUST be verified live during implementation (known failure mode: `L=` on a global query → 302 → "must go to api.myfantasyleague.com"; see the `GLOBAL_QUERIES` comment in mfl.ts). If a query turns out to be league-specific in practice, move it out of `GLOBAL_QUERIES` — the whitelist entry itself is unaffected.

No other tool changes: read-only guarantee, reserved-param stripping, APIKEY redaction, and 50k truncation all apply automatically. `WebSearch`/`WebFetch` are already in `DEFAULT_TOOLS` (missionRunner.ts) — web research is enabled purely by prompt instructions.

## Section 2: Full lineup

### 2a. Richer weekly digest (prompt-only change)

Rewrite the `weekly-digest` trigger prompt in `~/.cynco/missions/mfl-dynasty/mission.json` to require:

1. Pull `projectedScores`, `injuries`, and `nflSchedule` for the upcoming week.
2. Use WebSearch for borderline start/sit calls and injury news.
3. Emit **exactly one** recommendation with `actionType: "lineup"` whose `detail` is the complete suggested starting lineup, one slot per line, with opponent and projection:

```
QB: J. Hurts (vs DAL, proj 22.4)
RB: J. Williams (@ LAC, proj 11.2) — questionable, see info rec
WR: B. Aiyuk (vs SEA, proj 14.8)
...
Bench notes: Nix over Ward if Burrow inactive
```

4. Other recs (waiver/trade/info) continue as separate notifications, unchanged.

No code change: the outcome contract, `extractOutcome`, and `publishRecommendation` already support this.

### 2b. On-demand lineup from phone

User types plain text into the `cynco-commands` topic in the ntfy app: `lineup` (upcoming week) or `lineup 5` (specific week).

**`engine/daemon/types.ts`** — `CommandMessage` becomes a discriminated union:

```ts
export type CommandMessage =
  | { kind: 'approval'; recId: string; verdict: 'approve' | 'reject' }
  | { kind: 'text'; text: string }
```

**`engine/daemon/ntfyChannel.ts`** — `subscribe` parser: a message that parses as approval JSON (`recId` string + `verdict` approve/reject) → approval command (existing behavior). Anything else non-empty (plain text, or JSON without those fields) → `{kind:'text', text: <raw message>}`. Still outbound-only SSE long-poll; no new ports.

**`engine/daemon/missionRunner.ts`** —

- `handleCommand` handles `kind:'approval'` (rename of current logic; same semantics).
- New `handleTextCommand(text)`: parse `^lineup(\s+\d{1,2})?$` (case-insensitive, trimmed). Recognized → push `{week?: number}` onto an in-memory on-demand queue and publish an ack ("Lineup for week N queued — report in a few minutes"). Unrecognized → publish a help notification listing valid commands. **Never runs a model from the command handler.**
- `tick()` drains the on-demand queue **before** evaluating triggers. Each request runs through the existing `fire()` path with a synthetic trigger: `id: 'on-demand-lineup'`, `precheck: 'none'`, prompt from the lineup template with the requested week substituted. This inherits GPU-busy defer/backoff, run records, outcome files, rec publishing, and the single-flight `ticking` lock for free. A GPU-busy defer re-queues the request (it does not vanish).
- Queue is in-memory by design: a daemon restart drops pending on-demand requests — acceptable, the user just resends.

**`mission.json`** — new top-level field so wording is tunable without code:

```json
"commands": {
  "lineup": "Produce a full suggested starting lineup for week {week} ... (same data + format requirements as the digest lineup section)"
}
```

`{week}` placeholder; when no week is given, the prompt says "the upcoming week" and the model determines it from `nflSchedule`/league data.

**`engine/daemon/main.ts`** — the subscribe callback routes approval commands as today (first mission that knows the recId) and broadcasts text commands to every runner (in practice: one mission).

## Section 3: League-wide trade scan

### Trigger and dispatch

- **`engine/daemon/types.ts`**: `TriggerSpec` gains optional `taskType?: 'prompt' | 'trade-scan'` (absent = `'prompt'`; existing triggers untouched). `TaskFileInput` gains the same optional field, passed through by `missionRunner.fire()`.
- **`mission.json`** new trigger:

```json
{ "id": "trade-scan", "kind": "weekly", "day": "tue", "at": "09:00",
  "precheck": "none", "missedPolicy": "skip", "taskType": "trade-scan",
  "prompt": "<ranking-pass instructions — see below>" }
```

- **Timeout**: trade-scan tasks get a 60-minute timeout (vs the 15-minute default). `missionRunner.fire()` selects the timeout by `taskType`.
- **`engine/daemon/oneShot.ts`**: when `task.taskType === 'trade-scan'`, dispatch to the orchestrator instead of the single-loop path. Same outcome file, same exit-code contract.

### Orchestrator: `engine/daemon/tradeScan.ts` (new, runs inside the engine process)

**Pass 0 — deterministic fetch (no model):** league (franchise names), all rosters, `playerRanks`, `leagueStandings`, `injuries` — direct HTTP via `buildMflExportUrl` + `loadMflApiKey`, mirroring the daemon's snapshot fetchers. Resolve player ids to name/pos/team using the `players` query (filtered to ids on rosters). Build a compact per-franchise roster table annotated with ranks.

**Pass 1..N — per-rival candidate passes (11 rivals in a 12-team league):** one **tool-free** model completion each (direct provider call, not a ConversationLoop — all data is in the prompt, no tools needed). Prompt = my annotated roster + this rival's annotated roster + both standings lines + my known needs, asking for 0-2 mutually beneficial trades as a fenced JSON block:

```json
{"candidates": [{"give": ["player/pick"], "get": ["player/pick"], "rationale": "<why both sides say yes>"}]}
```

Defensive parse per pass (same last-fenced-block strategy as `extractOutcome`); a pass that fails to parse, errors, or times out is logged and skipped. Intermediate results are written to `tasks/tradescan-<stamp>-pass-<franchiseId>.json` for debuggability.

**Final pass — governed ranking loop:** all collected candidates (compact JSON) go into one normal one-shot `ConversationLoop` run with `allowedTools: ['Mfl', 'WebSearch', 'WebFetch']`. It sanity-checks the top candidates (injury news, recent performance, rank deltas), ranks them, and emits the **standard outcome contract** with 2-3 `trade` recs — each `detail` showing give/get and rationale, optional `deepLink` to the MFL trade page. The trigger's `prompt` field carries these ranking instructions.

**Failure shape:** fewer than 2 successful rival passes, or ranking-pass failure → outcome `ok: false` with error → existing failureStreak paging at 3 consecutive failures.

**Delivery:** unchanged — each trade rec is its own notification with Approve/Reject (`trade` promotes at 10). Approve still means "noted — propose it in MFL yourself."

**Budget:** 1 model load + 11 short completions + 1 governed loop ≈ 15-25 min wall time, Tuesday 09:00, inside one GPU window guarded by the existing GPU-busy check.

## Error handling

- **Text commands:** parse failures never reach a model — unknown text → help notification; malformed SSE events remain silently ignored. Ack/help publishes use the existing queue-on-failure publish path.
- **On-demand + GPU busy:** request stays queued and rides the existing defer/backoff.
- **Trade scan:** per-pass try/catch + skip; thresholds above; daemon hard kill (60 min) and engine internal deadline both apply.
- **New MFL queries:** inherit existing redaction/truncation/error handling.

## Testing (TDD — every test written failing first)

| File | Tests |
|---|---|
| `engine/__tests__/tools/mfl.test.ts` | new queries allowed; `playerRanks`/`nflSchedule` URLs omit `L`; `projectedScores` includes `L` |
| `engine/__tests__/daemon/ntfyChannel.test.ts` | approval JSON → approval command; plain text → text command; non-approval JSON → text command; existing approve/reject behavior unchanged |
| `engine/__tests__/daemon/missionRunner.test.ts` | `handleTextCommand` parses `lineup` / `lineup 5`, queues + acks; unknown text → help; tick drains queue through fire path (injected deps); GPU-busy defer re-queues; trade-scan trigger gets 60-min timeout + taskType passthrough |
| `engine/__tests__/daemon/tradeScan.test.ts` | happy path (stubbed fetch + stubbed completions: 11 passes → ranking → outcome); failed passes skipped; <2 successful passes → ok:false; candidate parser rejects malformed JSON |
| `engine/__tests__/daemon/oneShot.test.ts` | `taskType:'trade-scan'` dispatches to orchestrator; absent/`'prompt'` uses the normal loop |

**Wire-check (blocking final step):** grep every new symbol (`taskType`, `handleTextCommand`, `tradeScan`, `projectedScores`, `playerRanks`, `nflSchedule`, `kind: 'text'`, `commands`) and verify each is imported/called/used end-to-end.

Full suite vs the known 34-failure baseline (10 files) before any commit.

## Live verification (acceptance bar: reports on the phone)

1. Re-fire weekly-digest → full lineup card arrives as **one** notification with Approve/Reject.
2. Send `lineup` from the ntfy app → ack notification, then lineup card within minutes.
3. Force-fire trade-scan → 2-3 trade notifications with real give/get proposals.
4. Verify new MFL queries return data live (global-vs-league split confirmed).

## Out of scope

- Phase C (autonomous execution of approved actions) — trust ladder remains informational.
- Any new inbound network surface — phone control stays ntfy long-poll, outbound-only.
- On-demand trade scan (user chose weekly trigger only).
- Mode-aware governance spec (separate, already approved: `2026-06-12-mode-aware-governance-design.md`) — implemented after this feature.
