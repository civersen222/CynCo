# Closed-Loop Free Wins: Constrained Decoding, Best-of-N, Repo Map, Control Loop Wiring

**Stage B of the self-improvement roadmap.** Four independent subsystems that improve CynCo immediately with zero training, plus the trajectory data pipeline for future Stage C (SFT/DPO on Qwen3.6-27B).

Grounded in the Compass analysis (May 2026) which identified: no constrained decoding, no best-of-N, no tree-sitter, and an open training loop. This spec closes the "free wins" gap and wires the cybernetics layer to actively control inference.

---

## Scope

Four subsystems, loosely coupled with optional hooks between them:

1. **Constrained Decoding (GBNF)** — Grammar-enforced tool calls on llama.cpp, post-validation on both providers
2. **Best-of-N with Execution Selection** — Git worktree sandboxing, test-based patch selection
3. **Tree-sitter Repo Map + Hybrid Retrieval** — AST chunking, BM25 + vector fusion, configurable embedding model
4. **Control Loop Wiring** — Variety entropy drives temperature/tool-set, algedonic scalar feeds trajectory recorder

Each subsystem delivers value independently. They compound when all four are active.

---

## 1. Constrained Decoding

### Problem

Tool-call parsing relies on regex extraction (`/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g` in `engine/ollama/simulated.ts:70`) or native provider passthrough. When the model emits malformed JSON or wrong XML tags, tool calls are silently dropped. The current "JSON repair" (strip trailing commas) catches only one failure mode.

### Solution: Two Layers

**Layer 1 — GBNF Grammar (llama.cpp only)**

New file: `engine/decoding/grammarEmitter.ts`

- Reads the tool registry (`engine/tools/registry.ts`) at startup
- Walks each tool's `inputSchema` (JSON Schema) and emits a GBNF grammar
- Grammar structure:
  ```
  root ::= (tool_call ws)*
  tool_call ::= "<tool_call>" ws json_obj ws "</tool_call>"
  json_obj ::= "{" ws "\"name\"" ws ":" ws tool_name ws "," ws "\"arguments\"" ws ":" ws tool_args ws "}"
  tool_name ::= "\"Read\"" | "\"Write\"" | "\"Edit\"" | ... (from registry)
  tool_args ::= read_args | write_args | edit_args | ... (per tool)
  read_args ::= "{" ws "\"file_path\"" ws ":" ws json_string ... "}"
  ```
- Each tool's args rule is generated from its `inputSchema.properties` and `required` fields
- Grammar regenerated when tool set changes (workflow restriction, S5 tool restriction)
- Sent to llama-server via the `grammar` field in the request body
- Only applies to simulated tool-use mode (the `<tool_call>` XML format). For native tool-use models, the provider's own format handling is sufficient — post-validation (Layer 2) is the only layer.

Modify: `engine/llama/provider.ts` — add `grammar` parameter to `buildRequestBody()` when grammar is available and simulated mode is active.

**Layer 2 — Post-Validator (both providers)**

New file: `engine/decoding/postValidator.ts`

- After every tool-call extraction (native or simulated), validate:
  - Tool name exists in registry
  - Arguments conform to tool's `inputSchema` (required fields present, types match)
- On validation failure:
  - Inject corrective system message: "Tool call invalid: {specific error}. The schema for {tool_name} is: {schema}. Try again."
  - Re-prompt the model (same turn, not a new user message)
  - Max 2 correction attempts, then fall back to existing behavior
- Applies to both providers — grammar prevents most failures on llama.cpp, post-validation catches the rest

### Files

