# Grounding the Coding-Trajectory Training Pipeline — Design

**Date:** 2026-07-25
**Branch:** `training-reward-grounding`
**Status:** approved (user, 2026-07-25)

## Context

The governance dashboard reports `Tasks 302 / Turns 5752 / SFT Examples 147` with a progress bar
toward 300. The number is real; what it measures is not. Verified against `main` @ `841ea09` and
the live `~/.cynco` tree on 2026-07-25:

| Observation | Evidence |
|---|---|
| All 147 SFT examples are labeled `reward: 1.0` | 147/147 reward files equal exactly `1`; `dpoPairs: 0`; `avgReward: 1` |
| Weights sum to ~2.8 and clip to 1.0 | `rewardLabeler.ts:48-62` — the non-test terms alone total 1.8, so the ceiling is reached before `testsPass` is consulted |
| `testsPass` genuinely varies and is discarded anyway | min 0.4286, max 1.0 across the 147; every one still scored 1.0 |
| `finalizeTask` has no live caller | only importers are `datasetBuilder.ts:16` (offline backfill) and its tests |
| `testsPass` is not about tests | `datasetBuilder.ts:302` sets it to `toolSuccessRate` — the fraction of tool calls that did not error |
| Three components are assumptions | `datasetBuilder.ts:303-310` hardcodes `typecheckPass`/`buildPass`/`testsUnmodified` to `1` |
| Two components are one bit | `diffClean` and `taskCompleted` both derive from `usedActionTools` (0.7 combined weight on a single boolean) |
| `ranTests` is dead | computed at `datasetBuilder.ts:296`, never read |
| 155 trajectories are unlabeled | 302 trajectory files, 147 reward files |

Two corrections to the prior diagnosis, both established by reading current code:

1. **300 is not a gate.** The only hard abort is `lines < 10` (`runTraining.ts:72-79`). The 300 is a
   warning string and a dashboard display target (`dashboard/server.ts:224`). Nothing blocks a
   training run today.
2. **Test baseline is `8 failed | 2266 passed | 35 skipped`.** Seven are the known `workflowParity`
   failures at `workflowParity.test.ts:115`; the eighth is
   `benchmark/true/polyglot/exercise.test.ts:61 assertPristine`, an environmental failure from a
   dirty exercises checkout. Both are pre-existing and out of scope. The gate for this work is that
   the count does not grow.

### The finding that reframes the work

The repairs above all target the **label**. The **input** is destroyed at recording time.

`TrajectoryRecorder` stores `inputHash: sha256(args).slice(0,12)` and nothing else — no prompts, no
tool arguments, no assistant text, no tool results. `state_features` are hardcoded zeros at
`conversationLoop.ts:3271-3283` (`testsTotal: 0` is a literal; 0 of 5752 records carry a nonzero
value). `buildSFTDataset` then synthesizes a training target from what survives. A real row from
`~/.cynco/datasets/sft.jsonl`:

```json
{"role":"user","content":"Task task-000e130a (34 turns, reward 1.00)"}
{"role":"assistant","content":"Tool sequence: CodeIndex(ok, 33ms) → Glob(ok, 9ms) → Read(ok, 5ms) → Edit(ok, 5ms) → Bash(FAIL, 823ms) → ..."}
```

Fine-tuning on this teaches the model to emit the literal string `Tool sequence: Read(ok, 12ms) → …`.
A perfect reward label on this corpus buys nothing. The hash is one-way, so the 302 existing
trajectories cannot be repaired — they can only ever produce this shape.

Also note: `recordTurn` fires once per **tool call**, not per turn. "5752 turns" is 5752 tool calls.

## Goal

Make the reward label mean something, and give it something worth labeling:

1. Capture real conversation content as the training corpus.
2. Ground `testsPass` in parsed test-runner output.
3. Call `finalizeTask` from the live engine, once per task, on every exit path.
4. Measure components or mark them `unknown` — never assume `1`.
5. Normalize the reward to its ceiling so the signal survives.
6. Keep failed runs; re-gate on variance, not volume alone.

