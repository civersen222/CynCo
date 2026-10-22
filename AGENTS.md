# CynCo / LocalCode — map for agents

LocalCode is a local-first coding agent engine (Bun + TypeScript under `engine/`, Textual TUI under `tui/`) governed by a Viable System Model layer; CynCo is that engine running unattended CivKings missions under sealed gates (`scripts/dispatch-mission.sh`, `scripts/cynco-mission-driver.mjs`, ledger `benchmark/cynco-ledger/`). Each engine subsystem carries its own `CLAUDE.md` — read that for files, types, `file:line` refs and gotchas before touching it. The failure log `docs/cynco-failure-log.md` is the project's memory of what went wrong and why; cite F-numbers when a change closes one. The guard `engine/__tests__/guards/packageDocs.test.ts` fails when a package doc is missing or names a line that no longer exists, so a doc that is wrong cannot stay wrong. `docs/NOW.md` names the one current objective; the rules for changing anything are under **How to change CynCo** below.

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
| Generative UI | [`engine/genui/CLAUDE.md`](engine/genui/CLAUDE.md) | `RenderUI`: the component catalog, spec validator, prompt section, streaming partial frames and `ui.action` round trip that let the model draw tables, plans, charts and forms in the dashboard |
| Image generation | [`engine/imagegen/CLAUDE.md`](engine/imagegen/CLAUDE.md) | ComfyUI client, one-at-a-time job queue and the project image store behind RenderUI Image prompts; room left for image→3D→STL |
| Daemon | [`engine/daemon/CLAUDE.md`](engine/daemon/CLAUDE.md) | Liveness daemon, task runner (child engines), notifications |
| Projects | [`engine/projects/CLAUDE.md`](engine/projects/CLAUDE.md) | Non-code projects: folder layout + registry, invisible git, prose ingestion, project/global search, project chats, the three project tools, `/api/projects/*` |
| Profiles | [`engine/profiles/CLAUDE.md`](engine/profiles/CLAUDE.md) | `~/.cynco/profiles/*.yaml` schema and the runtime knobs that reach llama-server |
| Dashboard | `engine/dashboard/server.ts` + `index.html` + `access.ts` | Governance dashboard on the bridge port + 1 (token-gated `/ws` and `/api/*`, except `POST /api/pair`, which the single-use pairing code gates for remote clients); the page is read once at engine start; `access.ts` is the phone-access boundary (local vs remote, pairing, device tokens) — `docs/decisions/2026-10-22-phone-access.md` |
| Security | `engine/security/` | Local tokens (`tokens.json`), Job Object child cleanup (`jobObject.ts`) |
| Cybernetics core | `engine/cybernetics-core/README.md` | Beer/Ashby/Pask primitives the VSM layer is built on |

## Invariants

- **Grade the commit, not the tree** (F132): every verdict runs gate + suite against a pinned sha in a clean checkout.
- **`--ctx-size`, `--ctx-checkpoints` and `--cache-ram` are one decision** (F91): the budget comes from `engine/llama/checkpointCost.ts`, never from a hand-set number.
- **Children die with the engine** (F131): the engine sits in a KILL_ON_JOB_CLOSE job; no kill sweep is a substitute.
- **Refuse, don't crash** (F140): every llama-server spawn runs the host/GPU check first and names its refusal.
- **The dashboard rides the engine** (F141/F143): a dispatch swaps the engine under an open tab; mission end boots an idle engine; long tool calls show `running Nm NNs`.
- **Every operator-facing cap is tested at the layer where the work happens** (F142): `bashMaxTimeoutMs()`, not the dispatch banner.
- **Off this machine, only a paired device's token opens the dashboard** (phone access, 2026-10-22): the shared token is injected for loopback only, the bridge stays loopback, and management is refused to any remote client whatever it presents.
- **Never fail the same way twice**: every CynCo failure goes in `docs/cynco-failure-log.md` with where/how/why/fix.

## What to work on

`docs/NOW.md` holds the one current objective, a short Next list, the backlog and what is deliberately deferred. Work the current objective. When you discover something adjacent — a defect, a cleanup, a better idea — write it into NOW.md's backlog and keep going; changing the current objective is the owner's decision, not a side effect of a debugging session.

## How to change CynCo

