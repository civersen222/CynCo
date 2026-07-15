# Phase 4(d)+(e) — Task Homeostat Closeout Design

**Date:** 2026-07-15
**Branch base:** `main` @ 6310992 (P4.3 merged, PR #47)
**Status:** design approved; awaiting spec review → implementation plan

## Goal

Ship the two remaining Phase 4 items from `docs/STATE-AND-VISION-2026-07-12.md:299`:

- **4(d)** — Re-reference S3: classify *thrashing* (variety high ∧ error flat) vs *healthy exploration* (variety high ∧ error falling), as a per-turn measurement signal.
- **4(e)** — Report *regulator fidelity* per session: did the contract assertions predict the actual work?

Both grant **no new authority**. Like every Phase 4 signal, they enter the Phase 3 validation gauntlet — no S5 rule acts on them yet.

## Locked design decisions (do not revisit)

- **Measurement only — no new authority.** No S5 rule consumes `explorationState` or `regulatorFidelity`. Interventions are out of scope.
- **4(d) output taxonomy:** `explorationState: 'healthy_exploration' | 'thrashing' | 'floundering' | null`. Three named states plus null gives the gauntlet more discrimination than the STATE doc's two.
- **4(d) variety gate:** "variety high" = `turnsObserved >= 4 AND varietyWindowed / min(turnsObserved, 10) >= 0.6`. Uses the P1.5 `varietyWindowed` distinct-state count. The 4-turn floor prevents early-session misfire (a single multi-tool turn inflates the ratio). The 0.6 threshold and floor are **tunable** — the gauntlet validates them.
- **4(e) metric:** a composite struct, not an opaque score — `{ hadContract, resolutionRate, finalTaskError, contractReplacements }`. Components stay separable so falsification analysis can see *why* a session scored low.
- **4(e) is session-level, not per-turn.** Computed once at session end. **Not** plumbed to S5Input (S5 is per-turn; fidelity is only known at end).
- **4(e) ships on all three surfaces** (workspace/vibe/mission), mirroring the P4.2 contract-auto-create pattern and the "no lazy degradation" rule.
- **Sealed before the ablation return.** The 4(e) tracker updates in the always-track zone of `onTurnComplete` (ablated runs must still measure, same as windowedVariety/taskModel/turnNovelty). 4(d) is derived in `getReport()` from already-sealed values.
- **protocol.ts stays import-free:** new per-turn field `explorationState` widened to `string` on the wire (same convention as errorTrend). The session-fidelity event carries plain JSON.

## 4(d) — `explorationState` (per-turn signal)

### New module: `engine/vsm/explorationState.ts`

A pure, stateless function — no class, no per-turn state (all inputs are already sealed elsewhere):

```
export type ExplorationState = 'healthy_exploration' | 'thrashing' | 'floundering' | null

export function classifyExploration(
  varietyWindowed: number,
  turnsObserved: number,
  errorTrend: 'rising' | 'falling' | 'flat' | null,
): ExplorationState {
  // "variety high" gate
  if (turnsObserved < 4) return null
  if (varietyWindowed / Math.min(turnsObserved, 10) < 0.6) return null
  // variety is high — errorTrend names the regime
  switch (errorTrend) {
    case 'falling': return 'healthy_exploration'
    case 'flat':    return 'thrashing'
    case 'rising':  return 'floundering'
    default:        return null   // no active contract → no error signal
  }
}
```

### Wiring

- `engine/vsm/cyberneticsGovernance.ts` `getReport()`: compute
  `explorationState: classifyExploration(this.windowedVariety.count(), this.turnCount, taskSnapshot.errorTrend)`.
  `this.turnCount` (incremented in `onTurnComplete`, `cyberneticsGovernance.ts:397`) is the completed-turn count → the correct "turnsObserved"; window occupancy is `min(turnCount, 10)`.
- `engine/vsm/types.ts` `GovernanceReport`: add `explorationState: ExplorationState` after `progressRate`.
- Plumb the exact P4.3 chain:
  - `engine/bridge/protocol.ts` `GovernanceStatusEvent`: `explorationState?: string | null`.
  - `engine/bridge/conversationLoop.ts` governance.status emit: `explorationState: turnReport.explorationState`.
  - `scripts/cynco-ledger.mjs` per-turn ingest: `explorationState: m.explorationState ?? null`.
  - `engine/s5/types.ts` `S5Input`: `explorationState: ExplorationState` (measurement only; no rule consumes it).
  - `engine/s5/orchestrator.ts` mapping: `explorationState: input.governance.explorationState`.
- Update every `GovernanceReport` and `S5Input` object literal in tests/fixtures (same set touched by P4.3).

### Tests

- `engine/__tests__/vsm/explorationState.test.ts` (pure function): gated-out under 4 turns; gated-out on low variety; each of falling/flat/rising → healthy/thrashing/floundering; null errorTrend → null; boundary at exactly 0.6 and exactly 4 turns.
- Extend `engine/__tests__/vsm/signalsReport.test.ts`: report carries `explorationState` after a high-variety, error-falling sequence.

## 4(e) — `regulatorFidelity` (per-session signal)

### New module: `engine/vsm/regulatorFidelity.ts`

A session-scoped tracker:

```
export type RegulatorFidelity = {
  hadContract: boolean          // was a contract ever active this session
  resolutionRate: number | null // (passed+failed)/countable of the final contract; null if no countable
  finalTaskError: number | null // last sealed taskError
  contractReplacements: number  // count of title changes across the session (P4.2 rollover)
}

export class RegulatorFidelityTracker {
  // observe(snapshot) called each turn seal: set hadContract, count title changes
  // getFidelity(finalTaskError): RegulatorFidelity | null   (null if never had a contract)
}
```

- **Replacement counting:** increment when the current active-contract title differs from the last observed active title. A rollover from active→inactive→active with a new title counts once.
- **resolutionRate:** computed from the *final* contract snapshot at `getFidelity` time: `(passed + failed) / (total - skipped)`; null when countable is 0.
- **finalTaskError:** passed in by the caller (the governor's last sealed `taskError`), so the tracker never re-reads the contract for error.
- Returns `null` when `hadContract` is false (a no-contract session has no regulator to score).

### Wiring

- `CyberneticsGovernance`: `private regulatorFidelity = new RegulatorFidelityTracker()`; call `this.regulatorFidelity.observe(globalContract.snapshot())` in the always-track zone of `onTurnComplete` (before the ablation return). Expose `getSessionFidelity(): RegulatorFidelity | null` that calls `getFidelity(lastSealedTaskError)`.
- **Emission at session end — all three surfaces:**
  - **Protocol:** new event type `governance.session_fidelity` in `engine/bridge/protocol.ts` carrying the struct (plain JSON; unions widened to string/number as needed).
  - **Interactive + vibe:** emit the event and include the struct in the handoff written by `engine/memory/lifecycle.ts` `onSessionEnd` (extend the `Handoff` type in `engine/memory/types.ts` with an optional `regulator_fidelity` field).
  - **Mission (headless):** `scripts/cynco-ledger.mjs` ingests the `governance.session_fidelity` event and stores a **top-level** `regulatorFidelity` field on the mission record (not per-turn).
- The plan will pin the exact session-end call sites for each surface (conversationLoop teardown, vibe-loop completion, mission finalize).

### Tests

- `engine/__tests__/vsm/regulatorFidelity.test.ts` (tracker unit): no contract → null; all-passed contract → resolutionRate 1.0; mixed passed/failed/pending → correct fraction; skipped excluded from denominator; title change bumps `contractReplacements`; inactive→active-new-title counts one replacement; finalTaskError passed through.
- `engine/__tests__/vsm/signalsReport.test.ts` or a new `sessionFidelityReport.test.ts`: `getSessionFidelity()` returns the struct after a session with a contract; null with none.
- `engine/__tests__/harness/cyncoLedger.test.ts`: a `governance.session_fidelity` event lands as a top-level `regulatorFidelity` field on the mission record; absent event → field null/omitted.

## Constraints & non-goals

- **No new authority.** Neither signal changes any gate, temperature, tool set, or S5 decision. Interventions are future work.
- **No S5Input plumbing for 4(e).** Session-level, end-only.
- **No file/assertion semantic matching for 4(e).** "Did assertions predict the work?" is answered via resolution + error + churn, not by matching assertion text to `files_modified` (YAGNI; semantically fragile).
- Pre-existing minors from P4.1/P4.3 (tokPerSec typing, agreementRatio `as any`) remain out of scope.

## Integration verification (final plan step, BLOCKING)

Mirror P4.3's wire check:
- `grep` proves `classifyExploration` is imported AND called in `getReport()`; `explorationState` present in all 6 per-turn plumbing files.
- `grep` proves `RegulatorFidelityTracker` imported, instantiated, `observe()` called in `onTurnComplete`, and `getSessionFidelity()` called at each surface's session-end; `regulatorFidelity` / `session_fidelity` present in protocol, ledger, lifecycle/handoff.
- Full `npx vitest run` reconciled against the branch baseline (expected: baseline + new test count, zero regressions; note the pre-existing flaky `oneShot` 5s-timeout).
- STATE doc `:299` marker updated: 4(d)/(e) shipped; Phase 4 complete.

## Expected surfaces touched

New: `explorationState.ts`, `regulatorFidelity.ts` (+ 2–3 test files).
Modified: `types.ts`, `cyberneticsGovernance.ts`, `protocol.ts`, `conversationLoop.ts`, `cynco-ledger.mjs`, `s5/types.ts`, `s5/orchestrator.ts`, `memory/types.ts`, `memory/lifecycle.ts`, vibe-loop + mission session-end call sites, and the shared test fixtures.
