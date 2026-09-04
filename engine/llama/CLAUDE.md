# engine/llama

## Purpose
The llama.cpp serving layer underneath LocalCode's default provider: resolve the llama-server binary and GGUF model file, derive launch arguments (context window, checkpoint budget, KV cache), spawn and health-check the process, measure host commit charge and VRAM before every spawn and refuse rather than crash, back off and cap crash restarts, snapshot/restore slot KV across restarts, and expose an OpenAI-compatible `Provider` (`LlamaCppProvider`) to the rest of the engine. `engine/bootstrapProvider.ts` is the sole assembler — it builds the `ProcessManager` and `LlamaCppProvider` for both `engine/main.ts` and `benchmark/true/run.ts`; `engine/providers/factory.ts` and `engine/training/runTraining.ts` also reach in directly for provider construction and adapter resolution. It must never invent a checkpoint cost when the GGUF header or a live calibration disagrees with the hardcoded default (F89: never invented, always measured), never treat `--ctx-size`, `--ctx-checkpoints` and `--cache-ram` as independent choices (F91), and never let a transient host-memory shortage burn the whole crash-restart budget in minutes instead of refusing early (F140).

## Key files
| File | Role |
|---|---|
| `processManager.ts` | `ServerConfig`/`ProcessManagerConfig`, `buildServerArgs`, and `ProcessManager` — spawn, health check, crash backoff/budget, pre-spawn refusal, slot save/restore orchestration |
| `provider.ts` | `LlamaCppProvider` — the OpenAI-compatible `Provider`: `complete`/`stream`/`countTokens`, adapter routing |
| `gguf.ts` | GGUF header reader (`readGgufMeta`) — architecture-derived KV/checkpoint shape, never reads the tensors |
| `checkpointCost.ts` | Derives the affine checkpoint cost model from `GgufMeta`; sizes `--cache-ram` |
| `checkpointCalibration.ts` | `CheckpointCalibrator` watches live server checkpoint log lines, fits and persists a measured correction |
| `hostResources.ts` | Pre-spawn host commit-charge and GPU VRAM reads plus the refusal decision (F140) |
| `binaryManager.ts` | Resolve/download the llama-server binary (bin-brain vs bin, GitHub release download) |
| `modelResolver.ts` | Resolve a model name or adapter name to a GGUF file path |
| `errors.ts` | Typed errors (`BinaryNotFoundError`, `ModelNotFoundError`, `ServerStartError`, `AdapterNotFoundError`) and type guards |

## Important types & functions
- **`ProcessManager`** (`processManager.ts:295`) — owns the child process, restart budget, checkpoint-cost precedence, and slot snapshots; constructed once per server by `bootstrapProvider`.
- **`buildServerArgs`** (`processManager.ts:70`) — turns a `ServerConfig` into the llama-server CLI argv, including the derived `--cache-ram`.
- **`DEFAULT_CTX_SIZE`** (`processManager.ts:50`) — 131072; the context `bootstrapProvider` uses whenever no profile/env pins one, and the number the conversation loop's compaction trigger is a fraction of.
- **`restartDelayMs`** (`processManager.ts:246`) — exponential backoff per crash restart, capped at 120s, called from the `exit` handler.
- **`shouldRestartAfterExit`** (`processManager.ts:228`) — decides whether an exit should respawn: never for a deliberate stop, otherwise gated on the rolling restart budget.
- **`recentRestartCount`** (`processManager.ts:213`) — counts restarts inside a rolling window; called by `shouldRestartAfterExit`'s caller and the `exit` handler.
- **`SLOT_SNAPSHOT_FILE`** (`processManager.ts:254`) — `'session.bin'`, the one snapshot filename `saveSlot`/`restoreSlot` pass to llama-server's `/slots/0` API.
- **`validateChatTemplate`** (`processManager.ts:177`) — checks `/props` for tool-call support after health; non-fatal, sets `templateWarning`.
- **`readGgufMeta`** (`gguf.ts:93`) — streams the GGUF header in 1 MiB steps and returns `GgufMeta`; called once by `ProcessManager`'s constructor.
- **`checkpointCostFromMeta`** (`checkpointCost.ts:42`) — walks the header's per-layer pattern (global/sliding-window/SSM) into a `CheckpointCostModel`.
- **`derivedCacheRamMib`** (`checkpointCost.ts:85`) — the `--cache-ram` a context and checkpoint count require; called from `buildServerArgs`.
- **`worstCheckpointMib`** (`checkpointCost.ts:75`) — host memory one checkpoint costs at the far end of a context window; used by `derivedCacheRamMib` and `spawnRequirementFor`.
- **`CheckpointCalibrator`** (`checkpointCalibration.ts:42`) — observes checkpoint log lines, fits an affine correction, persists it, and warns when the derived model is off by more than tolerance.
- **`evaluateSpawn`** (`hostResources.ts:121`) — compares measured host/GPU memory to a `SpawnRequirement` and returns ok or a reason; never refuses on an `'unavailable'` reading.
- **`spawnRequirementFor`** (`hostResources.ts:112`) — computes commit and VRAM floors for a launch from context size, model file size, and the checkpoint cost model.
- **`LlamaCppProvider`** (`provider.ts:37`) — the `Provider` implementation the rest of the engine calls for completions, streaming, token counts, and adapter load/unload.

