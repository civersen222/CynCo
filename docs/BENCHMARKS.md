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

- **Real-repo, long-horizon tasks.** Each task clones the CivKings game repo and
  checks out a pinned green ref (`03b4032`). The Layer B suite is **flavor-2**: no
  `setup.patch` — the target subsystem is genuinely *unwired* on the green ref (e.g.
  `stability_system` exists but the turn loop never drives it). The agent must build
  the missing wiring across multiple files. Each task ships a verified
  `reference_solution.patch` (scores 1.0) and a green floor < 1.0.
- **Continuous scoring.** Each hidden pytest (`scorePytest`, headless via
  `SDL_VIDEODRIVER=dummy`) contains **4–6 independent `test_*` functions**; the task
  score is the **passing fraction** (`parsePytestScore`), so partial progress
  (2 of 4 sites wired = 0.5) is visible. The agent never sees the hidden test. An
  agent whose code *hangs* the test scores 0 and the run continues (the scorer
  treats a pytest `ETIMEDOUT` as an agent failure, not an infra abort); a genuine
  spawn failure — e.g. `python` missing — still surfaces loudly.
- **Calibration gate.** `run.ts --calibrate` runs an unaided ungoverned-only pilot
  and keeps only tasks scoring in the discriminating **0.2–0.8** band; saturators
  (0/1 with no headroom) carry no governance signal and are archived under
  `benchmark/true/tasks/civkings-b-saturated/` with a recorded drop reason.
- **Production backend.** `run.ts` calls the same `bootstrapProvider` as
  `engine/main.ts`, so the benchmark drives the exact llama-cpp + MTP path users
  run — not a stub.
- **Honest statistics.** The headline is the governed−ungoverned **score-lift** with
  a **paired-bootstrap** CI (`pairedBootstrapLift`, 10 000 iterations) over the
  per-task continuous scores; per-arm means use `meanBootstrap`. Binary full-pass
  rates (Wilson) are kept as a secondary. Verdict is `GOVERNANCE HELPS/HURTS` only
  if the score-lift CI excludes 0, else `INCONCLUSIVE`.
- **Clean ablation.** The governed/ungoverned split is the single env var
  `_ABLATION_VSM_DISABLED`; governance *interventions* are gated by it while
  *measurement* telemetry runs identically in both arms (so the comparison is fair).

Five calibrated tasks ship under `benchmark/true/tasks/civkings-b/`
(building-yields-audit, city-yield-consumers, faction-effects-applied,
gold-deficit-consequences, stability-loop); results are committed (not gitignored)
under `benchmark/true/results/`.

---

## 3. Current Results: CivKings Self-Ablation

### 3.1 Layer B — continuous-score, long-horizon suite (current headline)

Run **2026-06-18** on `qwen3.6-27b-q6k` (production llama-cpp + MTP backend), the
Layer B suite measures the **fully-wired** governance layer on long-horizon
"wire the half-built subsystem" tasks with **continuous** per-assertion scoring.
Five tasks (calibrated into the discriminating 0.2–0.8 band, see §2.3), each run
**governed vs ungoverned, N=5 per arm** (50 runs total).

Committed evidence: `benchmark/true/results/true-ablation-1781824508747.json`.

| Condition | Mean score | 95% CI (bootstrap) |
|---|---|---|
| Governed | **67.0%** | [55.3, 78.0] |
| Ungoverned | **75.3%** | [61.0, 88.0] |
| **Score-lift (governed − ungoverned)** | **−8.3%** | **[−28.0, +14.0]** (paired bootstrap) |

Secondary (binary full-pass): governed **28%**, ungoverned **56%**.

**Verdict: INCONCLUSIVE — the score-lift CI includes 0.** The point estimate leans
*against* governance, but at N=5 the interval is too wide to conclude either way.

Per-task lift (governed − ungoverned mean score):

| Task | Governed | Ungoverned | Lift |
|---|---|---|---|
| city-yield-consumers | 80% | 47% | **+33** |
| building-yields-audit | 80% | 85% | −5 |
| faction-effects-applied | 55% | 70% | −15 |
| gold-deficit-consequences | 80% | 95% | −15 |
| stability-loop | 40% | 80% | **−40** |

Two honest caveats on the negative lean:

1. **Governance helped most on the hardest task.** `city-yield-consumers` (the task
   ungoverned struggled with, .47) is the one governance rescued (+33); the deficits
   are all on easier tasks. This *hints* governance trades efficiency for resilience
   — a sharp, testable hypothesis, not a conclusion at N=5.
