# Aider-Polyglot Benchmark for CynCo — Design Spec

**Date:** 2026-07-06
**Status:** Approved by user (Approach 2: hybrid host-agent / Docker-tests)
**Branch:** `polyglot-benchmark` off `main`
**Goal:** A publishable, leaderboard-comparable Aider-polyglot number (all 225 exercises,
6 languages) for CynCo + Qwen3.6-27B as-shipped, with methodology that survives hostile
review on r/LocalLLaMA.

---

## Background

The Aider polyglot benchmark is 225 Exercism exercises (C++ 26, Go 39, Java 47,
JavaScript 49, Python 34, Rust 30) scored pass@2: try 1 from instructions; if hidden
tests fail, the test output is fed back into the same conversation for one retry.
Aider publishes a leaderboard; comparability requires matching this protocol.

A previous adapter (`benchmark/polyglot-adapter.ts`, gitignored, one stale
gemma4/Ollama run) exists but is disqualified:

1. Dead imports (`../src/src/localcode/...` — pre-refactor layout; cannot start).
2. **Validity hole:** agent runs inside `benchmark/polyglot-exercises/` where
   `.meta/` contains the reference solutions. CynCo has Read/Grep tools; it could
   simply find the answers.
3. **Tamper hole:** test files sit in the same dir the agent edits.
4. Retry semantics diverge from aider (resets files between tries, fresh loop with
   no memory, nested double-retry → up to 4 model calls).
5. Results written only at run end — a crash at exercise 220/225 loses everything.
6. Ollama-era config; risks llama-server churn per exercise.

The old adapter is retired (deleted) by this work; the new harness lives in tracked
code under `benchmark/true/polyglot/`.

## Non-Goals

- SWE-bench (separate effort, revisit after polyglot numbers exist).
- Prompt/params tuning for the benchmark. CynCo runs **as-shipped** (default
  temperature, governance active, default system prompt). The claim being tested is
  "CynCo out of the box," not a benchmark special.
- Leaderboard submission tooling; we publish our own numbers + raw JSONL + repro steps.

---

## Architecture (Approach 2 — hybrid)

**Agent edits on the host; tests execute in a Linux container.** This keeps the
in-process engine harness (same pattern as `benchmark/true/harness/driver.ts`) while
solving four missing Windows toolchains (Go, Rust, Java, C++) at once and matching
aider's Linux test environment.

```
host (Windows)                                 container (long-lived, Linux)
──────────────────────────────                 ──────────────────────────────
run.ts orchestrator                            polyglot-bench image:
  └─ per exercise:                               python+pytest, node+npm,
     1. stage workdir under SCRATCH/             go, rust, JDK+gradle,
        (stubs + build files, NO .meta,          cmake+g++
        NO test files)                         mounts (set once at start):
     2. ConversationLoop (in-process,            SCRATCH/  → /bench
        cwd=workdir, approveAll,                 caches    → /root/.gradle,
        one shared provider) — try 1                         /root/.cargo, ...
     3. inject pristine test files             docker exec: run language test
     4. docker exec test command  ─────────►     command in /bench/<ex>/
     5. delete test files from workdir
     6. fail → feed test output into the
        SAME loop (try 2), re-inject tests,
        re-run
     7. append result line to JSONL
```

### Components (all new, in `benchmark/true/polyglot/`)

| File | Responsibility |
|---|---|
| `Dockerfile` | Reproducible test-toolchain image (`polyglot-bench`). Ubuntu base; pinned toolchain versions documented in the README. |
| `container.ts` | Container lifecycle: build-if-missing, start long-lived container with SCRATCH + cache volumes mounted, `docker exec` a test command with timeout, teardown. One container for the whole run (no per-exercise startup cost). |
| `exercise.ts` | Discovery from `benchmark/polyglot-exercises/` via `.meta/config.json`; workdir staging (copy exercise dir **excluding `.meta/` and `config.files.test`**); test-file inject (always overwrite) / remove; prompt assembly from `.docs/instructions*.md` using aider's wording. |
| `runLoop.ts` | Engine driving: one provider bootstrapped **once** for the whole run (llama-server started once, never churned); per exercise a fresh `ConversationLoop` (cwd=workdir, `setApproveAll(true)`, events discarded); try 2 is a second `handleUserMessage` into the **same loop** so the model keeps its context, mirroring aider. Per-try hard timeout via `loop.abort()`. |
| `run.ts` | CLI orchestrator: `--lang`, `--exercise`, `--resume`, `--smoke` (1 exercise/language), `--budget <min>` (default 60); sequential execution; incremental JSONL append after every exercise; progress summary at the end of every chunk, full leaderboard comparison once all 225 are recorded. |
| `README.md` | Full reproduction instructions (for publication credibility). |

