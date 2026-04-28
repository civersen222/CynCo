"""Tests for localcode_tui.protocol module."""
import json
import pytest
from localcode_tui.protocol import (
    parse_event,
    serialize_command,
    _camel_to_snake,
    _snake_to_camel,
    SessionReadyEvent,
    SessionErrorEvent,
    StreamTokenEvent,
    MessageCompleteEvent,
    ToolStartEvent,
    ToolProgressEvent,
    ToolCompleteEvent,
    FileChangeEvent,
    ApprovalRequestEvent,
    ContextStatusEvent,
    ContextWarningEvent,
    MemoryRecalledEvent,
    MemoryWrittenEvent,
    UserMessageCommand,
    ApprovalResponseCommand,
    SlashCommandMsg,
    AbortCommand,
    FileOpenCommand,
    EVENT_TYPES,
)


class TestCamelToSnake:
    def test_simple(self):
        assert _camel_to_snake("camelCase") == "camel_case"

    def test_already_snake(self):
        assert _camel_to_snake("already_snake") == "already_snake"

    def test_single_word(self):
        assert _camel_to_snake("type") == "type"

    def test_multiple_humps(self):
        assert _camel_to_snake("contextLength") == "context_length"

    def test_consecutive_caps(self):
        assert _camel_to_snake("messageID") == "message_id"


class TestSnakeToCamel:
    def test_simple(self):
        assert _snake_to_camel("snake_case") == "snakeCase"

    def test_already_camel(self):
        assert _snake_to_camel("type") == "type"

    def test_multiple_underscores(self):
        assert _snake_to_camel("context_length") == "contextLength"

    def test_is_error(self):
        assert _snake_to_camel("is_error") == "isError"


class TestParseEvent:
    def test_parse_session_ready_from_string(self):
        data = json.dumps({"type": "session.ready", "model": "llama3", "contextLength": 8192})
        event = parse_event(data)
        assert isinstance(event, SessionReadyEvent)
        assert event.model == "llama3"
        assert event.context_length == 8192

    def test_parse_session_ready_from_dict(self):
        data = {"type": "session.ready", "model": "qwen2", "contextLength": 16384}
        event = parse_event(data)
        assert isinstance(event, SessionReadyEvent)
        assert event.model == "qwen2"

    def test_parse_session_error(self):
        event = parse_event({"type": "session.error", "error": "connection failed"})
        assert isinstance(event, SessionErrorEvent)
        assert event.error == "connection failed"

    def test_parse_stream_token(self):
        event = parse_event({"type": "stream.token", "text": "hello", "messageId": "m1"})
        assert isinstance(event, StreamTokenEvent)
        assert event.text == "hello"
        assert event.message_id == "m1"

    def test_parse_message_complete(self):
        event = parse_event({"type": "message.complete", "messageId": "m1", "stopReason": "end_turn"})
        assert isinstance(event, MessageCompleteEvent)
        assert event.message_id == "m1"
        assert event.stop_reason == "end_turn"

    def test_parse_tool_start(self):
        event = parse_event({"type": "tool.start", "toolId": "t1", "toolName": "Read", "input": {"path": "/foo"}})
        assert isinstance(event, ToolStartEvent)
        assert event.tool_id == "t1"
        assert event.tool_name == "Read"
        assert event.input == {"path": "/foo"}

    def test_parse_tool_complete(self):
        event = parse_event({"type": "tool.complete", "toolId": "t1", "result": "ok", "isError": False})
        assert isinstance(event, ToolCompleteEvent)
        assert event.tool_id == "t1"
        assert event.result == "ok"
        assert event.is_error is False

    def test_parse_file_change(self):
        event = parse_event({"type": "file.change", "path": "/src/foo.py", "changeType": "modify"})
        assert isinstance(event, FileChangeEvent)
        assert event.path == "/src/foo.py"
        assert event.change_type == "modify"

    def test_parse_approval_request(self):
        event = parse_event({"type": "approval.request", "requestId": "r1", "toolName": "Bash", "description": "run ls", "risk": "low"})
        assert isinstance(event, ApprovalRequestEvent)
        assert event.request_id == "r1"
        assert event.risk == "low"

    def test_parse_context_status(self):
        event = parse_event({"type": "context.status", "utilization": 0.5, "estimatedTokens": 16000, "contextLength": 32768, "action": "proceed"})
        assert isinstance(event, ContextStatusEvent)
        assert event.utilization == 0.5
        assert event.estimated_tokens == 16000

    def test_parse_context_warning(self):
        event = parse_event({"type": "context.warning", "utilization": 0.85, "message": "approaching limit"})
        assert isinstance(event, ContextWarningEvent)
        assert event.utilization == 0.85

    def test_parse_memory_recalled(self):
        event = parse_event({"type": "memory.recalled", "memories": [{"id": 1, "content": "test"}]})
        assert isinstance(event, MemoryRecalledEvent)
        assert len(event.memories) == 1

    def test_parse_unknown_type_returns_dict(self):
        data = {"type": "unknown.event", "foo": "bar"}
        result = parse_event(data)
        assert isinstance(result, dict)
        assert result["foo"] == "bar"

    def test_parse_with_defaults(self):
        event = parse_event({"type": "session.ready"})
        assert isinstance(event, SessionReadyEvent)
        assert event.model == ""
        assert event.context_length == 32768

    def test_all_event_types_covered(self):
        """Verify EVENT_TYPES maps all documented event types."""
        expected = {
            "session.ready", "session.error", "stream.token",
            "message.complete", "tool.start", "tool.progress",
            "tool.complete", "file.change", "approval.request",
            "context.status", "context.warning", "memory.recalled",
            "memory.written", "workflow.status", "governance.status",
            "summary.injected", "web.search.result",
            "config.current", "config.updated",
            "profile.list", "profile.validation", "profile.written",
            "tools.list",
            "wizard.response",
            "vibe.state_changed",
            "vibe.confidence_update",
            "vibe.task_complete",
            "vibe.escalation",
            "vibe.project_scanned",
            "vibe.question",
        }
        assert set(EVENT_TYPES.keys()) == expected


