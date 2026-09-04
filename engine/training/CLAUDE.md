# engine/training

## Purpose
Turns a finished agent task into fine-tuning data: what actually happened (trajectories, git facts, test/build results) becomes a measured reward, and the reward-eligible conversation becomes ChatML rows for SFT/DPO. The rule the whole package enforces is that a component is either MEASURED from something that actually happened or it is `'unknown'` and leaves the reward denominator — never assumed, never hardcoded to 1. Callers are `engine/bridge/conversationLoop.ts` (per-task recording, git facts, labeling), `engine/dashboard/server.ts` and `engine/training/runTraining.ts` (corpus stats and the SFT/DPO/promote pipeline), and every VSM-level component (`s2Coordinator.ts`, `subAgent.ts`, `s5/orchestrator.ts`, `vsm/cyberneticsGovernance.ts`, `main.ts`) that logs `(input, decision, outcome)` triples. It must never fabricate a measurement (F21, F43, F47), never let secrets or raw file contents reach the corpus unredacted, and never let a labeler version change meaning without bumping `LABELER_VERSION` (docs/cynco-failure-log.md F21, F25, F26, F27, F29, F43, F47).

## Key files
| File | Role |
|---|---|
| `adapterNames.ts` | Derives the three names (dir, file, Ollama tag) one training version produces, from a single validated version string. |
| `datasetBuilder.ts` | Loads trajectories+rewards, filters by eligibility, builds SFT/DPO JSONL, and gates training readiness. |
| `decisionJournal.ts` | Append-only, fsync'd JSONL writer for per-VSM-level `(input, decision, outcome)` journal entries. |
| `gitFacts.ts` | The only module that shells out to git; measures what a task actually changed (diffs, test-case deltas, dirty paths). |
| `messageSnapshot.ts` | Pure sanitizer that redacts secrets/sensitive paths and caps sizes before a conversation is persisted as corpus. |
| `rewardLabeler.ts` | Computes the scalar reward from `RewardComponents`, applies the anti-reward-hacking gate, persists `<taskId>.reward.json`. |
| `runTraining.ts` | CLI orchestrator for the `dataset → sft → promote → full` pipeline; the only stateful entry point (runs a stage on import). |
| `taskOutcome.ts` | Pure: turns raw observations (tests, commands, contract, git) into `RewardComponents`. |
| `trainingArgs.ts` | Pure argv parser for the training CLI, split out so it can be unit-tested without triggering a training run. |
| `trajectoryRecorder.ts` | Per-turn JSONL writer plus task-end conversation snapshot writer (calls into `messageSnapshot.ts`). |
| `types.ts` | `JournalEntry`/`BackfillRecord` types and their factory functions for `decisionJournal.ts`. |

## Important types & functions
- **`adapterNames`** (`adapterNames.ts:24`) — derives `dir`/`file`/`ollamaTag` from one version string; called by `runTraining.ts` stageTrain/stagePromote.
- **`DecisionJournalWriter`** (`decisionJournal.ts:27`) — `log`/`backfill` append entries to `~/.cynco/training/s{1-5}-decisions.jsonl`; obtained via `getJournal()`/`initJournal()` from every VSM-level caller.
- **`sanitizeMessages`** (`messageSnapshot.ts:201`) — redacts secrets/sensitive-path tool I/O and caps sizes; called by `TrajectoryRecorder.endTask`.
- **`buildComponents`** (`taskOutcome.ts:405`) — pure function turning a `TaskOutcomeInput` into `RewardComponents`; called by `conversationLoop.ts` at task end and by `rewardLabeler.relabel`.
- **`contractFactsFrom`** (`taskOutcome.ts:67`) — extracts `ContractFacts` from a `ContractSnapshot`, keyed on whether it has assertions, never on `active` (F43).
- **`computeReward`** (`rewardLabeler.ts:133`) — weighted mean of measured positive components minus stuck-turn/iteration penalties, with the `testsUnmodified === 0` veto to `-1.0` checked first.
- **`finalizeTask`** (`rewardLabeler.ts:160`) — computes the reward, persists `<taskId>.outcome.json` (evidence) and `<taskId>.reward.json` (verdict); called by `conversationLoop.ts`.
- **`TrajectoryRecorder`** (`trajectoryRecorder.ts:114`) — `startTask`/`recordTurn`/`endTask`; the per-task JSONL writer, obtained via `getTrajectoryRecorder()`/`initTrajectoryRecorder()`.
- **`collectGitFacts`** (`gitFacts.ts:463`) — the sole entry point that measures a task's diff against a base sha; returns `null` (not a guessed empty result) when unmeasurable.
- **`evaluateReadiness`** (`datasetBuilder.ts:504`) — gates whether the corpus is trainable (volume, pairable negatives, unsaturated mean, non-zero built rows); called by `runTraining.ts` stages `stats`/`dataset`/`sft`.
- **`exportDatasets`** (`datasetBuilder.ts:423`) — loads trajectories, builds `sft.jsonl`/`dpo.jsonl`/`stats.json`, always rewrites both files even when empty.

