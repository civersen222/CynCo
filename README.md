# CynCo — Cybernetic Collaborator

**A local AI system that codes, researches, makes things and runs unattended work on your own GPU. Zero API costs. Your data never leaves your machines.**

Inspired by Stafford Beer's Viable System Model and Salvador Allende's [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn) (Chile, 1971-73). AI that belongs to the person running it.

LocalCode is the engine (Bun + TypeScript in `engine/`, a Textual TUI in `tui/`); CynCo is that engine at work: in the terminal, in the browser, on your phone, and on its own overnight under sealed gates. It runs local models through [llama.cpp](https://github.com/ggml-org/llama.cpp) (the fast path, driven directly by the engine) or [Ollama](https://ollama.com).

---

## What CynCo does

**Writes and changes code.** A full tool-calling agent loop on your hardware: it reads, edits, runs commands, tests and commits.
- 34 built-in tools, with extended ones loaded on demand ([Tools](#tools-34-built-in)).
- A symbol-first code index: AST symbol lookup, then BM25 + vector hybrid search, plus a repo map ([Semantic Code Index](#semantic-code-index)).
- A Definition-of-Done contract on each coding request, which the model must satisfy before it may stop ([Contract Enforcement](#contract-enforcement)).
- Sub-agents, phase-gated workflows (`/tdd`, `/debug`, `/plan`, `/review` …) and installable skills ([Workflows](#workflows), [Skills](#skills)).
- *Opt-in* (`LOCALCODE_BEST_OF_N=true`): best-of-N candidates in git worktrees, chosen by test pass rate.

**Works on things that are not code.** [Projects](#projects) are a folder each: a build, a plan, a recipe book, a piece of research.
- Each has its own knowledge, cited chats, artifacts, a journal and an invisible git history.
- The chat draws tables, plans, charts and forms ([Generative UI](#governance-dashboard--chat-ui)).
- *Optional, on a second machine:* pictures painted on your ComfyUI server, photos looked at by a vision model, and photos varied, edited or turned into tracing sheets ([The image box](#the-image-box-vision-and-pictures)).
- Research across six search engines, with each saved report indexed for later search ([Deep Research](#deep-research-research)).

**Runs while you are away.**
- Dispatch one long-horizon brief: it works unattended until a marker commit, then a sealed gate grades it ([Autonomous missions](#autonomous-missions--calibrated-gate-supervision)).
- Multi-wave campaigns, run by a script ([Campaigns](#campaigns)).
- A daemon with scheduled missions and one-shots ([Always-on missions](#always-on-missions)).
- An outcome ledger with one labeled row per mission.

**Comes with you.** The dashboard is also the phone client, over your Tailscale tailnet ([Phone access](#phone-access)).
- Pair once; then chat, answer approvals, press Stop, attach photos, and see what the missions did while you were out.
- Install it as an app over HTTPS.
- *Opt-in* (`CYNCO_NTFY_URL`): a push when the engine is waiting for you.

**Looks after the machines it runs on** ([Wakefulness and the household](#wakefulness-and-the-household)).
- *Opt-in* (`LOCALCODE_LLAMA_LAZY`, `LOCALCODE_LLAMA_IDLE_UNLOAD_MS`): the model loads when a message needs it and unloads when idle, so the PC can sleep.
- *Optional, needs an always-on mini PC:* a doorman that wakes the PC for a phone knock or a scheduled trigger, and a watcher that keeps the household's records and writes a daily note.
- When another local-LLM app of yours holds the GPU, CynCo takes it for the turn and gives it back after ([Your other local-LLM apps](#your-other-local-llm-apps)).

**Governs and measures itself.** A Viable System Model layer (S1–S5) runs alongside the loop ([Governance](#governance-vsm-s1s5)).
- 21 S5 policy rules, a four-tier stuck-loop escape, variety control, an algedonic channel and a homeostat.
- A rule's authority to act is earned on the outcome ledger, not assumed.
- Every turn's cost is recorded from the server's own timings.
- The [Brain](#the-brain) tab shows thinking, per-token entropy and, with setup, the concepts mid-network.
- Every governance decision is journaled as [training data](#fine-tuned-models-coming).

---

## What it has done

What is measured and what is not, kept apart. The project's own terms are in [AGENTS.md](AGENTS.md) ("What a mechanism is"): *useful*, *correct*, *effective*, *hypothesis*.

- **Eleven sealed-gate campaigns, all passed.** These are C1–C11, run from 2026-08-24 to 2026-10-06, and together they built out the CivKings game, a Python strategy-simulation codebase, one campaign at a time.
  - The local agent wrote the code. The frontier model in the supervisor seat wrote briefs and gates, graded the results, and never edited the game.
  - Each campaign was graded by a held-out gate that had to fail cleanly on the base commit and on a cheat stub before dispatch.
  - Record: [docs/civkings-redesign-briefs/campaign-log.md](docs/civkings-redesign-briefs/campaign-log.md).
- **Supervision economics, measured.** C1–C5 are the [paper](docs/supervision-economics-paper.md): $1 of frontier supervision oversaw ~$1.39 of displaced generation (honest band $1.0–1.4), and that generation ran locally ~349× cheaper than API prices.
  - The running total after C11 wave 2: $2,995.57 of supervision against ~$5,920.56 of API-priced generation, which ran locally for ~$25.05 of power. That is $1 per ~$1.98 ([campaign log](docs/civkings-redesign-briefs/campaign-log.md); the paper's measurement caveats apply).
- **Serving, measured on the RTX 5090:**
  - 94–119 tok/s single-stream generation.
  - 16 of 16 streamed tool calls delivered, none dropped.
  - Warm turns reuse ~0.998 of the prompt cache at 45K tokens of context ([below](#recommended-llamacpp-direct-provider-with-mtp-speculative-decoding)).
- **Not yet shown effective: the governance layer itself.** On the long-horizon ablation suite, governed minus ungoverned is −8.3% [−28, +14], which is *inconclusive* ([docs/BENCHMARKS.md](docs/BENCHMARKS.md) §3–4).
  - It is wired and tested (*correct*). It has not been shown to improve outcomes (*effective*).
  - That is why S5's rules act only once they earn it.

---

## Models

CynCo is one system that uses several models, each for one job. Every name below is the one the code or the shipped profile asks for.

| Job | Model | Runs on | Set by |
|---|---|---|---|
| **The agent**: coding, project chats, missions | **Qwen3.8-27B**, NVFP4 GGUF with its MTP head (`Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf`, 19.7 GB) | llama-server on the main GPU, started and managed by the engine | a profile's `model_file`, or `LOCALCODE_MODEL_PATH` |
| The agent, on the Quick Start path | `qwen3.8:27b` from Ollama's library (18 GB) | Ollama | the shipped profile, `engine/profiles/templates/default.yaml` |
| Embeddings for the code index | `jina-code-embeddings-0.5b` when the server has it, else `nomic-embed-text` | any embedding server ([Semantic Code Index](#semantic-code-index)); on the CynCo PC, CynCo's own `llama-server --embeddings` on `127.0.0.1:9165`, CPU only | `LOCALCODE_EMBED_MODEL` |
| Embeddings for project knowledge | `nomic-embed-text` | the same server | `LOCALCODE_PROJECTS_EMBED_MODEL` |
| Looking at photos *(optional)* | `qwen3-vl:8b-instruct` | Ollama on the image box | `LOCALCODE_VISION_URL`, `LOCALCODE_VISION_MODEL` |
| Painting pictures *(optional)* | an SDXL checkpoint; Juggernaut first when none is named | ComfyUI on the image box | `LOCALCODE_COMFYUI_URL`, `LOCALCODE_COMFYUI_CHECKPOINT` |
| Editing photos, tracing sheets *(optional)* | Qwen-Image-Edit-2509 (`Q4_K_S` GGUF, 4-step Lightning LoRA) | ComfyUI on the image box | `LOCALCODE_COMFYUI_WORKFLOW_EDIT`, `LOCALCODE_COMFYUI_WORKFLOW_OUTLINE` |
| Answering while the main GPU is busy *(optional)* | `qwen3:14b` | Ollama on the image box | `LOCALCODE_FALLBACK_URL`, `LOCALCODE_FALLBACK_MODEL` |
| The Brain tab's concept lens *(optional)* | a Jacobian lens precomputed for Qwen3.6-27B | the jlens sidecar (Python, port 9163) | `LOCALCODE_JLENS=on`; the lens repo is `JLENS_MODEL_REPO` |
| S5 governance decisions | the 21 hand-written rules; a fine-tuned S5 model once one exists | in the engine; a model through Ollama | `LOCALCODE_S5_MODEL` |
| Training a personal adapter *(not yet run)* | base `unsloth/Qwen2.5-Coder-14B-Instruct` (QLoRA via Unsloth) | the main GPU | `--base` (default in `engine/training/trainingArgs.ts`) |
| Training the S5 model *(not yet run)* | base `unsloth/Qwen2.5-3B-Instruct-bnb-4bit` | the main GPU | `--model` of `scripts/fine_tune_s5.py` |

Both training defaults predate the move to Qwen3.6/3.8, and neither adapter has been trained. See [Fine-Tuned Models](#fine-tuned-models-coming).

The "image box" is a second PC on the LAN (here an RTX 4070 Ti Super). Nothing needs it. Each feature that uses it says so when its URL is unset, and the rest of CynCo works without it.

### Choosing the main model

CynCo needs a model with native tool calling. Only the first two rows have been measured here; the others are reasonable alternatives that have not been.

| Model | Kind | Size | Measured here | Notes |
|-------|------|------|---------------|-------|
| **Qwen3.8-27B** NVFP4 + MTP | hybrid (Gated DeltaNet + attention), MTP head | 19.7 GB | 94–119 tok/s single stream (prose 94.9, code 101.1, repetitive JSON 119.3: `benchmark/true/results/throughput-nvfp4-mtp-1787935000.summary.txt`); 16/16 streamed tool calls, zero drops (`benchmark/true/results/streamtoolcall-1787004103304.summary.txt`) | **What CynCo runs.** Trained to 262K context; served at 131K. Native tool use and thinking. Apache 2.0. On Ollama: `qwen3.8:27b`. |
| Qwen3.6-27B NVFP4 + MTP | hybrid (Gated DeltaNet + attention), MTP head | ~16 GB | 115 tok/s eval, 0.83 draft acceptance (live missions, 2026-07-10); its Q6_K ran the governance benchmark | The previous default. Every number in the [serving guide](docs/serving/rtx-5090-qwen3.6-27b.md) was measured on it. On Ollama: `qwen3.6:27b`. Note that `qwen3.6` alone is `qwen3.6:latest`, which is the 35B-A3B below. |
| Qwen3.6-35B-A3B | MoE, 3B active | ~20 GB (Q4_K_M) | not measured here | Fast per token. |
| Gemma4-31B | dense | ~19 GB (Q4) | not measured here | Native tool use. On Ollama: `gemma4:31b`. |
| Devstral-Small-2-24B | dense | ~15 GB (Q4) | not measured here | Built for agentic multi-file edits; fits a 16 GB card at a short context. On Ollama: `devstral-small-2:24b`. |

NVFP4 is the 4-bit format of NVIDIA's Blackwell generation (the RTX 5090 here). On an older card, a Q4_K_M or Q6_K GGUF is the usual choice.

### Quantization

We run the **NVFP4** GGUF of Qwen3.8-27B (`Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf`, 19.7 GB on disk). It was measured on 2026-08-28: 94–119 tok/s single-stream, and 16/16 streamed tool calls with zero drops (`benchmark/true/results/`). The trade-off logic is unchanged from Qwen3.6: on a 32 GB card, NVFP4 frees the most VRAM for KV cache and sub-agents, and Q6_K does not.

The quantization table below was measured on the previous default, Qwen3.6-27B. It is kept for the shape of the trade-off:

| Quantization | Size (27B) | Measured decode | Quality | When to Use |
|-------------|------------------|-----------------|---------|-------------|
| **NVFP4 + MTP** | ~16 GB | 115 tok/s eval, 0.83 draft acceptance (live missions, 2026-07-10) | Tool-call structure intact | **What we run.** Frees the most VRAM for context and agents. |
| Q6_K + MTP | ~22 GB | 153.7 tok/s median decode at `spec_draft_n=3` (benchAgentic A/B, 2026-07-01) | Near-lossless | The alternative if you have the headroom. |
| Q4_K_M | ~17 GB | not measured here | Good | 24 GB GPUs. |
| Q3_K_M | ~13 GB | not measured here | Noticeable loss | Only if you can't fit Q4. Tool-call structure degrades below 4-bit. |

The two measured numbers came from different harnesses: one is a live mission stream, the other a controlled A/B bench. They are reported separately rather than compared, and neither has been re-run against the other's setup.

**One gotcha, and it cost us a session.** The community NVFP4 GGUF embeds a stricter Jinja chat template that raises on mid-conversation system messages, and CynCo injects exactly those (index chunks, project state). Point the profile at a known-good template:

```yaml
runtime:
  chat_template_file: ~/.cynco/models/qwen3.6-27b-nvfp4/chat_template.jinja
```

The tool-call probe did not catch this, because it only sends system-first prompts. See [docs/cynco-failure-log.md](docs/cynco-failure-log.md).

**Qwen3.8 has its own template gotchas.** The same template-file override applies: a known-good `chat_template.jinja` ships next to our GGUF. Two things are new in 3.8:

- Its template reads `reasoning_effort` (`low | medium | xhigh`) and `preserve_thinking` from `--chat-template-kwargs`. The profile key is `chat_template_kwargs`, which the engine forwards; other models ignore unknown keys.
- It raises `No user query found in messages.` (a hard 400) on any prompt with no user message. That is one reason the engine's compaction anchors recent user messages verbatim, which a regression test enforces.

Its model card asks for the thinking-mode sampler (temperature 1.0, top_p 0.95, top_k 20) and for large reasoning budgets on agentic work. That is why the profiles here set `temperature: 1.0` and raise `reasoning_budget` above the engine's 256 default, which was tuned on Qwen3.6.

### Embedding model

Semantic indexing needs a *separate* embedding model, because the chat model does not serve embeddings. The code index asks for `jina-code-embeddings-0.5b` (code-specialized). If the server does not have it, the index falls back to `nomic-embed-text`. Project knowledge uses `nomic-embed-text` directly.

Ollama's library has no `jina-code-embeddings-0.5b`, so on Ollama pull the fallback:

```bash
ollama pull nomic-embed-text
```

Against Ollama, the engine also tries once, in the background, to pull the model it asked for, which for the default can't succeed. To use the jina model, serve its GGUF on an OpenAI-shaped server (`llama-server --embeddings`) and set `LOCALCODE_EMBED_MODEL` to the name that server knows it by.

Switching embedding models requires a re-index. If no embedding server answers, you get keyword search and the engine says so. [Semantic Code Index](#semantic-code-index) explains how it finds a server.

### A second main model: not wired

S5's rule W2 proposes switching to an alternative model when latency is *measured* rising over at least five turns, and the conversation loop applies a model switch that S5 hands it. But the loop gives S5 a list of exactly one model, the configured one (`availableModels` in `engine/bridge/conversationLoop.ts`), and no setting names a second. So W2 cannot fire in a real session (F233 in the [failure log](docs/cynco-failure-log.md)).

Nothing picks a model from the wording of a task either, and there is no plan to add that. S5 already carries a measured difficulty signal (`promptDifficulty`, derived from turn telemetry), which is better evidence than a guess from the request. The one place a second model answers today is the busy fallback in the table above, and that is chosen by who holds the GPU, not by S5.

---

## Quick Start

### Prerequisites
- [Ollama](https://ollama.com) running locally (or llama.cpp for the direct GGUF provider)
- [Bun](https://bun.sh) runtime
- Python 3.10+
- A GPU with 24 GB or more for the model below ([Hardware Expectations](#hardware-expectations))

### Install & Run

```bash
# Clone
git clone https://github.com/civersen222/CynCo.git
cd CynCo

# Install the engine's dependencies
bun install

# Pull the model the shipped profile runs (Qwen3.8-27B, 18 GB)
ollama pull qwen3.8:27b

# Pull the embedding model for semantic code search
ollama pull nomic-embed-text

# Install the TUI
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
cd tui && pip install -e . && cd ..

# Launch
cd tui && python -m localcode_tui.app
```

That's it. No API keys. No subscriptions. No data leaving your machine.

With no environment set and no profile of your own, the engine runs the profile that ships at `engine/profiles/templates/default.yaml`: provider `ollama`, model `qwen3.8:27b`, a 65,536-token context, temperature 1.0. A test keeps that file and the `ollama pull` line above naming the same model (`engine/__tests__/guards/quickStartStartsTheEngine.test.ts`). The faster llama.cpp path is below.

The TUI starts the engine for you and owns the terminal, so the engine's own output goes to `.cynco-engine.log` in the project folder, not to the screen. To attach to an engine you started yourself, pass `-p <project dir>`.

Beyond this page, [docs/README.md](docs/README.md) indexes the rest: [USER_GUIDE](docs/USER_GUIDE.md) (install, commands, modes, troubleshooting), [MANUAL](docs/MANUAL.md) (architecture), [BENCHMARKS](docs/BENCHMARKS.md) (what is measured, honest numbers), [MAXIMIZING](docs/MAXIMIZING.md) (tuning). Returning after a break, or working on CynCo itself: [AGENTS.md](AGENTS.md), then [docs/NOW.md](docs/NOW.md).

Once running, interact in the TUI or open the dashboard in your browser. The engine prints its URL at startup:

```
[dashboard] Governance dashboard on http://localhost:9161
```

That is the bridge's bound port plus one, not a fixed number. The bridge asks for `LOCALCODE_WS_PORT` (default `9160`). When that port is taken, as it ordinarily is after a restart, it tries the next one and then the one after. Read the line; don't assume `9161`.

### Recommended: llama.cpp Direct Provider with MTP Speculative Decoding

This is how we run CynCo: llama-server driven directly by the engine, with Multi-Token Prediction on the Qwen3.8-27B NVFP4 GGUF.

```bash
LOCALCODE_PROVIDER=llama-cpp \
  LOCALCODE_MODEL_PATH=~/.cynco/models/qwen3.8-27b-nvfp4/Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf \
  LOCALCODE_SPEC_TYPE=ngram-mod,draft-mtp \
  LOCALCODE_SPEC_DRAFT_N=3 \
  LOCALCODE_CONTEXT_LENGTH=131072 \
  bun engine/main.ts
```

The context is set explicitly because the shipped profile asks for 65536, and a profile's `context_length` beats the engine's built-in 131072. Half of what Qwen3.8-27B is trained for (262144) costs ~2.5 GB of f16 KV. At 65536 the engine compacted once every ~9 turns on long missions. Lower it if you have less VRAM.

The rest of the recipe belongs in a profile, because the template and reasoning settings are profile keys, not environment variables. This is the shape of the profile CynCo runs on, at `~/.cynco/profiles/default.yaml`:

```yaml
name: default
model: qwen3.8-27b-nvfp4
model_file: Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf
context_length: 131072
temperature: 1.0                  # the Qwen3.8 card's thinking-mode sampler
runtime:
  spec_type: ngram-mod,draft-mtp  # measured: 119.6 tok/s vs 113.9 for draft-mtp alone
  spec_draft_n: 3
  chat_template_file: ~/.cynco/models/qwen3.8-27b-nvfp4/chat_template.jinja
  chat_template_kwargs:
    reasoning_effort: medium
    preserve_thinking: true
  reasoning_budget: 4096          # a runaway stop; the engine's 256 was tuned on Qwen3.6
```

`spec_type`, `spec_draft_n` and `context_length` can be overridden by their environment variables. The other `runtime:` keys cannot: see [Configuration](#configuration).

The engine starts and manages llama-server itself:

- Single-slot mode.
- Context checkpoints for prefix-cache rollback. Qwen3.6 and 3.8 are hybrid Gated DeltaNet models, so warm turns only prefill new tokens instead of reprocessing the whole prompt.
- A capped reasoning budget (256 tokens unless the profile says otherwise).
- Accurate tok/s from the server's own eval timing.

The engine also keeps its prompt strictly append-only across turns to preserve the cache, which a regression test enforces. Measured live at 45K tokens of context: warm turns restore a checkpoint with ~0.998 prefix reuse and prefill only the ~500-900 genuinely new tokens (~0.6-0.9 s), instead of reprocessing the full prompt (~17 s). Each turn pays only for its new content.

Side queries go through the same llama-server instance, to avoid VRAM thrashing. Before any spawn, the engine checks the host's free memory and the GPU and names its refusal rather than crashing. llama-server runs inside the engine's Job Object, so it dies with the engine. Full tuning recipe: [docs/serving/rtx-5090-qwen3.6-27b.md](docs/serving/rtx-5090-qwen3.6-27b.md).

Every turn's cost is recorded to the `measurements` table, with the source the numbers came from:

- Tokens: prefill, cached and decode.
- Time: prefill and decode milliseconds, and wall milliseconds.

Prefill tokens are `timings.prompt_n`, the tokens the server actually evaluated. They are not `prompt_tokens`, which is the size of the whole prompt; conflating the two makes a cached 60K prefix look identical to a cold one. A turn whose server reported no timings is stored as `NULL`, not zero: it is unmeasured, not free. `/spend` sums the session and reports how many turns it covers, so a partial total reads as a floor rather than a claim.

**Other servers.** Besides `ollama` and `llama-cpp`, `LOCALCODE_PROVIDER` accepts `lmstudio`, `vllm` and `openai-compat`, for any server that speaks the OpenAI chat API (`LOCALCODE_BASE_URL`, `LOCALCODE_API_KEY`). The llama.cpp path is the measured one.

---

## Hardware Expectations

| GPU memory | Main model | What to expect |
|------|------------------|------------|
| **32 GB** | **Qwen3.8-27B NVFP4 + MTP** (llama.cpp) | **What CynCo is developed on.** 94–119 tok/s measured, with room for a 131K context and sub-agents. |
| 24 GB | `qwen3.8:27b` (Ollama, 18 GB), or a Q4_K_M GGUF | The full feature set, at a smaller context. Not measured here. |
| 16 GB | `devstral-small-2:24b` (15 GB) at a short context, or a 14B model such as `qwen3:14b` (9.3 GB, 40K context) | Usable, and not measured on missions. CynCo itself uses `qwen3:14b` only as the busy fallback. |
| under 16 GB | — | Not recommended. Models that fit struggle with the tool-calling format. |

**More than one machine (optional).**
- *A second GPU box on the LAN (here an RTX 4070 Ti Super):* serves the vision model, ComfyUI pictures and the busy fallback over the network.
- *An always-on mini PC:* runs the doorman and the watcher.

Neither is needed, and each feature that uses one says so when it is not configured.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  S5 Policy Engine: 21 rules (C1-C7, W1-W9, I1-I5), merged    │
│  into one decision a turn, applied only with authority       │
└──────────────────────────┬───────────────────────────────────┘
                           │ decides
┌──────────────────────────┴───────┐   WS   ┌───────────────┐
│  TypeScript Engine (Bun)         │◄──────►│  Python TUI   │
│                                  │  9160  │  (Textual)    │
│  Conversation Loop               │        │               │
│  ├── Tool Executor (34 tools)    │        │  Workspace    │
│  ├── Contracts (Definition of    │        │  Vibe Loop    │
│  │   Done)                       │        │  Settings     │
│  ├── VSM S1-S4: variety,         │        │  Context Bar  │
│  │   homeostat, algedonic, S2    │        └───────────────┘
│  ├── Code Index (symbol, hybrid) │
│  ├── Research (7 engines)        │
│  ├── Memory (learnings)          │
│  ├── Projects (prose, chats)     │
│  ├── Generative UI, Vision,      │   HTTP ┌───────────────┐
│  │   Pictures────────────────────┼───────►│  image box    │
│  └── Sub-Agents (6 personas)     │        │  Ollama,      │
│       ↓ HTTP                     │        │  ComfyUI      │
│  llama-server / Ollama / OpenAI  │        └───────────────┘
├──────────────────────────────────┤
│  Dashboard + Chat (HTTP+WS)      │  ← desk browser (loopback)
│  bridge port + 1 (9161 by dflt)  │  ← paired phone (tailnet)
└──────────────────────────────────┘
┌──────────────────────┐   ┌──────────────────────────────┐
│  Daemon (no model)   │   │  Doorman mini PC (always on) │
│  missions, one-shots │   │  wake-on-LAN, ntfy, watcher  │
│  ntfy to the phone   │   │  (daily note on :9171)       │
└──────────────────────┘   └──────────────────────────────┘
```

Each subsystem has its own `CLAUDE.md` with files, types and `file:line` references; [AGENTS.md](AGENTS.md) is the map.

---

## Features

### Workspace Mode
Type naturally. CynCo calls tools autonomously: it reads files, edits code, runs commands and searches the codebase. A Stop ends the turn and everything it started. The turn's abort signal reaches the model call, every tool and every sub-agent, and a Bash command is killed with its whole process tree.

Opt-in behaviours of the loop:
- **Best-of-N sampling** *(opt-in: `LOCALCODE_BEST_OF_N=true`)*: runs `LOCALCODE_BEST_OF_N_COUNT` candidates (default 2) in git worktrees, and keeps the one with the best test pass rate. It is skipped when no test framework is found.
- **House conduct** *(opt-in: `LOCALCODE_HOUSE_CONDUCT=true`)*: a `<CONDUCT>` section after the role, in the coding and project-chat prompts. It says: answer the request that was made, give no unasked-for disclaimers or lectures, and treat every subject the user raises as theirs to have answered. It names no category. It is measured by the ledger's `refusals` field ([benchmark/cynco-ledger/README.md](benchmark/cynco-ledger/README.md)), and stays opt-in until that comparison has run.
- **Constrained decoding** *(opt-in: `LOCALCODE_GRAMMAR_ENABLED=true`, llama.cpp only)*: for a model without native tool calling, CynCo parses tool calls out of the model's text and validates them, and the flag also constrains that text with a GBNF grammar. A native tool-calling model, Qwen3.8 among them, uses neither.
- **Advisors** *(opt-in: `LOCALCODE_ADVISORS=1`; exactly `1`, since `true` does nothing)*: the S2–S5 advisors are consulted during S4 reflection, and their advice goes into the context.

### Vibe Mode (`/project`)
Guided building for non-programmers. Type `/project` to start; `/mode` switches to the guided screen. CynCo asks clarifying questions scaled to the project's difficulty, locks decisions, then builds autonomously with goal-backward verification:
1. **Understand.** It asks focused questions and builds a confidence score across four dimensions.
2. **Teachback.** It explains back, in plain language, what it is about to build. Nothing is built until you confirm. This gate is hard: the model cannot skip it.
3. **Build.** It works autonomously with the locked D-XX decisions.
4. **Report.** It explains what was built in plain language, with analogies.
5. **Next.** It suggests the logical next step.

It has four modes: `new`, `continue`, `fix` (reproduce the problem first) and `explain` (read-only: it never writes, edits or creates a file). See `engine/vibe/CLAUDE.md`.

### Deep Research (`/research`)
Multi-source research across six search engines, routed by the query's domain:
- **DuckDuckGo**: the general web, with rate-limit mitigation and retry with backoff.
- **GitHub**: repositories, sorted by stars.
- **arXiv**: academic papers, with CS category filtering and relevance scoring.
- **Wikipedia**: background and definitions.
- **PubMed**: biomedical literature.
- **HuggingFace**: ML models and datasets.

A seventh, **SearXNG**, is registered too (`engine/research/engines/searxng.ts`), but it is used only when you point `LOCALCODE_SEARXNG_URL` at an instance.

Results are scored by keyword relevance, recency, source authority and cross-source corroboration, then deduplicated. When the primary engine comes back empty, a fallback chain (SearXNG, then DuckDuckGo, then Wikipedia) still finds results. The `IndexResearch` tool chunks a saved report into the code index, so later turns can search it.

### Sub-Agents
Six typed personas, each with domain vocabulary injected (the PRISM system): **scout**, **oracle**, **kraken**, **spark**, **architect** and **researcher**. The main loop or the `SubAgent` tool dispatches them as bounded, forked conversation loops; `CollectAgent` takes their results back.

What they can do today is narrower than the persona names suggest. Every sub-agent gets the read-only tool set, whatever its persona: Read, Glob, Grep, CodeIndex, Ls, ImageView and Git. The `specialist` and `full` trust tiers that would add a persona's own tools are not built yet (`engine/agents/trustTier.ts`). So sub-agents scout, read and report, and the main loop does the editing. The researcher persona has no web tools either.

The S2 coordinator queues agents when it reads the GPU as busy, and kills stuck agents through algedonic signals. Its GPU reading is Ollama's `/api/ps` at the chat URL: the share of the first loaded model that sits in VRAM. It reads 0 when the server lists no model and 0.5 when the call fails, so on a provider that is not Ollama the reading says nothing about the GPU.

### Governance (VSM S1–S5)
CynCo's loop runs inside a Viable System Model layer:

- **S1:** the tool outcomes.
- **S2:** coordination, of sub-agents among other things.
- **S3/S4:** the balance between doing and reflecting.
- **S5:** the policy that decides tool restrictions, compaction and priority shifts.

Alongside them run a variety engine (Ashby's requisite variety), a homeostat, an algedonic channel for pain signals and an action-fingerprint alarm. The Beer/Ashby/Pask primitives live in `engine/cybernetics-core/` ([its README](engine/cybernetics-core/README.md)); `engine/vsm/CLAUDE.md` maps the organs.

**Authority is earned, not assumed.** S5's rules are deterministic (`engine/s5/ruleBasedS5.ts`). Every rule that fires is merged into one decision per turn (`combineDecisions`), and whether that decision is *applied* depends on its authority (`engine/s5/ruleAuthority.ts`):

- **With no verdict file** (a fresh clone): in an interactive session the decision is applied when `LOCALCODE_S5_ENFORCE` is on, which is the default. In an unattended mission it is logged as `WOULD-ENFORCE (advisory)` and not applied.
- **With a verdict file** (`~/.cynco/datasets/rule-verdicts.json`, written by `scripts/cynco-rule-verdicts.mjs` at every campaign verdict): a decision is applied only when every rule behind it reads `PREDICTIVE` on the outcome ledger, meaning it fires more often on missions that went on to fail. Otherwise it is advisory.
  - On the development PC no rule has earned `PREDICTIVE` yet, so there S5 advises and logs, and applies nothing.

This is the project's rule for experimental policy: observe, then advise, then enforce once it is measured.

**The 21 rules** (plus an opt-in 22nd). Their ids carry a tier, Critical, Warning or Info, but the code does not act on the tier: whatever fires is merged and applied together when it has authority. The tiers count 7/10/4 while the ids read C1–C7, W1–W9 and I1–I5, because `I4` (heterarchy authority) declares `tier: 'warning'`.

*Critical:*
- **C1**, kill switch: it restricts to read-only tools when governance reports `halted`. The governance report never produces that status, so C1 does not fire (F233). The kill switch that does act is the algedonic channel's. After five consecutive tool failures it halts the loop and asks for `/reset`.
- **C2**, tool exclusion: when a specific tool fails 3+ times.
- **C3**, context overflow compaction: at 90% utilization.
- **C4**, doom-loop breaking: 3+ consecutive failing calls to the same tool, matched by tool name, not by input.
- **C5**, productivity collapse: performance critical and productivity under 0.3 blocks sub-agent spawns. It reads no GPU.
- **C6**, variety critical: restrict to the top-5 tools by success rate.
- **C7**, **stuck loop escape**: when stuck 5+ turns, restrict to tools not used recently, regardless of their success rate.

*Warning:* model switch on rising latency (W2, which cannot fire: see [A second main model](#a-second-main-model-not-wired)); a revert recommendation on 5+ stuck turns (W3, recommended and never executed); drift-based compaction and tool restriction; homeostatic instability rebalancing; S3/S4 imbalance correction. A fired warning rule also sends a `governance.recommendation`, which the TUI prints as a line in the chat.

*Info:* variety balance shifts, homeostatic adjustments and performance metrics, logged for training.

A 22nd rule, `P1` in `engine/s5/proactiveSurfacing.ts`, exists only when `LOCALCODE_S5_PROACTIVE_TOOLS=true`. It is append-only: it surfaces tools and never restricts them. It is off by default.

**Stuck-loop escalation (4 tiers), run by the loop itself:**
1. **Turn 3+:** a governance signal is appended to the conversation saying "change your approach". It is appended rather than written into the system prompt, which keeps the prompt cache valid.
2. **Turn 5+:** C7 restricts tools to ones not used in the last 5 turns.
3. **Turn 10+:** a synthetic user message makes the model reflect on what is blocking it.
4. **Turn 15+:** a hard halt returns control to the user.

After each decision, S5 compares the governance metrics before and after and writes the measured outcome into the decision journal. That is the training data below. Per-rule weights are also written to `~/.cynco/training/s5-weights.json`, but nothing reads them back yet (F233).

### Contract Enforcement
A request opens a Definition-of-Done contract, and the model cannot stop until its assertions pass:
- **Edit tasks:** the file was modified and the changes were committed. The commit assertion is dropped when you say not to commit.
- **Analysis tasks:** an answer was given, and it addresses your question.
- **Run tasks:** the command was executed and its output reported.

There are up to 5 enforcement rounds. If the model tries to stop early, it is told "You are NOT done". No contract is opened for a message of 15 characters or fewer, while an incomplete contract is still open, in a project chat, or for a UI action.

### Governance Dashboard + Chat UI
Open the URL the engine printed at startup: the bridge port + 1, which is `http://localhost:9161` when the bridge got its default. The desk page has seven tabs; the phone layout has four (see [Phone access](#phone-access)).

**[Chat]**: send prompts directly from the browser.
- Full tool output with expandable details, visible thinking tokens, and streaming model text.
- Slash commands drive the workflows (`/plan`, `/tdd`, `/debug`, `/review`, `/brainstorm`, `/critique`, `/research`).
- Enter sends; Shift+Enter makes a new line.
- Long tool calls show `running Nm NNs`.
- Approval cards and AskUser questions are answered right in the chat.

**Generative UI in the chat.** The model can draw structured UI in the chat pane with one tool call, `RenderUI`. It can draw:
- cards, tables, and plans with a status per step;
- key facts, metrics and inline-SVG charts;
- forms (inputs, selects, radios, checkboxes, sliders), buttons and follow-up chips;
- coding-agent report blocks: file changes, a command and its output, test results.

How it behaves:
- A surface draws progressively while the call streams.
- A click on a button sends the action name, and every input value on the surface, back to the model as its next message.
- Follow-up chips send their text as a user message.
- The model can re-render a surface in place by reusing its id.
- Assistant prose is rendered as markdown: headings, lists, tables, code fences, links.

The tool is always offered in a project chat, and can be loaded with `load_tools` in a coding session. In a project chat, a message that asks to see options, designs, pictures, a comparison or a table is answered with a surface. Its model calls go out with `tool_choice: required` until one draws, because the prompt alone let the model answer such a request in prose (F171). Every reply also carries a "Show as UI" link that redraws it.

The component catalog, validator and prompt section live in `engine/genui/` (see `engine/genui/CLAUDE.md`). The format and vocabulary were adopted from json-render, A2UI and OpenUI (credits in `CREDITS.md`). The renderer is hand-written vanilla DOM, so the page stays a single file with no build step.

An Image on a surface can show three kinds of picture:
- A picture painted from a `prompt`; see [The image box](#the-image-box-vision-and-pictures).
- An image file the model wrote into the project (a png, jpg, gif, webp or svg), named in `src` by its path relative to the project folder. The page fetches it through the engine (`GET /api/projects/:slug/files/<path>`), so a template or sketch the model drew as a file appears in its card (F175).
- A transformed project photo.

**[Governance]**: real-time VSM monitoring.
- **Tool Activity**: a stacked bar chart and a live feed with latency.
- **Governance Health**: S3/S4 balance, variety ratio, stuck turns, algedonic alerts, and action-fingerprint repetition alarms. The alarms flag loops of 3 identical or 6 alternating tool calls.
- **Prediction Tracker**: 8 redesigned hypotheses. They cover:
  - governance effectiveness: H1 Stuck Escape, H2 Nudge Response;
  - model predictability: H4 Read-to-Edit, H5 Thinking Efficiency;
  - parameter tuning: H6 Temperature Effect, H7 S4 Reflection ROI.

  Each is scored against a null baseline, and the baseline says where it came from:
  - `measured`: the hypothesis's own success predicate, scored on the same tool stream at points where it was *not* triggered;
  - `assumed`: the hand-written constant.

  Six of the eight can be measured. H3 reads governance state and H8 is scored once at session end, so both stay assumed. A significance verdict against an assumed baseline is a verdict against a guess, and `/predictions` says so.
- **Active Contract**: assertion status, pass, fail or pending.
- **S5 Decision Log**: live policy decisions with their reasoning.
- **tok/s**: from `timings.predicted_n / predicted_ms`, the server's own count and clock.

**[Brain]**: model cognition. A thinking-token viewer, a per-token entropy trace, and, with setup, a live concept workspace read from mid-network activations. See [The Brain](#the-brain) below.

**[History]**: session analytics.
- Per-session metrics charts: tool success, stuck turns, and context utilization over time.
- A session transcript viewer, and a session selector.

**[Config]**: engine and system settings.
- Temperature, context length and timeout sliders, and system control toggles.
- All 26 VSM governance parameters (`engine/vsm/governanceParams.ts`), with sliders and their declared bounds.
- **Phone access**, for pairing and devices.

**[Projects]**: your non-code projects; see [Projects](#projects).

**[Missions]**: everything the daemon runs; see [Always-on missions](#always-on-missions).
- Each trigger, with its next and last run.
- Who holds the GPU.
- Your other local-LLM apps, with their switch.

The page survives a reload, auto-detects active sessions, and reconnects on its own. A page whose socket dropped is sent what it missed, in order, once. It polls governance every 3 s, training data every 30 s, sessions every 15 s and missions every 10 s. A mission dispatch swaps the engine under an open tab, and mission end boots an idle engine again.

### Projects

A **[Projects]** view on the dashboard at `/#projects` for non-code work: a build, a plan, a recipe book, a piece of research. It is kept separate from the coding workspace above. It lists your projects and opens each one to its knowledge, artifacts, chats, inbox and journal. A project's chat answers from the project's own material, with numbered citations, alongside the open web.

Each project is one plain folder:

- `project.json` / `instructions.md`: the project's name, description and tags, plus your standing instructions for every chat in it.
- `knowledge/`: the sources you've gathered, each indexed for search. Uploads take `.md`, `.txt`, `.pdf`, `.epub`, `.docx` and `.xlsx`; photos are stored and, with a vision model set up, looked at.
- `chats/`: one JSONL transcript per conversation.
- `artifacts/`: the things CynCo has produced for you (specs, plans, drafts), each promotable into `knowledge/`.
- `inbox/`: drafts that a scheduled run left for you. A run whose `cwd` is the project folder files its answer here, and you accept it into artifacts or discard it from the project's Inbox tab, on the desk or the phone.
- `plan.md` and `journal.md`: the project's plan, and an append-only record of what happened.
- An invisible git history underneath the whole folder; no git command is ever shown to you.
- `images/`: the pictures a chat's cards asked for, each beside a JSON record of how it was made. The records are in the git history, the pictures are not.

A project chat has four tools of its own:
- `ProjectSearch`: search one project, or all of them.
- `SaveArtifact`.
- `AddToKnowledge`: add a source by path or by URL.
- `LookAt`: ask the vision model one aimed question about a photo.

Tool calls inside a project chat are graded, not approved by tier:
- A file write or read stays inside the project folder, or it is refused outright.
- A safe Bash command runs at once. A risky one asks you first.
- *Every* download asks, always, however safe it would otherwise look. So does anything that runs a program or script in the project, including code the chat may have just written.
- Anything dangerous is refused, with its reason.

In every mode, the engine's own token file is off limits to the model. SSH keys, `.env` files and system credential files need your yes before any tool touches them (`docs/decisions/2026-11-06-untrusted-content-and-secret-paths.md`). There is no `/undo` and no workspace snapshot inside a project chat: the project's own invisible git history is the record instead.

Three environment variables tune it:
- `LOCALCODE_PROJECTS_HOME` (default `~/cynco-projects`): where project folders live.
- `LOCALCODE_PROJECTS_EMBED_MODEL` (default `nomic-embed-text`): the prose embedding model.
- `LOCALCODE_PROJECTS_RETRIEVAL_SHARE` (default `0.15`): the share of the context window given to the per-turn retrieval block.

### The image box: vision and pictures

A second GPU box on the LAN can be CynCo's eyes and sketchpad (`docs/decisions/2026-11-08-image-box-design.md`). The main GPU's chat model stays text-only, and everything here is off until its URL is set.

**Looking at photos** *(opt-in: `LOCALCODE_VISION_URL`)*. A photo attached in a project chat is looked at once, in the background, by the vision model on that box's Ollama (`LOCALCODE_VISION_MODEL`, default `qwen3-vl:8b-instruct`). It reads the visible text first, then the state of lights, ports and selections, then gives a description. What it saw reaches both the next turn and the project's knowledge. The `LookAt` tool asks one aimed question and splits a large photo into tiles. Unset, looks are refused with "no vision model configured" and the chat stays text-only. See `engine/vision/CLAUDE.md`.

**Painting pictures** *(opt-in: `LOCALCODE_COMFYUI_URL`)*. An Image on a RenderUI surface can carry a `prompt` instead of a URL. In a project chat the engine paints it on your ComfyUI server, and the picture is kept in the project's `images/` folder with how it was made:

- The card shows a placeholder at once, and the picture fills in when it is ready.
- A prompt may be as long as the design needs.
- The same prompt with another whole-number `seed` is another take of it. The same prompt and seed is the same picture, never painted twice.
- Up to 18 pictures are painted per surface, one at a time, and the tool result says how long the wait is.

The chat never drives ComfyUI itself. The prompt tells it to ask with an Image, and a Bash command or a file that would drive the server is refused (F176). Check the setup with `bun engine/imagegen/check.ts`.

**Changing a project photo.** An Image with a `source` photo and a `transform` changes the photo:

- `vary`: vary it toward a prompt.
- `outline`: turn it into a tracing sheet to paint from.
- `edit`: change it as an instruction says (add, remove, replace). `outline` and `edit` both run on the built-in Qwen-Image-Edit-2509 graph.
- A redo of an `edit` or `outline` carries `fix`: what came out wrong, in your words.

The workflows can be replaced with `LOCALCODE_COMFYUI_WORKFLOW_VARY`, `_OUTLINE` and `_EDIT`. See `engine/imagegen/CLAUDE.md`.

### Local tokens

The engine mints `~/.cynco/tokens.json` at startup. The file is owner-only: on Windows the ACL is narrowed with `icacls`, since `chmod 0600` there is close to a no-op. Every token has one record shape, which carries a scope vector, rather than one key type per capability:

| Scope | Opens | Reaches its holder by |
|---|---|---|
| `bridge` | The TUI command channel on the bridge port. This drives the agent, and the agent has Bash. | Read from the token file. The TUI, the mission driver and the probes all do this, so launching any of them takes no arguments. |
| `inference` | Every dashboard read route, plus the dashboard WebSocket. That covers session transcripts, thinking tokens, governance, and the Chat tab's own send path. It also opens the day-to-day writes: project uploads and edits, moving or pausing a mission, and reading the apps list. | Injected into the dashboard page at request time. |
| `management` | Anything that changes engine or governance configuration: `POST /config/*`, `/api/brain/layer`, phone pairing and devices (`/api/phone*`), and switching an app (`/api/apps*` other than GET). | Printed once at engine startup and pasted by hand. Never handed to a page. |
| `inference`, held by a paired device (`device-…`) | The same read routes, socket, Chat send path and day-to-day writes as the page, and nothing else. Off this machine only a device record authenticates, so management is refused there whatever is presented. | Minted when a phone pairs with the single-use code. Kept in that browser's local storage. Revoked from Config → Phone access. |

The split is not ceremony. The inference token is delivered to a browser, so it is the secret most likely to escape. Flipping `ablation` or `contractEnforcement` silently corrupts the measurements the research rests on, so that costs a deliberate paste. A management token also reads, because the `admin` holder carries both scopes.

**The `inference` scope opens a send path, so it is bounded by an allowlist too.**
The Chat tab has to be able to talk to the agent, since that is the feature, so the dashboard socket forwards frames. Which frames is not left to the page: `dashboardCommandRefusal` in `engine/dashboard/server.ts` asks two separate questions, in order:

1. *May a browser send this kind of frame at all?* There is an allowlist of eleven frame types and fifteen slash commands, every one of them read-only or no more privileged than typing the same sentence.
2. *Is the frame the shape that kind is declared to have?* This is `validateCommand`, the same schema check the bridge entrance runs.

Authority comes first, because a perfectly well-formed `/approve-all` has to be refused for what it is, not for how it is spelled.

Absent from the allowlist, deliberately: `/approve-all`, `/skill` (it installs and deletes on disk), `/quit` and `/exit`, `/model`, `/reset` (it clears the governance kill switch), `/undo`, `/compact`, `/commit`, `/export`, `/analyze` and the `/audit-*` family. A refusal is logged rather than silently dropped. A boundary nobody can see is indistinguishable from a socket that lost the frame.

Two more things follow from this that are easy to get wrong:

- **Nothing here is protected by CORS.** A WebSocket handshake is not subject to CORS at all. And `Content-Type: text/plain` makes a POST a "simple" request, which lands without a preflight. The tokens are the control. Loopback binding is a floor, and a browser is already inside loopback.
- **Off this machine the shared token is never handed out.** A client that is not a loopback peer on the loopback listener gets the page with no token in it, and must pair (see [Phone access](#phone-access)). The `dashboard` and `admin` secrets are refused there as unknown.
  - `0.0.0.0` is still the wrong bind: it would put the pairing gate on every network you are on. Bind the Tailscale address and nothing else.
  - Pinned by `engine/__tests__/dashboard/phoneAccess.test.ts`.

### Phone access

The dashboard is the phone client: the same page and the same engine, over your Tailscale tailnet. That is the posture the liveness daemon already uses: no public port, never `0.0.0.0`, never Funnel. Design and rejected alternatives: [docs/decisions/2026-10-22-phone-access.md](docs/decisions/2026-10-22-phone-access.md).

1. Install Tailscale on the CynCo box and on the phone ([docs/liveness-setup.md](docs/liveness-setup.md) §2). `tailscale ip -4` gives the box's address.
2. Start the engine with `LOCALCODE_DASHBOARD_HOST=127.0.0.1,<that address>`.
   - On the desk, **Config → Phone access** (management token) shows the phone URL and a six-digit pairing code.
   - The engine's log prints both too. That is `.cynco-engine.log` in the project folder when the TUI launched it.
3. On the phone, open the phone URL, type the code once and name the device. Bookmark that exact address: a different spelling is a different origin, and pairs again.
   - The engine appends a `device-…` record to `~/.cynco/tokens.json` (`inference` scope), and the browser keeps its secret in local storage.
   - Each code works once. Five wrong codes close pairing for ten minutes.

What a paired phone can do is what the desk page can do: chat, watch tool activity, answer approval cards and AskUser questions, and press **Stop**. It cannot change configuration: management is refused off this machine whatever token is presented, and the phone is never asked for the management token. A paired phone is therefore equivalent to a terminal on this machine, Bash approvals included. Revoke a lost phone under Config → Phone access, and its page returns to pairing at once.

**What the phone sees.** A remote page lands in Projects and shows four tabs: Chat, Projects, **Away** and Missions. Away lists what the missions did while you were out: time, mission, trigger, ok or FAILED, and a summary, from every mission's `runs.jsonl` via `GET /api/away`.

The layout is one column, with the send box pinned to the bottom. A page whose socket dropped, for example a phone locked mid-answer, is sent what it missed, in order, once. The headless phone engine runs with `LOCALCODE_BRAIN=off` (no jlens sidecar, no activation tap). The desk page is unchanged.

**Files from the phone.** While a project is bound, an **Attach** button beside the send box takes files or a camera photo straight into that project's knowledge. It uses the same upload route as the Projects tab. The chat says what was added and whether it indexed, and with a vision model configured a photo is looked at too ([The image box](#the-image-box-vision-and-pictures)).

**Told when it waits** *(opt-in: `CYNCO_NTFY_URL`)*. When an approval or an AskUser question has been open for 5 s with no page connected, or for 60 s in any case, one ntfy notice goes to the phone. Tapping it opens the dashboard at the address the device last used.

**Device hygiene.** The same panel shows, per device, when a request last came from it and when it will be forgotten. A device nothing has arrived from for 30 days is removed on its own, and pairs again with a fresh code. The phone in daily use never meets this; an old tablet, or a browser profile nobody opens, does. **Revoke all** forgets every device at once and closes their pages, and when any device was paired it also mints a new pairing code. It is the button for "I am not sure what got out".

**Limit the port on the tailnet (optional, in the Tailscale admin console).** Pairing is what authenticates a device. A tailnet policy can also stop every other machine on the tailnet from reaching the dashboard port at all.

Tailscale's policy is allow-only, so the default "everything may reach everything" rule has to be replaced by rules that say the same thing *except* for that one port. Here is a sketch with this repository's addresses. Substitute the phone's and any laptop's tailnet IPs (`tailscale status`), and keep the doorman in `src`: it probes the dashboard to know the PC is awake (`scripts/doorman/`).

```jsonc
{
  "hosts": {
    "cynco-pc": "100.101.192.101",
    "doorman":  "100.110.117.10",
    "pixel":    "100.x.y.z"
  },
  "acls": [
    // the dashboard port: the owner's phone, and the doorman's wake probe — nobody else
    { "action": "accept", "src": ["pixel", "doorman"], "dst": ["cynco-pc:9161"] },
    // every other port on the CynCo box stays as open as it was
    { "action": "accept", "src": ["*"], "dst": ["cynco-pc:1-9160", "cynco-pc:9162-65535"] },
    // every other machine stays as open as it was: one entry per machine, or a tag
    { "action": "accept", "src": ["*"], "dst": ["doorman:*"] }
  ],
  "tests": [
    { "src": "pixel",   "accept": ["cynco-pc:9161"] },
    { "src": "doorman", "accept": ["cynco-pc:9161"] }
  ]
}
```

A machine left out of the last rule becomes unreachable over the tailnet. Here the NAS, the image box and ntfy on the doorman are all tailnet services, so list every one before saving. The admin console's preview and the `tests` block say what a change would cut off. A bridge port that walked moves the dashboard port, and this rule would then need the new number.

If the phone cannot connect:
- The Config panel, or the `[dashboard] phone listener` line in the engine's log, says whether the address bound. Tailscale being down at start is retried every 15 s.
- A bridge port that walked to `+1` moves the dashboard port, and the phone URL with it.
- Windows Firewall must allow `bun.exe` inbound on the Tailscale interface. The Config panel's "last phone request" says whether anything got through.

**HTTPS, and installing the page on the phone.** The page carries a web manifest and icons. Once it is served over HTTPS, Chrome on the phone offers **Install app**, and it opens like an app, full screen, from the home screen.

The HTTPS name is this machine's tailnet name (`<machine>.<tailnet>.ts.net`). `tailscale serve` provides the certificate and forwards to a port on `127.0.0.1`, the only target it supports. That port is **not** the dashboard's own: a forwarded request reaches it from `127.0.0.1`, which on the desk's listener is what is handed the shared token.

So the engine opens a second loopback listener for the proxy, `LOCALCODE_DASHBOARD_PROXY_PORT` (unset by default: no such listener). On it, every client is treated as off this machine: no token in the page, pairing, a device token, management refused.

`scripts\phone-https.ps1` does the set-up, and refuses to point `serve` at a port that answers like a desk listener. Without `-Apply` it only reports:

1. In the Tailscale admin console → DNS, enable **HTTPS certificates** (once per tailnet).
2. `scripts\phone-https.ps1 -Apply` sets `LOCALCODE_DASHBOARD_PROXY_PORT=9443` as a user variable.
   - Restart the engine: `scripts\cynco-services.ps1 stop engine`, then `start engine`.
   - Config → Phone access then shows an **HTTPS proxy target** row.
3. `scripts\phone-https.ps1 -Apply` again runs `tailscale serve --bg --https=443 http://127.0.0.1:9443` and prints the address.
4. On the phone, open `https://<machine>.<tailnet>.ts.net/` and pair once more. A new address is a new origin, so the token stored for the `http://100.x.y.z:9161` address does not apply. Then use the Chrome menu → **Install app**. The old address keeps working beside it.

`scripts\phone-https.ps1 -Off` stops serving. The address a paired device last opened the page on is kept with its record, so the wait notification's link still opens the dashboard after an engine restart. Push notifications from the page itself are a later increment.

### The Brain

The dashboard's **[Brain]** tab exposes what the model is doing internally, at three depths:

**Thinking stream (default-on).** Thinking tokens are persisted per turn and rendered in the Brain tab's turn browser. It is wired in `engine/bridge/conversationLoop.ts`, where `finalizeTurn` stores each turn's thinking text. No configuration is needed.

**Entropy trace (default-on in interactive sessions).** Every generated token carries its top-8 logprobs. The engine computes per-token entropy and streams it as a live sparkline (`brain.uncertainty`, and `brain.toolUncertainty` for tool choices), with a hover readout of the runner-up tokens.

It is requested in `engine/ollama/client.ts` and `engine/llama/provider.ts`. On llama.cpp it is off for one-shots and unattended missions unless `LOCALCODE_ENTROPY_TRACE=1`. It also turns itself off for the session when a stock llama-server rejects the logprobs request. When there is no logprob data the sparkline stays empty, and everything else keeps working.

**Concept workspace (setup-required).** A J-lens readout (`softmax(W_U · rmsnorm(J_ℓ h_ℓ))`) of mid-network activations, shown as a live ribbon of the concepts the model is holding at each layer. `engine/brain/activationsConsumer.ts` probes both dependencies at startup, and again on a timer, so a sidecar that starts late upgrades the tier. The tab's badge reports the tier: `live`, `record-only` or `entropy-only`. To enable the full `live` tier:

1. Download the lens artifacts: `cd jlens && python -m jlens_service.download`. The lens is the one precomputed for Qwen3.6-27B (`JLENS_MODEL_REPO`); on the Qwen3.8 default it reads 3.8's activations through 3.6's lens.
2. Set `LOCALCODE_JLENS=on`. The engine then starts the sidecar itself (port 9163) when the artifacts are there and the provider is llama-cpp.
3. Build the patched llama-server, with its activation tap and `/activations` route (the patch is in `docs/research/llamacpp-activation-tap.patch`). Deploy it to `~/.cynco/bin-brain/llama-server.exe` with its CUDA DLLs alongside. The engine picks that build up on its own and sets `LLAMA_ACTIVATIONS_LAYERS=24,32,40,48,56` for it. `LOCALCODE_LLAMA_SERVER` points at a build somewhere else.

Without step 3 the tab runs `entropy-only`; without step 2 it runs `record-only`. Nothing breaks either way.

### Always-on missions

CynCo can run as a persistent agent. A tiny daemon (`engine/daemon/`) never loads a model itself. It ticks scheduled mission triggers, for example "watch my fantasy league", and when one is due it starts a real governed engine run as a one-shot in its own process. It pushes digests and recommendations to your phone through self-hosted [ntfy](https://ntfy.sh) over Tailscale, and takes back approve/reject taps and free-text replies, with no public ports. Setup and the mission file: [docs/liveness-setup.md](docs/liveness-setup.md).

- **Each mission** has its own `mission.json`, with triggers, the tools it may use, its working folder and a time limit. A `precheckCommand` can skip loading the model when there is nothing to do.
  - A mission aimed at a project folder files its answer in that project's inbox, as a draft.
- **Schedule control without a restart.** From the dashboard's Missions tab, on the desk or the phone, or from the desk widget, you can:
  - move a pass, switch it off, or pause the whole daemon;
  - Resume, which picks up from now.

  The changes live in `schedule.json` beside `mission.json`, re-read every tick (`docs/decisions/2026-11-08-mission-schedule-control.md`).
- **The desk widget** (`scripts\cynco-widget.cmd`) is a small window. It shows whether CynCo is up, who holds the GPU, and one row per mission, with buttons to pause, resume or stop.
- **The services script** reports on and manages every background task: `scripts\cynco-services.ps1 status | start | stop | register`. It covers `engine` (the headless phone engine), `embed`, `daemon`, `watch` (the box reporter) and `listener`, and also reports whether ntfy on the doorman answers.

### Wakefulness and the household

The PC with the big GPU does not have to stay on. CynCo keeps it awake only while there is work, lets Windows' own timer put it to sleep, and gets it woken again when it is needed (`docs/decisions/2026-11-08-wakefulness-design.md`; `engine/power/CLAUDE.md`). Status: built 2026-11-08. The live proofs still owed are listed in [docs/NOW.md](docs/NOW.md).

- **Awake only while busy** *(default on, Windows)*. The engine tracks every open turn, one-shot, in-flight model request and queued picture. While any is open it holds the machine awake (`scripts/hold-awake.ps1`), and it lets go when the last one closes. Nothing in CynCo ever puts the machine to sleep.
- **A cold GPU until a message needs it** *(opt-in: `LOCALCODE_LLAMA_LAZY=true`)*.
  - The model loads before the first request, not at boot.
  - With `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` it unloads after that long with nothing open, taking a slot snapshot first so the conversation comes back warm.
  - While the daemon's one-shot owns the GPU (`~/.cynco/gpu-busy.json`), a lazy load waits and says so, instead of killing that server.
  - The headless phone engine runs this way.
- **One engine in the phone engine's seat.** A desk engine stops the headless phone engine before loading its model, and starts it again on exit. A second engine on another bridge port or `CYNCO_HOME` leaves it alone (F224).
- **A busy fallback** *(opt-in: `LOCALCODE_FALLBACK_URL`)*. When the GPU is held, requests go to Ollama on another box (`LOCALCODE_FALLBACK_MODEL`, default `qwen3:14b`), and the chat says so. "Held" means a one-shot is running, another engine's server is on the port, or a server CynCo may not stop is there.
- **The doorman** *(optional, an always-on mini PC; Python standard library only)*. It wakes the PC with wake-on-LAN for a phone knock on its page, or about three minutes before each scheduled trigger; the daemon publishes its wake schedule to it (`CYNCO_DOORMAN_URL`). It can wake the image box alongside. It also runs ntfy and a NAS watchdog. Setup: [docs/liveness-setup.md](docs/liveness-setup.md) §7; code: `scripts/doorman/`.
- **The watcher, the metasystem's always-on part** *(optional; live since 2026-11-12; observation only)*.
  - The box reporter (`engine/power/reporter/`, `LOCALCODE_WATCHER_URL`, the `watch` task) pushes the PC's state to the watcher on the doorman: its sleeps and wakes, GPUs, loaded models, services and jobs.
  - The watcher keeps it in one SQLite file, and serves a daily note with charts on port 9171, on a page that takes no input.
  - It finds what is wrong in two ways, both deterministic:
    - *By construction:* a wake with no knock behind it, a wanted service down, a model loaded and unused, a silence.
    - *By comparison:* a rolling median plus CUSUM.
  - It never acts on any box. Your answers to a finding ("that was me", "that is normal now") are not built yet.
  - Design: `docs/decisions/2026-11-11-metasystem-design.md`; setup: [docs/liveness-setup.md](docs/liveness-setup.md) §8.

### Your other local-LLM apps

Your other local-LLM projects (a game, a screenplay tool, a pay-equity service) start model servers of their own. CynCo treats them as parts of one system (`engine/apps/CLAUDE.md`; `docs/decisions/2026-11-11-local-llm-apps.md`):

- **The GPU hand-off** *(default on)*. When CynCo needs the GPU and an app's model server holds CynCo's model port, CynCo names the app in the chat, stops that server, and starts it again when its own work is done. This works for a chat turn and for a daemon one-shot.
  - An app on Ollama gets its model unloaded instead.
  - Apps are found from the live process tree and kept in `~/.cynco/apps.json`. `"manage": false` on an entry leaves that app's server alone.
  - CynCo never stops a server it has not identified. An app started as administrator is named, and neither stopped nor waited behind (F223).
- **The Missions tab** lists the apps, what each holds, and its switch.
- **Desktop icons.** `bun scripts/cynco-apps.mjs icons --repo <checkout>` makes an icon per app that has a `start` recipe on its registry entry. The icon starts the whole app through one launcher. Never Docker on this PC beside the models (F227).

Status: the hand-off was seen live on 2026-11-12 for an app started from a normal window. The icons have not yet been used against the real apps.

### Autonomous missions & calibrated-gate supervision

CynCo's proving ground is the unattended mission: one long-horizon brief, no user round-trips, graded at a sealed gate.

`scripts/dispatch-mission.sh <brief> <marker> [cwd] [timeout-s] [check-cmd] [probe-cmd]` boots a fresh engine. `scripts/cynco-mission-driver.mjs` then drives the run until a marker commit lands, a timeout closes it, or the engine goes quiet. In a mission, S5 acts only on rules that have earned authority (see [Governance](#governance-vsm-s1s5)). The harness around it:

- **Outcome ledger.** Every mission appends one labeled row to `benchmark/cynco-ledger/missions.NNNN.jsonl`. A row carries:
  - the outcome and the check-cmd verdict;
  - the exact commit range and per-tool call stats;
  - token counts measured from the server's own timings;
  - a separately-patched mutation-sweep label.

  An unmeasured mission is never defaulted to a passing one. Schema and labeling rules: [benchmark/cynco-ledger/README.md](benchmark/cynco-ledger/README.md).
- **In-loop probe (Stage 1).** Pass a cheap probe command, and the driver runs it at quiescent turn boundaries after each landed commit.
  - A FAIL's verbatim tail is injected back into the conversation as a user message.
  - Injections are capped by `CYNCO_MAX_PROBE_OVERRIDES` (default 3), and the probe fails closed on `CYNCO_PROBE_TIMEOUT_MS`.
  - The probe's full history lands in the ledger row's `probe` block.
- **Sealed, calibrated gates.** Success is graded by held-out gate scripts kept outside the supervised repository. Before dispatch, every gate must FAIL cleanly on the base commit, and still FAIL against a cheat-stub perturbation. A gate that errors on the base measures nothing, and a gate a trivial stub can pass cannot tell real work from fakery.
- **Measured supervision economics.** `scripts/supervision-economics.mjs` accounts real frontier-model supervision spend against API-priced displaced generation.
  - Through campaign C5 (54 supervised missions: the five campaigns and 40 earlier ones), $1 of frontier supervision oversaw ~$1.39 of displaced generation, and the honest band is ~$1.0–1.4.
  - That generation ran locally for ~$9.34 of electricity, ~349× cheaper than API pricing. Method, campaigns and failure modes: [docs/supervision-economics-paper.md](docs/supervision-economics-paper.md).
  - After C11 wave 2 the running figure is ~$1.98 per supervision dollar, with ~$5,920.56 displaced for ~$25.05 of power ([campaign log](docs/civkings-redesign-briefs/campaign-log.md)).
- **Failure-log discipline.** Every harness failure gets an F-number, a root cause and a fix in [docs/cynco-failure-log.md](docs/cynco-failure-log.md). The rule: never fail the same way twice.

#### Campaigns

A campaign is a series of mission waves toward one sealed gate, driven by one command:

```bash
bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c11.campaign.json [--waves N] [--resume] [--dry-run] [--scoreboard] [--autopoiesis]
```

The runner does the whole loop:
- It calibrates the gate and dispatches each wave.
- It grades partway through a wave and at its end, against the sealed gate and the repository's own suite.
- It runs a mutation sweep over the wave's diff, and writes the verdict.
- It retrains the outcome learner, and stops on PASS.

Two regulators watch in shadow (`R1.no-progress`, `R2.stalled`). `--author` has the machine draft the next campaign's sealed gate, and `--approve-proposal gate/<id>` seals what it staged. A campaign runs from its own worktree on branch `campaign/<id>` (F167).

The record of every wave is [docs/civkings-redesign-briefs/campaign-log.md](docs/civkings-redesign-briefs/campaign-log.md). The scoreboard (`scripts/cynco-scoreboard.mjs`) reports pass rate per GPU-hour, waves per campaign, gate lines fixed per landed wave, human interventions per wave, and per-rule precision. `scripts/cynco-signal-validation.mjs` asks whether a rule fires more often on missions that fail, and `scripts/cynco-rule-verdicts.mjs` writes the verdict file S5's authority reads.

### Semantic Code Index
**Requires an embedding server.** Vector indexing needs an embedding model running somewhere; it is not served by the chat model. The engine speaks both wire formats: Ollama's `/api/embed`, and the OpenAI-shaped `/v1/embeddings` that `llama-server --embeddings` and most local servers expose. It tries each until one answers, or you pin one with `LOCALCODE_EMBED_API=ollama|openai`.

It looks for a server in this order:
1. `LOCALCODE_EMBED_BASE_URL`.
2. The chat URL, if the chat provider is Ollama.
3. `http://localhost:11434`.

If nothing answers you get keyword search. The engine says so once in the chat, as well as on `context.status`, and says again when the server is back.

On the CynCo PC the embedding server is CynCo's own (`docs/decisions/2026-11-08-embeddings-own-llama-server.md`):
- `scripts/run-embed-server.cmd` runs `llama-server --embeddings` on the `nomic-embed-text` GGUF at `127.0.0.1:9165`, CPU only.
- It runs as the logon task "CynCo embed server" (`scripts/cynco-services.ps1 register embed` / `start embed` / `status`).
- The engines find it through three permanent user variables: `LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165`, `LOCALCODE_EMBED_API=openai` and `LOCALCODE_EMBED_MODEL=nomic-embed-text`. The model name is kept so existing project stores are reused.
- Ollama is no longer needed on that PC for embeddings.

Retrieval is **symbol-first**:

- ~85% of real Grep queries are exact-identifier lookups. Routed through cosine similarity like prose, those scored 63% top-3 against Grep's 92%.
- So identifier-looking queries hit the AST symbol table first (`engine/index/symbolLookup.ts`). They get back the definition (full body, `file:line`) plus ranked references in one call, an answer Grep structurally cannot give.
- Prose queries fall through to the **BM25 + dense RRF hybrid**, over an AST-boundary-aware tree-sitter chunker.
- A **repo map** (PageRank over imports) is injected on the first turn, capped at ~2k tokens.
- Index degradation is surfaced on `context.status` (`indexMode` / `indexDegraded` / `lastQueryMode`).

### Workflows
Structured multi-phase workflows with tool restrictions and advancement gates:
- `/research`: multi-source research with citations.
- `/tdd`: test-driven development (red-green-refactor).
- `/debug`: systematic problem diagnosis.
- `/review`: structured code review.
- `/plan`: implementation planning.
- `/brainstorm`: idea exploration.
- `/critique`: critical analysis.

### Skills
Shareable, self-contained capability packs. A skill is a directory with a `SKILL.md` (YAML frontmatter plus prose instructions) that declares the tools it needs.

Skills are discovered from two locations:
- Bundled builtins, in `engine/skills/builtins/`.
- Your workspace, `~/.cynco/skills/` (`$CYNCO_HOME/skills/` when `CYNCO_HOME` is set). A workspace skill overrides a builtin of the same name.

A name-sorted index of the available skills is surfaced in the prompt. The model calls `run_skill` to load a skill's full instructions and its declared tools on demand, or `list_skills` to enumerate them.

The seven guided workflows above ship as builtin skills: `tdd`, `debug`, `review`, `plan`, `brainstorm`, `critique` and `research`. `run_skill("tdd")` and the `/tdd` slash command are aliases. Both drive the same phase-gated workflow engine, so the workflow keeps its state machine (per-phase instructions, gates, allowed tools) rather than collapsing into flat prose.

Manage skills with the `/skill` slash command:
- `/skill list`: show discovered skills.
- `/skill new <name>`: scaffold a new skill (`~/.cynco/skills/<name>/SKILL.md`).
- `/skill install <owner>/<repo>[/subdir][@ref] --yes`: install from a GitHub zipball. No git binary is needed.
- `/skill remove <name>`: delete a workspace skill.

Install and remove both write to disk on the strength of a name someone else chose, so both are bounded rather than trusted:

- **Install shows you the payload before it asks.** A skill body is prose that gets handed to the model as instructions, and a confirmation prompt that summarised it was asking you to approve something you had not read.
  - The confirmation quotes the first `BODY_PREVIEW_LINES` (40) of the body verbatim, alongside the declared tools and the source, and says when it has truncated.
  - The zip's own subdirectory is resolved through `assertInside`, so a `../` in an archive path cannot escape the extraction root.
- **Remove takes only a lower-kebab-case name**, then resolves it inside the workspace skills folder. `/skill remove ../../..` gets a refusal, not a recursive delete.

### Tools (34 built-in)
Read, Write, Edit, MultiEdit, ApplyPatch, ReplaceFunction, Bash, Git, Glob, Grep, Ls, CodeIndex, WebSearch, WebFetch, ImageView, NotebookEdit, SaveLearning, SubAgent, CollectAgent, AskUser, IndexResearch, Mfl, ContractCreate, ContractAssertPass, ContractAssertFail, ContractStatus, RenderUI, ProjectSearch, SaveArtifact, AddToKnowledge, LookAt, load_tools, run_skill, list_skills

**On-demand loading.** Tools are split into a **core** set, offered to the model every turn, and an **extended** set, loaded on demand.
- `load_tools`, `run_skill` and `list_skills` are themselves core: they are the loading mechanism. When the model needs an extended tool it calls `load_tools` with the tool names, or a skill it runs declares them. They are then callable for the rest of the session.
- This keeps the default prompt small, and the append-only prompt-cache prefix intact, without losing any capability.
- The four project tools are offered in project chats.
- Set `LOCALCODE_ALL_TOOLS=true` to surface every tool up front and skip on-demand loading. That is best for cache-sensitive batch runs.

Every tool call passes the safety checks and the sealed-path guard in `engine/tools/`. A mission's gate files are immutable to the agent (`LOCALCODE_IMMUTABLE_PATHS`), and a doom-loop detector watches for repetition.

### Session Persistence
- **JSONL journaling.** Every message is saved, and survives crashes.
- **Handoff system.** The goal, progress, learnings and next steps persist across sessions.
- **Memory.** `SaveLearning` writes to a bitemporal learning store. Recall ranks learnings by relevance, recency (a half-life) and importance, with a bonus for promoted ones; the weights are the `LOCALCODE_RECALL_*` variables. A wrong learning is demoted, never deleted, and saving one twice counts as reinforcement (`engine/memory/CLAUDE.md`).
- **Adaptive Working Memory (AWM).** Session learnings are promoted into a durable ACE-style playbook only when the session can show it achieved something:
  - every Definition-of-Done contract it opened resolved, with no failed or unverified assertions;
  - and at least one assertion passed.

  A session that opened no contract promotes nothing. The gate and its limits are in `engine/memory/promotionGate.ts`. Assertions about files and commits are checked against the repository, but an engine-inferred contract can also pass an assertion on the model's own report, so this is a floor and not a proof. Promoted entries are recalled (capped at ~5) at the start of later sessions.
- **Compaction that keeps the goal.** At context overflow, recent user messages and the active Definition-of-Done contract are anchored verbatim through summarization, with durable facts flushed first, so constraints aren't silently erased.
- **Decision journals.** S1–S5 decisions are logged as training data (JSONL).
- **Governance DB.** SQLite, with session outcomes and per-turn measurements.

---

## Fine-Tuned Models (Coming)

CynCo collects governance decision data during every session, per VSM system, in `~/.cynco/training/s{1-5}-decisions.jsonl` (`engine/training/decisionJournal.ts`). This data is the foundation for fine-tuned models that would replace the rule-based governance with learned governance. The pipeline that builds datasets from it is `bun run engine/training/runTraining.ts --stage stats|dataset|sft|full`. It builds SFT and DPO data behind a readiness gate, redacts secrets before anything is stored, and vetoes a run that changed its own tests (`engine/training/CLAUDE.md`).

### S5 Decision Model
The first fine-tuning target. Today CynCo uses a rule-based S5 with 21 hand-written rules. The decision journal collects every S5 decision with the full governance snapshot: context usage, tool success rate, variety balance, stuck turns and so on.

**Status:** not yet trainable. The label path now exists; the volume does not.

A journal line is `{ timestamp, sessionId, system, input, decision, outcome? }`. Until 2026-07-28 no S5 decision ever carried an `outcome`:

- The S5 writer omitted it, since a policy decision has no result at the moment it is made.
- `DecisionJournalWriter.backfill()`, which exists to patch one in afterwards, had a single call site, in `engine/agents/s2Coordinator.ts`, for S2.

The only label was the one `engine/s5/exportTrainingData.ts` joined out of `governance.db` on `sessionId`. That is a *session*-level verdict stamped onto every decision the session made. It is enough to discard sessions that went badly, but it cannot tell two close calls inside one session apart.

Each S5 decision now carries three things it did not before:

- **`decisionId`**: a UUID, journaled inside the decision, and the join key for the outcome. The pre-existing `entryTimestamp` key cannot work here: `makeJournalEntry` reads the clock itself, so the writer never learns the line's timestamp.
- **`ruleIds`**: which of the 21 rules fired.
- **`rejected`**: rules that fired and were *overridden* by `combineDecisions`. The merge is lossy on purpose (`model` takes the first non-null, `tools` intersects), and these losers are the only negative examples the rule engine produces. A rule returning `null` is not among them: its condition was simply false, so it proposed nothing.

`S5Orchestrator.evaluateLastDecision()` writes the per-decision outcome, keyed on `decisionId`, from the measured change in `stuckTurns` and `toolSuccessRate`. When governance reports neither number, the outcome is written as **`unknown`**, not defaulted into a verdict.

The exporter treats outcomes this way:
- It drops decisions measured `negative`, even inside a viable session.
- It keeps `unknown` ones, where the session label remains the only evidence there is.
- When the verdict file exists, it also keeps only decisions whose every rule reads `PREDICTIVE`.
- It strips `decisionId`, `ruleIds` and `rejected` from the training *target*: they are evidence about the decision, not part of it.

So "500+ decisions" understates the requirement. It means 500+ with per-decision outcomes, and the counter starts from the date above.

**Goal:** a small adapter that makes better governance decisions than the hand-written rules: when to restrict tools, when to compact context, when to suggest model switches. The model sees the full governance state and outputs a coherent S5Decision. `scripts/fine_tune_s5.py` trains it, by default on `unsloth/Qwen2.5-3B-Instruct-bnb-4bit`, and `LOCALCODE_S5_MODEL` serves it, falling back to the rules on any error.

### Tool Selection Model (S1)
The S1 journal records every tool call with its outcome: 87,119 lines on the development PC as of 2026-11-13. It could train a model that picks better tools for a given context than the current LLM prompt does.

### Coordination Model (S2)
Agent scheduling decisions, with GPU utilization, queue depth and agent outcomes. It could train a model that schedules sub-agents more efficiently.

### Validation
Fine-tuned models will be validated against the rule-based system before deployment:
- A/B testing on real coding tasks, where the governance DB records both outcomes.
- A fine-tuned model must match or exceed the rule-based success rate before it replaces the rules.
- Ablation mode (`_ABLATION_VSM_DISABLED=1`) provides the baseline comparison.

Fine-tuned model adapters will be published on HuggingFace when validated.

---

## Configuration

Three layers, in order of precedence:

1. **Environment variables**: `LOCALCODE_*`, listed below. These win over the profile, with one exception, described below.
2. **A YAML profile**, searched in this order:
   - `.cynco/profiles/<name>.yaml` in the project;
   - then `~/.cynco/profiles/<name>.yaml`;
   - then the one that ships with the engine, at `engine/profiles/templates/default.yaml`.

   `LOCALCODE_PROFILE` picks the name; unset means `default`. Profiles compose through `extends:`.
3. **Built-in defaults**: the fallbacks compiled into the engine. Most are in `engine/config.ts`; the llama-server ones are in `engine/llama/processManager.ts`.

Nothing has to be configured to start. With no environment and no profile of your own, the shipped profile supplies the model and provider the Quick Start installs. Setting a variable overrides the profile for that one field and nothing else.

**The exception: llama-server launch knobs.** For these, a profile's `runtime:` value beats the environment variable, which applies only when the profile does not name the key (`engine/bootstrapProvider.ts`):
- `batch_size`, `gpu_layers` and `flash_attn`;
- `cache_ram`, `ctx_checkpoints` and `checkpoint_min_step`;
- `ubatch_size` and `reasoning_budget`.

`spec_type`, `spec_draft_n` and `context_length` follow the usual order.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALCODE_MODEL` | from profile (`qwen3.8:27b`) | Model name. Not required: the profile supplies it. |
| `LOCALCODE_BASE_URL` | `http://localhost:11434` | The Ollama (or OpenAI-compatible) server URL. |
| `LOCALCODE_PROVIDER` | from profile (`ollama`) | Provider: `ollama`, `llama-cpp`, `lmstudio`, `vllm` or `openai-compat`. With no profile at all, the built-in fallback is `llama-cpp`, which needs `LOCALCODE_MODEL_PATH`. |
| `LOCALCODE_MODEL_PATH` | — | The GGUF for the llama-cpp provider (or a profile's `model_file`). |
| `LOCALCODE_EMBED_MODEL` | `jina-code-embeddings-0.5b` | Model for code indexing. Falls back to `nomic-embed-text`, the one to pull on Ollama. |
| `LOCALCODE_TEMPERATURE` | `1.0` from the shipped profile (built-in `0.7`) | Sampling temperature. |
| `LOCALCODE_CONTEXT_LENGTH` | `65536` from the shipped profile; with no profile value, `131072` on llama-cpp and auto-detected on Ollama | Override the context window. It wins over a profile's `context_length`. `LOCALCODE_CACHE_RAM` is derived from whichever value ends up in force. |
| `LOCALCODE_ALL_TOOLS` | `false` | Surface every tool up front, instead of loading extended tools on demand via `load_tools`. |
| `LOCALCODE_S5_ENFORCE` | `true` | With no verdict file, whether S5 decisions are applied in an interactive session (`false` caps S5 at recommending). An advisory decision is never applied, whatever this says. See [Governance](#governance-vsm-s1s5). |
| `LOCALCODE_S5_PROACTIVE_TOOLS` | `false` | **Opt-in.** Let the S5 policy engine pre-load task-relevant tools before the model asks (for example, surface `Bash`, `Grep` and `Read` for a debugging request). Append-only: it never restricts. |
| `LOCALCODE_SEARXNG_URL` | — | SearXNG instance URL for research. |
| `LOCALCODE_S5_MODEL` | — | A fine-tuned S5 model served by Ollama, once one exists. It falls back to the rules on any error. |
| `LOCALCODE_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address, or a comma-separated list. The first entry is the desk's listener. Each further one (your Tailscale address) is a phone listener on the same port, whose clients must pair; see [Phone access](#phone-access). Never `0.0.0.0`. |
| `LOCALCODE_BRIDGE_HOST` | `127.0.0.1` | TUI bridge bind address. `0.0.0.0` puts the agent's command channel on the network, behind nothing but the bridge token; see [Local tokens](#local-tokens). |
| `LOCALCODE_BRAIN` | `on` | `off` means this engine starts no jlens sidecar and no activations consumer, and the Brain tab says so. The headless phone engine sets it. |
| `LOCALCODE_JLENS` | `off` | `on` starts the J-Space lens sidecar (Python, gigabytes of RAM) with the engine. When off, the Brain tab runs the entropy and activation tiers only, and says how to turn the lens on. |
| `LOCALCODE_LLAMA_LAZY` | `false` | `true` means the engine does not load the model at boot: the provider loads it before the first request. While the daemon's one-shot owns the GPU (`~/.cynco/gpu-busy.json`), it waits and says so, instead of killing that server. The widget's headless phone engine sets this; missions and the TUI keep the eager start. See `docs/decisions/2026-11-08-wakefulness-design.md`. |
| `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` | `0` (never) | With the lazy engine: unload llama-server (slot snapshot first) after this many ms with no open turn, one-shot or request. The next message loads it again. |
| `LOCALCODE_LLAMA_LAZY_WAIT_MS` | `1800000` | How long a lazy load waits for a busy GPU before the request fails with "GPU busy: waited N min for <trigger>". |
| `LOCALCODE_FALLBACK_URL` | unset | An Ollama base URL on another box (the 4070 Ti Super at `http://192.168.0.47:11434`). Requests go there instead of waiting when the GPU is held: a one-shot owns it, another engine's server holds the port, or a server CynCo may not stop is there. The chat says so. Unset means wait. Slice 2b of `docs/decisions/2026-11-08-wakefulness-design.md`. |
| `LOCALCODE_FALLBACK_MODEL` | `qwen3:14b` | The model asked for on the fallback box. |
| `LOCALCODE_VISION_URL` | unset | An Ollama base URL on the image box (the 4070 Ti Super, `http://192.168.0.47:11434`) that serves the vision model. A photo attached in a project chat is looked at there once, in the background, and its text and description reach the next turn and the project's knowledge. Unset, looks are refused with "no vision model configured" and the chat stays text-only. `docs/decisions/2026-11-08-image-box-design.md`. |
| `LOCALCODE_VISION_MODEL` | `qwen3-vl:8b-instruct` | The vision model asked for on the image box. |
| `LOCALCODE_CACHE_RAM` | derived (`21504` at the default context on Qwen3.8-27B) | llama-server's host prompt-cache RAM (MiB). This is a ceiling on **system** memory, not VRAM. It is derived so that the budget always holds one complete conversation's checkpoints:<br>• from a stored live calibration, when there is one;<br>• else from the GGUF header;<br>• else from the measured cost of one checkpoint (`149.65 MiB + 4.02 KiB × context`), times `ctx-checkpoints`.<br>The cache is required for context-checkpoint rollback on hybrid models (Qwen3.6/3.8), so don't set it to `0`. Setting it explicitly overrides the derivation, which also means you own the F91 arithmetic. |
| `LOCALCODE_CTX_CHECKPOINTS` | `32` | Recurrent-state checkpoints, for prefix-cache rollback on hybrid DeltaNet models. `64` killed llama-server with `bad allocation` against a fixed 8192 MiB cache (F91). `LOCALCODE_CACHE_RAM` is now derived from this value, so raising it raises the budget with it. Pinning `LOCALCODE_CACHE_RAM` too re-creates F91 by hand. |
| `LOCALCODE_CHECKPOINT_MIN_STEP` | `256` | Minimum token spacing between checkpoints. |
| `LOCALCODE_UBATCH_SIZE` | `2048` | llama-server's physical prefill batch size. |
| `LOCALCODE_REASONING_BUDGET` | `256` | llama-server's reasoning token budget. Tuned on Qwen3.6, where more than 256 hurt tool-call accuracy and uncapped thinking wasted minutes. Qwen3.8's card asks for large budgets, so the profiles here set `reasoning_budget: 4096` (a profile value beats this variable). |
| `LOCALCODE_PROJECTS_HOME` | `~/cynco-projects` | Where projects-mode project folders live (see [Projects](#projects)). |
| `LOCALCODE_PROJECTS_EMBED_MODEL` | `nomic-embed-text` | Prose embedding model for project knowledge, artifacts and chats. Changing it rebuilds each project's store on its next write (journaled `index.rebuilt`). |
| `LOCALCODE_PROJECTS_RETRIEVAL_SHARE` | `0.15` | Share of the context window given to a project chat's per-turn `[Project knowledge]` block (clamped to 0.02–0.5). |
| `LOCALCODE_COMFYUI_URL` | — | The ComfyUI server that paints RenderUI Image prompts in project chats (for example `http://192.168.1.50:8188`; start ComfyUI with `--listen`). |
| `LOCALCODE_COMFYUI_WORKFLOW_VARY` | built-in | An API-format ComfyUI workflow for the `vary` transform: a photo in the project, varied toward a `prompt`. Placeholders as for `LOCALCODE_COMFYUI_WORKFLOW`, plus `{{image}}` and `{{denoise}}`. Empty means the built-in img2img graph. `docs/decisions/2026-11-08-image-box-design.md` §4. |
| `LOCALCODE_COMFYUI_WORKFLOW_OUTLINE` | built-in | The `outline` transform's workflow: a tracing sheet to paint from. It needs `{{image}}` and `{{prompt}}`, which the engine fills with the tracing-sheet instruction plus the model's extra guides. Empty means the built-in Qwen-Image-Edit-2509 graph, the same as `edit` (F195). |
| `LOCALCODE_COMFYUI_WORKFLOW_EDIT` | built-in | The `edit` transform's workflow: a photo changed as the `prompt` instructs (add, remove, replace). It needs `{{image}}` and `{{prompt}}`. Empty means the built-in Qwen-Image-Edit-2509 graph: `UnetLoaderGGUF` (`ComfyUI-GGUF` pack) on `Qwen-Image-Edit-2509-Q4_K_S.gguf`, the 4-step Lightning LoRA, and `qwen_2.5_vl_7b_fp8_scaled` + `qwen_image_vae` (F193). |
| `LOCALCODE_COMFYUI_CHECKPOINT` | — | The ComfyUI checkpoint to use. Unset, it picks an SDXL one (Juggernaut first) and logs the pick. |

### Full inventory

That table is a shortlist. The engine reads considerably more than it, and the complete list is generated from the source rather than written by hand:

<!-- BEGIN GENERATED ENV INVENTORY -->

<!-- Generated by scripts/generate-env-docs.mjs. Do not edit by hand.
     Regenerate with: bun scripts/generate-env-docs.mjs -->

Every `LOCALCODE_*` variable the engine reads — 101 of them — with the fallback
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
| `LOCALCODE_BRAIN` | *not derived* | — | `engine/brain/brainSwitch.ts` |
| `LOCALCODE_BRAIN_LAYER` | `40` | — | `engine/main.ts` |
| `LOCALCODE_BRIDGE_HOST` | `127.0.0.1` | — | `engine/bridge/server.ts` |
| `LOCALCODE_CACHE_RAM` | *not derived* | — | `engine/llama/processManager.ts` |
| `LOCALCODE_CHECKPOINT_MIN_STEP` | `256` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_COMFYUI_CFG` | `6` | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_CHECKPOINT` | *not derived* | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_SIZE` | `1024x1024` | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_STEPS` | `40` | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_TIMEOUT_S` | `300` | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_URL` | *not derived* | — | `engine/imagegen/config.ts`, `engine/projects/binding.ts` |
| `LOCALCODE_COMFYUI_WORKFLOW` | *not derived* | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_WORKFLOW_EDIT` | *not derived* | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_WORKFLOW_OUTLINE` | *not derived* | — | `engine/imagegen/config.ts` |
| `LOCALCODE_COMFYUI_WORKFLOW_VARY` | *not derived* | — | `engine/imagegen/config.ts` |
| `LOCALCODE_CONTEXT_LENGTH` | *not derived* | — | `engine/bootstrapProvider.ts`, `engine/config.ts` |
| `LOCALCODE_CTX_CHECKPOINTS` | `32` | — | `engine/llama/processManager.ts` |
| `LOCALCODE_DASHBOARD_HOST` | `127.0.0.1` | — | `engine/dashboard/server.ts` |
| `LOCALCODE_DASHBOARD_PROXY_PORT` | *not derived* | — | `engine/dashboard/server.ts` |
| `LOCALCODE_EMBED_API` | *not derived* | — | `engine/index/embedClient.ts` |
| `LOCALCODE_EMBED_BASE_URL` | `http://localhost:11434` | — | `engine/bridge/conversationLoop.ts`, `engine/index/embedClient.ts` |
| `LOCALCODE_EMBED_MODEL` | *not derived* | — | `engine/index/embedClient.ts` |
| `LOCALCODE_ENTROPY_TRACE` | *not derived* | — | `engine/missionEnv.ts` |
| `LOCALCODE_EXPERTISE` | `advanced` | `expertise` | `engine/config.ts` |
| `LOCALCODE_FALLBACK_MODEL` | *not derived* | — | `engine/llama/busyFallback.ts` |
| `LOCALCODE_FALLBACK_URL` | *not derived* | — | `engine/llama/busyFallback.ts` |
| `LOCALCODE_FLASH_ATTN` | `true` | — | `engine/config.ts` |
| `LOCALCODE_GPU_LAYERS` | `999` | — | `engine/config.ts` |
| `LOCALCODE_GRAMMAR_ENABLED` | `false` | — | `engine/dashboard/server.ts`, `engine/engine/callModel.ts` |
| `LOCALCODE_HOUSE_CONDUCT` | `false` | — | `engine/config.ts` |
| `LOCALCODE_HYBRID_SEARCH` | `true` | — | `engine/bridge/conversationLoop.ts`, `engine/index/indexer.ts` |
| `LOCALCODE_IMMUTABLE_PATHS` | *not derived* | — | `engine/tools/executor.ts` |
| `LOCALCODE_JLENS` | *not derived* | — | `engine/brain/brainSwitch.ts` |
| `LOCALCODE_JLENS_PYTHON` | `python` | — | `engine/brain/jlensSidecar.ts` |
| `LOCALCODE_JLENS_URL` | `http://127.0.0.1:9163` | — | `engine/brain/jlensClient.ts`, `engine/brain/jlensSidecar.ts` |
| `LOCALCODE_LEARNINGS_DB` | *not derived* | — | `engine/bridge/conversationLoop.ts`, `engine/main.ts`, `engine/tools/impl/saveLearning.ts` |
| `LOCALCODE_LLAMA_HEALTH_TIMEOUT_MS` | *not derived* | — | `engine/llama/processManager.ts` |
| `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` | *not derived* | — | `engine/llama/lazyLoad.ts` |
| `LOCALCODE_LLAMA_LAZY` | `false` | — | `engine/llama/lazyLoad.ts` |
| `LOCALCODE_LLAMA_LAZY_WAIT_MS` | *not derived* | — | `engine/llama/lazyLoad.ts` |
| `LOCALCODE_LLAMA_MIN_COMMIT_FREE_MIB` | *not derived* | — | `engine/llama/hostResources.ts` |
| `LOCALCODE_LLAMA_SERVER` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_MAX_ITERATIONS` | `0` | — | `engine/bridge/conversationLoop.ts`, `engine/dashboard/server.ts` |
| `LOCALCODE_MAX_OUTPUT_TOKENS` | `16384` | `max_output_tokens` | `engine/config.ts` |
| `LOCALCODE_MISSION_BASE` | *not derived* | — | `engine/dashboard/server.ts`, `engine/missionEnv.ts` |
| `LOCALCODE_MISSION_CHECK` | *not derived* | — | `engine/dashboard/server.ts`, `engine/missionEnv.ts` |
| `LOCALCODE_MISSION_CWD` | *not derived* | — | `engine/bridge/contractAutoCreate.ts`, `engine/dashboard/server.ts`, `engine/missionEnv.ts` |
| `LOCALCODE_MISSION_MARKER` | *not derived* | — | `engine/dashboard/server.ts`, `engine/missionEnv.ts` |
| `LOCALCODE_MODEL` | *not derived* | `model` | `engine/config.ts` |
| `LOCALCODE_MODEL_PATH` | *not derived* | — | `engine/config.ts` |
| `LOCALCODE_NATIVE_TOOLS` | `false` | — | `engine/engine/callModel.ts` |
| `LOCALCODE_NO_SCOUTS` | `false` | — | `engine/config.ts` |
| `LOCALCODE_OPTIMIZED_PARAMS` | *not derived* | — | `engine/vsm/cyberneticsGovernance.ts` |
| `LOCALCODE_PORT` | `8081` | — | `engine/config.ts`, `engine/daemon/main.ts`, `engine/daemon/taskRunner.ts`, `engine/power/reporter/main.ts` |
| `LOCALCODE_PROFILE` | *not derived* | — | `engine/config.ts`, `engine/main.ts` |
| `LOCALCODE_PROJECTS_EMBED_MODEL` | `nomic-embed-text` | — | `engine/projects/ingest.ts` |
| `LOCALCODE_PROJECTS_HOME` | `~/cynco-projects` | — | `engine/projects/layout.ts` |
| `LOCALCODE_PROJECTS_RETRIEVAL_SHARE` | `0.15` | — | `engine/projects/retrieval.ts` |
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
| `LOCALCODE_SLOT_SNAPSHOT_MS` | *not derived* | — | `engine/llama/processManager.ts` |
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
| `LOCALCODE_VISION_MODEL` | *not derived* | — | `engine/vision/settings.ts` |
| `LOCALCODE_VISION_URL` | *not derived* | — | `engine/vision/settings.ts` |
| `LOCALCODE_WATCHER_URL` | *not derived* | — | `engine/power/reporter/main.ts` |
| `LOCALCODE_WS_PORT` | `9160` | — | `engine/main.ts` |

<!-- END GENERATED ENV INVENTORY -->

---

## Why?

In 1971, Stafford Beer designed a cybernetic system for real-time economic coordination in Chile: [Project Cybersyn](https://en.wikipedia.org/wiki/Project_Cybersyn). The project was ahead of its time, with distributed sensing, algedonic alerts and variety management. The political context ended it, but the ideas didn't die.

Every major AI coding tool today sends your code to someone else's servers. You pay per token for the privilege of using your own data. One policy change, and your tools disappear.

CynCo runs on your GPU. Your code never leaves your machine. The governance system is Beer's mathematics, implemented in code and measured against outcomes rather than taken on faith: variety engines, algedonic signals, homeostatic balance, and policy that earns its authority on a ledger. It is real feedback control, and the project publishes the numbers on whether it helps, including when it doesn't.

One GPU. Zero API costs. Yours to keep.

---

## Credits

- **Stafford Beer**: the Viable System Model, the foundation of CynCo's governance.
- **Salvador Allende & Fernando Flores**: Project Cybersyn, the original vision for cybernetic governance.
- **Ross Ashby**: the Law of Requisite Variety, used in variety regulation.
- **Humberto Maturana & Francisco Varela**: autopoiesis, used in self-modification governance.
- **W. Ross McCulloch**: heterarchy, used in dynamic authority selection.
- [Ollama](https://ollama.com): local LLM runtime (MIT).
- [llama.cpp](https://github.com/ggml-org/llama.cpp): GGUF inference engine (MIT).
- [Textual](https://textual.textualize.io): Python TUI framework (MIT).
- [sqlite-vec](https://github.com/asg017/sqlite-vec): vector search for SQLite (Apache 2.0).
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI), [ntfy](https://ntfy.sh) and [Tailscale](https://tailscale.com): the picture server, the phone push and the tailnet CynCo works with.
- Everything else, including the generative-UI formats CynCo adopted, is in [CREDITS.md](CREDITS.md).

## License

[AGPL-3.0](LICENSE). Use it, modify it, distribute it. But if you build a service with it, you must open source your changes. That's the point.
