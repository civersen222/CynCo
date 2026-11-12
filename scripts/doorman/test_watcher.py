"""The watcher's service: what it accepts, what it refuses, and what it reads of the doorman's own files.
Every server here listens on 127.0.0.1 on a port the OS chooses."""
import json
import os
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import watcher  # noqa: E402
from watchstore import Store, iso, parse_iso  # noqa: E402

NOW = parse_iso("2026-11-11T18:00:00Z")


@pytest.fixture
def running(tmp_path):
    store = Store(str(tmp_path / "watch.db"))
    srv = watcher.serve("127.0.0.1", 0, store, now=lambda: NOW, tz_offset_min=-420)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield store, "http://127.0.0.1:%d" % srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


def call(url, body=None, method=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        return err.code, err.read(), err.headers.get("Content-Type", "")


def push(base, records, box="main"):
    return call(base + "/push", {"v": 1, "box": box, "sentAt": iso(NOW), "records": records})


def test_a_push_is_stored_and_a_repeat_of_it_is_counted_as_already_there(running):
    store, base = running
    records = [{"t": "sample", "at": iso(NOW - 60), "idleS": 4}, {"t": "event", "at": iso(NOW - 30), "kind": "power.wake", "key": "w1", "data": {"source": "x"}}]
    code, body, _ = push(base, records)
    assert code == 200 and json.loads(body) == {"ok": True, "stored": 2, "duplicates": 0, "rejected": 0}
    code, body, _ = push(base, records)
    assert json.loads(body) == {"ok": True, "stored": 0, "duplicates": 2, "rejected": 0}
    assert store.last_seen("main") == NOW, "arrival is stamped with the doorman's clock"


def test_what_is_not_a_push_is_refused_without_a_crash(running):
    store, base = running
    assert call(base + "/push", raw=b"{not json")[0] == 400
    assert call(base + "/push", {"box": "main"})[0] == 400  # no records
    assert call(base + "/push", {"box": "main", "records": "x"})[0] == 400
    assert call(base + "/push", [1, 2])[0] == 400
    assert push(base, [{"t": "sample", "at": iso(NOW)}], box="<b>x</b>")[0] == 400
    assert push(base, [{"t": "sample", "at": iso(NOW)}] * 501)[0] == 400
    assert call(base + "/push", raw=b"x" * (watcher.MAX_BODY_BYTES + 1))[0] == 413
    assert call(base + "/push")[0] == 405
    assert call(base + "/elsewhere", {"a": 1})[0] == 404
    assert call(base + "/elsewhere")[0] == 404
    code, body, _ = push(base, [{"t": "sample", "at": "never"}, {"t": "sample", "at": iso(NOW)}])
    assert code == 200 and json.loads(body)["rejected"] == 1
    assert store.boxes() == ["main"], "nothing a refused request carried was stored"


def test_the_pages_answer_and_a_day_that_is_not_a_day_is_404(running):
    _, base = running
    code, body, ctype = call(base + "/")
    assert code == 200 and ctype.startswith("text/html") and b"2026-11-11" in body
    assert call(base + "/day/2026-11-10")[0] == 200
    assert call(base + "/day/2026-13-40")[0] == 404
    assert call(base + "/day/../../etc/passwd")[0] == 404
    code, body, ctype = call(base + "/findings.json?day=2026-11-11")
    assert code == 200 and ctype == "application/json" and json.loads(body)["day"] == "2026-11-11"
    assert call(base + "/findings.json?day=nope")[0] == 404
    assert json.loads(call(base + "/healthz")[1]) == {"ok": True}


def test_the_page_and_the_data_carry_the_same_findings(running):
    _, base = running
    night = [
        {"t": "event", "at": "2026-11-11T10:31:40Z", "kind": "power.sleep", "key": "s", "data": {"reason": "idle"}},
        {"t": "event", "at": "2026-11-11T10:46:46Z", "kind": "power.wake", "key": "w", "data": {"sleepAt": "2026-11-11T10:31:40Z", "source": "Power Button"}},
    ]
    assert push(base, night)[0] == 200
    data = json.loads(call(base + "/findings.json?day=2026-11-11")[1])
    assert [f["id"] for f in data["findings"]] == ["wake.unexplained:main:2026-11-11"]
    assert data["findings"][0]["marks"] == ["2026-11-11T10:46:46Z"]
    page = call(base + "/day/2026-11-11")[1].decode("utf-8")
    assert 'id="wake.unexplained:main:2026-11-11"' in page


def test_main_refuses_a_wildcard_address(tmp_path, capsys):
    for bind in ("0.0.0.0", "::"):
        assert watcher.main(["--bind", bind, "--db", str(tmp_path / "w.db")]) == 2
    assert "wildcard" in capsys.readouterr().err
    assert not (tmp_path / "w.db").exists(), "refused before anything is created"


def burst_line(at, target="main", cause="schedule"):
    return json.dumps({"at": at, "target": target, "cause": cause, "forAt": None}) + "\n"


def test_the_doormans_burst_journal_is_read_once_and_only_whole_lines(tmp_path):
    store = Store(str(tmp_path / "watch.db"))
    bursts = tmp_path / "bursts.jsonl"
    t = parse_iso("2026-11-11T10:11:09Z")
    bursts.write_text(burst_line(t) + burst_line(t + 1, target="image", cause="with:main") + '{"at": 99', encoding="utf-8")
    assert watcher.ingest_doorman_files(store, str(bursts), None, NOW) == 2
    assert watcher.ingest_doorman_files(store, str(bursts), None, NOW) == 0, "a second look reads nothing again"
    with open(bursts, "a", encoding="utf-8") as f:
        f.write('9.0, "target": "main", "cause": "knock", "forAt": null}\n' + "not json at all\n" + burst_line(t + 7200, cause="knock"))
    assert watcher.ingest_doorman_files(store, str(bursts), None, NOW) == 2, "the torn line is whole now; the foreign line is skipped"
    got = store.events(0, NOW + 1, box="doorman", kinds=["doorman.burst"])
    assert [(e["data"]["target"], e["data"]["cause"]) for e in got] == [("main", "knock"), ("main", "schedule"), ("image", "with:main"), ("main", "knock")]


def test_a_burst_journal_the_doorman_trimmed_is_read_again_and_stores_nothing_twice(tmp_path):
    store = Store(str(tmp_path / "watch.db"))
    bursts = tmp_path / "bursts.jsonl"
    t = parse_iso("2026-11-11T10:11:09Z")
    bursts.write_text("".join(burst_line(t + i * 3600) for i in range(6)), encoding="utf-8")
    assert watcher.ingest_doorman_files(store, str(bursts), None, NOW) == 6
    bursts.write_text("".join(burst_line(t + i * 3600) for i in range(4, 7)), encoding="utf-8")  # the newest half, plus one
    assert watcher.ingest_doorman_files(store, str(bursts), None, NOW) == 1
    assert len(store.events(0, NOW + 1, box="doorman")) == 7


def test_the_schedule_is_recorded_when_it_changes_and_a_missing_file_is_nothing(tmp_path):
    store = Store(str(tmp_path / "watch.db"))
    sched = tmp_path / "schedule.json"
    assert watcher.ingest_doorman_files(store, str(tmp_path / "none.jsonl"), str(sched), NOW) == 0
    sched.write_text(json.dumps({"main": [1794510900.0], "image": []}), encoding="utf-8")
    assert watcher.ingest_doorman_files(store, None, str(sched), NOW) == 1
    assert watcher.ingest_doorman_files(store, None, str(sched), NOW) == 0
    got = store.events(0, NOW * 2, box="doorman", kinds=["doorman.schedule"])
    assert got[0]["data"]["targets"]["main"] == [1794510900.0]
    sched.write_text("{torn", encoding="utf-8")
    os.utime(sched, (NOW, NOW + 50))
    assert watcher.ingest_doorman_files(store, None, str(sched), NOW) == 0, "a half-written file is read at the next look"
