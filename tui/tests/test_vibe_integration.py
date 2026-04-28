"""Tests for vibe loop integration wiring (Phase 3)."""
import pytest
import json


class TestConversationLoopVibeMode:
    """Tests verifying the protocol contract for vibeMode."""

    def test_protocol_has_vibe_events(self):
        """All vibe event types must be parseable."""
        from localcode_tui.protocol import parse_event
        events = [
            {"type": "vibe.state_changed", "fromState": "idle", "to": "understand"},
            {"type": "vibe.confidence_update", "confidence": {}, "overall": 50, "reason": "test"},
            {"type": "vibe.task_complete", "title": "Test", "analogy": "Like X", "filesChanged": [], "suggestion": "Do Y"},
            {"type": "vibe.escalation", "problem": "err", "tried": [], "proposal": "fix", "requestId": "1"},
            {"type": "vibe.question", "questionId": "q1", "text": "What?", "options": ["A", "B"]},
        ]
        for raw in events:
            parsed = parse_event(raw)
            assert parsed is not None
            assert hasattr(parsed, 'type')
            assert parsed.type == raw["type"]

    def test_protocol_serializes_vibe_commands(self):
        """Vibe commands must serialize to valid JSON for the engine."""
        from localcode_tui.protocol import serialize_command, VibeStartCommand, VibeAnswerCommand, VibeActionCommand

        cmd = VibeStartCommand(mode="new", description="build a game")
        j = json.loads(serialize_command(cmd))
        assert j["type"] == "vibe.start"
        assert j["mode"] == "new"

        cmd2 = VibeAnswerCommand(question_id="q1", answer="option A")
        j2 = json.loads(serialize_command(cmd2))
        assert j2["type"] == "vibe.answer"
        assert j2["questionId"] == "q1"

        cmd3 = VibeActionCommand(action="accept_suggestion", text="")
        j3 = json.loads(serialize_command(cmd3))
        assert j3["type"] == "vibe.action"
        assert j3["action"] == "accept_suggestion"


class TestVibeController:
    """Tests verifying the VibeController protocol contract."""

    def test_question_event_has_required_fields(self):
        from localcode_tui.protocol import VibeQuestionEvent
        q = VibeQuestionEvent(question_id="q-1", text="What kind of game?", options=["RPG", "Platformer", "Puzzle"])
        assert q.question_id == "q-1"
        assert q.text == "What kind of game?"
        assert len(q.options) == 3

    def test_confidence_update_has_all_dimensions(self):
        from localcode_tui.protocol import VibeConfidenceUpdateEvent
        conf = {"purpose": 80, "mechanics": 40, "integration": 60, "ambiguity": 30}
        evt = VibeConfidenceUpdateEvent(confidence=conf, overall=30, reason="need mechanics details")
        assert evt.overall == 30
        assert evt.confidence["purpose"] == 80
        assert evt.confidence["ambiguity"] == 30

    def test_state_changed_tracks_transitions(self):
        from localcode_tui.protocol import VibeStateChangedEvent
        evt = VibeStateChangedEvent(from_state="idle", to="understand")
        assert evt.from_state == "idle"
        assert evt.to == "understand"


class TestVibeCommandRouting:
    """Tests verifying TUI can send all vibe commands."""

    def test_vibe_start_serializes(self):
        from localcode_tui.protocol import serialize_command, VibeStartCommand
        cmd = VibeStartCommand(mode="new", description="build a todo app")
        j = json.loads(serialize_command(cmd))
        assert j["type"] == "vibe.start"
        assert j["mode"] == "new"
        assert j["description"] == "build a todo app"

    def test_vibe_answer_serializes(self):
        from localcode_tui.protocol import serialize_command, VibeAnswerCommand
        cmd = VibeAnswerCommand(question_id="q-1", answer="option B")
        j = json.loads(serialize_command(cmd))
        assert j["type"] == "vibe.answer"
        assert j["questionId"] == "q-1"
        assert j["answer"] == "option B"

    def test_vibe_action_serializes(self):
        from localcode_tui.protocol import serialize_command, VibeActionCommand
        cmd = VibeActionCommand(action="accept_suggestion")
        j = json.loads(serialize_command(cmd))
        assert j["type"] == "vibe.action"
        assert j["action"] == "accept_suggestion"

    def test_vibe_escalation_response_serializes(self):
        from localcode_tui.protocol import serialize_command, VibeEscalationResponseCommand
        cmd = VibeEscalationResponseCommand(request_id="esc-1", action="fix")
        j = json.loads(serialize_command(cmd))
        assert j["type"] == "vibe.escalation_response"
        assert j["requestId"] == "esc-1"
        assert j["action"] == "fix"