## Non-goals

- **No training run.** Not `--stage sft`, not `--stage backfill`, not `full`. The deliverable is a
  pipeline that *could* produce a trainable dataset, plus an honest readout of whether it has.
- **No eval harness.** Argued as a prerequisite to training in "Sequencing" below, but built
  separately.
- **No S5 decision-model work.** `docs/superpowers/specs/2026-07-22-s5-training-pipeline-design.md`
  covers a different model, a different corpus, and a different consumer; it explicitly declared
  coding-trajectory SFT a non-goal. That separation holds in both directions.
- **No repair of the 147 legacy examples.** Impossible by construction (see above).
- **No changes to the two pre-existing test failures.**

## Design decisions

Four decisions were settled with the user before design; each rejected a simpler option for a
stated reason.

**D1 — Repair the label *and* capture content.** Items 2-6 are only meaningful if something
eventually consumes the labels, and the recording site is where a real test signal has to be
extracted anyway.

**D2 — Split telemetry from training corpus.** The per-tool-call JSONL stays telemetry (it feeds the
dashboard and the stuck/variety signals; it was never SFT material). A separate end-of-task message
snapshot becomes the corpus. Rejected: enriching the per-call record, which would touch a hot path
that has produced two incidents this month and still require reassembly. The crash-loss objection is
weak — a crashed task would not be a `reward: 1.0` row anyway, and `finalizeTask` will not have run
either, so the two failure modes stay aligned.

**D3 — `taskCompleted` = contract, corroborated by observation.** Contract assertions are
*agent-attested* (`ContractAssertPass`), which is the exact surface that produced the S4_DET
"claimed 25/25 passed" false success. So the contract supplies intent and real test output supplies
corroboration; a complete contract with no observed test run degrades to `unknown`, not `1`.
Rejected: observation-only, which would zero out docs/config/refactor tasks that legitimately have
no suite.

**D4 — Exclude legacy data structurally; delete `backfillRewards`.** Nothing is deleted from
`~/.cynco`; eligibility requires a content file that legacy rows cannot have. `backfillRewards` has
no honest job once `finalizeTask` is live — every guess it ever made was a known-bad `1.0` — and a
neutered version is a YAGNI trap, because re-labeling would require content that was never recorded.

## Architecture

```
[per tool call]  parseTestSummary(cmd, output) ─┬─→ telemetry JSONL (testsTotal/testsFailing, real)
                                                └─→ task observation buffer
[task start]     recorder.startTask(taskId, model)
[task end]       recorder.endTask(getMessages())  → <taskId>.messages.json   (corpus)
   (finally)     buildComponents(observations, contract, git, telemetry)
                 finalizeTask(...)                → <taskId>.reward.json     (label, v2)
[export]         eligible iff labelerVersion >= 2 AND messages.json exists
                 → sft.jsonl (real messages) + dpo.jsonl (real pairs)
```

### 1. `engine/bridge/testSummary.ts` (new, pure)

Two partial parsers exist today and neither can answer "what fraction passed":
`benignToolResult.ts` detects a runner and rejects hard errors but returns a boolean;
`bestOfN/sampler.ts:16 parseTestOutput` returns counts but must be handed a framework label and has
no hard-error guard.

```ts
export type TestSummary = { framework: string; passed: number; total: number }
export function detectFramework(command: string): string | null
export function parseTestSummary(commandOrFramework: string, output: string): TestSummary | null
```

Returns `null` when no runner is recognized, a hard-error marker is present (collection error,
`ModuleNotFoundError`, usage error, command-not-found), or no pass/fail summary appears. The
`TEST_RUNNER` / `RAN_WITH_RESULTS` / `HARD_ERROR` patterns move here verbatim; counting logic comes
from `parseTestOutput`.

Consumers:
- `isBenignTestFailure` becomes `parseTestSummary(command, output) !== null` — **behavior-preserving**,
  and its existing 9 tests must pass unmodified as proof.
