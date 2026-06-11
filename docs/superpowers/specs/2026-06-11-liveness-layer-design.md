# CynCo Liveness Layer + MFL Agent PoC — Design

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan

## Background

Gap analysis against agent platforms (CoWork-OS, OpenClaw) showed CynCo's agent foundation is already platform-grade: 20 tools including multi-engine WebSearch and a 5-phase `/research` workflow, 6 sub-agent personas with S2 GPU-aware scheduling, 4-layer memory (ledger/handoffs/learnings/governance DB), vibe-loop autonomy, and VSM/S5 governance. What CynCo lacks is **liveness**: it only exists while a session is open.

Four gaps, one theme:

1. **No daemon** — the engine dies with the TUI session
2. **No scheduler** — no cron/timers/heartbeat anywhere
3. **No outbound channel** — reach is TUI WebSocket + dashboard only
4. **No mission-level goals** — memory is session/task-scoped

This design adds a focused liveness layer (not a platform pivot) with a concrete test workload: an agent that manages the user's MyFantasyLeague (MFL) dynasty fantasy football teams.

**Key framing:** the daemon/scheduler/ledger/notification stack is mission-agnostic. MFL is the first domain tool plugged into the framework; future missions are "write a tool + a mission.json."

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| Scope | Focused liveness layer, not general agent OS | Foundation is already platform-grade; PoC only has to prove liveness |
| First league platform | MFL (dynasty, active now); Sleeper later | Dynasty has year-round activity; Sleeper keeper league inactive for ~2 months |
| Autonomy level | B: monitor + recommend + phone approval | User wants C (autonomous writes) only after recommendations prove sane |
| Notification channel | Self-hosted ntfy over Tailscale | No public ports, no third-party message content, phone reachable anywhere |
| GPU policy | Tiny always-on daemon; llama-server spun up on demand per task | 22 GB VRAM not held idle; ~30-60 s startup irrelevant for scheduled work |
| Daemon architecture | Slim sentinel daemon + one-shot engine runs | Crash isolation, near-zero idle cost, engine barely changes |

## 1. Architecture overview

```
┌────────────────────────────── always on (tiny, no model) ─────────────────────────────┐
│  cynco-daemon  (bun engine/daemon/main.ts, kept alive by Windows Task Scheduler)      │
│   ├── Scheduler        cron triggers from mission config, persisted next-fire times   │
│   ├── MissionLedger    goals, run history, pending approvals, trust-ladder state      │
│   ├── NtfyChannel      subscribes cynco-commands, publishes cynco-alerts (Tailscale)  │
│   └── TaskRunner       GPU check → spawn one-shot engine → collect outcome            │
└────────────────────────────────────────────────────────────────────────────────────────┘
                      │ task file in / outcome file out
                      ▼ (only when a trigger fires and there is real work)
   bun engine/main.ts --run-task <file>     ← existing engine, new one-shot mode
   starts llama-server → runs task with tools (mfl, WebSearch, ...) → writes outcome
   → exits, stops llama-server
                      │
                      ▼
   ntfy (self-hosted, bound to Tailscale only) ──► phone (push + approve/reject buttons)
```

The daemon never loads a model and never imports heavy engine code — it is a scheduler, a ledger, and an ntfy client. All intelligence happens in short-lived engine runs.

## 2. Daemon (`engine/daemon/`)

- New entrypoint, ~5 modules: `main.ts`, `scheduler.ts`, `missionLedger.ts`, `ntfyChannel.ts`, `taskRunner.ts`.
- Kept alive by Windows Task Scheduler (run at logon, restart on failure). No new service framework.
- **Scheduler**: cron expressions from mission config. Next-fire times persisted so a reboot does not double-fire; missed runs follow a per-trigger policy (`skip` or `run-once-on-startup`).
- **Cheap pre-check before any model run**: for MFL-delta triggers, the daemon polls the MFL API directly (plain HTTP, no inference) and diffs against last-seen state — no change, no engine spawn. Triggers that need the model regardless (e.g., scheduled news sweep via WebSearch, weekly roster digest) skip the pre-check and always spawn. Most wakes should cost ~nothing.
- **GPU guard**: before spawning, check `nvidia-smi` plus "is an interactive CynCo session live" (tasklist heuristic for bun/llama-server). Busy → defer with backoff; notify only if a deadline-critical task cannot run.

