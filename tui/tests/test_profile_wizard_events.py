"""ProfileWizard consumes profile.written / profile.validation (review-minors fix)."""
from localcode_tui.protocol import ProfileWrittenEvent, ProfileValidationEvent
from localcode_tui.screens.profile_wizard import ProfileWizard


def _wizard_with_spies():
    w = ProfileWizard()
    calls = {"notify": [], "dismiss": []}
    w.notify = lambda msg, **k: calls["notify"].append((msg, k))
    w.dismiss = lambda result=None: calls["dismiss"].append(result)
    return w, calls


def test_profile_written_notifies_and_dismisses():
    w, calls = _wizard_with_spies()
    w.handle_profile_written(ProfileWrittenEvent(name="my-profile", path="/p.yaml"))
    assert calls["dismiss"] == ["my-profile"]
    assert "my-profile" in calls["notify"][0][0]


def test_profile_validation_failure_keeps_wizard_open():
    w, calls = _wizard_with_spies()
    w.handle_profile_validation(ProfileValidationEvent(ok=False, errors=["bad temperature"]))
    assert calls["dismiss"] == []
    assert "bad temperature" in calls["notify"][0][0]
    assert calls["notify"][0][1].get("severity") == "error"


def test_profile_validation_ok_is_noop():
    w, calls = _wizard_with_spies()
    w.handle_profile_validation(ProfileValidationEvent(ok=True))
    assert calls["notify"] == [] and calls["dismiss"] == []
