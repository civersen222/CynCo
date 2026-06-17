# production-progress-clamp

## Subsystem
`production.py` (re-exports `ProductionPopup` from `pygame_app/popups/production.py`).

## Function / behavior targeted
`ProductionPopup._build_queue_html(city)` — builds the city production queue
display, including a 200-cell progress bar for the current build:

```
progress = min(prod / cost, 1.0) if cost > 0 else 0
bar_w = int(200 * progress)
bar = f"[{'#' * bar_w}{'.' * (200 - bar_w)}] {int(progress * 100)}%"
```

This is real rendering logic (fraction computation, clamping, bar-width math,
percent formatting), callable fully headless with a duck-typed city stub — no
pygame_gui UIManager and no randomness on the asserted path.

## What the patch removes
The `min(..., 1.0)` clamp on `progress`:

- clean:   `progress = min(prod / cost, 1.0) if cost > 0 else 0`
- patched: `progress = (prod / cost) if cost > 0 else 0`

With an over-funded item (production 90 vs cost 60 → fraction 1.5) the unclamped
value yields `bar_w = int(200 * 1.5) = 300`, so the bar renders 300 `#` cells
(overflowing its 200-cell track) and reports `150%` instead of a full 200-cell
bar at `100%`.

## Hidden test
- `test_midprogress_bar_is_half_filled`: 30/60 → exactly 100 `#`, 100 `.`,
  length 200, `50%` present. Pins the bar-width math (unaffected by the patch;
  guards against trivial/degenerate fixes).
- `test_overflow_production_clamps_to_full_bar`: 90/60 → full 200-`#` bar, no
  `.`, `100%` present, `150%` absent. This is the assertion the clamp protects.

## Gate result (temp clone, pinned 03b4032, SDL_VIDEODRIVER=dummy)
- clean:   `2 passed in 0.31s`
- patched: `1 failed, 1 passed in 0.42s`
  (`test_overflow_production_clamps_to_full_bar` — `assert 300 == 200`)