Asked for by the owner on 2026-10-22 (the complexity-control mission: keep the ambition, make changes deliberate and verifiable) and condensed here. The sequence for every change beyond a one-line fix. It is a way of working, not a form to fill in.

1. **Outcome first.** Say what the owner can do afterwards and how you will see it works — observable acceptance criteria, never "cleaner" or "better architecture".
2. **Trace before you touch.** Follow the real path: entry point → the component that owns the state → dependents → failure paths → the tests that pin it. The package `CLAUDE.md` is the map; the source is the territory; a name or a README sentence is not evidence.
3. **Smallest complete solution.** Reach for the existing component, function, store, flag or coordinator first. A new mechanism — subsystem, service, abstraction, process, persistent store, protocol or message shape, environment variable, dependency, agent, governance rule — must answer six questions: what concrete problem; why the existing thing is insufficient; what state, dependencies and failure modes it adds; how it is verified; how it is disabled, recovered or removed; who maintains it. A small change answers them in a sentence of the commit message; a consequential one gets a short record in `docs/decisions/`.
4. **One vertical slice.** Behaviour + interface + failure handling + tests, usable end to end. No stub that cannot yet do anything, no framework waiting for its first caller, no unrelated refactor riding along. Extract a module when it has one responsibility and a testable seam — not because a file is long.
5. **Verify.** Every item of `docs/POST-CHANGE-VERIFICATION.md` (it says how to report what ran).
6. **Read the diff** for: scope creep, duplicated logic, new global or shared mutable state, hidden coupling across packages, an unsafe default, a second way to configure the same thing, a swallowed error, a claim no test backs.
7. **Update the one document that owns the behaviour** (the package `CLAUDE.md`, the README section, the user guide). Do not restate a fact in a second place; link to it. Cite the F-number when a change closes a failure-log entry.
8. **Close the loop.** Report what changed, how it was tested, what is uncertain, what it costs to keep, and leave the adjacent ideas in NOW.md.

### Review triggers

Look harder, and say so in the change description, when a diff adds: a runtime dependency or a separately running process; a persistent store or a second source of truth for state that already has an owner; a protocol or an incompatible message shape; an environment variable or feature flag; shared mutable state or lifecycle management across packages; cross-cutting behaviour that changes how several tools or workflows act; autonomous authority to change files, run commands, change policy or change network exposure; a core package depending on an experimental or optional one. These are triggers for a proportional design note, not prohibitions. File count and diff size are warning lights, not a quality score.

### Preserve what works

Do not remove, disable or rewrite a capability to make the architecture cleaner. Before changing established behaviour, know how the owner uses it, what depends on it, what its documentation promises and which test pins it. Removing a meaningful capability, a destructive migration, a broad rewrite, or widening a security boundary (binding beyond loopback, weakening a token scope, allowlisting a new browser frame) needs the owner's explicit yes first.

## What a mechanism is

Keep four statements apart — in comments, docs and reports alike:

- **useful** — the owner relies on it day to day;
- **correct** — it passes its functional tests;
- **effective** — it was shown to improve a measured outcome against a comparable baseline (`docs/BENCHMARKS.md`, the ledger);
- **hypothesis** — a research idea whose effect is unmeasured or inconclusive.

An inconclusive benchmark is not a reason to remove something useful, and a theory is not a reason to let a policy block work. Experimental policy earns authority in steps — observe, then advise, then enforce — and S5's `advisory` / earned-`enforce` split (`engine/s5/ruleAuthority.ts`) is the pattern to reuse, not to build beside. Every optional or experimental subsystem says in its package doc how it is switched on, what depends on it and what happens when it is absent. A `LOCALCODE_*` variable (a profile field maps onto one) is the switch mechanism for new behaviour; the README inventory is generated from the read sites. Do not add another mechanism, and do not add a switch to avoid making a decision.

## Build / test

`bun engine/main.ts` runs the engine (dashboard on 9161). `npx vitest run` is the engine suite (`bun:test` imports are aliased); `npm run audit:wiring` is the post-change guard set (protocol coverage, empty-catch ratchet, README env inventory, package docs); `cd tui && pytest` for the TUI. Missions: `scripts/dispatch-mission.sh <brief> <marker> <cwd> <timeout-s> "<check-cmd>"`.
