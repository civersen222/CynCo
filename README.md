# CynCo — Cybernetic Collaborator

**AI coding assistant that runs entirely on your GPU. Zero API costs. Your data never leaves your machine.**

Inspired by Stafford Beer's Viable System Model and Salvador Allende's [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn) (Chile, 1971-73). Technology built for the people, not corporations.

---

## What Is This?

CynCo is a terminal-based AI coding assistant powered by local LLMs via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp). It can:

- **Edit files, run commands, search code** — full tool-calling loop on your hardware
- **Build entire projects from a description** — guided Vibe mode asks smart questions, then builds autonomously
- **Self-govern with enforced cybernetics** — S5 policy engine hard-filters tools, kills stuck agents, and learns across sessions
- **Research from multiple sources** — DuckDuckGo, arXiv, Wikipedia, GitHub, PubMed, HuggingFace with intelligent query routing
- **Spawn parallel sub-agents** — 6 typed personas (scout/oracle/kraken/spark/architect/researcher) with GPU-aware scheduling
- **Index your codebase semantically** — vector search finds relevant code instantly
- **Persist across sessions** — handoff files, decision journals, governance DB, and rule weight learning

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

### Alternative: llama.cpp Direct Provider

CynCo can also drive llama-server directly for faster inference (15.6 tok/s vs 3.3 with Ollama on some models):

```bash
LOCALCODE_MODEL=qwen3.6 LOCALCODE_PROVIDER=llama-cpp bun engine/main.ts
```

The engine auto-downloads llama-server and manages the process.

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
                     ┌──────────────────────────────────────────────────────────┐
                     │  S5 Policy Engine (20 rules, 3 tiers)                   │
                     │  Critical: auto-enforce | Warning: TUI prompt | Info: log│
                     └────────────────────┬─────────────────────────────────────┘
                                          │ enforces
┌─────────────────────────────┐     WebSocket     ┌─────────────────────┐
│  TypeScript Engine (Bun)    │◄─────────────────►│  Python TUI         │
│                             │    port 9160      │  (Textual)          │
│  engine/main.ts             │                   │                     │
│  ├── conversation loop      │  stream.token     │  tui/app.py         │
│  ├── tool executor (19)     │  tool.start/done  │  ├── workspace      │
│  ├── S5 governance (enforced)│ file.change      │  ├── vibe loop      │
│  ├── S2 agent coordinator   │  governance.*     │  ├── project wizard │
│  ├── 6 search engines       │  subagent.*       │  └── context sidebar│
│  ├── semantic index          │  workflow.*       │                     │
│  └── Ollama / llama.cpp     │  s2.decision      │                     │
└─────────────────────────────┘                   └─────────────────────┘
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
Not advisory — **enforced**. S5 is the single policy enforcer with 20 tiered rules:

**Critical (auto-enforce, no user approval):**
- Kill switch on 5+ consecutive tool failures
- Tool exclusion when specific tool fails 3+ times
- Context overflow compaction at 90% utilization
- Doom loop breaking (3+ identical failing calls)
- Variety critical tool restriction to top-5 by success rate

**Warning (surfaced to TUI for accept/dismiss):**
- Model switch recommendation on rising latency
- Workspace revert on 5+ stuck turns with <50% tool success
- Drift-based compaction and tool restriction
- Homeostatic instability rebalancing
- S3/S4 imbalance correction

**Info (logged for training):**
- Variety balance shifts, homeostatic adjustments, performance metrics

Rule weights adjust across sessions based on outcomes — positive outcomes strengthen rules, user dismissals weaken them.

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

### Tools (19 built-in)
Read, Write, Edit, MultiEdit, ApplyPatch, Bash, Git, Glob, Grep, Ls, CodeIndex, WebSearch, WebFetch, ImageView, NotebookEdit, SaveLearning, SubAgent, CollectAgent, IndexResearch

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

---

## Why?

In 1971, Salvador Allende and Stafford Beer tried to build a cybernetic system that would give workers real-time control of Chile's economy. It was called [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn). The CIA helped destroy it in 1973.

The core idea survived: technology should serve the people who use it, not extract value from them. Every major AI coding tool today requires sending your code to someone else's servers and paying them for the privilege.

CynCo runs on your hardware. Your code stays on your machine. The cybernetic governance system — variety engines, algedonic signals, homeostatic balance, autopoietic strategy evolution — comes directly from Beer's work. It's not a metaphor. It's the actual math, enforced in code.

One GPU. Zero API costs. Nobody can shut it down.

---

## Credits

- **Stafford Beer** — Viable System Model, the foundation of CynCo's governance
- **Salvador Allende** — proved cybernetics could serve the people
- **Ross Ashby** — Law of Requisite Variety, used in variety regulation
- **Humberto Maturana & Francisco Varela** — autopoiesis, used in self-modification governance
- **W. Ross McCulloch** — heterarchy, used in dynamic authority selection
- [Ollama](https://ollama.com) — local LLM runtime (MIT)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — GGUF inference engine (MIT)
- [Textual](https://textual.textualize.io) — Python TUI framework (MIT)
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — vector search for SQLite (Apache 2.0)

## License

[AGPL-3.0](LICENSE) — Use it, modify it, distribute it. But if you build a service with it, you must open source your changes. That's the point.
