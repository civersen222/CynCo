# CynCo Technical Manual

> Engineering reference for the CynCo (LocalCode) engine and runtime. This manual
> describes the system as it exists in the current codebase. For end-user
> instructions see [USER_GUIDE.md](./USER_GUIDE.md); for performance data see
> [BENCHMARKS.md](./BENCHMARKS.md); for tuning see [MAXIMIZING.md](./MAXIMIZING.md).

---

## 1. What CynCo Is

**CynCo** (package name *LocalCode*) is a terminal-based AI coding assistant that
runs entirely against **local LLMs** — no data leaves the machine. It offers the
same surface as a cloud coding agent (file editing, shell execution, code search,
git, sub-agents) while sending every token to a model you host yourself, via
[Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp).

The project is named for **Project Cybersyn** (Chile, 1971–73) and is built on
Stafford Beer's **Viable System Model (VSM)**. The VSM is not branding: a live
cybernetic governance layer (Systems 1–5) observes and steers every turn of the
agent loop. See §5.

**Design goals:**
- **Local-first.** All inference is local. No API keys.
- **Falsifiable governance.** The VSM layer can be switched off at runtime
  (`_ABLATION_VSM_DISABLED=1`) so its effect is measurable, not assumed.
- **Self-improving.** Decisions are logged as training data so the S5 policy
  model can be fine-tuned from real governance traces.

---

## 2. Two-Process Architecture

CynCo is two cooperating processes connected by a WebSocket.

```
┌─────────────────────────────────┐     WebSocket       ┌──────────────────────┐
│  TypeScript Engine              │◄───────────────────►│  Python TUI          │
│  (Bun runtime)                  │   port 9160 (def.)  │  (Textual framework) │
│                                 │                     │                      │
│  engine/main.ts (entry)         │  ──── Protocol ──── │  tui/app.py          │
│  engine/bridge/server.ts        │  stream.token       │  tui/bridge.py       │
│  engine/bridge/                 │  tool.start/complete│  tui/screens/        │
│    conversationLoop.ts          │  approval.request   │  tui/widgets/        │
│  engine/engine/callModel.ts     │  governance.alert   │                      │
│  engine/ollama/client.ts        │  user.message       │                      │
│       ↓ HTTP                    │  /slash commands    │                      │
│  Ollama / llama-server          │                     │                      │
└─────────────────────────────────┘                     └──────────────────────┘
```

- **Engine** (`engine/`, TypeScript on Bun): owns the agent loop, model calls,
  tool execution, governance, memory, and indexing. Can run headless.
- **TUI** (`tui/`, Python + Textual): renders chat, sidebar, approvals, and
  guided/vibe screens. It is a thin client — all intelligence lives in the engine.
- **Bridge**: a Bun WebSocket server (`engine/bridge/server.ts`) on
  `127.0.0.1:9160` by default. Binds to `LOCALCODE_BRIDGE_HOST`; falls back to
  9161/9162 if the port is taken. A browser **dashboard** is served on
  `port + 1` (default 9161).

The protocol is defined twice in parallel and must stay in sync:
`engine/bridge/protocol.ts` (TypeScript) and `tui/localcode_tui/protocol.py`
(Python). Events flow engine→TUI (`stream.token`, `tool.start`, `tool.complete`,
`approval.request`, `governance.alert`, `session.ready`, …) and commands flow
TUI→engine (`user.message`, `abort`, `approval.response`, `/slash` commands,
`config.*`, `vibe.*`, …).

---

## 3. Engine Startup (`engine/main.ts`)

On launch the engine:

