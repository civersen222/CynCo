# engine/engine

## Purpose
This package is the model-calling core of CynCo's local inference engine: it converts internal
messages/tools into a `CompletionRequest`, streams a completion from the configured `Provider`
(Ollama or llama.cpp), translates the raw stream into the Anthropic-shaped event lifecycle, repairs
malformed tool-call JSON, enforces the local context-window budget, and assembles the static system
prompt. It is called by `bridge/conversationLoop.ts` (the main turn loop), `agents/subAgent.ts`
(delegated sub-agent turns), `hooks/contextCheck.ts` (pre-turn budget gate), and `ollama/format.ts`.
It must never let the prompt prefix mutate turn-to-turn (breaks llama.cpp checkpoint caching), never
silently drop an unparseable tool call (must mark it, never discard it), and never misclassify a
transient transport failure as permanent. Findings F22 and F51 (both in `callModel.ts`) directly
shaped the retry-error classifier.

## Key files
| File | Role |
|---|---|
| `callModel.ts` | Core `localCallModel` generator: resolves provider/model/capabilities, runs the pre-turn context check, builds the request, retries transport failures, and assembles streamed events into `AssistantMessage`s. |
| `contextBudget.ts` | Estimates token usage (char/4 heuristic or real tokenizer) and classifies it as ok/warning/exceeded against a context-window budget. |
| `messageConvert.ts` | Converts internal messages/tools to the Provider's `CompletionRequest` shape; handles simulated-tool-use serialization to `<tool_call>` XML. |
| `sessionExtras.ts` | Per-conversation cache so handoff+recalled-memory prompt text is computed once and re-appended byte-identically on every later turn. |
| `streamTranslator.ts` | Translates a raw Provider stream into the structured `message_start`/`content_block_*`/`message_stop` event lifecycle, in both native and simulated tool-use modes. |
| `systemPromptText.ts` | Static system-prompt section constants (ROLE, TOOL_USE, WORKFLOW, etc.) assembled by `assembleBasePrompt`. |
| `toolCallRepair.ts` | Single source of truth for parsing tool-call argument JSON: strict parse → jsonrepair salvage → malformed marker (never dropped). |
| `toolFilter.ts` | Applies profile allow/deny scoping rules to a tool list before it reaches the model. |

## Important types & functions
- **`localCallModel`** (`callModel.ts:244`) — the main async generator: resolves deps/model/capabilities, checks context budget, converts messages/tools, builds system prompt + session extras, retries transport failures, and yields `StreamEvent`/`AssistantMessage`/`api_retry` events. Called by `conversationLoop.ts` and `subAgent.ts`.
- **`isRetryableError`** (`callModel.ts:189`) — classifies an error as a retryable transport failure (both Node/libuv and Bun error-code vocabularies, plus a 503 "loading model" window). Used inside `localCallModel`'s retry loop.
- **`checkBudget`** / **`checkBudgetAsync`** (`contextBudget.ts:138`, `contextBudget.ts:111`) — sync/async context-budget classifiers; `checkBudgetAsync` is what `hooks/contextCheck.ts` calls with a real tokenizer.
- **`convertMessages`** (`messageConvert.ts:62`) — converts internal `Message[]` to Provider format, serializing tool blocks to text when `simulatedToolUse` is set.
- **`convertTools`** (`messageConvert.ts:156`) — converts tool-like objects to `ToolDefinition[]`; reads `inputJSONSchema` specifically (a past drift to `input_schema` sent schema-less tools to the model).
- **`translateStream`** (`streamTranslator.ts:36`) — dispatches to native or simulated stream translation based on `options.simulatedToolUse`.
- **`repairToolCall`** (`toolCallRepair.ts:24`) — parses tool-call argument JSON via the repair ladder; returns a malformed marker rather than throwing or dropping.
- **`getSessionExtras`** (`sessionExtras.ts:26`) — returns cached first-turn prompt extras (handoff + recalled memories) byte-identically on later turns of the same conversation, and pins `''` for an unrecognized mid-conversation key.
- **`filterTools`** (`toolFilter.ts:21`) — applies allow/deny `ToolScoping` to a tool array before conversion.

## Data flow
1. `conversationLoop.ts` (or `subAgent.ts`) calls `localCallModel` with messages, tools, system prompt pieces, and options.
2. `localCallModel` resolves the provider/model/capabilities and runs `checkContextBeforeTurn` (via `hooks/contextCheck.ts`, backed by `contextBudget.ts`), yielding a warning/exceeded event and possibly auto-externalizing a handoff.
3. `convertMessages` and `filterTools`/`convertTools` (`messageConvert.ts`) turn the internal messages/tools into the Provider's `CompletionRequest` shape.
4. `buildSystemPrompt` plus `getSessionExtras` (`sessionExtras.ts`) assemble the system prompt string, prepending a simulated-tool-use prompt when required.
5. `localCallModel` opens `provider.stream(request)`, retrying on `isRetryableError` up to `MAX_TRANSPORT_RETRIES`, and pipes the raw stream through `translateStream` (`streamTranslator.ts`).
6. `localCallModel` consumes the translated events, using `repairToolCall` (via `content_block_stop`) to parse tool-call JSON, and assembles/yields `AssistantMessage`s back to the caller.

## Gotchas
- The prompt prefix (system prompt + session extras) must stay byte-identical across turns of the same conversation — `sessionExtras.ts` caches the handoff/memories text on first turn and replays it verbatim; a single shared cache slot would let a sub-agent run evict the main conversation's entry, so the cache is a bounded multi-entry map (`MAX_ENTRIES = 16`). Pinned by `engine/__tests__/engine/prefixStability.test.ts` and `engine/__tests__/engine/sessionExtras.test.ts`.
- F22 (`callModel.ts:109`): the retryable-error predicate must recognize BOTH Node/libuv error codes (`ECONNREFUSED`, etc.) and Bun's own vocabulary (`ConnectionRefused`, etc.) — with only the Node names present, Bun's actual runtime errors matched nothing and a connection-refused failure was treated as permanent. Pinned by the `"recognises Bun's ConnectionRefused"` case in `engine/__tests__/engine/callModel.test.ts`.
- F51 (`callModel.ts:148`): an `HTTP 503` alone is not retryable — only a 503 paired with a loading marker (`Loading model` / `unavailable_error`) is treated as the server being mid-restart; a bare 503 could mean a dead upstream and retrying forever would hang. Pinned by the `F51: the server is up, answering, and not ready yet` describe block in `engine/__tests__/engine/callModel.test.ts`.
- Unparseable tool-call arguments are NEVER dropped — `repairToolCall` (`toolCallRepair.ts:24`) falls back to a `__malformed` marker (`MALFORMED_KEY`) carrying the raw text and error, which `conversationLoop.executeOneTool` turns into a bounded error-feedback retry. Pinned by `engine/__tests__/engine/toolCallRepair.test.ts`.
- `convertTools` (`messageConvert.ts:156`) reads `inputJSONSchema` specifically — a tool object using `input_schema` instead silently gets `{ type: 'object' }` with no described parameters, reaching the model schema-less.
