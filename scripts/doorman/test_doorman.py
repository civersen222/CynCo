"""Tests for the doorman core: wake bursts, status, schedule. Pure — fakes for clock, sender, prober, timers."""
import json
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
            schedule_later=self._later,
        )

    def _later(self, when, fn):
        entry = (when, fn)
        self.timers.append(entry)
        return lambda: self.timers.remove(entry) if entry in self.timers else None

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
    times = [t - 1000.0 for t, mac in h.sent if mac == "6C:6E:07:2D:AA:00"]
    assert times == [0, 15, 30, 45, 60]
    assert h.d.status("main")["burstActive"] is False


def test_second_knock_during_burst_does_not_double():
    h = Harness()
    h.d.knock("main")
    h.run_until(h.clock.t + 20)
    h.d.knock("main")
    h.run_until(h.clock.t + 120)
    assert len([m for _, m in h.sent if m == "6C:6E:07:2D:AA:00"]) == 5


def test_status_reports_probe_and_burst():
    h = Harness(probe_up=False)
    s = h.d.status("main")
    assert {k: s[k] for k in ("up", "burstActive", "lastWakeAt")} == {"up": False, "burstActive": False, "lastWakeAt": None}
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
    assert len([m for _, m in h.sent if m == "6C:6E:07:2D:AA:00"]) == 5  # one burst only


def test_unknown_target_raises_keyerror():
    h = Harness()
    try:
        h.d.knock("nope")
        assert False, "expected KeyError"
    except KeyError:
        pass


# ---- HTTP service (Task 2) ----
import http.client  # noqa: E402
import threading  # noqa: E402


class ServerHarness(Harness):
    def __enter__(self):
        self.server = doorman.serve("127.0.0.1", 0, self.d, page_html="<html data-dashboard='{dashboard}'>waking</html>")
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.server.shutdown()
        self.server.server_close()

    def get(self, path, method="GET", body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
        r = c.getresponse()
        data = r.read().decode()
        c.close()
        return r.status, data


def test_http_status_json_shape():
    with ServerHarness(probe_up=True) as h:
        code, body = h.get("/status?target=main")
        assert code == 200
        assert json.loads(body) == {"up": True, "burstActive": False, "lastWakeAt": None, "with": [{"name": "image", "up": True, "burstActive": False}]}


def test_http_wake_triggers_one_send():
    with ServerHarness() as h:
        code, body = h.get("/wake?target=main")
        assert code == 200
        assert json.loads(body)["burstActive"] is True
        assert len([m for _, m in h.sent if m == "6C:6E:07:2D:AA:00"]) == 1


def test_http_schedule_post_two_iso_times():
    with ServerHarness() as h:
        code, body = h.get("/schedule", "POST", json.dumps({"target": "main", "times": ["2026-11-08T20:00:00Z", "2026-11-08T21:00:00Z"]}))
        assert code == 200
        assert json.loads(body) == {"ok": True, "count": 2}
        assert len(h.timers) == 2


def test_http_unknown_target_404():
    with ServerHarness() as h:
        code, body = h.get("/status?target=nope")
        assert code == 404
        assert json.loads(body) == {"error": "no such target"}


def test_http_root_serves_page_with_dashboard():
    with ServerHarness() as h:
        code, body = h.get("/")
        assert code == 200
        assert "data-dashboard='http://100.101.192.101:9161/'" in body


# The image box (docs/decisions/2026-11-08-image-box-design.md §5): waking main wakes the 4070 box too.
IMAGE = "00:00:00:00:00:00"
MAINMAC = "6C:6E:07:2D:AA:00"


def test_load_targets_reads_with_and_health():
    targets = doorman.load_targets(os.path.join(HERE, "targets.example.json"))
    assert targets["main"].with_ == ["image"]
    assert targets["image"].health == "http://192.168.0.47:11434/api/version"
    assert targets["image"].with_ == []
    assert targets["image"].dashboard == ""


def test_knock_main_bursts_main_and_image_together_never_doubled():
    h = Harness()
    h.d.knock("main")
    h.run_until(h.clock.t + 1)
    assert sorted(m for _, m in h.sent) == sorted([MAINMAC, IMAGE])
    h.d.knock("main")
    h.run_until(h.clock.t + 120)
    assert len([m for _, m in h.sent if m == IMAGE]) == 5
    assert len([m for _, m in h.sent if m == MAINMAC]) == 5


def test_schedule_for_main_bursts_both_at_fire_time():
    h = Harness()
    h.d.set_schedule("main", [1000.0 + 900])
    h.run_until(1000.0 + 2000)
    first = {m: min(t for t, mm in h.sent if mm == m) for m in (MAINMAC, IMAGE)}
    assert first == {MAINMAC: 1000.0 + 720, IMAGE: 1000.0 + 720}


def test_status_main_lists_the_boxes_woken_with_it():
    h = Harness()
    s = h.d.status("main")
    assert s["with"] == [{"name": "image", "up": False, "burstActive": False}]
    h.d.knock("main")
    assert h.d.status("main")["with"][0]["burstActive"] is True


def test_knock_image_alone_wakes_only_image():
    h = Harness()
    h.d.knock("image")
    h.run_until(h.clock.t + 120)
    assert {m for _, m in h.sent} == {IMAGE}


def test_a_target_file_without_with_or_health_loads_as_before(tmp_path):
    p = tmp_path / "targets.json"
    p.write_text(json.dumps({"main": {"mac": MAINMAC, "dashboard": "http://x:9161/", "iface": "eth0"}}), encoding="utf-8")
    t = doorman.load_targets(str(p))["main"]
    assert (t.with_, t.health, t.dashboard) == ([], None, "http://x:9161/")


def test_real_probe_uses_health_when_set(monkeypatch):
    seen = []
    class R:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(doorman.urllib.request, "urlopen", lambda url, timeout=2: seen.append(url) or R())
    doorman.real_probe_up(doorman.Target(name="image", mac=IMAGE, dashboard="", iface="e", health="http://h/api/version"))
    doorman.real_probe_up(doorman.Target(name="main", mac=MAINMAC, dashboard="http://d/", iface="e"))
    assert seen == ["http://h/api/version", "http://d/"]
