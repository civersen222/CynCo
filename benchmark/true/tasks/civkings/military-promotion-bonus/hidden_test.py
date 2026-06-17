"""Hidden scoring test (never shown to the agent)."""
from military import Unit


def test_promotion_applies_stat_bonuses():
    # Swordsman base stats: attack 10, defense 10, movement 1.
    unit = Unit("Swordsman", "Rome", (0, 0))
    assert unit.attack == 10
    assert unit.defense == 10
    assert unit.max_moves == 1

    # Earn enough XP to trigger a pending promotion (threshold = 10 * level).
    unit.gain_xp(10)
    assert unit.pending_promotion is True

    # Accept an attack promotion: level rises, bonus is applied to the stat.
    unit.accept_promotion("attack")
    assert unit.pending_promotion is False
    assert unit.level == 2
    assert unit.attack == 11
    assert unit.defense == 10
    assert unit.max_moves == 1

    # Earn the next promotion (threshold now 10 * 2 = 20).
    unit.gain_xp(10)
    assert unit.pending_promotion is True
    unit.accept_promotion("defense")
    assert unit.level == 3
    assert unit.attack == 11
    assert unit.defense == 11

    # Promotions accumulate without resetting earlier bonuses.
    unit.gain_xp(10)
    unit.accept_promotion("attack")
    assert unit.attack == 12
    assert unit.defense == 11
    assert unit.level == 4
