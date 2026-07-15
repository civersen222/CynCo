from localcode_tui.widgets.diff_view import DiffView


def test_diff_view_renders_hunks():
    dv = DiffView()
    dv.set_diff("a.ts", "modify", [
        {"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2,
         "lines": [{"kind": "context", "text": "x"}, {"kind": "add", "text": "y"}, {"kind": "del", "text": "z"}]},
    ])
    text = dv.render_plain()
    assert "a.ts" in text
    assert "+y" in text
    assert "-z" in text


def test_diff_view_copy_text_round_trips():
    dv = DiffView()
    dv.set_diff("a.ts", "create", [{"oldStart": 0, "oldLines": 0, "newStart": 1, "newLines": 1,
                                    "lines": [{"kind": "add", "text": "hello"}]}])
    assert "hello" in dv.copy_text()
