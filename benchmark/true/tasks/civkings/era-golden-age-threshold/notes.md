# era-golden-age-threshold

## Target
- File: `era_system.py`
- Symbol: `EraSystem.check_era_transition()`
- Supporting logic exercised: `EraSystem.record_moment()` (score accumulation),
  `EraSystem.THRESHOLDS` (golden_age=24, dark_age=12),
  `EraSystem.get_era_bonuses()` (Golden yields=1.1).

## Behavior tested
Era progression is threshold-banded by `era_score`:
- score >= 24 (golden_age) -> 'Golden'
- 12 <= score < 24 -> 'Normal'
- score < 12 -> 'Dark'

`test_golden_age_requires_crossing_threshold` records all five historic moments
(3+5+3+5+3 = 19) and asserts the civ is still 'Normal' (19 is above the dark_age
band floor but below golden_age) — guards against a too-eager fix that returns
'Golden' on any positive score.

`test_golden_age_reached_at_threshold` sets era_score to exactly 24 and asserts
`check_era_transition() == 'Golden'` and that the Golden bonus `yields == 1.1`.

No randomness in the asserted path; deterministic, headless-clean.

## What the patch removes
`setup.patch` deletes the first branch of `check_era_transition`:
the `if self.era_score >= self.THRESHOLDS['golden_age']: return 'Golden'`.
With it gone, the highest band collapses into 'Normal' and a civ can never
reach a Golden Age — the broken symptom in the prompt.

## Gate result (temp clone, commit 03b4032, SDL_VIDEODRIVER=dummy)
- Clean:   `2 passed in 0.02s`
- Patched: `1 failed, 1 passed in 0.04s`
  (FAILED hidden_test.py::test_golden_age_reached_at_threshold — Golden vs Normal)
