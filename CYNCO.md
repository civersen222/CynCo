# CYNCO.md

CynCo's own conventions for this repository. Anything working in this tree — CynCo itself,
or a human, or another agent — is bound by the rules below. Guards under
`engine/__tests__/guards/` enforce the ones marked BLOCKING.

## Project Overview

**CynCo** is a local AI coding assistant that runs entirely on local LLMs via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp). It provides a terminal- and browser-based AI coding assistant — file editing, bash execution, code search, git operations, sub-agents — without sending any data to external APIs.

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
cd tui && python -m pytest tests/            # TUI tests
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

A third surface rides the same engine: the browser dashboard (`engine/dashboard/server.ts` +
`index.html`, HTTP + WebSocket on the bridge port + 1, token-gated). `docs/MANUAL.md` §2 is the
maintained description of the processes and ports; this diagram is the sketch.

### Key Directories

The subsystem map, with a `CLAUDE.md` per engine package, is the table in `AGENTS.md`; it is
kept current by `engine/__tests__/guards/packageDocs.test.ts`. No second tree is kept here.

## Configuration

All config is `LOCALCODE_*` environment variables layered over an optional YAML profile
(`~/.cynco/profiles/*.yaml`); no API key is needed. The shortlist with defaults and the
generated full inventory live in README "Configuration" and are checked against the code by
`engine/__tests__/guards/configTableMatchesTheCode.test.ts` — do not keep a second table here.

## Post-Change Verification (mandatory)

After EVERY change set (feature, fix, refactor), before moving on: every item of
`docs/POST-CHANGE-VERIFICATION.md` (the one canonical list; a guard failure is a stop-the-line bug).

## Import Conventions

- Imports use `.js` extensions (Bun convention): `import { foo } from './bar.js'`
- Lazy `require()` used to break circular dependencies