class TestAppVibeEventRouting:
    """Tests verifying app.py routes vibe events correctly."""

    def test_vibe_event_types_importable(self):
        from localcode_tui.protocol import (
            VibeStateChangedEvent,
            VibeConfidenceUpdateEvent,
            VibeTaskCompleteEvent,
            VibeEscalationEvent,
            VibeProjectScannedEvent,
            VibeQuestionEvent,
        )
        assert VibeStateChangedEvent is not None
        assert VibeConfidenceUpdateEvent is not None
        assert VibeTaskCompleteEvent is not None
        assert VibeEscalationEvent is not None
        assert VibeProjectScannedEvent is not None
        assert VibeQuestionEvent is not None

    def test_vibe_loop_screen_has_handlers(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'handle_state_changed')
        assert hasattr(VibeLoopScreen, 'handle_confidence_update')
        assert hasattr(VibeLoopScreen, 'handle_task_complete')
        assert hasattr(VibeLoopScreen, 'handle_question')

    def test_escalation_dialog_importable(self):
        from localcode_tui.widgets.escalation_dialog import EscalationDialog
        assert EscalationDialog is not None

    def test_app_has_vibe_handlers(self):
        """LocalCodeApp must have all vibe handler methods."""
        from localcode_tui.app import LocalCodeApp
        assert hasattr(LocalCodeApp, '_handle_vibe_state_changed')
        assert hasattr(LocalCodeApp, '_handle_vibe_confidence_update')
        assert hasattr(LocalCodeApp, '_handle_vibe_task_complete')
        assert hasattr(LocalCodeApp, '_handle_vibe_escalation')
        assert hasattr(LocalCodeApp, '_handle_vibe_project_scanned')
        assert hasattr(LocalCodeApp, '_handle_vibe_question')


class TestVibeLoopScreenInteraction:
    """Tests for VibeLoopScreen input handling."""

    def test_screen_has_input_handler(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'on_input_submitted')

    def test_screen_has_button_handler(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'on_button_pressed')

    def test_screen_tracks_question_id(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        screen = VibeLoopScreen()
        assert hasattr(screen, '_current_question_id')

    def test_screen_has_escalation_handler(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'handle_escalation')

    def test_screen_has_project_scanned_handler(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'handle_project_scanned')

    def test_screen_has_just_build_action(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, 'action_just_build')

    def test_initial_state_is_idle(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        screen = VibeLoopScreen()
        assert screen._state == "idle"
        assert screen._current_question_id == ""


class TestVibeEntryPoints:
    """Tests for vibe loop entry points."""

    def test_guided_screen_has_vibe_routing(self):
        """GuidedScreen should reference VibeLoopScreen."""
        import inspect
        from localcode_tui.screens.guided import GuidedScreen
        source = inspect.getsource(GuidedScreen)
        assert "VibeLoopScreen" in source

    def test_guided_screen_has_go_vibe(self):
        """GuidedScreen should have _go_vibe method."""
        from localcode_tui.screens.guided import GuidedScreen
        assert hasattr(GuidedScreen, '_go_vibe')

    def test_project_command_goes_to_vibe(self):
        """/project should route to VibeLoopScreen."""
        import inspect
        from localcode_tui.screens.workspace import WorkspaceScreen
        source = inspect.getsource(WorkspaceScreen._handle_slash_command)
        assert "VibeLoopScreen" in source

    def test_project_in_slash_commands(self):
        """WorkspaceScreen SLASH_COMMANDS should include /project."""
        from localcode_tui.screens.workspace import SLASH_COMMANDS
        commands = [cmd for cmd, _ in SLASH_COMMANDS]
        assert "/project" in commands
