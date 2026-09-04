# CynCo / LocalCode — map for agents

LocalCode is a local-first coding agent engine (Bun + TypeScript under `engine/`, Textual TUI under `tui/`) governed by a Viable System Model layer; CynCo is that engine running unattended CivKings missions under sealed gates (`scripts/dispatch-mission.sh`, `scripts/cynco-mission-driver.mjs`, ledger `benchmark/cynco-ledger/`). Each engine subsystem carries its own `CLAUDE.md` — read that for files, types, `file:line` refs and gotchas before touching it. The failure log `docs/cynco-failure-log.md` is the project's memory of what went wrong and why; cite F-numbers when a change closes one. The guard `engine/__tests__/guards/packageDocs.test.ts` fails when a package doc is missing or names a line that no longer exists, so a doc that is wrong cannot stay wrong.

| Subsystem | Doc | What it does |
|---|---|---|
| Conversation loop, tool dispatch, contracts, protocol | [`engine/bridge/CLAUDE.md`](engine/bridge/CLAUDE.md) | `ConversationLoop`: model calls, `executeOneTool`, S2 nudges, context injection, `EngineEvent` protocol, WS bridge to the TUI |
| Model-calling core | [`engine/engine/CLAUDE.md`](engine/engine/CLAUDE.md) | Messages/tools → `CompletionRequest`, provider streaming into the Anthropic-shaped event lifecycle, tool-call JSON repair ladder, context-window budget, static system prompt |
| Tool implementations | [`engine/tools/CLAUDE.md`](engine/tools/CLAUDE.md) | Bash/Read/Edit/Grep/CodeIndex/Git…, `bashMaxTimeoutMs`, safety checks, sealed-path guard, contract verify, doom-loop detector |
| VSM governance | [`engine/vsm/CLAUDE.md`](engine/vsm/CLAUDE.md) | S1–S5 organs, homeostat, algedonic channel, variety engine, read-loop gate, governance DB |
| S5 orchestrator | [`engine/s5/CLAUDE.md`](engine/s5/CLAUDE.md) | Rule-based + model S5, advisory vs enforce (`LOCALCODE_S5_ENFORCE`), decision evaluation, training export |
| llama.cpp serving | [`engine/llama/CLAUDE.md`](engine/llama/CLAUDE.md) | `ProcessManager` (spawn/health/pre-spawn refusal/backoff), GGUF header, checkpoint cost + live calibration, slot KV snapshots, `LlamaCppProvider` |
| Ollama provider | [`engine/ollama/CLAUDE.md`](engine/ollama/CLAUDE.md) | The Ollama provider, capability probe, request/stream formatting |
| Brain telemetry | [`engine/brain/CLAUDE.md`](engine/brain/CLAUDE.md) | Entropy trace, jlens sidecar (9163), activation tap; `brain.*` reaches the dashboard only |
| Code index | [`engine/index/CLAUDE.md`](engine/index/CLAUDE.md) | SQLite store, embeddings, hybrid rank, symbol lookup, repo map, `closeAllIndexers` |
| Retrieval | [`engine/retrieval/CLAUDE.md`](engine/retrieval/CLAUDE.md) | Tree-sitter chunking (`CHUNKER_VERSION`) used by the index |
| Research | [`engine/research/CLAUDE.md`](engine/research/CLAUDE.md) | Multi-engine search with a fallback chain, scoring/dedup, research reports embedded into the project store |
| Memory | [`engine/memory/CLAUDE.md`](engine/memory/CLAUDE.md) | Bitemporal `LearningStore`, recall, helpful/harmful demotion, compaction, atomic writes |
| Training | [`engine/training/CLAUDE.md`](engine/training/CLAUDE.md) | Trajectory recorder and labeling, decision journal, adapter names |
| Best-of-N | [`engine/bestOfN/CLAUDE.md`](engine/bestOfN/CLAUDE.md) | Candidate sampling and selection |
| Sub-agents | [`engine/agents/CLAUDE.md`](engine/agents/CLAUDE.md) | `SubAgentRunner`, agent modes, result hand-back |
| Skills | [`engine/skills/CLAUDE.md`](engine/skills/CLAUDE.md) | Skill discovery, loading and invocation |
| Workflows | [`engine/workflows/CLAUDE.md`](engine/workflows/CLAUDE.md) | `WorkflowEngine` |
| Vibe mode | [`engine/vibe/CLAUDE.md`](engine/vibe/CLAUDE.md) | Guided mode controller, side-query routing, mode suppression |
| Daemon | [`engine/daemon/CLAUDE.md`](engine/daemon/CLAUDE.md) | Liveness daemon, task runner (child engines), notifications |
| Profiles | [`engine/profiles/CLAUDE.md`](engine/profiles/CLAUDE.md) | `~/.cynco/profiles/*.yaml` schema and the runtime knobs that reach llama-server |
| Dashboard | `engine/dashboard/server.ts` + `index.html` | Governance dashboard on 9161 (token-gated `/ws`, `/api/mission`); the page is read once at engine start |
| Security | `engine/security/` | Local tokens (`tokens.json`), Job Object child cleanup (`jobObject.ts`) |
| Cybernetics core | `engine/cybernetics-core/README.md` | Beer/Ashby/Pask primitives the VSM layer is built on |

## Invariants

- **Grade the commit, not the tree** (F132): every verdict runs gate + suite against a pinned sha in a clean checkout.
- **`--ctx-size`, `--ctx-checkpoints` and `--cache-ram` are one decision** (F91): the budget comes from `engine/llama/checkpointCost.ts`, never from a hand-set number.
- **Children die with the engine** (F131): the engine sits in a KILL_ON_JOB_CLOSE job; no kill sweep is a substitute.
- **Refuse, don't crash** (F140): every llama-server spawn runs the host/GPU check first and names its refusal.
- **The dashboard rides the engine** (F141/F143): a dispatch swaps the engine under an open tab; mission end boots an idle engine; long tool calls show `running Nm NNs`.
- **Every operator-facing cap is tested at the layer where the work happens** (F142): `bashMaxTimeoutMs()`, not the dispatch banner.
- **Never fail the same way twice**: every CynCo failure goes in `docs/cynco-failure-log.md` with where/how/why/fix.

## Build / test

`bun engine/main.ts` runs the engine (dashboard on 9161). `npx vitest run` is the engine suite (`bun:test` imports are aliased); `npm run audit:wiring` is the post-change guard set (protocol coverage, empty-catch ratchet, README env inventory, package docs); `cd tui && pytest` for the TUI. Missions: `scripts/dispatch-mission.sh <brief> <marker> <cwd> <timeout-s> "<check-cmd>"`.
