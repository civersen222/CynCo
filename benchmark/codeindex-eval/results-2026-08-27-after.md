# CodeIndex eval — after (2026-08-27)

Trajectories: 60 · Grep calls dir-scoped with gold: 33 of 84 (coverage 39% (33/84)) · file-scoped (verification, excluded): 176 · CodeIndex replays skipped: 1
Skipped repos: C:\wt_305daff (no index)

## Top-3 file hit rate

| class | n | Grep | CodeIndex |
|---|---|---|---|
| symbol | 23 | 96% (22/23) | 96% (22/23) |
| conceptual | 9 | 78% (7/9) | 67% (6/9) |

## Burned CodeIndex queries (verbatim replay)

| query | top-1 | gold hit top-1 |
|---|---|---|
| new_app_state seed world construction | gilded/ui/app.py | no |
| _gen_betrothal_offer function body and accept handler wed_ma | (repo missing) | no |
| _open_scheme_picker_eligible attention refusal | gilded/ui/actions.py | no gold |
| _open_scheme_picker_eligible function definition | gilded/ui/actions.py | YES |

## Score dump (floor calibration)

hits:   1.00, 1.00, 1.00, 1.00, 0.23, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 0.38, 0.22, 1.00, 1.00, 1.00, 1.00
misses: 0.16, 1.00, 0.25, 1.00

## Per-query detail

