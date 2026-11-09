"""naswatch — tell the phone when the NAS stops answering, once per change.

Runs on the doorman (the always-on box) as a systemd unit. Every `interval_s`
it pings the router first, then the NAS. A target is `down` after `threshold`
consecutive failures and `up` again on the first success; only a transition
publishes to ntfy (`<ntfy_url>/<topic>`). While the router is down the NAS is
not judged: the alert is "house network down", not a NAS failure (the owner's
2026-10-28 ask after two NAS freezes: ping the router first, alert only on a
state change). Python 3 stdlib only; the `Watch` class is pure and tested in
test_naswatch.py. Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 6).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional


@dataclass
class Target:
    name: str
    host: str
    kind: str  # 'router' | 'nas'


@dataclass
class Config:
    ntfy_url: str
    topic: str
    targets: List[Target]
    interval_s: int = 60
    threshold: int = 3


def load_config(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return Config(
        ntfy_url=raw["ntfy_url"].rstrip("/"),
        topic=raw.get("topic", "cynco-alerts"),
        targets=[Target(t["name"], t["host"], t.get("kind", "nas")) for t in raw["targets"]],
        interval_s=int(raw.get("interval_s", 60)),
        threshold=int(raw.get("threshold", 3)),
    )


class Watch:
    """Pure state machine. `publish(title, body, priority)` is injected."""

    def __init__(self, targets: List[Target], threshold: int, publish: Callable[[str, str, int], None]) -> None:
        self.targets = targets
        self.threshold = threshold
        self._publish = publish
        self._state: Dict[str, str] = {t.name: "unknown" for t in targets}
        self._fails: Dict[str, int] = {t.name: 0 for t in targets}

    def states(self) -> Dict[str, str]:
        return dict(self._state)

    def tick(self, results: Dict[str, bool]) -> List[str]:
        lines: List[str] = []
        router = next((t for t in self.targets if t.kind == "router"), None)
        router_down = False
        # Router first: its verdict decides whether the others are judged.
        order = ([router] if router else []) + [t for t in self.targets if t is not router]
        for t in order:
            ok = bool(results.get(t.name, False))
            if t.kind != "router" and router_down:
                continue  # not judged while the house network is down
            if ok:
                self._fails[t.name] = 0
                if self._state[t.name] == "down":
                    lines.append(f"{t.name} is back")
                    self._publish(f"{t.name} is back", f"{t.name} ({t.host}) answers again", 3)
                self._state[t.name] = "up"
            else:
                self._fails[t.name] += 1
                if self._state[t.name] != "down" and self._fails[t.name] >= self.threshold:
                    self._state[t.name] = "down"
                    if t.kind == "router":
                        lines.append("house network down (router not answering)")
                        self._publish("house network down", f"the router ({t.host}) stopped answering {self.threshold} checks in a row", 4)
                    else:
                        lines.append(f"{t.name} stopped answering ({self.threshold} checks)")
                        self._publish(f"{t.name} stopped answering", f"{t.name} ({t.host}) failed {self.threshold} checks in a row", 4)
            if t.kind == "router" and self._state[t.name] == "down":
                router_down = True
        return lines


# ---- real deps ---------------------------------------------------------------
def ping(host: str) -> bool:
    try:
        r = subprocess.run(["ping", "-c", "1", "-W", "2", host], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def ntfy_publisher(ntfy_url: str, topic: str) -> Callable[[str, str, int], None]:
    def publish(title: str, body: str, priority: int) -> None:
        req = urllib.request.Request(f"{ntfy_url}/{topic}", data=body.encode("utf-8"), method="POST")
        req.add_header("Title", title)
        req.add_header("Priority", str(priority))
        req.add_header("Tags", "warning" if priority >= 4 else "white_check_mark")
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:  # the next transition will try again; never crash the watch
            print(f"naswatch: publish failed: {e}", file=sys.stderr)
    return publish


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="NAS watchdog: router first, alert on state change only")
    p.add_argument("--config", default="/etc/doorman/naswatch.json")
    p.add_argument("--once", action="store_true", help="one tick, print states, exit")
    a = p.parse_args(argv)
    cfg = load_config(a.config)
    w = Watch(cfg.targets, cfg.threshold, ntfy_publisher(cfg.ntfy_url, cfg.topic))
    print(f"naswatch: {len(cfg.targets)} target(s), every {cfg.interval_s}s, threshold {cfg.threshold}, alerts -> {cfg.ntfy_url}/{cfg.topic}", file=sys.stderr)
    while True:
        results = {t.name: ping(t.host) for t in cfg.targets}
        for line in w.tick(results):
            print(f"naswatch: {line}", file=sys.stderr)
        if a.once:
            print(json.dumps(w.states()))
            return 0
        time.sleep(cfg.interval_s)


if __name__ == "__main__":
    sys.exit(main())
