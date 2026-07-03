# Getting the Most Out of CynCo

> Practical guidance for extracting maximum value from CynCo on local hardware.
> Assumes you've read the [USER_GUIDE.md](./USER_GUIDE.md). Internals are in
> [MANUAL.md](./MANUAL.md); performance evidence is in [BENCHMARKS.md](./BENCHMARKS.md).

---

## 1. Choose the Right Model

The single biggest lever. CynCo auto-detects capabilities, but you want a model
with **native tool use** and ideally **native thinking** and a large context.

- **Recommended flagship:** `qwen3.6` — native tools, native thinking, large
  context. This is the default reference model.
- **Strong alternative:** `gemma4:31b`.
- Models with only **simulated** tool use (the engine parses tool calls from
  text) work but are less reliable on multi-step tool sequences.

A model's detected tier (`basic`/`standard`/`advanced`) follows its tool-use
capability and gates which tools and workflows are offered. Check what you're
getting with `/tools`.

---

## 2. Match the Backend to Your Hardware

Two backends, picked with `LOCALCODE_PROVIDER`:

### Ollama (simplest)
```bash
ollama pull qwen3.6
ollama pull nomic-embed-text   # required for code indexing
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts
```
Good default. Manages model loading for you.

### llama.cpp (`llama-server`) for maximum throughput
Use a GGUF you control (e.g. a Q6_K quant) and a profile to set runtime params —
GPU layers, batch size, flash attention, and **speculative decoding** (MTP /
draft models) which can substantially raise tokens/sec on capable GPUs.

```yaml
# ~/.cynco/profiles/fast.yaml
name: fast
model: qwen3.6
model_file: ~/.cynco/models/qwen3.6-Q6_K.gguf
runtime:
  gpu_layers: 80
  batch_size: 512
  flash_attn: true
  spec_type: draft-mtp
  spec_draft_n: 3
  reasoning_budget: 256
```
```bash
LOCALCODE_PROVIDER=llama-cpp LOCALCODE_PROFILE=fast bun engine/main.ts
```

**GPU sizing:** a 24–32 GB GPU comfortably runs a ~27B model at Q6_K with room
for context. Put as many layers on the GPU as VRAM allows (`gpu_layers`). On a
multi-GPU rig, keep the model on the largest card.

---

## 3. Tune Context Management

Context is finite; CynCo compacts automatically, but you control the thresholds.

- `LOCALCODE_CONTEXT_LENGTH` — override the detected window if you know your model
  supports more.
- Context thresholds (Settings → Context, or profile `context_management`):
  - `warning_threshold` (default 0.4) — when to start summarizing.
  - `hard_limit` (default 0.8) — when to force compaction.
- Use `/context` to see utilization and `/compact` to compress on demand before a
  big task.

**Tip:** start large tasks with a fresh, compacted context. The agent works best
when recent, relevant material dominates the window.

---

## 4. Use the Right Mode for the Job

- **Workspace** for hands-on development where you want to see and approve each
  step.
- **Workflows** (`/tdd`, `/debug`, `/review`, `/plan`, `/brainstorm`, `/critique`,
  `/research`) when the task has a natural structure. Workflows constrain the tool
  set per phase, which keeps the model focused and reduces thrashing. `/tdd`
  enforces test-first; `/debug` enforces root-cause-before-fix.
- **Vibe loop** (`/project`) for greenfield or non-engineer work — answer its
  questions and let it build.
- **Sub-agents** (`/agent`) to parallelize independent research or exploration
  without polluting your main context. Use `scout` for read-only codebase
  exploration, `researcher` for multi-source web research.

---

## 5. Governance & Feature Flags

CynCo's governance is on by default and mostly invisible. Several behaviors are
**opt-in flags** so you can turn them on deliberately (and so their effect stays
measurable — see BENCHMARKS):

| Flag | Effect | When to use |
|---|---|---|
| `LOCALCODE_TDD_GOV=1` | Soft "run your tests" nudge after several edits | Disciplined TDD outside a formal workflow |
| `LOCALCODE_ADVISORS=1` | Fires VSM advisors (S2–S5) into the reflection step | Hard tasks where extra oversight helps |
| `LOCALCODE_REPO_MAP=1` | Injects a PageRank repo map into context | Large unfamiliar codebases |
| `LOCALCODE_HYBRID_SEARCH` | `0` disables BM25+vector fusion | Leave on (default) for best search |
| `LOCALCODE_REFLEXION` | `0` disables error-correction notes | Leave on (default) |
| `_ABLATION_VSM_DISABLED=1` | Turns the entire VSM layer into a no-op | A/B testing only — not for normal use |

Turn `ADVISORS` and `TDD_GOV` on when you want maximum guardrails on a tricky
task; leave them off for speed on simple ones. Each advisor is an extra model
inference, so they add latency.

`/governance report` shows which interventions actually worked this session
(success rate per intervention type) — useful for deciding whether the extra
oversight is paying off for your workload.

---

## 6. Profiles: Set It Once

Encode your preferred setup as a profile so you don't re-type flags. Profiles
support `extends` for a base + variants (e.g. `fast`, `careful`, `research`), and
can scope tools with `allowed`/`denied`. Project-local `.cynco/profiles/` override
global `~/.cynco/profiles/`, so a repo can ship its own recommended config.

Example "careful" profile that lowers temperature and denies web access for an
offline, deterministic-leaning session:

```yaml
name: careful
extends: fast
temperature: 0.3
tools:
  denied: [WebSearch, WebFetch]
```

---

## 7. Lean on Memory & Indexing

- **Let it index.** The first task in a project triggers semantic indexing; after
  that, `CodeIndex` gives the model fast, relevant context. Re-run with `/analyze`
  after large changes.
- **Cross-session memory** means CynCo recalls prior goals and learnings per
  project. Long-running work benefits — it picks up where it left off. Don't fight
  it by constantly clearing; let handoffs accumulate.
- **Hybrid search** (default on) fuses keyword and semantic retrieval, which is
  more robust than either alone — keep it enabled.

---

## 8. Workflow for a Big Task (recommended recipe)

1. `/compact` (or start fresh) for a clean context.
2. `/analyze` if the codebase changed since last session.
3. `/plan` to get an implementation plan first — review it.
4. For risky/large work, set `LOCALCODE_ADVISORS=1` and (if TDD)
   `LOCALCODE_TDD_GOV=1` before launching the engine.
5. Execute in Workspace, approving tools as you go (or `/approve-all` once you
   trust the plan).
6. `/governance report` afterward to see what governance did.
7. `/commit` to land the work.

---

## 9. Help the Project: Contribute Benchmark Data

CynCo's value proposition is falsifiable (see BENCHMARKS). The most useful thing a
power user can do is **run ablations on real tasks** and contribute the results:

```bash
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts --run-ablation your-cases.json
```

Mid-difficulty, multi-file tasks — where staying un-stuck matters — are exactly
the data the project most needs to prove (or disprove) governance's value.