class TestSerializeCommand:
    def test_user_message(self):
        cmd = UserMessageCommand(text="hello world")
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "user.message"
        assert result["text"] == "hello world"

    def test_approval_response(self):
        cmd = ApprovalResponseCommand(request_id="r1", approved=True)
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "approval.response"
        assert result["requestId"] == "r1"
        assert result["approved"] is True

    def test_slash_command(self):
        cmd = SlashCommandMsg(command="compact", args="--force")
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "command"
        assert result["command"] == "compact"
        assert result["args"] == "--force"

    def test_abort_command(self):
        cmd = AbortCommand()
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "abort"

    def test_file_open_command(self):
        cmd = FileOpenCommand(path="/src/main.py")
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "file.open"
        assert result["path"] == "/src/main.py"

    def test_session_end_command(self):
        from localcode_tui.protocol import SessionEndCommand, serialize_command
        cmd = SessionEndCommand()
        result = json.loads(serialize_command(cmd))
        assert result["type"] == "session.end"

    def test_roundtrip_snake_to_camel(self):
        """snake_case fields should become camelCase in JSON output."""
        cmd = ApprovalResponseCommand(request_id="abc", approved=False)
        result = json.loads(serialize_command(cmd))
        assert "requestId" in result
        assert "request_id" not in result


class TestDataclassDefaults:
    def test_session_ready_defaults(self):
        e = SessionReadyEvent()
        assert e.type == "session.ready"
        assert e.model == ""
        assert e.context_length == 32768

    def test_tool_start_defaults(self):
        e = ToolStartEvent()
        assert e.input == {}

    def test_tool_complete_defaults(self):
        e = ToolCompleteEvent()
        assert e.is_error is False
        assert e.result is None

    def test_context_status_defaults(self):
        e = ContextStatusEvent()
        assert e.utilization == 0.0
        assert e.action == "proceed"


def test_summary_injected_event_parses():
    from localcode_tui.protocol import parse_event, SummaryInjectedEvent
    raw = '{"type": "summary.injected", "toolsUsed": ["Edit", "Bash"]}'
    event = parse_event(raw)
    assert isinstance(event, SummaryInjectedEvent)
    assert event.tools_used == ["Edit", "Bash"]


def test_summary_injected_event_empty_tools():
    from localcode_tui.protocol import parse_event, SummaryInjectedEvent
    raw = '{"type": "summary.injected", "toolsUsed": []}'
    event = parse_event(raw)
    assert isinstance(event, SummaryInjectedEvent)
    assert event.tools_used == []


def test_memory_recalled_with_session_context():
    from localcode_tui.protocol import parse_event, MemoryRecalledEvent
    raw = '{"type": "memory.recalled", "memories": [{"type": "WORKING_SOLUTION", "content": "Use intercept", "confidence": "high"}], "sessionContext": {"priorGoal": "fix bug", "priorStatus": "in_progress", "priorDate": "2d ago", "openThreads": [{"priority": "high", "description": "wire injection"}]}}'
    event = parse_event(raw)
    assert isinstance(event, MemoryRecalledEvent)
    assert len(event.memories) == 1
    assert event.session_context is not None
    assert event.session_context["prior_goal"] == "fix bug"
    assert len(event.session_context["open_threads"]) == 1


