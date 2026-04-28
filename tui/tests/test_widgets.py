"""Tests for TUI widgets (Task 19).

Tests cover: ChatPanel, ContextBar, ApprovalDialog, ToolActivity,
FilePreview, DiffView, FileTree, ProgressList.
"""
import pytest
from unittest.mock import patch

from textual.app import App, ComposeResult
from textual.widgets import Static


# ─── ChatPanel ────────────────────────────────────────────────

class TestChatPanel:
    """Tests for the ChatPanel (RichLog-based) widget."""

    def test_import(self):
        from localcode_tui.widgets.chat_panel import ChatPanel
        assert ChatPanel is not None

    def test_inherits_richlog(self):
        from localcode_tui.widgets.chat_panel import ChatPanel
        from textual.widgets import RichLog
        assert issubclass(ChatPanel, RichLog)

    def test_has_required_methods(self):
        from localcode_tui.widgets.chat_panel import ChatPanel
        assert hasattr(ChatPanel, "add_user_message")
        assert hasattr(ChatPanel, "add_assistant_token")
        assert hasattr(ChatPanel, "complete_assistant_message")
        assert hasattr(ChatPanel, "add_system_message")
        assert hasattr(ChatPanel, "add_error")

    def test_has_default_css(self):
        from localcode_tui.widgets.chat_panel import ChatPanel
        assert ChatPanel.DEFAULT_CSS is not None
        assert "ChatPanel" in ChatPanel.DEFAULT_CSS


# ─── ContextBar ───────────────────────────────────────────────

