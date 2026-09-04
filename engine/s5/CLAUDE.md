# engine/s5

## Purpose
S5 is the policy/decision layer of the Viable System Model: given a snapshot of governance, variety, homeostat, drift, and tool-outcome signals it decides context actions, tool restrictions, model switches, and priority shifts for the current turn. `main.ts` and `daemon/oneShot.ts` construct an `S5Orchestrator` wrapping either `RuleBasedS5` (default) or `ModelS5` (when `LOCALCODE_S5_MODEL` is set) and `bridge/conversationLoop.ts` is the sole caller of `makeDecision`/`evaluateLastDecision` per turn. Enforcement is gated by `LOCALCODE_S5_ENFORCE` (default on) — headless CynCo missions run capped to recommend-only so S5 can never kill a mission (F7) or confound the outcome ledger. S5 must never restrict tools to an empty set, and must never treat an unmeasured outcome as evidence of success or failure.

## Key files
| File | Role |
|---|---|
| `types.ts` | `S5Input`/`S5Decision`/`S5Rule` contracts shared by every implementation. |
| `orchestrator.ts` | `S5Orchestrator` — builds `S5Input` from loop state, calls the active S5 implementation, logs to audit + decision journal, tracks rule-weight outcomes. |
| `ruleBasedS5.ts` | `RuleBasedS5` — the 21+1-rule deterministic engine (C1–C7, W1–W9, I1–I5, plus opt-in P1) and `combineDecisions`. |
| `modelS5.ts` | `ModelS5` — calls a fine-tuned Ollama model for decisions, falls back to an inline rule-based implementation on any error. |
| `proactiveSurfacing.ts` | `PROACTIVE_SURFACING` (P1) rule and `classifyTaskClass` — opt-in tool pre-loading heuristic. |
| `ruleWeights.ts` | `RuleWeightManager` — persists per-rule weight adjustments from outcome feedback. |
| `exportTrainingData.ts` | Reads the S5 decision journal, joins to session outcomes, exports viable-only JSONL for `scripts/fine_tune_s5.py`. |

## Important types & functions
- **`S5Input`** (`types.ts:3`) — full state snapshot a rule evaluates against (governance, variety, homeostat, drift, difficulty, taskClass/loadedTools for surfacing).
- **`S5Decision`** (`types.ts:55`) — the combined output: tools/model/contextAction/priority/spawnAgent plus `ruleIds` and `rejected` (fired-and-overridden proposals).
- **`S5Interface`** (`types.ts:102`) — `decide(input): Promise<S5Decision>` contract implemented by both `RuleBasedS5` and `ModelS5`.
- **`S5Orchestrator`** (`orchestrator.ts:41`) — owns decision history, rule-weight manager, and audit/journal logging; `makeDecision` (called from `conversationLoop.ts`) and `evaluateLastDecision` are its main entry points.
- **`ALL_RULES`** (`ruleBasedS5.ts:447`) — the ordered rule list (critical → warning → info) `RuleBasedS5.decide` iterates.
- **`combineDecisions`** (`ruleBasedS5.ts:472`) — merges all fired rule proposals: tools intersect, surfaceTools union, contextAction/priority/model use strongest/first-wins, and records `RejectedProposal`s.
- **`ALL_TOOL_NAMES`** (`ruleBasedS5.ts:16`) — derived from the canonical tool registry; restriction rules must build allow-lists from this, never a hand-maintained copy.
- **`ModelS5`** (`modelS5.ts:61`) — fine-tuned-model caller; falls back to an internal `RuleBasedS5` on connection/timeout/parse error.
- **`classifyTaskClass`** (`proactiveSurfacing.ts:33`) — keyword classifier feeding `PROACTIVE_SURFACING`; distinct from vsm's complexity-oriented `classifyTask`.
- **`RuleWeightManager`** (`ruleWeights.ts:17`) — `getWeight`/`recordOutcome`/`save` for per-rule weight persistence in `~/.cynco/training/s5-weights.json`.
- **`exportViableExamples`** (`exportTrainingData.ts:79`) — reads the journal, backfills outcomes by `decisionId`, writes `{input, output}` JSONL for only `viable`-session, non-negative-outcome decisions.

