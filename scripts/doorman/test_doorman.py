"""Tests for the doorman core: wake bursts, status, schedule. Pure — fakes for clock, sender, prober, timers."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import doorman  # noqa: E402

HERE = os.path.dirname(__file__)


class FakeClock:
    def __init__(self, t=1000.0):
        self.t = t

    def now(self):
        return self.t


class Harness:
    """Drains scheduled callbacks in time order, advancing the clock to each."""

    def __init__(self, probe_up=False):
        self.clock = FakeClock()
        self.sent = []
        self.timers = []  # (when, fn)
        self.up = probe_up
        self.d = doorman.Doorman(
            doorman.load_targets(os.path.join(HERE, "targets.example.json")),
            send_wake=lambda t: self.sent.append((self.clock.now(), t.mac)),
            probe_up=lambda t: self.up,
            now=self.clock.now,
            schedule_later=lambda when, fn: self.timers.append((when, fn)),
        )

    def run_until(self, t_end):
        while True:
            due = [x for x in self.timers if x[0] <= t_end]
            if not due:
                break
            due.sort(key=lambda x: x[0])
            when, fn = due[0]
            self.timers.remove((when, fn))
            self.clock.t = max(self.clock.t, when)
            fn()
        self.clock.t = max(self.clock.t, t_end)


def test_load_targets_reads_mac_dashboard_iface():
    targets = doorman.load_targets(os.path.join(HERE, "targets.example.json"))
    assert targets["main"].mac == "6C:6E:07:2D:AA:00"
    assert targets["main"].dashboard == "http://100.101.192.101:9161/"
    assert targets["main"].iface == "enp1s0"
    assert targets["main"].name == "main"


def test_knock_starts_burst_and_sends_every_15s_for_60s():
    h = Harness()
    h.d.knock("main")
    h.run_until(h.clock.t + 120)
    times = [t - 1000.0 for t, _ in h.sent]
    assert times == [0, 15, 30, 45, 60]
    assert all(mac == "6C:6E:07:2D:AA:00" for _, mac in h.sent)
    assert h.d.status("main")["burstActive"] is False


def test_second_knock_during_burst_does_not_double():
    h = Harness()
    h.d.knock("main")
    h.run_until(h.clock.t + 20)
    h.d.knock("main")
    h.run_until(h.clock.t + 120)
    assert len(h.sent) == 5


def test_status_reports_probe_and_burst():
    h = Harness(probe_up=False)
    s = h.d.status("main")
    assert s == {"up": False, "burstActive": False, "lastWakeAt": None}
    h.d.knock("main")
    h.up = True
    s = h.d.status("main")
    assert s["up"] is True
    assert s["burstActive"] is True
    assert s["lastWakeAt"] == 1000.0


def test_set_schedule_replaces_and_bursts_180s_early():
    h = Harness()
    h.d.set_schedule("main", [1000.0 + 600, 1000.0 + 1200])
    h.d.set_schedule("main", [1000.0 + 900])  # replaces: the 600/1200 bursts must not fire
    h.run_until(1000.0 + 2000)
    first_send = min(t for t, _ in h.sent)
    assert first_send == 1000.0 + 900 - 180
    assert len(h.sent) == 5  # one burst only


def test_unknown_target_raises_keyerror():
    h = Harness()
    try:
        h.d.knock("nope")
        assert False, "expected KeyError"
    except KeyError:
        pass