## Data flow
1. During a task, `conversationLoop.ts` calls `TrajectoryRecorder.startTask`/`recordTurn` (`trajectoryRecorder.ts`) to append per-turn JSONL to `~/.cynco/trajectories/<taskId>.jsonl`, and `DecisionJournalWriter.log` (`decisionJournal.ts`) to append VSM-level decision triples.
2. At task end, `conversationLoop.ts` calls `collectGitFacts`/`collectDirtyPaths`/`commitsSince` (`gitFacts.ts`) plus its own test/build observations to build a `TaskOutcomeInput`, then `buildComponents` (`taskOutcome.ts`) turns it into `RewardComponents`.
3. `finalizeTask` (`rewardLabeler.ts`) calls `computeReward`, applies the `testsUnmodified` anti-reward-hacking gate, and writes `<taskId>.outcome.json` (raw evidence) and `<taskId>.reward.json` (verdict) to `~/.cynco/rewards`.
4. `TrajectoryRecorder.endTask` (`trajectoryRecorder.ts`) slices the session to this task's boundary (`sliceTaskMessages`), calls `sanitizeMessages` (`messageSnapshot.ts`) to redact/truncate it, and writes `<taskId>.messages.json`.
5. `runTraining.ts --stage dataset` calls `exportDatasets` (`datasetBuilder.ts`), which `loadTrajectories`, filters to `isUsable` rows (grounded labeler version, not degenerate, not quarantined, snapshot present), and writes `sft.jsonl`/`dpo.jsonl`/`stats.json`.
6. `runTraining.ts --stage sft` reads `stats.json`, calls `evaluateReadiness` (`datasetBuilder.ts`) as a gate, then invokes `scripts/train_sft.py`; `--stage promote` calls `adapterNames` (`adapterNames.ts`) and verifies the result is actually loadable via `resolveAdapter` before declaring success.

## Gotchas
- `runTraining.ts` parses `process.argv` and dispatches a stage at import time, so importing it to test argument parsing runs a training stage — parsing lives in `trainingArgs.ts`'s pure `parseTrainingArgs` instead (F27, pinned by `engine/__tests__/training/trainingArgs.test.ts`).
- The Ollama tag and the adapter filename were once the same string (`cynco-personalized:${version}`); a colon is illegal in an NTFS filename, so promotion silently wrote an unloadable file and exited 0 — `adapterNames()` derives all three names once, and `stagePromote` calls `resolveAdapter` to check the claim rather than announce it (F29, pinned by `engine/__tests__/training/adapterNames.test.ts`).
- `finalizeTrajectory` used to record a task's contract only when `isActive()`, so `resolveUnverified`'s forced failures were erased by the same deactivation that produced them, and `contract: null` became indistinguishable from "no contract at all" — `contractFactsFrom` keys on whether assertions exist, never on `active` (F43, pinned by `engine/__tests__/training/contractFactsFrom.test.ts`).
- `testsPass` and `taskCompleted` read the same test observations and must apply the identical "narrower than an earlier run" scope rule, or a run can be paid for a suite standing red under one component while the other reads `'unknown'` (F47, pinned by `engine/__tests__/training/testsPassScope.test.ts`).
- A crashed run with an otherwise-unmeasured outcome (`task-25d8015a`) was once labeled reward 0.9882 for a run that never reached an ending — `finalizeTask` now marks `degenerate: true` unless `hasOutcomeEvidence(components)` is true AND `outcome.endedInEngineError !== true` (F21, pinned by `engine/__tests__/training/rewardLabeler.test.ts`).
- A hand-set `quarantined` judgement does not survive `relabel` on its own — derived state is recomputed every relabel pass, so `relabel` must explicitly read the existing `quarantined` field and reapply it after recomputing (F26, pinned by `engine/__tests__/training/quarantine.test.ts`).
- `LABELER_VERSION` (`rewardLabeler.ts:31`) must bump whenever a component's or a weight's meaning changes — it was once a hardcoded literal `2` through sixteen semantic changes, so records that meant different things all claimed the same version; `engine/__tests__/training/labelerIdentity.test.ts` binds the number to what the labeler actually computes.
- In `messageSnapshot.ts`, `redactSecretValues` must run before `truncate()` — truncation keeps head and tail, so a secret sitting in the retained tail of an oversized file would otherwise survive verbatim.
- `collectGitFacts` (`gitFacts.ts`) never falls back to `HEAD` when `baseSha` is unresolvable — diffing HEAD-vs-worktree makes anything the agent already *committed* during the task invisible, which would let a run that committed a gutted test suite read `testsUnmodified: 1` as a fabricated pass.