| Action | Path | What Changes |
|--------|------|--------------|
| Create | `engine/decoding/grammarEmitter.ts` | GBNF generation from tool schemas |
| Create | `engine/decoding/postValidator.ts` | Schema validation + corrective re-prompt |
| Modify | `engine/llama/provider.ts` | Add `grammar` to request body |
| Modify | `engine/ollama/client.ts` | Wire post-validation after response |
| Modify | `engine/engine/callModel.ts` | Wire grammar into request pipeline |
| Modify | `engine/ollama/simulated.ts` | Post-validation replaces JSON repair hack |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_GRAMMAR_ENABLED` | `true` | Enable GBNF constrained decoding (llama.cpp) |

---

## 2. Best-of-N with Execution Selection

### Problem

CynCo runs a single-pass conversation loop. If the model produces a bad solution, the only recourse is the stuck loop escape (which restricts tools but doesn't try alternative approaches). Sampling multiple candidates and selecting by test results is the highest-leverage no-training intervention per the literature (DOCE, arXiv:2408.13745).

### Solution: Git Worktree Sandboxing

**Test Detector** — new file: `engine/bestOfN/testDetector.ts`
- Scans project root for test infrastructure:
  - Python: `pytest.ini`, `setup.cfg [tool:pytest]`, `pyproject.toml [tool.pytest]`, `tests/` directory
  - JavaScript/TypeScript: `jest.config.*`, `vitest.config.*`, `package.json` with `"test"` script
  - Rust: `Cargo.toml` with `[dev-dependencies]`
  - Go: `*_test.go` files
- Returns: `{ available: boolean, command: string, framework: string }`
- Cached per project root, invalidated when config files change

**Worktree Manager** — new file: `engine/bestOfN/worktreeManager.ts`
- Creates N temporary git worktrees from HEAD: `git worktree add --detach <tmpdir>`
- Uses OS temp directory with random suffix
- Cleanup via `git worktree remove --force` — registered as process exit handler
- Windows-safe: handles long paths, backslash normalization

**Sampler** — new file: `engine/bestOfN/sampler.ts`

Flow:
1. Test detector checks for test infrastructure → if none, skip (normal single-pass)
2. Create N worktrees from HEAD
3. For each worktree (serial — one GPU, one inference at a time):
   a. Run a mini conversation loop in the worktree directory with temp=0.8
   b. Same user message, tool set, system prompt, grammar constraints
   c. Cap at 15 turns per candidate (prevent runaway)
   d. After completion, extract file diff vs HEAD
   e. Run test command in the worktree
   f. Score: `{ tests_passed_ratio, stuck_turns, total_turns }`
4. Select winner: highest test pass rate, tiebreak on fewest turns
5. Apply winning diff to main working tree via `git apply`
6. Report: which candidate won, test results, turns used
7. Clean up all worktrees

**Activation:**
- Disabled by default — opt in via env var, governance param, or `/bestofn` command
- Default N=2 (control loop can raise to N=4 when variety is low)
- Only activates when: tests detected AND task involves code changes (edit/write contract assertions)
- Each candidate run uses the same Ollama/llama-server instance (stateless HTTP)

**What this does NOT do:**
- No parallel GPU execution (one GPU, serial candidates)
- No container sandboxing (git worktrees only)
- No activation on every message (tests required, opt-in)

### Files

| Action | Path | What Changes |
|--------|------|--------------|
| Create | `engine/bestOfN/testDetector.ts` | Detect test infrastructure |
| Create | `engine/bestOfN/worktreeManager.ts` | Git worktree lifecycle |
| Create | `engine/bestOfN/sampler.ts` | N-candidate orchestration |
| Create | `engine/bestOfN/patchExtractor.ts` | Extract diff from worktree |
| Modify | `engine/bridge/conversationLoop.ts` | Activation hook before runModelLoop |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_BEST_OF_N` | `false` | Enable best-of-N sampling |
| `LOCALCODE_BEST_OF_N_COUNT` | `2` | Default N |
| `LOCALCODE_BEST_OF_N_TEMP` | `0.8` | Temperature for candidates |
| `LOCALCODE_BEST_OF_N_TURN_CAP` | `15` | Max turns per candidate |

---

