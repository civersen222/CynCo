"""The watcher's model: the timeline, the measures and the findings that need no history."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import watchmodel as wm  # noqa: E402
from watchstore import iso, parse_iso  # noqa: E402

P = parse_iso
DAY0 = P("2026-11-11T07:00:00Z")  # the owner's local midnight (UTC-7)
DAY1 = DAY0 + 86400
LATER = DAY1 + 86400  # "now", well after the day

# The nine sleep/wake pairs of 2026-11-11 as the main PC's System log has them (F221): (sleep, wake).
REAL_NIGHT = [
    ("2026-11-11T10:10:16Z", "2026-11-11T10:11:17Z"),
    ("2026-11-11T10:31:40Z", "2026-11-11T10:46:46Z"),
    ("2026-11-11T11:07:09Z", "2026-11-11T11:16:46Z"),
    ("2026-11-11T11:37:09Z", "2026-11-11T11:47:54Z"),
    ("2026-11-11T12:08:17Z", "2026-11-11T12:18:02Z"),
    ("2026-11-11T12:38:25Z", "2026-11-11T12:47:55Z"),
    ("2026-11-11T13:08:18Z", "2026-11-11T13:17:55Z"),
    ("2026-11-11T13:38:18Z", "2026-11-11T14:02:55Z"),
    ("2026-11-11T14:23:18Z", "2026-11-11T14:46:47Z"),
]


def ev(box, at, kind, **data):
    return {"box": box, "at": P(at) if isinstance(at, str) else at, "kind": kind, "key": "%s" % at, "data": data}


def night_events(pairs=REAL_NIGHT, source="Power Button"):
    out = []
    for sleep, wake in pairs:
        out.append(ev("main", sleep, "power.sleep", reason="idle"))
        out.append(ev("main", wake, "power.wake", sleepAt=sleep, source=source))
    return out


def burst(at, target="main", cause="schedule"):
    return ev("doorman", at, "doorman.burst", target=target, cause=cause, forAt=None)


def sample(at, **body):
    return {"at": P(at) if isinstance(at, str) else at, **body}


def minute_samples(start, n, step=60.0, **body):
    t = P(start)
    return [sample(t + i * step, **body) for i in range(n)]


def kinds(found):
    return [f["kind"] for f in found]


def construct(samples, events, t0=DAY0, t1=DAY1, now=None):
    if now is None:  # read just after the last sample, so the silence after it is not what is being tested
        now = (max(s["at"] for s in samples) + 30) if samples else LATER
    segs = wm.timeline(samples, events, "main", t0, t1, now)
    return wm.findings_by_construction(samples, events, "main", segs, t0, t1, now, "2026-11-11")


# ---- wakes ------------------------------------------------------------------------------------
def test_a_wake_8_s_after_a_burst_for_its_box_is_explained_and_names_the_cause():
    events = night_events(REAL_NIGHT[:1]) + [burst("2026-11-11T10:11:09Z")]
    w = wm.wakes([], events, "main", DAY0, DAY1)
    assert len(w) == 1 and w[0]["explained"]["by"] == "schedule"
    assert "2026-11-11T10:11:09Z" in w[0]["explained"]["text"]
    assert construct([], events) == []


def test_the_night_of_f221_is_one_finding_with_its_eight_wakes_and_the_scheduled_one_is_not_in_it():
    events = night_events() + [burst("2026-11-11T10:11:09Z"), burst("2026-11-11T10:11:10Z", target="image", cause="with:main")]
    found = construct([], events)
    assert kinds(found) == ["wake.unexplained"]
    f = found[0]
    assert f["id"] == "wake.unexplained:main:2026-11-11"
    assert [iso(m) for m in f["marks"]] == [w for _, w in REAL_NIGHT[1:]]
    assert "8 times" in f["seen"] and "Power Button" in f["seen"]
    assert "10:11Z" in f["expected"], "the wake the doorman did cause is named as the contrast"
    for part in ("seen", "expected", "means", "suggest"):
        assert f[part].strip()


def test_a_burst_for_another_target_or_too_early_explains_nothing():
    events = night_events(REAL_NIGHT[1:2]) + [burst("2026-11-11T10:46:40Z", target="image"), burst("2026-11-11T10:40:00Z")]
    assert kinds(construct([], events)) == ["wake.unexplained"]


def test_the_owners_own_input_at_the_moment_of_the_wake_explains_it():
    events = night_events(REAL_NIGHT[1:2])
    wake = P("2026-11-11T10:46:46Z")
    touched = [sample(wake + 30, idleS=28)]  # last input 2 s after the wake
    untouched = [sample(wake + 30, idleS=900)]  # last input before the box went to sleep
    assert wm.wakes(touched, events, "main", DAY0, DAY1)[0]["explained"]["by"] == "owner"
    assert wm.wakes(untouched, events, "main", DAY0, DAY1)[0]["explained"] is None
    assert wm.wakes([sample(wake + 30, idleS=None)], events, "main", DAY0, DAY1)[0]["explained"] is None


def test_the_wake_source_windows_names_is_never_taken_as_the_owner():
    events = night_events(REAL_NIGHT[1:2], source="Power Button")
    assert kinds(construct([], events)) == ["wake.unexplained"]


# ---- the timeline -----------------------------------------------------------------------------
def test_late_and_out_of_order_events_give_the_same_timeline():
    events = night_events()
    a = wm.timeline([], events, "main", DAY0, DAY1, LATER)
    b = wm.timeline([], list(reversed(events)), "main", DAY0, DAY1, LATER)
    assert a == b
    asleep = [(iso(s["from"]), iso(s["to"])) for s in a if s["state"] == "asleep"]
    assert asleep == REAL_NIGHT
    awake = [s for s in a if s["state"] == "awake"]
    assert len(awake) == 8 and all(s["basis"] == "idle sleep" for s in awake), "each stretch between a wake and the next idle sleep"
    assert a[0]["state"] == "unknown" and a[-1]["state"] == "unknown", "before the first sleep and after the last wake nothing was reported"


def test_samples_make_awake_and_a_gap_nothing_explains_is_silent():
    samples = minute_samples("2026-11-11T16:00:00Z", 10) + minute_samples("2026-11-11T16:40:00Z", 5)
    segs = wm.timeline(samples, [], "main", DAY0, DAY1, LATER)
    states = [(s["state"], iso(s["from"]), iso(s["to"])) for s in segs]
    assert ("awake", "2026-11-11T16:00:00Z", "2026-11-11T16:09:00Z") in states
    assert ("silent", "2026-11-11T16:09:00Z", "2026-11-11T16:40:00Z") in states
    found = construct(samples, [], now=LATER)
    assert kinds(found) == ["box.silent", "box.silent"], "the gap, and the rest of the day after the last sample"
    quiet = [f for f in found if f["kind"] == "box.silent"]
    assert quiet[0]["id"] == "box.silent:main:2026-11-11T16:09:00Z"


def test_a_gap_the_box_later_explains_as_sleep_is_asleep_not_silent():
    samples = minute_samples("2026-11-11T16:00:00Z", 10) + minute_samples("2026-11-11T16:40:30Z", 5)
    events = [ev("main", "2026-11-11T16:09:20Z", "power.sleep", reason="idle"), ev("main", "2026-11-11T16:40:00Z", "power.wake", sleepAt="2026-11-11T16:09:20Z", source="Device -ASIX"), burst("2026-11-11T16:39:50Z", cause="knock")]
    segs = wm.timeline(samples, events, "main", DAY0, DAY1, LATER)
    assert [s["state"] for s in segs if s["from"] >= P("2026-11-11T16:00:00Z") and s["to"] <= P("2026-11-11T16:45:00Z")] == ["awake", "asleep", "awake"]
    assert construct(samples, events) == []


def test_a_sleep_whose_wake_is_not_reported_yet_ends_where_the_box_is_heard_from_again():
    # Windows writes the wake's own row a moment after the resume: the box's samples can arrive first.
    before = minute_samples("2026-11-11T16:00:00Z", 10)
    after = minute_samples("2026-11-11T16:40:30Z", 5)
    sleep = [ev("main", "2026-11-11T16:09:20Z", "power.sleep", reason="idle")]
    now = P("2026-11-11T16:45:00Z")
    segs = wm.timeline(before + after, sleep, "main", DAY0, DAY1, now)
    tail = [(s["state"], iso(s["from"]), iso(s["to"])) for s in segs if s["to"] > P("2026-11-11T16:00:00Z")]
    assert tail == [("awake", "2026-11-11T16:00:00Z", "2026-11-11T16:09:20Z"), ("asleep", "2026-11-11T16:09:20Z", "2026-11-11T16:40:30Z"), ("awake", "2026-11-11T16:40:30Z", "2026-11-11T16:45:00Z")]
    # with no sample after it, the box is asleep until now
    assert wm.timeline(before, sleep, "main", DAY0, DAY1, now)[-1]["state"] == "asleep"


def test_the_same_sleep_reported_twice_a_few_seconds_apart_is_one_sleep():
    # First from Kernel-Power 42 alone (read at the resume), then with the wake's row, whose sleep time is 3 s earlier.
    events = [
        ev("main", "2026-11-11T16:09:23Z", "power.sleep", reason="idle"),
        ev("main", "2026-11-11T16:09:20Z", "power.sleep", reason="idle"),
        ev("main", "2026-11-11T16:40:00Z", "power.wake", sleepAt="2026-11-11T16:09:20Z", source="Power Button"),
    ]
    segs = wm.timeline([], events, "main", DAY0, DAY1, LATER)
    assert [(iso(s["from"]), iso(s["to"])) for s in segs if s["state"] == "asleep"] == [("2026-11-11T16:09:20Z", "2026-11-11T16:40:00Z")]


# ---- silence is only ever between real reports (F232) ---------------------------------------
def test_a_box_is_not_silent_before_its_reporter_has_ever_run():
    # The first live day, 2026-11-12: the reporter started at 04:40:10Z and its first push carried
    # three days of the System log. The last event in that history was the wake at 14:46:47Z the day
    # before. The note called the 13.9 hours between them "went silent without saying why".
    events = night_events() + [burst("2026-11-11T10:11:09Z"), ev("main", "2026-11-12T04:40:10Z", "reporter.start", pid=1)]
    samples = minute_samples("2026-11-12T04:40:10Z", 20, idleS=30)
    now = P("2026-11-12T05:00:00Z")
    segs = wm.timeline(samples, events, "main", DAY0, DAY1, now)
    assert "silent" not in [s["state"] for s in segs]
    last_wake = P("2026-11-11T14:46:47Z")
    after = [s for s in segs if s["from"] >= last_wake]
    assert [(s["state"], iso(s["from"])) for s in after] == [("awake", "2026-11-11T14:46:47Z")]
    assert "System log" in after[0]["basis"], "awake by its own log: no sleep or shutdown is recorded for that time"
    found = construct(samples, events, now=now)
    assert kinds(found) == ["wake.unexplained"], "the eight wakes, and nothing about silence"
    # and it is still not a finding when the day is read later (the test's samples end at 04:59Z,
    # so the rest of that day is a silence of its own; the 13.9 hours before the first report are not)
    later = [f for f in construct(samples, events, now=LATER) if f["kind"] == "box.silent"]
    assert [iso(f["from"]) for f in later] == ["2026-11-12T04:59:10Z"]


def test_backfilled_history_alone_is_never_silence():
    # Power events with no sample anywhere: the reporter did not exist.
    events = night_events()
    for now in (P("2026-11-11T20:00:00Z"), LATER):
        segs = wm.timeline([], events, "main", DAY0, DAY1, now)
        assert "silent" not in [s["state"] for s in segs]
        assert "box.silent" not in kinds(construct([], events, now=now))


def test_a_late_logon_after_a_boot_is_not_silence():
    # The reporter starts at logon. Between the boot and the first report nothing was ever reporting.
    events = [ev("main", "2026-11-11T09:47:06Z", "power.shutdown"), ev("main", "2026-11-11T09:47:31Z", "power.boot")]
    before = minute_samples("2026-11-11T09:30:00Z", 17)  # reporting right up to the shutdown
    after = minute_samples("2026-11-11T14:59:10Z", 10)  # logged on five hours later
    segs = wm.timeline(before + after, events, "main", DAY0, DAY1, P("2026-11-11T15:10:00Z"))
    assert "silent" not in [s["state"] for s in segs]
    assert construct(before + after, events, now=P("2026-11-11T15:10:00Z")) == []


def test_a_box_that_was_reporting_when_it_slept_and_does_not_report_after_the_wake_is_silent():
    before = minute_samples("2026-11-11T16:00:00Z", 10)  # reporting until it slept
    events = [ev("main", "2026-11-11T16:09:20Z", "power.sleep", reason="idle"), ev("main", "2026-11-11T16:40:00Z", "power.wake", sleepAt="2026-11-11T16:09:20Z", source="x"), burst("2026-11-11T16:39:50Z", cause="knock")]
    after = minute_samples("2026-11-11T18:00:00Z", 5)  # heard again 80 minutes after the wake
    found = construct(before + after, events)
    assert kinds(found) == ["box.silent"]
    assert (iso(found[0]["from"]), iso(found[0]["to"])) == ("2026-11-11T16:40:00Z", "2026-11-11T18:00:00Z")


def test_a_stop_the_reporter_announced_is_not_silence():
    before = minute_samples("2026-11-11T16:00:00Z", 10)
    after = minute_samples("2026-11-11T18:30:00Z", 10)
    stop = [ev("main", "2026-11-11T16:09:05Z", "reporter.stop", reason="asked"), ev("main", "2026-11-11T18:30:00Z", "reporter.start", pid=2)]
    segs = wm.timeline(before + after, stop, "main", DAY0, DAY1, P("2026-11-11T18:40:00Z"))
    mid = [(s["state"], iso(s["from"]), iso(s["to"])) for s in segs if s["state"] != "unknown"]
    assert mid == [("awake", "2026-11-11T16:00:00Z", "2026-11-11T16:09:00Z"), ("unwatched", "2026-11-11T16:09:00Z", "2026-11-11T18:30:00Z"), ("awake", "2026-11-11T18:30:00Z", "2026-11-11T18:40:00Z")]
    assert "stopped on purpose" in [s for s in segs if s["state"] == "unwatched"][0]["basis"]
    assert construct(before + after, stop, now=P("2026-11-11T18:40:00Z")) == []
    # the same two stretches with nothing announced are silence, and a finding
    assert kinds(construct(before + after, [], now=P("2026-11-11T18:40:00Z"))) == ["box.silent"]


def test_a_reporter_stopped_on_purpose_and_not_started_again_is_unwatched_not_silent_however_late_it_is_read():
    before = minute_samples("2026-11-11T16:00:00Z", 10)
    stop = [ev("main", "2026-11-11T16:09:05Z", "reporter.stop", reason="asked")]
    for now in (P("2026-11-11T17:00:00Z"), LATER):
        segs = wm.timeline(before, stop, "main", DAY0, DAY1, now)
        assert segs[-1]["state"] == "unwatched"
        assert construct(before, stop, now=now) == []


def test_an_announced_stop_shows_at_once_and_a_restart_within_minutes_leaves_no_trace():
    before = minute_samples("2026-11-11T16:00:00Z", 10)
    stop = [ev("main", "2026-11-11T16:09:05Z", "reporter.stop", reason="asked")]
    segs = wm.timeline(before, stop, "main", DAY0, DAY1, P("2026-11-11T16:09:30Z"))
    assert segs[-1]["state"] == "unwatched", "said the moment it is stopped, not five minutes later"
    again = minute_samples("2026-11-11T16:10:00Z", 5)  # started again 55 s later, as after an update
    segs = wm.timeline(before + again, stop, "main", DAY0, DAY1, P("2026-11-11T16:14:30Z"))
    assert [s["state"] for s in segs if s["state"] != "unknown"] == ["awake"]


def test_an_announced_stop_does_not_excuse_a_later_silence():
    # Stopped and started on purpose in the morning; went quiet, unannounced, in the afternoon.
    a = minute_samples("2026-11-11T16:00:00Z", 10)
    b = minute_samples("2026-11-11T16:30:00Z", 10)
    c = minute_samples("2026-11-11T19:00:00Z", 5)
    stop = [ev("main", "2026-11-11T16:09:05Z", "reporter.stop", reason="asked")]
    found = construct(a + b + c, stop, now=P("2026-11-11T19:05:00Z"))
    assert kinds(found) == ["box.silent"]
    assert iso(found[0]["from"]) == "2026-11-11T16:39:00Z"


def test_a_wanted_service_is_not_called_down_while_the_box_is_unwatched():
    a = minute_samples("2026-11-11T16:00:00Z", 10, **svc(False))
    b = minute_samples("2026-11-11T18:30:00Z", 3, **svc(True))
    stop = [ev("main", "2026-11-11T16:09:05Z", "reporter.stop", reason="asked")]
    found = construct(a + b, stop, now=P("2026-11-11T18:33:00Z"))
    assert kinds(found) == ["service.down"]
    assert iso(found[0]["to"]) == "2026-11-11T16:09:00Z", "what was seen ends where the watching ended"


def test_silence_that_is_still_going_on_is_a_status_not_yet_a_finding():
    samples = minute_samples("2026-11-11T16:00:00Z", 10)
    now = P("2026-11-11T17:00:00Z")
    segs = wm.timeline(samples, [], "main", DAY0, DAY1, now)
    assert segs[-1]["state"] == "silent" and segs[-1]["to"] == now
    assert construct(samples, [], now=now) == []


def test_shutdown_to_boot_is_off():
    events = [ev("main", "2026-11-11T09:47:06Z", "power.shutdown"), ev("main", "2026-11-11T09:47:31Z", "power.boot")]
    segs = wm.timeline([], events, "main", DAY0, DAY1, LATER)
    assert [(s["state"], iso(s["from"]), iso(s["to"])) for s in segs if s["state"] == "off"] == [("off", "2026-11-11T09:47:06Z", "2026-11-11T09:47:31Z")]


def test_a_window_with_nothing_in_it_is_unknown_and_a_window_in_the_future_is_empty():
    assert [s["state"] for s in wm.timeline([], [], "main", DAY0, DAY1, LATER)] == ["unknown"]
    assert wm.timeline([], [], "main", DAY0, DAY1, DAY0 - 5) == []


# ---- services ---------------------------------------------------------------------------------
def svc(up, wanted=True, name="embed", by="the engine"):
    return {"services": [{"name": name, "up": up, "wanted": wanted, "by": by}]}


def test_a_service_down_for_a_minute_is_a_restart_and_for_four_is_a_finding():
    blip = minute_samples("2026-11-11T16:00:00Z", 3, **svc(True)) + minute_samples("2026-11-11T16:03:00Z", 2, **svc(False)) + minute_samples("2026-11-11T16:05:00Z", 3, **svc(True))
    assert construct(blip, []) == []
    out = minute_samples("2026-11-11T16:00:00Z", 3, **svc(True)) + minute_samples("2026-11-11T16:03:00Z", 5, **svc(False)) + minute_samples("2026-11-11T16:08:00Z", 3, **svc(True))
    found = construct(out, [])
    assert kinds(found) == ["service.down"]
    assert found[0]["id"] == "service.down:main:embed:2026-11-11T16:03:00Z"
    assert iso(found[0]["to"]) == "2026-11-11T16:08:00Z" and found[0]["open"] is False
    assert "the engine" in found[0]["expected"]


def test_a_service_nothing_depends_on_is_never_flagged():
    samples = minute_samples("2026-11-11T16:00:00Z", 30, **svc(False, wanted=False))
    assert construct(samples, []) == []


def test_a_service_still_down_at_the_last_report_is_open_and_says_how_to_start_it():
    samples = minute_samples("2026-11-11T16:00:00Z", 10, **svc(False))
    now = P("2026-11-11T16:10:00Z")
    found = construct(samples, [], now=now)
    assert kinds(found) == ["service.down"] and found[0]["open"] is True
    assert "cynco-services.ps1 start embed" in found[0]["suggest"]


def test_the_dependents_own_words_open_and_close_an_outage_with_no_sample_at_all():
    events = [
        ev("main", "2026-11-11T15:06:00Z", "service.said_down", service="embed", by="the engine", text="No embedding endpoint answered", basis="engine log, anchored by the index stamp"),
        ev("main", "2026-11-11T17:18:12Z", "service.said_up", service="embed", by="the engine"),
    ]
    found = construct([], events)
    assert kinds(found) == ["service.down"]
    f = found[0]
    assert (iso(f["from"]), iso(f["to"]), f["open"]) == ("2026-11-11T15:06:00Z", "2026-11-11T17:18:12Z", False)
    assert "2.2 h" in f["seen"] and "anchored by the index stamp" in f["seen"]


def test_an_outage_ends_where_the_box_went_to_sleep():
    samples = minute_samples("2026-11-11T16:00:00Z", 6, **svc(False))
    events = [ev("main", "2026-11-11T16:05:30Z", "power.sleep", reason="idle"), ev("main", "2026-11-11T18:00:00Z", "power.wake", sleepAt="2026-11-11T16:05:30Z", source="x"), burst("2026-11-11T17:59:50Z")]
    found = construct(samples, events)
    assert kinds(found) == ["service.down"]
    assert iso(found[0]["to"]) == "2026-11-11T16:05:30Z"


# ---- models -----------------------------------------------------------------------------------
def model(busy, name="Qwen3.8-27B", server="llama:8081"):
    return {"models": [{"server": server, "name": name, "busy": busy}]}


def test_a_model_loaded_and_unused_for_25_minutes_is_a_finding_and_for_10_is_not():
    short = minute_samples("2026-11-11T16:00:00Z", 11, **model(False))
    assert construct(short, []) == []
    long = minute_samples("2026-11-11T16:00:00Z", 5, **model(True)) + minute_samples("2026-11-11T16:05:00Z", 26, **model(False)) + minute_samples("2026-11-11T16:31:00Z", 3, **model(True))
    found = construct(long, [])
    assert kinds(found) == ["model.unused"]
    assert found[0]["id"] == "model.unused:main:2026-11-11T16:05:00Z"
    assert "Qwen3.8-27B" in found[0]["seen"] and "26 min" in found[0]["seen"]


def test_a_model_whose_use_could_not_be_read_is_not_called_unused():
    samples = minute_samples("2026-11-11T16:00:00Z", 40, **model(None))
    assert construct(samples, []) == []
    m = wm.measures(samples, [], "main", wm.timeline(samples, [], "main", DAY0, DAY1, LATER), DAY0, DAY1)
    assert m["loadedUnused"]["unusedS"] == 0 and m["loadedUnused"]["value"] == 0.0


# ---- measures ---------------------------------------------------------------------------------
def test_asleep_when_it_could_be_reads_about_0_4_over_the_four_hours_of_f221():
    t0, t1 = P("2026-11-11T10:31:40Z"), P("2026-11-11T14:46:47Z")
    events = night_events(REAL_NIGHT[1:])
    segs = wm.timeline([], events, "main", t0, t1, LATER)
    m = wm.measures([], events, "main", segs, t0, t1)["asleepWhenCould"]
    assert round(m["asleepS"] / 60) == 112
    assert 0.40 <= m["value"] <= 0.46
    assert m["inferredS"] > 0, "the awake stretches are counted as not needed because each ended in an idle sleep"


def test_measures_with_nothing_to_measure_are_none_not_zero():
    m = wm.measures([], [], "main", [], DAY0, DAY1)
    assert m["asleepWhenCould"]["value"] is None and m["loadedUnused"]["value"] is None
    assert m["answering"] == {} and m["jobs"] == {}


def test_answering_when_wanted_and_job_rates():
    samples = minute_samples("2026-11-11T16:00:00Z", 6, **svc(True)) + minute_samples("2026-11-11T16:06:00Z", 5, **svc(False))
    events = [ev("main", "2026-11-11T16:01:00Z", "job.run", mission="fantasy-digest", triggerId="digest-bronze-card", ok=True), ev("main", "2026-11-11T17:01:00Z", "job.run", mission="fantasy-digest", triggerId="digest-bronze-card", ok=False)]
    m = wm.measures(samples, events, "main", wm.timeline(samples, events, "main", DAY0, DAY1, LATER), DAY0, DAY1)
    assert m["answering"]["embed"]["value"] == 0.6
    assert m["jobs"]["fantasy-digest/digest-bronze-card"] == {"runs": 2, "ok": 1, "rate": 0.5}


def test_idle_samples_count_as_time_nothing_needed_the_box_and_use_does_not():
    idle = minute_samples("2026-11-11T16:00:00Z", 11, idleS=900, engine={"up": True, "processing": False, "open": []})
    busy = minute_samples("2026-11-11T16:00:00Z", 11, idleS=900, engine={"up": True, "processing": True, "open": [{"kind": "turn"}]})
    for samples, expect in ((idle, 600.0), (busy, 0.0)):
        m = wm.measures(samples, [], "main", wm.timeline(samples, [], "main", DAY0, DAY1, LATER), DAY0, DAY1)
        assert m["asleepWhenCould"]["notNeededS"] == expect


# ---- the day ----------------------------------------------------------------------------------
def test_day_bounds_are_the_owners_local_day():
    assert wm.day_bounds("2026-11-11", -420) == (DAY0, DAY1)
    assert wm.day_of(P("2026-11-12T03:00:00Z"), -420) == "2026-11-11"
    try:
        wm.day_bounds("2026-13-40", -420)
        raise AssertionError("a day that is not a day must be refused")
    except ValueError:
        pass
