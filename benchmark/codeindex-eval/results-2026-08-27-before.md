# CodeIndex eval — before (2026-08-27)

Trajectories: 60 · Grep calls dir-scoped with gold: 34 of 85 (coverage 40% (34/85)) · file-scoped (verification, excluded): 174 · CodeIndex replays skipped: 1
Skipped repos: C:\wt_305daff (no index)

## Top-3 file hit rate

| class | n | Grep | CodeIndex |
|---|---|---|---|
| symbol | 24 | 92% (22/24) | 63% (15/24) |
| conceptual | 9 | 89% (8/9) | 33% (3/9) |

## Burned CodeIndex queries (verbatim replay)

| query | top-1 | gold hit top-1 |
|---|---|---|
| new_app_state seed world construction | gilded/tests/test_war_verbs_m6b.py | no |
| _gen_betrothal_offer function body and accept handler wed_ma | (repo missing) | no |
| _open_scheme_picker_eligible attention refusal | gilded/ui/actions.py | no gold |
| _open_scheme_picker_eligible function definition | gilded/ui/actions.py | YES |

## Score dump (floor calibration)

hits:   0.28, 0.26, 0.39, 0.33, 0.19, 0.28, 0.35, 0.34, 0.37, 0.35, 0.35, 0.42, 0.21, 0.46, 0.36, 0.29, 0.19, 0.35
misses: 0.26, 0.14, 0.22, 0.39, 0.31, 0.27, 0.25, 0.27, 0.22, 0.20, 0.34, 0.23, 0.27, 0.33, 0.21

## Per-query detail

| class | pattern | grep | ci | ci top-1 |
|---|---|---|---|---|
| symbol | `power_row_title\|_accent_counts` | HIT | HIT | gilded/ui/registry.py |
| symbol | `_non_seat_houses\|_target_for` | HIT | HIT | gilded/orders.py |
| symbol | `_richest_house\|_strongest_house` | HIT | HIT | gilded/orders.py |
| symbol | `can_place_informant` | HIT | miss | gilded/tests/test_ui_powers.py |
| conceptual | `Gilded Machine` | HIT | miss | gilded/tests/test_policy.py |
| conceptual | `\.want` | HIT | miss | gilded\tests\test_c2_contract.py |
| symbol | `class GildedGame\|def __init__\|def __new__\|GildedGame\(seed` | HIT | miss | gilded\tests\test_ai.py |
| symbol | `class Character\|def __init__\|self.dispositions` | miss | miss | gilded/society/characters.py |
| conceptual | `game\.ladder\(\|game\.beats\(\|\.beats\.\|\.ladder\.\|acts\.` | miss | miss | _probe27.py |
| conceptual | `game\.ladder\(\|game\.beats\(\|s\.game\.beats\|state\.game\.ladder` | HIT | miss | gilded/tests/test_c1_visibility.py |
| symbol | `def handle_click\|def _end_turn_dispatch\|def _end_turn_eligible` | HIT | HIT | gilded/ui/actions.py |
| symbol | `^GUIDE_BG\|^GUIDE_EDGE\|GUIDE_` | HIT | HIT | gilded\ui\broadsheet.py |
| symbol | `ACCEPT_SCORE\s*=\|MUSTER_CAP\s*=\|MUSTER_GATE\s*=` | HIT | miss | gilded/tests/test_war_verbs_m6b.py |
| symbol | `def _auto_terms\|def terms_cost` | HIT | HIT | gilded/fronts.py |
| conceptual | `truces` | HIT | miss | gilded/fronts.py |
| symbol | `def wed_match` | HIT | miss | gilded/tests/test_agenda.py |
| symbol | `class SchemeManager` | HIT | HIT | gilded/society/schemes.py |
| symbol | `_richest_rival\|_best_relations\|_strongest_rival\|_weakest_neighbor` | HIT | miss | gilded/agenda.py |
| conceptual | `dividends\|credit.*dividend` | HIT | miss | gilded\society\shares.py |
| symbol | `def output_gold` | HIT | HIT | gilded/enterprises.py |
| symbol | `TREASURY_LABELS` | HIT | miss | gilded/tests/test_treasury_journal.py |
| symbol | `def goal_initiative` | HIT | HIT | gilded/agenda.py |
| symbol | `def _marriageable` | HIT | HIT | gilded/agenda.py |
| symbol | `_has_marriage_tie` | HIT | miss | gilded/intel.py |
| symbol | `def apply_drift` | HIT | HIT | legacy/civkings/dispositions.py |
| symbol | `garrison_stub\|heir_picker_rows\|seed_42.*wars` | HIT | miss | gilded/docket.py |
| symbol | `open_scheme_picker_eligible` | HIT | HIT | gilded/ui/actions.py |
| conceptual | `score.*capital\|capital.*score\|buy.*press\|sell.*press\|raise.*press\|8/8` | HIT | HIT | gilded/tests/test_capital_m8.py |
| symbol | `test_tab_differs_with_and_without_heir` | HIT | HIT | gilded/tests/test_heir_controls.py |
| symbol | `test_heir_picker_shows_loyalty_and_opinion` | HIT | HIT | gilded/tests/test_heir_controls.py |
| conceptual | `docket\.initiative\|initiative` | HIT | HIT | gilded\docket.py |
| conceptual | `def initiative` | HIT | HIT | gilded/docket.py |
| symbol | `test_.*press\|test_.*ui.*action\|test_.*dispatch` | miss | HIT | gilded/tests/test_war_verbs_m6b.py |
