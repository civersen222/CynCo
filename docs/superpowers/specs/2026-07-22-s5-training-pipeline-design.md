# Outcome-Grounded S5 Training Pipeline — Design

**Date:** 2026-07-22
**Context:** The infrastructure to fine-tune and serve an S5 Decision Model already exists (`scripts/fine_tune_s5.py` trainer + `ModelS5` inference wired via `LOCALCODE_S5_MODEL` in `engine/main.ts:210-216`). It is **data-gated**: the current export path (`engine/s5/trainingData.ts` / `scripts/aggregate_training_data.py`) derives the training *target* from the same rules the model is meant to replace — i.e. distillation, not outcome-learning — and points at a directory (`~/.localcode`) that `main.ts:86-95` already migrated away from. This spec replaces that path with a real outcome-grounded pipeline that exports only decisions made in **viable** sessions and feeds the trainer end-to-end.

## Goal

Turn logged S5 decisions into outcome-grounded training data by:
1. Recording **clean** session outcomes (reject degenerate `total_turns==0` sessions at write; purge existing ones).
2. Making the decision→outcome **join** possible (fix the S5 journal to stamp the real session id).
3. Exporting `{input, output}` JSONL **reward-filtered to viable sessions** (real logged decision as the target, not a rule-derived one).
4. **Persisting** the already-live `PredictionTracker` results to `governance.db.predictions` (a flush bridge) so H1-H8 signals begin accumulating a cross-session hit-rate instead of evaporating each session.
5. Repointing `fine_tune_s5.py` at `~/.cynco` and proving an **end-to-end dry-run** export→load, removing the superseded derive-from-rules aggregator.

## Non-goals

