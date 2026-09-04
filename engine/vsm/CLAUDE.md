# engine/vsm

## Purpose
This is LocalCode's VSM (Viable System Model) governance layer: it wraps the vendored `../cybernetics-core` library (Ashby, Beer, Pask, von Foerster primitives) around the agentic conversation loop to watch tool calls, detect stuck/thrashing behaviour, gate redundant reads, score falsifiable governance hypotheses (H1-H8), and persist cross-session learning to SQLite. The primary caller is `engine/bridge/conversationLoop.ts`, which constructs one `CyberneticsGovernance` per session and calls it on every tool result and turn boundary; `engine/agents/subAgent.ts` does the same for sub-agents, and `engine/dashboard/server.ts` / `engine/s5/orchestrator.ts` / `engine/s5/types.ts` read params, report types, and `DifficultyLevel` only. It must never block the model from making the edit it is being told to make (see `ReadLoopGate` relent logic below), and must never derive `taskError` from a model self-estimate — only from contract state.

## Key files
| File | Role |
|---|---|
| `ablationRunner.ts` | Governed-vs-ungoverned A/B harness: runs each test case twice and picks a winner. |
| `algedonicIntegration.ts` | Pain/pleasure signal routing + kill switch on consecutive failures. |
| `autopoiesisIntegration.ts` | Self-modification governance: parameter changes go through a `Proposal` gated by identity checks. |
| `autopoiesisVerifier.ts` | Assesses whether LocalCode itself meets autopoiesis criteria (closure, boundary, etc). |
| `conceptTable.ts` | Builds/caches the repo-wide concept-collision table used by grounding checks. |
| `constraintChecks.ts` | Autonomy, POSIWID, and freedom-ratio enforcement for S3/S4. |
| `controlSignals.ts` | Variety-driven temperature and tool-set-widening signals. |
| `conversationTheory.ts` | Pask teachback + agreement tracking + entailment mesh for task ordering. |
| `cyberneticsGovernance.ts` | Central orchestrator; owns every other integration and exposes the report API. |
| `difficultyClassifier.ts` | Classifies session difficulty from turn history into a governance intensity 0-3. |
| `essentialVariables.ts` | Registry of viability-bounded variables (error rate, context %, stuck turns, ...). |
| `eventBus.ts` | Global `EventBus` singleton — every module emits domain events through it. |
| `explorationState.ts` | Classifies variety-high regimes as healthy exploration / thrashing / floundering. |
| `feedbackControl.ts` | PID controller + feedback loop + ultrastable system for context/approval control. |
| `fingerprintRepetition.ts` | Detects identical/alternating tool-call fingerprint runs (stuck signal). |
| `governanceDb.ts` | SQLite (bun:sqlite) persistence for sessions, measurements, predictions, spend. |
| `governanceParams.ts` | Single source of truth for every named, bounded, tunable governance threshold. |
| `governanceSignal.ts` | Builds the stuck-loop warning/critical message appended to the conversation. |
| `groundingProbe.ts` | Static concept-collision detector: symbol table vs. proposed edit text. |
| `groundingTrigger.ts` | Scales a grounding finding into skip/warn/block by governance intensity. |
| `heterarchyIntegration.ts` | McCulloch redundancy-of-command: decides which S-system commands per context. |
| `homeostatIntegration.ts` | Ashby 3-variable homeostat coupling S3/S4/context pressure, with ultrastability. |
| `identityGuard.ts` | Session-end invariant + POSIWID check against a fixed `SessionRecord`. |
| `interventionPersistence.ts` | Load/save `InterventionTracker` success counts to `training/intervention-rates.json`. |
| `interventionTracker.ts` | Within-session PID-style learning of which interventions preceded success. |
| `observerEffects.ts` | Second-order cybernetics: per-observer measurement log, divergence, eigenforms. |
| `performanceMetrics.ts` | Beer's Achievement metric + CUSUM drift detection on failure rate. |
| `population.ts` | Evolving population of 10 parameter/strategy configs selected per session. |
| `predictionTracker.ts` | The 8 falsifiable H1-H8 governance hypotheses, with Wilson-score CIs and measured null baselines. |
| `progressModel.ts` | Newly-passed contract assertions per 1k tokens for the last sealed turn. |
| `readLoopGate.ts` | Denies/escalates redundant Read/Grep/Glob/Ls calls; re-arms on any file write. |
| `reflexionFeedback.ts` | Generates a specific self-correction note appended to a failed tool result. |
| `regulatorFidelity.ts` | Session-scoped: did contract assertions predict the actual work (resolution rate, replacements). |
| `s4Reflector.ts` | Periodic self-reflection: scores progress/confidence/quality/stuckness, adapts its own frequency. |
| `sessionHomeostat.ts` | Session-level viability check + parameter perturbation via `EssentialVariableRegistry`. |
| `spendReport.ts` | Formats a `SessionSpend` (from `governanceDb.ts`) into the `/spend` command's text. |
| `strategyMemory.ts` | Cross-session strategy→outcome memory (entailment mesh + structural coupling). |
| `taskModel.ts` | Computes `taskError`/`errorTrend` from contract state, CUSUM-alarmed, never from the model. |
| `testDrivenGov.ts` | Soft nudge to run tests after N consecutive edits without one. |
| `toolGating.ts` | Deterministic tool removal (not suggestion) when a tool is overused or stuck. |
| `turnNovelty.ts` | Per-turn fraction of touched file paths never seen before this session. |
| `types.ts` | Import-free shared types: `GovernanceReport`, `GovernanceAlert`, snapshot shapes. |
| `windowedVariety.ts` | Rolling-window distinguishable-state (Ashby variety) counter; shares fingerprint format with stuck detection. |

