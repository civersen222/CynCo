# True Benchmark Design (Current, Fully-Wired Governance)

> **Status:** design — approved decisions captured; pending user review before plan.
> **Date:** 2026-06-16
> **Supersedes:** the discredited April ablation data retracted in `docs/BENCHMARKS.md` §3.

## Why this exists

The old benchmark numbers are not citable: they predate the June-16 governance
wiring, the two ablation arms were near-identical (consistent with measuring a
half-built system), and the results were gitignored scratch files. This benchmark
replaces them with a **committed, reproducible** measurement of the *current*
governance layer, reported with **confidence intervals, not point estimates**.

It answers two questions, layered:

- **Layer A — Self-ablation lift (controlled, primary).** Does VSM governance make
  the *same* local model measurably better than the ungoverned baseline? This is
  the only thing we fully control (same model, same task, governance ON vs
  `_ABLATION_VSM_DISABLED=1`). It is the falsifiability claim.
- **Layer B — Absolute scorecard (parity hook, secondary).** What is CynCo's
  absolute pass rate on a standard suite, so it can be placed *in context* against
  published frontier numbers? Reported as context, never as a head-to-head win.

## Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Central claim | Both, layered (A: self-ablation lift; B: absolute scorecard) |
| Task basis | Both: CivKings (Layer A) + SWE-bench-lite-50 (Layer B) |
| Statistical rigor | **N=3** per task per condition; Wilson + paired bootstrap CIs |
| Frontier reference | **Published** SWE-bench-lite leaderboard numbers — context only |
| CivKings task source | **Mix**: mine git history where it has clean tests, hand-author the rest |
| Harness | **Fully standalone**, zero reuse of existing `benchmark/` code |
| Model | `qwen3.6` (Ollama) |

## System under test — invocation contract

The harness drives the **real** engine loop (this is the system under test; it is
not "benchmark code" and so does not violate the zero-reuse decision):

```ts
const s5   = new S5Orchestrator(new RuleBasedS5())
const loop = new ConversationLoop({
  config: { ...config, approveAll: true, noScouts: true },
  provider,
  emit: () => {},
  cwd: <isolated temp clone of the task repo>,   // governance acts on this dir
  s5,
})
const timer = setTimeout(() => loop.abort(), TIMEOUT_MS)
try { await loop.handleUserMessage(taskPrompt) } finally { clearTimeout(timer) }
const messages = loop.getMessages()
```

- **Governance toggle:** `process.env._ABLATION_VSM_DISABLED` is read by
  `CyberneticsGovernance` at loop construction. The harness sets it to `'1'` for
  the ungoverned arm and deletes it for the governed arm (always cleared in a
  `finally`).
- **Config/provider** are built the same way `engine/main.ts` builds them
  (`loadConfig()` + provider construction). qwen3.6 via Ollama.

## Layer A — CivKings self-ablation (headline)

**Target codebase:** the real CivKings repo (`C:\Users\civer\civkings`), pinned to
a known-green commit. 67 Python modules, real pytest suite — the long-horizon,
multi-file band where governance should matter.

### Task model

Each task is a directory under `benchmark/true/tasks/civkings/<task-id>/` with:

```
task.json        # id, prompt, start_ref (commit or patch to apply), timeout
hidden_test.py   # the scoring test — NEVER placed where the agent can read it
notes.md         # provenance: mined-from-history <sha> | authored, difficulty
```

- **Start state:** the harness clones CivKings into a fresh temp dir, checks out
  `start_ref`, and (for authored tasks) applies a `setup.patch` that removes/breaks
  the target so there is real work to do.
- **Prompt:** a natural-language task ("implement/fix X"), as a user would phrase
  it. The agent never sees `hidden_test.py`.
- **Scoring:** after the run, the harness copies `hidden_test.py` into the temp
  dir and runs `pytest hidden_test.py -q` under `SDL_VIDEODRIVER=dummy`. **Pass =
  exit 0.** Nothing else counts (no tool-success heuristics, no turn-count wins).

### Anti-gaming guarantees

1. Hidden test injected only at scoring time → the agent cannot target it.
2. Fresh temp clone per run → no cross-run contamination (governed vs ungoverned,
   and across the 3 repeats).
3. Pass/fail is a process exit code, not a model judgment.

### Task sourcing (mix)

- **Mined from history:** for CivKings commits that already ship a matching test,
  check out the **parent** as `start_ref`; the task is to reproduce the fix; score
  with the test from the child commit. (SWE-bench methodology, applied to our own
  repo.)
- **Authored:** where history lacks clean tests, hand-write a self-contained
  feature/bug task + `setup.patch` + `hidden_test.py`, deliberately placed in the
  mid-difficulty multi-file band.
- **Target count:** ~12 tasks total.

### Rigor & verdict

- 12 tasks × {governed, ungoverned} × **N=3** = 72 runs.
- Per-condition pass rate with **Wilson** 95% CI.
- **Lift** = governed − ungoverned, with a **paired bootstrap** CI over tasks.
- **Verdict rule:** governance "helps" only if the lift CI excludes 0. If it
  doesn't, that is reported plainly — parity or worse is a publishable result here.

## Layer B — SWE-bench-lite absolute scorecard (secondary)

**Tasks:** the committed `benchmark/swebench-lite-50.json` (canonical SWE-bench
format: `instance_id`, `base_commit`, gold `patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`).

**Run:** CynCo in normal **governed** mode, N=1 × 50 → absolute pass rate with a
binomial (Wilson) CI.

**Scoring (official SWE-bench method):** in an isolated checkout of the upstream
repo at `base_commit`, apply the agent's diff, then the gold **test** patch, then
run `FAIL_TO_PASS` (must now pass) and `PASS_TO_PASS` (must stay passing). All green
= task resolved.

**Comparison:** report CynCo's pass rate next to **published** SWE-bench-lite
leaderboard scores, **explicitly labeled apples-to-oranges** (different harness,
different scaffold). Context, not a head-to-head claim.

### Known cost / risk (called out honestly)

Layer B requires provisioning each upstream repo's Python environment (astropy,
django, sympy, …) at a pinned `base_commit`. This is the classic SWE-bench infra
cost and the main feasibility risk. **Mitigation:** Layer A (CivKings) is the
headline and ships first; Layer B is built second with explicit per-repo
environment-setup tasks, and may begin on the subset of repos that provision
cleanly before scaling to all 50.

## Committed artifacts (fixes the gitignored-scratch problem)

All of the following are version-controlled (the old results were not):

```
benchmark/true/
  run.ts                 # standalone entrypoint (no benchmark/ reuse)
  harness/               # clone/isolate, toggle ablation, drive loop, score, stats
  tasks/civkings/<id>/   # task.json, hidden_test.py, setup.patch, notes.md
  tasks/swebench/        # loader + per-repo env setup
  results/               # committed timestamped JSON (model, per-task, CIs, raw runs)
```

Plus a regenerated `docs/BENCHMARKS.md` §3/§4 with the real numbers + CIs,
replacing today's "none that can be trusted."

## Out of scope

- Live frontier API runs (the parity layer uses published numbers only).
- Tuning governance to win — the benchmark measures, it does not optimize.
- H1–H8 causal instrumentation (tracked separately in BENCHMARKS §6).

## Open implementation questions (for the plan, not blockers)

- Exact CivKings pin commit (known-green) and the 12 task picks.
- Whether to provision SWE-bench repos via the official Docker harness or native
  venvs on this Windows box.
- Timeout per task (April harness used 5 min; long-horizon tasks may need more).
