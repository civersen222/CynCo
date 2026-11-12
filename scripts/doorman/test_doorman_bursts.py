"""The doorman writes down each wake burst it starts, with what caused it, so the watcher can
match a box's wake to a knock or a scheduled job (docs/decisions/2026-11-11-metasystem-design.md, slice 1)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import doorman  # noqa: E402
import journal_bursts  # noqa: E402
from test_doorman import Harness  # noqa: E402

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "2026-11-11")
MACS = {"6C:6E:07:2D:AA:00": "main", "D8:43:AE:96:AE:8B": "image"}
COMPANIONS = {"main": ["image"]}


def recording(h):
    seen = []
    h.d.record = seen.append
    return seen


def test_a_knock_records_one_burst_for_the_target_and_one_for_its_companion():
    h = Harness()
    seen = recording(h)
    h.d.knock("main")
    assert [(r["target"], r["cause"]) for r in seen] == [("main", "knock"), ("image", "with:main")]
    assert seen[0]["at"] == 1000.0 and seen[0]["forAt"] is None


def test_a_second_knock_during_the_burst_records_nothing():
    h = Harness()
    seen = recording(h)
    h.d.knock("main")
    h.run_until(1020.0)
    h.d.knock("main")
    assert len(seen) == 2  # main and its companion, once


def test_a_scheduled_fire_records_the_time_it_was_scheduled_for():
    h = Harness()
    seen = recording(h)
    h.d.set_schedule("main", [5000.0])
    h.run_until(5000.0)
    main = [r for r in seen if r["target"] == "main"]
    assert len(main) == 1
    assert main[0]["cause"] == "schedule"
    assert main[0]["forAt"] == 5000.0
    assert main[0]["at"] == 5000.0 - doorman.LEAD_S


def test_a_recorder_that_throws_does_not_stop_the_wake():
    h = Harness()

    def boom(rec):
        raise OSError("disk full")

    h.d.record = boom
    h.d.knock("main")
    assert h.sent, "the wake packet must still be sent"


def test_jsonl_recorder_appends_one_line_per_burst_and_trims(tmp_path):
    path = str(tmp_path / "bursts.jsonl")
    rec = doorman.jsonl_recorder(path, max_lines=10)
    for i in range(12):
        rec({"at": float(i), "target": "main", "cause": "knock", "forAt": None})
    with open(path, "r", encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    assert len(rows) <= 10
    assert rows[-1]["at"] == 11.0, "the newest burst is kept"
    assert rows[0]["at"] > 0.0, "the oldest are dropped"


def test_main_wires_the_recorder(tmp_path, monkeypatch):
    made = {}

    def fake_serve(bind, port, d, page_html=None):
        made["d"] = d

        class S:
            def serve_forever(self):
                return None

        return S()

    monkeypatch.setattr(doorman, "serve", fake_serve)
    bursts = str(tmp_path / "state" / "bursts.jsonl")
    rc = doorman.main([
        "--targets", os.path.join(HERE, "targets.example.json"), "--bind", "127.0.0.1",
        "--schedule-file", str(tmp_path / "state" / "schedule.json"), "--bursts-file", bursts,
    ])
    assert rc == 0
    made["d"].record({"at": 1.0, "target": "main", "cause": "knock", "forAt": None})
    assert os.path.exists(bursts)


def test_the_real_journal_of_2026_11_11_has_one_burst_before_the_night_and_none_during_it():
    with open(os.path.join(FIXTURE, "doorman-journal.txt"), "r", encoding="utf-8") as f:
        bursts = journal_bursts.parse(f.read().splitlines(), MACS, COMPANIONS)
    main = [b for b in bursts if b["target"] == "main"]
    iso = [journal_bursts.iso(b["at"]) for b in main]
    # The fixture opens at 09:00Z: the hourly digest's wakes at 09:11 and 10:11, then (F221) nothing until 19:12Z.
    assert iso[:3] == ["2026-11-11T09:11:08Z", "2026-11-11T10:11:09Z", "2026-11-11T19:12:00Z"]
    assert all(b["cause"] == "schedule" for b in main), "no GET /wake line that day: every burst was a scheduled one"
    assert [b["cause"] for b in bursts if b["target"] == "image"][0] == "with:main"


def test_the_journal_gives_the_same_bursts_with_lf_and_crlf_line_endings():
    # F231: a Windows checkout gives this fixture CRLF. Read in binary so the endings are exactly these.
    with open(os.path.join(FIXTURE, "doorman-journal.txt"), "rb") as f:
        text = f.read().decode("utf-8").replace("\r\n", "\n")
    lf = text.split("\n")
    crlf = [line + "\r" for line in lf]  # what splitting a CRLF file on "\n" leaves behind
    knock = [
        '2026-11-12T05:00:00+00:00 doorman sh[1]: 100.64.0.9 "GET /wake?target=main HTTP/1.1" 200 -',
        "2026-11-12T05:00:00+00:00 doorman sudo[2]:     root : PWD=/ ; USER=root ; COMMAND=/usr/sbin/etherwake -i enp1s0 6C:6E:07:2D:AA:00",
    ]
    want = journal_bursts.parse(lf + knock, MACS, COMPANIONS)
    assert len(want) > 4 and want[-1]["cause"] == "knock"
    assert journal_bursts.parse(crlf + [k + "\r" for k in knock], MACS, COMPANIONS) == want
    assert journal_bursts.parse([line + "\r\n" for line in lf + knock], MACS, COMPANIONS) == want  # lines as a file object yields them


def test_a_wake_request_in_the_journal_makes_the_burst_a_knock():
    lines = [
        '2026-11-12T05:00:00+00:00 doorman sh[1]: 100.64.0.9 "GET /wake?target=main HTTP/1.1" 200 -',
        "2026-11-12T05:00:00+00:00 doorman sudo[2]:     root : PWD=/ ; USER=root ; COMMAND=/usr/sbin/etherwake -i enp1s0 6C:6E:07:2D:AA:00",
        "2026-11-12T05:00:15+00:00 doorman sudo[3]:     root : PWD=/ ; USER=root ; COMMAND=/usr/sbin/etherwake -i enp1s0 6C:6E:07:2D:AA:00",
    ]
    bursts = journal_bursts.parse(lines, MACS)
    assert len(bursts) == 1 and bursts[0]["cause"] == "knock"