## 3. Mission ledger (`~/.cynco/missions/{mission-id}/`)

- `mission.json` — goal statement, MFL league IDs, schedule triggers, trust-ladder config (JSON, not YAML: the `yaml` package is unreliable under vitest in this repo and the daemon must not depend on it)
- `state.json` — last-seen MFL snapshot (for delta detection), pending approvals
- `runs.jsonl` — append-only run history: trigger, outcome, recommendations made, approval results
- Trust ladder is per action-type: `{ "waiver": { mode: "ask", approvedStreak: 4, promoteAt: 10 }, ... }`. Phase C flips `mode: "auto"` per type — the data model supports it now; the write path comes later.

## 4. One-shot engine mode

- `bun engine/main.ts --run-task <taskfile.json>` — boots headless, **no WebSocket server**, runs the conversation loop on the task prompt with auto-approved read tools, writes a structured outcome file (summary + recommendations array), exits.
- Stops llama-server on exit (new provider flag; interactive mode keeps current behavior).
- Task file carries: prompt, mission context (goal, roster snapshot, last 3 run summaries — reusing the existing handoff format), allowed tools, timeout.
- Hard timeout (default 15 min) — daemon kills the process and records failure. 3 consecutive failures → algedonic ntfy alert: "agent stuck on mission X."

## 5. MFL tool (`engine/tools/impl/mfl.ts`)

- Typed wrapper over MFL's JSON export API (`api.myfantasyleague.com/{year}/export?TYPE=...`): rosters, players, transactions, standings, injuries, pending trades. The model calls `mfl({ query: "transactions", league: "..." })` instead of hand-building URLs.
- Credentials (API key) in `~/.cynco/credentials/mfl.json`, injected by the tool, never present in prompts or outcome files.
- **Read-only in this build.** The import (write) endpoints are explicitly out of scope until Phase C.
- Injury/news context comes from existing WebSearch — no new research code.

## 6. Notifications & approvals (ntfy over Tailscale)

- Self-hosted ntfy on the 5090 box, listening **only on the Tailscale interface**, access-token auth. Two topics: `cynco-alerts` (out) and `cynco-commands` (in).
- Recommendation push includes approve/reject action buttons; a tap publishes `{recId, verdict}` to `cynco-commands`. The daemon holds a persistent SSE subscription — outbound-only from its perspective, zero listening ports beyond the tailnet.
- In Phase B, "approve" means "good call, I'll do it" — the notification includes the MFL deep link so the user executes the move manually. Every clean approval advances the trust ladder.
- Free-text phone commands ("how's my roster?") ride the same command topic later — the listener exists from day one, but command handling beyond approve/reject is out of scope for this build.

## 7. Error handling

- Engine run timeout → kill, record failure, scheduler keeps going.
- Repeated failures (3 consecutive) → algedonic ntfy alert.
- ntfy unreachable → queue notifications locally, retry with backoff.
- GPU busy → defer task with backoff.
- Daemon crash → Windows Task Scheduler restarts it; persisted next-fire times prevent double-firing.

## 8. Testing

- **Unit**: scheduler fire/miss logic, ledger CRUD + trust-ladder transitions, ntfy client against a mock server, MFL tool against fixture JSON, task-file contract round-trip.
- **Integration**: daemon spawns a stub "engine" script (no model) end-to-end: trigger → delta detected → spawn → outcome → ntfy publish → simulated approval → ledger updated.
- **Manual smoke**: one real run against the actual MFL league, read-only, recommendations delivered to phone.
- **Final wire-check**: grep every new symbol and verify it is imported/called/used (standing project rule).

## Out of scope (explicit)

Phase C autonomous writes, Sleeper league support, free-text phone command handling, skill packs, channels beyond ntfy, background memory "dreaming."

## Phase C preview (not in this build)

When the trust ladder for an action type reaches its threshold, the daemon proposes promotion to `auto`. On user confirmation, that action type gains a write path through MFL import endpoints, gated by S5 approval tiers. The ledger schema in §3 already records everything needed.
