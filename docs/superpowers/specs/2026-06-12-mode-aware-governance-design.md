# Mode-Aware Governance — Design

**Date:** 2026-06-12
**Status:** Approved (design review with user)
**Branch:** new branch after `liveness-layer` merges
**Prerequisite:** liveness-layer branch landed (one-shot mode, MFL agent, daemon)

## Problem

Several governance subsystems were calibrated for interactive chat and silently
misbehave in one-shot mission mode. Every VSM halt during the liveness-layer
week traced to the same root cause: **the governance layer does not know which
regime it is operating in.**

Incidents (all 2026-06-12, morning-brief mission):

1. **C7 hardcoded coding tools** — stuck-loop rule restricted a mission run to
   `[Edit, Write, MultiEdit, ApplyPatch, Bash]`; intersection with the mission
   pin was empty. (Fixed on liveness-layer: `activeToolNames` plumbing.)
2. **Stuck signals said "EDIT or WRITE code"** — meaningless to a read-only
   research agent. (Partially fixed: text generalized, but not mode-specific.)
3. **Teachback false divergence** — the static mission prompt contains "what";
   the Pask regex heuristic marked it a confused user, re-recorded it every
   internal turn, pinned agreement at 0.00, and the algedonic kill switch
   halted the run. (Patched on liveness-layer: dedupe + min-sample. The
   underlying miscalibration — treating a mission prompt as dialogue — remains.)
4. **S5 restriction not enforced at execution** — model kept calling a
   restricted-out tool it saw in history; calls succeeded; stuck climbed to
   15 → HALT. (Fixed on liveness-layer: per-iteration offered-set gate.)

Each fix so far has been a per-subsystem patch. This design makes
**mode-awareness a first-class input to every subsystem** so the class of bug
is closed, not just the instances. It also captures these incident→fix cycles
as structured governance training data for S5 (the Level 4 autopoietic goal).

## Non-Goals

- No new modes beyond `mission` and `interactive` (vibe loop etc. can map onto
  these later).
- No threshold retuning beyond what mode-awareness requires (kill-switch and
  HALT thresholds stay as-is).
- No changes to the daemon, scheduler, or notification path.

---

## 1. RunMode plumbing (architectural core)

**Approach A (approved):** explicit parameter, no globals.

- New type in `engine/types.ts`:

  ```ts
  export type RunMode = 'mission' | 'interactive'
  ```

- `ConversationLoop` opts (`engine/bridge/conversationLoop.ts:112` area) gain
  `mode?: RunMode` (default `'interactive'`). Construction sites:
  - `engine/daemon/oneShot.ts:99` passes `mode: 'mission'`
  - `engine/main.ts:333` (WebSocket bridge) passes nothing → interactive
- `CyberneticsGovernance` constructor
  (`engine/vsm/cyberneticsGovernance.ts:162`) becomes
  `constructor(onAlert?, opts?: { mode?: RunMode })`; stores
  `readonly mode: RunMode` (default `'interactive'`). ConversationLoop passes
  its mode at its construction site (`conversationLoop.ts:208`).
- `engine/agents/subAgent.ts:68` also constructs a governance instance:
  sub-agents inherit the parent loop's mode (a research sub-agent inside a
  mission run is still unattended).
- `getReport()` includes `mode`. S5 sees it via the existing
  `governance: { ...govReport, ... }` spread in both S5Input call sites — no
  new S5Input field needed (same pattern as `activeToolNames`).

**Why not a global:** hidden dependencies are how this codebase's wiring bugs
happen (see feedback memory). Explicit construction makes tests trivial:
`new CyberneticsGovernance(undefined, { mode: 'mission' })`.

## 2. Per-subsystem mission behavior

Each subsystem consults `this.mode` at its existing decision point.

### 2a. Conversation theory (cyberneticsGovernance.ts ~413-440)

