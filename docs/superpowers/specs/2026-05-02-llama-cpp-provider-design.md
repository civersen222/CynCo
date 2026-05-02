# V2 Provider: LlamaCppProvider — llama-server Backend with LoRA Support

## Summary

Replace Ollama as the default inference backend with llama.cpp's `llama-server`, giving full control over inference parameters (flash attention, batch size, KV cache, GPU layers) and enabling LoRA adapter hot-swap for the VSM training pipeline. Ollama remains as a fallback provider.

**Problem:** Ollama delivers 3.3 tok/s on an RTX 5090 with qwen3.6 36B Q4_K_M at 17K context. The 5090 should do 20-40+ tok/s. Ollama's OpenAI-compat endpoint doesn't expose performance tuning, and its llama.cpp backend may lack Blackwell optimizations. We need direct control.

**Solution:** A new `LlamaCppProvider` that manages llama-server as a child process, auto-downloads the binary, resolves GGUF model files from a local directory, and supports dual-machine adapter inference.

**Prerequisites:** Existing `Provider` interface with optional `loadAdapter`/`unloadAdapter`/`activeAdapter` methods (already built in v2 bridge work).

---

## Decisions

- **D-01:** Default provider switches to `llama-cpp`. Ollama stays as `LOCALCODE_PROVIDER=ollama`.
- **D-02:** llama-server binary auto-downloaded to `~/.cynco/bin/` on first run from llama.cpp GitHub releases (CUDA build). Version pinned.
- **D-03:** GGUF models stored in `~/.cynco/models/<model-name>/`. Resolved by stem name (`LOCALCODE_MODEL=qwen3.6`). `LOCALCODE_MODEL_PATH` overrides.
- **D-04:** LoRA adapters stored in `~/.cynco/adapters/`. Adapter swap = kill + restart llama-server with `--lora` flag (~2-3s cost).
- **D-05:** Dual-machine support via `LOCALCODE_ADAPTER_URL`. Remote machine runs a smaller model with LoRA permanently loaded. Adapter calls route there with zero swap cost.
- **D-06:** Hybrid process management — connect to existing server if port is occupied, spawn if not.
- **D-07:** Format conversion layer (`format.ts`, `simulated.ts`, `probe.ts`) reused unchanged. llama-server speaks the same OpenAI-compatible protocol.
- **D-08:** No changes to conversation loop, bridge, tools, VSM, or agents. They talk to `Provider` and don't know what's behind it.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LocalCode Engine                                           │
│                                                             │
│  ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │ Provider Router  │───►│ LlamaCppProvider              │   │
│  │                  │    │   ├─ complete() / stream()    │   │
│  │ LOCALCODE_       │    │   ├─ loadAdapter() → routes   │   │
│  │ PROVIDER=        │    │   │   to adapter server       │   │
│  │ llama-cpp|ollama │    │   ├─ ProcessManager           │   │
│  │                  │    │   │   (start/stop/restart)     │   │
│  │                  │    │   └─ BinaryManager             │   │
│  │                  │    │       (download/version)       │   │
│  └────────┬─────────┘    └──────────────────────────────┘   │
│           │                     │              │             │
│           ▼                     ▼              ▼             │
│  ┌─────────────────┐   ┌────────────┐  ┌──────────────┐    │
│  │ OllamaProvider  │   │ Primary    │  │ Adapter       │    │
│  │ (fallback)       │   │ Server     │  │ Server        │    │
│  └─────────────────┘   │ :8081      │  │ :8082 or      │    │
│                         │ 5090 local │  │ remote 4070   │    │
│                         └────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

Two-tier inference:
- **Primary server** — runs the base model (e.g., qwen3.6 36B on the 5090) for all general inference.
- **Adapter server** — either a local restart with `--lora` (single machine) or a remote llama-server on the network (e.g., qwen3:8b + LoRA on a 4070 Ti Super). Dedicated to S-level governance decisions.

When `LOCALCODE_ADAPTER_URL` is set, `loadAdapter()` switches the target URL with zero restart cost. When not set, adapter swap kills and restarts the primary server with `--lora` (~2-3s).

---

## 2. Binary Management

**Module:** `engine/llama/binaryManager.ts`

Auto-downloads `llama-server.exe` (CUDA build) from llama.cpp GitHub releases on first run.

### Resolution Order

1. `LOCALCODE_LLAMA_SERVER` env var — explicit path, power users
2. `~/.cynco/bin/llama-server.exe` — auto-downloaded
3. PATH lookup — user-installed

### Version Pinning

```
~/.cynco/bin/
├── llama-server.exe
└── version.json    # { "version": "b5432", "downloadedAt": "2026-05-02T..." }
```

