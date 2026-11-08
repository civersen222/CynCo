# engine/power

## Purpose
The engine's and the daemon's relationship with the machine's power state, in two parts that share one signal. `activity.ts` is the signal: a process-wide refcount of what is open — a turn, a one-shot child, an in-flight model request — with edge callbacks on 0→1 (`onBusy`) and 1→0 (`onIdle`). `awake.ts` consumes it to keep Windows from sleeping while anything is open (a `SetThreadExecutionState` helper that lives exactly as long as the busy stretch); `engine/llama/idleUnload.ts` consumes it to unload the model only when nothing has been open for a while. Nothing here ever puts the machine to sleep: Windows' own idle timer does that, and the doorman (`scripts/doorman/`) wakes it. Design and rationale: `docs/decisions/2026-11-08-wakefulness-design.md` (slices 2 and 3).

## Key files
| File | Role |
|---|---|
| `activity.ts` | `ActivityRegistry` (`begin(kind,label) → end()`, `count()`, `snapshot()`, `onBusy`, `onIdle`) and the shared `activity` instance. |
| `awake.ts` | `wireHoldAwake(registry, deps?)`: spawns `scripts/hold-awake.ps1` on busy, kills it on idle; no-op off Windows. |

## Important types & functions
- **`ActivityRegistry`** (`activity.ts:16`) — the refcount. `begin` returns an idempotent `end`; listeners fire only on the 0↔1 edges, so overlapping activities produce one busy and one idle.
- **`activity`** (`activity.ts:58`) — the one instance; producers import it rather than threading a registry through constructors.

## Gotchas
- Producers must call `end()` on every exit path (a `finally`), or the PC never sleeps and the model never unloads. The returned closure is idempotent so a double call is safe.
- The registry is per process: the engine, the daemon and each one-shot child hold their own helper. That is intended — each process keeps the PC awake for its own work and the helper exits with its parent.
