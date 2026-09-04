# engine/brain

## Purpose
The Brain is LocalCode's telemetry layer on top of the model's own token stream: it turns per-token logprobs into entropy signals, taps a patched llama-server's raw activations, and (when available) reads those activations out through the jlens sidecar (the J-Space viewer, port 9163). It auto-detects which of three tiers it can run at — `live` (tap + sidecar), `record-only` (tap only), `entropy-only` (neither) — and never blocks or fails decode: every dependency failure degrades silently to a log line and a lower tier. `conversationLoop.ts` drives the entropy/divergence side per turn; `main.ts` owns the Tier 3 `ActivationsConsumer` and sidecar process lifecycle, wiring `setBrainLayer` into the dashboard so a browser can switch the readout layer live. `dashboard/server.ts` exposes `POST /api/brain/layer` for that switch. The package must never throw into the model-serving path, and must never write telemetry to the live trajectory corpus from a test or sandbox context (the recording directory is injected, not defaulted).

## Key files
| File | Role |
|---|---|
| `activationsConsumer.ts` | Tier 3: polls `/activations` on the llama-server, decodes fp32 payloads, runs jlens readouts, auto-detects/re-probes the tier, broadcasts `brain.tier`/`brain.workspace`. |
| `brainRecorder.ts` | Persists per-turn entropy and divergence telemetry to `<trajectoryDir>/brain/<taskId>.jsonl`, joinable to trajectory rows by `(task_id, turn_idx)`. |
| `jlensClient.ts` | HTTP client for the jlens sidecar's `/health` and `/readout` endpoints; null-degrades on any failure. |
| `jlensSidecar.ts` | Decides whether to manage a jlens sidecar process, kills stale ones, and spawns/stops a fresh one. |
| `toolDivergence.ts` | Detects reasoning/action divergence: a confident (low-entropy) tool emission that the read-loop gate has disabled. |

## Important types & functions
- **`decodeB64Floats`** (`activationsConsumer.ts:10`) — decodes a base64 fp32 activation payload into a `Float32Array`; called by `ActivationsConsumer.pollOnce`.
- **`ActivationsConsumer`** (`activationsConsumer.ts:37`) — Tier 3 poll/readout/broadcast loop; `start()`/`stop()` called from `main.ts`, `layer` mutated by `setBrainLayer`.
- **`BrainTier`** (`activationsConsumer.ts:35`) — the `'live' | 'record-only' | 'entropy-only'` union reported in `brain.tier` broadcasts.
- **`BrainRecorder`** (`brainRecorder.ts:53`) — accumulates tool-token entropy per model call and writes `turn`/`divergence` JSONL rows; constructed in `conversationLoop.ts` with a `dirFor` callback bound to `getTrajectoryRecorder()?.brainDir`.
- **`ToolEntropySummary`** (`brainRecorder.ts:26`) — `{n, mean, min, max}` over one model call's tool-token entropies; `n` is carried so a two-token mean isn't mistaken for a two-hundred-token one.
- **`JlensClient`** (`jlensClient.ts:7`) — `health()`/`readout()` against the sidecar at `LOCALCODE_JLENS_URL` (default `http://127.0.0.1:9163`); used by `ActivationsConsumer`.
- **`sidecarDecision`** (`jlensSidecar.ts:41`) — pure function: whether the engine should start/manage a sidecar, given the configured URL and artifact presence; unit-tested directly.
- **`startJlensSidecar`** (`jlensSidecar.ts:93`) — kills stale sidecars, spawns a fresh one if `sidecarDecision` says to, and returns a `stop()` handle; called once from `main.ts` when `provider === 'llama-cpp'`.
- **`ToolDivergenceDetector`** (`toolDivergence.ts:10`) — tracks a running entropy floor over the tool stream and flags a disabled tool emitted with confidence below it; driven from `conversationLoop.ts`'s read-loop escalation path.