## Data flow
1. `conversationLoop.ts` builds an `OrchestratorInput` from live loop/governance state and calls `S5Orchestrator.makeDecision`.
2. `makeDecision` (`orchestrator.ts:64`) assembles the full `S5Input`, applying safe defaults for optional governance signals.
3. The active `S5Interface.decide` runs: `RuleBasedS5.decide` (`ruleBasedS5.ts:598`) evaluates every rule in `ALL_RULES` (plus `PROACTIVE_SURFACING` if `isProactiveToolsEnabled()`), collects fired `Partial<S5Decision>`s and rule ids, then calls `combineDecisions`.
4. `makeDecision` logs the resulting `S5Decision` to `AuditLogger` (`s5-decisions`) and to the training journal (`getJournal().log`), then appends a `DecisionLogEntry` to `history` (capped at `MAX_HISTORY`).
5. `conversationLoop.ts` reads `decision.contextAction`/`tools`/`model`/`priority` and, if `isS5EnforcementEnabled()`, applies them; otherwise it logs `WOULD-ENFORCE` and only recommends.
6. On the next turn, `evaluateLastDecision` (`orchestrator.ts:190`) compares before/after governance metrics, records the outcome via `RuleWeightManager.recordOutcome`, and backfills the journal entry by `decisionId` so it carries its own measured result.
7. `exportTrainingData.ts`'s `exportViableExamples` later joins the journal to session outcomes (via `loadOutcomesFromDb`) to produce training JSONL, offline from the live decision path.

## Gotchas
- `LOCALCODE_S5_ENFORCE` defaults ON; setting it `false` caps S5 at recommend/journal-only so it can neither kill a headless CynCo mission (F7) nor confound the outcome ledger — pinned by `enforcement.test.ts`.
- `ALL_TOOL_NAMES` must be derived from the tool registry, never hand-maintained — a stale hardcoded copy once silently dropped a third of the tool surface (`AskUser`, `ReplaceFunction`, `Mfl`, the four Contract tools) from every restriction allow-list, since `excludeTools()` is an allow-list and any omitted tool becomes excluded whenever S5 enforces; pinned by the `ALL_TOOL_NAMES governance surface` describe block in `ruleBasedS5.test.ts` and `everyS5RuleCanFire.test.ts`.
- C7 must never restrict to an empty tool set (`if (unused.length === 0) return null`) — a 2026-06-12 incident where coding tools were hardcoded left a read-only mission run with zero tools and it halted; pinned by `stuckRules.test.ts`.
- `evaluateLastDecision` treats a missing before/after metric as `null`, never `0`/`1.0` — a fabricated baseline produces a fabricated training label, and the old `?? 1.0` biased every unreported turn toward "positive"; pinned by `outcomeBackfill.test.ts`.
- `PROACTIVE_SURFACING` (P1) is opt-in via `LOCALCODE_S5_PROACTIVE_TOOLS` (default OFF); with the flag off the rule is entirely absent from the rule list, so `surfaceTools` is never produced — pinned by `proactiveSurfacing.test.ts`'s `RuleBasedS5 flag gating` block and `proactiveJournal.test.ts`.
- `surfaceTools` is append-only (a pre-load hint), never a restriction — it is safe to apply even when `LOCALCODE_S5_ENFORCE=false` caps everything else, per `combineDecisions`'s union merge policy.
- `RejectedProposal`s are only recorded when a rule explicitly proposed a value for a contested field (`tools`, `contextAction`, `priority`, `model`, `spawnAgent`) and the applied value differs — a rule returning `null` is uninformative, not a rejection; pinned by `rejectedCandidates.test.ts`.
- `exportTrainingData.ts` strips `decisionId`, `ruleIds`, and `rejected` from training targets (`NON_TARGET_FIELDS`) so the fine-tuned model learns from the decision itself, not by imitating the rule engine's internals or hallucinating UUIDs.
- Every rule in `ALL_RULES` must have a reachable true branch — enforced by `everyS5RuleCanFire.test.ts`, which also confirms C2/C4 are unreachable without real tool results and that the loop always feeds S5 a real (never hardcoded-empty) tool-result window.