| class | pattern | grep | ci | gold | ci top-3 |
|---|---|---|---|---|---|
| symbol | `power_row_title\|_accent_counts` | HIT | HIT | registry.py | gilded/ui/broadsheet.py, gilded/ui/registry.py, gilded/tests/test_c4_residuals.py |
| symbol | `_non_seat_houses\|_target_for` | HIT | HIT | orders.py | gilded/orders.py, gilded/agenda.py |
| symbol | `_richest_house\|_strongest_house` | HIT | HIT | orders.py | gilded/orders.py, gilded/tests/test_dashboard.py |
| symbol | `can_place_informant` | HIT | HIT | broadsheet.py | gilded/tests/test_ui_powers.py, gilded/ui/broadsheet.py |
| conceptual | `Gilded Machine` | HIT | miss | __main__.py, app.py | gilded/tests/test_policy.py, gilded/tests/test_chassis.py, _probe28.py |
| conceptual | `\.want` | HIT | HIT | chassis.py, ambitions.py | gilded/tests/test_c2_contract.py, gilded/ambitions.py, gilded/orders.py |
| symbol | `class GildedGame\|def __init__\|def __new__\|GildedGame\(seed` | miss | HIT | chassis.py | gilded/chassis.py, gilded/console.py, gilded/tests/test_ai.py |
| symbol | `class Character\|def __init__\|self.dispositions` | HIT | miss | chassis.py | gilded/society/characters.py, legacy/civkings/simulation.py, _probe27.py |
| conceptual | `game\.ladder\(\|game\.beats\(\|\.beats\.\|\.ladder\.\|acts\.` | miss | HIT | beats.py | gilded/ladder.py, gilded/beats.py, gilded/tests/test_c1_visibility.py |
| conceptual | `game\.ladder\(\|game\.beats\(\|s\.game\.beats\|state\.game\.ladder` | HIT | HIT | beats.py | gilded/ladder.py, gilded/beats.py, legacy/civkings/game_manager.py |
| symbol | `def handle_click\|def _end_turn_dispatch\|def _end_turn_eligible` | HIT | HIT | actions.py, broadsheet.py | gilded/ui/actions.py, gilded/ui/broadsheet.py, legacy/civkings/pygame_app/map/minimap.py |
| symbol | `^GUIDE_BG\|^GUIDE_EDGE\|GUIDE_` | HIT | HIT | broadsheet.py | gilded/ui/widgets.py, gilded/ui/broadsheet.py |
| symbol | `ACCEPT_SCORE\s*=\|MUSTER_CAP\s*=\|MUSTER_GATE\s*=` | HIT | HIT | ai.py | gilded/fronts.py, gilded/ai.py, gilded/tests/test_war_tab_doctrines.py |
| symbol | `def _auto_terms\|def terms_cost` | HIT | HIT | fronts.py | gilded/docket.py, gilded/fronts.py, gilded/ai.py |
| conceptual | `truces` | miss | miss | ai.py | legacy/civkings/diplomacy.py, gilded/tests/test_agenda.py |
| symbol | `def wed_match` | HIT | HIT | marriages.py | gilded/society/marriages.py, gilded/docket.py |
| symbol | `class SchemeManager` | HIT | HIT | schemes.py | gilded/society/schemes.py, legacy/civkings/schemes.py, gilded/chassis.py |
| symbol | `_richest_rival\|_best_relations\|_strongest_rival\|_weakest_neighbor` | HIT | HIT | test_agenda.py | gilded/agenda.py, gilded/tests/test_agenda.py |
| conceptual | `dividends\|credit.*dividend` | HIT | miss | chassis.py | gilded/houses.py, gilded/orders.py, gilded/ambitions.py |
| symbol | `def output_gold` | HIT | HIT | enterprises.py | gilded/enterprises.py, gilded/society/shares.py, gilded/tests/test_enterprises.py |
| symbol | `TREASURY_LABELS` | HIT | HIT | houses.py | gilded/houses.py, gilded/tests/test_treasury_journal.py |
| symbol | `def goal_initiative` | HIT | HIT | agenda.py | gilded/agenda.py, gilded/ai.py, gilded/tests/test_agenda.py |
| symbol | `def _marriageable` | HIT | HIT | agenda.py | gilded/agenda.py, gilded/tests/test_agenda.py |
| symbol | `_has_marriage_tie` | HIT | HIT | agenda.py | gilded/intel.py, gilded/agenda.py, gilded/tests/test_intel_ui8.py |
| symbol | `def apply_drift` | HIT | HIT | dispositions.py | gilded/society/dispositions.py, legacy/civkings/dispositions.py, gilded/docket.py |
| symbol | `garrison_stub\|heir_picker_rows\|seed_42.*wars` | HIT | HIT | test_war_verbs_m6b.py | gilded/tests/test_heir_controls.py, gilded/tests/test_war_verbs_m6b.py, .base_broadsheet_test.py |
| symbol | `open_scheme_picker_eligible` | HIT | HIT | actions.py | gilded/ui/actions.py |
| conceptual | `score.*capital\|capital.*score\|buy.*press\|sell.*press\|raise.*press\|8/8` | HIT | HIT | test_capital_m8.py | gilded/tests/test_capital_m8.py, gilded/fronts.py |
| symbol | `test_tab_differs_with_and_without_heir` | HIT | HIT | test_heir_controls.py | gilded/tests/test_heir_controls.py |
| symbol | `test_heir_picker_shows_loyalty_and_opinion` | HIT | HIT | test_heir_controls.py | gilded/tests/test_heir_controls.py |
| conceptual | `docket\.initiative\|initiative` | HIT | HIT | docket.py | gilded/docket.py, .base_broadsheet_test.py, .base_brodsheet.py |
| conceptual | `def initiative` | HIT | HIT | docket.py | gilded/docket.py, .base_broadsheet_test.py, .base_brodsheet.py |

## Reading notes (2026-08-27, committed snapshot)

- Gold = files the mission Read/Edited right after the query, so two rows score a
  correct DEFINITION answer as a miss because the mission's next hop was the callee:
  `new_app_state seed world construction` (burned q1) returns gilded/ui/app.py —
  the actual `def new_app_state` — while the mission next read chassis.py (the
  constructor it calls). Same shape for `class Character` (defined in
  society/characters.py; gold chassis.py). The card body shows the callee import,
  which is the hop Grep cannot provide.
- Grep's own column moves between runs (96% → 91% → 96%) because the civkings
  repo is a live mission target; both tools were always replayed against the
  same tree in the same run.
- Burned queries: q4 YES top-1; q2 repo missing locally; q3 has no gold (the
  mission read nothing after); q1 see above.
