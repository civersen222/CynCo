"""The note: one page that takes no input, escapes what the boxes sent, and marks what was flagged."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import watchmodel as wm  # noqa: E402
import watchnote  # noqa: E402
from watchstore import Store, iso, parse_iso  # noqa: E402

P = parse_iso
LATER = P("2026-11-13T12:00:00Z")
OFF = -420


def report(store, day="2026-11-11", now=LATER):
    return wm.day_report(store, day, now, OFF)


def night(store):
    store.add("main", [
        {"t": "event", "at": "2026-11-11T10:10:16Z", "kind": "power.sleep", "key": "s0", "data": {"reason": "idle"}},
        {"t": "event", "at": "2026-11-11T10:11:17Z", "kind": "power.wake", "key": "w0", "data": {"sleepAt": "2026-11-11T10:10:16Z", "source": "Device -USB4(TM) Host Router (Microsoft)"}},
        {"t": "event", "at": "2026-11-11T10:31:40Z", "kind": "power.sleep", "key": "s1", "data": {"reason": "idle"}},
        {"t": "event", "at": "2026-11-11T10:46:46Z", "kind": "power.wake", "key": "w1", "data": {"sleepAt": "2026-11-11T10:31:40Z", "source": "Power Button"}},
    ], P("2026-11-11T15:00:00Z"))
    store.add("doorman", [{"t": "event", "at": "2026-11-11T10:11:09Z", "kind": "doorman.burst", "key": "b", "data": {"target": "main", "cause": "schedule", "forAt": None}}], P("2026-11-11T10:11:10Z"))


def test_an_empty_store_renders_a_page_that_says_nothing_has_been_pushed(tmp_path):
    page = watchnote.render(report(Store(str(tmp_path / "w.db"))))
    assert "No box has pushed anything yet" in page
    assert "Flagged (0)" in page and "Nothing was flagged for this day." in page


def test_the_page_takes_no_input_and_fetches_nothing(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    night(store)
    page = watchnote.render(report(store))
    for tag in ("<script", "<form", "<input", "<button", "<textarea", "<select", "<iframe", "<link", "<img"):
        assert tag not in page.lower(), tag
    assert not re.search(r"\bon[a-z]+\s*=", page), "no inline event handlers"
    urls = re.findall(r"""(?:src|href|action)\s*=\s*["']([^"']*)""", page)
    assert urls and all(u == "/" or re.fullmatch(r"/day/\d{4}-\d{2}-\d{2}", u) for u in urls), urls
    assert "url(" not in page and "@import" not in page, "no font or stylesheet from anywhere"
    assert "http://" not in page and "https://" not in page


def test_a_finding_has_its_four_lines_and_the_flagged_time_is_marked_on_the_chart(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    night(store)
    page = watchnote.render(report(store))
    for heading in ("What was seen", "What was expected", "What the watcher believes it means", "Suggested"):
        assert heading in page
    assert "Wakes with nothing behind them" in page and "03:46Z" not in page
    assert page.count('class="mark"') == 1, "one unexplained wake, one mark"
    assert "flagged 03:46 (2026-11-11T10:46:46Z)" in page
    assert page.count('class="woke"') == 1, "the wake the doorman caused is drawn, and is not a flag"
    assert "a scheduled job&#x27;s wake at 2026-11-11T10:11:09Z" in page
    assert 'class="asleep"' in page and 'class="awake"' in page


def test_what_a_box_sent_is_escaped_everywhere(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    evil = '<script>alert(1)</script>"><b>'
    t = P("2026-11-11T16:00:00Z")
    samples = []
    for i in range(30):
        samples.append({"t": "sample", "at": iso(t + i * 60), "idleS": 9000,
                        "gpus": [{"i": 0, "name": evil, "tempC": 40 + (i % 3), "utilPct": 1, "procs": [evil]}],
                        "models": [{"server": evil, "name": evil, "busy": False}],
                        "holder": {"unit": "app:" + evil, "detail": evil},
                        "services": [{"name": evil, "up": False, "wanted": True, "by": evil}]})
    store.add("main", samples + [
        {"t": "event", "at": iso(t), "kind": "power.wake", "key": "w", "data": {"sleepAt": iso(t - 600), "source": evil}},
        {"t": "event", "at": iso(t + 60), "kind": "job.run", "key": "j", "data": {"mission": evil, "triggerId": evil, "ok": False, "summary": evil}},
        {"t": "event", "at": iso(t + 90), "kind": "engine.loop_blocked", "key": "l", "data": {"seconds": evil, "until": evil}},
    ], t + 2000)
    store.add("doorman", [{"t": "event", "at": iso(t - 5), "kind": "doorman.burst", "key": "b", "data": {"target": "main", "cause": evil, "forAt": None}}], t)
    page = watchnote.render(report(store))
    assert "<script" not in page and "<b>" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    kinds = [f["kind"] for f in report(store)["findings"]]
    assert "service.down" in kinds and "model.unused" in kinds


def test_a_finding_that_is_still_true_comes_first(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    night(store)
    t = P("2026-11-11T16:00:00Z")
    down = [{"t": "sample", "at": iso(t + i * 60), "services": [{"name": "embed", "up": False, "wanted": True, "by": "the engine"}]} for i in range(10)]
    store.add("main", down, t + 600)
    now = t + 9 * 60 + 20
    r = wm.day_report(store, "2026-11-11", now, OFF)
    # The box woke at 10:46Z and was not heard from until 16:00Z: that silence is a finding of its own.
    assert [f["kind"] for f in r["findings"]] == ["service.down", "wake.unexplained", "box.silent"], "what is still true rises above what is over"
    page = watchnote.render(r)
    assert page.index("A service was not answering") < page.index("Wakes with nothing behind them")
    assert "still true" in page
    assert "is not built yet" in page, "the page does not claim an answer path that does not exist"


def test_the_status_line_says_silent_while_a_box_has_not_explained_itself(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    t = P("2026-11-11T16:00:00Z")
    store.add("main", [{"t": "sample", "at": iso(t + i * 60), "idleS": 1000} for i in range(10)], t + 540)
    page = watchnote.render(wm.day_report(store, "2026-11-11", t + 3600, OFF))
    assert "main: silent, with no sleep or shutdown reported yet since 09:09, last heard 51 min ago" in page
    assert "Flagged (0)" in page


def test_a_young_series_is_listed_as_still_learning(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    t = P("2026-11-11T16:00:00Z")
    store.add("main", [{"t": "sample", "at": iso(t + i * 60), "gpus": [{"i": 0, "name": "RTX 5090", "tempC": 39, "utilPct": 0, "procs": []}]} for i in range(120)], t + 7200)
    page = watchnote.render(report(store))
    assert "Still learning (1)" in page and "RTX 5090, idle temperature" in page and "needs 12 readings over 3 days" in page
    assert 'class="temp t0"' in page, "charted from its first reading"


def test_findings_json_has_the_pages_ids_and_iso_times(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    night(store)
    r = report(store)
    data = watchnote.findings_json(r)
    assert [f["id"] for f in data["findings"]] == [f["id"] for f in r["findings"]]
    f = data["findings"][0]
    assert f["marks"] == ["2026-11-11T10:46:46Z"] and f["from"] == "2026-11-11T10:46:46Z"
    assert data["boxes"][0]["box"] == "main"
