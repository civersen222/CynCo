# CynCo Ollama Tool Calling Fix — Session Prompt

Copy everything below the line and paste it as your first message in a new Claude Code session opened in `C:\Users\civer\localcode`.

---

We need to fix CynCo's tool calling pipeline. Research found that the "model says Edit but calls Read" problem is likely an Ollama template bug, not a model limitation. There are 3 workstreams:

## 1. Switch to simulated tool prompts (highest priority)

CynCo already has `engine/ollama/simulated.ts` with `buildSimulatedToolPrompt()` that embeds tools in the system prompt instead of using Ollama's `tools` API parameter. This bypasses 3 confirmed Ollama bugs:
- Ollama Issue #14601: tool definitions serialized as Go structs (malformed JSON)
- Ollama Issue #14601: assistant tool calls stripped from conversation history (model can't see its own previous calls)
- Ollama Issue #14493: wrong renderer/parser for Qwen 3.5/3.6 (Hermes-style vs Qwen3-Coder XML format)

**Task**: Make the simulated tool prompt path the DEFAULT for Ollama provider. Read `engine/ollama/client.ts` and `engine/ollama/simulated.ts` to understand both paths. The simulated path should:
- Embed tool definitions as structured text in the system prompt
- Parse tool calls from model output (XML `<function=name>` tags or JSON blocks)
- Preserve full conversation history including previous tool calls in assistant messages
- Fall back gracefully if parsing fails

Check if `engine/engine/callModel.ts` or `engine/bridge/conversationLoop.ts` controls which path is used. Wire the simulated path as default, with a `LOCALCODE_NATIVE_TOOLS=true` env var to opt back into native Ollama tools if needed.

## 2. Enable MTP speculative decoding in llama-server provider

The llama-server (llama.cpp) provider at `engine/llama/provider.ts` should support MTP speculative decoding for 1.4-2.2x speedup. 

**Task**: When using the llama-server provider, add support for launching llama-server with `--spec-type mtp --spec-draft-n-max 3` flags. Read `engine/llama/provider.ts` and `engine/config.ts` to understand how llama-server is launched. Add config:
- `LOCALCODE_SPEC_TYPE=mtp` (default: none)  
- `LOCALCODE_SPEC_DRAFT_N=3` (default: 3)

## 3. Temperature control for tool selection

Research shows lower temperature (0.1-0.3) dramatically improves tool selection accuracy, and extended thinking (256+ tokens) actually DEGRADES tool accuracy.

**Task**: In `engine/engine/callModel.ts` or wherever the model request is built:
- When governance detects stuck >= 3, lower temperature to 0.1 for the next call
- Add `LOCALCODE_TOOL_TEMPERATURE=0.2` env var for explicit control
- If thinking/reasoning mode is enabled, cap thinking budget to 64 tokens during tool selection turns (turns where the model should be calling a tool, not reasoning)

Read `engine/vsm/cyberneticsGovernance.ts` for the stuck detection, and `engine/vsm/controlSignals.ts` for the existing variety-driven temperature control. The tool temperature should override variety-driven temperature when stuck >= 3.

## 4. Secondary Ollama server support (PC 2)

**Task**: Add support for a secondary Ollama server for embeddings and advisory tasks:
- `LOCALCODE_EMBED_BASE_URL=http://PC2-IP:11434` — route embedding requests to PC 2
- Read `engine/index/embedClient.ts` to see where embeddings are requested. Make it use `LOCALCODE_EMBED_BASE_URL` if set, otherwise fall back to `LOCALCODE_BASE_URL`.

## 5. Test with Gemma 4 31B

After the above changes, test CynCo with `gemma4:31b` as an alternative to `qwen3.6:27b`. Gemma 4 showed 86.4% tool-call alignment on tau2-bench (vs Qwen's ~68%). Run a simple CivKings task through CynCo with each model and compare:
- Time to first edit
- Number of read loops before editing
- Whether the tool call matches stated intent

## Context

- CynCo is at `C:\Users\civer\localcode`, TypeScript/Bun runtime
- CLAUDE.md has full architecture docs
- All config uses `LOCALCODE_*` env vars
- Tests: `cd engine && bun test` (or specific test files)
- The user's hardware: RTX 5090 (32GB), secondary PC with RTX 4070 Ti Super (16GB) on WiFi
- Current model: qwen3.6:27b via Ollama
- NEVER edit files in `C:\Users\civer\civkings` — that's CynCo's test project

Prioritize workstream 1 (simulated tool prompts) — it's the highest-impact fix and the infrastructure already exists. Commit after each workstream.
