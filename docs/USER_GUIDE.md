# CynCo User Guide

> How to install, launch, and work with CynCo — the local AI coding assistant.
> For internals see [MANUAL.md](./MANUAL.md); for getting the most out of it see
> [MAXIMIZING.md](./MAXIMIZING.md).

---

## 1. What You Get

CynCo is a coding assistant that runs **entirely on your own hardware**. It edits
files, runs commands, searches your codebase, drives git, and spawns sub-agents —
all powered by a local model through Ollama or llama.cpp. Nothing is sent to a
cloud API. There is no API key.

There are two ways to work:

- **Workspace mode** — a developer chat with full tool access and a live sidebar.
  This is the default.
- **Guided / Vibe mode** — for non-engineers. CynCo asks you questions, then
  builds the thing and explains what it did in plain language.

---

## 2. Prerequisites

1. **A model backend**, one of:
   - **Ollama** (simplest): install from [ollama.com](https://ollama.com), then
     pull a model. Recommended: `ollama pull qwen3.6`. For code indexing also
     `ollama pull nomic-embed-text`.
   - **llama.cpp** (`llama-server`) with a local GGUF file — see MAXIMIZING.md.
2. **Bun** (the engine runtime).
3. **Python 3.10+** (the TUI).

> Model note: use `qwen3.6` or `gemma4:31b`. CynCo auto-detects each model's
> capabilities (tool use, thinking, context size) on startup.

---

## 3. Launching CynCo

From the repository root:

```bash
cd tui && python -m localcode_tui.app
```

This starts the TUI, which spawns the engine in the background and connects over
WebSocket (port 9160).

What happens on first launch:

1. The **Project Picker** appears (unless a project is passed). Choose the
   directory you want to work in. Recent projects are remembered.
2. The engine boots, runs a health check against your model, and indexes the
   project for semantic search.
3. You land in **Workspace** (or **Guided**, per your settings). The header shows
   the active model and context usage.

To run the **engine only** (headless, no UI):

```bash
LOCALCODE_MODEL=qwen3.6 bun engine/main.ts
```

---

## 4. Slash Commands

Type these in the chat input. Full list (from the in-app `/help`):

**Chat & navigation**
| Command | Action |
|---|---|
| `/help` | Show all commands |
| `/stop` (or `Ctrl+X`) | Stop the model mid-generation |
| `/clear` | Clear chat history |
| `/copy` | Copy the last response to the clipboard |
| `/mode` | Switch between Workspace and Guided |
| `/settings` | Open settings |
| `/quit` | Exit |

**Model**
| Command | Action |
|---|---|
| `/model` | Pick a model interactively |
| `/model <name>` | Switch directly (e.g. `/model qwen3.6`) |

**Tools & approvals**
| Command | Action |
|---|---|
| `/tools` | List tools and their approval tiers |
| `/approve-all` | Auto-approve all tool calls this session |

**Context**
| Command | Action |
|---|---|
| `/context` | Show context-window utilization |
| `/compact` | Manually compact the conversation |

**Code & git**
| Command | Action |
|---|---|
| `/read <path>` | Read a file (e.g. `/read src/foo.ts`) |
| `/search <term>` | Search the codebase |
| `/git` | Git status + recent changes |
| `/commit` | Help create a commit from staged changes |
| `/diff` | Show the diff of modified files |
| `/analyze` | Rebuild the project code index |

**Workflows** (structured, multi-phase — tools are constrained per phase)
| Command | Workflow |
|---|---|
| `/tdd` | Test-driven development |
| `/debug` | Systematic debugging |
| `/review` | Code review |
| `/plan` | Implementation planning |
| `/brainstorm` | Idea exploration |
| `/critique` | Critical analysis |
| `/research` | Deep research with web sources + citations |
| `/cancel` | Cancel the active workflow |

**Agents & projects**
| Command | Action |
|---|---|
| `/agent` | Launch a sub-agent (scout, oracle, architect, …) |
| `/project` | Start guided project building (vibe loop) |

---

## 5. Screens & Modes

| Screen | What you do there |
|---|---|
| **Project Picker** | Choose the working directory |
| **Workspace** | Free-form developer chat with tools + sidebar (default) |
| **Guided** | Menu: New project / Work on existing / Fix a bug / Learn |
| **Vibe Loop** | Q&A → autonomous build → plain-language report (non-engineers) |
| **Project Wizard** | Research → brainstorm → design → plan for a new project |
| **Settings** | Model, temperature, context, tier, theme, tools, profiles |
| **Model Picker** | Choose from installed models |
| **Profile Wizard** | Create a reusable YAML profile |

Toggle Workspace ↔ Guided with `Ctrl+W` or `/mode`.

---

## 6. The Workspace UI

```
┌──────────────────────────────────────────┬────────────────────┐
│ Header: model · context % · GPU          │                    │
├──────────────────────────────────────────┤  Context Sidebar   │
│  Chat (you, assistant, tool activity,    │  · Session info    │
│  governance signals)                     │  · Files in context│
│                                          │  · Tool log        │
│  Worker animation while generating       │  · Sub-agents      │
│                                          │  · Memory (prior)  │
│  Command palette (/) + input             │  · Workflow status │
│                                          │  · Governance health│
├──────────────────────────────────────────┴────────────────────┤
│ Tool activity timeline (latency per call)                     │
└────────────────────────────────────────────────────────────────┘
```

The sidebar is your window into what the agent is doing: which files it has
read, every tool call and its result, sub-agent status, recalled memories from
past sessions, the active workflow phase, and governance health (context %, tool
success rate, stuck-turn count, tokens/sec).

---

## 7. Tool Approval & Safety

Tools fall into two approval tiers:

- **auto** — read-only / information tools (Read, Grep, Glob, Ls, Git status,
  CodeIndex, web search/fetch, …) run without a prompt.
- **approve** — anything that mutates files or runs commands (Write, Edit,
  MultiEdit, ApplyPatch, ReplaceFunction, Bash, NotebookEdit, SpawnAgent, …)
  requires your confirmation.

When the agent wants an `approve` tool, an **approval dialog** appears showing the
tool name, a description of what it will do, and a risk level. Choose **Allow**
(`a` / Enter) or **Deny** (`d`). Denying lets the agent try a different approach
rather than aborting.

To stop confirming for a session, use `/approve-all`. (For unattended/headless
runs the engine can auto-approve, but interactive use defaults to asking.)

---

## 8. Profiles & Settings

**Settings** (`/settings`) change the running session immediately: model,
temperature, max output tokens, timeout, context length, tier, theme, context
thresholds, and tool permissions.

**Profiles** are reusable YAML files in `~/.cynco/profiles/` (or project-local
`.cynco/profiles/`, which take priority). They support inheritance via `extends`.
A profile can pin the model, runtime params, capabilities, and an allow/deny tool
list:

```yaml
name: my-profile
extends: base-profile      # optional
model: qwen3.6
temperature: 0.5
context_length: 32768
tools:
  allowed: [Read, Write, Edit, Bash, Git]
  denied: [WebSearch]
```

Create one through the **Profile Wizard** (Settings → Create Profile, or
`/project`-adjacent flows) or by hand. Environment variables override profile
values.

Your **expertise level** (beginner / intermediate / advanced) tailors how much
the agent explains and how aggressively governance oversees it.

---

## 9. Memory Across Sessions

CynCo remembers prior sessions per project. At the start of a task it injects
what it learned before (the goal, files touched, open threads); at the end it
writes a handoff. You'll see recalled memory in the sidebar. Use the
**SaveLearning** behavior (the agent does this automatically, and you can ask it
to) to record durable lessons.

---

## 10. The Browser Dashboard

While a session runs, open **http://localhost:9161** for a richer view:

- **Chat** — same conversation in the browser, with expandable tool outputs and
  visible thinking tokens.
- **Governance** — live VSM graphs (S3/S4 balance, tool success, stuck turns,
  rule log).
- **History** — per-session analytics.
- **Config** — live parameter sliders.

---

## 11. Troubleshooting

- **"Model not found" / health check fails** — confirm the backend is running
  (`ollama list`) and that `LOCALCODE_MODEL` matches an installed model.
- **Engine won't connect** — the bridge may have fallen back to port 9161/9162 if
  9160 was busy; restart cleanly. On Windows, kill stray engine processes rather
  than reconnecting to an old one.
- **Slow first response** — the project is being indexed; subsequent queries are
  faster. `nomic-embed-text` must be installed for indexing.
- **Agent seems stuck** — give it time; long Read/search sequences are normal
  work, not a hang. Governance will nudge or restrict tools if it truly loops.
- **Can't read the engine console** — the TUI owns the terminal; check log files
  rather than expecting console output.
