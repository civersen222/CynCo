# Vibe Loop Completion — Design Spec

**Date:** 2026-07-04
**Status:** Approved by user
**Delivery:** One spec, three sequential plans/branches/PRs, merged in order:
1. `vibe-harden` — verify + fix + test the existing wiring
2. `vibe-modes` — continue / fix / explain become real behaviors
3. `vibe-phases` — ProjectWizard → phased execution with pause-and-check-in

Each PR is independently shippable. PR N+1 branches from main after PR N merges (GitHub PR flow: push → PR → merge on web → pull main).

---

## Background

The vibe loop is CynCo's key differentiator: a guided contractor-style workflow for
non-engineer users (UNDERSTAND → BUILD → REPORT → escalation), with a confidence
scorer and plain-language reporting. Phases 1–3 were implemented 2026-04-23 and the
wiring is complete end-to-end:

- `engine/vibe/` — types.ts, engine.ts (state machine), confidence.ts (scorer),
  controller.ts (826-line orchestrator)
- `engine/bridge/protocol.ts` — 6 vibe events + 4 vibe commands in the unions
- `engine/bridge/conversationLoop.ts` — `vibeMode` flag + event suppression
- `engine/main.ts` — command routing to `VibeController`
- `tui/localcode_tui/screens/vibe_loop.py` (549 lines), `app.py` routing,
  `guided.py` buttons, `workspace.py` `/project` entry

**But:** it has never been verified end-to-end since April; conversationLoop.ts has
changed heavily (~70 commits: liveness layer, nudge cooling, GS signals). The engine
integration test is 13 lines. The mode buttons (new/continue/fix/explain) all run
the identical generic flow — controller.ts checks the mode (~line 504) and ignores
it. `VibeLoopScreen(phases=...)` is accepted but never used.

## Goals

1. Make the existing wiring provably work against today's engine (tests + live run).
2. Make the four modes behave distinctly (the differentiator actually differentiates).
3. Wire ProjectWizard phases into the loop with cross-session resume.

## Non-Goals

- Voice input/output.
- AI-generated test suggestions in completion reports.
- New protocol message types (design constraint: none are needed).
- Reworking the confidence scorer or state machine internals.

---

## PR 1: `vibe-harden` — verify + fix + test

**Goal:** trust. All existing wiring covered by integration tests, fragilities fixed,
one live end-to-end run passing against the real model.

### Integration tests (mocked model)

New `engine/__tests__/vibe/controllerIntegration.test.ts` covering the full chain
the current 13-line test ignores:

- `vibe.start` → controller emits `vibe.question` with confidence state
- answers → `vibe.confidence_update` increments → threshold crossing triggers BUILD
- BUILD delegates to `ConversationLoop.handleUserMessage` with `vibeMode=true`,
  and suppression actually suppresses `stream.token` during vibe builds.
  **Amended after code review:** `tool.start`/`tool.complete` intentionally DO
  reach the TUI — app.py:228-263 renders them as plain-language activity lines
  and drives the worker animation. Tests protect both directions: token stream
  suppressed, tool events flowing.
- REPORT → `vibe.task_complete` carries `files_modified` sourced from
  `buildHandoff()` (verifies the uncertain contract)
- governance-stuck → `vibe.escalation` → `vibe.escalation_response` resumes the loop

### Hardening

- **Provider-aware sideQuery (rot bug found in code review):** main.ts:404 builds
  the vibe controller's sideQuery on Ollama-only `/api/chat`; with the llama-cpp
  primary backend every vibe sideQuery fails and degrades to fallbacks.
  conversationLoop.ts:1287 already has a provider-aware `sideQuery` — expose it
  publicly and route the vibe controller through it.
- **sideQuery timeouts:** every `sideQuery` call in controller.ts gets a timeout
  (default from `LOCALCODE_TIMEOUT`). On timeout the existing per-call fallback
  paths engage (fallback question, generic analogy, etc.) — never a silent hang.
- **Escalation-dialog race:** app.py pushes `EscalationDialog` via
  `asyncio.ensure_future` fire-and-forget; concurrent escalations can race.
  Serialize dialog presentation.

### Live E2E

