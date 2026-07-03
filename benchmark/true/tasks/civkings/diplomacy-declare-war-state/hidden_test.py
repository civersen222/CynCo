"""Hidden scoring test (never shown to the agent).

Declaring war must (1) register the war on BOTH civilizations symmetrically so
is_at_war / get_active_wars report it from either side, and (2) sour relations by
-50 (clamped to the -100..100 floor). The relation hit also drives get_all_relations
into the "War" status bucket. Passes against unmodified CivKings at 03b4032; fails
when declare_war is reduced to a one-sided registration with no relation penalty
(the setup.patch).
"""
from diplomacy import DiplomacyManager


def test_war_is_registered_on_both_sides():
    d = DiplomacyManager()
    d.declare_war("Rome", "Athens")
    assert d.is_at_war("Rome", "Athens") is True
    assert d.is_at_war("Athens", "Rome") is True
    assert d.get_active_wars("Rome") == ["Athens"]
    assert d.get_active_wars("Athens") == ["Rome"]


def test_declaring_war_damages_relations_by_fifty():
    d = DiplomacyManager()
    assert d.get_relation("Rome", "Athens") == 0
    d.declare_war("Rome", "Athens")
    assert d.get_relation("Rome", "Athens") == -50
    # relation lookup must be order-independent
    assert d.get_relation("Athens", "Rome") == -50


def test_war_relation_penalty_clamps_at_floor():
    d = DiplomacyManager()
    # drive relations to the floor, then a war hit cannot go below -100
    d.modify_relation("Rome", "Athens", -80)
    d.declare_war("Rome", "Athens")
    assert d.get_relation("Rome", "Athens") == -100


def test_war_shows_up_as_war_status():
    d = DiplomacyManager()
    d.declare_war("Rome", "Athens")
    pair = tuple(sorted(["Rome", "Athens"]))
    statuses = d.get_all_relations()
    assert statuses[pair] == "War"
