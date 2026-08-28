# CynCo — Cybernetic Collaborator

**AI coding assistant that runs entirely on your GPU. Zero API costs. Your data never leaves your machine.**

Inspired by Stafford Beer's Viable System Model and Salvador Allende's [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn) (Chile, 1971-73). AI that belongs to the person running it.

---

## What Is This?

CynCo is an AI coding assistant powered by local LLMs via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp). Work from the terminal TUI, or straight from your browser — the dashboard includes a full chat UI. It can:

- **Edit files, run commands, search code** — full tool-calling loop on your hardware
- **Build entire projects from a description** — guided Vibe mode asks smart questions, then builds autonomously
- **Self-govern with enforced cybernetics** — S5 policy engine with 21 rules, 4-tier stuck loop escape, live governance signals injected every iteration
- **Chat and monitor from the browser** — dashboard with a full chat UI plus real-time tool activity, contracts, predictions, training data progress, and variety control
- **Constrained decoding** *(opt-in: `LOCALCODE_GRAMMAR_ENABLED=true`)* — GBNF grammar enforcement on llama.cpp, post-validation on all providers
- **Best-of-N sampling** *(opt-in: `LOCALCODE_BEST_OF_N=true`)* — run multiple candidates in git worktrees, select by test pass rate
- **Tree-sitter code indexing** — AST-aware chunking with BM25 + vector hybrid search and PageRank repo map
- **Self-improving training loop** — trajectory recorder collects per-turn data, reward labeler scores outcomes, Unsloth SFT pipeline exports ChatML datasets
- **Research from multiple sources** — DuckDuckGo, arXiv, Wikipedia, GitHub, PubMed, HuggingFace with intelligent query routing
- **Spawn parallel sub-agents** — 6 typed personas (scout/oracle/kraken/spark/architect/researcher) with GPU-aware scheduling
- **Index your codebase semantically** — vector + BM25 hybrid search finds relevant code instantly
- **Persist across sessions** — handoff files, decision journals, governance DB, rule weight learning, and trajectory data for training
- **Run unattended long-horizon missions** — dispatch one brief, drive to a marker commit, verify with a check command, and append a labeled row to an outcome ledger — see [Autonomous missions](#autonomous-missions--calibrated-gate-supervision)

---

## Recommended Models

CynCo works best with models that support native tool calling. Here are the tested and recommended models:

### Primary (your main coding model)

| Model | Type | VRAM | Speed (RTX 5090) | SWE-bench | Notes |
|-------|------|------|-------------------|-----------|-------|
| **Qwen3.8-27B** | Hybrid (Gated DeltaNet) + MTP | ~20 GB (NVFP4) | 94–119 tok/s, measured | not measured here | **What we run.** NVFP4 GGUF via the llama.cpp provider with MTP+ngram speculative decoding — acceptance drives the spread (prose 94.9, code 101.1, repetitive JSON 119.3 tok/s). 16/16 streamed tool calls, zero drops. Trained to 262K context; we serve 131K. Native tool use. Apache 2.0. |
| Qwen3.6-27B | Dense + MTP | ~16 GB (NVFP4) | 115 tok/s eval, measured | 77.2% | The previous default — every number in the serving guide was measured on it. NVFP4 GGUF with MTP speculative decoding. Native tool use. Apache 2.0. |
| Gemma4-31B | Dense | ~19 GB (Q4) | ~52 tok/s | ~65% | Good alternative. Native tool use. |
| Devstral-Small-2-24B | Dense | ~15 GB (Q4) | ~70 tok/s | Good | Strong for agentic multi-file edits. Fits 16GB GPUs. |
| Qwen3.6-35B-A3B | MoE | ~20 GB (Q4) | ~234 tok/s | 73.4% | Raw speed champion (3B active params), but 27B dense scores higher and MTP closes the speed gap. |

### Quantization

We run the **NVFP4** GGUF of Qwen3.8-27B (`Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf`, 19.7 GB on disk), measured 2026-08-28 at 94–119 tok/s single-stream with 16/16 streamed tool calls and zero drops (`benchmark/true/results/`). The trade-off logic is unchanged from Qwen3.6: NVFP4 frees the most VRAM on a 32 GB card for KV and sub-agents, which Q6_K does not. The quantization table below was measured on the previous default (Qwen3.6-27B) and is kept for the shape of the trade-off:

| Quantization | Size (27B dense) | Measured decode | Quality | When to Use |
|-------------|------------------|-----------------|---------|-------------|
| **NVFP4 + MTP** | ~16 GB | 115 tok/s eval, 0.83 draft acceptance (live missions, 2026-07-10) | Tool-call structure intact | **What we run.** Frees the most VRAM for context and agents. |
| Q6_K + MTP | ~22 GB | 153.7 tok/s median decode at `spec_draft_n=3` (benchAgentic A/B, 2026-07-01) | Near-lossless | The alternative if you have the headroom. |
| Q4_K_M | ~17 GB | not measured here | Good | 24 GB GPUs. |
| Q3_K_M | ~13 GB | not measured here | Noticeable loss | Only if you can't fit Q4. Tool-call structure degrades below 4-bit. |

The two measured numbers came from different harnesses — one is a live mission stream, the other a controlled A/B bench — so they are reported separately rather than compared. Neither has been re-run against the other's setup.

**One gotcha, and it cost us a session.** The community NVFP4 GGUF embeds a stricter Jinja chat template that raises on mid-conversation system messages, and CynCo injects exactly those (index chunks, project state). Point the profile at a known-good template:

```yaml
runtime:
  chat_template_file: ~/.cynco/models/qwen3.6-27b-nvfp4/chat_template.jinja
```

The tool-call probe did not catch this, because it only sends system-first prompts. See [docs/cynco-failure-log.md](docs/cynco-failure-log.md).

**Qwen3.8 has its own template gotchas.** The same template-file override applies (a known-good `chat_template.jinja` ships next to our GGUF), and two things are new. Its template reads `reasoning_effort` (`low | medium | xhigh`) and `preserve_thinking` from `--chat-template-kwargs` — profile key `chat_template_kwargs`, which the engine forwards; other models ignore unknown keys. And it raises `No user query found in messages.` — a hard 400 — on any prompt with no user message, which is one reason the engine's compaction anchors recent user messages verbatim (enforced by a regression test).

### Embedding Model

Semantic indexing needs a *separate* embedding model — the chat model does not serve embeddings. CynCo asks for `jina-code-embeddings-0.5b` (code-specialized) and falls back to `nomic-embed-text` if that one is missing. Against an Ollama server it will also try to pull the missing model in the background, once; against an OpenAI-shaped server (`llama-server --embeddings`) there is nothing to pull, so install it yourself:

```bash
ollama pull jina-code-embeddings-0.5b
```

Override with `LOCALCODE_EMBED_MODEL` — switching embed models requires a re-index. If no embedding server answers you get keyword search and the engine says so; see [Semantic Code Index](#semantic-code-index) for how it finds one.

### A second model (optional)

Configure more than one model and S5 can switch between them mid-session. Rule W2 fires when latency is *measured* rising over at least five turns and an alternative is configured, and the conversation loop applies the switch.

This is a reaction to observed slowness, not a router: nothing inspects a task and sends it to a smaller model up front. There is no dispatch-time complexity classifier, and no plan to add one — S5 already carries a measured difficulty signal (`promptDifficulty`, derived from turn telemetry), which is strictly better evidence than guessing from the wording of a request.

---

## Quick Start

### Prerequisites
- [Ollama](https://ollama.com) running locally (or llama.cpp for the direct GGUF provider)
- [Bun](https://bun.sh) runtime
- Python 3.10+

### Install & Run

```bash
# Clone
git clone https://github.com/civersen222/CynCo.git
cd CynCo

# Pull recommended model
ollama pull qwen3.6

# Install Python dependencies
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
cd tui && pip install -e . && cd ..

# Pull embedding model for semantic code search
ollama pull jina-code-embeddings-0.5b

# Launch
cd tui && python -m localcode_tui.app
```

That's it. No API keys. No subscriptions. No data leaving your machine.

Once running, interact in the TUI or open the dashboard in your browser. The engine prints its URL at startup:

```
[dashboard] Governance dashboard on http://localhost:9161
```

That is the bridge's bound port plus one, not a fixed number. The bridge asks for `LOCALCODE_WS_PORT` (default `9160`) and falls back to the next free port when that one is taken — which, after a restart, is the ordinary case. Read the line; don't assume `9161`.

### Recommended: llama.cpp Direct Provider with MTP Speculative Decoding

This is how we run CynCo — llama-server driven directly with Multi-Token Prediction on the Qwen3.8-27B NVFP4 GGUF:

```bash
LOCALCODE_PROVIDER=llama-cpp \
  LOCALCODE_MODEL_PATH=~/.cynco/models/qwen3.8-27b-nvfp4/Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf \
  LOCALCODE_SPEC_TYPE=ngram-mod,draft-mtp \
  LOCALCODE_SPEC_DRAFT_N=3 \
  bun engine/main.ts
```

Context defaults to 131072 — half of what Qwen3.8-27B is trained for (262144), ~2.5 GB of f16 KV — because at 65536 the engine compacted once every ~9 turns on long missions. Override with `LOCALCODE_CONTEXT_LENGTH` if you have less VRAM.

With NVFP4 you also need the chat-template override from [Quantization](#quantization) above, which is a profile key rather than an env var.

The engine auto-manages llama-server with: single-slot mode, context checkpoints for prefix-cache rollback (Qwen3.6 and 3.8 are hybrid Gated DeltaNet models — warm turns only prefill new tokens instead of reprocessing the whole prompt), capped reasoning budget (256 tokens), and accurate tok/s from server eval timing. The engine keeps its prompt strictly append-only across turns to preserve the cache (enforced by a regression test). Measured live at 45K tokens of context: warm turns restore a checkpoint with ~0.998 prefix reuse and prefill only the ~500-900 genuinely new tokens (~0.6-0.9 s) instead of reprocessing the full prompt (~17 s) — each turn pays only for its new content. Side queries route through the same llama-server instance to avoid VRAM thrashing. Full tuning recipe: [docs/serving/rtx-5090-qwen3.6-27b.md](docs/serving/rtx-5090-qwen3.6-27b.md).

Every turn's cost is recorded to the `measurements` table: prefill tokens, cached tokens, decode tokens, prefill/decode milliseconds, wall milliseconds, and the source the numbers came from. Prefill tokens are `timings.prompt_n` — the tokens the server actually evaluated — not `prompt_tokens`, which is the size of the whole prompt; conflating them makes a cached 60K prefix look identical to a cold one. A turn whose server reported no timings is stored as `NULL`, not zero: it is unmeasured, not free. `/spend` sums the session and reports how many turns it covers, so a partial total reads as a floor rather than a claim.

---

## Hardware Expectations

| VRAM | Recommended Model | Experience |
|------|------------------|------------|
| 8-12 GB | Devstral-Small-2 Q4 | Solid tool calling, single-file tasks |
| 16 GB | Devstral-Small-2 Q6 | Multi-file projects, sub-agents |
| 24 GB | Qwen3.6-27B NVFP4 | Full feature set, parallel agents |
| **32 GB** | **Qwen3.8-27B NVFP4 + MTP** | **What we develop on. 94–119 tok/s measured, with room for 131K context + agents.** |
| 32+16 GB (dual) | Primary + a smaller alternative | S5 can switch to the alternative when latency rises (rule W2) |

Smaller models (<7B) struggle with the tool-calling format. 24B+ recommended for real work.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  S5 Policy Engine (21 rules, 3 tiers, enforced)              │
│  7 Critical: auto-enforce | 10 Warning: TUI | 4 Info: journal│
└──────────────────────────┬───────────────────────────────────┘
                           │ enforces
┌──────────────────────────┴───────┐   WS   ┌─────────────────┐
│  TypeScript Engine (Bun)         │◄──────►│  Python TUI     │
│                                  │  9160  │  (Textual)      │
│  Conversation Loop               │        │                 │
│  ├── Tool Executor (29 tools)    │        │  Workspace      │
│  ├── Contract Enforcement        │        │  Vibe Loop      │
│  ├── S2 Agent Coordinator        │        │  Settings       │
│  ├── 6 Search Engines            │        │  Context Bar    │
│  ├── Semantic Code Index         │        │                 │
│  ├── Context Compressor          │        │                 │
│  └── Sub-Agents (6 personas)     │        │                 │
│       ↓ HTTP                     │        │                 │
│  Ollama / llama.cpp              │        │                 │
├──────────────────────────────────┤        └─────────────────┘
│  Governance Dashboard (HTTP+WS)  │
│  bridge port + 1 (9161 by dflt)  │   ← browser
│  Live monitoring + param control │
└──────────────────────────────────┘
```

---

## Features

### Workspace Mode
Type naturally. CynCo calls tools autonomously — reads files, edits code, runs commands, searches the codebase.

### Vibe Mode (`/project`)
Guided building for non-programmers. Type `/project` to start. CynCo asks clarifying questions scaled to project difficulty, builds locked decisions, then codes autonomously with goal-backward verification:
1. **Understand** — asks focused questions, builds confidence score
2. **Build** — works autonomously with locked D-XX decisions
3. **Report** — explains what was built in plain language with analogies
4. **Next** — suggests the logical next step

Also accessible via `/mode` to switch to the guided screen.

### Deep Research (`/research`)
Multi-source research workflow with 6 search engines:
- **DuckDuckGo** — general web (rate-limit mitigation, retry with backoff)
- **GitHub** — repos sorted by stars with minimum threshold filtering
- **arXiv** — academic papers with CS category filtering and relevance scoring
- **Wikipedia** — background and definitions
- **PubMed** — biomedical literature
- **HuggingFace** — ML models and datasets

A seventh, **SearXNG**, is implemented (`engine/research/engines/searxng.ts`) but only used when you point `LOCALCODE_SEARXNG_URL` at an instance.

Results are scored by keyword relevance, recency, source authority, and cross-source corroboration. Fallback engine chain ensures results even when primary engine is unavailable.

### Sub-Agents
6 typed personas with domain vocabulary injection (PRISM system):
- **scout** — codebase exploration, pattern finding
- **oracle** — external documentation, API research
- **kraken** — test-driven implementation
- **spark** — targeted bug fixes
- **architect** — system design, planning
- **researcher** — multi-source research with web access

S2 coordinator manages GPU utilization, queues agents when resources are constrained, and kills stuck agents via algedonic signals.

### Enforced Governance (VSM S1-S5)
Not advisory — **enforced**. S5 is the single policy enforcer with 21 tiered rules, all in `engine/s5/ruleBasedS5.ts`: 7 Critical, 10 Warning, 4 Info.

**Critical — 7 rules, auto-enforced with no user approval:**
- **C1** Kill switch on 5+ consecutive tool failures
- **C2** Tool exclusion when a specific tool fails 3+ times
- **C3** Context overflow compaction at 90% utilization
- **C4** Doom loop breaking (3+ identical failing calls)
- **C5** GPU exhaustion — block sub-agent spawns
- **C6** Variety critical — restrict to top-5 tools by success rate
- **C7** **Stuck loop escape** — restrict to unused tools when stuck 5+ turns, regardless of tool success rate

One wart worth naming rather than hiding: the rule with `id: 'I4'` (heterarchy authority) sits in the Info block by name but declares `tier: 'warning'`, so it is enforced as a Warning. That is why the tiers count 7/10/4 while the ids read C1-C7, W1-W9, I1-I5.

A 22nd rule, `P1` in `engine/s5/proactiveSurfacing.ts`, exists only when `LOCALCODE_S5_PROACTIVE_TOOLS=true`. It is append-only — it surfaces tools, never restricts them — and it is off by default.

**Stuck Loop Escalation (4 tiers):**
1. **Turn 3+** — governance signal appended to the conversation: "change your approach" (appended, not a system-prompt rewrite — keeps the prompt cache valid)
2. **Turn 5+** — C7 critical rule restricts tools to ones not used in last 5 turns
3. **Turn 10+** — synthetic user message forces model to reflect on what's blocking it
4. **Turn 15+** — hard halt, returns control to user

**Warning (surfaced to TUI for accept/dismiss):**
- Model switch recommendation on rising latency
- Workspace revert on 5+ stuck turns
- Drift-based compaction and tool restriction
- Homeostatic instability rebalancing
- S3/S4 imbalance correction

**Info (logged for training):**
- Variety balance shifts, homeostatic adjustments, performance metrics

Rule weights adjust across sessions based on outcomes — positive outcomes strengthen rules, user dismissals weaken them.

### Contract Enforcement
Every user message auto-creates a Definition of Done contract. The model cannot stop until all assertions pass:
- **Edit tasks:** file modified + changes committed
- **Analysis tasks:** answer provided + addresses user's question
- **Run tasks:** command executed + output reported
- Up to 5 enforcement rounds — if the model tries to stop early, it gets told "you're NOT done"

### Governance Dashboard + Chat UI
Open the URL the engine printed at startup (bridge port + 1; `http://localhost:9161` when the bridge got its default). Five tabs:

**[Chat]** — Send prompts directly from the browser. Full tool output with expandable details, visible thinking tokens, streaming model text. Slash commands (`/plan`, `/tdd`, `/debug`) for workflows. Enter to send, Shift+Enter for newlines.

**[Governance]** — Real-time VSM monitoring:
- **Tool Activity** — stacked bar chart + live feed with latency
- **Governance Health** — S3/S4 balance, variety ratio, stuck turns, algedonic alerts, and action-fingerprint repetition alarms (flags 3-identical / 6-alternating tool-call loops)
- **Prediction Tracker** — 8 redesigned hypotheses measuring governance effectiveness (H1: Stuck Escape, H2: Nudge Response), model predictability (H4: Read-to-Edit, H5: Thinking Efficiency), and parameter tuning (H6: Temperature Effect, H7: S4 Reflection ROI). Each is scored against a null baseline, and the baseline says where it came from: `measured` means the hypothesis's own success predicate was scored on the same tool stream at points where it was *not* triggered; `assumed` means the hand-written constant. Six of the eight can be measured; H3 reads governance state and H8 is scored once at session end, so both stay assumed. A significance verdict against an assumed baseline is a verdict against a guess, and `/predictions` now says so.
- **Active Contract** — assertion status with pass/fail/pending
- **S5 Decision Log** — live policy decisions with reasoning
- **tok/s** — from `timings.predicted_n / predicted_ms`, the server's own count and clock. It used to be the engine's count of *stream deltas* over its own wall clock, which reads low under speculative decoding (one chunk can carry several tokens) and includes queueing the server never saw.

**[Brain]** — Model cognition: thinking-token viewer, per-token entropy trace, and (with setup) a live concept workspace read from mid-network activations. See **The Brain** below.

**[History]** — Session analytics with per-session metrics charts (tool success, stuck turns, context utilization over time), session transcript viewer, and session selector.

**[Config]** — Temperature, context length, timeout sliders. System control toggles. All 26 VSM governance parameters (`engine/vsm/governanceParams.ts`) with sliders and their declared bounds.

Survives page reload, auto-detects active sessions, auto-reconnects on disconnect. Polls governance every 3s and training data every 30s.

### Local tokens

The engine mints `~/.cynco/tokens.json` at startup (owner-only; on Windows the
ACL is narrowed with `icacls`, since `chmod 0600` there is close to a no-op). One
record shape carrying a scope vector, not one key type per capability:

| Scope | Opens | Reaches its holder by |
|---|---|---|
| `bridge` | The TUI command channel on the bridge port — this drives the agent, and the agent has Bash | Read from the token file. The TUI, the mission driver and the probes all do this, so launching any of them takes no arguments. |
| `inference` | Every dashboard read route, plus the dashboard WebSocket — session transcripts, thinking tokens, governance, and the Chat tab's own send path | Injected into the dashboard page at request time. |
| `management` | `POST /config/*` and `/api/brain/layer` — anything that changes engine or governance configuration | Printed once at engine startup and pasted by hand. Never handed to a page. |

The split is not ceremony. The inference token is delivered to a browser, so it
is the secret most likely to escape; flipping `ablation` or
`contractEnforcement` silently corrupts the measurements the research rests on,
so that costs a deliberate paste. A management token also reads, because the
`admin` holder carries both scopes.

**The `inference` scope opens a send path, so it is bounded by an allowlist too.**
The Chat tab has to be able to talk to the agent — that is the feature — so the
dashboard socket forwards frames. Which frames is not left to the page:
`dashboardCommandRefusal` in `engine/dashboard/server.ts` asks two separate
questions, in order. First *may a browser send this kind of frame at all* — an
allowlist of nine frame types and fifteen slash commands, every one of them
read-only or no more privileged than typing the same sentence. Then *is the frame
the shape that kind is declared to have* — `validateCommand`, the same schema
check the bridge entrance runs. Authority first, because a perfectly well-formed
`/approve-all` has to be refused for what it is, not for how it is spelled.

Absent from the allowlist, deliberately: `/approve-all`, `/skill` (installs and
deletes on disk), `/quit` and `/exit`, `/model`, `/reset` (clears the governance
kill switch), `/undo`, `/compact`, `/commit`, `/export`, `/analyze` and the
`/audit-*` family. A refusal is logged rather than silently dropped — a boundary
nobody can see is indistinguishable from a socket that lost the frame.

Two more things follow from this that are easy to get wrong:

- **Nothing here is protected by CORS.** A WebSocket handshake is not subject to
  it at all, and `Content-Type: text/plain` makes a POST a "simple" request that
  lands without a preflight. The tokens are the control; loopback binding is a
  floor, and a browser is already inside loopback.
- **Binding to `0.0.0.0` puts the token in front of the network.** That is a
  64-hex secret in a file on one machine, not an auth system. Don't.

### The Brain

The dashboard's **[Brain]** tab exposes what the model is doing internally, at three depths:

**Thinking stream (default-on).** Thinking tokens are persisted per turn and rendered in the Brain tab's turn browser. Wired in `engine/bridge/conversationLoop.ts` (`finalizeTurn` stores each turn's thinking text) — no configuration needed.

**Entropy trace (default-on).** Every generated token carries its top-8 logprobs; the engine computes per-token entropy and streams it as a live sparkline with a hover readout of the runner-up tokens. Wired in `engine/ollama/client.ts` and `engine/llama/provider.ts` (logprobs request + `brain.token` broadcast). If the backend returns no logprob data, the trace degrades to a "no logprob data" notice — everything else keeps working.

**Concept workspace (setup-required).** A J-lens readout (`softmax(W_U · rmsnorm(J_ℓ h_ℓ))`) of mid-network activations, shown as a live ribbon of the concepts the model is holding at each layer. Tier support is auto-detected at startup by `engine/brain/activationsConsumer.ts` (`start()` probes both dependencies and reports `live` / `record-only` / `entropy-only` on the tab's badge). To enable the full `live` tier:

1. Download the lens artifacts: `cd jlens && python -m jlens_service.download`
2. Start the sidecar: `python -m jlens_service.server` (port 9163)
3. Build the patched llama-server (activation tap + `/activations` route — patch in `docs/research/llamacpp-activation-tap.patch`, base llama.cpp b9529), deploy to its own directory (e.g. `~/.cynco/bin-brain/llama-server.exe` with its CUDA DLLs alongside)
4. Set `LLAMA_ACTIVATIONS_LAYERS=24,32,40,48,56` and `LOCALCODE_LLAMA_SERVER=~/.cynco/bin-brain/llama-server.exe`

Without steps 3-4 the tab runs `entropy-only`; without step 2 it runs `record-only`. Nothing breaks either way.

### Always-on missions (experimental)

CynCo can run as a persistent agent: a tiny daemon schedules mission triggers (e.g. "watch my
fantasy league"), wakes the engine on-demand for one-shot tasks, and pushes recommendations to
your phone via self-hosted [ntfy](https://ntfy.sh) over Tailscale — approve or reject with one tap,
no public ports. See [docs/liveness-setup.md](docs/liveness-setup.md).

### Autonomous missions & calibrated-gate supervision

CynCo's proving ground is the unattended mission: one long-horizon brief, no user round-trips, graded at a sealed gate. `scripts/dispatch-mission.sh <brief> <marker> [cwd] [timeout-s] [check-cmd] [probe-cmd]` boots a fresh engine and `scripts/cynco-mission-driver.mjs` drives the run until a marker commit lands, a timeout closes it, or the engine goes quiet. The harness around it:

- **Outcome ledger.** Every mission appends one labeled row to `benchmark/cynco-ledger/missions.NNNN.jsonl`: outcome, check-cmd verdict, exact commit range, per-tool call stats, measured token counts from the server's own timings, and a separately-patched mutation-sweep label. An unmeasured mission is never defaulted to a passing one. Schema and labeling rules: [benchmark/cynco-ledger/README.md](benchmark/cynco-ledger/README.md).
- **In-loop probe (Stage 1).** Pass a cheap probe command and the driver runs it at quiescent turn boundaries after each landed commit; a FAIL's verbatim tail is injected back into the conversation as a user message, capped by `CYNCO_MAX_PROBE_OVERRIDES` (default 3) and fail-closed on `CYNCO_PROBE_TIMEOUT_MS`. The probe's full history lands in the ledger row's `probe` block.
- **Sealed, calibrated gates.** Success is graded by held-out gate scripts kept outside the supervised repository. Before dispatch, every gate must FAIL cleanly on the base commit and still FAIL against a cheat-stub perturbation — a gate that errors on the base measures nothing, and a gate a trivial stub can pass cannot discriminate real work from fakery.
- **Measured supervision economics.** `scripts/supervision-economics.mjs` accounts real frontier-model supervision spend against API-priced displaced generation. Over the five CivKings redesign campaigns (2026-08, all passed their sealed gates): $1 of frontier supervision oversaw ~$1.39 of displaced generation, and that generation ran locally for ~$9.34 of electricity — ~349× cheaper than API pricing. Method, campaigns, and failure modes: [docs/supervision-economics-paper.md](docs/supervision-economics-paper.md).
- **Failure-log discipline.** Every harness failure gets an F-number, a root cause, and a fix in [docs/cynco-failure-log.md](docs/cynco-failure-log.md). The rule: never fail the same way twice.

### Semantic Code Index
**Requires an embedding server.** Vector indexing needs an embedding model running somewhere — it is not served by the chat model. The engine speaks both wire formats: Ollama's `/api/embed` and the OpenAI-shaped `/v1/embeddings` (which `llama-server --embeddings` and most local servers expose), trying each until one answers, or pinned with `LOCALCODE_EMBED_API=ollama|openai`. It looks at `LOCALCODE_EMBED_BASE_URL`, then at the chat URL if the chat provider is Ollama, then at `http://localhost:11434`. If nothing answers you get keyword search, and the engine says so once at the top of the session as well as on `context.status`.

Automatic vector indexing via `jina-code-embeddings-0.5b` (code-specialized; `nomic-embed-text` runtime fallback). The model starts each task knowing your codebase — function signatures, class definitions, imports. Retrieval is **symbol-first**: ~85% of real mission queries are exact-identifier lookups, and routing those through cosine similarity like prose scored 63% top-3 against Grep's 92% — so identifier-looking queries now hit the AST symbol table first (`engine/index/symbolLookup.ts`), returning the definition (full body, `file:line`) plus ranked references in one call, an answer Grep structurally cannot give. Prose queries fall through to the **BM25 + dense RRF hybrid** over an AST-boundary-aware chunker. A **repo map** is injected on the first turn (capped ~2k tokens), and index degradation is surfaced on `context.status` (`indexMode` / `indexDegraded` / `lastQueryMode`) — it falls back to keyword search, and says so, when the embedding model is unavailable.

### Workflows
Structured multi-phase workflows with tool restrictions and advancement gates:
- `/research` — multi-source research with citations
- `/tdd` — test-driven development (red-green-refactor)
- `/debug` — systematic problem diagnosis
- `/review` — structured code review
- `/plan` — implementation planning
- `/brainstorm` — idea exploration
- `/critique` — critical analysis

### Skills
Shareable, self-contained capability packs — a directory with a `SKILL.md` (YAML frontmatter + prose instructions) that declares the tools it needs. Skills are discovered from two locations: bundled builtins (`engine/skills/builtins/`) and your workspace (`~/.cynco/skills/`, which overrides builtins by name). A name-sorted index of available skills is surfaced in the prompt; the model calls `run_skill` to load a skill's full instructions and its declared tools on demand, or `list_skills` to enumerate them.

The seven guided workflows above (`tdd`, `debug`, `review`, `plan`, `brainstorm`, `critique`, `research`) ship as builtin skills. `run_skill("tdd")` and the `/tdd` slash command are aliases: both drive the same phase-gated workflow engine, so the workflow keeps its state machine (per-phase instructions, gates, allowed tools) rather than collapsing into flat prose.

Manage skills with the `/skill` slash command:
- `/skill list` — show discovered skills
- `/skill new <name>` — scaffold a new skill (`~/.cynco/skills/<name>/SKILL.md`)
- `/skill install <owner>/<repo>[@ref][/subdir] --yes` — install from a GitHub zipball (no git binary needed)
- `/skill remove <name>` — delete a workspace skill

Both of those write to disk on the strength of a name someone else chose, so both
are bounded rather than trusted:

- **Install shows you the payload before it asks.** A skill body is prose that
  gets handed to the model as instructions, and a confirmation prompt that
  summarised it was asking you to approve something you had not read. The
  confirmation now quotes the first `BODY_PREVIEW_LINES` (40) of the body
  verbatim alongside the declared tools and the source, and says when it has
  truncated. The zip's own subdirectory is resolved through `assertInside`, so a
  `../` in an archive path cannot escape the extraction root.
- **Remove resolves through `resolveWorkspaceSkillDir`**, which is
  `assertInside(workspaceSkillsDir(), name)`. `/skill remove ../../..` gets a
  refusal, not a recursive delete.

### Tools (29 built-in)
Read, Write, Edit, MultiEdit, ApplyPatch, ReplaceFunction, Bash, Git, Glob, Grep, Ls, CodeIndex, WebSearch, WebFetch, ImageView, NotebookEdit, SaveLearning, SubAgent, CollectAgent, AskUser, IndexResearch, Mfl, ContractCreate, ContractAssertPass, ContractAssertFail, ContractStatus, load_tools, run_skill, list_skills

`load_tools`, `run_skill`, and `list_skills` are **load-on-demand**: extended tools are pulled in only when the model asks for them (or a skill declares them), keeping the default prompt lean while preserving the append-only prompt-cache prefix.

**On-demand loading.** Tools are split into a **core** set (offered to the model every turn) and an **extended** set (loaded on demand). When the model needs an extended tool it calls the `load_tools` meta-tool with the tool names; they are then callable for the rest of the session. This keeps the default prompt small without losing any capability. Set `LOCALCODE_ALL_TOOLS=true` to surface every tool up front and skip on-demand loading (best for cache-sensitive batch runs).

### Session Persistence
- **JSONL journaling** — every message saved, survives crashes
- **Handoff system** — goal, progress, learnings, next steps persist across sessions
- **Adaptive Working Memory (AWM)** — session learnings promoted into a durable ACE-style playbook only when the session can show it achieved something: every Definition-of-Done contract it opened resolved with no failed or unverified assertions, and at least one assertion passed. A session that opened no contract promotes nothing. The gate and its limits are in `engine/memory/promotionGate.ts` — assertions about files and commits are checked against the repository, but an engine-inferred contract can also pass an assertion on the model's own report, so this is a floor and not a proof. Promoted entries are recalled (capped ~5) at the start of later sessions
- **Compaction that keeps the goal** — at context overflow, recent user messages and the active Definition-of-Done contract are anchored verbatim through summarization (durable facts flushed first) so constraints aren't silently erased
- **Decision journals** — S1-S5 decisions logged as training data (JSONL)
- **Governance DB** — SQLite with session outcomes and per-turn measurements
- **Rule weights** — S5 rule effectiveness learned across sessions

---

## Fine-Tuned Models (Coming)

CynCo collects governance decision data during every session, per VSM system, in `~/.cynco/training/s{1-5}-decisions.jsonl` (`engine/training/decisionJournal.ts`). This data is the foundation for fine-tuned models that will replace the rule-based governance with learned governance:

### S5 Decision Model
The first fine-tuning target. Currently CynCo uses a rule-based S5 with 21 hand-coded rules. The decision journal collects every S5 decision with the full governance snapshot (context usage, tool success rate, variety balance, stuck turns, etc.).

**Status:** Not yet trainable. The label path now exists; the volume does not.

A journal line is `{ timestamp, sessionId, system, input, decision, outcome? }`. Until 2026-07-28 no S5 decision ever carried an `outcome`: the S5 writer omitted it (a policy decision has no result at the moment it is made), and `DecisionJournalWriter.backfill()` — which exists to patch one in afterwards — had a single call site, in `engine/agents/s2Coordinator.ts`, for S2. The only label was the one `engine/s5/exportTrainingData.ts` joined out of `governance.db` on `sessionId`: a *session*-level verdict stamped onto every decision the session made, enough to discard sessions that went badly but unable to tell two close calls inside one session apart.

Each S5 decision now carries three things it did not before:

- **`decisionId`** — a UUID, journaled inside the decision. The join key for the outcome. (The pre-existing `entryTimestamp` key cannot work here: `makeJournalEntry` reads the clock itself, so the writer never learns the line's timestamp.)
- **`ruleIds`** — which of the 21 rules fired.
- **`rejected`** — rules that fired and were *overridden* by `combineDecisions`. The merge is lossy on purpose (`model` takes the first non-null, `tools` intersects), and these losers are the only negative examples the rule engine produces. A rule returning `null` is not among them: its condition was simply false, so it proposed nothing.

`S5Orchestrator.evaluateLastDecision()` writes the per-decision outcome, keyed on `decisionId`, from the measured change in `stuckTurns` and `toolSuccessRate`. When governance reports neither number the outcome is **`unknown`**, and it is written as `unknown` — not defaulted into a verdict. The exporter drops decisions measured `negative` even inside a viable session, and keeps `unknown` ones, where the session label remains the only evidence there is.

The exporter strips `decisionId`, `ruleIds` and `rejected` from the training *target* — they are evidence about the decision, not part of it.

So "500+ decisions" understates the requirement: it means 500+ with per-decision outcomes, and the counter starts from the date above.

**Goal:** A small LoRA adapter (on Qwen3.6 or similar) that makes better governance decisions than the hand-coded rules — when to restrict tools, when to compact context, when to suggest model switches. The model sees the full governance state and outputs a coherent S5Decision.

### Tool Selection Model (S1)
4,000+ tool call records with success/failure outcomes. Could train a model that picks better tools for a given context than the current LLM prompt.

### Coordination Model (S2)
Agent scheduling decisions with GPU utilization, queue depth, and agent outcomes. Could train a model that schedules sub-agents more efficiently.

### Validation
Fine-tuned models will be validated against the rule-based system before deployment:
- A/B testing on real coding tasks (governance DB records both outcomes)
- Must match or exceed rule-based success rate before replacing it
- Ablation mode (`_ABLATION_VSM_DISABLED=1`) provides baseline comparison

Fine-tuned model adapters will be published on HuggingFace when validated.

---

## Configuration

Three layers, in order of precedence:

1. **Environment variables** — `LOCALCODE_*`, listed below. Highest priority.
2. **A YAML profile** — `.cynco/profiles/<name>.yaml` in the project, then
   `~/.cynco/profiles/<name>.yaml`, then the one that ships with the engine at
   `engine/profiles/templates/default.yaml`. `LOCALCODE_PROFILE` picks the name;
   unset means `default`. Profiles compose through `extends:`.
3. **Built-in defaults** — the fallbacks compiled into `engine/config.ts`.

Nothing has to be configured to start: with no environment and no profile of your
own, the shipped profile supplies the model and provider the Quick Start installs.
Setting a variable overrides the profile for that one field and nothing else.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_MODEL` | from profile (`qwen3.6`) | Model name. Not required — the profile supplies it. |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `LOCALCODE_PROVIDER` | from profile (`ollama`) | Provider: `ollama` or `llama-cpp`. With no profile at all the built-in fallback is `llama-cpp`, which needs `LOCALCODE_MODEL_PATH`. |
| `LOCALCODE_EMBED_MODEL` | `jina-code-embeddings-0.5b` | Model for code indexing (falls back to `nomic-embed-text`) |
| `LOCALCODE_TEMPERATURE` | `0.7` | Sampling temperature |
| `LOCALCODE_CONTEXT_LENGTH` | `131072` (llama-cpp), auto-detected on Ollama | Override context window. On the llama-cpp path a profile's `context_length` wins over this default; `LOCALCODE_CACHE_RAM` is derived from whichever value ends up in force. |
| `LOCALCODE_ALL_TOOLS` | `false` | Surface every tool up front instead of loading extended tools on demand via `load_tools` |
| `LOCALCODE_S5_PROACTIVE_TOOLS` | `false` | **Opt-in.** Let the S5 policy engine proactively pre-load task-relevant tools (e.g. surface `Bash`, `Grep`, `Read` for a debugging request) before the model asks. Append-only — never restricts. |
| `LOCALCODE_SEARXNG_URL` | — | SearXNG instance URL for research |
| `LOCALCODE_S5_MODEL` | — | Fine-tuned S5 model (when available) |
| `LOCALCODE_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address. `0.0.0.0` puts the session transcripts and the event stream on the network, behind nothing but the inference token — see [Local tokens](#local-tokens). |
| `LOCALCODE_BRIDGE_HOST` | `127.0.0.1` | TUI bridge bind address. `0.0.0.0` puts the agent's command channel on the network, behind nothing but the bridge token — see [Local tokens](#local-tokens). |
| `LOCALCODE_CACHE_RAM` | derived — `21504` at the default context | llama-server host prompt-cache RAM (MiB), a ceiling on **system** memory, not VRAM. Derived as `ctx-checkpoints × (149.65 MiB + 4.02 KiB × context)`, the measured cost of one checkpoint, so the budget always holds one complete conversation's checkpoints. The cache is required for context-checkpoint rollback on hybrid models (Qwen3.6/3.8) — don't set to `0`. Setting it explicitly overrides the derivation, which also means you own the F91 arithmetic. |
| `LOCALCODE_CTX_CHECKPOINTS` | `32` | Recurrent-state checkpoints for prefix-cache rollback on hybrid DeltaNet models. `64` killed llama-server with `bad allocation` against a fixed 8192 MiB cache (F91); `LOCALCODE_CACHE_RAM` is now derived from this value, so raising it raises the budget with it — unless you pin `LOCALCODE_CACHE_RAM` too, which re-creates F91 by hand. |
| `LOCALCODE_CHECKPOINT_MIN_STEP` | `256` | Minimum token spacing between checkpoints. |
| `LOCALCODE_UBATCH_SIZE` | `2048` | llama-server physical prefill batch size. |
| `LOCALCODE_REASONING_BUDGET` | `256` | llama-server reasoning token budget. >256 hurts tool-call accuracy; uncapped thinking wastes minutes. Raise if your model needs more deliberation. |

### Full inventory

That table is a shortlist. The engine reads considerably more than it, and the
complete list is generated from the source rather than written by hand:

<!-- BEGIN GENERATED ENV INVENTORY -->

<!-- Generated by scripts/generate-env-docs.mjs. Do not edit by hand.
     Regenerate with: bun scripts/generate-env-docs.mjs -->

Every `LOCALCODE_*` variable the engine reads — 68 of them — with the fallback
each read site uses when it is unset, and the profile key (if any) that sits between the
two. Read out of the source by `scripts/generate-env-docs.mjs`, so it cannot drift from
the code the way a hand-written list does.

`*not derived*` is a statement about the generator, not about the engine: the read site
resolves in a shape the scanner does not recognise, so no default is claimed for it. Two
values separated by `/` mean two read sites disagree.

| Variable | Default when unset | Profile key | Read in |
|----------|--------------------|-------------|---------|
| `LOCALCODE_ADAPTER_URL` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_ADVISORS` | `false` | — | `engine/bridge/conversationLoop.ts` |
| `LOCALCODE_ALL_TOOLS` | `false` | — | `engine/config.ts` |
| `LOCALCODE_API_KEY` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_APPROVE_ALL` | `false` | — | `engine/config.ts` |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | `base_url` | `engine/config.ts`, `engine/engine/callModel.ts` |
| `LOCALCODE_BATCH_SIZE` | `2048` | — | `engine/config.ts` |
| `LOCALCODE_BEST_OF_N` | `false` | — | `engine/bridge/conversationLoop.ts`, `engine/dashboard/server.ts` |
| `LOCALCODE_BEST_OF_N_COUNT` | `2` | — | `engine/bridge/conversationLoop.ts`, `engine/dashboard/server.ts` |
| `LOCALCODE_BEST_OF_N_TEMP` | `0.8` | — | `engine/bridge/conversationLoop.ts` |
| `LOCALCODE_BEST_OF_N_TURN_CAP` | `15` | — | `engine/bridge/conversationLoop.ts`, `engine/dashboard/server.ts` |
| `LOCALCODE_BRAIN_LAYER` | `40` | — | `engine/main.ts` |
| `LOCALCODE_BRIDGE_HOST` | `127.0.0.1` | — | `engine/bridge/server.ts` |
| `LOCALCODE_CACHE_RAM` | *not derived* | — | `engine/llama/processManager.ts` |
| `LOCALCODE_CHECKPOINT_MIN_STEP` | `256` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_CONTEXT_LENGTH` | *not derived* | — | `engine/bootstrapProvider.ts`, `engine/config.ts` |
| `LOCALCODE_CTX_CHECKPOINTS` | `32` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_DASHBOARD_HOST` | `127.0.0.1` | — | `engine/dashboard/server.ts` |
| `LOCALCODE_EMBED_API` | *not derived* | — | `engine/index/embedClient.ts` |
| `LOCALCODE_EMBED_BASE_URL` | `http://localhost:11434` | — | `engine/bridge/conversationLoop.ts`, `engine/index/embedClient.ts` |
| `LOCALCODE_EMBED_MODEL` | *not derived* | — | `engine/index/embedClient.ts` |
| `LOCALCODE_EXPERTISE` | `advanced` | `expertise` | `engine/config.ts` |
| `LOCALCODE_FLASH_ATTN` | `true` | — | `engine/config.ts` |
| `LOCALCODE_GPU_LAYERS` | `999` | — | `engine/config.ts` |
| `LOCALCODE_GRAMMAR_ENABLED` | `false` | — | `engine/dashboard/server.ts`, `engine/engine/callModel.ts` |
| `LOCALCODE_HYBRID_SEARCH` | `true` | — | `engine/bridge/conversationLoop.ts`, `engine/index/indexer.ts` |
| `LOCALCODE_IMMUTABLE_PATHS` | *not derived* | — | `engine/tools/executor.ts` |
| `LOCALCODE_JLENS_URL` | `http://127.0.0.1:9163` | — | `engine/brain/jlensClient.ts` |
| `LOCALCODE_LEARNINGS_DB` | *not derived* | — | `engine/bridge/conversationLoop.ts`, `engine/main.ts`, `engine/tools/impl/saveLearning.ts` |
| `LOCALCODE_LLAMA_HEALTH_TIMEOUT_MS` | *not derived* | — | `engine/llama/processManager.ts` |
| `LOCALCODE_LLAMA_SERVER` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_MAX_ITERATIONS` | *not derived* | — | `engine/bridge/conversationLoop.ts` |
| `LOCALCODE_MAX_OUTPUT_TOKENS` | `16384` | `max_output_tokens` | `engine/config.ts` |
| `LOCALCODE_MODEL` | *not derived* | `model` | `engine/config.ts` |
| `LOCALCODE_MODEL_PATH` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_NATIVE_TOOLS` | `false` | — | `engine/engine/callModel.ts` |
| `LOCALCODE_NO_SCOUTS` | `false` | — | `engine/config.ts` |
| `LOCALCODE_OPTIMIZED_PARAMS` | *not derived* | — | `engine/vsm/cyberneticsGovernance.ts` |
| `LOCALCODE_PORT` | `8081` | — | `engine/config.ts` |
| `LOCALCODE_PROFILE` | *not derived* | — | `engine/config.ts`, `engine/main.ts` |
| `LOCALCODE_PROVIDER` | `llama-cpp` | `provider` | `engine/config.ts` |
| `LOCALCODE_REASONING_BUDGET` | `256` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_RECALL_EMBED_TIMEOUT_MS` | `4000` | — | `engine/index/embedClient.ts` |
| `LOCALCODE_RECALL_HALFLIFE_HOURS` | `72` | — | `engine/memory/learningStore.ts` |
| `LOCALCODE_RECALL_PROMOTED_BONUS` | `0.15` | — | `engine/memory/learningStore.ts` |
| `LOCALCODE_RECALL_W_IMPORTANCE` | `0.25` | — | `engine/memory/learningStore.ts` |
| `LOCALCODE_RECALL_W_RECENCY` | `0.25` | — | `engine/memory/learningStore.ts` |
| `LOCALCODE_RECALL_W_RELEVANCE` | `0.5` | — | `engine/memory/learningStore.ts` |
| `LOCALCODE_REFLEXION` | `true` | — | `engine/vsm/reflexionFeedback.ts` |
| `LOCALCODE_REPO_MAP` | `true` | — | `engine/bridge/conversationLoop.ts` |
| `LOCALCODE_S5_ENFORCE` | `true` | — | `engine/config.ts` |
| `LOCALCODE_S5_MODEL` | *not derived* | — | `engine/daemon/oneShot.ts`, `engine/main.ts` |
| `LOCALCODE_S5_PROACTIVE_TOOLS` | `false` | — | `engine/config.ts` |
| `LOCALCODE_SEARXNG_URL` | *not derived* | — | `engine/research/engines/searxng.ts` |
| `LOCALCODE_SESSION_ID` | *not derived* | — | `engine/bridge/conversationLoop.ts`, `engine/s5/orchestrator.ts`, `engine/tools/impl/saveLearning.ts` |
| `LOCALCODE_SIMULATED_TOOLS` | `false` | — | `engine/engine/callModel.ts` |
| `LOCALCODE_SPEC_DRAFT_N` | *not derived* | — | `engine/bootstrapProvider.ts` |
| `LOCALCODE_SPEC_TYPE` | *not derived* | — | `engine/bootstrapProvider.ts`, `engine/main.ts` |
| `LOCALCODE_TDD_GOV` | `false` | — | `engine/bridge/conversationLoop.ts` |
| `LOCALCODE_TEMPERATURE` | `0.7` | `temperature` | `engine/config.ts` |
| `LOCALCODE_THREADS` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_TIER` | *not derived* | `tier` | `engine/config.ts` |
| `LOCALCODE_TIMEOUT` | `300000` | `timeout` | `engine/config.ts` |
| `LOCALCODE_TOOL_TEMPERATURE` | *not derived* | — | `engine/engine/callModel.ts` |
| `LOCALCODE_TRAJECTORY_ENABLED` | `true` | — | `engine/dashboard/server.ts`, `engine/main.ts` |
| `LOCALCODE_UBATCH_SIZE` | `2048` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_VARIETY_CONTROL` | `true` | — | `engine/bridge/conversationLoop.ts`, `engine/dashboard/server.ts` |
| `LOCALCODE_WS_PORT` | `9160` | — | `engine/main.ts` |

<!-- END GENERATED ENV INVENTORY -->

---

## Why?

In 1971, Stafford Beer designed a cybernetic system for real-time economic coordination in Chile — [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn). The project was ahead of its time: distributed sensing, algedonic alerts, variety management. The political context ended it, but the ideas didn't die.

Every major AI coding tool today sends your code to someone else's servers. You pay per token for the privilege of using your own data. One policy change and your tools disappear.

CynCo runs on your GPU. Your code never leaves your machine. The governance system — variety engines, algedonic signals, homeostatic balance, autopoietic strategy evolution — is Beer's mathematics, implemented and enforced in code. Not a metaphor. Not advisory. Real feedback control.

One GPU. Zero API costs. Yours to keep.

---

## Credits

- **Stafford Beer** — Viable System Model, the foundation of CynCo's governance
- **Salvador Allende & Fernando Flores** — Project Cybersyn, the original vision for cybernetic governance
- **Ross Ashby** — Law of Requisite Variety, used in variety regulation
- **Humberto Maturana & Francisco Varela** — autopoiesis, used in self-modification governance
- **W. Ross McCulloch** — heterarchy, used in dynamic authority selection
- [Ollama](https://ollama.com) — local LLM runtime (MIT)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — GGUF inference engine (MIT)
- [Textual](https://textual.textualize.io) — Python TUI framework (MIT)
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — vector search for SQLite (Apache 2.0)

## License

[AGPL-3.0](LICENSE) — Use it, modify it, distribute it. But if you build a service with it, you must open source your changes. That's the point.
