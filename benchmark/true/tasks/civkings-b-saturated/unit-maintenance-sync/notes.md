# unit-maintenance-sync — author notes

## Behavior under test
CivKings has two independent sources of truth for per-turn unit maintenance:

- **Canonical:** `game_data.py` — `UNIT_TYPES[t].gold_maintenance` (int per unit type).
- **Secondary:** `gold_management.py` — a hand-written `UNIT_MAINTENANCE` dict +
  `add_unit` / `calculate_unit_maintenance` that sums it, with a `.get(type, 1.0)`
  fallback for missing types.

The turn loop in `game.py` (`process_turn`, ~lines 618–627) charges the treasury
using the **canonical** `UNIT_TYPES` figures, while `GoldManagement` uses the
**secondary** table. They disagree for many unit types, and several canonical
unit types are absent from the secondary table (so they get the arbitrary `1.0`
default instead of their real cost).

Task: make maintenance authoritative and consistent — the charge must equal the
sum of canonical per-unit maintenance for any army, missing types must use their
canonical cost (no silently-free or silently-defaulted units), and the two
sources must agree.

## Divergence (the signal)
Probed at green ref `03b4032` (one unit of each type, secondary `.get(type, 1.0)`):

| unit type    | canonical (UNIT_TYPES) | secondary (UNIT_MAINTENANCE) | note |
|--------------|------------------------|------------------------------|------|
| Knight       | 2                      | 3.0                          | present in both, **disagrees** |
| Crossbowman  | 1                      | 1.5                          | present in both, **disagrees** |
| **Galley**   | **0**                  | **1.0 (fallback)**           | **missing from secondary → silently charged** |
| Trader       | 0                      | 1.0 (fallback)               | missing → silently charged |
| Militia      | 0                      | 0.5                          | disagrees |
| Siege Tower  | 2                      | 1.0 (fallback)               | missing → under-charged |
| Monk, Phalanx| 0                      | 1.0 (fallback)               | missing → silently charged |

Headline missing-type case used in the prompt/tests: **Galley** (canonical 0,
but the secondary table silently charges 1.0). Headline present-but-disagrees:
**Knight** (2 vs 3.0).

The secondary table also uses names that don't exist in the canonical set at all
(Infantry, Cavalry, Ranger, Galleys, Trebuchet, Scout, Merchant, Military_Unit,
Ship_of_the_Line), confirming the two were authored independently.

## Files / sites the reference touches
- `gold_management.py` only:
  - add `from game_data import UNIT_TYPES`.
  - add `GoldManagement.maintenance_for_type(unit_type)` classmethod: prefer
    canonical `UNIT_TYPES[t].gold_maintenance`; fall back to the local table,
    then `0.0` (never an arbitrary `1.0`).
  - `add_unit` now stores `maintenance_for_type(unit_type)`.

`game.py`'s turn loop is already canonical, so no change is needed there — the
divergence lived entirely in `gold_management.py`. The reference reconciles the
two by making the secondary path derive from the canonical definitions (single
effective source of truth). No circular import: `game_data` does not import
`gold_management`.

A weak agent that only edits the obvious dict (e.g. tweaks a couple of numbers)
or only fixes the missing-types fallback will still leave per-type mismatches and
fail the per-type / agreement tests.

## Hidden tests (4 independent `test_*`)
1. `test_gold_management_matches_canonical_sum_for_common_army` — GoldManagement's
   total for a mixed army equals the canonical per-unit sum.
2. `test_every_unit_type_agrees_with_canonical` — for **every** type in
   `UNIT_TYPES`, one unit's GoldManagement maintenance == canonical (covers
   missing types like Galley charged 0, and disagreements like Knight).
3. `test_turn_loop_charge_matches_gold_management` — turn-loop canonical sum over
   the player's living units == GoldManagement for the same army == canonical
   sum (the two code paths must coincide). Avoids net-gold measurement (tax
   income inflows pollute it); compares maintenance computations directly.
4. `test_maintenance_non_negative_and_monotonic` — regression guard: maintenance
   ≥ 0 and never shrinks as the army grows. Passes on green too.

All deterministic, headless (`SDL_VIDEODRIVER=dummy`), use real classes
(`game_data.UNIT_TYPES`, `gold_management.GoldManagement`, `game.Game`,
`military.Unit`). Relational assertions — no hard-coded gold totals.

## Gate scores (scratch clone at 03b4032)
- **GREEN** (unmodified): `1 passed, 3 failed` → **1/4**. The 3 divergence tests
  fail; only the non-negative/monotonic guard passes.
- **REFERENCE** (`git apply reference_solution.patch`): `4 passed` → **4/4**.

## Assumptions
- `Game(CIVILIZATIONS["Rome"], [CIVILIZATIONS["Greece"]])` is a valid headless
  construction (matches sibling task `gold-deficit-consequences`).
- Player units are seeded into both `game.units` and
  `game.military_manager.units` (same pattern as the sibling task).
- Canonical truth = `UNIT_TYPES[t].gold_maintenance`; an unknown type (not in
  UNIT_TYPES) should cost 0, not an arbitrary default.

Status: **DONE**.

## Calibration (2026-06-18)
DROPPED from the headline set: unaided ungoverned mean = 100% over 2 reps (qwen3.6-27b-q6k).
Saturated above the 0.2-0.8 discriminating band — no headroom for governance to register a lift, so it carries no governance signal. Kept here as authored evidence; not part of the headline run.
