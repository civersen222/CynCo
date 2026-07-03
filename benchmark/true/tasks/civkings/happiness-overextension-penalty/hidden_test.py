"""Hidden scoring test (never shown to the agent)."""
from happiness_system import HappinessSystem


def test_overextension_penalty_scales_with_excess_cities():
    hs = HappinessSystem()

    # At or below the threshold: no penalty.
    hs.update_city_count(5)
    assert hs.overextension_penalty == 0
    assert hs.current_happiness == 100

    # Three cities beyond the limit -> 3 * 5 = 15 happiness lost.
    hs.update_city_count(8)
    assert hs.overextension_penalty == 15
    assert hs.current_happiness == 85
