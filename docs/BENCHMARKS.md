# CynCo Benchmarks

> How CynCo's performance is measured, what the current numbers actually say, and
> how to reproduce them. This document is deliberately **falsifiable**: every
> claim here can be re-run from the committed harness and case files. Where the
> data is unflattering, it is reported as-is.

---

## 1. Philosophy: Measure, Don't Assert

CynCo's central thesis is that a cybernetic governance layer (the VSM, Systems
1–5) makes a local model behave more like a frontier coding agent. That is a
**testable claim**, not a marketing one. The whole governance layer can be
switched off at runtime with a single environment variable
(`_ABLATION_VSM_DISABLED=1`), so its contribution can be isolated by running the
*same task, same model, same seed-of-conditions* twice — once **governed**, once
**ungoverned** — and comparing.

If governance helps, governed runs should win. If it doesn't, the numbers will
say so. This document reports both.

---

## 2. The Ablation Harness

There are two harnesses in the repo:

### 2.1 Built-in runner (`engine/vsm/ablationRunner.ts`)

Compares governed vs ungoverned over a list of free-text tasks. Invoked via:

```bash
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts --run-ablation <cases.json>
```

**Case file format** (`AblationTestCase[]`):

```json
[
  { "name": "Fix import error",
    "task": "Fix the import error in src/main.ts",
    "expectedFiles": ["src/main.ts"],
    "maxTurns": 15 }
]
```

For each case the runner executes the task twice. It deletes
`_ABLATION_VSM_DISABLED` for the governed run and sets it to `'1'` for the
ungoverned run (always cleared in a `finally`), constructing a fresh
`ConversationLoop` each time with `approveAll: true`, `noScouts: true`, a silent
emitter, and a 5-minute timeout.

**Metrics** (`metricsFromMessages`), computed directly from the message log:

| Metric | Definition |
|---|---|
| `turns` | Count of assistant messages |
| `toolSuccess` | `(tool_use blocks − errored tool_result blocks) / tool_use blocks` (= 1 if no tools) |
| `filesChanged` | Unique file paths touched by Edit/Write |
| `outcome` | `success` unless the run timed out |

**Winner** (`pickWinner`) is deterministic, in priority order:
1. successful outcome beats failure, then
2. higher `toolSuccess`, then
3. fewer `turns`, else **tie**.

`summarize` aggregates win rates and average turns/success across all cases, and
`formatReport` prints an ASCII table.

> **Honest caveats in this harness:** `expectedFiles` and `maxTurns` are carried
> on the type but **not used** in scoring. And `toolSuccess` returns `1` when a
> run makes no tool calls — a do-nothing run scores a vacuous "100%". Treat
> single-metric wins with suspicion; prefer the criteria-scored harness below for
> real verdicts.

### 2.2 Criteria-scored harness (`benchmark/ablation.ts` + friends)

The richer harness in `benchmark/` runs structured tasks with **verification
scripts** and per-criterion scoring (file existence, command success, git-commit
checks, tests passing). Task suites that ship in the repo:

- `benchmark/simple-tasks/tasks.json` — **50** Python tasks (hello-world →
  advanced) with `verify` commands and `expected_output`.
- `benchmark/swebench-lite-50.json` — **50** SWE-bench-lite tasks.
- `benchmark/tasks/` — expert/multi-file SWE-style tasks (TDD cycle, state
  machine, debug-from-symptoms, new subsystem, analyze unknown codebase).

Results are written as JSON to `benchmark-results/ablation/` and
`benchmark-results/ablation-full/`.

---

## 3. Current Results: None That Can Be Trusted

**There is no credible benchmark of the current governance layer.** This is stated
bluntly on purpose.

Old result files exist under `benchmark-results/`, but they must **not** be cited
as evidence for the system as it stands today, for three independent reasons:

1. **They predate the governance wiring.** The most-cited file
   (`benchmark-results/ablation/ablation-v2-1776717161981.json`) was produced on
   **2026-04-20**. The governance features that define the current "governed"
   condition — `reflexionFeedback`, `interventionTracker`, `toolGating`,
   `testDrivenGov`, `advisorRouter` — were only wired into the live loop on
   **2026-06-16** (commits `d4fbefb`…`d3b2440`). The April run therefore measured a
   *half-built* governance layer. Its "governed" arm was missing most of the
   governance.

