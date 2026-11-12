"""journal_bursts — the doorman's wake bursts, read back out of its systemd journal.

The doorman writes each burst to its burst journal since metasystem slice 1 (`doorman.jsonl_recorder`).
For the days before that, and for the 2026-11-11 fixture, the same facts are in the system journal:
every wake packet is a `sudo ... etherwake -i <iface> <MAC>` line and every phone knock a `GET /wake`
line. This module turns that text into the records the burst journal holds.

    sudo journalctl -u doorman --utc -o short-iso -q --since "2026-11-11 00:00:00 UTC" \
      | python3 journal_bursts.py --targets /etc/doorman/targets.json >> /var/lib/doorman/bursts.jsonl

Python 3 standard library only. Pure: `parse` takes lines and returns records.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from typing import Dict, Iterable, List, Optional

BURST_GAP_S = 60.0  # a packet more than this after the last one for the same MAC starts a new burst
KNOCK_WINDOW_S = 2.0  # a `GET /wake` this close before a burst's first packet caused it

_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:?\d{2}|Z)?\s")
_ETHERWAKE = re.compile(r"COMMAND=\S*etherwake\b.*?\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b")
_WAKE_REQUEST = re.compile(r'"GET /wake(?:\?[^" ]*)? HTTP')
_TARGET_PARAM = re.compile(r"[?&]target=([A-Za-z0-9_.-]+)")


def _epoch(line: str) -> Optional[float]:
    m = _STAMP.match(line)
    if not m:
        return None
    zone = m.group(2) or "+00:00"
    if zone == "Z":
        zone = "+00:00"
    if ":" not in zone:
        zone = zone[:3] + ":" + zone[3:]
    try:
        return _dt.datetime.fromisoformat(m.group(1) + zone).timestamp()
    except ValueError:
        return None


def iso(at: float) -> str:
    return _dt.datetime.fromtimestamp(at, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(
    lines: Iterable[str],
    mac_to_target: Dict[str, str],
    companions: Optional[Dict[str, List[str]]] = None,
    default_target: str = "main",
) -> List[dict]:
    """Burst records `{"at", "target", "cause", "forAt"}` in time order.

    `cause` is `knock` when a `GET /wake` for that target came at most KNOCK_WINDOW_S before the first
    packet, `with:<name>` for a companion (`companions[name]` lists it) woken by that target's burst,
    else `schedule`: the doorman sends packets for nothing but a knock or a scheduled time. `forAt` is
    not in the journal: None.
    """
    companions = companions or {}
    macs = {k.upper(): v for k, v in mac_to_target.items()}
    last_packet: Dict[str, float] = {}
    knocks: List[tuple] = []  # (at, target)
    out: List[dict] = []
    for line in lines:
        at = _epoch(line)
        if at is None:
            continue
        if _WAKE_REQUEST.search(line):
            t = _TARGET_PARAM.search(line)
            knocks.append((at, t.group(1) if t else default_target))
            continue
        m = _ETHERWAKE.search(line)
        if not m:
            continue
        target = macs.get(m.group(1).upper())
        if target is None:
            continue
        prev = last_packet.get(target)
        last_packet[target] = at
        if prev is not None and at - prev <= BURST_GAP_S:
            continue
        cause = "schedule"
        if any(kt == target and 0 <= at - ka <= KNOCK_WINDOW_S for ka, kt in knocks):
            cause = "knock"
        out.append({"at": at, "target": target, "cause": cause, "forAt": None})
    # A companion's burst starts within a second or two of the burst that woke it.
    by_time = sorted(out, key=lambda b: b["at"])
    for b in by_time:
        if b["cause"] != "schedule":
            continue
        for other in by_time:
            if other is b or other["target"] == b["target"] or abs(other["at"] - b["at"]) > 2.0:
                continue
            if b["target"] in companions.get(other["target"], ()):
                b["cause"] = "with:" + other["target"]
                break
    return by_time


def maps_from_targets(targets: dict) -> tuple:
    """(MAC -> target, target -> companions) from a targets.json object."""
    macs = {str(v["mac"]).upper(): name for name, v in targets.items()}
    companions = {name: list(v.get("with", [])) for name, v in targets.items()}
    return macs, companions


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="doorman journal text on stdin -> burst records (JSON lines) on stdout")
    p.add_argument("--targets", default="/etc/doorman/targets.json")
    a = p.parse_args(argv)
    with open(a.targets, "r", encoding="utf-8") as f:
        macs, companions = maps_from_targets(json.load(f))
    for b in parse(sys.stdin, macs, companions):
        sys.stdout.write(json.dumps(b) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
