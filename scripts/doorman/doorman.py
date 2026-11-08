"""doorman — the always-on front door that wakes CynCo's GPU boxes over the basement switch.

Runs on the doorman mini PC (Ubuntu, Tailscale 100.110.117.10). Python 3 stdlib only.
Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 1).

Core (this module, pure, tested in test_doorman.py):
  Target        one wakeable box: mac, dashboard URL to probe, interface to send on
  Doorman       knock() starts a wake burst (etherwake every BURST_INTERVAL_S for BURST_DURATION_S,
                never doubled), status() reports probe + burst, set_schedule() replaces the list
                of future times at which to burst LEAD_S early.
The HTTP service, the waking page and the real senders live below the core (added in Task 2).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

BURST_INTERVAL_S = 15.0
BURST_DURATION_S = 60.0
LEAD_S = 180.0


@dataclass
class Target:
    name: str
    mac: str
    dashboard: str
    iface: str


def load_targets(path: str) -> Dict[str, Target]:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return {name: Target(name=name, mac=v["mac"], dashboard=v["dashboard"], iface=v["iface"]) for name, v in raw.items()}


class Doorman:
    def __init__(
        self,
        targets: Dict[str, Target],
        send_wake: Callable[[Target], None],
        probe_up: Callable[[Target], bool],
        now: Callable[[], float],
        schedule_later: Callable[[float, Callable[[], None]], None],
    ) -> None:
        self.targets = targets
        self._send_wake = send_wake
        self._probe_up = probe_up
        self._now = now
        self._schedule_later = schedule_later
        self._burst: Dict[str, Optional[float]] = {n: None for n in targets}  # burst start time
        self._last_wake: Dict[str, Optional[float]] = {n: None for n in targets}
        self._schedule_gen: Dict[str, int] = {n: 0 for n in targets}  # bumps per set_schedule; stale timers no-op

    def _target(self, name: str) -> Target:
        return self.targets[name]  # KeyError for an unknown target, by design

    def knock(self, name: str) -> dict:
        self._target(name)
        if self._burst[name] is None:
            self._burst[name] = self._now()
            self._burst_tick(name)
        return self.status(name)

    def status(self, name: str) -> dict:
        t = self._target(name)
        return {
            "up": bool(self._probe_up(t)),
            "burstActive": self._burst[name] is not None,
            "lastWakeAt": self._last_wake[name],
        }

    def set_schedule(self, name: str, times: List[float]) -> None:
        self._target(name)
        self._schedule_gen[name] += 1
        gen = self._schedule_gen[name]
        now = self._now()
        for at in times:
            fire_at = max(now, at - LEAD_S)

            def fire(n: str = name, g: int = gen) -> None:
                if self._schedule_gen[n] == g:
                    self.knock(n)

            self._schedule_later(fire_at, fire)

    def _burst_tick(self, name: str) -> None:
        started = self._burst[name]
        if started is None:
            return
        t = self._target(name)
        self._send_wake(t)
        self._last_wake[name] = self._now()
        if self._now() - started < BURST_DURATION_S:
            self._schedule_later(self._now() + BURST_INTERVAL_S, lambda: self._burst_tick(name))
        else:
            self._burst[name] = None