On startup: if binary missing, download latest CUDA release. If present, use it. Future `localcode update-server` command bumps version.

### Download Flow

1. Query GitHub API: `https://api.github.com/repos/ggerganov/llama.cpp/releases/latest`
2. Find asset matching `llama-*-bin-win-cuda-*-x64.zip`
3. Download, extract `llama-server.exe` to `~/.cynco/bin/`
4. Write `version.json`
5. Log: `[llama-cpp] Downloaded llama-server <version> to ~/.cynco/bin/`

---

## 3. Model Resolution

**Module:** `engine/llama/modelResolver.ts`

### Resolution Order

1. `LOCALCODE_MODEL_PATH=/path/to/file.gguf` — wins outright, skip all resolution
2. `~/.cynco/models/<model-name>/*.gguf` — scan directory, pick largest file (highest quality quant)
3. Not found → error: `"No GGUF found for 'qwen3.6'. Download one to ~/.cynco/models/qwen3.6/ or set LOCALCODE_MODEL_PATH"`

### Directory Layout

```
~/.cynco/
├── bin/
│   ├── llama-server.exe
│   └── version.json
├── models/
│   ├── qwen3.6/
│   │   └── qwen3.6-Q4_K_M.gguf
│   └── qwen3-8b/
│       └── qwen3-8b-Q4_K_M.gguf
├── adapters/
│   ├── s1-lora.gguf
│   ├── s3-lora.gguf
│   └── s5-lora.gguf
└── training/          # existing decision journals
    └── ...
```

Log which exact GGUF file was selected at startup.

### Adapter Resolution

`loadAdapter('s3-lora')` resolves to `~/.cynco/adapters/s3-lora.gguf`. Flat directory, name-based lookup.

---

## 4. Process Management

**Module:** `engine/llama/processManager.ts`

### Startup Flags

```
llama-server \
  --model <resolved-gguf-path> \
  --port 8081 \
  --ctx-size 32768 \
  --n-gpu-layers 999 \
  --flash-attn \
  --batch-size 2048 \
  --host 127.0.0.1
```

### Configurable Parameters

| Env Var | Flag | Default |
|---------|------|---------|
| `LOCALCODE_CONTEXT_LENGTH` | `--ctx-size` | 32768 |
| `LOCALCODE_BATCH_SIZE` | `--batch-size` | 2048 |
| `LOCALCODE_GPU_LAYERS` | `--n-gpu-layers` | 999 (all) |
| `LOCALCODE_PORT` | `--port` | 8081 |
| `LOCALCODE_FLASH_ATTN` | `--flash-attn` | true (omit flag if false) |
| `LOCALCODE_THREADS` | `--threads` | auto (omit flag) |

### Lifecycle

- **Startup:** Check if port is occupied. If yes, connect to existing server (hybrid mode). If no, spawn llama-server as child process. Wait for `/health` to return 200.
- **Shutdown:** Kill child process via `process.kill()` (Windows-compatible). On failure, `taskkill /F /PID`.
- **Adapter swap (single machine):** Kill server, restart with `--lora ~/.cynco/adapters/<name>.gguf`, wait for `/health`, resume.
- **Adapter swap (dual machine):** Switch target URL to `LOCALCODE_ADAPTER_URL`. No process restart.
- **Crash recovery:** If child process dies mid-session, restart it and log a warning.

---

## 5. Provider Implementation

**Module:** `engine/llama/provider.ts`

`LlamaCppProvider` implements `Provider` — same interface as `OllamaProvider`.

### Reused Code (unchanged)

| Module | What |
|--------|------|
| `engine/ollama/format.ts` | `toOpenAIMessages`, `toOpenAITools`, `fromOpenAIResponse`, `fromOpenAIStreamChunk`, `parseSSELine` |
| `engine/ollama/simulated.ts` | `extractSimulatedToolCalls`, `extractThinkingBlocks`, `buildSimulatedToolPrompt` |
| `engine/ollama/probe.ts` | `resolveCapabilities` — model family capability detection |

### What Changes vs OllamaProvider

| Method | OllamaProvider | LlamaCppProvider |
|--------|---------------|------------------|
| `healthCheck()` | `GET /` | `GET /health` |
| `listModels()` | `GET /api/tags` | Scan `~/.cynco/models/` directories |
| `pullModel()` | `POST /api/pull` | Not implemented — user downloads GGUFs |
| `complete()` | `POST /v1/chat/completions` | Same endpoint, same format |
| `stream()` | `POST /v1/chat/completions` | Same endpoint, same format |
| `buildRequestBody()` | Includes `options.num_ctx` hack | No `options` — context set at server startup |
| `loadAdapter()` | Not implemented | Restart with `--lora` or switch to adapter URL |
| `unloadAdapter()` | Not implemented | Restart without `--lora` or switch back to primary URL |
| `activeAdapter()` | Not implemented | Returns current adapter ID or null |

