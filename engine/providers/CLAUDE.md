# engine/providers

## Purpose
What the model providers share that belongs to none of them: the factory that turns a provider name into a `Provider`, a generic OpenAI-compatible provider, and the stall clock every streamed request runs under. The two providers the engine actually runs live in their own packages (`engine/llama/`, `engine/ollama/`); `engine/bootstrapProvider.ts` is the one assembler and decides which is built.

## Key files
| File | Role |
|---|---|
| `factory.ts` | `ProviderType` (the union a profile's or the environment's provider name is typed as) and `createProvider`. |
| `openaiCompat.ts` | `OpenAICompatProvider`: any server with `/v1/chat/completions` and `/v1/models`, with an optional bearer key. |
| `streamWatchdog.ts` | The stall clock (F235): `StreamWatchdog`, `StreamStalledError`, and the two limits. Used by `engine/llama/provider.ts` and `engine/ollama/client.ts`. |

## Important types & functions
- **`ProviderType`** (`factory.ts:6`) — `'ollama' | 'lmstudio' | 'llamacpp' | 'llama-cpp' | 'vllm' | 'openai-compat'`. A wrong literal in code is a compile error; a wrong value in a profile or in `LOCALCODE_PROVIDER` is not checked (`engine/config.ts` casts it).
- **`createProvider`** (`factory.ts:8`) — name, base URL, optional key and context length → a `Provider`.
- **`OpenAICompatProvider`** (`openaiCompat.ts:13`) — sends `Authorization: Bearer <key>` only when a key is set.
- **`StreamWatchdog`** (`streamWatchdog.ts:53`) — one per streamed request: its own abort signal (also aborted by the caller's, so a Stop still ends the request), armed with the first-byte limit by `waitFirstByte()` and re-armed with the idle limit by `sawData()`. `stalled` holds the error when a limit fired, which is how a provider tells a cut from a Stop. Its fourth argument names the server in the error text and the engine-log tag.
- **`StreamStalledError`** (`streamWatchdog.ts:37`) — `phase` (`first-byte` or `mid-stream`) and `silentMs`. It carries no `code`, so `callModel.isRetryableError` never retries it: the turn ends through the loop's error path as `session.error`.
- **`STREAM_FIRST_BYTE_MS`** (`streamWatchdog.ts:33`), **`STREAM_IDLE_MS`** (`streamWatchdog.ts:34`) — twenty minutes before the first byte, ten between bytes; the reasoning is in the comment above them.

## Gotchas
- **`createProvider` is only ever asked for `'ollama'` in production** (`engine/bootstrapProvider.ts`, twice: the Ollama path and the busy fallback). `bootstrapProvider` builds the llama.cpp provider itself and sends every other provider name down the Ollama path, so a profile that says `openai-compat`, `vllm` or `lmstudio` runs the Ollama client against its base URL and `OpenAICompatProvider` is never constructed outside the tests. It mostly works, because the Ollama client speaks `/v1/chat/completions` too; its model listing and pull do not. Found by the 2026-11-17 work-order triage and left as it is: `docs/NOW.md`.
- **The clock measures the server's silence, never the caller's.** A provider re-arms it as each read of the body begins, so time the loop spends on the events of one chunk does not count. The lazy llama.cpp model load is outside it (`ensureReady` runs first and has its own wait); Ollama's own model load is inside it and is far shorter than the first-byte limit.
- **`OpenAICompatProvider.stream` has no stall clock.** It is not reachable in production (above); wire it to `StreamWatchdog` when it becomes so.
- A stall cut is logged once as `[llama-cpp] …` or `[ollama] …` with the error's text, and only the llama.cpp provider has a recovery hook (`onStreamStall`: its server is the engine's to stop or restart, Ollama's is not).
- Pinned by `engine/__tests__/llama/streamStall.test.ts` and `engine/__tests__/ollama/streamStall.test.ts`, both against a real HTTP server, because what has to be true is that the connection closes.
