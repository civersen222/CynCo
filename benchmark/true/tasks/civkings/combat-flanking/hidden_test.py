"""Hidden scoring test (never shown to the agent).

Flanking must reward surrounding the defender: combat.calculate_flanking returns
+2 attack per friendly unit adjacent to the defender's hex (the attacker itself
excluded), capped at +12. This bonus also feeds preview_combat's attacker
strength and estimated damage. Passes against unmodified CivKings at 03b4032;
fails when calculate_flanking is stubbed to always return 0 (the setup.patch).
"""
import random

from combat import calculate_flanking, preview_combat, _hex_neighbors
from military import Unit
from hex_map import HexTile
from game_data import TerrainType


def _friendly_on(neighbor_indices, defender_pos):
    neighbors = _hex_neighbors(defender_pos)
    return [Unit("Militia", "Rome", neighbors[i]) for i in neighbor_indices]


def test_no_adjacent_friendlies_gives_no_flank():
    attacker = Unit("Catapult", "Rome", (0, 0))
    defender_pos = (3, 3)
    # only the attacker is "friendly" and it sits far away, not adjacent
    assert calculate_flanking(attacker.position, defender_pos, [attacker]) == 0


def test_flank_scales_two_per_adjacent_friendly():
    attacker = Unit("Catapult", "Rome", (0, 0))
    defender_pos = (3, 3)
    one = _friendly_on([0], defender_pos)
    three = _friendly_on([0, 1, 2], defender_pos)
    assert calculate_flanking(attacker.position, defender_pos, [attacker] + one) == 2
    assert calculate_flanking(attacker.position, defender_pos, [attacker] + three) == 6


def test_flank_is_capped_at_twelve():
    attacker = Unit("Catapult", "Rome", (0, 0))
    defender_pos = (3, 3)
    # cover all 6 neighbor hexes twice over -> 8 adjacent friendlies
    many = _friendly_on([0, 1, 2, 3, 4, 5, 0, 1], defender_pos)
    assert calculate_flanking(attacker.position, defender_pos, [attacker] + many) == 12


def test_attacker_at_defender_position_is_excluded():
    # the attacker standing on a neighbor must not count itself as a flanker
    defender_pos = (3, 3)
    neighbor = _hex_neighbors(defender_pos)[0]
    attacker = Unit("Catapult", "Rome", neighbor)
    assert calculate_flanking(attacker.position, defender_pos, [attacker]) == 0


def test_flank_bonus_increases_preview_attacker_strength():
    random.seed(0)  # only win-chance sim uses RNG; asserted fields are deterministic
    attacker = Unit("Catapult", "Rome", (0, 0))  # attack 16
    defender = Unit("Militia", "Athens", (3, 3))  # defense 6
    tile = HexTile(3, 3, TerrainType.PLAINS)  # no terrain defense bonus

    no_flank = preview_combat(attacker, defender, tile)
    assert no_flank["attacker_strength"] == 16.0
    assert no_flank["estimated_damage"] == 10.0
    assert "flanking" not in no_flank["bonuses"]

    three = _friendly_on([0, 1, 2], (3, 3))
    flanked = preview_combat(
        attacker, defender, tile, friendly_units=[attacker] + three
    )
    # +6% flanking: 16 * 1.06 = 16.96 ; estimated damage = 16.96 - 6.0 = 10.96
    assert flanked["bonuses"]["flanking"] == 6
    assert flanked["attacker_strength"] == 16.96
    assert flanked["estimated_damage"] == 10.96
