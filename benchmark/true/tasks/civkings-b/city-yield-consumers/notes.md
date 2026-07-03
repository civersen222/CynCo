# city-yield-consumers — authoring notes

## Behavior under test
`City.calculate_yields()` (city.py) returns `food, gold, science, production,
culture, faith, stability`. The turn loop `Game.process_turn()` (game.py,
"7. City Production" section, ~line 689) iterates owned cities and is the place
where produced yields are supposed to be consumed into the owning civ's totals.

The task asks the agent to ensure every produced yield has its downstream
effect: science -> research, faith -> civ faith, happiness -> production
modifier. (Culture is deliberately excluded — it is already wired.)

## Investigation (green ref 03b4032)
Traced each yield key from `calculate_yields()` to its consumer in `process_turn`:

| yield      | consumer at green                                                        | status            |
|------------|--------------------------------------------------------------------------|-------------------|
| culture    | `civ_obj.culture += yields['culture']` (game.py ~696)                     | WIRED (excluded)  |
| food/gold/production | passed to `city.process_production(...)` (game.py ~709)         | consumed          |
| **science**| passed to `process_production`, which does `self.science += turn_science` on the **city** (city.py ~456). `Game.research[civ]` (a `TechManager` with `add_research_progress` / `current_research_progress`) is **never advanced** by city science. | **MISSING** |
| **faith**  | `yields['faith']` is computed (district `faith_bonus`, building `faith`) but **never** added to `Game.faith_points[civ]`. The only faith code in `process_production` (city.py ~483) is buildings-count-based and its `hasattr(b,'name')` guard is always False (keys are strings), so it is effectively dead and ignores `yields['faith']`. | **MISSING** |
| stability  | informational only                                                       | n/a               |

Happiness production modifier: `HappinessSystem.get_production_loss()`
(happiness_system.py ~148) exists and returns <1.0 when unhappy, but it is
**never applied** to city production in the turn loop. The empire
`HappinessSystem` is instantiated and `current_happiness` printed (game.py ~243,
~635) yet its production-loss multiplier is dropped. (The city-level
`self.happiness` int penalty inside `calculate_yields` is a *different*,
city-scoped mechanic and does not cover the empire happiness signal.)

Empirically confirmed by probe: after one `process_turn()`, `culture` 0->1.0
(wired), but research progress stayed 0, `faith_points` stayed 0, and effective
production was identical at 100% vs 10% empire happiness.

## Missing consumer links chosen as the signal (all 3)
1. **science -> research** — city science yield must advance
   `Game.research[civ].current_research_progress` (or complete the tech).
2. **faith -> civ faith** — city faith yield must accumulate into
   `Game.faith_points[civ]`.
3. **happiness -> production** — low empire happiness
   (`HappinessSystem.get_production_loss() < 1.0`) must reduce the effective
   production a city contributes, vs an identical high-happiness empire.

Culture is intentionally NOT tested (already satisfied on green).

## Tests (hidden_test.py) — 3 independent `test_*`
- `test_science_yield_advances_research`
- `test_faith_yield_accumulates_into_civ_faith`
- `test_low_happiness_reduces_effective_production`

Each is independently satisfiable for partial credit. Deterministic
(`random.seed(...)` before every `process_turn`), headless
(`SDL_VIDEODRIVER=dummy`, no pygame surface). Built on the real
`Game(CIVILIZATIONS["Rome"], [CIVILIZATIONS["Greece"]])` construction already
used by the repo's own `test_civkings.py`. Inequalities are robust
(`>=`/`<` with 1e-6 slack); the happiness test holds city-level happiness fixed
in both runs so only the empire `get_production_loss()` factor differs.

## Reference solution (reference_solution.patch)
Single file touched: **game.py**, in the "7. City Production" loop, right after
the existing culture accrual. Adds:
- science -> `tech_mgr.add_research_progress(owner, int(science_yield))`
  (starting research on the first available tech if none is active);
- faith -> `self.faith_points[owner] += faith_yield`;
- production -> multiply `yields['production']` by
  `self.happiness_system.get_production_loss()` for the player civ before it is
  passed into `process_production`.
`city.py` was not modified. Culture accrual is left untouched (no double count).

## Gate scores
- **GREEN** (03b4032, no patch): **0/3** pass (all three missing-consumer tests
  fail). < all-pass as required.
- **REFERENCE** (`git apply reference_solution.patch`): **3/3** pass.

Verified in a fresh clone of `03b4032` (clone, checkout, run green = 0/3,
`git apply --check` clean, apply, run = 3/3).

## Assumptions
- Empire happiness modulates production for the **player** civ (the turn loop's
  section 7 production accounting is player-scoped; AI civs run via
  `_process_ai_turn`). The happiness test only inspects the player city.
- `int(science_yield)` truncation matches `add_research_progress`'s int
  semantics; the science test allows either progress increase or tech completion.
