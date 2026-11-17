# engine/providers

## Purpose
What the model providers share that belongs to none of them: the factory that turns a provider name into a `Provider`, a generic OpenAI-compatible provider, and the stall clock every streamed request runs under. The two providers the engine actually runs live in their own packages (`engine/llama/`, `engine/ollama/`); `engine/bootstrapProvider.ts` is the one assembler and decides which is built.

## Key files
| File | Role |
|---|---|
| `names.ts` | `PROVIDER_TYPES` / `ProviderType` (the two providers CynCo has) and `providerFromName`, the check `engine/config.ts` runs on a configured name. No imports. |
| `factory.ts` | `createProvider`; re-exports the names. |
| `openaiCompat.ts` | `OpenAICompatProvider`: any server with `/v1/chat/completions` and `/v1/models`, with an optional bearer key. |
| `streamWatchdog.ts` | The stall clock (F235): `StreamWatchdog`, `StreamStalledError`, and the two limits. Used by `engine/llama/provider.ts` and `engine/ollama/client.ts`. |

## Important types & functions
- **`ProviderType`** (`names.ts:15`) — `'ollama' | 'llama-cpp'`. A wrong literal in code is a compile error.
- **`providerFromName`** (`names.ts:24`) — the name a profile or `LOCALCODE_PROVIDER` gives, checked: one of the two, or a refusal that says what to set. `engine/config.ts` throws it as a `ConfigRefusal` and `main.ts` prints it and exits.
- **`createProvider`** (`factory.ts:8`) — name, base URL and context length → a `Provider`; a name forced past the type throws.
- **`OpenAICompatProvider`** (`openaiCompat.ts:13`) — sends `Authorization: Bearer <key>` only when a key is set.
- **`StreamWatchdog`** (`streamWatchdog.ts:88`) — one per streamed request: its own abort signal (also aborted by the caller's, so a Stop still ends the request), armed with the first-byte limit by `waitFirstByte()` and re-armed with the idle limit by `sawData()`. `stalled` holds the error when a limit fired, which is how a provider tells a cut from a Stop. Its fourth argument names the server in the error text and the engine-log tag.
- **`modelSilence`** (`streamWatchdog.ts:62`) — the request in flight and how long its server has sent nothing (`phase`, `silentMs`, `limitMs`, `server`), or null when none is; with several in flight, the one silent longest. It reads a module-level set of the clocks that are waiting right now, which only a clock writes: it joins when it is armed and leaves on `dispose` or when it cuts its request, so a request that ended is never reported as still silent. `engine/main.ts` hands it to the dashboard, which puts it on `/api/session` (`engine/dashboard/CLAUDE.md`). Pinned by `providers/modelSilence.test.ts`.
- **`StreamStalledError`** (`streamWatchdog.ts:37`) — `phase` (`first-byte` or `mid-stream`) and `silentMs`. It carries no `code`, so `callModel.isRetryableError` never retries it: the turn ends through the loop's error path as `session.error`. `stallOf(err)` answers `{ phase, silentMs }` for this class and null for anything else, a look-alike with the same name included; the loop puts it on that frame as `stall`, which is how the mission driver tells a stall from a crash (`engine/bridge/CLAUDE.md`).
- **`STREAM_FIRST_BYTE_MS`** (`streamWatchdog.ts:33`), **`STREAM_IDLE_MS`** (`streamWatchdog.ts:34`) — twenty minutes before the first byte, ten between bytes; the reasoning is in the comment above them.

## Gotchas
- **Only two names exist, on purpose.** Until 2026-11-17 `ProviderType` also named `lmstudio`, `llamacpp`, `vllm` and `openai-compat`, none of which was ever built: `engine/bootstrapProvider.ts` has two paths, llama.cpp and "everything else", and everything else is the Ollama client, so `provider: vllm` ran the Ollama client against its base URL and said nothing. The owner's decision was to take the names out (decision sheet of 2026-11-17, row 4). `createProvider` is asked only for `'ollama'` in production (the Ollama path and the busy fallback); `bootstrapProvider` builds the llama.cpp provider itself.
- **The clock measures the server's silence, never the caller's.** A provider re-arms it as each read of the body begins, so time the loop spends on the events of one chunk does not count. The lazy llama.cpp model load is outside it (`ensureReady` runs first and has its own wait); Ollama's own model load is inside it and is far shorter than the first-byte limit.
- **`OpenAICompatProvider` is built by nothing in production** since its three names left the type; its tests construct it directly. It also has no stall clock. Whether it is deleted or wired to a name again is in `docs/NOW.md`.
- A stall cut is logged once as `[llama-cpp] …` or `[ollama] …` with the error's text, and only the llama.cpp provider has a recovery hook (`onStreamStall`: its server is the engine's to stop or restart, Ollama's is not).
- Pinned by `engine/__tests__/llama/streamStall.test.ts` and `engine/__tests__/ollama/streamStall.test.ts`, both against a real HTTP server, because what has to be true is that the connection closes.