class TestContextBar:
    """Tests for the ContextBar reactive gauge widget."""

    def test_import(self):
        from localcode_tui.widgets.context_bar import ContextBar
        assert ContextBar is not None

    def test_inherits_static(self):
        from localcode_tui.widgets.context_bar import ContextBar
        assert issubclass(ContextBar, Static)

    def test_has_reactive_utilization(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        assert hasattr(bar, "utilization")

    def test_has_reactive_thresholds(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        assert hasattr(bar, "warning_threshold")
        assert hasattr(bar, "hard_limit")

    def test_render_bar_ok_state(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        result = bar._render_bar(0.2)
        assert "OK" in result
        assert "green" in result

    def test_render_bar_warning_state(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        result = bar._render_bar(0.5)
        assert "WARNING" in result
        assert "yellow" in result

    def test_render_bar_critical_state(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        result = bar._render_bar(0.9)
        assert "CRITICAL" in result
        assert "red" in result

    def test_render_bar_percentage(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        result = bar._render_bar(0.5)
        assert "50%" in result

    def test_render_bar_clamps_to_100(self):
        from localcode_tui.widgets.context_bar import ContextBar
        bar = ContextBar()
        result = bar._render_bar(1.5)
        assert "100%" in result

    def test_default_css(self):
        from localcode_tui.widgets.context_bar import ContextBar
        assert "ContextBar" in ContextBar.DEFAULT_CSS


# ─── ApprovalDialog ──────────────────────────────────────────

class TestApprovalDialog:
    """Tests for the tool approval modal dialog."""

    def test_import(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        assert ApprovalDialog is not None

    def test_inherits_modal_screen(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        from textual.screen import ModalScreen
        assert issubclass(ApprovalDialog, ModalScreen)

    def test_constructor_stores_fields(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        dialog = ApprovalDialog("read_file", "Reading /etc/passwd", risk="high")
        assert dialog.tool_name == "read_file"
        assert dialog.description == "Reading /etc/passwd"
        assert dialog.risk == "high"

    def test_constructor_default_risk(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        dialog = ApprovalDialog("edit_file", "Editing foo.py")
        assert dialog.risk == "low"

    def test_has_compose_method(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        assert hasattr(ApprovalDialog, "compose")

    def test_has_button_handler(self):
        from localcode_tui.widgets.approval import ApprovalDialog
        assert hasattr(ApprovalDialog, "on_button_pressed")


# ─── ToolActivity ─────────────────────────────────────────────

class TestToolActivity:
    """Tests for the tool activity display widget."""

    def test_import(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        assert ToolActivity is not None

    def test_inherits_static(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        assert issubclass(ToolActivity, Static)

    def test_has_active_tools_reactive(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        activity = ToolActivity()
        assert hasattr(activity, "active_tools")

    def test_has_start_tool(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        assert hasattr(ToolActivity, "start_tool")

    def test_has_complete_tool(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        assert hasattr(ToolActivity, "complete_tool")

    def test_default_css(self):
        from localcode_tui.widgets.tool_activity import ToolActivity
        assert "ToolActivity" in ToolActivity.DEFAULT_CSS


# ─── FilePreview ──────────────────────────────────────────────

class TestFilePreview:
    """Tests for the file preview widget."""

    def test_import(self):
        from localcode_tui.widgets.file_preview import FilePreview
        assert FilePreview is not None

    def test_inherits_static(self):
        from localcode_tui.widgets.file_preview import FilePreview
        assert issubclass(FilePreview, Static)

    def test_has_show_file(self):
        from localcode_tui.widgets.file_preview import FilePreview
        assert hasattr(FilePreview, "show_file")

    def test_has_show_diff(self):
        from localcode_tui.widgets.file_preview import FilePreview
        assert hasattr(FilePreview, "show_diff")

    def test_default_css(self):
        from localcode_tui.widgets.file_preview import FilePreview
        assert "FilePreview" in FilePreview.DEFAULT_CSS


# ─── DiffView ─────────────────────────────────────────────────

class TestDiffView:
    """Tests for the diff view widget."""

    def test_import(self):
        from localcode_tui.widgets.diff_view import DiffView
        assert DiffView is not None

    def test_inherits_static(self):
        from localcode_tui.widgets.diff_view import DiffView
        assert issubclass(DiffView, Static)

    def test_has_show_diff(self):
        from localcode_tui.widgets.diff_view import DiffView
        assert hasattr(DiffView, "show_diff")

    def test_default_css(self):
        from localcode_tui.widgets.diff_view import DiffView
        assert "DiffView" in DiffView.DEFAULT_CSS


# ─── FileTree ─────────────────────────────────────────────────

class TestFileTree:
    """Tests for the file tree widget."""

    def test_import(self):
        from localcode_tui.widgets.file_tree import FileTree
        assert FileTree is not None

    def test_inherits_directory_tree(self):
        from localcode_tui.widgets.file_tree import FileTree
        from textual.widgets import DirectoryTree
        assert issubclass(FileTree, DirectoryTree)

    def test_default_css(self):
        from localcode_tui.widgets.file_tree import FileTree
        assert "FileTree" in FileTree.DEFAULT_CSS


# ─── ProgressList ─────────────────────────────────────────────

class TestProgressList:
    """Tests for the step progress list widget."""

    def test_import(self):
        from localcode_tui.widgets.progress import ProgressList
        assert ProgressList is not None

    def test_inherits_static(self):
        from localcode_tui.widgets.progress import ProgressList
        assert issubclass(ProgressList, Static)

    def test_constructor_with_steps(self):
        from localcode_tui.widgets.progress import ProgressList
        pl = ProgressList(steps=["Step 1", "Step 2", "Step 3"])
        assert len(pl._steps) == 3
        assert pl._steps[0]["text"] == "Step 1"
        assert pl._steps[0]["status"] == "pending"

    def test_constructor_no_steps(self):
        from localcode_tui.widgets.progress import ProgressList
        pl = ProgressList()
        assert len(pl._steps) == 0

    def test_set_step_status(self):
        from localcode_tui.widgets.progress import ProgressList
        pl = ProgressList(steps=["A", "B"])
        pl.set_step_status(0, "done")
        assert pl._steps[0]["status"] == "done"

    def test_set_step_status_bounds(self):
        from localcode_tui.widgets.progress import ProgressList
        pl = ProgressList(steps=["A"])
        # Out of bounds should not raise
        pl.set_step_status(5, "done")
        pl.set_step_status(-1, "done")

    def test_has_default_css(self):
        from localcode_tui.widgets.progress import ProgressList
        assert "ProgressList" in ProgressList.DEFAULT_CSS


# ─── Widget __init__ exports ─────────────────────────────────

class TestWidgetsInit:
    """Tests for the widgets package __init__.py exports."""

    def test_all_widgets_exported(self):
        from localcode_tui.widgets import (
            ChatPanel,
            ContextBar,
            ApprovalDialog,
            ToolActivity,
            FilePreview,
            DiffView,
            FileTree,
            ProgressList,
            ConfidenceBar,
            CompletionCard,
            EscalationDialog,
            ProjectEntry,
        )
        assert ChatPanel is not None
        assert ContextBar is not None
        assert ApprovalDialog is not None
        assert ToolActivity is not None
        assert FilePreview is not None
        assert DiffView is not None
        assert FileTree is not None
        assert ProgressList is not None
        assert ConfidenceBar is not None
        assert CompletionCard is not None
        assert EscalationDialog is not None
        assert ProjectEntry is not None


# ─── ConfidenceBar ───────────────────────────────────────────

class TestConfidenceBar:
    def test_import(self):
        from localcode_tui.widgets.confidence_bar import ConfidenceBar
        assert ConfidenceBar is not None

    def test_update_confidence(self):
        from localcode_tui.widgets.confidence_bar import ConfidenceBar
        bar = ConfidenceBar()
        bar.update_confidence(
            confidence={"purpose": 80, "mechanics": 30, "integration": 70, "ambiguity": 60},
            overall=30,
            reason="need more on mechanics"
        )
        assert bar._overall == 30


# ─── CompletionCard ──────────────────────────────────────────

class TestCompletionCard:
    def test_import(self):
        from localcode_tui.widgets.completion_screen import CompletionCard
        assert CompletionCard is not None

    def test_set_completion(self):
        from localcode_tui.widgets.completion_screen import CompletionCard
        card = CompletionCard()
        card.set_completion(
            title="Inventory System",
            analogy="Think of it like a backpack.",
            files_changed=["inventory.py"],
            suggestion="Build a shop next.",
        )
        assert card._title == "Inventory System"


# ─── EscalationDialog ───────────────────────────────────────

class TestEscalationDialog:
    def test_import(self):
        from localcode_tui.widgets.escalation_dialog import EscalationDialog
        assert EscalationDialog is not None

    def test_is_modal(self):
        from localcode_tui.widgets.escalation_dialog import EscalationDialog
        from textual.screen import ModalScreen
        assert issubclass(EscalationDialog, ModalScreen)


# ─── ProjectEntry ────────────────────────────────────────────

class TestProjectEntry:
    def test_import(self):
        from localcode_tui.widgets.project_entry import ProjectEntry
        assert ProjectEntry is not None

    def test_set_existing(self):
        from localcode_tui.widgets.project_entry import ProjectEntry
        entry = ProjectEntry()
        entry.set_existing_project("civkings", 15, ["Python"], "Strategy game")
        assert entry._project_name == "civkings"

    def test_set_returning(self):
        from localcode_tui.widgets.project_entry import ProjectEntry
        entry = ProjectEntry()
        entry.set_returning(done=["Built inventory"], next_suggestion="Shop system")
        assert len(entry._done_items) == 1
