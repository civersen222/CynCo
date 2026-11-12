"""The Cyberstride filter: every reading is noise, a transient, a change of slope or a step, and only
the last two are findings. Every series in this file is SYNTHETIC, built by the functions below; the
real records are replayed in test_watch_replay.py."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import watchmodel as wm  # noqa: E402
from watchstore import iso, parse_iso  # noqa: E402

HERE = os.path.dirname(__file__)
T0 = parse_iso("2026-11-01T00:00:00Z")
WIGGLE = [0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.4]  # a fixed pattern, so the tests are the same every run


def flat(n, level=40.0, every=6 * 3600.0, start=T0):
    """Synthetic: `n` readings around `level`, one every six hours."""
    return [(start + i * every, level + WIGGLE[i % len(WIGGLE)]) for i in range(n)]


def classes(result):
    return [p["cls"] for p in result["points"]]


def test_the_two_cusum_detectors_agree_on_one_sequence():
    with open(os.path.join(HERE, "fixtures", "cusum-parity.json"), "r", encoding="utf-8") as f:
        case = json.load(f)
    c = wm.Cusum(case["threshold"], case["slack"])
    for dev, up, lo, alarm in zip(case["deviations"], case["upper"], case["lower"], case["alarm"]):
        assert c.update(dev) is alarm
        assert (c.upper, c.lower) == (up, lo)
    c.reset()
    assert (c.upper, c.lower) == (0.0, 0.0)


def test_a_series_without_enough_history_is_still_learning_and_flags_nothing():
    few = wm.classify(flat(8))
    assert few["state"] == "learning" and few["changes"] == []
    assert few["need"] == "needs 12 readings over 3 days; has 8 over 1.8"
    assert classes(few) == [None] * 8, "charted, with no class"
    short = wm.classify(flat(40, every=600.0))  # many readings, all within seven hours
    assert short["state"] == "learning"
    assert wm.classify([])["state"] == "learning"


def test_flat_noise_flags_nothing():
    r = wm.classify(flat(60))
    assert r["state"] == "ok" and r["changes"] == []
    assert set(classes(r)) == {"noise"}


def test_one_spike_is_a_transient_and_is_not_a_finding():
    data = flat(40)
    data[25] = (data[25][0], 55.0)
    r = wm.classify(data)
    assert classes(r)[25] == "transient"
    assert r["changes"] == []
    assert classes(r)[26] == "noise", "the reading after it is judged against the old level"


def test_a_level_shift_is_one_step_at_the_reading_where_it_happened():
    data = flat(30) + flat(20, level=48.0, start=T0 + 30 * 6 * 3600.0)
    r = wm.classify(data)
    assert [c["cls"] for c in r["changes"]] == ["step"]
    assert r["changes"][0]["at"] == data[30][0]
    assert round(r["changes"][0]["from"]) == 40 and round(r["changes"][0]["to"]) == 48
    assert classes(r)[30] == "step"
    assert "step" not in classes(r)[31:], "the new level is the baseline from then on; it is not flagged again"


def test_a_slow_ramp_is_a_change_of_slope_not_a_step():
    data = flat(30)
    start = T0 + 30 * 6 * 3600.0
    data += [(start + i * 6 * 3600.0, 40.0 + 0.9 * (i + 1) + WIGGLE[i % len(WIGGLE)]) for i in range(12)]  # +0.9 a reading
    r = wm.classify(data)
    assert [c["cls"] for c in r["changes"]][:1] == ["slope"]
    assert data[30][0] <= r["changes"][0]["at"] <= data[36][0], "it is placed where the drift began, not where it was noticed"


def test_a_drop_is_seen_as_well_as_a_rise():
    data = flat(30) + flat(10, level=30.0, start=T0 + 30 * 6 * 3600.0)
    r = wm.classify(data)
    assert [c["cls"] for c in r["changes"]] == ["step"] and r["changes"][0]["to"] < r["changes"][0]["from"]


def test_readings_given_out_of_order_are_classed_in_time_order():
    data = flat(30) + flat(20, level=48.0, start=T0 + 30 * 6 * 3600.0)
    assert wm.classify(list(reversed(data))) == wm.classify(data)


def gpu_samples(start, hours, temp, util=2, per_hour=12):
    out = []
    for h in range(hours):
        for k in range(per_hour):
            at = start + h * 3600.0 + k * (3600.0 / per_hour)
            out.append({"at": at, "gpus": [{"i": 0, "name": "RTX 5090", "tempC": temp + WIGGLE[(h + k) % len(WIGGLE)], "utilPct": util}]})
    return out


def test_gpu_temperature_becomes_hourly_idle_and_busy_series():
    samples = gpu_samples(T0, 4, 39.0) + gpu_samples(T0 + 4 * 3600.0, 2, 71.0, util=97)
    s = wm.series(samples)
    assert sorted(s) == ["gpu0.tempBusy", "gpu0.tempIdle"]
    assert len(s["gpu0.tempIdle"]["readings"]) == 4 and len(s["gpu0.tempBusy"]["readings"]) == 2
    assert s["gpu0.tempIdle"]["label"] == "RTX 5090, idle temperature"
    # an hour with fewer than five samples is not a reading; a sample with no temperature is skipped
    assert wm.series(gpu_samples(T0, 1, 39.0, per_hour=3) + [{"at": T0, "gpus": [{"i": 0, "tempC": None, "utilPct": 0}]}, {"at": T0, "gpus": None}]) == {}


def test_a_warmer_idle_card_is_a_finding_on_the_day_it_changed_and_a_new_series_says_still_learning():
    week = gpu_samples(T0, 24 * 6, 39.0)  # six days at 39
    warm = gpu_samples(T0 + 6 * 86400.0, 24, 47.0)  # then a day at 47
    day0, day1 = T0 + 6 * 86400.0, T0 + 7 * 86400.0
    found, learning, classified = wm.findings_by_comparison(wm.series(week + warm), "main", day0, day1)
    assert [f["kind"] for f in found] == ["change.step"] and learning == []
    f = found[0]
    assert f["id"] == "change:main:gpu0.tempIdle:%s" % iso(day0)
    assert "39.0" in f["expected"] and "47" in f["seen"]
    assert classified["gpu0.tempIdle"]["state"] == "ok"
    # the same change is not a finding of the day before or the day after
    assert wm.findings_by_comparison(wm.series(week + warm), "main", day0 - 86400.0, day0)[0] == []
    young, learning, _ = wm.findings_by_comparison(wm.series(gpu_samples(T0, 10, 39.0)), "main", T0, T0 + 86400.0)
    assert young == [] and [x["series"] for x in learning] == ["gpu0.tempIdle"]
    assert learning[0]["need"].startswith("needs 12 readings over 3 days")