2. **A timeout confound.** Governed runs used more turns (43 vs 38) and timed out
   more often (9/25 vs 5/25); on `gold-deficit` the governed arm timed out 4 of 5
   times, so part of its deficit is "ran out of clock on unfinished work," not worse
   reasoning. This is simultaneously a *real efficiency cost* of governance and a
   confound for the quality reading.

### 3.2 Layer A — why the first null was a measurement artifact

The first attempt (**2026-06-17**, twelve single-edit tasks, **binary** pass/fail,
N=3, 72 runs) produced a degenerate result:

| Condition | Pass rate | 95% CI (Wilson) | Raw |
|---|---|---|---|
| Governed | 83.3% | [68.1, 92.1] | 30/36 |
| Ungoverned | 83.3% | [68.1, 92.1] | 30/36 |
| **Lift** | **0.0%** | **[0.0, 0.0]** | — |

At the time this was read as a *credible null*. **Layer B falsifies that reading.**
The same governance layer, measured on a discriminating suite, moves the signal off
zero (−8.3%, §3.1) — so Layer A's flat 0.0 [0.0, 0.0] was the **instrument failing
to register**, not governance being neutral. Two root causes: tasks were too short
(single-line re-adds; the agent never spirals) and binary scoring discarded all
partial-progress gradient. Layer A is kept as committed evidence of the artifact;
the Layer B figures (§3.1) supersede it.

Committed evidence (Layer A): `benchmark/true/results/true-ablation-1781728598176.json`.

> **The old April data remains discredited.** Files under `benchmark-results/`
> (e.g. `ablation/ablation-v2-1776717161981.json`, 2026-04-20) predate the
> governance wiring (`reflexionFeedback`, `interventionTracker`, `toolGating`,
> `testDrivenGov`, `advisorRouter` landed 2026-06-16), reported suspiciously
> identical arms (40.0% vs 40.0%), and are gitignored scratch — **not** committed,
> reproducible evidence. Do not cite them. The §3 numbers above supersede them.

---

## 4. What We Can Honestly Say Today

- **Governance is wired and the ablation switch works.** Every governed run fired
  axiom checks and contract enforcement; every ungoverned run fired none — verified
  in the logs.
- **On a discriminating long-horizon suite, the measured score-lift is −8.3%
  [−28, +14] — INCONCLUSIVE, leaning negative.** The current governance layer does
  *not* demonstrably improve task score on these tasks, and on the easier ones it
  appears to add turns/timeouts without a correctness benefit (§3.1).
- **The one positive signal is on the hardest task** (`city-yield`, +33),
  consistent with the thesis that governance helps where the agent would otherwise
  spiral — but it is a single task at N=5, not a result.
- **The instrument now works.** Layer A could not move (0.0 [0.0, 0.0]); Layer B
  produces a real, non-saturated distribution with gradient. A benchmark that can
  register a governance difference is the deliverable — and it currently registers
  one that does **not** favor governance.
- **Next falsifiable step:** raise N and the per-task timeout (to clear the timeout
  confound), and widen the kept-task set, to test the "helps on hard, costs on easy"
  hypothesis with a tighter CI.

This is reported plainly because the project's whole premise is falsifiability. The
honest status is *"no demonstrated benefit, a hint of cost, one hard-task win"* —
not a positive performance claim. A committed, discriminating null (or negative
lean) is worth more than a rigged win.

---

## 5. Reproducing the Benchmarks

```bash
# TRUE benchmark — Layer B headline (§3.1): 5 calibrated tasks, N=5 per arm:
LOCALCODE_MODEL=qwen3.6-27b-q6k bun benchmark/true/run.ts --reps 5
# → writes a timestamped, committable JSON to benchmark/true/results/

# Re-calibrate the kept-task set (unaided ungoverned pilot, keep 0.2–0.8 band):
LOCALCODE_MODEL=qwen3.6-27b-q6k bun benchmark/true/run.ts --calibrate

# Built-in runner over your own cases:
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts --run-ablation my-cases.json

# Criteria-scored Python suite (50 tasks), governed vs ungoverned:
bun benchmark/ablation.ts            # see benchmark/cli.ts for options/flags
```

Each run records the model, per-task continuous scores, and the governed/ungoverned
split, so any result in §3 can be regenerated and checked against the committed JSON.
The §3.1 headline figures came from
`benchmark/true/results/true-ablation-1781824508747.json`; the Layer A artifact
(§3.2) from `benchmark/true/results/true-ablation-1781728598176.json`.

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
