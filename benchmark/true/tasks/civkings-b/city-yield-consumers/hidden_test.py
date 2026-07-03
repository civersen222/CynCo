"""Hidden scoring test (never shown to the agent).

Verifies that EVERY yield a city produces is actually *consumed* by the turn
loop -- i.e. that producing a yield has its intended downstream effect.

``City.calculate_yields()`` returns food, gold, science, production, culture,
faith and stability. At the pinned green ref several of those produced yields
are computed but never accumulated into the civ's running totals during
``Game.process_turn()``:

  * science is dropped onto a dead per-city counter (``city.science``) and never
    advances the civ's research (``Game.research[civ].current_research_progress``);
  * the city's ``faith`` yield is never accumulated into
    ``Game.faith_points[civ]``;
  * the empire ``HappinessSystem.get_production_loss()`` multiplier is never
    applied, so low happiness does not actually reduce effective production.

(The ``culture`` yield IS already accrued to the civ at green, so it is not
tested here.) A correct fix wires each produced yield to its consumer inside the
turn loop. Each test below targets one independent missing link, so a partial
implementation still earns partial credit.

Deterministic + headless: SDL is forced to the dummy driver and no pygame
surface is ever created. ``random`` is seeded before any ``process_turn`` call.
"""
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

# The task is run from inside the CivKings checkout, so the modules are importable
# directly; but be defensive about the working directory.
sys.path.insert(0, os.getcwd())

import random

from game import Game
from game_data import CIVILIZATIONS, BUILDINGS


def _fresh_game():
    """A deterministic two-civ game (player Rome, one AI), headless."""
    random.seed(12345)
    return Game(CIVILIZATIONS["Rome"], [CIVILIZATIONS["Greece"]])


def _player_city(game):
    pname = game.player_civ.name
    cities = [c for c in game.cities.values() if c.owner == pname]
    assert cities, "expected the player civ to own at least one city"
    return pname, cities[0]


def _queue_expensive(city):
    """Queue a building too expensive to finish in a single turn so production
    keeps accumulating and process_production runs every turn."""
    name, _cost = max(
        ((n, city.get_production_cost(n) or 0) for n in BUILDINGS),
        key=lambda kv: kv[1],
    )
    city.production_queue = [name]
    city.current_production = None
    return name


def test_science_yield_advances_research():
    """A city's science yield must advance the civ's current research, not vanish
    into a dead per-city counter."""
    game = _fresh_game()
    pname, city = _player_city(game)

    tm = game.research[pname]
    # Ensure something is actively being researched and won't auto-complete in one
    # turn (pick a tech whose cost comfortably exceeds one turn of science).
    sci_yield = city.calculate_yields().get("science", 0)
    assert sci_yield > 0, "test setup expects the city to produce science"

    if not tm.current_research:
        avail = tm.get_available_technologies(pname)
        assert avail, "no technologies available to research"
        # Prefer an expensive tech so a single turn cannot complete it.
        from tech import TECHNOLOGIES
        avail.sort(key=lambda t: TECHNOLOGIES[t].cost, reverse=True)
        tm.research(avail[0], pname)

    from tech import TECHNOLOGIES
    cost = TECHNOLOGIES[tm.current_research].cost
    started = tm.current_research
    before_progress = tm.current_research_progress
    before_done = set(tm.researched.keys())

    random.seed(12345)
    game.process_turn()

    after_progress = tm.current_research_progress
    after_done = set(tm.researched.keys())

    # Either progress on the same tech increased, or (if the tech was cheap enough)
    # the tech completed -- both mean the science yield was consumed by research.
    completed_started = started in after_done and started not in before_done
    progressed = (tm.current_research == started) and (after_progress > before_progress)
    assert progressed or completed_started, (
        "city science yield did not advance research: "
        f"tech={started} cost={cost} progress {before_progress} -> {after_progress}; "
        f"newly researched={after_done - before_done}"
    )


def test_faith_yield_accumulates_into_civ_faith():
    """A city's faith yield must accumulate into the civ's faith points."""
    game = _fresh_game()
    pname, city = _player_city(game)

    # Give the city a faith-producing building so it yields positive faith.
    faith_buildings = [b for b in BUILDINGS.values() if getattr(b, "faith", 0) > 0]
    assert faith_buildings, "expected at least one faith-producing building"
    city.add_building(faith_buildings[0])

    faith_yield = city.calculate_yields().get("faith", 0)
    assert faith_yield > 0, "test setup expects the city to produce faith"

    before = game.faith_points.get(pname, 0)
    random.seed(12345)
    game.process_turn()
    after = game.faith_points.get(pname, 0)

    assert after >= before + faith_yield - 1e-6, (
        "city faith yield was not accumulated into the civ's faith points: "
        f"faith_points {before} -> {after} (city produced {faith_yield} faith)"
    )


def test_low_happiness_reduces_effective_production():
    """When empire happiness is low, the happiness production-loss multiplier must
    reduce the effective production the city accumulates, compared with an
    otherwise identical high-happiness empire."""

    def run(base_happiness):
        game = _fresh_game()
        pname, city = _player_city(game)
        # Keep the *city-level* happiness identical in both runs (0 -> no
        # city-level production penalty branch fires), so only the empire-level
        # HappinessSystem.get_production_loss() can differ between the two runs.
        city.happiness = 0
        _queue_expensive(city)
        game.happiness_system.base_happiness = base_happiness
        # Sanity: the two regimes must actually differ in production-loss factor.
        loss = game.happiness_system.get_production_loss()
        random.seed(999)
        game.process_turn()
        return city.production, loss

    high_prod, high_loss = run(100)   # get_production_loss() == 1.0
    low_prod, low_loss = run(10)      # get_production_loss() < 1.0

    assert high_loss > low_loss, (
        "test setup invalid: production-loss factors did not differ "
        f"(high={high_loss}, low={low_loss})"
    )
    assert low_prod < high_prod - 1e-6, (
        "low empire happiness did not reduce effective production: "
        f"production accumulated high-happiness={high_prod}, "
        f"low-happiness={low_prod} (should be strictly less)"
    )
