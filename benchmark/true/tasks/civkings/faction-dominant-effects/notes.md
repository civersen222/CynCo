# faction-dominant-effects

## Targeted behavior
`FactionManager.get_faction_effects()` in `faction_system.py`.

A faction with `influence >= 70` is `is_dominant` and must add its
`FACTION_TYPES[type]['bonuses']` to the combined effects, each scaled by `0.1`.
A faction with `influence <= 20` is `is_marginalized` and adds its `penalties`
scaled by `0.05`. These two aggregation paths plus the dominant-detection are
the real logic under test (not a trivial getter).

## Symbols
- `FactionManager.get_faction_effects`
- `Faction.is_dominant` / `Faction.is_marginalized` (influence thresholds)
- `FactionManager.FACTION_TYPES[...]['bonuses']`

## What the patch removes
The two-line `for stat, bonus ...: effects[stat] += bonus * 0.1` loop inside the
`if faction.is_dominant:` branch is replaced with `pass`. The marginalized
penalty path is left intact, so with the patch only penalties surface and every
dominant bonus disappears.

## Test expectations (deterministic, headless, no randomness)
Factions are constructed directly (not via `initialize_factions`, which adds
random members), so no RNG touches the asserted path.

- nobles influence=80 (dominant: stability=5, military=10),
  popular influence=10 (marginalized: stability=-5, military=-5),
  conflict_level=0:
  - military == 0.75  (1.0 bonus - 0.25 penalty)
  - stability == 0.25 (0.5 bonus - 0.25 penalty)
- religious influence=50 -> culture/happiness == 0.0 (not dominant)
  raised to 75 -> culture == 1.0, happiness == 0.5

## Gate result (temp clone of pinned 03b4032, SDL_VIDEODRIVER=dummy)
- clean:   `2 passed in 0.02s`
- patched: `2 failed in 0.04s`
