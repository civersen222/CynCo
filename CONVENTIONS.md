# CynCo conventions

CynCo's own conventions for this repository. Anything working in this tree — CynCo itself,
or a human, or another agent — is bound by the rules below; the guards under
`engine/__tests__/guards/` enforce the mandatory ones. This file holds conventions only: the
architecture is `docs/MANUAL.md`, and the subsystem map, with a `CLAUDE.md` per engine package,
is the table in `AGENTS.md`. (It was `CYNCO.md` until 2026-11-17, when the architecture sketch
it carried, which had fallen behind the manual, was taken out.)

## Project Overview

**CynCo** is a local AI coding assistant that runs entirely on local LLMs via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp). It provides a terminal- and browser-based AI coding assistant — file editing, bash execution, code search, git operations, sub-agents — without sending any data to external APIs.

Inspired by Stafford Beer's Viable System Model and Salvador Allende's Project Cybersyn (Chile, 1971-73). AI coding for the people, on their own hardware.

**Key technologies:** TypeScript (Bun runtime), Python (Textual TUI), Ollama (local model backend), WebSocket (engine ↔ TUI bridge).

The TypeScript engine lives in `engine/`. The Python TUI lives in `tui/`.

## Running and Testing

```bash
# --- Launch CynCo ---
cd tui && python -m localcode_tui.app        # Launches TUI + engine

# --- Engine only (headless WebSocket server; dashboard on 9161) ---
bun engine/main.ts

# --- Tests ---
npx vitest run                               # engine suite (guards included)
npm run typecheck                            # strict type-check of the engine
cd tui && python -m pytest tests/            # TUI tests
```

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
