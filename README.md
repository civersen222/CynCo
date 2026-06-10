# CynCo — Cybernetic Collaborator

**AI coding assistant that runs entirely on your GPU. Zero API costs. Your data never leaves your machine.**

Inspired by Stafford Beer's Viable System Model and Salvador Allende's [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn) (Chile, 1971-73). AI that belongs to the person running it.

---

## What Is This?

CynCo is a terminal-based AI coding assistant powered by local LLMs via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp). It can:

- **Edit files, run commands, search code** — full tool-calling loop on your hardware
- **Build entire projects from a description** — guided Vibe mode asks smart questions, then builds autonomously
- **Self-govern with enforced cybernetics** — S5 policy engine with 21 rules, 4-tier stuck loop escape, live governance signals injected every iteration
- **Monitor governance in real-time** — browser dashboard on port 9161 shows tool activity, contracts, predictions, training data progress, and variety control
- **Constrained decoding** — GBNF grammar enforcement on llama.cpp, post-validation on all providers. No more silent tool-call drops
- **Best-of-N sampling** — run multiple candidates in git worktrees, select by test pass rate
- **Tree-sitter code indexing** — AST-aware chunking with BM25 + vector hybrid search and PageRank repo map
- **Self-improving training loop** — trajectory recorder collects per-turn data, reward labeler scores outcomes, Unsloth SFT pipeline exports ChatML datasets
- **Research from multiple sources** — DuckDuckGo, arXiv, Wikipedia, GitHub, PubMed, HuggingFace with intelligent query routing
- **Spawn parallel sub-agents** — 6 typed personas (scout/oracle/kraken/spark/architect/researcher) with GPU-aware scheduling
- **Index your codebase semantically** — vector + BM25 hybrid search finds relevant code instantly
- **Persist across sessions** — handoff files, decision journals, governance DB, rule weight learning, and trajectory data for training

---

## Recommended Models

CynCo works best with models that support native tool calling. Here are the tested and recommended models:

### Primary (your main coding model)

| Model | Type | VRAM (Q4) | Speed (RTX 5090) | SWE-bench | Notes |
|-------|------|-----------|-------------------|-----------|-------|
| **Qwen3.6-35B-A3B** | MoE | ~20 GB | ~234 tok/s | 73.4% | **Best choice for 32GB GPUs.** Only 3B active params = fast. Native tool use. Apache 2.0. |
| Gemma4-31B | Dense | ~19 GB | ~52 tok/s | ~65% | Good alternative. Slower (dense). Native tool use. |
| Devstral-Small-2-24B | Dense | ~15 GB | ~70 tok/s | Good | Strong for agentic multi-file edits. Fits 16GB GPUs. |
| Qwen3.6-27B | Dense | ~17 GB | ~65 tok/s | 77.2% | Best dense model. Good cascade secondary on a 16GB GPU. |

### Quantization

Use **Q4_K_M** for the best speed/quality balance. For coding, Q4 quality loss is minimal and speed gain is significant:

| Quantization | Size (35B MoE) | Speed | Quality | When to Use |
|-------------|---------------|-------|---------|-------------|
| Q6_K | ~27 GB | Fast | Near-lossless | When you have VRAM headroom and want max quality |
| **Q4_K_M** | ~20 GB | Fastest | Good | Default recommendation. Best speed/quality trade-off |
| Q3_K_M | ~16 GB | Fast | Noticeable loss | Only if you can't fit Q4 |

### Embedding Model

Pull `nomic-embed-text` for semantic code indexing. This runs alongside your main model:

```bash
ollama pull nomic-embed-text
```

### Cascade (Optional)

If you have a second GPU on the network, run a smaller model (Devstral-Small-2 or Qwen3.6-27B) as a cascade secondary. CynCo's S2 coordinator routes simple tasks to the fast model and complex tasks to your primary.

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
ollama pull nomic-embed-text

# Launch
cd tui && python -m localcode_tui.app
```

That's it. No API keys. No subscriptions. No data leaving your machine.

### Alternative: llama.cpp Direct Provider with MTP Speculative Decoding

CynCo can drive llama-server directly with Multi-Token Prediction for ~100 tok/s generation (vs ~12 tok/s on Ollama):

```bash
LOCALCODE_PROVIDER=llama-cpp \
  LOCALCODE_MODEL_PATH=~/.cynco/models/qwen3.6-mtp/Qwen3.6-27B-Q6_K.gguf \
  LOCALCODE_SPEC_TYPE=draft-mtp \
  LOCALCODE_SPEC_DRAFT_N=3 \
  LOCALCODE_CONTEXT_LENGTH=65536 \
  bun engine/main.ts