In mission mode: skip `recordExchange` entirely and never fire
`AgreementDivergence` pain. A static mission prompt is not dialogue; agreement
is undefined without a counterparty. The dedupe (`_lastRecordedUserMessage`)
and min-sample (`getDecidedCount() >= 2`) guards added on liveness-layer stay
as defense-in-depth for interactive mode.

### 2b. Stuck-counter progress definition (cyberneticsGovernance.ts:248-262, 503-517)

Two defects, verified against current code:

1. **Signatures are name-only.** `onToolResult` pushes just `name` into
   `lastToolSignatures` (:261), and stuck detection (:509-511) counts 3+
   uniform entries as stuck. A mission calling `Mfl` five times with
   *different queries* (rosters → scores → transactions…) is doing exactly its
   job and still climbs the counter.

   Fix (both modes): signatures become param-aware —
   `name + ':' + JSON.stringify(input ?? {}).slice(0, 200)`. Stuck means
   repeating the *same call*, not the same tool. This requires adding an
   `input?: unknown` parameter to `onToolResult` and passing the tool input
   from the conversationLoop call site (wire-check item). The original
   incident (fetching the identical full player DB 8 times) is still caught:
   identical params → uniform signatures.

2. **Reset list is coding-only.** Only successful `Write | Edit | MultiEdit |
   Bash | ApplyPatch` reset `stuckCount` (:251) — in a read-only mission **no
   pinned tool can ever reset it**; recovery is impossible by construction.

   Fix: in mission mode, a successful tool call whose signature is novel
   within the current `lastToolSignatures` window resets `stuckCount` to 0.
   Interactive mode keeps the coding-tool reset list unchanged.

Backstop for trivially-reworded loops (model varies params while still
looping): the response-prefix uniformity check (:505-510) is unchanged, and
REDIRECT/HALT ceilings stay where they are.

### 2c. S5 rules (engine/s5/ruleBasedS5.ts)

- C7 legacy fallback (the hardcoded
  `['Edit','Write','MultiEdit','ApplyPatch','Bash']` branch when
  `activeToolNames` is absent) is gated to interactive mode; in mission mode
  with no `activeToolNames` it returns null (never restrict blind).
- Any other rule that names coding tools gets the same audit (sweep all rules
  for hardcoded tool lists; plan enumerates them).

### 2d. Stuck governance signal text (conversationLoop.ts ~1467-1481)

Mission-mode CRITICAL variant ends with:
"If you have enough information, STOP calling tools and produce your final
structured outcome now." Interactive keeps the current generic text. The
variant is selected by the loop's `mode`.

### 2e. S2 nudges (observed in the 2026-06-12 replay, post-fix run)

The S2 coordinator nudged "Do not describe what you will do. Call a tool now."
on the turn where the model was correctly producing its final structured
outcome (text-only by design). In mission mode, S2 must not push toward tool
use when the run is in its answer-production phase — at minimum, suppress
tool-pushing nudges when the response parses as (or begins) the structured
outcome format. Plan enumerates the nudge call sites and picks the narrowest
gate.

## 3. "No data == worst case" audit

The agreement bug pattern: a metric returns its worst value (0.0) when it has
**no sample**, and a pain/penalty path consumes it without a minimum-sample
guard. Sweep every integration consumed in `onTurnComplete` and `getReport`:

| Integration | Metric | Suspect path |
|---|---|---|
| ObserverEffectsIntegration | divergence (`checkDivergence('success_rate', 0.2)` at :399) | divergence on < N measurements |
| AutopoiesisIntegration | structural coupling (`recordInteraction` at :447) | coupling drift judged before history exists |
| PerformanceMetricsIntegration | productivity ratio / CUSUM drift | drift alarm from a cold start |
| Variety (attenuators/amplifiers) | varietyRatio | ratio computed over empty windows |
| HeterarchyIntegration | authority context | first-turn authority flapping |

