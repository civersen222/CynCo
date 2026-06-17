# starvation-cascade — author notes

## Behavior under test
CivKings cities grow on a food surplus but never starve. This task adds a
starvation cascade: a food deficit (food income < population consumption)
must drain population over turns, apply a per-city happiness penalty, and —
when severe / sustained — drag stability below the well-fed baseline, while
well-fed cities still grow and population never falls below a floor of 1.

## Codebase facts (ref 03b4032)
- `City.__init__(name, owner, position, population=1, gold=0, climate_zone=ClimateZone.TEMPERATE, is_coastal=False)` (city.py).
- `City.calculate_yields()` food = `2.0 + population * 0.5`, then `* climate.food_multiplier` (`+ coastal bonus` if `is_coastal`). For `ClimateZone.TEMPERATE` every multiplier is 1.0 and `happiness_modifier` is 0.0, so the food math is fully deterministic and repeated `calculate_yields()` calls do not mutate `happiness`.
- `City.grow()` computes `consumption = population * 1.5`; pre-change it only ever *increments* population (`if food > consumption and population < 20`). No starvation path existed.
- `calculate_yields()` returns a `"stability"` key = `50 + (building/district bonuses) + happiness`, clamped to [0, 100]. Per-city happiness is the `city.happiness` int.
- `happiness_system.HappinessSystem` is an **empire-wide** system, not per-city — the per-city happiness used by stability is `city.happiness`. The tests therefore exercise the `City` object directly.
- Turn integration point: `Game.process_turn` (game.py ~line 700) calls `city.grow()` once per city per turn, so adding the cascade inside `City.grow()` wires it into the real turn loop automatically.

## Deterministic test setups (all TEMPERATE, non-coastal)
- pop 16 → food 10.0 vs consumption 24.0 → deep deficit (drain / happiness / stability tests).
- pop 4  → food 4.0  vs consumption 6.0  → mild deficit (floor test, ground down over 40 turns).
- pop 1  → food 2.5  vs consumption 1.5  → healthy surplus (regression + well-fed stability baseline = 50).

## Hidden tests (5, independent)
- `test_food_deficit_drains_population` — sustained deficit shrinks population below start.
- `test_starvation_applies_happiness_penalty` — starving city's `happiness` drops below its start value.
- `test_severe_starvation_reduces_stability` — after a sustained deficit, `calculate_yields()['stability']` is below the well-fed baseline (50).
- `test_well_fed_city_still_grows` — regression guard: surplus city still grows.
- `test_starvation_respects_population_floor` — 40 turns of deficit never drops population below 1.

Assertions are relational (compare to the city's own starting state / its own
well-fed baseline), so they do not hard-code the implementation's thresholds
or penalty magnitudes.

## Reference solution
`reference_solution.patch` touches only **city.py**:
- adds `self.starvation_turns = 0` to `City.__init__`.
- rewrites `City.grow()`: surplus → grow and reset `starvation_turns`; deficit →
  increment `starvation_turns`, apply happiness penalty `-min(starvation_turns, 5)`,
  decrement population while `> POPULATION_FLOOR (=1)`; break-even resets the counter.
- in `calculate_yields()`, subtracts `3 * starvation_turns` from stability before the clamp.

## Gate scores
- GREEN (unmodified 03b4032): **2 / 5 pass** (regression `test_well_fed_city_still_grows`
  and floor `test_starvation_respects_population_floor` pass trivially since baseline
  never loses population; the 3 starvation tests fail). 2/5 < 1.0. ✔
- REFERENCE (patch applied to fresh 03b4032 checkout): **5 / 5 pass**. ✔

## Assumptions
- TEMPERATE climate chosen specifically because all yield multipliers are 1.0 and
  the climate happiness modifier is 0.0, giving fully deterministic food/happiness math.
- Stability hit is implemented as a direct deduction in `calculate_yields()` keyed on
  `starvation_turns` (the codebase exposes stability cleanly; no separate revolt-risk
  field was needed).
- No `setup_patch`; tests use only the real `City` / `game_data` API and set
  `SDL_VIDEODRIVER=dummy` (no pygame surface is created).
