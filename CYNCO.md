# CYNCO.md

CynCo's own conventions for this repository. Anything working in this tree — CynCo itself,
or a human, or another agent — is bound by the rules below. Guards under
`engine/__tests__/guards/` enforce the ones marked BLOCKING.

## Project Overview

**CynCo** is a local AI coding assistant that runs entirely on local LLMs via [Ollama](https://ollama.com). It provides a terminal-based AI coding assistant — file editing, bash execution, code search, git operations, sub-agents — without sending any data to external APIs.

Inspired by Stafford Beer's Viable System Model and Salvador Allende's Project Cybersyn (Chile, 1971-73). AI coding for the people, on their own hardware.

**Key technologies:** TypeScript (Bun runtime), Python (Textual TUI), Ollama (local model backend), WebSocket (engine ↔ TUI bridge).

The TypeScript engine lives in `engine/`. The Python TUI lives in `tui/`.

## Running and Testing

```bash
# --- Launch CynCo ---
cd tui && python -m localcode_tui.app        # Launches TUI + engine

# --- Engine only (headless WebSocket server) ---
LOCALCODE_MODEL=qwen3:8b bun engine/main.ts

# --- Tests ---
cd tui && python -m pytest tests/            # TUI tests (284)
```

## Architecture

### Two-Process Architecture

```
┌─────────────────────────────────┐     WebSocket      ┌──────────────────────┐
│  TypeScript Engine              │◄───────────────────►│  Python TUI          │
│  (Bun runtime)                  │     port 9160       │  (Textual framework) │
│                                 │                     │                      │
│  engine/main.ts (entry)         │  ──── Protocol ──── │  tui/app.py          │
│  engine/bridge/server.ts        │  stream.token       │  tui/bridge.py       │
│  engine/bridge/                 │  tool.start/complete│  tui/screens/        │
│    conversationLoop.ts          │  approval.request   │  tui/widgets/        │
│  engine/engine/callModel.ts     │  context.status     │                      │
│  engine/ollama/client.ts        │  user.message       │                      │
│       ↓ HTTP                    │  command             │                      │
│  Ollama /v1/chat/completions    │                     │                      │
└─────────────────────────────────┘                     └──────────────────────┘
```

### Key Directories

```
engine/
├── engine/        # Core: callModel, streamTranslator, messageConvert, systemPrompt
├── ollama/        # Ollama: client (HTTP), probe (tier), format, simulated
├── bridge/        # WebSocket server + conversation loop for TUI
├── memory/        # Session continuity: ledger, lifecycle, handoff, recall
├── profiles/      # YAML profile loading, validation, inheritance
├── agents/        # Sub-agents, S2 coordinator, vocabulary routing, PRISM
├── hooks/         # Context management hooks (contextCheck)
├── tools/         # Tool registry, executor, implementations
├── index/         # Semantic code index: embedClient, chunker, store, indexer
├── vibe/          # Vibe loop: engine, controller, confidence, types
├── vsm/           # VSM governance: cybernetics, heterarchy, algedonic, S4 reflector
├── s5/            # S5 decision orchestrator
├── context/       # Context compressor with file operation tracking
├── session/       # JSONL session persistence
├── prompts/       # Prompt template loader
├── snapshot/      # Git-based workspace snapshots
├── config.ts      # isLocalMode() + env/profile config loader
├── provider.ts    # Provider interface definition
├── types.ts       # Internal types
└── main.ts        # Entry point (WebSocket server)

tui/
├── localcode_tui/
│   ├── app.py         # Textual application + event routing
│   ├── bridge.py      # WebSocket client to engine
│   ├── config.py      # YAML profile loading (Python side)
│   ├── protocol.py    # Protocol types (mirrors bridge/protocol.ts)
│   ├── screens/       # workspace, guided, vibe_loop, project_wizard, etc.
│   ├── widgets/       # chat_panel, context_sidebar, worker_animation, etc.
│   └── styles/        # Textual CSS themes
└── tests/             # TUI tests
```

## Configuration

All config uses `LOCALCODE_*` environment variables. No API key needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_MODEL` | *required* | Ollama model name (e.g., `qwen3:8b`) |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `LOCALCODE_PROFILE` | — | YAML profile name |
| `LOCALCODE_TIER` | `auto` | Force tier: basic/standard/advanced |
| `LOCALCODE_TEMPERATURE` | `0.7` | Sampling temperature |
| `LOCALCODE_TIMEOUT` | `120000` | Request timeout (ms) |
| `LOCALCODE_CONTEXT_LENGTH` | Auto-detected | Override context window |
| `LOCALCODE_EMBED_MODEL` | `nomic-embed-text` | Model for code indexing |
| `LOCALCODE_SIMULATED_TOOLS` | `false` | Kill switch: force prompt-engineered `<tool_call>` XML on llama-cpp instead of native tool calling |

## Post-Change Verification (mandatory)

After EVERY change set (feature, fix, refactor), before moving on:

1. Run both suites: `npm test` (includes the guard tests in `engine/__tests__/guards/`) and `cd tui && python -m pytest tests/ -q`. Any guard failure is a stop-the-line bug.
2. New engine→TUI protocol event types must be emitted AND handled in the same PR (or added to the guard allowlist with a written reason).
3. Empty `catch {}` / `except: pass` blocks are banned — log the error or emit a governance.alert. The ratchet tests enforce this.
4. Any README capability claim must cite a default-ON code path; opt-in features must be labeled opt-in with their env flag.
5. Every plan's final task greps all new symbols to prove they are imported and called on a live path (wire check — BLOCKING).

Canonical tracked copy: `docs/POST-CHANGE-VERIFICATION.md` (this file is gitignored — keep both in sync).

## Import Conventions

- Imports use `.js` extensions (Bun convention): `import { foo } from './bar.js'`
- Feature flags use `feature('FLAG_NAME')` from a shim (`featureShim.ts`)
- Lazy `require()` used to break circular dependencies