def test_memory_recalled_without_session_context():
    from localcode_tui.protocol import parse_event, MemoryRecalledEvent
    raw = '{"type": "memory.recalled", "memories": []}'
    event = parse_event(raw)
    assert isinstance(event, MemoryRecalledEvent)
    assert event.session_context is None


def test_memory_written_event_parses():
    from localcode_tui.protocol import parse_event, MemoryWrittenEvent
    raw = '{"type": "memory.written", "kind": "handoff", "summary": "Saved handoff: fix bug (in_progress)"}'
    event = parse_event(raw)
    assert isinstance(event, MemoryWrittenEvent)
    assert event.kind == "handoff"
    assert "fix bug" in event.summary


def test_config_current_event_parses():
    from localcode_tui.protocol import parse_event, ConfigCurrentEvent
    raw = '{"type": "config.current", "config": {"model": "qwen3:8b", "temperature": 0.7, "maxOutputTokens": 8192, "timeout": 300000, "baseUrl": "http://localhost:11434", "contextLength": 32768, "tier": "auto"}}'
    event = parse_event(raw)
    assert isinstance(event, ConfigCurrentEvent)
    assert event.config["model"] == "qwen3:8b"


def test_config_updated_event_parses():
    from localcode_tui.protocol import parse_event, ConfigUpdatedEvent
    raw = '{"type": "config.updated", "applied": {"temperature": 0.5}, "errors": [{"field": "bogus", "message": "Unknown"}]}'
    event = parse_event(raw)
    assert isinstance(event, ConfigUpdatedEvent)
    assert event.applied == {"temperature": 0.5}
    assert len(event.errors) == 1


def test_config_updated_no_errors():
    from localcode_tui.protocol import parse_event, ConfigUpdatedEvent
    raw = '{"type": "config.updated", "applied": {"temperature": 0.5}}'
    event = parse_event(raw)
    assert isinstance(event, ConfigUpdatedEvent)
    assert event.errors is None


def test_profile_list_event_parses():
    from localcode_tui.protocol import parse_event, ProfileListEvent
    raw = '{"type": "profile.list", "profiles": [{"name": "coding", "scope": "user", "active": true}], "parseErrors": []}'
    event = parse_event(raw)
    assert isinstance(event, ProfileListEvent)
    assert len(event.profiles) == 1
    assert event.profiles[0]["name"] == "coding"


def test_profile_validation_event_parses():
    from localcode_tui.protocol import parse_event, ProfileValidationEvent
    raw = '{"type": "profile.validation", "ok": false, "errors": ["Missing name"]}'
    event = parse_event(raw)
    assert isinstance(event, ProfileValidationEvent)
    assert event.ok is False
    assert len(event.errors) == 1


def test_profile_written_event_parses():
    from localcode_tui.protocol import parse_event, ProfileWrittenEvent
    raw = '{"type": "profile.written", "name": "coding", "path": "/home/user/.cynco/profiles/coding.yml"}'
    event = parse_event(raw)
    assert isinstance(event, ProfileWrittenEvent)
    assert event.name == "coding"


def test_session_ready_extended_fields():
    from localcode_tui.protocol import parse_event, SessionReadyEvent
    raw = '{"type": "session.ready", "model": "qwen3:8b", "contextLength": 32768, "projectPath": "/home/user/project", "version": "0.1.0", "sessionStartTime": "2026-04-17T10:45:24Z", "lspServers": [{"language": "typescript", "available": true}], "mcpServers": []}'
    event = parse_event(raw)
    assert isinstance(event, SessionReadyEvent)
    assert event.project_path == "/home/user/project"
    assert event.version == "0.1.0"
    assert event.session_start_time == "2026-04-17T10:45:24Z"
    assert len(event.lsp_servers) == 1
    assert event.lsp_servers[0]["language"] == "typescript"
    assert event.mcp_servers == []


def test_session_ready_expertise_field():
    from localcode_tui.protocol import parse_event, SessionReadyEvent
    raw = '{"type": "session.ready", "model": "qwen3:8b", "contextLength": 32768, "expertise": "beginner"}'
    event = parse_event(raw)
    assert isinstance(event, SessionReadyEvent)
    assert event.expertise == "beginner"
