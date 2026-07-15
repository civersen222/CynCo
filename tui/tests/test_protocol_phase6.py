from localcode_tui.protocol import parse_event, FileDiffEvent, PROTOCOL_VERSION, protocol_mismatch_warning


def test_file_diff_parses_with_hunks():
    ev = parse_event({"type": "file.diff", "path": "a.ts", "changeType": "modify",
                      "hunks": [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2,
                                 "lines": [{"kind": "add", "text": "y"}]}]})
    assert isinstance(ev, FileDiffEvent)
    assert ev.change_type == "modify"
    assert ev.hunks[0]["lines"][0]["kind"] == "add"


def test_session_ready_carries_protocol_version():
    ev = parse_event({"type": "session.ready", "model": "m", "protocolVersion": PROTOCOL_VERSION})
    assert ev.protocol_version == PROTOCOL_VERSION


def test_mismatch_warning():
    assert protocol_mismatch_warning(PROTOCOL_VERSION) is None
    assert protocol_mismatch_warning(PROTOCOL_VERSION + 1) is not None
