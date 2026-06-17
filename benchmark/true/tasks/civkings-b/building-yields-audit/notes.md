# building-yields-audit — author notes

## Summary
Make `City.calculate_yields()` honor **every** declared effect field of every
placed building generically, so each `BuildingType` field reaches the returned
yields dict, without regressing already-working yields, district adjacency, or
climate multipliers.

## Files / sites
- **`city.py`** — `City.calculate_yields()`, the "Add yields from buildings"
  loop (around L234–250 at green). Reference fix replaces the hardcoded
  per-field `if building.X > 0` block with a generic loop over the
  `BuildingType` effect fields, adding each declared positive field to the
  yields dict (`defense_bonus` surfaced under the `"defense"` key; `happiness`
  also still accumulates into `self.happiness` so the downstream
  stability/production math is unchanged).
- **`game_data.py`** — read only. `BUILDINGS` is a `dict[str, BuildingType]`
  (`@dataclass`) with fields `food/production/gold/science/faith/culture/
  happiness/defense_bonus` (+ `defense`/`requires_*`). City constructor:
  `City(name, owner, position, ...climate_zone=...)`; add a building via
  `city.add_building(BUILDINGS["..."])`.

## Important finding (premise correction)
At the pinned green ref `03b4032`, the standard six yields
(food/gold/science/production/faith/culture) declared by buildings are **already
applied correctly** by the existing loop — commit `c827c02 "Add building yield
effects to cities"` had fixed that. So there is **no** science/gold orphan at
this ref, contrary to the original task brief, and **no `setup_patch` is used**
(per the constraint).

The genuinely-orphaned declared fields at green are the ones the loop never
surfaces into the returned dict:
- **`happiness`** — declared by **Theater** (`happiness=3`); never appears as a
  yields key.
- **`defense_bonus`** — declared by **Wall** (`20`) and **Barracks** (`10`);
  never appears as a yields key.

The task/tests were therefore targeted at these real orphans while keeping the
exact same theme ("honor every building's declared effects generically"). The
generic test (c) also re-confirms the already-working six are still correct.

## Orphaned buildings the tests target
- Theater (declared `happiness=3`)
- Wall, Barracks (declared `defense_bonus=20` / `10`)

## Tests (independent, headless, deterministic)
- `test_declared_happiness_reaches_yields` — a happiness-declaring building
  surfaces happiness by the declared amount. (FAILS green)
- `test_declared_defense_reaches_yields` — a defense-declaring building surfaces
  its defense bonus (accepts `defense` or `defense_bonus` key). (FAILS green)
- `test_every_declared_effect_reflected_generically` — for every building, each
  positive declared effect field moves the matching output entry by exactly the
  declared amount (temperate, climate mults = 1.0). (FAILS green)
- `test_existing_yields_and_climate_not_regressed` — regression guard: Library
  science contribution stays exactly +2 (no double count) and a non-temperate
  climate multiplier (TROPICAL food = 1.2) still applies. (PASSES green)

## Gate scores
- **GREEN** (no patch): **1/4** pass (only the regression test passes).
- **REFERENCE** (`git apply reference_solution.patch`): **4/4** pass.
- Existing game suites (`test_economy_systems.py`, `test_civkings.py`): 24/24
  still pass with the fix.

## Assumptions
- `defense_bonus` may legitimately surface under either a `"defense"` or
  `"defense_bonus"` output key (tests accept both); the reference uses
  `"defense"`.
- Comparisons use temperate climate (all multipliers 1.0) so declared deltas are
  exact; the regression test separately proves climate multipliers still run.
