# happiness-overextension-penalty

## Target
- File: `happiness_system.py`
- Symbol: `HappinessSystem.overextension_penalty` (property), consumed by `HappinessSystem.current_happiness`.

## Behavior tested
Overextension reduces happiness once the empire exceeds its administrative city
limit (`_max_cities_before_penalty`, default 5). Each city beyond the limit costs
5 happiness.

- 5 cities (at the limit): penalty `0`, `current_happiness == 100`.
- 8 cities (3 excess): penalty `3 * 5 == 15`, `current_happiness == 85`.

The asserted path is fully deterministic and headless (no pygame, no randomness).

## What the patch removes
`setup.patch` replaces the body of `overextension_penalty` with a flat
`return 0`, deleting the threshold check and the `excess * penalty_per_city`
computation. With the patch, sprawling empires never lose happiness, so the
penalty stays 0 and `current_happiness` stays 100 for 8 cities — the test's
`== 15` / `== 85` assertions fail.

## Gate result
- Clean (commit 03b4032): `1 passed in 0.01s`
- Patched: `1 failed in 0.02s` (`assert 0 == 15`)
