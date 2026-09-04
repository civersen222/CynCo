# engine/ollama

## Purpose
The Ollama `Provider` implementation plus a capability-probe table shared with the llama-cpp path. Per `engine/bootstrapProvider.ts:6`, llama-cpp is the *default* provider; Ollama is used only when `config.provider` is explicitly not `'llama-cpp'` — it is never a silent degradation target (llama-cpp setup failure throws instead of falling back here, because a degraded fallback runs the wrong model/context). `format.ts` (OpenAI-format translation) and `probe.ts` (capability lookup) are reused directly by `engine/providers/openaiCompat.ts` and `engine/llama/provider.ts`, since both Ollama's and llama-server's chat endpoints are OpenAI-compatible. `simulated.ts` (XML tool-call/thinking extraction for models without native function calling) is consumed by `engine/engine/callModel.ts`, `engine/bridge/conversationLoop.ts` and `engine/engine/streamTranslator.ts`. No F-numbered failure-log entry is cited in this package's comments, though `format.ts:264` documents an unlabeled prior finding about a dropped usage-only chunk.

## Key files
| File | Role |
|---|---|
| `client.ts` | `OllamaProvider`: HTTP calls to Ollama's `/v1/chat/completions`, `/api/tags`, `/api/pull`. |
| `errors.ts` | Typed error classes with actionable messages (`ollama serve`, `ollama pull ...`); unit-tested but not currently thrown by `client.ts`. |
| `format.ts` | OpenAI-compat message/tool/response/stream-chunk translation, shared with the llama-cpp OpenAI-compat path. |
| `probe.ts` | Known-model capability table and family-based lookup/fallback logic. |
| `simulated.ts` | `<tool_call>`/Hermes/fenced-JSON/bare-syntax tool-call extraction and `<think>` block extraction for Standard-tier models. |

## Important types & functions
- **`OllamaProvider`** (`client.ts:17`) — implements `Provider`; called by `engine/providers/factory.ts` (construction) and `engine/engine/callModel.ts` (generation).
- **`toOpenAIMessages`** (`format.ts:24`) — converts internal `Message[]` to OpenAI chat messages; splits `tool_result` blocks into separate `role:'tool'` messages, strips thinking/image/document blocks.
- **`fromOpenAIStreamChunk`** (`format.ts:234`) — converts one OpenAI SSE chunk into zero or more internal `StreamEvent`s (text/thinking deltas, tool-call start/delta, usage `message_delta`). Called from `client.ts:137` per parsed SSE line.
- **`parseTurnCost`** (`format.ts:169`) — extracts `TurnCost` from a response/chunk's `usage`/`timings`; source is `'server-timings'` only when a `timings` block is present (llama-server), `'usage-only'` when only token counts are present (Ollama's shim), `'none'` otherwise.
- **`resolveCapabilities`** (`probe.ts:109`) — resolves `ModelCapabilities` via known table → probe result → safe basic-tier defaults. Called from `client.ts:47/52`, `engine/bootstrapProvider.ts`, `engine/engine/callModel.ts`, and `engine/llama/provider.ts`.
- **`buildSimulatedToolPrompt`** (`simulated.ts:55`) — builds the `<tool_call>` XML instruction prompt for Standard-tier models; memoized (single-slot cache keyed on tool-name list) so the prefix stays byte-identical across turns for llama.cpp prompt caching.
- **`extractSimulatedToolCalls`** (`simulated.ts:85`) — pulls `<tool_call>`, Hermes `<function=...>`, fenced-JSON, and bare-call-syntax tool calls out of model output text; validates each against the tool registry and silently discards invalid/unparseable ones.
- **`extractProseToolCalls`** (`simulated.ts:254`) — rescues tool calls a model wrote as ordinary code (e.g. `Read(file_path="x")`) instead of the requested XML tags.

## Data flow
1. `engine/engine/callModel.ts` builds a `CompletionRequest` and calls `OllamaProvider.stream()` (`client.ts:66`).
2. `buildRequestBody()` (`client.ts:180`) converts it via `toOpenAIMessages`/`toOpenAITools` (`format.ts:24`/`format.ts:96`), prepends a system message, sets `options.num_ctx` only when the resolved context exceeds Ollama's 32K default, and adds `logprobs`/`top_logprobs` when streaming.
3. `client.ts:90` POSTs the body to `${baseUrl}/v1/chat/completions`.
4. The response body reader splits on `\n`, and `parseSSELine` (`format.ts:362`) parses each `data: ` line to JSON (or signals `[DONE]`/non-data lines).
5. `fromOpenAIStreamChunk` (`format.ts:234`) turns each parsed chunk into `StreamEvent`s; `client.ts` yields `message_start` before the loop and `message_stop` after.
6. For Standard-tier (simulated-tool-use) models, `engine/engine/streamTranslator.ts` runs `extractSimulatedToolCalls`/`extractThinkingBlocks` (`simulated.ts:85`/`simulated.ts:163`) over the accumulated text to recover tool calls and thinking that arrived as plain text rather than native `tool_calls`.

## Gotchas
- `client.ts:66`–`156` (`stream()`) unconditionally writes `.cynco-http-debug.json` before the request and `.cynco-sse-debug.json` after, and `console.log`s the HTTP status and chunk count on every call — real disk/stdout side effects on every streamed turn, not just a debug build.
- `errors.ts` exports `ConnectionError`, `ModelNotFoundError`, `ModelLoadError`, `TimeoutError`, `GenerationError` and is imported into `client.ts`, but none of them are actually thrown there — `healthCheck()` catches and returns `false` instead of raising `ConnectionError`. `errors.test.ts` only exercises the classes in isolation, not the wiring.
- `format.ts:260`–`270`: a chunk carrying only `usage` (empty `choices`) must still be read — `mapFinishReason` on it can legitimately be `undefined`, and "consumers must not read it as a stop" (comment at `format.ts:274`). Pinned by `turnCost.test.ts` ("rides the streaming usage chunk").
- `parseTurnCost` (`format.ts:169`) never returns `source: 'server-timings'` for Ollama — its OpenAI-compat shim does not send a `timings` block, so Ollama turns are always `'usage-only'` or `'none'`. Pinned by `turnCost.test.ts`.
- `extractProseToolCalls` (`simulated.ts:254`) only runs when `extractSimulatedToolCalls` found zero structured calls — "a model that emits `<tool_call>` correctly must not also have its narration mined for accidental extra calls" (`simulated.ts:120`). Pinned by `simulated.test.ts` ("does not mine narration when a structured call was found").
- `buildSimulatedToolPrompt` (`simulated.ts:55`) caches only the single most recent tool set (module-level `simPromptKey`/`simPromptValue`), not an LRU — alternating between two tool sets rebuilds every call. Pinned by `simulatedMemo.test.ts`.
- `lookupKnownCapabilities` (`probe.ts:90`) falls back through progressively shorter hyphenated prefixes (e.g. `devstral-small-2` → `devstral-small` → `devstral`) before returning `null`; an unrecognized family silently gets `tier: 'basic'`, `toolUse: 'none'` from `resolveCapabilities`' safe defaults rather than an error.
