# engine/daemon

## Purpose
The CynCo liveness layer: a tiny always-on sentinel (`main.ts`) that never loads a model itself, ticks scheduled missions on a 30s interval, and spawns a real governed engine run in a separate process only when a trigger is actually due. It talks to the phone over a self-hosted ntfy server (`ntfyChannel.ts`) — publishing digests/recommendations and receiving approve/reject taps and free-text commands — and hands each due trigger to `taskRunner.ts`, which GPU-guards and spawns `engine/main.ts --run-task <file>` as a child process. The child runs `oneShot.ts`, which drives the prompt through the same S5/VSM-governed `ConversationLoop` interactive sessions use, then writes a `TaskOutcome` JSON the daemon reads back. It must never run model inference in-process, never let an SSE command callback start a model run directly (text commands are queued and only fired from `tick()`), and never let the one-shot child inherit the daemon's ntfy credentials.

## Key files
| File | Role |
|---|---|
| `types.ts` | Shared contracts (TriggerSpec, MissionConfig, TaskFileInput/Outcome, MissionState, CommandMessage) between the daemon and the one-shot engine. |
| `taskFile.ts` | Reads/writes the task-file and outcome-file JSON that cross the daemon/engine process boundary. |
| `main.ts` | Entry point: loads missions, wires ntfy + MissionRunner, runs the 30s tick loop, handles shutdown. |
| `missionLedger.ts` | Per-mission on-disk state (state.json, runs.jsonl): trust ladder, pending approvals, atomic saves, corrupt-file recovery. |
| `missionRunner.ts` | Per-mission tick logic: evaluates triggers, fires tasks, handles GPU-busy backoff, failure/halt alerts, approvals, text commands. |
| `ntfyChannel.ts` | Self-hosted ntfy client: publish (with offline queue) and SSE subscribe for phone commands. |
| `oneShot.ts` | Runs INSIDE the spawned engine process: drives one prompt through `ConversationLoop`, extracts the outcome contract, writes it out. |
| `scheduler.ts` | Pure trigger-time arithmetic (interval/daily/weekly/cron) — no I/O, no `Date.now()`. |
| `taskRunner.ts` | Spawns the one-shot engine child with a GPU guard and hard timeout/kill. |
| `tradeScan.ts` | Multi-pass trade-scan orchestrator (`taskType: 'trade-scan'`), dispatched from `oneShot.ts`, runs inside the same engine process. |

