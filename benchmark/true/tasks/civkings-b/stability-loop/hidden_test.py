"""Hidden scoring test for the stability-loop wiring task (never shown to the agent).

Each test drives the REAL turn loop / real classes and verifies that the empire
StabilitySystem is actually wired into game.process_turn:

  - war lowers stability vs a no-war baseline,
  - conquest (gaining a city) lowers it further than war alone,
  - low empire stability reduces city production yield,
  - revolt risk rises once war has driven stability down.

The four tests are independent so partial implementations score partially.
Tests are headless: game.py imports no GUI/pygame modules.
"""
import random

from game import Game
from game_data import CIVILIZATIONS


PLAYER = "Rome"
RIVAL = "Greece"


def _new_game():
    """Construct a minimal two-civ game deterministically."""
    random.seed(0)
    g = Game(
        player_civ=CIVILIZATIONS[PLAYER],
        ai_civs=[CIVILIZATIONS[RIVAL]],
        map_width=8,
        map_height=8,
    )
    return g


def _player_city(g):
    for c in g.cities.values():
        if c.owner == PLAYER:
            return c
    raise AssertionError("player has no city")


def test_war_lowers_stability():
    """Being at war during a processed turn must reduce empire stability
    below the peace baseline run under identical conditions."""
    # Peace baseline.
    g_peace = _new_game()
    random.seed(0)
    g_peace.process_turn()
    peace_stability = g_peace.stability_system.stability

    # Same game, but at war before the turn is processed.
    g_war = _new_game()
    g_war.diplomacy_manager.declare_war(PLAYER, RIVAL)
    random.seed(0)
    g_war.process_turn()
    war_stability = g_war.stability_system.stability

    assert war_stability < peace_stability, (
        f"war stability {war_stability} should be below peace {peace_stability}"
    )


def test_conquest_lowers_stability_further():
    """Gaining a city (conquest) on top of being at war must reduce stability
    strictly more than war alone."""
    # War only.
    g_war = _new_game()
    g_war.diplomacy_manager.declare_war(PLAYER, RIVAL)
    random.seed(0)
    g_war.process_turn()
    war_stability = g_war.stability_system.stability

    # War plus a freshly conquered (newly player-owned) city.
    g_conq = _new_game()
    g_conq.diplomacy_manager.declare_war(PLAYER, RIVAL)
    # Take an enemy city: create/own a new city under the player before the turn.
    rival_city = None
    for c in g_conq.cities.values():
        if c.owner != PLAYER:
            rival_city = c
            break
    if rival_city is None:
        # No rival city existed; fabricate one owned by the rival, then conquer it.
        from city import City
        rival_city = City(name="Conquered Town", owner=RIVAL, position=(5, 5))
        g_conq.cities[rival_city.name] = rival_city
    # Player conquers it: ownership flips to the player this turn.
    rival_city.owner = PLAYER
    random.seed(0)
    g_conq.process_turn()
    conquest_stability = g_conq.stability_system.stability

    assert conquest_stability < war_stability, (
        f"conquest stability {conquest_stability} should be below war-only "
        f"{war_stability}"
    )


def test_low_stability_reduces_city_production():
    """When empire stability is low, a city's production accumulated during a
    processed turn must be lower than under high stability."""
    def run(stability_value):
        g = _new_game()
        city = _player_city(g)
        city.production_queue = ["Bank"]  # high cost -> will not finish in one turn
        city.production = 0
        g.stability_system.stability = stability_value
        random.seed(0)
        g.process_turn()
        return city.production

    high = run(90)
    low = run(10)

    assert high > 0, "expected the city to accumulate some production"
    assert low < high, (
        f"low-stability production {low} should be below high-stability {high}"
    )


def test_revolt_risk_rises_after_war():
    """Once war has driven stability down through the turn loop, the computed
    revolt risk must exceed the peacetime baseline."""
    g_peace = _new_game()
    random.seed(0)
    g_peace.process_turn()
    peace_risk = g_peace.stability_system.calculate_revolt_risk()

    g_war = _new_game()
    g_war.diplomacy_manager.declare_war(PLAYER, RIVAL)
    # Several war turns to push stability into a riskier band.
    for _ in range(3):
        random.seed(0)
        g_war.process_turn()
    war_risk = g_war.stability_system.calculate_revolt_risk()

    assert war_risk > peace_risk, (
        f"war revolt risk {war_risk} should exceed peace {peace_risk}"
    )
