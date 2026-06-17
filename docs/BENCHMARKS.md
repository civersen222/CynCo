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

### 2.3 TRUE benchmark — CivKings self-ablation (`benchmark/true/`)

The harness that produced the §3 results. It is **fully standalone** (zero reuse
of the older `benchmark/` code) and built for falsifiability:

- **Real-repo tasks.** Each task clones the CivKings game repo, checks out a pinned
  green ref (`03b4032`), and applies a `setup.patch` that breaks one feature. The
  agent must restore it. Scoring runs a **hidden pytest** (`scorePytest`, headless
  via `SDL_VIDEODRIVER=dummy`) that the agent never sees: clean ref **passes**,
  patched ref **fails** — every gate is independently verified.
- **Production backend.** `run.ts` calls the same `bootstrapProvider` as
  `engine/main.ts`, so the benchmark drives the exact llama-cpp + MTP path users
  run — not a stub.
- **Honest statistics.** Per-task and overall pass rates use Wilson score
  intervals; the governed−ungoverned **lift** CI uses a paired bootstrap (10 000
  iterations). Verdict is `GOVERNANCE HELPS/HURTS` only if the lift CI excludes 0,
  else `INCONCLUSIVE`.
- **Clean ablation.** The governed/ungoverned split is the single env var
  `_ABLATION_VSM_DISABLED`; governance *interventions* are gated by it while
  *measurement* telemetry runs identically in both arms (so the comparison is fair).

Twelve tasks ship under `benchmark/true/tasks/civkings/`; results are committed
(not gitignored) under `benchmark/true/results/`.

---

## 3. Current Results: CivKings Self-Ablation (Layer A)

The first credible measurement of the **fully-wired** governance layer was run on
**2026-06-17** against the standalone harness in `benchmark/true/` (§2.3). Twelve
multi-file CivKings tasks, each run **governed vs ungoverned, N=3 per arm** (72
runs total), on `qwen3.6-27b-q6k` driving the production llama-cpp + MTP backend.

Committed evidence: `benchmark/true/results/true-ablation-1781728598176.json`.

| Condition | Pass rate | 95% CI (Wilson) | Raw |
|---|---|---|---|
| Governed | **83.3%** | [68.1, 92.1] | 30/36 |
| Ungoverned | **83.3%** | [68.1, 92.1] | 30/36 |
| **Lift (governed − ungoverned)** | **0.0%** | **[0.0, 0.0]** (paired bootstrap) | — |

**Verdict: INCONCLUSIVE — the confidence interval includes 0.** On this suite,
governance changed task success by exactly nothing.

This is a *credible* null, not a measurement artifact, for three reasons:

1. **The suite has real signal — it is not a pass-everything ceiling.** Ten of
   twelve tasks pass 3/3 in both arms; two (`faction-dominant-effects`,
   `market-price-clamp`) fail 0/3 in both arms. Ten of those twelve failures were
   the agent finishing with a *wrong answer* (not a timeout), so the model
   genuinely cannot solve them. Governance failed to help on exactly the tasks
   where help was possible.
2. **Per-task results are perfectly symmetric.** No task flips between conditions —
   governance rescued no failure and broke no success.
3. **A latency cost with no correctness benefit.** All five "passed-but-timed-out"
   runs were *governed*: governance adds verification turns that occasionally push
   a run past the 15-minute wall, without changing the outcome.

> **The old April data remains discredited.** Files under `benchmark-results/`
> (e.g. `ablation/ablation-v2-1776717161981.json`, 2026-04-20) predate the
> governance wiring (`reflexionFeedback`, `interventionTracker`, `toolGating`,
> `testDrivenGov`, `advisorRouter` landed 2026-06-16), reported suspiciously
> identical arms (40.0% vs 40.0%), and are gitignored scratch — **not** committed,
> reproducible evidence. Do not cite them. The §3 numbers above supersede them.

---

## 4. What We Can Honestly Say Today

- **Governance is wired and the ablation switch works.** Every governed run fired
  axiom checks and contract enforcement; every ungoverned run fired none. The flag
  genuinely toggles the layer, verified in the run logs.
- **On short-horizon multi-file bug fixes, governance is outcome-neutral.**
  Measured lift is 0.0% [0.0, 0.0] (§3). It neither helped nor hurt task success,
  and it carried a small latency cost (governed runs run longer).
- **This does not falsify the central thesis — it bounds where it applies.** These
  CivKings tasks resolve in ~15 agent turns inside a single subsystem. That is
  likely too short a horizon for variety/management-capacity governance to
  differentiate: the agent rarely gets the chance to spiral, which is precisely the
  failure mode governance is theorized to catch. The honest reading is *"no
  measurable effect on this regime,"* not *"no effect anywhere."*
- The next falsifiable step is a **long-horizon, easy-to-get-stuck suite** (§7) —
  the regime where governance should help if it helps at all. Until that is run, no
  positive performance claim is warranted.

This is reported plainly because the project's whole premise is falsifiability. A
governance layer that claimed wins it can't reproduce would be worthless; a clean,
committed null on a discriminating suite is worth more than a rigged win.

---

## 5. Reproducing the Benchmarks

```bash
# TRUE benchmark — the §3 CivKings self-ablation (N=3, all 12 tasks):
LOCALCODE_MODEL=qwen3.6-27b-q6k bun benchmark/true/run.ts --reps 3
# → writes a timestamped, committable JSON to benchmark/true/results/

# Built-in runner over your own cases:
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts --run-ablation my-cases.json

# Criteria-scored Python suite (50 tasks), governed vs ungoverned:
bun benchmark/ablation.ts            # see benchmark/cli.ts for options/flags
```

Each run records the model, per-task metrics, and the governed/ungoverned split,
so any result in §3 can be regenerated and checked against the committed JSON. The
§3 figures came from `benchmark/true/results/true-ablation-1781728598176.json`.

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