## Important types & functions
- **`TriggerSpec` / `TaskFileInput` / `TaskOutcome`** (`types.ts:7`, `types.ts:53`, `types.ts:70`) — the contracts every other daemon file passes across the daemon↔engine process boundary.
- **`MissionRunner`** (`missionRunner.ts:33`) — the class whose `tick()` (called every 30s from `main.ts`) drives the whole per-mission scheduling/firing/notification loop.
- **`runGovernedLoop`** (`oneShot.ts:132`) — runs one prompt through the real `ConversationLoop`, called by both `runOneShotTask` and `tradeScan.ts`'s final ranking pass.
- **`runOneShotTask`** (`oneShot.ts:193`) — the function `engine/main.ts` invokes when `--run-task` is passed; reads the task file, dispatches to `runGovernedLoop` or `runTradeScan`, writes the outcome.
- **`TaskRunner`** (`taskRunner.ts:63`) — its `run()` method GPU-guards, spawns the child engine process, enforces the timeout, and reads back the outcome.
- **`isGpuBusy`** (`taskRunner.ts:22`) — nvidia-smi + tasklist heuristic; both probes fail open (can't tell → let the run proceed).
- **`MissionLedger`** (`missionLedger.ts:14`) — loads/saves per-mission `state.json`/`runs.jsonl`; `saveState()` writes atomically via tmp-file rename.
- **`evaluateTrigger` / `computeNextFire`** (`scheduler.ts:127`, `scheduler.ts:98`) — pure trigger arithmetic consumed by `MissionRunner.tick()`.
- **`NtfyChannel`** (`ntfyChannel.ts:36`) — `publish`/`publishRecommendation`/`subscribe` used by `main.ts` and injected into `MissionRunner`.
- **`runTradeScan`** (`tradeScan.ts:163`) — the multi-pass orchestrator dispatched from `oneShot.ts` when `taskType === 'trade-scan'`.

## Data flow
1. `main.ts` loads every `<mission-id>/mission.json` under `CYNCO_MISSIONS_DIR`, builds a `MissionLedger` + `TaskRunner` per mission, and starts a 30s `setInterval` calling `runner.tick()` on each `MissionRunner`.
2. `MissionRunner.tick()` (`missionRunner.ts:50`) calls `evaluateTrigger` (`scheduler.ts:127`) per trigger; a due trigger's `nextFire` is persisted to `state.json` *before* firing, then `fire()` (`missionRunner.ts:85`) runs.
3. `fire()` optionally runs the `mfl-delta` precheck, builds mission context (goal + last 3 runs + roster snapshots), and calls `deps.runTask(input)` — in production this is `TaskRunner.run()`.
4. `TaskRunner.run()` (`taskRunner.ts:70`) checks `isGpuBusy()`; if free, it writes the task file (`taskFile.ts:10`) and spawns `bun engine/main.ts --run-task <path>` as a child process (ntfy env vars stripped), enforcing `timeoutMs` with a hard kill.
5. Inside the child, `engine/main.ts` calls `runOneShotTask` (`oneShot.ts:193`), which reads the task file and either calls `runGovernedLoop` (plain prompt) or `runTradeScan` (`tradeScan.ts:163`) for `taskType: 'trade-scan'`.
6. `runGovernedLoop` (`oneShot.ts:132`) drives the prompt through `ConversationLoop` with `approveAll`/`noScouts`, then `extractOutcome` (`oneShot.ts:37`) parses the model's fenced JSON into a `TaskOutcome`, which `writeOutcome` (`taskFile.ts:24`) writes to `outcomePath`.
7. `TaskRunner.run()` reads the outcome back via `readOutcome` (`taskFile.ts:29`) and returns it to `fire()`, which records a `RunRecord` (`missionLedger.ts:58`), saves pending recommendations, and — before any notification — calls `MissionLedger.saveState()`.
8. `fire()` publishes: recommendations via `NtfyChannel.publishRecommendation` (`ntfyChannel.ts:105`), halts/failure streaks via `NtfyChannel.publish` at priority 5, or a plain digest when there's nothing actionable.
9. Phone taps/text arrive over `NtfyChannel.subscribe` (`ntfyChannel.ts:132`, SSE) into `main.ts`'s command handler, which calls `MissionRunner.handleCommand` (approvals) or `handleTextCommand` (queued, drained only by the next `tick()`).

## Gotchas
- A model run must NEVER start from the SSE command callback — free-text commands are queued in `onDemand` and only fired from `tick()`'s `drainOnDemand` (`missionRunner.ts:235`); pinned by `handleTextCommand("lineup") queues a request and publishes an ack` in `missionRunner.test.ts`.
- `nextFire` is persisted to `state.json` *before* firing, so a crash mid-run can't re-fire the same trigger on restart (`missionRunner.ts:57`); pinned by `persists nextFire to disk before firing — a crash mid-run cannot re-fire`.
- All ledger mutations (pending recs, failure streak) are saved BEFORE any phone notification — a crash between save and publish must never leave a notification with no matching pending state (`missionRunner.ts:200`); pinned by `Fix 1: pending is on disk even when publishRecommendation throws`.
- A HALT (`error` starting with `"HALTED:"`) pages immediately at priority 5 regardless of the failure streak — it does not wait for `FAILURE_ALERT_THRESHOLD` (`missionRunner.ts:178`); pinned by `publishes immediately with priority 5 when the outcome is a HALT, regardless of failure streak`.
- The spawned one-shot engine must NOT inherit the daemon's `CYNCO_NTFY_*` env — it can only report through its outcome file, never talk to the phone directly (`taskRunner.ts:84`); pinned by `strips CYNCO_NTFY_* env so the one-shot engine cannot act as the daemon`.
- Recommendation ids are always minted by `extractOutcome` (`rec-<hex>`), never trusted from the model — they key the ledger's pending map and ride ntfy approve buttons (`oneShot.ts:46`); pinned by `assigns ids to recommendations missing one`.
- `resolveApproval` uses `Object.hasOwn` to guard against prototype-pollution keys like `"constructor"` reaching the plain-object pending map (`missionLedger.ts:88`); pinned by `resolveApproval ignores prototype keys like "constructor"`.
- A corrupt `state.json` (power loss mid-write) is backed up to `.corrupt` and the mission starts with fresh state instead of crash-looping the daemon forever (`missionLedger.ts:33`); pinned by `survives a corrupt state.json: backs it up and starts fresh`.
- `isGpuBusy` fails open on both probes: if nvidia-smi or tasklist can't be read, the run proceeds rather than blocking forever (`taskRunner.ts:20`); pinned by `returns false when the process list is unavailable`.
- Zero assistant turns (every model call timed out) must report failure, not the unstructured-fallback `ok: true` — `runGovernedLoop` gates on `countAssistantTurns(messages) === 0` before falling through to `extractOutcome` (`oneShot.ts:176`).
