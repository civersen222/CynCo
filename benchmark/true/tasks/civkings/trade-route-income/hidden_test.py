"""Hidden scoring test (never shown to the agent).

Trade routes must generate gold income each time they are processed. Passes
against unmodified CivKings at 03b4032; fails when the per-route gold crediting
in EconomyManager.process_trade_routes is removed (the setup.patch stub).
"""
from economy import EconomyManager


def test_trade_routes_generate_gold():
    economy = EconomyManager()
    assert economy.create_trade_route("Rome", "Athens", gold=10) is True
    assert len(economy.trade_routes) == 1

    total = economy.process_trade_routes()
    assert total == 10
    assert economy.gold == 10

    total = economy.process_trade_routes()
    assert total == 10
    assert economy.gold == 20


def test_multiple_trade_routes_accumulate_gold():
    economy = EconomyManager()
    economy.create_trade_route("Rome", "Athens", gold=10)
    economy.create_trade_route("Rome", "Carthage", gold=15)

    total = economy.process_trade_routes()
    assert total == 25
    assert economy.gold == 25