- `sampler.parseTestOutput` delegates, keeping its `{passed, total}` return shape.

Per the standing lesson: when a defect is one drifted copy of N duplicates, fix the duplication.

### 2. `engine/training/trajectoryRecorder.ts` — lifecycle + snapshot

```ts
endTask(messages: Message[], meta?: { endedAt?: string }): string | null
```

Writes `<baseDir>/<taskId>.messages.json`:

```json
{ "schemaVersion": 2, "taskId": "...", "model": "...", "startedAt": "...", "endedAt": "...", "messages": [ ... ] }
```

Content policy, applied at write time:
- **Truncate** any tool-result text over **4 KB** to head 2 KB + `\n…[N bytes elided]…\n` + tail 2 KB.
  Uncapped, one `Read` of a large file dominates the example; estimated corpus is 100-300 MB across
  300 tasks without this.
- **Redact** tool results whose originating tool input path matches `.env`, `credentials`, `secrets`,
  `*.pem`, `id_rsa` → `[redacted: sensitive path]`. The snapshot otherwise contains verbatim repo
  source; it stays local under `~/.cynco` and this is stated rather than discovered.
- **Cap** the whole file at **2 MB**; past that, drop oldest non-system messages and record
  `"truncatedMessages": N`.
- `endTask` clears `_taskId`, so a `recordTurn` after it is the existing no-op-with-error, not a
  write into a finished task.

Telemetry fix: at `conversationLoop.ts:3271-3278`, populate `testsTotal`/`testsFailing` from
`parseTestSummary` when the call was a test run, replacing the `0` literals.

### 3. `engine/bridge/conversationLoop.ts` — one task boundary

`handleUserMessage` (`:675`) has at least six exits: the `:678` guard, in-loop returns near
`:1795`/`:2000`/`:2391`/`:2473`, the max-iterations fall-through at `:2606-2608`, and throws. These
are **not** enumerated. The body moves to a private `runUserMessage(...)`, and:

```ts
async handleUserMessage(text, opts) {
  try { await this.runUserMessage(text, opts) }
  finally { this.finalizeTrajectory() }
}
```

