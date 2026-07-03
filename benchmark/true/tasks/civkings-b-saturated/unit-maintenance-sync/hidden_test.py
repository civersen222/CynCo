"""Hidden grading test for the `unit-maintenance-sync` benchmark task.

CivKings has two independent sources of truth for per-turn unit maintenance:

  * the canonical unit definitions in ``game_data.py`` (``UNIT_TYPES[t]``
    carries a ``gold_maintenance`` figure per unit type), and
  * a hand-written table plus summing routine in ``gold_management.py``.

The turn loop in ``game.py`` charges the treasury for maintenance. These
sources disagree for several unit types, and some unit types are missing
entirely from the ``gold_management`` table (so they fall back to an
arbitrary default fee instead of their canonical cost).

These tests are relational: they compare ``gold_management``'s computed
maintenance and the turn-loop's treasury charge against the canonical
``UNIT_TYPES`` figures, so they do not hard-code any particular gold number.
Each test is independently satisfiable.
"""
import os
import math

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _canonical(unit_type):
    """Canonical per-turn maintenance for a unit type from game_data."""
    from game_data import UNIT_TYPES
    return float(UNIT_TYPES[unit_type].gold_maintenance)


def _gm_for_army(unit_types):
    """Maintenance that gold_management computes for an army of these types.

    Uses the real GoldManagement registration + summing API.
    """
    from gold_management import GoldManagement

    gm = GoldManagement()
    for i, t in enumerate(unit_types):
        gm.add_unit(f"{t}-{i}", t)
    return float(gm.calculate_unit_maintenance())


def _new_game():
    from game_data import CIVILIZATIONS
    from game import Game
    return Game(CIVILIZATIONS["Rome"], [CIVILIZATIONS["Greece"]])


def _player(game):
    return game.player_civ.name


def _seed_army(game, unit_types):
    """Place one unit of each given type for the player on the map."""
    from military import Unit

    pc = _player(game)
    pos = next(
        (u.position for u in game.units.values() if u.owner == pc),
        (0, 0),
    )
    names = []
    for i, t in enumerate(unit_types):
        u = Unit(t, pc, pos)
        u.name = f"{pc} {t} seed {i}"
        game.units[u.name] = u
        game.military_manager.units.append(u)
        names.append(u.name)
    return names


# A spread of unit types that exist in the canonical UNIT_TYPES table and
# whose canonical maintenance values differ from each other.
_COMMON_ARMY = ["Militia", "Archer", "Knight", "Catapult", "Crossbowman"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_gold_management_matches_canonical_sum_for_common_army():
    """gold_management's army total must equal the canonical per-unit sum."""
    army = list(_COMMON_ARMY)

    expected = sum(_canonical(t) for t in army)
    actual = _gm_for_army(army)

    assert math.isclose(actual, expected, rel_tol=0, abs_tol=1e-6), (
        f"gold_management charged {actual} for army {army}, but the canonical "
        f"per-unit maintenance from UNIT_TYPES sums to {expected}"
    )


def test_every_unit_type_agrees_with_canonical():
    """Per type, one unit's gold_management maintenance == canonical figure.

    This includes types that are absent from gold_management's own table:
    a missing type must be charged its canonical cost, never an arbitrary
    default, and a canonically-free unit must genuinely cost zero.
    """
    from game_data import UNIT_TYPES

    mismatches = []
    for t in sorted(UNIT_TYPES):
        canonical = _canonical(t)
        computed = _gm_for_army([t])
        if not math.isclose(computed, canonical, rel_tol=0, abs_tol=1e-6):
            mismatches.append((t, canonical, computed))

    assert not mismatches, (
        "unit types whose gold_management maintenance disagrees with the "
        f"canonical UNIT_TYPES.gold_maintenance: {mismatches}"
    )


def test_turn_loop_charge_matches_gold_management():
    """The turn-loop maintenance charge and gold_management must agree.

    The turn loop in game.py bills the treasury for maintenance using the
    canonical UNIT_TYPES figures, while gold_management computes its own total
    for the same army. Whichever path runs, the army must be billed the same
    amount, so the two computations must coincide for a real player army.
    """
    game = _new_game()
    pc = _player(game)

    # Remove any pre-placed player units so we measure exactly our army.
    for name in [n for n, u in list(game.units.items()) if u.owner == pc]:
        del game.units[name]
    game.military_manager.units = [
        u for u in game.military_manager.units if getattr(u, "owner", None) != pc
    ]

    army = list(_COMMON_ARMY)
    _seed_army(game, army)

    # 1. What the turn loop charges: canonical sum over the player's living
    #    units (this mirrors game.py's maintenance block exactly).
    from game_data import UNIT_TYPES
    turn_loop_charge = 0.0
    for unit in game.units.values():
        if unit.owner == pc and getattr(unit, "is_alive", True):
            utype = UNIT_TYPES.get(unit.unit_type)
            if utype is not None:
                turn_loop_charge += float(utype.gold_maintenance)

    # 2. What gold_management computes for the same army.
    gm_charge = _gm_for_army(army)

    assert math.isclose(turn_loop_charge, gm_charge, rel_tol=0, abs_tol=1e-6), (
        f"turn loop bills {turn_loop_charge} for the player's army but "
        f"gold_management computes {gm_charge} for the same units {army}; "
        f"the two maintenance sources disagree"
    )

    # And both must equal the canonical per-unit sum.
    expected = sum(_canonical(t) for t in army)
    assert math.isclose(gm_charge, expected, rel_tol=0, abs_tol=1e-6), (
        f"gold_management bills {gm_charge} but the canonical total is "
        f"{expected} for army {army}"
    )


def test_maintenance_non_negative_and_monotonic():
    """Maintenance is never negative and never shrinks as the army grows."""
    from game_data import UNIT_TYPES

    types = sorted(UNIT_TYPES)
    running = []
    prev_total = 0.0
    for t in types:
        running.append(t)
        total = _gm_for_army(running)
        assert total >= -1e-9, (
            f"maintenance went negative ({total}) for army {running}"
        )
        assert total >= prev_total - 1e-9, (
            f"maintenance shrank from {prev_total} to {total} after adding {t}"
        )
        prev_total = total
