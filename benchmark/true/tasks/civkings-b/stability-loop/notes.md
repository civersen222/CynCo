# stability-loop — author notes

Flavor-2 task (no `setup_patch`): the feature is absent on the green ref `03b4032`.
The agent must wire the already-implemented `StabilitySystem` into the turn loop so
wars/conquests/low-stability actually affect the game.

## Real API used (read from source at 03b4032, not guessed)

`stability_system.py` — `class StabilitySystem`:
- `__init__(government_type="Monarchy")` → default `stability = 80` (Monarchy base).
- `stability: float` (0-100 clamped), `unrest`, `revolt_risk` attributes.
- `apply_event_modifier(event_type, amount=None)` — uses `EVENT_MODIFIERS`
  (`"war_declared": -15`, `"conquest": -8`, ...); returns the applied delta.
- `apply_change(amount)` — raw stability change.
- `update_war_status(at_war: bool, conquered_cities: int = 0)` — bookkeeping counters.
- `calculate_unrest()`, `calculate_revolt_risk()` (returns 0..1, rises as stability
  drops past 60/40/20 thresholds plus an `unrest` term).

`game.py`:
- `Game.__init__(player_civ, ai_civs=None, map_width=16, map_height=16)`.
- `self.stability_system = StabilitySystem()` (line ~244) — created, never driven.
- `process_turn()` block "2. Happiness & Stability" only *reads* stability.
- `process_turn()` block "7. City Production" calls `city.calculate_yields()` then
  `city.process_production(food, gold, science, production)`; empire stability is not
  applied to the production yield on green.
- `self.player_civ.name` is the player civ; cities keyed by name in `self.cities`,
  each `city.owner` is a civ name string.

`diplomacy.py` — `DiplomacyManager`:
- `declare_war(aggressor, defender)`, `is_at_war(a, b)`,
  `get_active_wars(civ) -> List[str]` (empty list ⇒ at peace).

`city.py`:
- `City(name, owner, position, ...)`; `calculate_yields()` returns a dict with a
  `"production"` key; `process_production(...)` accumulates into `city.production`
  and only runs when `city.production_queue` is non-empty and the queued item has a
  known cost (`get_production_cost`). `"Bank"` (cost 100) is used in the test because
  it will not complete in a single turn, so `city.production` reflects the per-turn
  production accrued (lets the test observe the stability multiplier).

## What the reference patch touches

Single file: **game.py**, three sites:
1. `__init__`: add `self._stability_war_active` / `self._stability_owned_cities`
   tracking fields, and (after `_setup_ai_players`) seed the owned-city baseline so
   founding cities are not mistaken for conquests on turn 1.
2. `process_turn` block 2 ("Happiness & Stability"): if at war, apply
   `apply_event_modifier("war_declared")` once at war onset and `apply_change(-3)`
   each ongoing war turn; call `update_war_status(at_war)`; detect a net increase in
   player-owned cities and apply `apply_event_modifier("conquest")` per gained city.
3. `process_turn` block 7 ("City Production"): multiply the player city's
   `yields["production"]` by `0.5 + 0.5*(stability/100)` so a destabilized empire
   produces less (mult in [0.5, 1.0]).

Patch format: `git diff` from the CivKings repo root, apply with
`git apply reference_solution.patch`. Verified to apply cleanly on a fresh `03b4032`
checkout.

## Hidden tests (4, independent)

- `test_war_lowers_stability` — war turn vs identical peace turn (same seed):
  stability lower under war.
- `test_conquest_lowers_stability_further` — war+conquest (player gains a city) vs
  war-only: stability strictly lower.
- `test_low_stability_reduces_city_production` — same city/turn at stability 10 vs 90:
  accumulated `city.production` strictly lower at low stability.
- `test_revolt_risk_rises_after_war` — three war turns vs peace baseline:
  `calculate_revolt_risk()` strictly higher.

All run headless (game.py imports no pygame/GUI). Determinism via `random.seed(0)`
re-seeded immediately before each `process_turn()` so succession/event RNG cancels
between the compared runs; assertions are inequalities, not exact floats.

## Gate scores (measured)

- GREEN (feature absent, `03b4032`): **0/4** — all four tests fail.
- REFERENCE (patch applied): **4/4** — all pass.

End-to-end re-verified from a clean green checkout: green 0/4, `git apply` OK,
reference 4/4.

## Assumptions

- Player civ "Rome" vs rival "Greece" from `CIVILIZATIONS`; an 8x8 map is enough to
  construct a valid game quickly. The player starts owning a city, the rival has its
  own; if no rival city exists the conquest test fabricates one and flips its owner.
- "Conquest" is detected as a net increase in player-owned city count between turns —
  this is the robust signal because game.py has no single clean conquest hook in the
  turn loop. A correct solution could instead hook the actual city-capture path; the
  test only asserts the *behavior* (gaining a city lowers stability more than war
  alone), so alternative wirings that produce the same behavior also pass.
- Production penalty is applied to the player's cities; the test only inspects a
  player-owned city, so a solution that penalizes all cities also passes.