### Adapter Routing

```typescript
private getBaseUrl(): string {
  if (this.activeAdapterId && this.adapterUrl) {
    return this.adapterUrl   // route to remote adapter server
  }
  return this.primaryUrl     // route to primary server
}
```

When `LOCALCODE_ADAPTER_URL` is not set and `loadAdapter()` is called, `ProcessManager` restarts the primary server with `--lora`. When the URL is set, it just switches the target — zero cost.

---

## 6. Provider Selection & Startup Flow

**In `engine/main.ts`:**

```
1. Load config (env vars + profile)
2. Read LOCALCODE_PROVIDER (default: 'llama-cpp')
3. If 'llama-cpp':
   a. BinaryManager.resolve() — find or download llama-server
   b. ModelResolver.resolve(LOCALCODE_MODEL) — find GGUF file
   c. ProcessManager.ensureRunning() — check port, spawn if needed
   d. Wait for /health to return 200
   e. Construct LlamaCppProvider with primaryUrl, adapterUrl
4. If 'ollama':
   a. Existing OllamaProvider path (unchanged)
5. Continue with conversation loop as before
```

### Graceful Degradation

- Binary not found and can't download → fall back to Ollama if available, log warning
- GGUF not found → error with download instructions, no silent fallback
- Adapter URL configured but unreachable → adapter calls fall back to primary server with restart-swap, log warning

---

## 7. Configuration

### New Env Vars

| Variable | Default | Purpose |
|---------|---------|---------|
| `LOCALCODE_PROVIDER` | `llama-cpp` | `llama-cpp` or `ollama` |
| `LOCALCODE_LLAMA_SERVER` | auto | Path to llama-server binary |
| `LOCALCODE_MODEL_PATH` | auto | Explicit GGUF path override |
| `LOCALCODE_ADAPTER_URL` | none | Remote adapter server URL (e.g., `http://192.168.1.50:8081`) |
| `LOCALCODE_PORT` | 8081 | Primary llama-server port |
| `LOCALCODE_BATCH_SIZE` | 2048 | Prompt processing batch size |
| `LOCALCODE_GPU_LAYERS` | 999 | GPU layer offload count |
| `LOCALCODE_FLASH_ATTN` | true | Enable flash attention |
| `LOCALCODE_THREADS` | auto | CPU thread count |

### Unchanged Env Vars

| Variable | Still Used By |
|---------|--------------|
| `LOCALCODE_MODEL` | Both providers — model name |
| `LOCALCODE_CONTEXT_LENGTH` | Both providers — context window size |
| `LOCALCODE_TEMPERATURE` | Both providers — sampling temp |
| `LOCALCODE_TIMEOUT` | Both providers — request timeout |
| `LOCALCODE_TIER` | Both providers — capability tier override |
| `LOCALCODE_EMBED_MODEL` | Ollama only — embedding model (separate concern) |

---

## 8. New Files

| File | Purpose |
|------|---------|
| `engine/llama/provider.ts` | `LlamaCppProvider` implementing `Provider` interface |
| `engine/llama/processManager.ts` | Start/stop/restart llama-server child process |
| `engine/llama/binaryManager.ts` | Download, version-pin, resolve llama-server binary |
| `engine/llama/modelResolver.ts` | GGUF file resolution from model name |
| `engine/llama/errors.ts` | Provider-specific error types |

## 9. Modified Files

| File | Changes |
|------|---------|
| `engine/config.ts` | Add new env vars (PROVIDER, PORT, BATCH_SIZE, GPU_LAYERS, FLASH_ATTN, THREADS, LLAMA_SERVER, MODEL_PATH, ADAPTER_URL) |
| `engine/main.ts` | Provider selection logic — branch on LOCALCODE_PROVIDER, startup flow for llama-cpp path |

## 10. Unchanged Files

| File | Why |
|------|-----|
| `engine/provider.ts` | Interface already has adapter methods from v2 bridge work |
| `engine/ollama/format.ts` | Reused by both providers — protocol-level, not backend-level |
| `engine/ollama/simulated.ts` | Reused by both providers |
| `engine/ollama/probe.ts` | Reused by both providers |
| `engine/ollama/client.ts` | Untouched — still works for `LOCALCODE_PROVIDER=ollama` |
| `engine/bridge/*` | Talks to Provider interface, backend-agnostic |
| `engine/tools/*` | Backend-agnostic |
| `engine/vsm/*` | Backend-agnostic |
| `engine/agents/*` | Backend-agnostic |
