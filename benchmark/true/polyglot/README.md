# Aider-Polyglot Benchmark Harness for CynCo

Runs the [aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
(225 Exercism exercises: C++ 26, Go 39, Java 47, JavaScript 49, Python 34, Rust 30)
against CynCo **as-shipped** on local hardware, with aider's pass@2 protocol.

## What this measures

- **Headline: pass@2.** Try 1 gets aider's exercise prompt (`.docs/` texts + aider's
  instruction wording). If the hidden tests fail, the test output is fed into the
  **same conversation** with aider's retry wording for one more try. Also reported:
  pass@1, per-language breakdown, timeout counts.
- **Env-failure taxonomy:** test-command failures that are provably environmental
  (exec timeout, docker exit 125/126/127, missing-toolchain markers) are flagged
  `envFailure: true`. They **still count as failures in the headline number**
  (aider parity) but are listed separately so they can be re-run after an infra
  fix. No silent exclusions.

## Anti-cheat guarantees

1. **Reference solutions unreachable:** `.meta/` (contains `example` solutions) is
   never copied into the agent's workdir; the workdir is an isolated temp dir.
2. **Tests unreadable during tries:** test files exist in the workdir only between
   inject and remove, while the agent is not running. Injection always overwrites,
   so an agent-created file with a test's name is clobbered by the pristine copy.
   At verdict time all non-solution scaffolding (build files, runners, configs) is
   restored from pristine, so a patched `gradlew` or fake `npm test` can't lie.
3. **As-shipped config:** no benchmark-specific prompts or parameters. The only
   harness-supplied instruction text is aider's own exercise prompt wording.
   Governance (S5) stays active.
4. **Raw data in git:** results JSONL, run logs, harness code, and Dockerfile are
   all tracked. The harness refuses to run if the exercises repo is not pristine
   (`assertPristine`).

## Requirements

- **Docker Desktop** (tests run in a Linux container; the agent runs on the host)
- **Bun** (drives the CynCo engine in-process)
- **Exercises checkout** at `benchmark/polyglot-exercises`:

  ```bash
  git clone https://github.com/Aider-AI/polyglot-benchmark.git benchmark/polyglot-exercises
  git -C benchmark/polyglot-exercises checkout 7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
  ```

- A configured local model (`LOCALCODE_MODEL` or a CynCo profile). The harness
  refuses to run without one — results must be attributable.

## How to run

The `polyglot-bench` image builds automatically on first run (several minutes).

```bash
# 1. Pre-flight gate: 1 exercise per language. Iterate until all 6 produce
#    valid results (pass/fail fine; envFailure is not).
bun benchmark/true/polyglot/run.ts --smoke

# 2. Full run, in ≤60-minute chunks. Repeat until 225/225 recorded.
bun benchmark/true/polyglot/run.ts --resume --budget 60
```

Each chunk stops cleanly before an exercise that couldn't fit the budget
(conservative worst case: 26 min/exercise), prints a progress report, and exits.
Interruptions are harmless — every exercise is appended to the JSONL the moment
it finishes, and `--resume` skips already-recorded ones.

Other flags: `--lang go`, `--exercise bowling`, `--out path.jsonl`.

## Results

- JSONL: `benchmark/true/results/polyglot-<model>.jsonl` (one line per exercise)
- Log: `benchmark/true/results/polyglot-<timestamp>.log` (one per chunk)

Record schema (`ExerciseRecord`):

| Field | Meaning |
|---|---|
| `language` | cpp / go / java / javascript / python / rust |
| `exercise` | exercise name |
| `passed` | hidden tests green within 2 tries (headline) |
| `passedTry` | `1`, `2`, or `null` |
| `durationMs` | whole-exercise wall time |
| `tryDurationsMs` | per-try model wall time |
| `testDurationMs` | total docker test time |
| `error` | model-call error or `try timeout` (optional) |
| `envFailure` | `true` if failure is provably environmental (optional) |

## Container toolchain versions

`polyglot-bench` image (Ubuntu 24.04), as built:

```
Python 3.12.3 / pytest 7.4.4
node v22.23.1
go 1.22.2 linux/amd64
rustc 1.83.0 (pinned via rustup)
openjdk 21.0.11
cmake 3.28.3
g++ 13.3.0 (Ubuntu 24.04)
```

Gradle/cargo/go/npm caches persist in named docker volumes across chunks.

## Protocol parity notes

- Try 2 continues the **same** `ConversationLoop` (aider keeps the conversation).
- Skipped tests are enabled the way aider does it: JS `xtest/xit/xdescribe` →
  `test/it/describe`, Java `@Disabled` lines stripped, Rust
  `cargo test -- --include-ignored`, C++ `-DEXERCISM_RUN_ALL_TESTS=1`.
- Java runs `bash gradlew test` (exec bit is lost copying from a Windows host).
- Per-try model timeout 8 min (counts as a failed try); test timeout 5 min.