## Important types & functions
- **`CyberneticsGovernance`** (`cyberneticsGovernance.ts:102`) — the orchestrator; one instance per session, constructed by `conversationLoop.ts`/`subAgent.ts`. Exposes `onToolResult`, `onTurnComplete`, `getReport()`, `checkOrHalt()`, and getters for every sub-integration.
- **`GovernanceReport`** (`types.ts:48`) — the per-turn snapshot returned by `getReport()`; consumed by the TUI, dashboard, and S5 orchestrator.
- **`GovernanceDB`** (`governanceDb.ts:124`) — SQLite persistence for sessions/measurements/predictions/spend, opened once per `CyberneticsGovernance` under `cyncoHome()/governance/governance.db`.
- **`GOVERNANCE_PARAMS`** (`governanceParams.ts:44`) — "NO MAGIC NUMBERS IN GOVERNANCE CODE": every threshold used anywhere in this package must be registered here and read via `getParam`.
- **`ReadLoopGate`** (`readLoopGate.ts:85`) — allow/warn/deny/escalate verdicts for repeated read-only tool calls; called from `conversationLoop.ts` before Read/Grep/Glob/Ls execute.
- **`PredictionTracker`** (`predictionTracker.ts:178`) — tracks the H1-H8 hypotheses (`HypothesisId`, `predictionTracker.ts:23`) and their Wilson-score confidence intervals.
- **`TaskModel`** (`taskModel.ts:33`) — the governor's own read of contract state into `taskError`/`errorTrend`; called once per turn seal.
- **`buildGovernanceSignal`** (`governanceSignal.ts:7`) — turns a stuck-turn count into a warning/critical message appended (not prompt-rewritten) to the conversation.
- **`applyToolGate`** (`toolGating.ts:16`) — pure narrowing of an offered tool list by a restricted-name list; used by `conversationLoop.ts` each turn.
- **`evaluateGrounding`** (`groundingTrigger.ts:61`) — decides skip/warn/block for an Edit/Write/MultiEdit whose added text resolves a concept to the wrong source.
- **`ConfigPopulation`** (`population.ts:41`) — the 10-member evolving population of governance-param + strategy configs `CyberneticsGovernance` selects from at startup.

