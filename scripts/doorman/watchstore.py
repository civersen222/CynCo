"""watchstore — the watcher's memory: one SQLite file on the doorman.

Design: docs/decisions/2026-11-11-metasystem-design.md (slice 1). Every box pushes samples (its state
on a beat) and events (a change, with the time it happened); the doorman's own wake bursts and schedule
are events of the box `doorman`. A record is stored under the time it describes, never the time it
arrived: a PC reports its sleep after it wakes, and a backlog arrives hours late.

A push that is repeated stores nothing twice: samples are unique on (box, at), events on
(box, kind, key). Python 3 standard library only.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import json
import re
import sqlite3
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

SAMPLE_DAYS = 90  # samples older than this are pruned; events are kept
BOX_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  box TEXT NOT NULL, at REAL NOT NULL, received_at REAL NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (box, at)
);
CREATE TABLE IF NOT EXISTS events (
  box TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
  received_at REAL NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (box, kind, key)
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def parse_iso(s: Any) -> float:
    """ISO 8601 to epoch seconds. A time without a zone is UTC. Raises ValueError on anything else."""
    if isinstance(s, (int, float)) and not isinstance(s, bool):
        return float(s)
    if not isinstance(s, str):
        raise ValueError("not a time: %r" % (s,))
    t = s.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    # Python 3.12's fromisoformat takes up to microseconds; Windows writes seven fractional digits.
    t = re.sub(r"(\.\d{6})\d+", r"\1", t)
    d = _dt.datetime.fromisoformat(t)
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return d.timestamp()


def iso(at: float) -> str:
    return _dt.datetime.fromtimestamp(at, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(_SCHEMA)

    @contextlib.contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        # One connection per call: the HTTP server answers on threads and SQLite connections are not shared.
        # sqlite3's own context manager commits and does not close, so this one does both.
        c = sqlite3.connect(self.path, timeout=10)
        try:
            c.execute("PRAGMA busy_timeout=10000")
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    # ---- writing -------------------------------------------------------------
    def add(self, box: str, records: Iterable[Any], received_at: float) -> Dict[str, int]:
        """Store a push's records. Returns how many were stored, were already there, or were refused."""
        if not isinstance(box, str) or not BOX_NAME.match(box):
            raise ValueError("bad box name")
        stored = duplicates = rejected = 0
        with self._conn() as c:
            for r in records:
                try:
                    if not isinstance(r, dict):
                        raise ValueError("not an object")
                    at = parse_iso(r.get("at"))
                    if r.get("t") == "sample":
                        body = {k: v for k, v in r.items() if k not in ("t", "at")}
                        cur = c.execute(
                            "INSERT OR IGNORE INTO samples (box, at, received_at, body) VALUES (?,?,?,?)",
                            (box, at, received_at, json.dumps(body, separators=(",", ":"))),
                        )
                    elif r.get("t") == "event":
                        kind = r.get("kind")
                        if not isinstance(kind, str) or not kind or len(kind) > 64:
                            raise ValueError("bad kind")
                        key = r.get("key")
                        if not isinstance(key, str) or not key:
                            key = iso(at)
                        data = r.get("data")
                        cur = c.execute(
                            "INSERT OR IGNORE INTO events (box, at, kind, key, received_at, data) VALUES (?,?,?,?,?,?)",
                            (box, at, kind, key[:200], received_at, json.dumps(data if isinstance(data, dict) else {}, separators=(",", ":"))),
                        )
                    else:
                        raise ValueError("unknown record type")
                except (ValueError, TypeError, OverflowError):
                    rejected += 1
                    continue
                if cur.rowcount == 1:
                    stored += 1
                else:
                    duplicates += 1
        return {"stored": stored, "duplicates": duplicates, "rejected": rejected}

    def set_meta(self, key: str, value: Any) -> None:
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)", (key, json.dumps(value)))

    def prune(self, now: float, sample_days: int = SAMPLE_DAYS) -> int:
        with self._conn() as c:
            return c.execute("DELETE FROM samples WHERE at < ?", (now - sample_days * 86400.0,)).rowcount

    # ---- reading -------------------------------------------------------------
    def samples(self, box: str, t0: float, t1: float) -> List[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT at, body FROM samples WHERE box = ? AND at >= ? AND at < ? ORDER BY at", (box, t0, t1)).fetchall()
        out = []
        for at, body in rows:
            d = json.loads(body)
            d["at"] = at
            out.append(d)
        return out

    def events(self, t0: float, t1: float, box: Optional[str] = None, kinds: Optional[Iterable[str]] = None) -> List[dict]:
        sql = "SELECT box, at, kind, key, data FROM events WHERE at >= ? AND at < ?"
        args: List[Any] = [t0, t1]
        if box is not None:
            sql += " AND box = ?"
            args.append(box)
        kinds = list(kinds) if kinds is not None else None
        if kinds:
            sql += " AND kind IN (%s)" % ",".join("?" * len(kinds))
            args.extend(kinds)
        with self._conn() as c:
            rows = c.execute(sql + " ORDER BY at, kind, key", args).fetchall()
        return [{"box": b, "at": at, "kind": kind, "key": key, "data": json.loads(data)} for b, at, kind, key, data in rows]

    def boxes(self) -> List[str]:
        with self._conn() as c:
            rows = c.execute("SELECT box FROM samples UNION SELECT box FROM events ORDER BY 1").fetchall()
        return [r[0] for r in rows]

    def last_seen(self, box: str) -> Optional[float]:
        """When the box last pushed anything (arrival time, the doorman's clock)."""
        with self._conn() as c:
            a = c.execute("SELECT MAX(received_at) FROM samples WHERE box = ?", (box,)).fetchone()[0]
            b = c.execute("SELECT MAX(received_at) FROM events WHERE box = ?", (box,)).fetchone()[0]
        seen = [x for x in (a, b) if x is not None]
        return max(seen) if seen else None

    def span(self) -> Optional[Tuple[float, float]]:
        """The earliest and latest time any record describes, or None for an empty store."""
        with self._conn() as c:
            lo = [x for x in (c.execute("SELECT MIN(at) FROM samples").fetchone()[0], c.execute("SELECT MIN(at) FROM events").fetchone()[0]) if x is not None]
            hi = [x for x in (c.execute("SELECT MAX(at) FROM samples").fetchone()[0], c.execute("SELECT MAX(at) FROM events").fetchone()[0]) if x is not None]
        return (min(lo), max(hi)) if lo and hi else None

    def meta(self, key: str, default: Any = None) -> Any:
        with self._conn() as c:
            row = c.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default