## Data flow
1. **Engine start**: `bootstrapProvider` resolves the binary (`resolveBinary`/`downloadBinary`) and model (`resolveModel`), then constructs `new ProcessManager(...)` — whose constructor picks the checkpoint cost model in precedence order: stored calibration (`CheckpointCalibrator.loadStored`) → GGUF header (`checkpointCostFromMeta(readGgufMeta(...))`) → measured default (`MEASURED_DEFAULT_COST`) (`processManager.ts:328`). `bootstrapProvider` then calls `ensureRunning()`, which kills any stale server on the port and calls `startProcess()`; `startProcess()` runs `preSpawnCheck()` (which wraps `evaluateSpawn`), then `spawn()` with `buildServerArgs(...)`, then `waitForHealth()`, then `validateChatTemplate()`.
2. **A crash**: the child's `exit` handler (`processManager.ts:552`) computes `deliberate` and calls `shouldRestartAfterExit`; if it says yes, `restartDelayMs(recentRestarts)` sets the backoff before `startProcess()` runs again. That retry re-enters `preSpawnCheck()`; a refusal there pops the just-added timestamp back off `restartTimes` (hands the budget back) and reschedules after `REFUSAL_RECHECK_MS` instead of consuming a restart. A successful restart calls `restoreSlot()` to bring back the last slot KV snapshot instead of re-prefilling from token 0.

## Gotchas
- `--ctx-size`, `--ctx-checkpoints` and `--cache-ram` are one decision, not three (F91): "Raising the window raises what each checkpoint can cost... and raising the count multiplies it; leaving the budget behind is what produced 'failed to allocate memory for prompt cache state: bad allocation' 753 turns into CivKings 11M" (`processManager.ts:132`). Pinned by `describe('context size, checkpoints and cache-ram move together (F91)', ...)` in `engine/__tests__/llama/processManager.test.ts`.
- A checkpoint's cost is affine in tokens, not proportional: a constant term (SSM recurrent state + sliding-window KV) plus a per-token term, both derived from the GGUF header in `checkpointCost.ts:42`. Pinned by `describe('checkpointCostFromMeta', ...)` in `engine/__tests__/llama/checkpointCost.test.ts`.
- `nvidia-smi` cannot see llama.cpp's own VMM allocations, so the GPU reading `readGpuMemory` produces is only meaningful **before** our server is up — exactly when `preSpawnCheck` runs (`hostResources.ts:79`). Pinned by `describe('evaluateSpawn', ...)` in `engine/__tests__/llama/hostResources.test.ts`.
- The `--slot-save-path` filename must not contain path separators: `SLOT_SNAPSHOT_FILE` is the bare name `'session.bin'` because "llama-server refuses path separators in the name" (`processManager.ts:253`). Pinned by `describe('slot snapshot flags', ...)` in `engine/__tests__/llama/slotSnapshot.test.ts`.
- The restart budget is 3 crash restarts in 600s (`MAX_RESTARTS_IN_WINDOW`, `RESTART_WINDOW_MS` at `processManager.ts:202`); a refused spawn during a retry hands its slot back instead of spending it (F140), so a memory-pressure event cannot exhaust the budget in minutes the way it did before. Pinned by `describe('what to do when llama-server exits', ...)` and `describe('restartDelayMs — a transient fault must not spend the whole budget in a minute', ...)` in `engine/__tests__/llama/processManager.test.ts`.
- `bin-brain` (the activation-tap build) outranks the stock `bin` download in `resolveBinary` (`binaryManager.ts:27`) — it sat unselected for five weeks because nothing chose it, silently downgrading the brain readout to entropy-only.
