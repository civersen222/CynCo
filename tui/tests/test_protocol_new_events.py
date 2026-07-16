"""Parse tests for the events wired in the 2026-07-16 audit hardening."""
import json
from localcode_tui.protocol import (
    parse_event, serialize_command,
    StreamThinkingEvent, AskRequestEvent, SnapshotTakenEvent,
    SnapshotRestoredEvent, GovernanceRecommendationEvent, AskAnswerCommand,
)


def test_parse_stream_thinking():
    e = parse_event('{"type": "stream.thinking", "text": "hmm"}')
    assert isinstance(e, StreamThinkingEvent)
    assert e.text == "hmm"


def test_parse_ask_request():
    e = parse_event('{"type": "ask.request", "requestId": "r1", "question": "Which DB?", "options": ["sqlite", "postgres"]}')
    assert isinstance(e, AskRequestEvent)
    assert e.request_id == "r1"
    assert e.question == "Which DB?"
    assert e.options == ["sqlite", "postgres"]


def test_parse_ask_request_without_options():
    e = parse_event('{"type": "ask.request", "requestId": "r2", "question": "Name?"}')
    assert isinstance(e, AskRequestEvent)
    assert e.options == []


def test_parse_snapshot_taken():
    e = parse_event('{"type": "snapshot.taken", "hash": "abc123", "prevHash": "def456", "filesChanged": 3, "additions": 10, "deletions": 2}')
    assert isinstance(e, SnapshotTakenEvent)
    assert e.prev_hash == "def456"
    assert e.files_changed == 3


def test_parse_snapshot_restored():
    e = parse_event('{"type": "snapshot.restored", "hash": "def456", "filesChanged": 3}')
    assert isinstance(e, SnapshotRestoredEvent)
    assert e.files_changed == 3


def test_parse_governance_recommendation():
    e = parse_event(json.dumps({
        "type": "governance.recommendation", "requestId": "q1", "severity": "warning",
        "signal": "W3", "title": "High error trend", "description": "CUSUM alarm on taskError.",
        "action": {"contextAction": "compact"}, "autoApplyAfterMs": 60000,
    }))
    assert isinstance(e, GovernanceRecommendationEvent)
    assert e.signal == "W3"
    assert e.action == {"contextAction": "compact"}
    assert e.auto_apply_after_ms == 60000


def test_serialize_ask_answer():
    out = json.loads(serialize_command(AskAnswerCommand(request_id="r1", answer="sqlite")))
    assert out == {"type": "ask.answer", "requestId": "r1", "answer": "sqlite"}
