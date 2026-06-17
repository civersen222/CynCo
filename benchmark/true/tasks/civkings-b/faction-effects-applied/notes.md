# faction-effects-applied — authoring notes

## What the task asks for
Wire `FactionManager.get_faction_effects()` into `game.py`'s turn loop so faction
bonuses/penalties actually modify per-civ state (gold, stability, culture) each
turn, and so the returned turn log mentions the applied faction effect.

## Real-code facts (ref 03b4032)
- `faction_system.py`
  - `Faction.is_dominant` = `influence >= 70`; `is_marginalized` = `influence <= 20`.
  - `FactionManager.get_faction_effects()` returns a dict with keys
    `stability, happiness, gold, culture, science, military`. Dominant factions
    add `bonus * 0.1`; marginalized add `penalty * 0.05`. (e.g. Popular Assembly
    dominant → gold `+10 * 0.1 = +1.0`.)
  - `FactionManager(civ_name)` + `.initialize_factions()` creates nobles /
    religious / popular factions. `_update_dominant_faction()` recomputes the
    dominant one.
- `game.py`
  - Green has a single `self.faction_manager = FactionManager(player_name)` for
    the player only; AI civs have NO faction state.
  - `_initialize_game` calls `self.faction_manager.initialize_factions()` (~L459).
  - Turn loop section "6. Faction Effects" (~L683) computes the effects but only
    prints a stability string; it never applies anything.
  - **Key gotcha:** `process_turn()` RETURNS `self.state.turn_events`, NOT the
    local `msgs` list. Anything appended only to `msgs` is discarded. The turn-log
    assertion therefore requires appending to `self.state.turn_events`.
  - Gold is per-civ: `self.gold[civ_name]` (int dict). Culture is per-civ on the
    `Civilization` object: `self.civilizations[civ].culture`. Stability is a
    single shared `self.stability_system` (`StabilitySystem.apply_change(amount)`),
    modeling the player's empire — so only the player's factions move it.
  - AI civs (Rome, Greece) own no cities in a fresh game, so their gold is
    untouched by tax/production loops (verified: stays exactly 100). This makes AI
    civ gold a noise-free signal for the dominant / per-civ tests.

## Files the reference patch touches
- `game.py` only (47 insertions, 6 deletions):
  1. `__init__`: add `self.faction_managers: Dict[str, FactionManager] = {}`.
  2. `_initialize_game`: populate `faction_managers` for every civ (player entry
     reuses `self.faction_manager`; AI civs get their own initialized managers).
  3. Turn loop section 6: iterate `faction_managers`, apply `gold` to
     `self.gold[civ]`, `culture` to `self.civilizations[civ].culture`, and (player
     only) `stability` via `self.stability_system.apply_change(...)`; append a
     `Faction Effect (...)` line to `self.state.turn_events`.

## Hidden tests (4, independent)
- `test_dominant_faction_increases_gold` — Rome's Popular Assembly dominant →
  Rome gold strictly increases over a turn.
- `test_marginalized_faction_applies_penalty` — all player factions marginalized →
  player stability strictly decreases (stability is noise-free, no tax effect).
- `test_effects_are_per_civ` — Rome dominant (gold up) while Greece left neutral →
  Rome gold up, Greece gold unchanged.
- `test_turn_log_mentions_faction_effect` — returned turn log contains
  "faction"+"effect" when an effect is applied.

Tests are headless (`SDL_VIDEODRIVER=dummy`, no pygame surface), use strict
inequalities, and degrade to assertion failures (not infra errors) on green via a
`_manager_for` helper that falls back to `faction_manager` for the player.

## Gate scores (scratch clone of civkings @ 03b4032)
- GREEN (clean checkout, no patch): **0 / 4 pass** (all fail — feature absent;
  3 fail on missing per-civ managers, 1 on unchanged stability `80 < 80`).
- REFERENCE (`git apply reference_solution.patch`): **4 / 4 pass.**
- Patch verified `git apply --check` clean on a fresh checkout.

## Assumptions
- A correct solution introduces per-civ faction managers (the task explicitly
  states AI civs need their own faction state). The helper tolerates any dict
  named `faction_managers` keyed by civ name; the player path also accepts the
  legacy single `faction_manager`.
- Magnitudes from `get_faction_effects` are small (gold `+1.0`, stability
  `-0.25`); tests assert direction (`>`, `<`, `==`), not exact values, so any
  reasonable application scheme (rounded or float) passes.