`finalizeTrajectory()` is idempotent per task (guards on the recorder's `taskId` being non-null),
wraps its body in try/catch so a labeling failure can never break a session, and calls `endTask`
then `finalizeTask`.

This applies the standing lesson directly: when a path becomes terminal, audit every *other* exit
that now diverges. A wrapper makes divergence impossible instead of caught.

### 4. `engine/training/taskOutcome.ts` (new) — measure or say `unknown`

```ts
export type ComponentValue = number | 'unknown'
export function buildComponents(input: TaskOutcomeInput): RewardComponents
```

| Component | Source | `unknown` when |
|---|---|---|
| `testsPass` | last test observation, `passed / total` | no test runner observed |
| `taskCompleted` | contract complete && `failedCount()===0` && ≥1 observation with `failed===0` → 1; contract failed → 0 | no contract and no observation |
| `typecheckPass` | exit status of an observed `tsc` / `mypy` / `bunx tsc` | no such command observed |
| `buildPass` | exit status of an observed `bun build` / `npm run build` / `cargo build` | no such command observed |
| `diffClean` | every path in `git status --porcelain` is one `fileTracker` recorded | not a git repo |
| `testsUnmodified` | see safety gate below | **never** — safety gates do not degrade |
| `stuckTurns`, `iterFraction` | existing telemetry | never |
| `userSatisfaction` | no source today | always `0` |

### 5. `engine/training/rewardLabeler.ts` — normalize to the ceiling

```
if (testsUnmodified === 0) return -1.0            // safety gate, unchanged

known   = positive components whose value !== 'unknown'
base    = Σ(wᵢ·vᵢ) / Σ(wᵢ)   over known           // ∈ [0,1]
reward  = base
        - 0.05 · min(stuckTurns, 10)
        - 0.10 · iterFraction
        + 0.30 · max(0, userSatisfaction)
clip to [-1, 1]
```

Weights are unchanged (`testsPass` 1.0, `typecheckPass` 0.5, `buildPass` 0.3, `diffClean` 0.2,
`taskCompleted` 0.5); dividing by the weight sum of *known* components removes the saturation.
`testsPass` 0.43 and 1.0 now produce different rewards, which is the entire point. If no positive
component is known, `base` is `0` and the record carries `"degenerate": true`.

Reward records gain `labelerVersion: 2`.

#### The safety gate and TDD

`testsUnmodified: 0 → -1.0` assumes test files are sacred. CynCo does TDD, where writing tests is
frequently the assigned job — implemented literally this would hard-fail every TDD task, which is
almost certainly why it was hardcoded to `1`, disabling the only safety check in the function.

The gate therefore fires on **weakening**, not touching:

- a test file is **deleted**, or
- the diff to test files has **net line deletions** while non-test files also changed.

Adding tests is free. Quietly gutting an existing suite to make it pass is `-1.0`. This targets the
`characters.py` 378→148 gutting incident without punishing legitimate red-green work.

### 6. `engine/training/datasetBuilder.ts` + `runTraining.ts` — eligibility and gate

- `loadTrajectories` also loads the sibling `messages.json` when present.
- **Eligibility:** an SFT example requires `reward.labelerVersion >= 2` **and** a messages snapshot.
  The 147 legacy rows are structurally excluded; nothing is deleted from `~/.cynco`.
- `buildSFTDataset` emits the real captured `messages` array. The synthesized
  `Tool sequence: …` string is deleted.
- `buildDPODataset` pairs real message arrays. **Low-reward trajectories are never dropped** — DPO
  needs pairs and there are zero today.
- `backfillRewards` and the `backfill` stage are **deleted**, along with the dead `ranTests`.
  `--stage dataset` and `--stage full` drop their backfill call.
- **Readiness gate** replaces the single count with three conditions, each reported separately by
  `stageStats` and the dashboard:
  - `usableExamples >= 150`
  - `negativeExamples (reward < 0.3) >= 20`
  - `avgReward < 0.9` — a saturated mean means the labeler regressed
- `dashboard/server.ts:224` reports the three conditions and relabels the figure **usable examples**.
  `stats.json` gains `usableExamples`, `negativeExamples`, `legacyExcluded`.

## Error handling

| Case | Behavior |
|---|---|
| Task ends with zero tool calls | `endTask` writes no snapshot; no reward file; not counted as usable |
| Snapshot write fails (disk, permissions) | Logged once, `finalizeTrajectory` continues to the label; never throws into the session |
| `git` unavailable or not a repo | `diffClean` = `unknown`; `testsUnmodified` = `1` (cannot observe weakening) |
| Contract inactive | `taskCompleted` falls to observation alone, else `unknown` |
| Test output parses to `total === 0` | Treated as no observation (`null`), not `0/0` |
| All positive components `unknown` | `base = 0`, record flagged `degenerate: true`, excluded from SFT |
| Legacy reward file (no `labelerVersion`) | Read as v1, counted in `legacyExcluded`, never exported |
| `endTask` called twice | Second call is a no-op (`_taskId` already cleared) |

## Testing

Every layer gets unit tests; `vitest` is the only gate (no root `tsconfig.json`, so Bun strips types
without checking and a type error reaches runtime).

- **`testSummary.test.ts`** — pytest/jest/vitest/cargo/go summaries parse to correct ratios; a
  collection error returns `null` despite a stray count in the output; an unrecognized command
  returns `null`.
- **`benignToolResult.test.ts`** — the existing 9 tests pass **unmodified**, proving the refactor is
  behavior-preserving.
- **`trajectoryRecorder.test.ts`** — snapshot has `schemaVersion: 2` and real message content;
  a >4 KB tool result is truncated with the elision marker; a `.env` read is redacted; `endTask`
  twice is a no-op.
- **`conversationLoopFinalize.test.ts`** — `finalizeTrajectory` runs exactly once on: normal
  completion, an early return, a thrown exception, and max-iterations. This is the regression test
  for the six-exit problem.
- **`taskOutcome.test.ts`** — each component resolves to a measured value with a signal present and
  to `unknown` without one; a contract marked complete with no observed test run yields
  `taskCompleted: 'unknown'`, **not** `1` (the S4_DET false-success regression test).
- **`rewardLabeler.test.ts`** — reward is strictly monotonic in `testsPass` (the specific bug:
  0.43 and 1.0 must not tie); `unknown` components leave the denominator; the safety gate still
  returns `-1.0`; net-deletion-in-tests trips the gate while pure test addition does not.
- **`datasetBuilder.test.ts`** — a v1 reward file is excluded; a v2 file without a snapshot is
  excluded; a v2 file with a snapshot exports real messages; a low-reward trajectory survives to
  DPO; the three gate conditions compute correctly.

**Gate:** `bunx vitest run` — `8 failed | 2266 passed | 35 skipped` is the baseline and the failure
count must not grow. The 8 are pre-existing and must not be "fixed" as part of this work.

**Live verification (mandatory before claiming done):** run one real task through a **scratch repo**
on a spare `LOCALCODE_WS_PORT`, launched with `cwd` = the scratch repo — an approve-all agent
launched from `localcode` will happily edit its own engine. Confirm on disk: a `messages.json` with
real content, a `reward.json` with `labelerVersion: 2`, at least one `unknown` component, and a
reward that is **not** exactly 1.0.

## Wire check (blocking, final task)

Grep each new symbol and prove a live non-test caller:
- `parseTestSummary` — called from `benignToolResult`, `sampler`, and the telemetry site.
- `endTask` / `finalizeTrajectory` — called from `conversationLoop`, not only tests.
- `finalizeTask` — a live caller exists for the first time (this is the headline fix).
- `backfillRewards`, `ranTests` — **zero** remaining references, proving the dead path is gone.
- No reward file written by v2 code contains a hardcoded `1` for an unmeasured component.

## Sequencing — eval harness before training

**An eval harness must come before any training run, and I hold this independently of the request
for a second opinion.**

The argument is falsifiability. After this spec lands, the pipeline can emit a labeled corpus with
real variance. Suppose 300 examples arrive and an adapter is trained. What changes? Without a
held-out benchmark the only available evidence is vibes on the next mission — and CynCo's mission
outcomes are dominated by *engine* behavior, which is precisely what has been changing weekly. The
tool-floor fix alone converted a 115-iteration thrash into a clean one-commit run. Against that
variance, a LoRA on 300 examples is unmeasurable: any post-training improvement is confounded with
whatever engine fix landed the same week, and any regression is deniable.

There is a sharper version. The failure this spec repairs was *silent* — a reward function returning
1.0 for everything looked exactly like a reward function working perfectly, for 147 examples and
five months. A training pipeline without an eval harness has the same shape: it always produces an
adapter, the adapter always loads, and nothing ever says "this is worse." I would rather not build a
second instance of the bug I am here to fix.

`C:/tmp/tdd_probe` is the seed. It already reproduces a real incident, drives a second engine on an
isolated port, and has a binary pass criterion. Generalizing it to N fixed scenarios with recorded
baselines gives a benchmark that can *fail*. Recommended order: this spec → collect labeled
trajectories from normal Gilded work → eval harness → baseline the current model → train → compare.

Where I differ from the framing: the harness does not need to be large. Ten to fifteen scenarios
with deterministic pass/fail beats a hundred fuzzy ones, and the highest-value scenarios are
regressions already survived — the S4_DET missed-callers case, the destructive-Write gutting, the
false-success outcome report. Those are known-hard, already-diagnosed, and each has an unambiguous
correct answer.

## Operational sequencing

Land on branch `training-reward-grounding`, merge to local `main`. Nothing has ever been pushed to a
remote; do not push. Do not run `--stage backfill`, `--stage sft`, or `--stage full` at any point —
backfill would add 155 more `1.0` labels and train on noise.
