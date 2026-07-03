"""Hidden scoring test (never shown to the agent)."""
from era_system import EraSystem


def test_golden_age_requires_crossing_threshold():
    era = EraSystem()
    # Accumulate score: 3 + 5 + 3 + 5 + 3 = 19 (below golden_age=24)
    for moment in ('first_tech', 'first_wonder', 'won_battle',
                   'founded_religion', 'met_all_civs'):
        era.record_moment(moment)
    assert era.era_score == 19
    # 19 is >= dark_age (12) but < golden_age (24): must be 'Normal'.
    assert era.check_era_transition() == 'Normal'


def test_golden_age_reached_at_threshold():
    era = EraSystem()
    era.era_score = 24  # exactly at golden_age threshold
    assert era.check_era_transition() == 'Golden'
    bonuses = era.get_era_bonuses('Golden')
    assert bonuses['yields'] == 1.1
