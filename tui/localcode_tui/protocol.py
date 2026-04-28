"""WebSocket protocol types matching the TypeScript engine protocol.

All messages are JSON objects with a 'type' discriminator field.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Optional
import json


# ─── Engine → TUI Events ──────────────────────────────────────

@dataclass
class SessionReadyEvent:
    type: str = "session.ready"
    model: str = ""
    context_length: int = 32768
    project_path: str = ""
    version: str = ""
    session_start_time: str = ""
    lsp_servers: list = field(default_factory=list)
    mcp_servers: list = field(default_factory=list)
    expertise: str = "advanced"


@dataclass
class SessionErrorEvent:
    type: str = "session.error"
    error: str = ""


@dataclass
class StreamTokenEvent:
    type: str = "stream.token"
    text: str = ""
    message_id: Optional[str] = None


@dataclass
class MessageCompleteEvent:
    type: str = "message.complete"
    message_id: str = ""
    stop_reason: Optional[str] = None
    usage: Optional[dict] = None


@dataclass
class ToolStartEvent:
    type: str = "tool.start"
    tool_id: str = ""
    tool_name: str = ""
    input: dict = field(default_factory=dict)


@dataclass
class ToolProgressEvent:
    type: str = "tool.progress"
    tool_id: str = ""
    output: str = ""


@dataclass
class ToolCompleteEvent:
    type: str = "tool.complete"
    tool_id: str = ""
    result: Any = None
    is_error: bool = False


@dataclass
class FileChangeEvent:
    type: str = "file.change"
    path: str = ""
    change_type: str = "modify"
    diff: Optional[str] = None


@dataclass
class ApprovalRequestEvent:
    type: str = "approval.request"
    request_id: str = ""
    tool_name: str = ""
    description: str = ""
    risk: str = "low"


@dataclass
class ContextStatusEvent:
    type: str = "context.status"
    utilization: float = 0.0
    estimated_tokens: int = 0
    context_length: int = 32768
    action: str = "proceed"


@dataclass
class ContextWarningEvent:
    type: str = "context.warning"
    utilization: float = 0.0
    message: str = ""


@dataclass
class MemoryRecalledEvent:
    type: str = "memory.recalled"
    memories: list = field(default_factory=list)
    session_context: dict | None = None


@dataclass
class WorkflowStatusEvent:
    type: str = "workflow.status"
    active: bool = False
    workflow: Optional[str] = None
    phase: Optional[str] = None
    display_name: Optional[str] = None


@dataclass
class GovernanceStatusEvent:
    type: str = "governance.status"
    health: str = "healthy"
    s3s4_balance: str = "balanced"
    tool_success_rate: float = 1.0
    stuck_turns: int = 0
    suggestion: Optional[str] = None


@dataclass
class SummaryInjectedEvent:
    type: str = "summary.injected"
    tools_used: list = field(default_factory=list)


@dataclass
class MemoryWrittenEvent:
    type: str = "memory.written"
    kind: str = "handoff"
    summary: str = ""


@dataclass
class ConfigCurrentEvent:
    type: str = "config.current"
    config: dict = field(default_factory=dict)


@dataclass
class ConfigUpdatedEvent:
    type: str = "config.updated"
    applied: dict = field(default_factory=dict)
    errors: list | None = None


@dataclass
class ProfileListEvent:
    type: str = "profile.list"
    profiles: list = field(default_factory=list)
    parse_errors: list = field(default_factory=list)


@dataclass
class ProfileValidationEvent:
    type: str = "profile.validation"
    ok: bool = True
    errors: list = field(default_factory=list)


@dataclass
class ProfileWrittenEvent:
    type: str = "profile.written"
    name: str = ""
    path: str = ""


@dataclass
class ToolsListEvent:
    type: str = "tools.list"
    tools: list = field(default_factory=list)


@dataclass
class WizardResponseEvent:
    type: str = "wizard.response"
    request_id: str = ""
    text: str = ""
    error: str | None = None


@dataclass
class WebSearchResultEvent:
    type: str = "web.search.result"
    request_id: str = ""
    results: str = ""


@dataclass
class VibeStateChangedEvent:
    type: str = "vibe.state_changed"
    from_state: str = "idle"
    to: str = "idle"


@dataclass
class VibeConfidenceUpdateEvent:
    type: str = "vibe.confidence_update"
    confidence: dict = field(default_factory=dict)
    overall: float = 0.0
    reason: str = ""


@dataclass
class VibeTaskCompleteEvent:
    type: str = "vibe.task_complete"
    title: str = ""
    analogy: str = ""
    files_changed: list = field(default_factory=list)
    suggestion: str = ""
    preview_path: Optional[str] = None


@dataclass
class VibeEscalationEvent:
    type: str = "vibe.escalation"
    problem: str = ""
    tried: list = field(default_factory=list)
    proposal: str = ""
    request_id: str = ""


@dataclass
class VibeProjectScannedEvent:
    type: str = "vibe.project_scanned"
    summary: str = ""
    file_count: int = 0
    languages: list = field(default_factory=list)


@dataclass
class VibeQuestionEvent:
    type: str = "vibe.question"
    question_id: str = ""
    text: str = ""
    options: list = field(default_factory=list)


# ─── TUI → Engine Commands ─────────────────────────────────────

@dataclass
class UserMessageCommand:
    type: str = "user.message"
    text: str = ""


@dataclass
class ApprovalResponseCommand:
    type: str = "approval.response"
    request_id: str = ""
    approved: bool = False


@dataclass
class SlashCommandMsg:
    type: str = "command"
    command: str = ""
    args: Optional[str] = None


@dataclass
class AbortCommand:
    type: str = "abort"


@dataclass
class FileOpenCommand:
    type: str = "file.open"
    path: str = ""


@dataclass
class SessionEndCommand:
    type: str = "session.end"


@dataclass
class VibeStartCommand:
    type: str = "vibe.start"
    mode: str = "new"
    description: str = ""


@dataclass
class VibeAnswerCommand:
    type: str = "vibe.answer"
    question_id: str = ""
    answer: str = ""


@dataclass
class VibeActionCommand:
    type: str = "vibe.action"
    action: str = ""
    text: str = ""


@dataclass
class VibeEscalationResponseCommand:
    type: str = "vibe.escalation_response"
    request_id: str = ""
    action: str = ""


# ─── Parser ────────────────────────────────────────────────────

EVENT_TYPES = {
    "session.ready": SessionReadyEvent,
    "session.error": SessionErrorEvent,
    "stream.token": StreamTokenEvent,
    "message.complete": MessageCompleteEvent,
    "tool.start": ToolStartEvent,
    "tool.progress": ToolProgressEvent,
    "tool.complete": ToolCompleteEvent,
    "file.change": FileChangeEvent,
    "approval.request": ApprovalRequestEvent,
    "context.status": ContextStatusEvent,
    "context.warning": ContextWarningEvent,
    "memory.recalled": MemoryRecalledEvent,
    "memory.written": MemoryWrittenEvent,
    "workflow.status": WorkflowStatusEvent,
    "governance.status": GovernanceStatusEvent,
    "summary.injected": SummaryInjectedEvent,
    "config.current": ConfigCurrentEvent,
    "config.updated": ConfigUpdatedEvent,
    "profile.list": ProfileListEvent,
    "profile.validation": ProfileValidationEvent,
    "profile.written": ProfileWrittenEvent,
    "tools.list": ToolsListEvent,
    "wizard.response": WizardResponseEvent,
    "web.search.result": WebSearchResultEvent,
    "vibe.state_changed": VibeStateChangedEvent,
    "vibe.confidence_update": VibeConfidenceUpdateEvent,
    "vibe.task_complete": VibeTaskCompleteEvent,
    "vibe.escalation": VibeEscalationEvent,
    "vibe.project_scanned": VibeProjectScannedEvent,
    "vibe.question": VibeQuestionEvent,
}


def parse_event(data: str | dict) -> Any:
    """Parse a JSON event from the engine into a typed dataclass."""
    if isinstance(data, str):
        data = json.loads(data)
    event_type = data.get("type", "")
    cls = EVENT_TYPES.get(event_type)
    if cls is None:
        return data  # Return raw dict for unknown types
    # Map camelCase JSON keys to snake_case dataclass fields
    kwargs = {}
    for key, value in data.items():
        snake_key = _camel_to_snake(key)
        if snake_key in {f.name for f in cls.__dataclass_fields__.values()}:
            kwargs[snake_key] = value
    # Deep-convert sessionContext nested keys for MemoryRecalledEvent
    if cls is MemoryRecalledEvent and 'session_context' in kwargs and kwargs['session_context'] is not None:
        sc = kwargs['session_context']
        kwargs['session_context'] = {
            _camel_to_snake(k): v for k, v in sc.items()
        }
        # Also convert nested open_threads list items
        if 'open_threads' in kwargs['session_context']:
            kwargs['session_context']['open_threads'] = [
                {_camel_to_snake(k): v for k, v in t.items()}
                for t in kwargs['session_context']['open_threads']
            ]
    return cls(**kwargs)


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    import re
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()


def serialize_command(command) -> str:
    """Serialize a command dataclass to JSON string."""
    from dataclasses import asdict
    d = asdict(command)
    # Convert snake_case back to camelCase for the engine
    return json.dumps({_snake_to_camel(k): v for k, v in d.items()})


def _snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase."""
    components = name.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])