## Data flow
1. `conversationLoop.ts` constructs one `CyberneticsGovernance` (`cyberneticsGovernance.ts:195`), which loads optimized/population params and opens `GovernanceDB`.
2. Before each Read/Grep/Glob/Ls tool call, `ReadLoopGate.evaluate` runs; before each Edit/Write/MultiEdit, `evaluateGrounding` runs against the cached `conceptTable.ts` table.
3. After every tool call, `CyberneticsGovernance.onToolResult` (`cyberneticsGovernance.ts:280`) always records measurement state (tool history, fingerprints, windowed variety, novelty) and, unless ablated/paused, feeds the algedonic channel and decision journal.
4. At each turn boundary, `onTurnComplete` seals `TaskModel`, `ProgressModel`, `TurnNoveltyMeter`, updates the homeostat/feedback-control/performance-metrics integrations, and evaluates any due `PredictionTracker` triggers.
5. `getReport()` assembles the `GovernanceReport` (variety, S3/S4 balance, stuck turns, predictions, S4 reflection, heterarchy) consumed by the TUI and dashboard.
6. `buildGovernanceSignal` / `TestDrivenGovernor` / `ToolGating` translate report state into conversation-appended nudges or a narrowed tool set for the next model turn.
7. At session end, `recordSessionOutcome` writes to `GovernanceDB`, `StrategyMemory`/`ConfigPopulation` persist to disk, and `InterventionTracker` success counts are saved via `interventionPersistence.ts`.

## Gotchas
- A governance **denial** (read-loop gate, commit-scope guard, S5 restriction) is neutral for the algedonic pain counter — it neither increments nor clears it. Treating a denial as a tool failure halted a session mid-edit via the kill switch, losing 148 uncommitted lines (`algedonicIntegration.ts:38`, pinned by `algedonicIntegration.test.ts`).
- Stuck detection must fingerprint by tool name **and** normalized args, not name alone — a mission calling `Mfl` with different queries once climbed to stuck=15 and HALTed mid-answer under name-only signatures (`cyberneticsGovernance.ts:301`, `windowedVariety.ts:12`; pinned by `stuckSignatures.test.ts`, `stuckDetection.test.ts`).
- `ReadLoopGate` relents (stops refusing) a signature after `ESCALATE_AFTER` (3) consecutive denials, because `Edit` needs an exact `old_string` and a blinded model can never produce one; CynCo was observed rewriting `gilded/docket.py` via `python -c` four times while the read counter never reset (`readLoopGate.ts:15`, `readLoopGate.ts:121`; pinned by `readLoopGate.test.ts`).
- `taskError` is computed by the governor from contract state and must **never** be asked of the executing model as a mid-run self-estimate — online progress prompting is counterproductive (`taskModel.ts:5`; pinned by `taskModel.test.ts`).
- `GovernanceDB` must be a static top-level `import`, not a `require()` inside the constructor — a runtime `require` of a relative TS path resolves under Bun but not under the vitest transform, silently disabling persistence in half the suite (`cyberneticsGovernance.ts:56-59`; pinned by `governanceDb.test.ts`).
- `windowedVariety.ts` is deliberately **not** folded into `cybernetics-core` (vendored, do-not-modify) and shares its fingerprint format with stuck detection by contract, not by import — keep the two in sync by hand.
- `PredictionTracker`'s null baselines start as hand-guessed `assumed` constants in `HYPOTHESES` and only switch to a `measured` per-session rate once `MIN_BASELINE_SAMPLES` (20) untriggered observations exist — below that the measured rate is noisier than the guess it would replace (`predictionTracker.ts:152-158`; pinned by `nullBaseline.test.ts`).
- `applyToolGate` never returns an empty tool set — if narrowing would remove every tool, the original set passes through unchanged, because a starved model is worse than a repetitive one (`toolGating.ts:13`; pinned by `toolGating.test.ts`).
