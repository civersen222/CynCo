# CynCo — Cybernetic Collaborator

**AI coding assistant that runs entirely on your GPU. Zero API costs. Your data never leaves your machine.**

Inspired by Stafford Beer's Viable System Model and Salvador Allende's [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn) (Chile, 1971-73). Technology built for the people, not corporations.

---

## What Is This?

CynCo is a terminal-based AI coding assistant powered by local LLMs via [Ollama](https://ollama.com). It can:

- **Edit files, run commands, search code** — full tool-calling loop on your hardware
- **Build entire projects from a description** — guided `/project` mode asks smart questions, then builds autonomously
- **Self-govern with cybernetics** — a Viable System Model monitors performance, detects stuck states, and adapts strategy
- **Index your codebase semantically** — vector search finds relevant code instantly instead of blind file reading
- **Persist across sessions** — state files, decision locking, and JSONL journaling survive crashes

Describe what you want to build. CynCo asks clarifying questions, creates an implementation plan, then codes autonomously — reading files, writing code, running tests, fixing its own errors. All on your GPU. Zero API costs.

## Quick Start

### Prerequisites
- [Ollama](https://ollama.com) running locally
- [Bun](https://bun.sh) runtime
- Python 3.10+

### Install & Run

```bash
# Clone
git clone https://github.com/civersen222/CynCo.git
cd CynCo

# Pull a model
ollama pull qwen3:8b

# Install Python dependencies (use a venv on modern distros)
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
cd tui && pip install -e . && cd ..

# (Optional) Pull embedding model for semantic code search
ollama pull nomic-embed-text

# Launch
cd tui && python -m localcode_tui.app
```

That's it. No API keys. No subscriptions. No data leaving your machine.

## Hardware Expectations

CynCo runs on your local GPU via Ollama. Performance scales with model size and hardware:

| VRAM | Recommended Model | Speed |
|------|------------------|-------|
| 4-6 GB | qwen2.5-coder:7b | ~15 tok/s, basic tool calling |
| 8-12 GB | qwen3:8b, devstral-small | ~25 tok/s, reliable tool use |
| 16-24 GB | qwen3:32b, qwen2.5-coder:32b | ~10 tok/s, complex projects |
| 32+ GB | gemma4:31b, llama4 | Best quality, slower |
| CPU only | qwen2.5:0.5b | ~2 tok/s, very limited |

Smaller models (<7B) struggle with the tool-calling format. 8B+ recommended for real work. The semantic index adds ~5 seconds at startup (one-time embedding via nomic-embed-text).

## Architecture

```
┌─────────────────────────────┐     WebSocket     ┌─────────────────────┐
│  TypeScript Engine (Bun)    │◄─────────────────►│  Python TUI         │
│                             │    port 9160      │  (Textual)          │
│  engine/main.ts             │                   │                     │
│  ├── conversation loop      │  stream.token     │  tui/app.py         │
│  ├── tool executor (18)     │  tool.start       │  ├── workspace      │
│  ├── VSM governance         │  tool.complete    │  ├── vibe loop      │
│  ├── semantic index         │  approval.request │  ├── project wizard │
│  └── Ollama client          │  vibe.* events    │  └── context sidebar│
│       ↓ HTTP                │                   │                     │
│  Ollama /v1/chat/completions│                   │                     │
└─────────────────────────────┘                   └─────────────────────┘
```

## Features

### Workspace Mode
Type naturally. CynCo calls tools autonomously — reads files, edits code, runs commands, searches the codebase. But local — your GPU, your data.

### Project Mode (`/project`)
Guided building for non-engineers:
1. **Understand** — asks difficulty-based questions about what you want
2. **Build** — works autonomously, shows real-time tool progress
3. **Report** — explains what it built in plain language
4. **Next** — suggests the logical next step

### Semantic Code Index
Every project is automatically indexed using vector embeddings (Ollama + sqlite-vec). The model starts each task already knowing your codebase — no more blind file reading.

### VSM Governance (Experimental)
A Viable System Model from cybernetics monitors the AI in real-time. This is active research — some subsystems are fully wired, others are computed but not yet enforced:
- **Wired:** Strategy injection into prompts, governance signal injection (variety, stuck detection, stability), algedonic kill switch (circuit breaker after consecutive failures), context pressure warnings at 65%/80%
- **Computed but logged only:** S5 tool restrictions and heterarchy-based tool gating are computed but not enforced (restricting tools mid-session caused model failures)
- **Session-end evaluation:** Autopoietic strategy evolution records session outcomes and rewrites strategy for next session

### Tools (17 built-in)
Read, Write, Edit, MultiEdit, Bash, Glob, Grep, Git, CodeSearch, **CodeIndex**, WebFetch, WebSearch, ImageView, Ls, ApplyPatch, NotebookEdit, SaveLearning

### Session Persistence
- **JSONL journaling** — every message saved, survives crashes
- **STATE.md** — project state persists across sessions
- **Decision locking** — Q&A answers get D-XX IDs, enforced in builds
- **Plan files** — `.localcode-plan.md` tracks all design decisions

## Configuration

All config via environment variables. No config files required.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_MODEL` | *required* | Ollama model (e.g., `qwen3:8b`) |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `LOCALCODE_EMBED_MODEL` | `nomic-embed-text` | Model for code indexing |
| `LOCALCODE_TEMPERATURE` | `0.7` | Sampling temperature |
| `LOCALCODE_CONTEXT_LENGTH` | Auto-detected | Override context window |

## Why?

In 1971, Salvador Allende and Stafford Beer tried to build a cybernetic system that would give workers real-time control of Chile's economy. It was called [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn). The CIA helped destroy it in 1973.

The core idea survived: technology should serve the people who use it, not extract value from them. Every major AI coding tool today requires sending your code to someone else's servers and paying them for the privilege.

CynCo runs on your hardware. Your code stays on your machine. The cybernetic governance system — variety engines, algedonic signals, autopoietic strategy evolution — comes directly from Beer's work. It's not a metaphor. It's the actual math.

One GPU. Zero API costs. Nobody can shut it down.

## Credits

- **Stafford Beer** — Viable System Model, the foundation of CynCo's governance
- **Salvador Allende** — proved cybernetics could serve the people
- **Ross Ashby** — Law of Requisite Variety, used in tool diversity monitoring
- [Ollama](https://ollama.com) — local LLM runtime (MIT)
- [Textual](https://textual.textualize.io) — Python TUI framework (MIT)
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — vector search for SQLite (Apache 2.0)
- Architectural patterns informed by [pi-mono](https://github.com/badlogic/pi-mono) and [GSD](https://github.com/gsd-build/get-shit-done)

## License

[AGPL-3.0](LICENSE) — Use it, modify it, distribute it. But if you build a service with it, you must open source your changes. Corporations can't take this and close-source it. That's the point.
