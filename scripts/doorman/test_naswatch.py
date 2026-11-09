"""NAS watchdog state machine: router first, N consecutive failures = down, alert on transitions only."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import naswatch  # noqa: E402

ROUTER = naswatch.Target("router", "192.168.0.1", "router")
NAS = naswatch.Target("NAS", "192.168.0.165", "nas")


def make(threshold=3):
    published = []
    w = naswatch.Watch([ROUTER, NAS], threshold=threshold, publish=lambda title, body, prio: published.append((title, body, prio)))
    return w, published


def test_first_up_is_silent_and_down_needs_threshold():
    w, pub = make()
    assert w.tick({"router": True, "NAS": True}) == []
    assert w.tick({"router": True, "NAS": False}) == []
    assert w.tick({"router": True, "NAS": False}) == []
    lines = w.tick({"router": True, "NAS": False})
    assert lines == ["NAS stopped answering (3 checks)"]
    assert pub[-1][2] == 4
    # staying down is silent; coming back speaks once at priority 3
    assert w.tick({"router": True, "NAS": False}) == []
    assert w.tick({"router": True, "NAS": True}) == ["NAS is back"]
    assert pub[-1][2] == 3


def test_flapping_below_threshold_never_alerts():
    w, pub = make()
    w.tick({"router": True, "NAS": True})
    for ok in [False, False, True, False, False, True]:
        assert w.tick({"router": True, "NAS": ok}) == []
    assert pub == []


def test_router_down_is_one_house_alert_and_suppresses_nas():
    w, pub = make()
    w.tick({"router": True, "NAS": True})
    for _ in range(2):
        assert w.tick({"router": False, "NAS": False}) == []
    lines = w.tick({"router": False, "NAS": False})
    assert lines == ["house network down (router not answering)"]
    # while the router is down the NAS is not judged
    assert w.tick({"router": False, "NAS": False}) == []
    assert w.tick({"router": True, "NAS": True}) == ["router is back"]
    assert all("NAS" not in t for t, _, _ in pub)


def test_states_are_readable():
    w, _ = make(threshold=1)
    w.tick({"router": True, "NAS": False})
    assert w.states() == {"router": "up", "NAS": "down"}


def test_config_loads_targets_and_defaults(tmp_path):
    p = tmp_path / "naswatch.json"
    p.write_text('{"ntfy_url": "http://100.110.117.10:8090", "topic": "cynco-alerts", "targets": [{"name": "router", "host": "192.168.0.1", "kind": "router"}, {"name": "NAS", "host": "192.168.0.165", "kind": "nas"}]}', encoding="utf-8")
    cfg = naswatch.load_config(str(p))
    assert cfg.interval_s == 60 and cfg.threshold == 3
    assert [t.name for t in cfg.targets] == ["router", "NAS"]
    assert cfg.ntfy_url == "http://100.110.117.10:8090"