```

The engine auto-manages llama-server with: single-slot mode, disabled prompt cache (SWA models invalidate it), capped reasoning budget (256 tokens), and accurate tok/s from server eval timing. Side queries route through the same llama-server instance to avoid VRAM thrashing.

---

## Hardware Expectations

| VRAM | Recommended Model | Experience |
|------|------------------|------------|
| 8-12 GB | Devstral-Small-2 Q4 | Solid tool calling, single-file tasks |
| 16 GB | Qwen3.6-27B Q4 or Devstral-Small-2 Q6 | Multi-file projects, sub-agents |
| 24 GB | Qwen3.6-35B-A3B Q4 | Full feature set, parallel agents |
| **32 GB** | **Qwen3.6-35B-A3B Q4 + large context** | **Optimal. Room for 32K context + agents.** |
| 32+16 GB (dual) | Primary + cascade secondary | Complex tasks on primary, simple on secondary |

Smaller models (<7B) struggle with the tool-calling format. 24B+ recommended for real work.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  S5 Policy Engine (21 rules, 3 tiers, enforced)              │
│  Critical: auto-enforce | Warning: TUI | Info: journal       │
└──────────────────────────┬───────────────────────────────────┘
                           │ enforces
┌──────────────────────────┴───────┐   WS   ┌─────────────────┐
│  TypeScript Engine (Bun)         │◄──────►│  Python TUI     │
│                                  │  9160  │  (Textual)      │
│  Conversation Loop               │        │                 │
│  ├── Tool Executor (24 tools)    │        │  Workspace      │
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
│  http://localhost:9161           │   ← browser
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
Not advisory — **enforced**. S5 is the single policy enforcer with 21 tiered rules:

**Critical (auto-enforce, no user approval):**
- Kill switch on 5+ consecutive tool failures
- Tool exclusion when specific tool fails 3+ times
- Context overflow compaction at 90% utilization
- Doom loop breaking (3+ identical failing calls)
- Variety critical tool restriction to top-5 by success rate
- **Stuck loop escape** — restricts to unused tools when stuck 5+ turns, regardless of tool success rate

**Stuck Loop Escalation (4 tiers):**
1. **Turn 3+** — governance signal injected into system prompt: "change your approach"
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
Open `http://localhost:9161` during any session. Four tabs:

**[Chat]** — Send prompts directly from the browser. Full tool output with expandable details, visible thinking tokens, streaming model text. Slash commands (`/plan`, `/tdd`, `/debug`) for workflows. Enter to send, Shift+Enter for newlines.

**[Governance]** — Real-time VSM monitoring:
- **Tool Activity** — stacked bar chart + live feed with latency
- **Governance Health** — S3/S4 balance, variety ratio, stuck turns, algedonic alerts
- **Prediction Tracker** — 8 redesigned hypotheses measuring governance effectiveness (H1: Stuck Escape, H2: Nudge Response), model predictability (H4: Read-to-Edit, H5: Thinking Efficiency), and parameter tuning (H6: Temperature Effect, H7: S4 Reflection ROI)
- **Active Contract** — assertion status with pass/fail/pending
- **S5 Decision Log** — live policy decisions with reasoning
- **tok/s** — real-time inference speed from llama-server eval timing

**[History]** — Session analytics with per-session metrics charts (tool success, stuck turns, context utilization over time), session transcript viewer, and session selector.

**[Config]** — Temperature, context length, timeout sliders. System control toggles. All 21 VSM governance parameters with sliders and bounds.

Survives page reload, auto-detects active sessions, auto-reconnects on disconnect. Polls governance every 3s and training data every 30s.

### Semantic Code Index
Automatic vector indexing via `nomic-embed-text`. The model starts each task knowing your codebase — function signatures, class definitions, imports. Falls back to keyword search if embedding model unavailable.

### Workflows
Structured multi-phase workflows with tool restrictions and advancement gates:
- `/research` — multi-source research with citations
- `/tdd` — test-driven development (red-green-refactor)
- `/debug` — systematic problem diagnosis
- `/review` — structured code review
- `/plan` — implementation planning
- `/brainstorm` — idea exploration
- `/critique` — critical analysis

### Tools (24 built-in)
Read, Write, Edit, MultiEdit, ApplyPatch, ReplaceFunction, Bash, Git, Glob, Grep, Ls, CodeIndex, WebSearch, WebFetch, ImageView, NotebookEdit, SaveLearning, SubAgent, CollectAgent, IndexResearch, ContractCreate, ContractAssertPass, ContractAssertFail, ContractStatus

### Session Persistence
- **JSONL journaling** — every message saved, survives crashes
- **Handoff system** — goal, progress, learnings, next steps persist across sessions
- **Decision journals** — S1-S5 decisions logged as training data (JSONL)
- **Governance DB** — SQLite with session outcomes and per-turn measurements
- **Rule weights** — S5 rule effectiveness learned across sessions

---

## Fine-Tuned Models (Coming)

CynCo collects governance decision data during every session — (input, decision, outcome) triples for each of its S1-S5 systems. This data is the foundation for fine-tuned models that will replace the rule-based governance with learned governance:

### S5 Decision Model
The first fine-tuning target. Currently CynCo uses a rule-based S5 with 20 hand-coded rules. The decision journal collects every S5 decision with the full governance snapshot (context usage, tool success rate, variety balance, stuck turns, etc.) and the outcome (did the decision help?).

**Status:** Collecting training data. Need 500+ decisions with backfilled outcomes before LoRA fine-tuning is viable. The journal format is locked: `{ input: S5Input, decision: S5Decision, outcome: OutcomeScore }`.

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

All config via environment variables. No config files required.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_MODEL` | *required* | Model name (e.g., `qwen3.6`) |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `LOCALCODE_PROVIDER` | `ollama` | Provider: `ollama` or `llama-cpp` |
| `LOCALCODE_EMBED_MODEL` | `nomic-embed-text` | Model for code indexing |
| `LOCALCODE_TEMPERATURE` | `0.7` | Sampling temperature |
| `LOCALCODE_CONTEXT_LENGTH` | Auto-detected | Override context window |
| `LOCALCODE_SEARXNG_URL` | — | SearXNG instance URL for research |
| `LOCALCODE_S5_MODEL` | — | Fine-tuned S5 model (when available) |
| `LOCALCODE_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address (set to `0.0.0.0` to expose on network) |
| `LOCALCODE_CACHE_RAM` | `0` | llama-server KV cache RAM (MB). Default 0 is optimal for Qwen3.6 SWA (cache invalidated every call). Set to `2048` for non-SWA models (Llama/Mistral/Phi) to enable KV prefix reuse. |
| `LOCALCODE_REASONING_BUDGET` | `256` | llama-server reasoning token budget. >256 hurts tool-call accuracy; uncapped thinking wastes minutes. Raise if your model needs more deliberation. |

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
