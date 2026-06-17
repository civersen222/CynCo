"""Hidden grading test for the `gold-deficit-consequences` benchmark task.

Verifies that a civilization's gold deficit has real consequences on its
army:

  * a moderate deficit debuffs unit combat strength,
  * a severe deficit disbands at least one unit,
  * disbanded units are gone from every registry (no dangling references),
  * a healthy treasury leaves the army untouched (regression guard).

The tests are relational (they compare against each unit's own base stats and
against the pre-turn count) so they do not hard-code the implementation's
chosen thresholds.
"""
import os
import math

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _new_game():
    from game_data import CIVILIZATIONS
    from game import Game
    return Game(CIVILIZATIONS["Rome"], [CIVILIZATIONS["Greece"]])


def _player(game):
    return game.player_civ.name


def _seed_army(game, count=6, unit_type="Swordsman"):
    """Add `count` combat units to the player and return their names."""
    from military import Unit

    pc = _player(game)
    # Reuse an existing player unit position so the units sit on the map.
    pos = next(
        (u.position for u in game.units.values() if u.owner == pc),
        (0, 0),
    )
    names = []
    for i in range(count):
        u = Unit(unit_type, pc, pos)
        u.name = f"{pc} {unit_type} seed {i}"
        game.units[u.name] = u
        game.military_manager.units.append(u)
        names.append(u.name)
    return names


def _player_combat_units(game):
    pc = _player(game)
    return [
        u
        for u in game.units.values()
        if u.owner == pc and u.is_alive and (u.attack > 0 or u.defense > 0)
    ]


def _base_stats(unit):
    base = unit.get_base_stats()
    return base["attack"], base["defense"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_moderate_deficit_debuffs_combat_strength():
    """A real gold deficit should weaken surviving units below their base."""
    game = _new_game()
    pc = _player(game)
    _seed_army(game, count=6)

    # Snapshot base stats per unit by name.
    base_by_name = {
        u.name: _base_stats(u) for u in _player_combat_units(game)
    }
    assert base_by_name, "expected seeded combat units before the turn"

    # Drive the treasury into a clear deficit.
    game.gold[pc] = -300

    game.process_turn()

    survivors = {u.name: u for u in _player_combat_units(game)}
    assert survivors, "no surviving combat units to inspect after the turn"

    weakened = 0
    for name, unit in survivors.items():
        if name not in base_by_name:
            continue
        base_atk, base_def = base_by_name[name]
        if unit.attack < base_atk or unit.defense < base_def:
            weakened += 1

    assert weakened >= 1, (
        "expected at least one surviving unit to have reduced attack or "
        "defense after a turn spent in heavy gold deficit"
    )


def test_severe_deficit_disbands_units():
    """A severe deficit should reduce the player's living unit count."""
    game = _new_game()
    pc = _player(game)
    _seed_army(game, count=8)

    count_before = len(
        [u for u in game.units.values() if u.owner == pc and u.is_alive]
    )
    assert count_before >= 4, "test setup should leave several player units"

    # Push the treasury into a deep, sustained deficit.
    game.gold[pc] = -1000

    game.process_turn()

    count_after = len(
        [u for u in game.units.values() if u.owner == pc and u.is_alive]
    )

    assert count_after < count_before, (
        f"expected unit count to drop under a severe deficit "
        f"(before={count_before}, after={count_after})"
    )


def test_disbanded_unit_removed_from_all_registries():
    """Disbanded units must not linger in any registry."""
    game = _new_game()
    pc = _player(game)
    _seed_army(game, count=8)

    names_before = {
        u.name for u in game.units.values() if u.owner == pc and u.is_alive
    }

    game.gold[pc] = -1000
    game.process_turn()

    names_after = {
        u.name for u in game.units.values() if u.owner == pc and u.is_alive
    }
    disbanded = names_before - names_after
    assert disbanded, "expected at least one unit to be disbanded"

    # 1. Disbanded units must be gone from the primary name->Unit registry.
    for name in disbanded:
        assert name not in game.units, (
            f"disbanded unit {name!r} still present in game.units"
        )

    # 2. Disbanded units must be gone from the military manager's flat list.
    mm_alive_names = {
        getattr(u, "name", None)
        for u in game.military_manager.units
        if getattr(u, "is_alive", True)
    }
    for name in disbanded:
        assert name not in mm_alive_names, (
            f"disbanded unit {name!r} still tracked by military_manager"
        )

    # 3. No dangling double-count: every living player unit in the manager is
    #    also present in game.units (registries agree).
    for u in game.military_manager.units:
        if getattr(u, "owner", None) == pc and getattr(u, "is_alive", False):
            assert u.name in game.units, (
                f"military_manager has live unit {u.name!r} missing from game.units"
            )


def test_healthy_treasury_leaves_army_intact():
    """Regression guard: no deficit means no debuff and no disbanding."""
    game = _new_game()
    pc = _player(game)
    _seed_army(game, count=6)

    base_by_name = {
        u.name: _base_stats(u) for u in _player_combat_units(game)
    }
    count_before = len(
        [u for u in game.units.values() if u.owner == pc and u.is_alive]
    )

    # Keep the treasury comfortably positive.
    game.gold[pc] = 5000

    game.process_turn()

    count_after = len(
        [u for u in game.units.values() if u.owner == pc and u.is_alive]
    )
    assert count_after == count_before, (
        f"healthy treasury should not disband units "
        f"(before={count_before}, after={count_after})"
    )

    for unit in _player_combat_units(game):
        if unit.name not in base_by_name:
            continue
        base_atk, base_def = base_by_name[unit.name]
        assert unit.attack >= base_atk, (
            f"{unit.name} lost attack with a healthy treasury"
        )
        assert unit.defense >= base_def, (
            f"{unit.name} lost defense with a healthy treasury"
        )
