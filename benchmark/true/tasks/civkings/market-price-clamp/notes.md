# market-price-clamp

## Subsystem
`market_simulation.py` — commodity prices / supply-demand.

## Behavior targeted
`MarketSimulation.calculate_price(resource)` clamps the computed price into the
market's sane range `[0.1, 100.0]` via the final line
`price = max(0.1, min(100.0, price))`.

This clamp is the only RNG-independent guarantee in `calculate_price`: the raw
price is `base * (demand / supply)` multiplied by a random fluctuation factor in
`[0.9, 1.1]`. By choosing extreme supply/demand ratios the fluctuation can never
pull the result back inside the bounds, so the clamp's effect is fully
deterministic:

- supply=1, demand=100000 -> raw ~100000, fluctuation keeps it >= 90000 -> clamp pins to **100.0**.
- supply=100000, demand=1 -> raw ~1e-5 -> clamp pins to **0.1**.

The hidden test asserts both the ceiling (`== 100.0`) and the floor (`== 0.1`),
and loops 200x each direction so any surviving randomness would surface.

## What the patch removes
`setup.patch` deletes the single clamp line `price = max(0.1, min(100.0, price))`
from `calculate_price`, leaving `return price` to emit the unbounded raw value.
No other logic is touched.

## Symbol(s)
- `MarketSimulation.calculate_price`

## Gate result (temp clone of pinned commit 03b4032, headless SDL dummy)
- Clean: `2 passed in 0.01s`
- Patched: `2 failed in 0.04s`
  - ceiling test: raw ~9e4 exceeds 100.0
  - floor test: `assert 1.0257673174169825e-05 >= 0.1` fails