1. **Ensures ripgrep is on PATH** (Windows) for the Grep tool.
2. **Loads config** via `loadConfig()` — environment variables plus an optional
   YAML profile (`LOCALCODE_PROFILE`). See [config](#configuration).
3. **Initializes a provider** (§4): llama-cpp (spawns/manages a `llama-server`
   process) or Ollama / OpenAI-compatible HTTP endpoint. Context length is
   auto-detected or forced with `LOCALCODE_CONTEXT_LENGTH`.
4. **Dispatches one-shot modes** if a CLI flag is present (and then exits):
   - `--run-task <file.json>` — execute a single mission headless.
   - `--export-training <out.jsonl>` — dump S5 decision history as JSONL.
   - `--run-ablation <cases.json>` — A/B governed vs ungoverned (see BENCHMARKS).
5. **Starts the WebSocket bridge** (default port 9160) and the **dashboard** HTTP
   server (port+1).
6. **Discovers language servers** (TypeScript, Python, Rust, Go, C) for context.
7. **Builds the S5 orchestrator** (rule-based by default; LoRA model if
   `LOCALCODE_S5_MODEL` is set) and the decision journal.
8. **Runs a health check**, emits `session.ready`, and **auto-indexes** the
   project for semantic search if the index is stale.

Signal handlers (SIGTERM/SIGINT) record the session outcome, back-fill training
data, and write the audit log before exit.

### CLI flags & key environment variables

| Flag / Var | Purpose |
|---|---|
| `--run-task <file>` | One-shot mission from a JSON task file |
| `--export-training <path>` | Export `DecisionLogger` history → JSONL |
| `--run-ablation <path>` | Governed vs ungoverned A/B over a case file |
| `LOCALCODE_MODEL` | **Required.** Model name (e.g. `qwen3.6`, `gemma4:31b`) |
| `LOCALCODE_PROVIDER` | `ollama` (default), `llama-cpp`, `lmstudio`, `openai-compat`, `vllm` |
| `LOCALCODE_BASE_URL` | Backend URL (default `http://localhost:11434`) |
| `LOCALCODE_WS_PORT` | Bridge port (default 9160) |
| `LOCALCODE_BRIDGE_HOST` | Bridge bind host (default `127.0.0.1`) |
| `LOCALCODE_CONTEXT_LENGTH` | Override context window (tokens) |
| `LOCALCODE_PROFILE` | YAML profile name |
| `LOCALCODE_S5_MODEL` | Fine-tuned LoRA S5 model (else rule-based) |
| `_ABLATION_VSM_DISABLED` | `1` makes the whole VSM layer a no-op (for ablation) |
| `LOCALCODE_REFLEXION` | `0` disables error-correction feedback notes |
| `LOCALCODE_HYBRID_SEARCH` | `0` disables BM25+vector fusion (vector only) |
| `LOCALCODE_REPO_MAP` | `1` injects a PageRank repo map into context |

---

## 4. Model Backend

The provider abstraction lives in `engine/provider.ts` (interface) and
`engine/providers/factory.ts` (selection). A provider exposes `listModels`,
`probeCapabilities`, `complete`, `stream`, and `healthCheck`.

| Provider | Implementation | Endpoint |
|---|---|---|
| `ollama` | `OllamaProvider` (`engine/ollama/client.ts`) | `POST /api/chat` (native, streaming) |
| `llama-cpp` | `LlamaCppProvider` | `POST /completion` on a managed `llama-server` |
| `lmstudio` / `openai-compat` / `vllm` | `OpenAICompatProvider` | `POST /v1/chat/completions` |

**Capability probing** (`engine/ollama/probe.ts`) maps a model family to a
capability table (tool use: `native`/`simulated`/`none`; thinking; vision;
context window). The **tier** derives from tool-use capability:

- `native` tool use → **advanced**
- `simulated` → **standard**
- `none` → **basic**

Models without native tool support use **simulated** tool calling: the engine
parses tool calls out of the model's text rather than a structured API field.
The recommended flagship is `qwen3.6` (native tools, native thinking, large
context).

---

## 5. The VSM Governance Layer

The governance layer is the architectural heart of CynCo. It implements Beer's
Viable System Model as a live controller wrapped around the agent loop, in
`engine/vsm/cyberneticsGovernance.ts` (the `CyberneticsGovernance` class). It is
**not advisory** — it can restrict tools, inject signals, lower temperature, and
trip a kill switch.

### 5.1 The five systems

| System | Role | Where it lives |
|---|---|---|
| **S1** Operations | The tool executions themselves | `executeBatch` in the loop; `ToolExecutor` |
| **S2** Coordination | Anti-oscillation, scheduling, GPU queue | `S2Coordinator`, `advisorRouter` (S2) |
| **S3** Operations mgmt | Resource allocation: which tools, when to compact | `ToolGating`, `ContextCompressor`, `TestDrivenGovernor` |
| **S3\*** Audit | Quality spot-checks, catch confident errors | `advisorRouter` (S3*), `reflexionFeedback` |
| **S4** Intelligence | Environment scanning, task classification | `S4Reflector`, `advisorRouter` (S4) |
| **S5** Policy | Identity, expertise, the final decision | `S5Orchestrator`, `IdentityGuard` |

### 5.2 Sub-components

These modules were each individually wired into the live loop (see the Phase 2
PR) and are exercised every turn unless a flag gates them:

- **`interventionTracker.ts`** — records each intervention (nudge, temperature
  drop, contract, tool restriction) and whether it *succeeded* (defined as the
  turn ending un-stuck). Closes a within-session PID loop and feeds
  `/governance report`.
- **`toolGating.ts`** — `ToolGating` tracks per-tool repetition; after a
  consecutive-use threshold it restricts the offending tool (never restricting
  `Bash`/`Glob`/`Grep`/`Ls`). The pure helper `applyToolGate(tools, restricted)`
  is the final deterministic gate applied to the per-iteration tool list, and it
  refuses to empty the list.
- **`testDrivenGov.ts`** — `TestDrivenGovernor` counts consecutive edits; after
  the threshold the pure helper `shouldNudgeTests(gov, {flagOn, workflowActive})`
  emits a **soft** "run your tests" nudge. Opt-in via `LOCALCODE_TDD_GOV=1`,
  suppressed while a formal workflow owns the test phase.
- **`reflexionFeedback.ts`** — `withReflexion(tool, isError, output, truncated)`
  appends an error-specific self-correction note to a failed tool result
  (e.g. "Edit string not found — re-Read the file first"). Always on unless
  `LOCALCODE_REFLEXION=0`.
- **`advisorRouter.ts`** — fires the relevant VSM advisors (S2–S5) as separate
  model inferences and injects their guidance into the S4 reflection context.
  Opt-in via `LOCALCODE_ADVISORS=1`. `runAdvisors(state, askModel)` is the pure
  orchestrator.
- **`predictionTracker.ts`** — tracks eight falsifiable hypotheses (H1–H8) about
  whether interventions actually change behavior, with Wilson-score confidence
  intervals. See BENCHMARKS §6 for its current (limited) reliability.

### 5.3 The ablation switch

The constructor reads the kill switch once:

```ts
this._ablated = process.env._ABLATION_VSM_DISABLED === '1'
```

When ablated, every governance method early-returns a no-op default — no stuck
detection, no interventions, no signals. The `AblationRunner` flips this flag
between the two halves of each A/B pair, which is what makes the governance
layer's contribution **measurable** rather than asserted.

---

## 6. The Conversation Loop (`engine/bridge/conversationLoop.ts`)

`ConversationLoop` is the core agentic loop. The high-level flow of a user turn:

1. **Ingest** the user message; append to history and the JSONL session journal.
2. **Context preparation**: compaction check (compress if over threshold),
   optional read-only **scout** dispatch (S2, capped), **CodeIndex** semantic
   search injection, optional **repo map** injection, `.cynco-state.md` and prior
   **learnings** injection, first-message project audit, custom `system.md`
   instructions, governance stuck-signal injection, active contract context, and
   any workflow system-prompt override.
3. **Call the model** (streaming). Collect streamed tokens and tool calls.
4. **Pre-execution governance**:
   - **S1** batch classification (parallel reads, sequential writes).
   - **S3** `applyToolGate` restricts repeated/risky tools.
   - **S3** `shouldNudgeTests` may inject a TDD nudge.
   - **S4** `runAdvisors` may inject advisor guidance.
   - **S5** `S5Orchestrator.makeDecision` may restrict tools, change context
     action, or set priority.
5. **Execute tools**: for each call — request approval (unless auto-approve),
   execute, truncate output per `TOOL_OUTPUT_LIMITS`, apply `withReflexion` on
   error, record success/latency, run the post-execution governance hook, and
   emit `tool.start`/`tool.progress`/`tool.complete`.
6. **Feed results** back into context and **loop** until the model stops or an
   abort is signalled.

Key methods: `handleUserMessage`, `callModel`, `executeBatch`, `executeOneTool`,
`getGovernance`, `getMessages`, `buildHandoff`, `resume`, `setCwd`,
`startWorkflow`. The S5 decision orchestrator lives in `engine/s5/orchestrator.ts`
(`RuleBasedS5` default, `ModelS5` when a LoRA is configured), with rule weights
persisted to `~/.cynco/training/rule-weights.json` and down-weighted when the
user rejects S5 advice.

---

## 7. Tools (`engine/tools/`)

`ALL_TOOLS` (`engine/tools/registry.ts`) contains **26 tools**. Each has an
approval tier: `auto` (no prompt — read-only/info) or `approve` (user must
confirm — anything that mutates files or runs commands).

| Tool | Tier | What it does |
|---|---|---|
| Read | auto | Read file contents with line numbers |
| Glob | auto | Find files by glob pattern |
| Grep | auto | Regex content search (ripgrep) |
| Ls | auto | List a directory |
| ImageView | auto | View an image file |
| CodeIndex | auto | Semantic + keyword code search |
| Git | auto | Git status/log/diff/add/commit |
| WebFetch | auto | Fetch & convert a web page to text |
| WebSearch | auto | Multi-source web search (arXiv, GitHub, docs, …) |
| SaveLearning | auto | Persist a cross-session learning |
| IndexResearch | auto | Build a cited research index from web results |
| MflTool | auto | Multi-file linter / code-quality checks |
| AskUser | auto | Ask the human a question (blocks for an answer) |
| ContractStatus | auto | Check task-contract status |
| Write | approve | Create / overwrite a file |
| Edit | approve | In-place edit (semantic merge fallback) |
| MultiEdit | approve | Multiple edits across a file |
| ApplyPatch | approve | Apply a unified diff |
| ReplaceFunction | approve | Replace a named function |
| Bash | approve | Run a shell command |
| NotebookEdit | approve | Edit a Jupyter notebook |
| SpawnAgent | approve | Launch a sub-agent |
| CollectAgent | approve | Collect a sub-agent's result |
| ContractCreate | approve | Create a task contract with assertions |
| ContractAssertPass | approve | Mark a contract assertion passed |
| ContractAssertFail | approve | Mark a contract assertion failed |

`ToolExecutor` (`engine/tools/executor.ts`) dispatches calls through the approval
broker, enforces output limits, and records outcomes for governance.
`ToolScorer` (`engine/tools/toolScorer.ts`) persists per-tool success rates to
`~/.cynco/tool-scores.json`.

---

## 8. Supporting Subsystems

- **Memory / continuity** (`engine/memory/`): `lifecycle.ts` loads prior handoffs
  and a project ledger at session start and writes a handoff (goal, files
  modified, viability status) at session end, under
  `~/.cynco/continuity/<project_hash>/`. Recent learnings are injected per turn.
- **Code index** (`engine/index/`): SQLite store of tree-sitter chunks +
  embeddings (via Ollama `/api/embed`). Query uses **Reciprocal Rank Fusion** of
  vector and BM25 results (`LOCALCODE_HYBRID_SEARCH`, default on). `RepoMapBuilder`
  computes an import-graph PageRank for the opt-in repo map.
- **Vibe loop** (`engine/vibe/`): `VibeLoopEngine` is a state machine
  (SETUP → QUESTIONS → BUILD → REPORT) that asks one clarifying question per turn,
  tracks confidence, then builds autonomously and reports in plain language. This
  is CynCo's guided mode for non-engineers.
- **Context compression** (`engine/context/`): `ContextCompressor` summarizes the
  oldest messages via a side-query when utilization crosses the warning threshold.
- **Agents** (`engine/agents/`): `SubAgent` isolated loops with personas;
  `S2Coordinator` polls GPU utilization and manages the agent queue; `cascade.ts`
  classifies task complexity to route between fast and powerful models.
- **Profiles** (`engine/profiles/`): YAML profile loading with inheritance from
  `~/.cynco/profiles/` (and project-local `.cynco/profiles/`, higher priority).
- **Workflows** (`engine/workflows/`): phase-based structured tasks
  (`/tdd`, `/debug`, `/review`, `/plan`, `/brainstorm`, `/critique`, `/research`)
  that constrain the tool set per phase.

---

## 9. Persistence & On-Disk Layout

| Path | Purpose |
|---|---|
| `~/.cynco/profiles/` | Global YAML profiles |
| `.cynco/profiles/` | Project-local profiles (override global) |
| `~/.cynco/continuity/<hash>/` | Session handoffs + project ledger |
| `~/.cynco/decisions/*.jsonl` | S5 decision journal (one file per day) |
| `~/.cynco/training/rule-weights.json` | S5 rule weights |
| `~/.cynco/tool-scores.json` | Per-tool success scores |
| `~/.cynco/governance.db` | VSM outcomes / per-turn metrics (SQLite) |
| `~/.cynco/models/`, `~/.cynco/bin/` | GGUF models / `llama-server` (llama-cpp) |

---

## 10. Configuration

All configuration is via `LOCALCODE_*` environment variables and/or a YAML
profile; **no API key is ever required**. See the table in §3 for the most
important variables, and [MAXIMIZING.md](./MAXIMIZING.md) for how to combine them
for best results. Import convention: engine imports use `.js` extensions (Bun),
and the engine runs under `bun`, not `node`. Tests run under **vitest**
(`npx vitest run`), not `bun test`.
