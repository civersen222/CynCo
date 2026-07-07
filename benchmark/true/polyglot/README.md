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
   (`assertPristine`), and re-checks pristineness before **every** verdict run —
   an agent that wrote into the exercises checkout kills the run instead of
   poisoning it.

**Accepted residual risk** (shared with aider's own harness): the agent's tools
run unsandboxed on the host, so it could in principle leave a background process
alive past its try. The verdict window is still tamper-checked (pristine restore
of all scaffolding + pristine-source assert), but a sufficiently deliberate
background process racing the verdict is not defended against. CynCo's agent has
no benchmark awareness, so this is a theoretical, not practical, hole.

## Requirements

- **Docker Desktop** (tests run in a Linux container; the agent runs on the host)
- **Bun** (drives the CynCo engine in-process)
- **Exercises checkout** at `benchmark/polyglot-exercises`:

  ```bash
  git clone --config core.autocrlf=false https://github.com/Aider-AI/polyglot-benchmark.git benchmark/polyglot-exercises
  git -C benchmark/polyglot-exercises checkout 7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
  ```

  (`core.autocrlf=false` matters on Windows: CRLF in `gradlew` / shell scripts
  breaks them under the container's Linux bash.)

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
(conservative worst case: 46 min/exercise — 2 tries × 8 min model + up to 10 min
in-flight tool tail after an abort + 2 × 5 min tests), prints a progress report,
and exits. Typical exercises take a few minutes, so a 60-min chunk usually runs
several; the worst case just guarantees no overrun. Interruptions are harmless —
every exercise is appended to the JSONL the moment it finishes, and `--resume`
skips already-recorded ones. Budgets below 46 min are refused (nothing would run).

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

The report's `timeouts` count covers **try** (model) timeouts; test-command
timeouts appear under `env failures`.

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
- Prompt wording (try 1 addendum and try 2 retry) is aider's exact text.
- **Deviation, disclosed:** aider feeds the full test output into try 2; this
  harness truncates long output to the first 20 + last 80 lines (local-model
  context is finite; failure summaries live at the end of pytest/gradle/cargo
  output). Short output is passed through unchanged.
- Skipped tests are enabled at inject time: JS `xtest/xit/xdescribe` →
  `test/it/describe`, Java `@Disabled` lines stripped, Rust
  `cargo test -- --include-ignored`, C++ `-DEXERCISM_RUN_ALL_TESTS=1`.
  (Aider's JS script converts only `xtest`; converting `xit`/`xdescribe` too is
  strictly **harder** — more tests enabled — never easier.)
- Java runs `bash gradlew test` (exec bit is lost copying from a Windows host).
- JS runs `npm install` inside the container per verdict (aider pre-installs
  node_modules; the npm cache volume keeps this fast after the first run).
- Per-try model timeout 8 min: the try is aborted and recorded in `error`, but
  its partial edits still get a verdict run — same as an interrupted aider
  attempt. Test-command timeout 5 min (→ `envFailure`).
- S5 governance is active in its as-shipped default (rule-based S5, same as a
  fresh CynCo install without a fine-tuned decision model).