- **No H1-H8 signal redesign.** We wire the *mechanism* that records and evaluates predictions; redesigning the signals themselves stays deferred (step 4 of the falsification program, gated on ledger data).
- **No coding-trajectory SFT.** `engine/training/scripts/train_sft.py` (14B Qwen-Coder, `{messages}` format, `~/.cynco/datasets/sft.jsonl`) is a *different* model for a different goal. Left untouched; explicitly out of scope.
- **No new inference contract.** The `output` stays a decision JSON (`ModelS5`'s existing contract). The outcome is used as a *filter*, not folded into the target.
- **No actual GPU training run.** The deliverable is a valid, loadable dataset + a proven export; training itself needs unsloth/GPU and is a manual follow-up.

## Relationship to prior work

`docs/superpowers/specs/2026-07-11-cynco-outcome-ledger-design.md` defines a **driver-side** mission ledger: the headless mission driver buffers per-turn WS-event signal vectors and writes `benchmark/cynco-ledger/missions.jsonl` for step-2 signal precision/recall scoring. That is a *separate* dataset with a *separate* consumer.

This spec is **engine-side**: it joins the engine's own `governance.db` session outcomes against the `s5-decisions.jsonl` decision journal, in-process, and feeds the model *trainer*. The prediction-loop wiring (layer 4 below) populates the engine-internal `predictions` table — complementing, not duplicating, the driver-side `missions.jsonl`. Both exist because one validates signals externally (driver) and one grounds training + validates predictions internally (engine).

## Architecture — one join key

Everything links through `sessionId`:

```
[in session]  S5 decides → journal(sessionId, input, decision)          → s5-decisions.jsonl
              PredictionTracker.check/evaluate (already live, in-memory) → completedPredictions
[session end] recordSessionOutcome(sessionId, outcome) [guard: turns>0]  → sessions
              flush tracker.completedPredictions                         → predictions (DB)
[export]      exportTrainingData: s5-decisions.jsonl ⋈ sessions BY sessionId
              → keep outcome=='viable' → {input, output}                 → ~/.cynco/training/s5_training_data.jsonl
[train]       fine_tune_s5.py --training-data ~/.cynco/training/s5_training_data.jsonl
```

### The load-bearing bug

`engine/s5/orchestrator.ts:132` stamps the S5 journal entry with `sessionId: entry.timestamp.toString()` — **not** the real governance session id (`cyberneticsGovernance._sessionId`, the same id `recordSession` uses). This silently breaks the join before it can happen: no journalled decision can ever match a `sessions` row. Fixing this is the pivot the whole pipeline turns on.

### Design choice — join at export, not backfill

`engine/training/decisionJournal.ts:48` exposes `backfill(system, entryTimestamp, outcome)`, built for "patch in outcomes unknown at decision time." **We deliberately do not use it for S5.** Rationale:
- Backfill is append-only and would require timestamp-matching to re-associate an outcome with its original decision line.
- The authoritative outcome already lives in `governance.db.sessions`.

So the journal stays immutable and the exporter performs the join (`SELECT outcome FROM sessions WHERE session_id = ?`). One source of truth for outcomes (the DB); no file mutation.

## Components / file structure

### 1. Session outcome hygiene
- **`engine/vsm/governanceDb.ts`** — `recordSession()` gains a write-time guard: reject records with `totalTurns <= 0` (return without insert; log a one-line `[governanceDb] rejected degenerate session <id> (0 turns)`). Add a `purgeDegenerateSessions(): number` method (`DELETE FROM sessions WHERE total_turns <= 0`, returns row count) plus cascade delete of orphaned `measurements`.
- **`engine/vsm/cyberneticsGovernance.ts`** — `recordSessionOutcome()` (line 1001) builds the record with `totalTurns: this.turnCount` (line 1012), which the write-guard reads; confirm it early-returns cleanly when the guard rejects. **Also fix the banned empty `catch {}` at line 1016** — CLAUDE.md and the ratchet tests treat empty catch as a stop-the-line bug; since we are editing this method, log the error or emit a `governance.alert` instead of swallowing it.
- **`engine/main.ts:399,953`** — stop passing hardcoded `'default', 0` for `strategy`/`configIndex`; thread the actual strategy/config from the governance layer (`loop.getGovernance().getStrategy?.()` / config index), falling back to `'default', 0` only if genuinely unset.
- **One-time purge:** call `purgeDegenerateSessions()` once behind a guarded startup migration in `main.ts` (idempotent — after the write-guard lands, it finds nothing on subsequent runs).

### 2. Join foundation
- **`engine/s5/orchestrator.ts:131-141`** — replace `sessionId: entry.timestamp.toString()` with the real session id. Thread the governance `sessionId` into the S5 decision path (the orchestrator is invoked from `conversationLoop`, which owns `this.sessionId` / `process.env.LOCALCODE_SESSION_ID`). Pass it in via the S5 input or an explicit arg; the journal entry must carry the same id `recordSession` uses.

### 3. Exporter (new)
- **`engine/s5/exportTrainingData.ts`** — new module:
  - `exportViableExamples(opts: { journalDir?, dbPath?, out? }): { written: number, skipped: number }`.
  - Reads `~/.cynco/training/s5-decisions.jsonl` (S5 entries only).
  - Opens `governance.db`, builds a `Map<sessionId, outcome>` from `sessions`.
  - For each S5 decision whose session outcome is `'viable'`, emit `{ input: formatInput(state), output: JSON.stringify(decision) }` — reusing `formatInput` extracted/shared from `trainingData.ts`; the `output` is the **real logged decision**, not `deriveDecision`.
  - Writes to `~/.cynco/training/s5_training_data.jsonl`.
  - **Empty viable set → do not write a file; log a warning and return `written: 0`** (caller/CLI exits non-zero). Never emit a silent empty training file.
  - A thin CLI entry (`bun engine/s5/exportTrainingData.ts`) for manual/offline runs.
- **`engine/s5/trainingData.ts`** — retire `deriveDecision` (dead once the exporter uses real decisions; remove it and its tests per no-dead-code rule). Keep/relocate `formatInput` as the shared input formatter the exporter imports.

### 4. Prediction persistence bridge
`PredictionTracker` (`engine/vsm/predictionTracker.ts`) **already runs live** — `cyberneticsGovernance.ts:627-642` calls `checkTriggers`/`checkExtendedTriggers`/`evaluateOpen` every turn, opening H1-H7 predictions and computing their `correct`/`actualOutcome` inside the evaluation window. It keeps everything in memory (`openPredictions`/`completedPredictions`) and **never persists** — which is the real reason `governance.db.predictions` has 0 rows. Each session's evaluated predictions evaporate at exit. So this layer is a *persistence bridge*, not new signal wiring.
- **Flush at session end**, co-located with `recordSessionOutcome`: write every `tracker.completedPredictions` entry to `governance.db.predictions` in final form (predicted + actual + correct + evaluation turn).
- `governanceDb.recordPrediction` inserts an *open* row (no `actual_outcome`) and returns nothing; `evaluatePrediction` updates by `id`. Persisting *already-completed* predictions with that two-step API needs the inserted id, which isn't returned. Add a single-shot **`recordCompletedPrediction(record)`** to `governanceDb` (one INSERT with `actual_outcome`/`correct`/`evaluation_turn` populated). Keep the existing open/evaluate methods for any future streaming use.
- **Two dormant-signal gaps to decide in the plan** (surfaced during design, not silently inherited):
  - **H8** (`evaluateSessionEnd`) has **zero callers** and is never *opened* by either trigger check — it is fully dead. The plan must either invoke `evaluateSessionEnd` at session close (and open H8 somewhere) or explicitly document H8 as out of scope. Do not let the flush silently omit it without a decision.
  - Predictions still open at crash/exit stay in `openPredictions`, never reach `completedPredictions`, and are correctly excluded from the flush and from `getStatistics` (which only groups completed). This is the desired behavior; no null-outcome rows are written.
- No signal redesign — the H1-H8 heuristics and their correctness logic are unchanged; we only make their results durable so a cross-session hit-rate can accumulate.

### 5. Trainer repoint + dead-code removal
- **`scripts/fine_tune_s5.py`** — `DEFAULT_TRAINING_DATA`: `~/.localcode/training/...` → `~/.cynco/training/s5_training_data.jsonl`. Add a `--validate-only` flag that loads + format-checks every line (each has `input`/`output`, `output` parses as JSON) and exits **without** importing unsloth — this is the CI-friendly dry-run proof.
- **`scripts/aggregate_training_data.py`** — **delete.** Superseded by the TS exporter; it is the second derive-from-rules path and points at the migrated-away `~/.localcode`. Remove it and any reference.

## Data flow — edge cases & error handling

| Case | Behavior |
|------|----------|
| Session crashed, no outcome recorded | No `sessions` row → decisions excluded from export (no join match). |
| Degenerate session (`total_turns==0`) | Rejected at `recordSession` write; purged once from history. |
| Zero viable sessions at export | Exporter warns, writes nothing, returns `written:0`; CLI exits non-zero. |
| S5 journal entry with legacy timestamp-id | Won't match any session → excluded (old rows are lost to the join by design; only post-fix rows train). |
| Prediction still open at crash/exit | Stays in `openPredictions`, never flushed; no null-outcome row written; excluded from `getStatistics`. |

## Testing

- **`engine/__tests__/vsm/governanceDb.test.ts`** (extend): `recordSession` rejects `totalTurns==0`; `purgeDegenerateSessions` deletes only degenerate rows + orphaned measurements and returns the count.
- **`engine/__tests__/s5/exportTrainingData.test.ts`** (new): fixture journal + fixture DB → exporter keeps only viable-session decisions, emits valid `{input,output}` with the real decision as `output`; empty-viable fixture → `written:0`, no file.
- **`engine/__tests__/predictionDb.test.ts`** (extend): `recordCompletedPrediction` inserts a fully-populated row (predicted/actual/correct/turn) readable via `getAllPredictions`; a session-end flush of a `PredictionTracker` with N completed predictions writes exactly N rows.
- **`engine/__tests__/s5/orchestratorSessionId.test.ts`** (new or extend orchestrator tests): journalled S5 entry carries the injected real session id, not the timestamp.
- **E2E dry-run:** run the exporter on a fixture `~/.cynco` tree → run `python scripts/fine_tune_s5.py --training-data <fixture>.jsonl --validate-only` → expect "OK, N examples" with exit 0.
- **Post-change verification (mandatory, per CLAUDE.md):** `npm test` incl. `engine/__tests__/guards/`, and `cd tui && python -m pytest tests/ -q`.

## Wire check (BLOCKING — final task)

Grep every new/changed symbol and prove it is imported + called on a live path:
- `exportViableExamples`, `purgeDegenerateSessions` — imported and called (exporter CLI; startup migration).
- Real `sessionId` in `orchestrator.ts` journal entry — assert no remaining `entry.timestamp.toString()` as a sessionId.
- `recordCompletedPrediction` + the session-end flush — grep must show a live governance-layer call site (co-located with `recordSessionOutcome`), not only `__tests__`; and `governance.db.predictions` gains rows after a real session (was 0).
- `deriveDecision` and `scripts/aggregate_training_data.py` — grep confirms **zero** remaining references (proving the dead path is fully removed).
- `fine_tune_s5.py` default path — grep confirms no remaining `~/.localcode` reference.

## Scope note

Layers 1-3 + 5 (the SFT export pipeline) and layer 4 (prediction validation) are independently shippable. They share only the `sessionId` join foundation (layer 2). Kept in one spec at the user's request; if descoped later, layer 4 can be lifted out without unpicking the pipeline.

## Operational sequencing

Land via PR to `main` (web flow per standing preference). After merge, accumulate viable sessions by running CynCo missions (Phase-3 gauntlet), then run the exporter → `fine_tune_s5.py`. The pipeline is same-day once viable-session volume exists; the remaining distance to a *meaningful* fine-tune is mission volume, which this spec unblocks by making every viable session a real training example for the first time.
