"""The watcher's store: records keep the time they describe, and a repeated push stores nothing twice."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import watchstore  # noqa: E402

T = watchstore.parse_iso("2026-11-11T10:00:00Z")


def store(tmp_path):
    return watchstore.Store(str(tmp_path / "watch.db"))


def sample(at, **body):
    return {"t": "sample", "at": watchstore.iso(at), **body}


def event(at, kind, key=None, **data):
    r = {"t": "event", "at": watchstore.iso(at), "kind": kind, "data": data}
    if key:
        r["key"] = key
    return r


def test_parse_iso_reads_the_shapes_the_boxes_write():
    assert watchstore.parse_iso("2026-11-11T10:46:46.5898729Z") == pytest.approx(watchstore.parse_iso("2026-11-11T10:46:46Z") + 0.589872, abs=1e-5)
    assert watchstore.parse_iso("2026-11-11T03:46:46-07:00") == watchstore.parse_iso("2026-11-11T10:46:46Z")
    assert watchstore.parse_iso("2026-11-11T10:46:46") == watchstore.parse_iso("2026-11-11T10:46:46Z")
    assert watchstore.iso(watchstore.parse_iso("2026-11-11T10:46:46Z")) == "2026-11-11T10:46:46Z"
    for bad in ("yesterday", "", None, True, {"a": 1}):
        with pytest.raises(ValueError):
            watchstore.parse_iso(bad)


def test_a_repeated_push_stores_nothing_twice(tmp_path):
    s = store(tmp_path)
    records = [sample(T, idleS=5), event(T + 1, "power.wake", key="wake:1", source="Power Button")]
    assert s.add("main", records, T + 2) == {"stored": 2, "duplicates": 0, "rejected": 0}
    assert s.add("main", records, T + 30) == {"stored": 0, "duplicates": 2, "rejected": 0}
    assert len(s.samples("main", T - 1, T + 10)) == 1
    assert len(s.events(T - 1, T + 10)) == 1


def test_records_come_back_in_the_order_they_happened_not_the_order_they_arrived(tmp_path):
    s = store(tmp_path)
    s.add("main", [event(T + 600, "power.wake", key="w2"), sample(T + 120, idleS=1)], T + 700)
    s.add("main", [event(T, "power.sleep", key="s1"), sample(T + 60, idleS=2)], T + 9000)  # a backlog, hours late
    assert [e["key"] for e in s.events(T - 1, T + 1000)] == ["s1", "w2"]
    assert [x["idleS"] for x in s.samples("main", T, T + 1000)] == [2, 1]
    assert s.last_seen("main") == T + 9000


def test_a_bad_record_is_refused_and_the_rest_are_stored(tmp_path):
    s = store(tmp_path)
    got = s.add("main", [
        {"t": "sample", "at": "not a time"},
        {"t": "mystery", "at": watchstore.iso(T)},
        {"t": "event", "at": watchstore.iso(T)},  # no kind
        "a string",
        sample(T, idleS=3),
    ], T)
    assert got == {"stored": 1, "duplicates": 0, "rejected": 4}


def test_a_box_name_that_is_not_a_plain_name_is_refused(tmp_path):
    s = store(tmp_path)
    for bad in ("", "<b>x</b>", "a b", "x" * 65, None, 7):
        with pytest.raises(ValueError):
            s.add(bad, [sample(T)], T)


def test_events_filter_by_box_and_kind_and_an_event_without_a_key_is_keyed_by_its_time(tmp_path):
    s = store(tmp_path)
    s.add("main", [event(T, "power.wake"), event(T, "power.wake"), event(T + 5, "job.run", key="r1")], T)
    s.add("doorman", [event(T - 8, "doorman.burst", key="main:1", target="main", cause="schedule")], T)
    assert len(s.events(T - 100, T + 100, kinds=["power.wake"])) == 1
    assert [e["kind"] for e in s.events(T - 100, T + 100, box="doorman")] == ["doorman.burst"]
    assert s.events(T - 100, T + 100, box="doorman")[0]["data"]["cause"] == "schedule"
    assert s.boxes() == ["doorman", "main"]


def test_prune_drops_old_samples_and_keeps_events(tmp_path):
    s = store(tmp_path)
    old = T - 100 * 86400
    s.add("main", [sample(old, idleS=1), sample(T, idleS=2), event(old, "power.wake", key="old")], T)
    assert s.prune(T) == 1
    assert [x["idleS"] for x in s.samples("main", old - 1, T + 1)] == [2]
    assert len(s.events(old - 1, T + 1)) == 1


def test_answers_and_meta_round_trip_and_an_unknown_answer_is_refused(tmp_path):
    s = store(tmp_path)
    s.set_answer("wake.unexplained:main:2026-11-11", "me", T)
    s.set_answer("wake.unexplained:main:2026-11-11", "wrong", T + 5)
    assert s.answers() == {"wake.unexplained:main:2026-11-11": {"answer": "wrong", "at": T + 5}}
    with pytest.raises(ValueError):
        s.set_answer("x", "maybe", T)
    assert s.meta("bursts.offset", 0) == 0
    s.set_meta("bursts.offset", 4096)
    assert s.meta("bursts.offset") == 4096


def test_an_empty_store_has_no_span_and_nobody_was_seen(tmp_path):
    s = store(tmp_path)
    assert s.span() is None and s.boxes() == [] and s.last_seen("main") is None
    s.add("main", [sample(T), event(T + 50, "power.wake")], T + 60)
    assert s.span() == (T, T + 50)
