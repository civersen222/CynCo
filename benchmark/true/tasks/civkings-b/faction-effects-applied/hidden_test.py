"""Hidden scoring test (never shown to the agent).

Verifies that internal faction influence actually modifies game state during a
processed turn. At the pinned green ref, game.py computes
``FactionManager.get_faction_effects()`` but never applies the result to gold,
stability, or culture, and never records a faction-effect line in the returned
turn log -- so every test here fails. A correct wiring:

  * a dominant faction (influence >= 70) raises its civ's gold,
  * a marginalized empire (all factions <= 20) lowers the player's stability,
  * effects are per-civ (one civ's factions do not change another's gold),
  * the turn log returned by process_turn() mentions a faction effect.

Tests are independent and use strict inequalities so a partial implementation
still scores partial credit. Headless: no pygame surface is created.
"""
import os
import random

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

from game import Game
from game_data import CIVILIZATIONS


def _new_game(seed=1234):
    random.seed(seed)
    return Game(CIVILIZATIONS["Mesopotamia"], ai_civs=["Rome", "Greece"])


def _manager_for(game, civ_name):
    """Return the FactionManager that governs ``civ_name``.

    A correct implementation keeps a per-civ mapping (so AI civs have their own
    factions). The player's manager is always reachable via faction_manager.
    Returns None when no per-civ manager exists (feature not wired for that civ).
    """
    managers = getattr(game, "faction_managers", None)
    if isinstance(managers, dict) and civ_name in managers:
        return managers[civ_name]
    if civ_name == game.player_civ.name:
        return getattr(game, "faction_manager", None)
    return None


def _make_dominant(manager, faction_type, influence=95):
    """Force one faction dominant and the rest neutral (no penalties)."""
    for ft, faction in manager.factions.items():
        faction.influence = 50
    manager.factions[faction_type].influence = influence
    manager._update_dominant_faction()
    manager.conflict_level = 0.0


def _make_all_marginalized(manager, influence=10):
    for faction in manager.factions.values():
        faction.influence = influence
    manager._update_dominant_faction()
    manager.conflict_level = 0.0


def test_dominant_faction_increases_gold():
    """A dominant gold-favoring faction must raise its civ's gold over a turn."""
    game = _new_game()
    mgr = _manager_for(game, "Rome")
    assert mgr is not None, "Rome has no faction manager; effects not wired per-civ"
    # Popular Assembly grants a gold bonus when dominant.
    _make_dominant(mgr, "popular")

    baseline = game.gold["Rome"]
    game.process_turn()

    # Rome owns no cities, so the only thing that can move its gold is the
    # applied faction bonus.
    assert game.gold["Rome"] > baseline


def test_marginalized_faction_applies_penalty():
    """An empire whose factions are all marginalized must lose stability."""
    game = _new_game(seed=99)
    mgr = _manager_for(game, game.player_civ.name)
    assert mgr is not None, "player has no faction manager"
    _make_all_marginalized(mgr)

    baseline_stability = game.stability_system.stability
    game.process_turn()

    assert game.stability_system.stability < baseline_stability


def test_effects_are_per_civ():
    """Tuning one civ's factions must not change another civ's gold."""
    game = _new_game(seed=7)
    rome_mgr = _manager_for(game, "Rome")
    greece_mgr = _manager_for(game, "Greece")
    assert rome_mgr is not None and greece_mgr is not None, (
        "AI civs lack their own faction managers; effects not per-civ"
    )
    # Rome dominant (gold up); Greece left neutral so it should not move.
    _make_dominant(rome_mgr, "popular")
    for faction in greece_mgr.factions.values():
        faction.influence = 50
    greece_mgr._update_dominant_faction()
    greece_mgr.conflict_level = 0.0

    greece_baseline = game.gold["Greece"]
    rome_baseline = game.gold["Rome"]
    game.process_turn()

    # Rome got its bonus; Greece (neutral, no cities) did not.
    assert game.gold["Rome"] > rome_baseline
    assert game.gold["Greece"] == greece_baseline


def test_turn_log_mentions_faction_effect():
    """The returned turn log must name a faction effect when one is applied."""
    game = _new_game(seed=55)
    mgr = _manager_for(game, "Rome")
    assert mgr is not None, "Rome has no faction manager; effects not wired per-civ"
    _make_dominant(mgr, "popular")

    log = game.process_turn()
    blob = "\n".join(str(line) for line in log).lower()
    assert "faction" in blob and "effect" in blob
