"""The proof on the doorman's side: the real records of 2026-11-11, replayed, must put the night of F221
and the embedding outage of F215 on the note. `fixtures/2026-11-11/README.md` says where each record
came from and which times are reconstructed. The same replay through real processes, with the main PC's
reporter doing the sending, is engine/__tests__/power/replay20261111.test.ts."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import journal_bursts  # noqa: E402
import watcher  # noqa: E402
import watchmodel as wm  # noqa: E402
import watchnote  # noqa: E402
from watchstore import Store, iso, parse_iso  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "2026-11-11")
OFF = -420  # the owner's zone that day (UTC-7)
READ_AT = parse_iso("2026-11-12T15:00:00Z")  # "the next morning"

F221_WAKES = [
    "2026-11-11T10:46:46Z", "2026-11-11T11:16:46Z", "2026-11-11T11:47:54Z", "2026-11-11T12:18:02Z",
    "2026-11-11T12:47:55Z", "2026-11-11T13:17:55Z", "2026-11-11T14:02:55Z", "2026-11-11T14:46:47Z",
]


def replayed(tmp_path):
    store = Store(str(tmp_path / "watch.db"))
    with open(os.path.join(FIXTURE, "pushes.json"), "r", encoding="utf-8") as f:
        body = json.load(f)
    got = store.add(body["box"], body["records"], parse_iso(body["sentAt"]))
    assert got == {"stored": 26, "duplicates": 0, "rejected": 0}
    # The doorman's own record of the day, from its journal, through the file the watcher reads.
    with open(os.path.join(FIXTURE, "targets.json"), "r", encoding="utf-8") as f:
        macs, companions = journal_bursts.maps_from_targets(json.load(f))
    with open(os.path.join(FIXTURE, "doorman-journal.txt"), "r", encoding="utf-8") as f:
        bursts = journal_bursts.parse(f.read().splitlines(), macs, companions)
    path = tmp_path / "bursts.jsonl"
    path.write_text("".join(json.dumps(b) + "\n" for b in bursts), encoding="utf-8")
    assert watcher.ingest_doorman_files(store, str(path), None, READ_AT) == len(bursts)
    return store


def test_the_night_of_f221_is_on_the_next_mornings_note_without_anyone_looking_for_it(tmp_path):
    report = wm.day_report(replayed(tmp_path), "2026-11-11", READ_AT, OFF)
    wakes = [f for f in report["findings"] if f["kind"] == "wake.unexplained"]
    assert len(wakes) == 1
    f = wakes[0]
    assert f["box"] == "main" and [iso(m) for m in f["marks"]] == F221_WAKES
    assert "8 times" in f["seen"] and "Power Button" in f["seen"]
    assert "asleep 10 min to 25 min each time" in f["seen"]
    # The ninth wake of that night was the doorman's own, for the hourly job: matched, and named as the contrast.
    all_wakes = report["boxes"][0]["wakes"]
    assert len(all_wakes) == 9
    assert iso(all_wakes[0]["at"]) == "2026-11-11T10:11:17Z" and all_wakes[0]["explained"]["by"] == "schedule"
    assert "2026-11-11T10:11:09Z" in all_wakes[0]["explained"]["text"]
    assert "10:11Z" in f["expected"]


def test_the_embedding_outage_is_on_the_note_with_what_is_known_of_its_times(tmp_path):
    report = wm.day_report(replayed(tmp_path), "2026-11-11", READ_AT, OFF)
    down = [f for f in report["findings"] if f["kind"] == "service.down"]
    assert len(down) == 1
    f = down[0]
    assert f["id"] == "service.down:main:embed:2026-11-11T15:06:00Z"
    assert (iso(f["from"]), iso(f["to"]), f["open"]) == ("2026-11-11T15:06:00Z", "2026-11-11T17:18:12Z", False)
    assert "2.2 h" in f["seen"]
    assert "the engine's own log line" in f["seen"], "the note says how the start was timed"
    assert "started by hand at 10:18:12 local" in f["seen"], "and that the end is from the failure log, not from a reading"
    assert "the engine" in f["expected"]


def test_nothing_else_is_flagged_and_the_measure_reads_about_0_4(tmp_path):
    report = wm.day_report(replayed(tmp_path), "2026-11-11", READ_AT, OFF)
    assert sorted(f["kind"] for f in report["findings"]) == ["service.down", "wake.unexplained"]
    assert report["learning"] == []
    m = report["boxes"][0]["measures"]["asleepWhenCould"]
    assert round(m["asleepS"] / 60) == 113, "nine sleeps, 113 minutes"
    assert 0.35 <= m["value"] <= 0.45
    states = [s["state"] for s in report["boxes"][0]["segments"]]
    assert states.count("asleep") == 9 and states.count("off") == 3
    assert "silent" not in states, "no sample exists for that day, so nothing is called silent"


def test_the_page_for_that_day_shows_both_and_marks_the_eight_wakes(tmp_path):
    page = watchnote.render(wm.day_report(replayed(tmp_path), "2026-11-11", READ_AT, OFF))
    assert "Flagged (2)" in page
    assert "Wakes with nothing behind them" in page and "A service was not answering" in page
    assert page.count('class="mark"') == 9, "eight wakes and the start of the outage"
    for at in F221_WAKES:
        assert "(%s)" % at in page
    assert page.count('class="woke"') == 1
    assert "embed NOT answering" in page and "down 2.2 h" in page
    assert "<script" not in page and "<form" not in page


def test_the_day_before_and_the_day_after_are_quiet(tmp_path):
    store = replayed(tmp_path)
    for day in ("2026-11-10", "2026-11-12"):
        assert wm.day_report(store, day, READ_AT, OFF)["findings"] == []