Deliverable: for each metric that can punish (pain signal, S5 input, status
escalation), either (a) a minimum-sample guard with a test proving no-data is
neutral, or (b) a comment documenting why cold-start is already safe. Fixes
land with tests in the `agreementPain.test.ts` style (construct governance,
drive turns, assert no halt/pain).

## 4. Model-scored teachback (interactive only)

The regex heuristic (`conversationTheory.ts:41-42`) is a placeholder, not
conversation theory. Replace its **scoring** role, keep it as fallback:

- When a genuine new user reply follows a system explanation (the existing
  dedupe already establishes "new"), enqueue an async scoring call to the
  local model: a short classification prompt returning exactly one of
  `verified | divergent | pending`.
- **Off the hot path:** the turn does not wait. The exchange is recorded as
  `pending` immediately; when the score lands it upgrades the exchange
  (TeachbackExchange.verify). Late scores after conversation end are dropped.
- **Budget:** one small inference per genuine user reply, capped at ~64 output
  tokens, temperature 0. Uses the same provider/model as the session (no extra
  model load).
- **Fallback:** scoring error or timeout (5s) → regex heuristic result.
- **Mission mode:** never fires (section 2a skips recording entirely).
- The ≥2-decided floor on agreement pain stays regardless of scorer quality.

## 5. S5 incident capture (Level 4 feed)

Every major governance intervention becomes a structured record:

- **Triggers:** REDIRECT (stuck=10), HALT (stuck=15), kill switch, C7/S5 tool
  restriction applied, empty-restriction skip, execution-gate block,
  agreement pain.
- **Record:** `{ ts, sessionId, mode, trigger, subsystem, action, metricsSnapshot
  (stuck, agreementRatio, varietyRatio, painStreak, toolHistory tail), taskId? }`
- **Storage:** new `incidents` table in the existing GovernanceDB
  (`engine/vsm/governanceDb.ts`, SQLite at `~/.cynco/.../governance.db`),
  same lazy-init/fail-soft pattern as current tables.
- **Outcome backfill:** at run end (one-shot outcome write, or session close),
  the run's incidents get `outcome: 'completed' | 'halted' | 'killed'` so each
  record is a labeled (situation → intervention → result) training example.
- Read path: a `getIncidents(since?)` query for the dashboard and future S5
  fine-tuning export. No training pipeline in this spec — capture only.

## 6. Verification

- **Governance calibration suite** (`engine/__tests__/vsm/missionMode.test.ts`
  + extensions to existing files): simulated mission turn streams replaying
  each real incident as a fixture —
  - static prompt repeated N turns → no agreement pain, no kill switch
  - read-only tool with varied params → stuck resets (mission), doesn't
    (interactive, non-coding tool)
  - C7 with no activeToolNames → null in mission mode
  - each audited metric: cold-start neutrality test
  - incident records written on HALT/restriction, backfilled on completion
- **Live verification:** morning-brief replay task must complete with a
  genuine structured outcome (`ok: true`, real summary, no HALT) — the
  standing standard from liveness-layer.
- **Blocking wire-check (final step):** grep every new symbol (`RunMode`,
  `mode` opts, `incidents` table writers/readers, scorer entry point) and
  verify each is constructed/imported/called from the live path, not just
  tests.

## Risks / trade-offs

- **Mission stuck-reset loosening** could let a genuinely-looping mission run
  longer before HALT (novel-params spam). Mitigation: signature window check
  means only *novel* successful calls reset; uniform repetition still climbs;
  HALT ceiling unchanged.
- **Model-scored teachback adds inference cost** per interactive user reply.
  Mitigation: async, tiny token cap, only on genuine new replies, fallback on
  timeout — worst case equals today's behavior.
- **Two modes today, more later:** RunMode is a string union; adding `'vibe'`
  later is additive. Subsystems must switch on mode via narrow helpers (e.g.
  `isUnattended()`), not scattered `=== 'mission'` checks, so a third mode is
  one edit.
