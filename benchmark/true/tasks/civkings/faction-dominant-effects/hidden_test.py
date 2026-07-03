"""Hidden scoring test (never shown to the agent).

A dominant faction (influence >= 70) must contribute its bonuses to the
combined faction effects, scaled by 0.1. A marginalized faction (influence
<= 20) contributes its penalties scaled by 0.05. Passes against unmodified
CivKings at 03b4032; fails when the dominant-faction bonus aggregation in
FactionManager.get_faction_effects is removed (the setup.patch stub).
"""
from faction_system import FactionManager, Faction


def _build_manager() -> FactionManager:
    fm = FactionManager("Rome")
    # Nobles dominant (influence 80): bonuses stability=5, military=10
    fm.factions["nobles"] = Faction(
        name="Noble Court of Rome",
        faction_type="nobles",
        influence=80,
        support=50,
    )
    # Popular marginalized (influence 10): penalties stability=-5, military=-5
    fm.factions["popular"] = Faction(
        name="Popular Assembly of Rome",
        faction_type="popular",
        influence=10,
        support=50,
    )
    fm._update_dominant_faction()
    fm.conflict_level = 0.0
    return fm


def test_dominant_faction_bonuses_aggregated():
    fm = _build_manager()
    effects = fm.get_faction_effects()

    # military comes only from the dominant nobles bonus (10 * 0.1 = 1.0)
    # minus the marginalized popular penalty (-5 * 0.05 = -0.25)
    assert effects["military"] == 0.75
    # stability: nobles bonus 5*0.1=0.5 + popular penalty -5*0.05=-0.25
    assert effects["stability"] == 0.25


def test_only_dominant_provides_bonuses():
    fm = FactionManager("Athens")
    # Single non-dominant, non-marginalized faction (influence 50) => no effects
    fm.factions["religious"] = Faction(
        name="Religious Order of Athens",
        faction_type="religious",
        influence=50,
        support=50,
    )
    fm._update_dominant_faction()
    fm.conflict_level = 0.0

    effects = fm.get_faction_effects()
    assert effects["culture"] == 0.0
    assert effects["happiness"] == 0.0

    # Raise to dominant: religious bonuses culture=10, happiness=5
    fm.factions["religious"].influence = 75
    effects = fm.get_faction_effects()
    assert effects["culture"] == 1.0
    assert effects["happiness"] == 0.5
