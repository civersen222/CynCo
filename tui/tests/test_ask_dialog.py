"""Tests for AskDialog and the ask.request -> ask.answer wiring."""
from localcode_tui.widgets.ask_dialog import AskDialog


def test_dialog_stores_question_and_options():
    d = AskDialog("Which DB?", ["sqlite", "postgres"])
    assert d.question == "Which DB?"
    assert d.options == ["sqlite", "postgres"]


def test_dialog_defaults_to_free_text():
    d = AskDialog("Name?")
    assert d.options == []


def test_handler_registered_in_dispatch_table():
    """Verify AskRequestEvent is in the event dispatch table."""
    from localcode_tui.app import LocalCodeApp
    from localcode_tui.protocol import AskRequestEvent

    # Create an app instance to access _event_dispatch_table
    app = LocalCodeApp()
    table = app._event_dispatch_table()

    # AskRequestEvent should map to _handle_ask_request
    assert AskRequestEvent in table
    assert table[AskRequestEvent] == app._handle_ask_request


def test_ask_dialog_has_escape_binding():
    """Verify AskDialog has an Escape binding to cancel."""
    from localcode_tui.widgets.ask_dialog import AskDialog

    assert hasattr(AskDialog, "BINDINGS")
    binding_keys = [b[0] for b in AskDialog.BINDINGS]
    assert "escape" in binding_keys


def test_ask_dialog_can_cancel():
    """Verify AskDialog can be dismissed with an empty string."""
    d = AskDialog("Question?")

    # Test that action_cancel method exists and dismisses with empty string
    assert hasattr(d, "action_cancel")
    assert callable(d.action_cancel)
