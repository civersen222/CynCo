# gold-deficit-consequences — author notes

## Task summary
Long-horizon, multi-file CivKings feature: make a civilization's gold deficit
have real consequences on its army. Today `gold_management.py` computes
maintenance/expenses and `game.py`'s `process_turn` subtracts unit maintenance
from `self.gold[civ]`, but a negative treasury never touches units. The agent
must:
1. ensure the treasury is decremented by expenses each turn (so a civ that
   can't pay actually ends in deficit),
2. debuff surviving combat units once the deficit passes a moderate level,
3. disband some units once the deficit passes a much larger level, removing
   them from **every** registry.

## Real code investigated (ref 03b4032, scratch clone only)
- `gold_management.py` — `GoldManagement` with `UNIT_MAINTENANCE`,
  `calculate_unit_maintenance`, `process_monthly_expenses(income)` returning a
  dict keyed `income / unit_maintenance / tribute / bribery / total_expenses /
  surplus_deficit`. Also `add_unit(name,type)` / `remove_unit(name)` for the
  maintenance ledger.
- `military.py` — `Unit` has `.unit_type`, `.owner`, `.attack`, `.defense`,
  `.is_alive`, `.name`, `.hp`, and `get_base_stats()` (base attack/defense from
  `UNIT_TYPES`). `MilitaryManager` holds a flat `self.units: List[Unit]` with
  `add_unit` / `remove_unit` / `get_units_by_owner`.
- `game.py` — units live in two registries: `self.units: Dict[str, Unit]`
  (name -> Unit) and `self.military_manager.units: List[Unit]`. `self.gold:
  Dict[str, int]`. `process_turn` (~lines 618-643) subtracts player unit
  maintenance into `self.gold[civ]`, adds tax income, then calls
  `gold_management.process_monthly_expenses`. Dead-unit cleanup at the end of
  the turn removes `is_alive == False` units from both registries.
- `game_data.py` — `UnitType` dataclass (`attack`, `defense`, `movement`,
  `production_cost`, `gold_maintenance`, ...). Player ("Rome") starts each game
  with a Settler (0/0) and a Militia (5/6).
- The map (`hex_map.add_unit`) only stores `unit.unit_type` strings on tiles,
  not `Unit` objects, so the authoritative registries are `self.units` and
  `self.military_manager.units`. The hidden test checks both.

## Files / sites the reference touches
Single file: `game.py`.
- New helpers added before `process_turn`: `_combat_units_for`,
  `_disband_unit`, `_apply_gold_deficit_consequences` (plus four class-level
  threshold/fraction constants).
- One call inserted into `process_turn` right after gold expenses are settled
  (`# 3b. Gold deficit consequences`).
`_disband_unit` removes a unit from `self.units`, calls
`military_manager.remove_unit`, and `gold_management.remove_unit` to keep the
maintenance ledger in sync (and sets `is_alive = False`).

## Reference thresholds chosen
- `GOLD_DEFICIT_DEBUFF_THRESHOLD = 50` (deficit beyond this debuffs units)
- `GOLD_DEFICIT_DISBAND_THRESHOLD = 100` (deficit beyond this disbands units)
- `GOLD_DEFICIT_DEBUFF_FRACTION = 0.25` (combat strength lost while in debt)
- `GOLD_DEFICIT_DISBAND_FRACTION = 0.5` (share of army disbanded when severe)
Disband targets the weakest units first; debuff cuts attack/defense by 25% of
each unit's base (min 1 when the base stat is non-zero).

## Hidden test (4 independent tests, relational — no hard-coded thresholds)
- `test_moderate_deficit_debuffs_combat_strength` — seeds 6 Swordsmen, sets
  gold to -300, runs a real `process_turn`, asserts >=1 surviving unit has
  attack or defense below its own base.
- `test_severe_deficit_disbands_units` — seeds 8 units, gold -1000, asserts
  living player unit count drops.
- `test_disbanded_unit_removed_from_all_registries` — gold -1000, asserts each
  disbanded unit is gone from `game.units` AND from `military_manager.units`,
  and that every live manager unit is still in `game.units` (no dangling /
  double-count).
- `test_healthy_treasury_leaves_army_intact` — gold +5000, asserts count and
  per-unit base strength unchanged (regression guard).

The deficit magnitudes used (-300, -1000) sit well above the reference
thresholds, but the assertions only check the *relationship* (below base /
count dropped / registries agree / unchanged when healthy), so an agent that
picks its own reasonable thresholds and a monotonic policy still passes.

## Gate results (clean `git clone --no-hardlinks` at 03b4032)
- GREEN (no solution): **1/4** — only `test_healthy_treasury_leaves_army_intact`
  passes; the three consequence tests fail (no debuff, no disband). Score < 1.0
  as required.
- REFERENCE (`git apply reference_solution.patch`): **4/4** — all pass.

Headless: tests set `SDL_VIDEODRIVER=dummy`; the real `Game(...).process_turn()`
loop runs without pygame display. Verified with
`SDL_VIDEODRIVER=dummy python -m pytest hidden_test.py -q`.

## Assumptions
- Consequences apply to the player civ (`game.player_civ.name`), the civ whose
  maintenance `process_turn` already settles. The prompt scopes consequences to
  "the player's civilization".
- "Combat units" = living units with non-zero base attack or defense (excludes
  the starting Settler, which is 0/0).