`scripts/vibe-e2e.ts` — a scripted WebSocket client that plays the TUI role against
the real headless engine (Qwen3.6 on llama.cpp): connect → `vibe.start` → answer
generated questions → tiny build task in a temp dir → assert `vibe.task_complete`
arrives with files_modified. Kept in the repo as a manual smoke tool (not CI).
Whatever the last 70 commits broke gets fixed in this PR.

### Exit criteria

- All vitest (engine) + pytest (TUI) green
- Live E2E passes on the real model
- PR merged on GitHub

---

## PR 2: `vibe-modes` — continue / fix / explain

**Design principle:** no new protocol messages. Mode-specific steps are expressed as
ordinary `vibe.question` / `vibe.state_changed` events. Mode logic lives entirely in
`VibeController`; the TUI is nearly untouched.

### Shared foundation: upgraded project scan

`scanProject()` (controller.ts:729), used by all modes that need context:

- Raise the 400-byte/file cap to 4 KB/file with a 64 KB total scan budget
- Add `git log --oneline -15`
- Read `.cynco-plan.md` and `.cynco-state.md` when present

### Mode behaviors

- **new** — current generic Q&A flow, unchanged; build from scratch.
- **continue** — scan first; a sideQuery produces a plain-language "here's where we
  left off: …" summary emitted as the opening message; Q&A asks about *what's next*
  (scan summary injected into the question-generation prompt). If a phase plan
  exists in `.cynco-state.md`, offer to resume the current phase (groundwork for
  PR 3).
- **fix** — first question is always "What's wrong? What did you see?" Then scan,
  then a **diagnose step**: a read-only investigation delegation to conversationLoop
  that locates the problem, followed by a confirmation question — "I think the issue
  is X; in plain terms: [analogy]. Want me to fix it?" Only on yes does the real
  build run. On no, back to Q&A.
- **explain** — scan, then answer via sideQuery with analogies. No build phase:
  understand → report directly. The report card offers "want me to change
  anything?", which restarts the loop in fix mode with context carried over.

### Tests

- Controller integration tests per mode (mocked model) asserting the distinct flows
- pytest for the explain → fix handoff on the TUI side

---

## PR 3: `vibe-phases` — wizard → phased execution

**Source of truth is the file, not memory.** When the ProjectWizard finishes, its
phase plan is written into `.cynco-plan.md` as a structured phase checklist. The
`VibeLoopScreen(phases=result)` in-memory pass remains only for immediate display —
the controller always reads phases from the file. That is what makes phased projects
survive an app restart.

### Execution flow

- `vibe.start` with a phase plan present → Q&A is scoped to phase 1 only (phase
  description injected into question generation)
- Build phase 1 → report → **pause**: the completion card's suggested action becomes
  "Start phase 2: <name>?" and the loop sits in report state until the user accepts
  (or types something else). User chose pause-and-check-in over auto-advance.
- Accepting rolls into phase 2's Q&A. Each completed phase is checked off in
  `.cynco-plan.md`; current position written to `.cynco-state.md`.

### Cross-session resume

Closing the app mid-project loses nothing: **continue** mode (PR 2) reads
`.cynco-state.md`, says "we're 2 of 5 phases in; phase 3 is <name>," and offers to
resume. No new mechanism — the PR 2 continue flow reading PR 3's state.

### TUI

Small addition to `VibeLoopScreen`: a "Phase 2 of 5: <name>" indicator (the
constructor already accepts phases; it just never displayed them).

### Tests

- Controller tests: phase-scoped Q&A, pause-after-phase, accept → next phase,
  persistence round-trip
- A resume-mid-project test tying PR 2 + PR 3 together
- pytest for the phase indicator

---

## Error handling (all three PRs)

Any failure inside a phase, build, diagnose step, or sideQuery goes through the
existing escalation protocol (`vibe.escalation` → plain-language dialog →
`vibe.escalation_response`). No new error paths.

## Verification strategy (agreed with user)

1. Automated integration tests with mocked model — live in CI forever.
2. Live headless E2E run driven autonomously via `scripts/vibe-e2e.ts` against the
   real model.
3. Final TUI smoke test by the user: launch TUI → guided mode → one real vibe task,
   before the cycle is called done.
