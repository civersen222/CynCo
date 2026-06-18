"""Hidden scoring test for the tax-happiness-chain wiring task (never shown to the agent).

CivKings already ships a TaxSystem (gold multiplier + a happiness_penalty that scales
with how far the tax rate sits above the neutral rate of 50), a HappinessSystem (whose
current_happiness subtracts a settable tax_penalty and clamps to 0-100), and a
StabilitySystem (apply_change clamps 0-100). What is missing is the *wiring* in the
turn loop: raising the tax rate never actually lowers happiness, and sustained low
happiness never erodes stability.

Each test exercises the REAL classes through game.Game.process_turn (or, for the
already-deterministic gold path, the real TaxSystem) and is independent so partial
implementations score partially:

  (a) a higher tax rate yields more tax gold income than a lower rate,
  (b) a higher tax rate yields lower happiness than a lower rate after a turn,
  (c) sustained low happiness drives stability below a high-happiness baseline,
  (d) an extreme tax rate never pushes happiness outside the 0-100 clamp.

Tests are headless: game.py imports no GUI/pygame modules. random is seeded so the
turn loop is deterministic.
"""
import random

from game import Game
from game_data import CIVILIZATIONS
from city import City


PLAYER = "Rome"
RIVAL = "Greece"


def _new_game():
    """Construct a minimal two-civ game deterministically."""
    random.seed(0)
    return Game(
        player_civ=CIVILIZATIONS[PLAYER],
        ai_civs=[CIVILIZATIONS[RIVAL]],
        map_width=8,
        map_height=8,
    )


def _player_city_names(g):
    return [name for name, c in g.cities.items() if c.owner == PLAYER]


def _flood_cities(g, count):
    """Give the player many extra cities so the existing overextension penalty
    drives empire happiness low without depending on any new mechanic."""
    for i in range(count):
        c = City(name=f"OverflowTown{i}", owner=PLAYER, position=(i % 7, (i // 7) % 7))
        g.cities[c.name] = c


def test_higher_tax_yields_more_gold_income():
    """A higher tax rate must extract strictly more tax gold income than a lower
    rate from the same cities. (This path already scales on the base game.)"""
    g = _new_game()

    g.tax_system.set_tax_rate(20)
    low_income = g.tax_system.process_tax_income(g.cities)

    g.tax_system.set_tax_rate(80)
    high_income = g.tax_system.process_tax_income(g.cities)

    assert high_income > low_income, (
        f"tax income at 80% ({high_income}) should exceed income at 20% ({low_income})"
    )


def test_higher_tax_lowers_happiness():
    """After a processed turn, empire happiness at a punishing tax rate must be
    strictly below happiness at the neutral rate -- i.e. the tax->happiness link
    is actually wired into the turn loop."""
    def happiness_at(rate):
        g = _new_game()
        g.tax_system.set_tax_rate(rate)
        random.seed(0)
        g.process_turn()
        return g.happiness_system.current_happiness

    neutral_happiness = happiness_at(50)
    high_tax_happiness = happiness_at(100)

    assert high_tax_happiness < neutral_happiness, (
        f"happiness at 100% tax ({high_tax_happiness}) should be below happiness "
        f"at the neutral 50% rate ({neutral_happiness})"
    )


def test_sustained_low_happiness_lowers_stability():
    """When empire happiness stays low across several processed turns, stability
    must fall below the high-happiness baseline run under identical conditions."""
    def stability_after(num_extra_cities, turns=5):
        g = _new_game()
        g.tax_system.set_tax_rate(20)
        _flood_cities(g, num_extra_cities)
        for _ in range(turns):
            random.seed(0)
            g.process_turn()
        return g.happiness_system.current_happiness, g.stability_system.stability

    baseline_happiness, baseline_stability = stability_after(0)
    low_happiness, low_stability = stability_after(25)

    # Sanity: the flooded empire is genuinely the low-happiness one.
    assert low_happiness < baseline_happiness, (
        f"flooded empire happiness {low_happiness} should be below baseline "
        f"{baseline_happiness}"
    )
    assert low_stability < baseline_stability, (
        f"sustained low-happiness stability {low_stability} should be below the "
        f"high-happiness baseline {baseline_stability}"
    )


def test_extreme_tax_respects_happiness_clamp():
    """An extreme tax rate, even stacked on other happiness penalties, must never
    push happiness outside the legal 0-100 range."""
    g = _new_game()
    _flood_cities(g, 30)  # heavy overextension penalty on top of tax
    g.tax_system.set_tax_rate(100)
    random.seed(0)
    g.process_turn()

    happiness = g.happiness_system.current_happiness
    assert 0 <= happiness <= 100, (
        f"happiness {happiness} must stay within the 0-100 clamp under extreme tax"
    )
