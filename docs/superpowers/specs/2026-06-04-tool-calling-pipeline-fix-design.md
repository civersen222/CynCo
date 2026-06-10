# Tool Calling Pipeline Fix — Design Spec

**Date**: 2026-06-04
**Problem**: CynCo's tool calling accuracy is degraded by 3 confirmed Ollama bugs that corrupt tool definitions, strip tool call history, and use wrong template renderers. Research shows this is an Ollama infrastructure problem, not a model limitation.
**Solution**: 5 workstreams to bypass Ollama bugs, enable speculative decoding, improve temperature control, support dual-GPU setups, and validate with Gemma 4.

---

## Background

### Confirmed Ollama Bugs

1. **Ollama #14601 — Go struct serialization**: Tool definitions passed via Ollama's `tools` API parameter are serialized as Go structs (e.g., `map[type:object properties:map[...]]`) instead of valid JSON. Models receive malformed schemas.

2. **Ollama #14601 — Stripped tool call history**: When using native tool calling, Ollama strips assistant tool call blocks from conversation history. The model cannot see its own previous tool calls, breaking multi-step workflows.

3. **Ollama #14493 — Wrong template renderer**: Qwen 3.5/3.6 models use Qwen3-Coder XML format for tool calls, but Ollama's Hermes-style renderer/parser is applied instead, causing format mismatches.

### Existing Infrastructure

CynCo already has a complete simulated tool use path:
- `engine/ollama/simulated.ts`: `buildSimulatedToolPrompt()` embeds tools in system prompt, `extractSimulatedToolCalls()` parses `<tool_call>` XML from output
- `engine/engine/streamTranslator.ts`: Buffers simulated output, extracts tool blocks, emits structured events
- `engine/bridge/conversationLoop.ts`: Fallback XML extraction at lines 1620-1658
- `engine/ollama/probe.ts`: Model capability table controls routing (`native` vs `simulated` vs `none`)

The simulated path works end-to-end for models marked `toolUse: 'simulated'`. The fix is making it the default for Ollama-served models.

---

## Workstream 1: Simulated Tool Prompts as Default (Highest Priority)

### Change

In `engine/engine/callModel.ts`, add a provider-level override: when `provider.name === 'ollama'` and `LOCALCODE_NATIVE_TOOLS` is not `'true'`, force `simulatedToolUse = true` regardless of probe capabilities.

This preserves the capability table's accuracy (models *do* support native tools when served via llama-cpp), while routing around Ollama's bugs.

### Parser Maximalism

The tool call parser in `simulated.ts` must handle ALL common formats models might emit:

1. **CynCo canonical** (current): `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
2. **Hermes-style**: `<function=tool_name>{"param": "value"}</function>`
3. **Qwen3-Coder XML**: `<tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>` (whitespace variants)
4. **Raw JSON blocks**: ` ```json\n{"name": "...", "arguments": {...}}\n``` ` (fenced code blocks). Only parsed when the JSON object contains both `"name"` and `"arguments"` keys — prevents false positives on regular code blocks.
5. **Multiple calls**: All formats may appear multiple times in a single response

The existing regex `/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g` already handles #1 and #3. Add parsers for #2 and #4.

### Conversation History Preservation

When using simulated tools, previous assistant tool calls must appear in conversation history as visible text (not stripped like Ollama does with native calls). The `convertMessages()` function in `messageConvert.ts` must serialize tool_use blocks back to `<tool_call>` XML in assistant messages so the model sees its full history.

### Config

- `LOCALCODE_NATIVE_TOOLS=true` — opt back into Ollama's native tool calling (for testing/debugging)
- Default: simulated (no env var needed)

### Files Modified

- `engine/engine/callModel.ts` — provider-level override logic
- `engine/ollama/simulated.ts` — add Hermes and JSON block parsers
- `engine/engine/messageConvert.ts` — serialize tool_use blocks in assistant history

---

## Workstream 2: MTP Speculative Decoding for llama-server

### Change

In `engine/llama/processManager.ts`, add speculative decoding flags to the llama-server spawn command when configured.

### Config

- `LOCALCODE_SPEC_TYPE` — speculative decoding type (e.g., `draft-mtp`). Only added when set.
- `LOCALCODE_SPEC_DRAFT_N` — max draft tokens (default: `2` when spec_type is set)

### Flags Added to llama-server

When `LOCALCODE_SPEC_TYPE` is set:
```
--spec-type draft-mtp --spec-draft-n-max 2
```

### GGUF Source

**`unsloth/Qwen3.6-27B-MTP-GGUF`** (1.1M downloads, 642 likes) — MTP heads baked into the GGUF, no separate draft model needed.

Recommended quantization for RTX 5090 (32GB):
- **Q6_K (22GB)**: Sweet spot — near-Q8 quality with 10GB headroom for context
- **Q8_0 (29GB)**: Max quality, tight on VRAM — use `-c 4096` or `-c 8192`

Download: `llama-server -hf unsloth/Qwen3.6-27B-MTP-GGUF:Q6_K`

Note: Standard Ollama blobs do NOT include MTP heads — this is llama-server only.

### Files Modified

- `engine/llama/processManager.ts` — add spec flags to spawn args

---

## Workstream 3: Temperature Control for Stuck States

### Change

In `engine/engine/callModel.ts`, add a governance-aware temperature override that fires when the model is stuck in tool selection loops.

### Logic

1. **Stuck temperature override**: When governance reports `stuckTurns >= 3`, override temperature to `LOCALCODE_TOOL_TEMPERATURE` or `0.1` (hardcoded floor). This takes priority over variety-driven temperature adjustments.

2. **Thinking budget cap**: When `stuckTurns >= 3` and thinking is enabled, cap `budgetTokens` to `64`. Extended thinking (256+ tokens) degrades tool selection accuracy — the model overthinks instead of acting.

3. **Priority order**: `stuck override > LOCALCODE_TOOL_TEMPERATURE > variety-driven > config.temperature`

### Config

- `LOCALCODE_TOOL_TEMPERATURE=0.2` — explicit tool selection temperature (optional)
- When not set, stuck override uses `0.1`

### Governance Integration

The stuck count is read from `CyberneticsGovernance.getStuckCount()`. The governance instance must be accessible from `callModel.ts`. Currently, governance lives in `conversationLoop.ts`. Two options:

Add `options.stuckTurns?: number` and let conversationLoop pass it from `governance.getStuckCount()`.

### Files Modified

- `engine/engine/callModel.ts` — temperature override + thinking cap logic
- `engine/bridge/conversationLoop.ts` — pass `stuckTurns` in options

---

## Workstream 4: Secondary Ollama Server for Embeddings

### Change

In `engine/index/embedClient.ts`, use `LOCALCODE_EMBED_BASE_URL` if set, falling back to the constructor's `baseUrl` parameter.

### Config

- `LOCALCODE_EMBED_BASE_URL=http://192.168.x.x:11434` — route embedding requests to secondary machine

### Implementation

One-line change in constructor:
```typescript
this.baseUrl = process.env.LOCALCODE_EMBED_BASE_URL ?? baseUrl
```

### Files Modified

- `engine/index/embedClient.ts` — constructor change

---

## Workstream 5: Gemma 4 Validation

### Change

No code changes. Manual testing after WS1-WS4 are complete.

### Test Protocol

Run the same CivKings task with both models:
1. `qwen3.6:27b` (current default)
2. `gemma4:31b` (tau2-bench: 86.4% tool alignment vs Qwen's ~68%)

### Metrics to Compare

- Time to first edit (seconds)
- Number of read-only turns before first write
- Tool call / stated intent alignment (does the model call what it says it will?)
- Total tokens consumed

### Prerequisite

`gemma4:31b` must be pulled on Ollama: `ollama pull gemma4:31b`

---

## Wire Check (Final Verification Step)

After all workstreams are implemented:

1. `grep -r 'LOCALCODE_NATIVE_TOOLS'` — verify it's read in callModel.ts and documented in config
2. `grep -r 'LOCALCODE_SPEC_TYPE'` — verify it's read in processManager.ts
3. `grep -r 'LOCALCODE_TOOL_TEMPERATURE'` — verify it's read in callModel.ts
4. `grep -r 'LOCALCODE_EMBED_BASE_URL'` — verify it's read in embedClient.ts
5. `grep -r 'extractHermesToolCalls\|extractJsonBlockToolCalls'` — verify new parsers are called from extractSimulatedToolCalls
6. Verify `provider.name` is accessible in callModel.ts (it's already used at line 355 for grammar)
7. Run `cd engine && bun test` to verify no regressions
