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
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

BURST_INTERVAL_S = 15.0
BURST_DURATION_S = 60.0
LEAD_S = 180.0


@dataclass
class Target:
    name: str
    mac: str
    dashboard: str  # the page hands the phone here; '' for a box with no dashboard (the image box)
    iface: str
    health: Optional[str] = None  # probed instead of the dashboard when set (e.g. Ollama /api/version)
    with_: List[str] = field(default_factory=list)  # targets woken whenever this one is ("with" in targets.json)

    @property
    def probe_url(self) -> str:
        return self.health or self.dashboard


def load_targets(path: str) -> Dict[str, Target]:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    targets = {
        name: Target(name=name, mac=v["mac"], dashboard=v.get("dashboard", ""), iface=v["iface"], health=v.get("health"), with_=list(v.get("with", [])))
        for name, v in raw.items()
    }
    for t in targets.values():
        for w in t.with_:
            if w not in targets:
                raise KeyError(f"target {t.name!r} wakes unknown target {w!r}")
    return targets


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
        self._schedule_handles: Dict[str, List[Any]] = {n: [] for n in targets}  # cancel handles from schedule_later
        self._schedule_times: Dict[str, List[float]] = {n: [] for n in targets}
        self._lock = threading.Lock()  # knock() under ThreadingHTTPServer must start one burst, not two
        self.schedule_path: Optional[str] = None  # set by main(); None = in-memory only (tests)
        # Called once per burst that starts, with {"at","target","cause","forAt"}: the watcher reads these to match a
        # box's wake to a knock or a scheduled job (docs/decisions/2026-11-11-metasystem-design.md, slice 1).
        self.record: Callable[[dict], None] = lambda rec: None

    def _target(self, name: str) -> Target:
        return self.targets[name]  # KeyError for an unknown target, by design

    def knock(self, name: str, cause: str = "knock", for_at: Optional[float] = None) -> dict:
        """Start a wake burst for `name` and for every target in its `with` list (the image box
        wakes with the main PC: docs/decisions/2026-11-08-image-box-design.md §5). Never doubled.
        `cause` is "knock" (somebody asked) or "schedule" (a time the daemon posted, `for_at`)."""
        t = self._target(name)
        for n in [name, *t.with_]:
            self._burst_start(n, cause if n == name else "with:" + name, for_at)
        return self.status(name)

    def _burst_start(self, name: str, cause: str = "knock", for_at: Optional[float] = None) -> None:
        with self._lock:
            start = self._burst[name] is None
            if start:
                self._burst[name] = self._now()
        if start:
            try:
                self.record({"at": self._burst[name], "target": name, "cause": cause, "forAt": for_at})
            except Exception as e:  # the record is for the watcher; a wake must never wait on it
                import sys as _sys
                print("doorman: burst not recorded: %s" % e, file=_sys.stderr)
            self._burst_tick(name)

    def status(self, name: str) -> dict:
        t = self._target(name)
        return {
            "up": bool(self._probe_up(t)),
            "burstActive": self._burst[name] is not None,
            "lastWakeAt": self._last_wake[name],
            "with": [{"name": w, "up": bool(self._probe_up(self._target(w))), "burstActive": self._burst[w] is not None} for w in t.with_],
        }

    def set_schedule(self, name: str, times: List[float]) -> None:
        self._target(name)
        self._schedule_gen[name] += 1
        gen = self._schedule_gen[name]
        for h in self._schedule_handles[name]:  # cancel the previous list's timers (not merely ignore them)
            if callable(h):
                h()
        self._schedule_handles[name] = []
        self._schedule_times[name] = list(times)
        now = self._now()
        for at in times:
            fire_at = max(now, at - LEAD_S)

            def fire(n: str = name, g: int = gen, scheduled: float = at) -> None:
                if self._schedule_gen[n] == g:
                    self.knock(n, cause="schedule", for_at=scheduled)

            self._schedule_handles[name].append(self._schedule_later(fire_at, fire))
        self._persist_schedule()

    def _persist_schedule(self) -> None:
        if not self.schedule_path:
            return
        tmp = self.schedule_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._schedule_times, f)
        import os as _os
        _os.replace(tmp, self.schedule_path)

    def load_schedule(self) -> None:
        """Re-arm the persisted lists (after a restart). Past times are dropped by set_schedule's max(now, ...)? No:
        a past wake time still fires at once, which is right — the PC may be asleep past a trigger we missed."""
        if not self.schedule_path:
            return
        try:
            with open(self.schedule_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return
        for name, times in saved.items():
            if name in self.targets and isinstance(times, list):
                self.set_schedule(name, [float(t) for t in times])

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


# ---------------------------------------------------------------------------
# HTTP service (Task 2). Bound to the Tailscale address only; no auth beyond
# the tailnet — the dashboard it hands off to still requires pairing.
#   GET  /                 waking page for the default target ("main")
#   GET  /status?target=   {"up","burstActive","lastWakeAt"}
#   GET  /wake?target=     start a burst (idempotent while one runs); returns status
#   POST /schedule         {"target","times":[iso8601,...]} → replaces that target's wake times
# ---------------------------------------------------------------------------
import argparse  # noqa: E402
import datetime as _dt  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

DEFAULT_TARGET = "main"
_HERE = os.path.dirname(os.path.abspath(__file__))


def _parse_iso(s: str) -> float:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = _dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return d.timestamp()


def real_send_wake(t: Target) -> None:
    subprocess.run(["sudo", "etherwake", "-i", t.iface, t.mac], check=False, timeout=10)


def real_probe_up(t: Target) -> bool:
    if not t.probe_url:
        return False
    try:
        with urllib.request.urlopen(t.probe_url, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def real_schedule_later(when: float, fn: Callable[[], None]) -> Callable[[], None]:
    timer = threading.Timer(max(0.0, when - time.time()), fn)
    timer.daemon = True
    timer.start()
    return timer.cancel


def jsonl_recorder(path: str, max_lines: int = 20000) -> Callable[[dict], None]:
    """Append each burst to `path` as one JSON line. Over `max_lines` the file is rewritten with its
    newest half, so it cannot grow without bound; the watcher re-reads a file that got shorter."""
    lock = threading.Lock()
    count = [-1]  # lines in the file; counted on first use

    def record(rec: dict) -> None:
        with lock:
            if count[0] < 0:
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        count[0] = sum(1 for _ in f)
                except OSError:
                    count[0] = 0
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
            count[0] += 1
            if count[0] > max_lines:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                keep = lines[-(max_lines // 2):]
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.writelines(keep)
                os.replace(tmp, path)
                count[0] = len(keep)

    return record


def _make_handler(d: Doorman, page_html: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "doorman/1"

        def _json(self, code: int, obj) -> None:
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        @staticmethod
        def _target_name(q) -> str:
            return (q.get("target") or [DEFAULT_TARGET])[0]

        def do_GET(self) -> None:  # noqa: N802
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            try:
                if url.path == "/":
                    t = d.targets[self._target_name(q)]
                    body = page_html.replace("{dashboard}", t.dashboard).replace("{target}", t.name).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                elif url.path == "/status":
                    self._json(200, d.status(self._target_name(q)))
                elif url.path == "/wake":
                    self._json(200, d.knock(self._target_name(q)))
                else:
                    self._json(404, {"error": "not found"})
            except KeyError:
                self._json(404, {"error": "no such target"})

        def do_POST(self) -> None:  # noqa: N802
            url = urllib.parse.urlparse(self.path)
            if url.path != "/schedule":
                self._json(404, {"error": "not found"})
                return
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
                times = [_parse_iso(s) for s in body.get("times", [])]
                d.set_schedule(body.get("target", DEFAULT_TARGET), times)
                self._json(200, {"ok": True, "count": len(times)})
            except KeyError:
                self._json(404, {"error": "no such target"})
            except (ValueError, TypeError) as e:
                self._json(400, {"error": "bad schedule: %s" % e})

        def log_message(self, fmt, *args) -> None:  # journald gets one line per request
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    return Handler


def serve(bind_ip: str, port: int, d: Doorman, page_html: Optional[str] = None) -> ThreadingHTTPServer:
    if page_html is None:
        with open(os.path.join(_HERE, "index.html"), "r", encoding="utf-8") as f:
            page_html = f.read()
    return ThreadingHTTPServer((bind_ip, port), _make_handler(d, page_html))


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="CynCo doorman: wake GPU boxes over the switch, hand the phone to the dashboard")
    p.add_argument("--targets", default="/etc/doorman/targets.json")
    p.add_argument("--bind", required=True, help="Tailscale address to bind (never 0.0.0.0)")
    p.add_argument("--port", type=int, default=9170)
    p.add_argument("--schedule-file", default="/var/lib/doorman/schedule.json", help="the daemon's wake times survive a restart here")
    p.add_argument("--bursts-file", default="/var/lib/doorman/bursts.jsonl", help="one line per wake burst, read by the watcher")
    a = p.parse_args(argv)
    if a.bind in ("0.0.0.0", "::"):
        print("refusing to bind a wildcard address", file=sys.stderr)
        return 2
    d = Doorman(load_targets(a.targets), real_send_wake, real_probe_up, time.time, real_schedule_later)
    os.makedirs(os.path.dirname(a.schedule_file), exist_ok=True)
    d.schedule_path = a.schedule_file
    os.makedirs(os.path.dirname(a.bursts_file), exist_ok=True)
    d.record = jsonl_recorder(a.bursts_file)  # before load_schedule: a missed time fires at once and is a burst too
    d.load_schedule()
    srv = serve(a.bind, a.port, d)
    print("doorman listening on %s:%d targets=%s" % (a.bind, a.port, list(d.targets)), file=sys.stderr)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
