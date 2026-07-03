"""Hidden scoring test (never shown to the agent)."""
from market_simulation import MarketSimulation


def test_price_clamped_to_ceiling_under_extreme_demand():
    """With extreme demand vs. minimal supply the raw price would be ~100000,
    but it must be capped at the market ceiling of 100.0 regardless of the
    random fluctuation factor (0.9..1.1 keeps it far above 100.0)."""
    market = MarketSimulation()
    # supply=1, demand=100000 -> base price 100000; fluctuation keeps it >= 90000
    market.supply["Gold"] = 1.0
    market.demand["Gold"] = 100000.0
    # Run many times: the ceiling must hold deterministically every time.
    for _ in range(200):
        price = market.calculate_price("Gold")
        assert price <= 100.0
    # And it should actually be sitting at the ceiling, not some lower value.
    assert market.calculate_price("Gold") == 100.0


def test_price_clamped_to_floor_under_supply_glut():
    """With a massive supply glut the raw price collapses toward zero, but it
    must never drop below the market floor of 0.1, independent of fluctuation."""
    market = MarketSimulation()
    market.supply["Gold"] = 100000.0
    market.demand["Gold"] = 1.0
    for _ in range(200):
        price = market.calculate_price("Gold")
        assert price >= 0.1
    assert market.calculate_price("Gold") == 0.1
