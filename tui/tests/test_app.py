"""Tests for the main LocalCode TUI application (Task 23).

Tests cover: LocalCodeApp class, event routing, main() entry point.
"""
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from textual.app import App


# ─── LocalCodeApp ─────────────────────────────────────────────

class TestLocalCodeApp:
    """Tests for the main Textual application."""

    def test_import(self):
        from localcode_tui.app import LocalCodeApp
        assert LocalCodeApp is not None

    def test_inherits_app(self):
        from localcode_tui.app import LocalCodeApp
        assert issubclass(LocalCodeApp, App)

    def test_constructor_defaults(self):
        from localcode_tui.app import LocalCodeApp
        app = LocalCodeApp()
        assert app.bridge_port == 9160
        assert app.show_setup is False
        assert app.bridge is None
        assert app._current_message == ""

    def test_constructor_custom_port(self):
        from localcode_tui.app import LocalCodeApp
        app = LocalCodeApp(port=8080)
        assert app.bridge_port == 8080

    def test_constructor_setup_flag(self):
        from localcode_tui.app import LocalCodeApp
        app = LocalCodeApp(setup=True)
        assert app.show_setup is True

    def test_has_title(self):
        from localcode_tui.app import LocalCodeApp
        assert LocalCodeApp.TITLE == "LocalCode"

    def test_has_bindings(self):
        from localcode_tui.app import LocalCodeApp
        assert LocalCodeApp.BINDINGS is not None
        # Should have at least quit and switch mode
        binding_keys = [b[0] for b in LocalCodeApp.BINDINGS]
        assert "ctrl+q" in binding_keys
        assert "ctrl+w" in binding_keys

    def test_has_send_message(self):
        from localcode_tui.app import LocalCodeApp
        assert hasattr(LocalCodeApp, "send_message")

    def test_has_action_switch_mode(self):
        from localcode_tui.app import LocalCodeApp
        assert hasattr(LocalCodeApp, "action_switch_mode")

    def test_has_action_quit(self):
        from localcode_tui.app import LocalCodeApp
        assert hasattr(LocalCodeApp, "action_quit")

    def test_loads_config(self):
        from localcode_tui.app import LocalCodeApp
        app = LocalCodeApp()
        assert app.config is not None
        assert hasattr(app.config, "ui")

    def test_event_handler_methods(self):
        """App should have handlers for all protocol events."""
        from localcode_tui.app import LocalCodeApp
        app = LocalCodeApp()
        assert hasattr(app, "_handle_stream_token")
        assert hasattr(app, "_handle_message_complete")
        assert hasattr(app, "_handle_tool_start")
        assert hasattr(app, "_handle_tool_complete")
        assert hasattr(app, "_handle_approval_request")
        assert hasattr(app, "_handle_context_status")
        assert hasattr(app, "_handle_context_warning")

    def test_process_event_dispatch_stream_token(self):
        """on_local_code_app_engine_event_received should route StreamTokenEvent to handler."""
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import StreamTokenEvent
        app = LocalCodeApp()
        app._handle_stream_token = MagicMock()
        event = StreamTokenEvent(text="hello")
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        app._handle_stream_token.assert_called_once_with(event)

    def test_process_event_dispatch_message_complete(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import MessageCompleteEvent
        app = LocalCodeApp()
        app._handle_message_complete = MagicMock()
        event = MessageCompleteEvent(message_id="123")
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        app._handle_message_complete.assert_called_once_with(event)

    def test_process_event_dispatch_tool_start(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import ToolStartEvent
        app = LocalCodeApp()
        app._handle_tool_start = MagicMock()
        event = ToolStartEvent(tool_id="t1", tool_name="read")
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        app._handle_tool_start.assert_called_once_with(event)

    def test_process_event_dispatch_tool_complete(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import ToolCompleteEvent
        app = LocalCodeApp()
        app._handle_tool_complete = MagicMock()
        event = ToolCompleteEvent(tool_id="t1")
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        app._handle_tool_complete.assert_called_once_with(event)

    def test_process_event_dispatch_context_status(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import ContextStatusEvent
        app = LocalCodeApp()
        app._handle_context_status = MagicMock()
        event = ContextStatusEvent(utilization=0.5)
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        app._handle_context_status.assert_called_once_with(event)

    def test_process_event_dispatch_session_ready(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import SessionReadyEvent
        app = LocalCodeApp()
        app.notify = MagicMock()
        app._handle_session_ready = MagicMock()
        event = SessionReadyEvent(model="llama3.2:7b")
        msg = LocalCodeApp.EngineEventReceived(event)
        app.on_local_code_app_engine_event_received(msg)
        assert app.sub_title == "Model: llama3.2:7b"
        app._handle_session_ready.assert_called_once_with(event)

    def test_handle_stream_token_accumulates(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import StreamTokenEvent
        app = LocalCodeApp()
        app._handle_stream_token(StreamTokenEvent(text="hello "))
        assert app._current_message == "hello "
        app._handle_stream_token(StreamTokenEvent(text="world"))
        assert app._current_message == "hello world"

    def test_handle_message_complete_resets(self):
        from localcode_tui.app import LocalCodeApp
        from localcode_tui.protocol import MessageCompleteEvent
        app = LocalCodeApp()
        app._current_message = "accumulated text"
        app._handle_message_complete(MessageCompleteEvent(message_id="m1"))
        assert app._current_message == ""


# ─── main() entry point ──────────────────────────────────────

class TestMain:
    """Tests for the main() CLI entry point."""

    def test_main_exists(self):
        from localcode_tui.app import main
        assert callable(main)


# ─── Theme file exists ───────────────────────────────────────

class TestTheme:
    """Tests that theme.tcss exists and has content."""

    def test_theme_file_exists(self):
        from pathlib import Path
        theme_path = Path(__file__).parent.parent / "localcode_tui" / "styles" / "theme.tcss"
        assert theme_path.exists(), f"theme.tcss not found at {theme_path}"
        content = theme_path.read_text()
        assert len(content) > 0

    def test_workspace_tcss_exists(self):
        from pathlib import Path
        p = Path(__file__).parent.parent / "localcode_tui" / "styles" / "workspace.tcss"
        assert p.exists(), f"workspace.tcss not found at {p}"

    def test_guided_tcss_exists(self):
        from pathlib import Path
        p = Path(__file__).parent.parent / "localcode_tui" / "styles" / "guided.tcss"
        assert p.exists(), f"guided.tcss not found at {p}"
