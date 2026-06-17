# improvements-worker-build-progress

## Function / behavior targeted
`ImprovementManager.process_turn` in `improvements.py` — the worker-presence
gate that controls when an in-progress tile improvement advances.

Real logic exercised (not a trivial getter):
- An active improvement only advances when its tile `(x, y)` is in
  `tiles_with_workers`. Tiles with no worker (empty set, or a worker on a
  different tile) must stay at progress 0.
- After exactly `build_turns` worker-turns (Farm = 3) the improvement
  completes: `improvement_progress` flips to `-1` and the entry is removed
  from `_active_improvements`, and a completion message is returned.

## What the patch removes
Deletes the worker-presence guard at the top of the per-improvement loop:
```
if (x, y) not in tiles_with_workers:
    continue
```
With the guard gone, `process_turn` advances every active improvement every
turn regardless of where the Worker is — so Farms finish with no worker on the
tile, and a worker on `(9,9)` still completes a build on `(2,3)`.

## Why the asserted path avoids the pre-existing repo bug
At pinned commit 03b4032, `can_improve` references an undefined name
(`allowed_terrain`) and raises `NameError` for every call, so
`can_improve` / `start_improvement` / `get_available_improvements` are NOT
clean-testable. The test therefore sets tile state and `_active_improvements`
directly and only exercises `process_turn`, which does not call `can_improve`.
The emoji `print` in `process_turn` is safe under pytest's stdout capture
(UTF-8) even though it would crash on the raw cp1252 Windows console.

## Gate result (temp clone of /c/Users/civer/civkings @ 03b4032, SDL dummy)
- clean:   `3 passed in 0.0Xs`
- patched: `2 failed, 1 passed` (test_worker_advances_and_completes_at_build_turns
  still passes since the worker IS present; the two no-progress-without-worker
  tests fail because progress advances anyway)

See REPORT for verbatim pytest lines.