## Data flow
1. `conversationLoop.observeUncertainty` receives per-token logprobs (thinking/output/tool) from the model stream and computes entropy via `UncertaintyTracker.entropy`.
2. Tool-kind entropy feeds both `ToolDivergenceDetector.observeEntropy` and `BrainRecorder.observeToolEntropy`; all entropy points are batched and flushed as `brain.uncertainty` / `brain.toolUncertainty` through `dashboardBroadcast` once 16 points accumulate (`flushUncertainty`).
3. At model-call start, `resetBrainTurnState` clears the uncertainty batch, the recorder's window, and the thinking buffer so an aborted call cannot bleed entropy into the next.
4. When the read-loop gate escalates on a confident emission of a disabled tool, `ToolDivergenceDetector.check` produces a verdict, redundant reads are pruned, and both `dashboardBroadcast({type:'brain.toolDivergence', ...})` and `BrainRecorder.recordDivergence` fire.
5. At each tool-call turn boundary, `BrainRecorder.recordTurn` writes the accumulated `BrainRecorder.snapshot()` keyed on the trajectory recorder's `taskId`/`turnIdx` (read before `recorder.recordTurn` increments it, so the join lands on the right row).
6. Independently, if `provider === 'llama-cpp'`, `main.ts` calls `startJlensSidecar` then constructs `ActivationsConsumer` and calls `start()`, which probes the activation tap and jlens health, announces the tier via `brain.tier`, and — while `live` — polls `/activations`, decodes each entry with `decodeB64Floats`, gets a `JlensClient.readout`, and broadcasts `brain.workspace` per entry.
7. `evaluate()` re-probes on a timer (default 10s) only when the tap was configured at spawn, so a sidecar that comes up late upgrades the tier without a restart; `stop()` (called from `main.ts` shutdown) clears both timers.

## Gotchas
- Tier auto-detection is live, not one-shot: "the tier used to be decided once here and never revisited, so a jlens sidecar started a minute after the engine left the dashboard reading `record-only` until the next restart" (`activationsConsumer.ts:56-59`) — pinned by `activationsConsumer.test.ts` ("promotes record-only -> live when the jlens sidecar comes up later", "announces the tier once, not on every re-probe").
- A 200 from `/activations` does not mean the tap is on: "the patched binary serves /activations (empty forever) even with taps off, so a 200 alone must not count as tap up" — pass `tapConfigured` explicitly (`activationsConsumer.ts:26-28`); pinned by the `tapConfigured=false` test in `activationsConsumer.test.ts`.
- `brain.uncertainty` / `brain.toolUncertainty` / `brain.tier` / `brain.workspace` / `brain.toolDivergence` all go through `dashboardBroadcast` directly — never `this.emit` and never the engine→TUI protocol. Pinned by `engine/__tests__/bridge/brainWiring.test.ts` ("brain.uncertainty goes through dashboardBroadcast, not this.emit (protocol guard)", "brain.toolUncertainty is NOT in the engine→TUI protocol (ts or py)").
- Entropy is tracked even with no dashboard attached — the divergence floor and recorded telemetry must not depend on a dashboard being connected (`engine/bridge/conversationLoop.ts:571`); pinned by `brainTelemetryWiring.test.ts` ("captures tool entropy with no dashboard attached").
- The divergence floor has an absolute floor and cap (`ToolDivergenceDetector.ABS_FLOOR = 0.05`, `ABS_CAP = ln(2)`) because a real model's tool-token entropy sits so close to zero that a pure σ-floor would collapse to ~0 and never flag anything (`toolDivergence.ts:13-19`).
- The jlens sidecar is never adopted from a prior run, only killed and respawned: "on Windows children outlive their parent, and a sidecar from a dead engine is a process whose state nobody can account for" (`jlensSidecar.ts:11-15`), matching only on the module name so a foreign process on the port is left alone to fail its own bind.
- `BrainRecorder`'s trajectory directory is injected via a `dirFor()` callback, never defaulted — a caller redirecting the trajectory directory (tests, sandboxes) must not have its telemetry land in the real corpus (`brainRecorder.ts:12-15`); pinned by `brainTelemetryWiring.test.ts` ("the brain directory follows the trajectories and never the live corpus") and `brainRecorder.test.ts` ("writes nothing when there is no directory").
- `joinTurnIdx` must be read from `recorder.turnIdx` *before* `recorder.recordTurn` runs, since that call increments it — otherwise the brain row joins to the wrong trajectory row (`engine/bridge/conversationLoop.ts:4180`).
