"""Hidden scoring test (never shown to the agent)."""
from great_people import GreatPeopleManager, GREAT_PERSON_TYPES


def test_recruitment_deducts_threshold_and_carries_over():
    gp = GreatPeopleManager()
    threshold = GREAT_PERSON_TYPES["Great Scientist"]["threshold"]

    # Seed points above the recruitment threshold for one GP type only.
    gp.points["Rome"] = {t: 0 for t in GREAT_PERSON_TYPES}
    gp.points["Rome"]["Great Scientist"] = threshold + 50

    recruited = gp.check_recruitment("Rome")

    # The great person is recruited exactly once this turn.
    assert recruited == ["Great Scientist"]
    assert len(gp.recruited) == 1
    assert gp.recruited[0]["type"] == "Great Scientist"
    assert gp.recruited[0]["civ"] == "Rome"

    # Recruiting must consume the threshold cost, leaving the overflow to carry over.
    assert gp.points["Rome"]["Great Scientist"] == 50

    # A second check this turn must NOT recruit again (points now below threshold).
    again = gp.check_recruitment("Rome")
    assert again == []
    assert len(gp.recruited) == 1
    assert gp.points["Rome"]["Great Scientist"] == 50