## 3. Tree-sitter Repo Map + Hybrid Retrieval

### Problem

Current code indexing uses regex-based chunking (`engine/index/chunker.ts`) that splits on `def`/`class`/function keywords with brace-matching. This misses: method boundaries in complex classes, nested functions, decorator associations, accurate import resolution. Vector search via sqlite-vec is the only retrieval signal — no keyword/BM25 scoring.

### Solution: Three Layers

**Layer 1 — Tree-sitter Chunker** (replaces logic in `engine/index/chunker.ts`)

- Add npm dependencies: `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-javascript`, `tree-sitter-rust`, `tree-sitter-go`
- Parse each file → walk AST → extract:
  - Function declarations (name, signature, body range)
  - Class declarations (name, methods, inheritance)
  - Method definitions within classes
  - Import/export statements
  - Call sites (which function calls which)
- Each chunk carries AST metadata: `{ kind, name, signature, startLine, endLine, parentClass? }`
- Extracts relationships from AST: imports, call sites, inheritance
- Falls back to current regex chunker for unsupported languages (Lua, Shell, C#, etc.)

**Layer 2 — Repo Map** — new file: `engine/retrieval/repoMap.ts`

- Builds directed graph from AST relationships: `definition → reference` edges across files
- Runs personalized PageRank seeded by:
  - Files mentioned in current user message
  - Files recently edited in the conversation
  - Files in active contract scope
- Output: ranked list of relevant definitions — functions and classes most connected to what the user is working on
- Injected into system context alongside vector search results
- Graph rebuilt during indexing, PageRank runs per query (~ms for repos under 50K nodes)

**Layer 3 — Hybrid Search** — new file: `engine/retrieval/hybridSearch.ts`

- **BM25 index** (`engine/retrieval/bm25Index.ts`): tf-idf scoring over chunk content and names, stored in SQLite alongside existing tables
- **Vector search**: existing sqlite-vec path, unchanged
- **Fusion**: reciprocal-rank fusion — `score(doc) = sum(1/(k + rank_i))` across both rankers, k=60
- Returns top-K fused results, capped at 10 chunks or ~2500 tokens total

**Configurable embedding model:**
- `LOCALCODE_EMBED_MODEL` env var already exists (default: `nomic-embed-text`)
- On startup, compare stored embed model in index metadata vs config
- On mismatch: log warning, trigger re-index on next `/analyze` or stale check
- Embedding dimension read from API response (not hardcoded) — sqlite-vec virtual table created with detected dimension
- Supports both `nomic-embed-text` (768-dim) and `Qwen3-Embedding-0.6B` or any Ollama-compatible model

### Files

| Action | Path | What Changes |
|--------|------|--------------|
| Create | `engine/retrieval/repoMap.ts` | AST graph + PageRank |
| Create | `engine/retrieval/bm25Index.ts` | BM25 keyword scoring |
| Create | `engine/retrieval/hybridSearch.ts` | Reciprocal-rank fusion |
| Modify | `engine/index/chunker.ts` | Tree-sitter AST parsing, regex fallback |
| Modify | `engine/index/store.ts` | BM25 table, hybrid query, dynamic embed dimension |
| Modify | `engine/index/indexer.ts` | Wire tree-sitter chunker, build repo map graph, populate BM25 |
| Modify | `engine/index/embedClient.ts` | Dynamic dimension detection |
| Modify | `engine/tools/impl/codeIndex.ts` | Query hybrid search, include repo map results |
| Modify | `engine/bridge/conversationLoop.ts` | Repo map PageRank injection into system context |

### Dependencies

- `tree-sitter` + language grammars added to `package.json`
- No Python dependencies — tree-sitter has native Node/Bun bindings

---

## 4. Control Loop Wiring

### Problem

The cybernetics layer computes tool entropy (Shannon, base-2) and produces algedonic pain/pleasure signals — but neither drives inference parameters. Variety ratio is reported to the dashboard but doesn't control anything. The training loop is open: data is collected but never structured for future SFT/DPO.

### Solution: Two Parts

### Part A — Variety-Driven Control

Modify: `engine/vsm/cyberneticsGovernance.ts` — new method `getControlSignals()`

**Temperature control:**
- Every turn, read tool entropy H over last 10 tool calls (already computed as `toolEntropy`)
- H < `variety.lowEntropyThreshold` (default 0.5) → hammering one tool: raise temperature by +0.1, widen tool set to all available
- H > log2(|active_tools|) - `variety.highEntropyMargin` (default 0.2) → thrashing: lower temperature by -0.1, narrow to top-3 by recent success rate
- Clamp to [`variety.temperatureFloor` (0.3), `variety.temperatureCeiling` (1.0)]
- Changes are per-turn and transient — not persisted to config
- Emitted in `governance.status` event for dashboard visibility

**Best-of-N budget control** (hook into `engine/bestOfN/sampler.ts`):
- Variety balanced → N=2 (default)
- H < 0.5 or stuck turns >= 3 → N=4 (spend more compute to escape)
- Variety critical → skip best-of-N entirely (model too broken, return to user)

Modify: `engine/bridge/conversationLoop.ts` — read control signals before each model call, apply temperature and tool-set adjustments.

### Part B — Trajectory Recorder

New file: `engine/training/trajectoryRecorder.ts`

**Per-turn record** — written to `~/.cynco/trajectories/<taskId>.jsonl`, fsync'd:
```json
{
  "task_id": "string",
  "turn_idx": 0,
  "ts": "2026-05-28T...",
  "model": "qwen3.6:27b",
  "adapter_id": null,
  "tool_calls": [
    {"name": "Read", "input_hash": "abc123", "success": true, "latency_ms": 450}
  ],
  "state_features": {
    "files_touched": 3,
    "diff_size": 120,
    "tests_total": 15,
    "tests_failing_before": 2,
    "tools_used": ["Read", "Edit", "Bash"],
    "context_pct": 0.45
  },
  "reward_components": {
    "tool_success_rate": 1.0,
    "stuck_turns": 0,
    "variety_entropy": 1.58
  }
}
```

Messages snapshot omitted per-turn (too large) — recorded only at task end.

**Reward Labeler** — new file: `engine/training/rewardLabeler.ts`

At task end (contract fulfilled or user sends new message), finalize:
```json
{
  "task_id": "string",
  "turns": 8,
  "components": {
    "tests_pass": 0.93,
    "typecheck_pass": 1,
    "build_pass": 1,
    "diff_applied_cleanly": 1,
    "task_completed": 1,
    "stuck_turns": 0,
    "iter_fraction": 0.016,
    "user_satisfaction": 1,
    "tests_unmodified": 1
  },
  "reward": 0.88
}
```

Reward formula:
```
r = 1.0*tests_pass + 0.5*typecheck_pass + 0.3*build_pass + 0.2*diff_clean
  + 0.5*task_completed - 0.05*min(stuck_turns, 10) - 0.1*iter_fraction
  + 0.3*max(0, user_satisfaction)

if tests_unmodified == 0: r = -1.0   (anti-reward-hacking)
r = clip(r, -1.0, 1.0)
```

Test file hash-pinning: at task start, SHA256 hash all test files. At finalize, re-hash. If any changed, `tests_unmodified = 0` → reward = -1.0.

**Algedonic integration** (modify `engine/vsm/algedonicIntegration.ts`):
- Wire per-tool pain/pleasure scalar into trajectory record's `reward_components`
- At task end, emit finalized reward as an algedonic signal — closing the loop

### Files

| Action | Path | What Changes |
|--------|------|--------------|
| Create | `engine/training/trajectoryRecorder.ts` | Per-turn JSONL trajectory writer |
| Create | `engine/training/rewardLabeler.ts` | Task-end reward computation |
| Modify | `engine/vsm/cyberneticsGovernance.ts` | Export `getControlSignals()` |
| Modify | `engine/bridge/conversationLoop.ts` | Read control signals, adjust temp/tools, call recorder |
| Modify | `engine/vsm/algedonicIntegration.ts` | Emit scalar reward to recorder |
| Modify | `engine/tools/contract.ts` | Trigger reward finalization on fulfillment |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_TRAJECTORY_ENABLED` | `true` | Enable trajectory recording |
| `LOCALCODE_VARIETY_CONTROL` | `true` | Enable variety → temperature control |

### Governance Params (dashboard-tunable)

| Param | Default | System | Description |
|-------|---------|--------|-------------|
| `variety.temperatureFloor` | 0.3 | variety | Min temperature from variety control |
| `variety.temperatureCeiling` | 1.0 | variety | Max temperature from variety control |
| `variety.lowEntropyThreshold` | 0.5 | variety | H below this = hammering |
| `variety.highEntropyMargin` | 0.2 | variety | H within this of max = thrashing |
| `bestOfN.budget` | 2 | global | Default N, overridable by control loop |

---

## 5. Cross-Cutting: Integration & Data Flow

### Subsystem interaction

```
User Message
    |
    +---> Repo Map (PageRank seeded by mentioned files)
    |       +---> System context injection
    |
    +---> Control Loop reads variety entropy
    |       +---> Adjusts temperature for this turn
    |       +---> Adjusts tool-set width
    |       +---> Sets best-of-N budget (N=2 or N=4)
    |
    +---> Best-of-N check: tests available AND code task?
    |       +-- YES --> Run N candidates in worktrees
    |       |            Each candidate uses:
    |       |              - GBNF grammar (llama.cpp) or post-validation (Ollama)
    |       |              - Repo map context
    |       |              - Temperature from control loop
    |       |            Select winner by test pass rate
    |       |
    |       +-- NO ---> Normal single-pass conversation loop
    |                    Still uses grammar + repo map + temperature control
    |
    +---> Trajectory Recorder captures every turn
            +---> Reward Labeler finalizes at task end
                    +---> ~/.cynco/trajectories/<taskId>.jsonl
                            (ready for Stage C training)
```

### Error handling

- Grammar emitter failure → fall back to no grammar (existing behavior)
- Tree-sitter parse failure for a file → fall back to regex chunker for that file
- BM25 index corruption → rebuild on next `/analyze`
- Worktree creation failure → skip best-of-N, run single-pass
- Trajectory recorder failure → log warning, don't block conversation
- Each subsystem degrades gracefully without taking down the others

### All new environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_GRAMMAR_ENABLED` | `true` | GBNF constrained decoding (llama.cpp) |
| `LOCALCODE_BEST_OF_N` | `false` | Enable best-of-N sampling |
| `LOCALCODE_BEST_OF_N_COUNT` | `2` | Default N |
| `LOCALCODE_BEST_OF_N_TEMP` | `0.8` | Temperature for candidates |
| `LOCALCODE_BEST_OF_N_TURN_CAP` | `15` | Max turns per candidate |
| `LOCALCODE_TRAJECTORY_ENABLED` | `true` | Trajectory recording |
| `LOCALCODE_VARIETY_CONTROL` | `true` | Variety → temperature control |

---

## Out of Scope (Stage C)

These are explicitly deferred to the training spec:

- Unsloth SFT/DPO/GRPO training pipeline
- GGUF conversion and Ollama adapter creation
- Eval harness (personalized held-out, HumanEval+, MBPP+, BFCL)
- Promotion gate (eval → promote/rollback)
- S4 learned outcome predictor
- S5 outcome-conditioned training labels (replacing deriveDecision)
- Synthetic task generation (mutate-then-fix)
- Speculative decoding with draft model

The trajectory recorder and reward labeler in this spec collect the data those systems will consume.