### Scoring & metrics

Per exercise JSONL record: `language, exercise, passed, passedTry (1|2|null),
durationMs, tryDurationsMs[], testDurationMs, error?, envFailure?`.

- **Headline: pass@2** (aider-comparable). Also reported: pass@1, per-language
  breakdown, timeout counts.
- **Env-failure taxonomy:** test-command failures that are provably environmental
  (docker exec nonzero before any test ran, missing toolchain, infra timeout) are
  flagged `envFailure: true`, still counted as failures in the headline number
  (aider parity — their env failures count too), but listed separately so they can
  be re-run with `--resume` after an infra fix. No silent exclusions.

### Anti-cheat / validity guarantees

1. **Reference solutions unreachable:** `.meta/` never copied into the workdir. The
   agent's cwd is an isolated temp dir; the exercises repo is outside it.
2. **Tests unreadable during tries:** test files exist in the workdir only between
   inject and remove, while the agent is not running. Inject always overwrites, so
   an agent-created file with a test's name is clobbered by the pristine copy.
3. **As-shipped config:** no benchmark-specific prompts or parameters. The only
   harness-level instruction is aider's own exercise prompt wording.
4. **Raw data published:** JSONL + run log + harness code + Dockerfile all tracked
   in git.

### Durability & chunked execution (~30–50h total, run in ≤1h chunks)

The full run is **never one long process**. It is a sequence of user-triggered
chunks, each bounded by `--budget <min>` (default 60):

- **Budget scheduler:** before starting each exercise, the orchestrator checks
  `elapsed + worstCase(exercise)` against the budget, where worstCase is the
  conservative per-exercise ceiling (2 tries × 8 min model + 2 × 5 min tests ≈ 26
  min). If it doesn't fit, the chunk stops cleanly — a chunk can end early but
  never overruns its budget. Expected per-exercise mean is well under 10 min, so a
  60-min chunk typically completes 6–15 exercises; the full 225 take roughly 20–40
  chunks.
- **Chunk end report:** exercises done this chunk, cumulative progress (n/225),
  running pass@2, projected chunks remaining. Re-running the same command with
  `--resume` starts the next chunk.
- All state between chunks lives in the JSONL: appended after each exercise;
  `--resume` skips exercises already recorded. Nothing is lost if a chunk crashes.
- One llama-server per chunk (bootstrapped once at chunk start; per-exercise loops
  share the provider; `ensureRunning` kills any stale server first, per policy).
  The Docker container is likewise started at chunk start and torn down at chunk
  end — cache volumes persist on disk, so warm Gradle/cargo caches carry across
  chunks.
- Per-try model timeout: 8 min (abort + count as failed try). Test-command timeout:
  5 min (Gradle first-run; warm caches via mounted volumes make subsequent runs fast).
- Run log tee'd to `benchmark/true/results/polyglot-<ts>.log` (one per chunk).

### Error handling

- Engine call throws → recorded as failed try (`error` populated), run continues.
- Docker exec timeout/nonzero-before-tests → `envFailure: true`, continue.
- Container dies mid-run → orchestrator fails fast with a clear message; `--resume`
  continues after restart.
- Ctrl-C / crash mid-chunk → JSONL is already durable; `--resume` next chunk.

### Testing (no model, no GPU)

- Unit tests (`benchmark/true/polyglot/__tests__/`): exercise discovery counts
  (225 total; per-language counts match aider's published split), workdir staging
  excludes `.meta` + test files, inject/remove round-trip, overwrite-clobber of
  agent-created test-name collisions, resume filtering, JSONL append format,
  prompt assembly, budget scheduler (stops before an exercise that can't fit;
  never overruns the budget).
- `--smoke` mode: 6 exercises (1/language) against the real model + container —
  the pre-flight gate before the full run.
- Docker `container.ts` gets an integration test gated like other live tests
  (skipped unless docker present).

### Execution plan (after implementation)

1. Build image, run unit tests.
2. `--smoke` (6 exercises, ~1h) — fix env issues until all 6 produce *valid*
   results (pass or fail is fine; envFailure is not).
3. Full run as user-triggered chunks: each chunk is one command
   (`... --resume --budget 60`), runs ≤1h, ends with a progress report and stops.
   The user launches chunks at their convenience; roughly 20–40 chunks total.
   Interruptions are harmless (`--resume`).
4. Once all 225 are recorded: score, write summary, publish results + update the
   Reddit post draft with real numbers (whatever they are — nulls included).

### Open risk, called out honestly

C++/Java exercises are the most likely env-failure sources even in-container
(CMake/Gradle quirks). The smoke gate exists to burn these down before the long run;
if a language proves systematically broken in the container, we fix the image — we
do not quietly drop the language.
