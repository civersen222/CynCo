import pytest

from events.registry import Event, Outcome, register, get


def test_register_and_get():
    ev = register(Event("probe_register", "A probe", (Outcome("one", "One thing happened.", {"gold": 1}),)))
    assert get("probe_register") is ev
    assert len(ev.outcomes) == 1


def test_duplicate_id_raises():
    register(Event("probe_duplicate", "A probe", ()))
    with pytest.raises(ValueError):
        register(Event("probe_duplicate", "Again", ()))
