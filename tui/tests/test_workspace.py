import pytest
from localcode_tui.protocol import SummaryInjectedEvent


def test_workspace_has_handle_summary_injected_method():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "handle_summary_injected"), \
        "WorkspaceScreen must expose handle_summary_injected for app routing"


def test_summary_injected_chip_text_singular():
    from localcode_tui.screens.workspace import _format_summary_chip
    event = SummaryInjectedEvent(tools_used=["Edit"])
    text = _format_summary_chip(event)
    assert "summary" in text.lower()
    assert "tool" in text.lower()


def test_summary_injected_chip_text_plural():
    from localcode_tui.screens.workspace import _format_summary_chip
    event = SummaryInjectedEvent(tools_used=["Edit", "Bash"])
    text = _format_summary_chip(event)
    assert "tools" in text.lower()


def test_summary_injected_chip_text_empty_tools():
    from localcode_tui.screens.workspace import _format_summary_chip
    event = SummaryInjectedEvent(tools_used=[])
    text = _format_summary_chip(event)
    assert len(text) > 0


def test_workspace_has_handle_memory_recalled_method():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "handle_memory_recalled")


def test_workspace_has_handle_memory_written_method():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "handle_memory_written")


def test_workspace_has_action_open_settings():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "action_open_settings")


def test_workspace_has_action_new_profile():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "action_new_profile")


# ─── Explain mode tests ───────────────────────────────────────

def test_build_explain_prompt():
    from localcode_tui.screens.workspace import _build_explain_prompt
    prompt = _build_explain_prompt("Edit", "src/app.py", "Changed line 42")
    assert "Edit" in prompt
    assert "src/app.py" in prompt
    assert "doesn't write code" in prompt


def test_scripted_explanation_known_tool():
    from localcode_tui.screens.workspace import _scripted_explanation
    text = _scripted_explanation("Edit", "src/app.py")
    assert "changes" in text.lower()
    assert "src/app.py" in text


def test_scripted_explanation_unknown_tool():
    from localcode_tui.screens.workspace import _scripted_explanation
    text = _scripted_explanation("FancyTool", "some input")
    assert len(text) > 0


def test_workspace_has_handle_wizard_response():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "handle_wizard_response")


def test_workspace_has_request_tool_explanation():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "_request_tool_explanation")


def test_workspace_has_action_start_project():
    from localcode_tui.screens.workspace import WorkspaceScreen
    assert hasattr(WorkspaceScreen, "action_start_project")
