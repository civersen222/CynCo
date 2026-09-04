# engine/vibe

## Purpose
This package drives LocalCode's guided "vibe" mode for non-engineer users: a Q&A loop that
classifies task difficulty, scores confidence across four dimensions, asks clarifying questions
via side-queries to the LLM, gets the user to confirm a plain-language "teachback" of what will
be built, then delegates the actual BUILD to `ConversationLoop`. It is driven exclusively by
`engine/main.ts`, which owns the single `VibeController` instance and wires its `emit`, `sideQuery`,
and `loop` callbacks. It must never let the model skip the teachback confirmation before opening
the build gate (Pask two-directional agreement, Phase 6a), and `explain` mode must never write,
edit, or create files (Phase 6b read-only constraint).

## Key files
| File | Role |
|---|---|
| `controller.ts` | `VibeController` — orchestrates the full loop: scan project, ask questions, teachback, build, report, escalate. |
| `engine.ts` | `VibeLoopEngine` — the `VibeState` state machine and confidence bookkeeping that `VibeController` drives. |
| `confidence.ts` | Difficulty classification (`classifyPromptComplexity`) and `ConfidenceScorer`, the 4-dimension confidence tracker. |
| `phaseOrdering.ts` | `orderPhasesByEntailment` — orders wizard phases by prerequisite using Pask's `EntailmentMesh`. |
| `types.ts` | Shared types: `VibeState`, `VibeMode`, `VibeEvent`/`VibeCommand`, `MODE_CONFIG` per-mode behavior. |

## Important types & functions
- **`synthesizeDecisionAssertions`** (`controller.ts:19`) — turns answered Q&A pairs into `D-XX` DoD assertions; called by `createContractFromDecisions` to seed `globalContract` before BUILD.
- **`VibeController`** (`controller.ts:88`) — the orchestrator class; constructed once in `engine/main.ts`'s `getOrCreateVibeController`.
- **`VibeControllerOptions`** (`controller.ts:58`) — constructor shape (`emit`, `sideQuery`, `loop`, optional `timeoutMs`, default 120s).
- **`VibeLoopEngine`** (`engine.ts:8`) — state machine; `start`, `transitionToBuild`, `transitionToTeachback`, `completeTask`, `escalate`, `handleAction`, `handleEscalationResponse`.
- **`classifyPromptComplexity`** (`confidence.ts:40`) — maps a description to a `DifficultyLevel` (`trivial`…`massive`) via keyword/word-count heuristics; called by `VibeLoopEngine.start`.
- **`ConfidenceScorer`** (`confidence.ts:76`) — tracks `purpose`/`mechanics`/`integration`/`ambiguity` scores; `overall()` is the min of all four; `isReady()` compares to `CONFIDENCE_THRESHOLDS[difficulty]`.
- **`INCREMENTS_PER_ANSWER`** (`confidence.ts:9`) — fixed per-difficulty confidence bump used by `ConfidenceScorer.increment`.
- **`orderPhasesByEntailment`** (`phaseOrdering.ts:10`) — topologically orders `Phase[]` by `requires`, returns input order unchanged on cycle detection.
- **`MODE_CONFIG`** (`types.ts:48`) — per-`VibeMode` behavior: `reproduceFirst` (fix), `readOnly` (explain), `minAgreement` (Pask floor for BUILD, `SharedProcedures` for all modes).
- **`minAgreementForBuild`** (`types.ts:55`) — reads `MODE_CONFIG[mode].minAgreement`.

## Data flow
1. `engine/main.ts` handles TUI command `vibe.start` and calls `VibeController.start(mode, description)`.
2. `start` sets `loop.setApproveAll(true)`, runs `scanProject()` (walks the cwd, reads key config/source files, summarizes via `sideQuery`), seeds baseline confidence, and emits the first `vibe.question`.
3. Each `vibe.answer` reaches `handleAnswer`: short picks (A/B/C, <10 chars) accumulate into `answers` and call `generateQuestion` (which side-queries the LLM for the next question or `READY`); substantive text directives go straight to `enterTeachback`.
4. `enterTeachback` sets all confidence dimensions to 100, summarizes understanding via `sideQuery`, and emits a `teachback` question asking the user to confirm.
5. `handleAnswer('teachback', …)` checks `buildGateOpen()` (Pask agreement ≥ `MODE_CONFIG[mode].minAgreement` AND `ConfidenceScorer.isReady()`); if open, calls `executeBuild()`.
6. `executeBuild` optionally researches via `shouldResearch`/`loop.handleUserMessage`, builds the task prompt (`buildTaskPrompt`, includes locked D-XX decisions and mode constraints), calls `createContractFromDecisions`, then `loop.handleUserMessage(buildPrompt)`.
7. After build, `loop.getGovernanceReport().stuckTurns >= 3` routes to `generateEscalationSummary`/`engine.escalate`; otherwise `generateCompletionReport` verifies the outcome via `sideQuery`, reports pass/fail to `loop.reportVerification`, and emits `vibe.task_complete`.

## Gotchas
- Teachback is a hard gate: BUILD only starts through `buildGateOpen()`, which requires both Pask agreement at `MODE_CONFIG[mode].minAgreement` and `ConfidenceScorer.isReady()` — pinned by `engine/__tests__/vibe/teachbackGate.test.ts`.
- `explain` mode is READ-ONLY: `MODE_CONFIG.explain.readOnly` injects a "do NOT write, edit, or create any files" constraint into the build prompt; `fix` mode injects "REPRODUCE FIRST" — both pinned by `engine/__tests__/vibe/modeRecovery.test.ts`.
- `sideQueryWithTimeout` (`controller.ts:67`) races every `sideQuery` call against `timeoutMs` (default 120s) — every call site has a `catch` fallback, so a timeout must never propagate as an unhandled rejection (`engine/__tests__/vibe/controllerIntegration.test.ts`, describe block `sideQuery timeout`).
- `MAX_QUESTIONS = 30` (`controller.ts:16`) is a safety valve only — the LLM is expected to say `READY` before that; do not treat it as the normal exit path.
- `just_build` pre-seeds Pask agreement to the mode's floor so a single teachback confirm can open the gate, but the loop must still go through `enterTeachback` — it is an escape hatch, not a bypass (`controller.ts:279-287`).
- In vibe mode the raw token stream is suppressed but `tool.start`/`tool.complete` events intentionally still flow (TUI activity lines/animation) — pinned by `engine/__tests__/vibe/vibeModeSuppression.test.ts`, gated behind `CYNCO_INTEGRATION=1`.
- `writePlanFile`/`readPlanFile`/`writeStateFile`/`readStateFile` read/write `.cynco-plan.md` and `.cynco-state.md` in `process.cwd()` via `require('fs')` — tests must `process.chdir()` into a temp dir first (see `teachbackGate.test.ts`, `modeRecovery.test.ts`).
