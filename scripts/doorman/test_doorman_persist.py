"""Review follow-ups: the schedule survives a doorman restart; concurrent knocks start one burst."""
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(__file__))
from test_doorman import Harness  # noqa: E402


def test_schedule_persists_across_restart(tmp_path):
    path = str(tmp_path / "schedule.json")
    h = Harness()
    h.d.schedule_path = path
    h.d.set_schedule("main", [1000.0 + 600])
    assert json.load(open(path))["main"] == [1600.0]
    h2 = Harness()
    h2.timers.clear()
    h2.d.schedule_path = path
    h2.d.load_schedule()
    assert len(h2.timers) == 1
    h2.run_until(1000.0 + 600)
    assert len(h2.sent) == 5


def test_set_schedule_cancels_the_previous_timers():
    h = Harness()
    h.d.set_schedule("main", [1000.0 + 600, 1000.0 + 1200])
    h.d.set_schedule("main", [1000.0 + 900])
    # only the live schedule's timer remains armed (stale ones are cancelled, not merely ignored)
    assert len(h.timers) == 1


def test_knock_under_concurrent_calls_sends_one_burst():
    h = Harness()
    threads = [threading.Thread(target=lambda: h.d.knock("main")) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    h.run_until(1000.0 + 120)
    assert len(h.sent) == 5
