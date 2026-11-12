"""watcher — the always-on part of the metasystem: memory, the model and the daily note.

Runs on the doorman beside doorman.py and naswatch.py (Ubuntu, Tailscale 100.110.117.10), as its own
systemd unit. Python 3 standard library only. Design: docs/decisions/2026-11-11-metasystem-design.md
(slice 1: observation only; nothing here acts on any box).

It never asks a box for anything. Each box pushes its own state (`POST /push`), so watching cannot wake
a sleeping box and nothing new listens on a working one. Its own box's facts it reads from files the
doorman already writes: the burst journal and the wake schedule.

  POST /push                 {"v":1,"box":name,"sentAt":iso,"records":[sample|event,...]} -> counts
  GET  /                     the note for today (the owner's local day)
  GET  /day/YYYY-MM-DD       the note for that day
  GET  /findings.json?day=   the same findings as data (same ids as the page)
  GET  /healthz              {"ok":true}

Bound to the Tailscale address only; no authentication beyond the tailnet, as the doorman's own
routes. The page takes no input. What is stored is bounded per request (1 MiB, 500 records) and
samples older than 90 days are pruned.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import watchmodel  # noqa: E402
import watchnote  # noqa: E402
from watchstore import Store  # noqa: E402

MAX_BODY_BYTES = 1 << 20
MAX_RECORDS = 500
DRAIN_LIMIT_BYTES = 16 << 20  # an oversized body up to this is read and dropped before the 413
INGEST_EVERY_S = 15.0
PRUNE_EVERY_S = 86400.0


def local_offset_min(at: float) -> int:
    """This machine's offset from UTC, in minutes, at that moment (the doorman keeps the owner's zone)."""
    return int((time.localtime(at).tm_gmtoff or 0) // 60)


def ingest_doorman_files(store: Store, bursts_file: Optional[str], schedule_file: Optional[str], now: float) -> int:
    """Read what the doorman wrote since last time into events of the box `doorman`. Returns how many were new.

    The burst journal is read by byte offset, whole lines only; a file that got shorter was rewritten
    (the doorman trims it) and is read again from the start, which stores nothing twice. The schedule
    is recorded whenever the file changes.
    """
    added = 0
    if bursts_file:
        try:
            size = os.path.getsize(bursts_file)
        except OSError:
            size = None
        if size is not None:
            offset = int(store.meta("bursts.offset", 0) or 0)
            if size < offset:
                offset = 0
            if size > offset:
                with open(bursts_file, "rb") as f:
                    f.seek(offset)
                    chunk = f.read()
                end = chunk.rfind(b"\n")
                if end >= 0:
                    records = []
                    for line in chunk[:end].split(b"\n"):
                        try:
                            r = json.loads(line)
                            at = float(r["at"])
                            target = str(r["target"])
                        except (ValueError, KeyError, TypeError):
                            continue  # a torn or foreign line: skipped, the offset still moves past it
                        records.append({"t": "event", "at": at, "kind": "doorman.burst", "key": "%s:%.3f" % (target, at),
                                        "data": {"target": target, "cause": r.get("cause"), "forAt": r.get("forAt")}})
                    added += store.add(watchmodel.DOORMAN_BOX, records, now)["stored"]
                    store.set_meta("bursts.offset", offset + end + 1)
    if schedule_file:
        try:
            mtime = os.stat(schedule_file).st_mtime
        except OSError:
            mtime = None
        if mtime is not None and mtime != store.meta("schedule.mtime"):
            try:
                with open(schedule_file, "r", encoding="utf-8") as f:
                    targets = json.load(f)
            except (OSError, ValueError):
                targets = None  # mid-write: read it at the next look
            if isinstance(targets, dict):
                added += store.add(watchmodel.DOORMAN_BOX, [{"t": "event", "at": mtime, "kind": "doorman.schedule", "key": "%.3f" % mtime, "data": {"targets": targets}}], now)["stored"]
                store.set_meta("schedule.mtime", mtime)
    return added


def _make_handler(store: Store, now: Callable[[], float], tz_offset_min: Optional[int]):
    def offset(at: float) -> int:
        return tz_offset_min if tz_offset_min is not None else local_offset_min(at)

    class Handler(BaseHTTPRequestHandler):
        server_version = "watcher/1"

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _report(self, day: str):
            t = now()
            return watchmodel.day_report(store, day, t, offset(t))

        def do_GET(self) -> None:  # noqa: N802
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            t = now()
            today = watchmodel.day_of(t, offset(t))
            try:
                if url.path == "/":
                    self._send(200, watchnote.render(self._report(today)).encode("utf-8"), "text/html; charset=utf-8")
                elif url.path.startswith("/day/"):
                    self._send(200, watchnote.render(self._report(url.path[len("/day/"):])).encode("utf-8"), "text/html; charset=utf-8")
                elif url.path == "/findings.json":
                    self._json(200, watchnote.findings_json(self._report((q.get("day") or [today])[0])))
                elif url.path == "/healthz":
                    self._json(200, {"ok": True})
                elif url.path == "/push":
                    self._json(405, {"error": "POST only"})
                else:
                    self._json(404, {"error": "not found"})
            except ValueError:
                self._json(404, {"error": "no such day"})

        def do_POST(self) -> None:  # noqa: N802
            if urllib.parse.urlparse(self.path).path != "/push":
                self._json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                self._json(411, {"error": "Content-Length required"})
                return
            if length < 0 or length > MAX_BODY_BYTES:
                # Read it off the socket in pieces and keep none of it, so the sender gets the answer
                # instead of a reset; far past the bound the connection is simply closed.
                left = length if 0 < length <= DRAIN_LIMIT_BYTES else 0
                while left > 0:
                    got = self.rfile.read(min(left, 65536))
                    if not got:
                        break
                    left -= len(got)
                self.close_connection = True
                self._json(413, {"error": "body over %d bytes" % MAX_BODY_BYTES})
                return
            try:
                body = json.loads(self.rfile.read(length) or b"null")
            except ValueError:
                self._json(400, {"error": "not JSON"})
                return
            records = body.get("records") if isinstance(body, dict) else None
            if not isinstance(records, list):
                self._json(400, {"error": "records must be a list"})
                return
            if len(records) > MAX_RECORDS:
                self._json(400, {"error": "more than %d records in one push" % MAX_RECORDS})
                return
            try:
                got = store.add(body.get("box"), records, now())
            except ValueError as err:
                self._json(400, {"error": str(err)})
                return
            self._json(200, {"ok": True, **got})

        def log_message(self, fmt, *args) -> None:  # journald gets one line per request
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    return Handler


def serve(bind_ip: str, port: int, store: Store, now: Callable[[], float] = time.time, tz_offset_min: Optional[int] = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((bind_ip, port), _make_handler(store, now, tz_offset_min))


def keep_reading(store: Store, bursts_file: Optional[str], schedule_file: Optional[str], stop: threading.Event, every_s: float = INGEST_EVERY_S) -> None:
    """The background loop: the doorman's files into the store, and a prune once a day. Never dies."""
    last_prune = 0.0
    while not stop.is_set():
        t = time.time()
        try:
            ingest_doorman_files(store, bursts_file, schedule_file, t)
            if t - last_prune >= PRUNE_EVERY_S:
                store.prune(t)
                last_prune = t
        except Exception as err:  # a locked or unreadable file is tried again at the next look
            print("watcher: reading the doorman's files failed: %s" % err, file=sys.stderr)
        stop.wait(every_s)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="CynCo watcher: boxes push their state, the doorman keeps it and serves the daily note")
    p.add_argument("--bind", required=True, help="Tailscale address to bind (never 0.0.0.0)")
    p.add_argument("--port", type=int, default=9171)
    p.add_argument("--db", default="/var/lib/cynco-watcher/watch.db")
    p.add_argument("--bursts-file", default="/var/lib/doorman/bursts.jsonl", help="the doorman's burst journal ('' = none)")
    p.add_argument("--schedule-file", default="/var/lib/doorman/schedule.json", help="the doorman's wake schedule ('' = none)")
    p.add_argument("--tz-offset-min", type=int, default=None, help="the owner's offset from UTC in minutes (default: this machine's own zone)")
    a = p.parse_args(argv)
    if a.bind in ("0.0.0.0", "::", ""):
        print("refusing to bind a wildcard address", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(a.db)), exist_ok=True)
    store = Store(a.db)
    stop = threading.Event()
    threading.Thread(target=keep_reading, args=(store, a.bursts_file or None, a.schedule_file or None, stop), daemon=True).start()
    srv = serve(a.bind, a.port, store, tz_offset_min=a.tz_offset_min)
    print("watcher listening on %s:%d db=%s" % (a.bind, srv.server_address[1], a.db), file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