2. **The numbers are suspiciously identical, consistent with measuring nothing.**
   That run reported governed vs ungoverned at 40.0% vs 40.0% pass, 4.6 vs 4.7
   tools, 256 vs 257 tokens. When the two arms of an ablation are this close, the
   most likely explanation is not "governance is exactly neutral" but "the toggle
   had almost nothing to toggle" — which matches reason (1).

3. **The data is not version-controlled.** `benchmark-results/` is gitignored.
   These are unreviewed local scratch files, not committed, reproducible evidence.

So this section deliberately reports **no headline numbers**. Any prior draft that
presented the April figures as "current results" was wrong, and they have been
removed.

---

## 4. What We Can Honestly Say Today

- **Governance is wired and the ablation switch works.** A governed and an
  ungoverned run of the *same* task take measurably different paths (different turn
  counts and tool sequences). The plumbing is real and the flag genuinely toggles
  it. This was verified directly, not benchmarked.
- **Whether governance improves task outcomes is currently UNKNOWN.** It has not
  been measured since the wiring landed. Claiming a win — or even claiming
  "parity" — would be unsupported.
- The honest one-liner is: *the governance layer is built and toggleable; its
  effect on task success is unmeasured and must be established by a fresh run (§5)
  before any performance claim is made.*

This is reported plainly because the project's whole premise is falsifiability. A
governance layer that claimed wins it can't reproduce would be worthless.

---

## 5. Reproducing the Benchmarks

```bash
# Built-in runner over your own cases:
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts --run-ablation my-cases.json

# Criteria-scored Python suite (50 tasks), governed vs ungoverned:
bun benchmark/ablation.ts            # see benchmark/cli.ts for options/flags

# Results land in benchmark-results/ablation*/ as timestamped JSON.
```

Each run records the model, per-task metrics, and the governed/ungoverned split,
so any result in §3 can be regenerated and checked against the committed JSON.

---

## 6. Prediction Tracker (H1–H8): Status

`engine/vsm/predictionTracker.ts` defines **eight falsifiable hypotheses** about
whether specific interventions change behavior, each with a null baseline and a
Wilson-score confidence interval:

| ID | Hypothesis | Null baseline |
|---|---|---|
| H1 | After a stuck-escape (tools restricted), an Edit/Write follows within 3 turns | 0.40 |
| H2 | After a nudge, the next tool type changes | 0.50 |
| H3 | After a contract is created, all assertions pass within 20 iters | 0.50 |
| H4 | After 3 reads of one file, an Edit follows within 2 turns | 0.30 |
| H5 | After >100 thinking tokens, the next tool is an action tool | 0.30 |
| H6 | After temperature is lowered, a different tool than the last 3 is used | 0.33 |
| H7 | After an S4 reflection, behavior changes within 3 turns | 0.50 |
| H8 | Edits/min beats the session rolling average | 0.50 |

The triggers and evaluators are **wired and run every turn**, but they are
currently **correlational smoke tests, not causal measurements**: evaluation
conditions are loose (e.g. H1 counts any action tool, not verified stuck-state
resolution), and thresholds like "stuck ≥ 5" are heuristic, not empirically
tuned. **Do not cite H1–H8 hit rates as evidence of causal efficacy yet.** They
are scaffolding for a future, properly instrumented evaluation (explicit logging
of when/why temperature is lowered, real edits/min tracking, verified stuck
resolution).

---

## 7. Roadmap to a Credible Benchmark

To turn parity-with-caveats into a defensible claim, in priority order:

1. **Add a mid-difficulty multi-file suite** — the regime where governance should
   actually help (long-horizon, easy to get stuck).
2. **Use `expectedFiles` for validation** in the built-in runner instead of
   ignoring it; stop treating no-tool runs as 100% success.
3. **Instrument interventions causally** (log temperature changes, verify stuck
   resolution) so H1–H8 become real measurements.
4. **Report confidence intervals and run counts** for every headline number, not
   point estimates from a single run.

Until then, the honest one-line summary is: *governance is wired and toggleable,
but its effect on task success is unmeasured — no performance claim is warranted
yet.*
