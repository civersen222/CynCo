"""watchmodel — what the watcher makes of its memory. Pure and deterministic: records in, report out.

Design: docs/decisions/2026-11-11-metasystem-design.md (slice 1, "The watch loop").

Two kinds of finding, as the design defines them:

  wrong by construction   needs no history and works on the first day: a wake with no doorman burst
                          behind it, a service something depends on not answering, a model loaded
                          with nothing using it, a box that went silent without saying why.
  wrong by comparison     needs a baseline: each new reading of a series is classed as noise, a
                          transient, a change of slope or a step (Beer's Cyberstride filter; a rolling
                          median and a CUSUM detector here). Only a slope or a step is a finding, and a
                          series without enough history says "still learning" and flags nothing.

Nothing here reads a clock, a file or a socket; `watcher.py` hands it records from `watchstore`.
Python 3 standard library only.
"""
from __future__ import annotations

import datetime as _dt
import statistics
from typing import Any, Dict, List, Optional, Tuple

from watchstore import iso, parse_iso

# ---- constants: every sensitivity of the watch loop is here, in one place ---------------------
WAKE_MATCH_BEFORE_S = 120.0  # a burst that started this long before a wake is behind it
WAKE_MATCH_AFTER_S = 5.0  # clock difference between the box and the doorman
OWNER_WOKE_WITHIN_S = 120.0  # a sample this soon after a wake can show the owner's own input
SERVICE_DOWN_MIN_S = 180.0  # shorter than this is a restart, not an outage
MODEL_UNUSED_MIN_S = 1200.0  # the phone engine's own idle unload is 15 minutes; longer is nobody's plan
SILENT_GAP_S = 300.0  # a box that is awake reports every minute
SLEEP_SETTLE_S = 30.0  # a sample this long after a sleep began was sent after the box woke again
NEED_IDLE_S = 300.0  # input within this long means the owner is at the box

WINDOW = 30  # readings in the rolling baseline
MIN_READINGS = 12  # a series speaks after this many readings ...
MIN_SPAN_DAYS = 3.0  # ... spread over at least this long
Z_OUT = 3.0  # robust sigmas beyond which a reading is not noise
SUSTAIN = 3  # this many in a row on one side is a step
CUSUM_K = 0.5  # slack, in sigmas (engine/cybernetics-core/src/metrics/index.ts)
CUSUM_H = 5.0  # threshold, in sigmas
HISTORY_DAYS = 21  # how far back the comparison looks

DOORMAN_BOX = "doorman"


# ---- the timeline -----------------------------------------------------------------------------
def _power_intervals(events: List[dict], box: str, sample_times: Optional[List[float]] = None) -> Tuple[List[dict], List[dict]]:
    """(asleep, off) intervals from one box's power events, each {"from","to","reason"|"open"}."""
    mine = sorted((e for e in events if e["box"] == box and e["kind"].startswith("power.")), key=lambda e: e["at"])
    asleep: List[dict] = []
    covered_sleeps: List[float] = []
    for e in mine:
        if e["kind"] != "power.wake":
            continue
        try:
            sleep_at = parse_iso(e["data"].get("sleepAt"))
        except ValueError:
            continue
        if sleep_at >= e["at"]:
            continue
        reason = next((s["data"].get("reason") for s in mine if s["kind"] == "power.sleep" and abs(s["at"] - sleep_at) <= 10.0), None)
        asleep.append({"from": sleep_at, "to": e["at"], "reason": reason, "wake": e})
        covered_sleeps.append(sleep_at)
    # A sleep nobody has reported the end of yet: asleep from then on (closed by the caller's horizon),
    # or until the box is heard from again. Its wake is written up a moment after it resumes, so its
    # first samples can arrive before the wake does; a box that is sending samples is not asleep.
    for s in mine:
        if s["kind"] == "power.sleep" and not any(abs(s["at"] - c) <= 10.0 for c in covered_sleeps):
            later = [x["at"] for x in mine if x["at"] > s["at"] and x["kind"] in ("power.wake", "power.boot")]
            later += [t for t in (sample_times or []) if t > s["at"] + SLEEP_SETTLE_S]
            asleep.append({"from": s["at"], "to": min(later) if later else None, "reason": s["data"].get("reason"), "wake": None})
    off: List[dict] = []
    downs = [e for e in mine if e["kind"] == "power.shutdown"]
    boots = [e for e in mine if e["kind"] == "power.boot"]
    for d in downs:
        nxt = [b["at"] for b in boots if b["at"] > d["at"]]
        off.append({"from": d["at"], "to": min(nxt) if nxt else None, "reason": d["data"].get("reason")})
    return asleep, off


def timeline(samples: List[dict], events: List[dict], box: str, t0: float, t1: float, now: float) -> List[dict]:
    """The box's state over [t0, min(t1, now)) as segments {"state","from","to","basis"}.

    States: `asleep` and `off` come from the box's own power events; `awake` from its samples, and from
    a wake that ends in a sleep with nothing in between; `silent` is a gap in the samples that no sleep
    or shutdown covers; `unknown` is time nothing was reported about.
    """
    end = min(t1, now)
    if end <= t0:
        return []
    asleep, off = _power_intervals(events, box, [x["at"] for x in samples])
    explicit: List[dict] = []
    for iv, state in [(a, "asleep") for a in asleep] + [(o, "off") for o in off]:
        a, b = iv["from"], iv["to"] if iv["to"] is not None else end
        if b <= t0 or a >= end:
            continue
        basis = "the box's System log"
        if state == "asleep" and iv.get("reason"):
            basis += " (sleep reason: %s)" % iv["reason"]
        explicit.append({"state": state, "from": max(a, t0), "to": min(b, end), "basis": basis, "_from": a, "_to": iv["to"], "_reason": iv.get("reason")})
    explicit.sort(key=lambda s: s["from"])
    merged: List[dict] = []
    for s in explicit:  # overlapping reports of the same stretch
        if merged and s["from"] < merged[-1]["to"]:
            if s["to"] > merged[-1]["to"]:
                s = dict(s)
                s["from"] = merged[-1]["to"]
            else:
                continue
        merged.append(s)
    explicit = merged

    times = sorted(x["at"] for x in samples if t0 - SILENT_GAP_S <= x["at"] < end)
    out: List[dict] = []
    cursor = t0
    bounds = explicit + [None]
    prev: Optional[dict] = None
    for nxt in bounds:
        a, b = cursor, (nxt["from"] if nxt else end)
        if b > a:
            left_is_wake = prev is not None and prev["_to"] is not None and prev["_to"] >= t0 - 1
            right_is_sleep = nxt is not None and nxt["_from"] >= a
            inside = [t for t in times if a <= t < b]
            before = [t for t in times if t < a]
            if not inside:
                if left_is_wake and right_is_sleep:
                    why = "idle sleep" if nxt["state"] == "asleep" and nxt.get("_reason") == "idle" else "between a wake and the next %s" % ("sleep" if nxt["state"] == "asleep" else "shutdown")
                    out.append({"state": "awake", "from": a, "to": b, "basis": why})
                elif before and a - before[-1] <= SILENT_GAP_S and b - before[-1] <= SILENT_GAP_S:
                    out.append({"state": "awake", "from": a, "to": b, "basis": "samples"})
                elif before and a - before[-1] <= SILENT_GAP_S:
                    out.append({"state": "silent", "from": a, "to": b, "basis": "no sample since %s" % iso(before[-1])})
                else:
                    out.append({"state": "unknown", "from": a, "to": b, "basis": "nothing was reported"})
            else:
                first = inside[0]
                lead_ok = (first - a <= SILENT_GAP_S) or (before and first - before[-1] <= SILENT_GAP_S)
                if first > a:
                    if lead_ok:
                        out.append({"state": "awake", "from": a, "to": first, "basis": "samples"})
                    elif left_is_wake or (before and a - before[-1] <= SILENT_GAP_S):
                        out.append({"state": "silent", "from": a, "to": first, "basis": "no sample until %s" % iso(first)})
                    else:
                        out.append({"state": "unknown", "from": a, "to": first, "basis": "nothing was reported"})
                for i in range(len(inside) - 1):
                    s, e = inside[i], inside[i + 1]
                    out.append({"state": "awake" if e - s <= SILENT_GAP_S else "silent", "from": s, "to": e, "basis": "samples" if e - s <= SILENT_GAP_S else "no sample since %s" % iso(s)})
                last = inside[-1]
                if b > last:
                    if b - last <= SILENT_GAP_S:
                        out.append({"state": "awake", "from": last, "to": b, "basis": "samples"})
                    else:
                        out.append({"state": "silent", "from": last, "to": b, "basis": "no sample since %s" % iso(last)})
        if nxt:
            out.append({k: v for k, v in nxt.items() if not k.startswith("_")})
            cursor = nxt["to"]
            prev = nxt
    # join neighbours in the same state
    joined: List[dict] = []
    for s in out:
        if s["to"] <= s["from"]:
            continue
        if joined and joined[-1]["state"] == s["state"] and abs(joined[-1]["to"] - s["from"]) < 1e-6:
            joined[-1]["to"] = s["to"]
        else:
            joined.append(dict(s))
    return joined


# ---- wakes ------------------------------------------------------------------------------------
def wakes(samples: List[dict], events: List[dict], box: str, t0: float, t1: float) -> List[dict]:
    """Every wake of the box in [t0, t1) with what, if anything, was behind it.

    Windows' own wake source is carried and never trusted: on 2026-11-11 eight wakes by network traffic
    all read "Power Button" (F221). A wake is explained by a doorman burst for this box, or by the
    owner's own input at the moment of the wake.
    """
    bursts = [e for e in events if e["box"] == DOORMAN_BOX and e["kind"] == "doorman.burst" and e["data"].get("target") == box]
    out = []
    for e in sorted((e for e in events if e["box"] == box and e["kind"] == "power.wake" and t0 <= e["at"] < t1), key=lambda e: e["at"]):
        at = e["at"]
        why = None
        behind = [b for b in bursts if at - WAKE_MATCH_BEFORE_S <= b["at"] <= at + WAKE_MATCH_AFTER_S]
        if behind:
            b = max(behind, key=lambda b: b["at"])
            cause = b["data"].get("cause") or "burst"
            label = {"knock": "a knock on the doorman", "schedule": "a scheduled job's wake"}.get(cause, "the doorman (%s)" % cause)
            why = {"by": cause, "text": "%s at %s" % (label, iso(b["at"])), "at": b["at"], "forAt": b["data"].get("forAt")}
        else:
            for s in samples:
                if at <= s["at"] <= at + OWNER_WOKE_WITHIN_S and isinstance(s.get("idleS"), (int, float)) and s["at"] - s["idleS"] >= at - WAKE_MATCH_AFTER_S:
                    why = {"by": "owner", "text": "keyboard or mouse input at %s" % iso(s["at"] - s["idleS"]), "at": s["at"] - s["idleS"], "forAt": None}
                    break
        sleep_at = None
        try:
            sleep_at = parse_iso(e["data"].get("sleepAt"))
        except ValueError:
            sleep_at = None
        out.append({"at": at, "sleepAt": sleep_at, "source": e["data"].get("source") or "not given", "explained": why})
    return out


# ---- services, models, holders ----------------------------------------------------------------
def _dt_after(samples: List[dict], i: int) -> float:
    """The time a sample stands for: until the next one, and nothing across a gap."""
    if i + 1 >= len(samples):
        return 0.0
    d = samples[i + 1]["at"] - samples[i]["at"]
    return d if 0 < d <= SILENT_GAP_S else 0.0


def service_names(samples: List[dict], events: List[dict], box: str) -> List[str]:
    names = []
    for s in samples:
        for sv in s.get("services") or []:
            if isinstance(sv, dict) and sv.get("name") and sv["name"] not in names:
                names.append(sv["name"])
    for e in events:
        if e["box"] == box and e["kind"] in ("service.said_down", "service.said_up"):
            n = e["data"].get("service")
            if n and n not in names:
                names.append(n)
    return names


def service_observations(samples: List[dict], events: List[dict], box: str, name: str) -> List[dict]:
    """What was seen of one service, in time order: {"at","up","wanted","by","said"}.

    A sample is the box's own look at the port. `service.said_down` / `said_up` are the dependent's own
    words (the engine saying its embedding endpoint did not answer): a state that holds until the
    next observation.
    """
    obs = []
    for s in samples:
        for sv in s.get("services") or []:
            if isinstance(sv, dict) and sv.get("name") == name and isinstance(sv.get("up"), bool):
                obs.append({"at": s["at"], "up": sv["up"], "wanted": bool(sv.get("wanted")), "by": sv.get("by") or "", "said": None})
    for e in events:
        if e["box"] == box and e["kind"] in ("service.said_down", "service.said_up") and e["data"].get("service") == name:
            obs.append({"at": e["at"], "up": e["kind"] == "service.said_up", "wanted": True, "by": e["data"].get("by") or "", "said": e["data"]})
    obs.sort(key=lambda o: (o["at"], 0 if o["said"] else 1))
    return obs


def service_bands(samples: List[dict], events: List[dict], box: str, name: str, segments: List[dict], end: float) -> List[dict]:
    """One service as stretches {"state": "up"|"down"|"idle", "from", "to", ...}; `idle` = not wanted.

    A stretch ends where the next observation begins or where the box stopped being awake (asleep,
    off, or silent: it is not "not answering while wanted" when the box itself is not there).
    """
    obs = service_observations(samples, events, box, name)
    not_awake = [g for g in segments if g["state"] in ("asleep", "off", "silent")]
    bands: List[dict] = []
    for i, o in enumerate(obs):
        nxt = obs[i + 1]["at"] if i + 1 < len(obs) else end
        stop = nxt
        if not (o["said"] and not o["up"]):
            # Only "it does not answer", in the dependent's own words, is a state that holds until
            # somebody says otherwise. One look at the port, or "it is back", stands for the minutes
            # after it and not for the hours: the band ends there and the rest is not drawn.
            stop = min(stop, o["at"] + SILENT_GAP_S)
        for g in not_awake:  # a silent stretch starts at the last sample
            if g["from"] >= o["at"] and g["from"] < stop:
                stop = g["from"]
        state = "idle" if not o["wanted"] else ("up" if o["up"] else "down")
        closed_by_up = i + 1 < len(obs) and stop == nxt
        closer = obs[i + 1]["said"] if closed_by_up else None  # the words that ended it, when words did
        if bands and bands[-1]["state"] == state and abs(bands[-1]["to"] - o["at"]) < 1e-6:
            bands[-1]["to"] = stop
            bands[-1]["observed"] += 1
            bands[-1]["closed"] = closed_by_up
            bands[-1]["closedSaid"] = closer
        else:
            bands.append({"state": state, "from": o["at"], "to": stop, "by": o["by"], "said": o["said"], "observed": 1, "closed": closed_by_up, "closedSaid": closer})
    return [b for b in bands if b["to"] > b["from"] or b["state"] == "down"]


def model_bands(samples: List[dict]) -> List[dict]:
    """Stretches in which a model was loaded: {"model","server","from","to","unusedS","loadedS"}."""
    out: List[dict] = []
    open_: Dict[str, dict] = {}
    for i, s in enumerate(samples):
        d = _dt_after(samples, i)
        present = set()
        for m in s.get("models") or []:
            if not isinstance(m, dict) or not m.get("name"):
                continue
            key = "%s|%s" % (m.get("server") or "", m["name"])
            present.add(key)
            b = open_.get(key)
            if b is None:
                b = open_[key] = {"model": m["name"], "server": m.get("server") or "", "from": s["at"], "to": s["at"], "unusedS": 0.0, "loadedS": 0.0, "idleRunS": 0.0, "idleRunFrom": None, "longestIdleS": 0.0, "longestIdleFrom": None}
            b["to"] = s["at"] + d
            b["loadedS"] += d
            if m.get("busy") is False:  # None = could not tell: never counted as unused
                b["unusedS"] += d
                if b["idleRunFrom"] is None:
                    b["idleRunFrom"] = s["at"]
                b["idleRunS"] += d
                if b["idleRunS"] > b["longestIdleS"]:
                    b["longestIdleS"], b["longestIdleFrom"] = b["idleRunS"], b["idleRunFrom"]
            else:
                b["idleRunS"], b["idleRunFrom"] = 0.0, None
        for key in list(open_):
            if key not in present or d == 0.0:
                out.append(open_.pop(key))
    out.extend(open_.values())
    return sorted(out, key=lambda b: b["from"])


def holder_bands(samples: List[dict]) -> List[dict]:
    """Who held the GPU by CynCo's own reckoning, as stretches {"unit","from","to"}."""
    out: List[dict] = []
    for i, s in enumerate(samples):
        h = s.get("holder")
        unit = h.get("unit") if isinstance(h, dict) else None
        d = _dt_after(samples, i)
        if not unit or d == 0.0:
            continue
        if out and out[-1]["unit"] == unit and abs(out[-1]["to"] - s["at"]) < 1e-6:
            out[-1]["to"] = s["at"] + d
        else:
            out.append({"unit": unit, "from": s["at"], "to": s["at"] + d})
    return out


# ---- measures ---------------------------------------------------------------------------------
def _needed(s: dict) -> Optional[bool]:
    """Did anything need the box at this sample? None when the sample cannot say."""
    eng = s.get("engine") if isinstance(s.get("engine"), dict) else {}
    if eng.get("processing") or (eng.get("open") or []):
        return True
    h = s.get("holder") if isinstance(s.get("holder"), dict) else {}
    if str(h.get("unit") or "").startswith("oneshot"):
        return True
    if any(isinstance(m, dict) and m.get("busy") is True for m in s.get("models") or []):
        return True
    idle = s.get("idleS")
    if isinstance(idle, (int, float)):
        return idle < NEED_IDLE_S
    return None


def measures(samples: List[dict], events: List[dict], box: str, segments: List[dict], t0: float, t1: float) -> dict:
    """The design's measures on a 0 to 1 scale. A value is None when there was nothing to measure."""
    asleep_s = sum(g["to"] - g["from"] for g in segments if g["state"] == "asleep")
    inferred_s = sum(g["to"] - g["from"] for g in segments if g["state"] == "awake" and g["basis"] == "idle sleep")
    idle_awake_s = 0.0
    sampled_s = 0.0
    inside = [s for s in samples if t0 <= s["at"] < t1]
    for i, s in enumerate(inside):
        d = _dt_after(inside, i)
        need = _needed(s)
        if need is None:
            continue
        sampled_s += d
        if need is False:
            idle_awake_s += d
    not_needed = asleep_s + inferred_s + idle_awake_s
    loaded = sum(b["loadedS"] for b in model_bands(inside))
    unused = sum(b["unusedS"] for b in model_bands(inside))
    answering = {}
    for name in service_names(inside, events, box):
        wanted_s = up_s = 0.0
        for i, s in enumerate(inside):
            d = _dt_after(inside, i)
            for sv in s.get("services") or []:
                if isinstance(sv, dict) and sv.get("name") == name and sv.get("wanted") and isinstance(sv.get("up"), bool):
                    wanted_s += d
                    up_s += d if sv["up"] else 0.0
        answering[name] = {"value": (up_s / wanted_s) if wanted_s > 0 else None, "upS": up_s, "wantedS": wanted_s}
    jobs: Dict[str, dict] = {}
    for e in events:
        if e["box"] == box and e["kind"] == "job.run" and t0 <= e["at"] < t1:
            k = "%s/%s" % (e["data"].get("mission") or "?", e["data"].get("triggerId") or "?")
            j = jobs.setdefault(k, {"runs": 0, "ok": 0, "rate": None})
            j["runs"] += 1
            j["ok"] += 1 if e["data"].get("ok") else 0
    for j in jobs.values():
        j["rate"] = j["ok"] / j["runs"]
    return {
        "asleepWhenCould": {"value": (asleep_s / not_needed) if not_needed > 0 else None, "asleepS": asleep_s, "notNeededS": not_needed, "inferredS": inferred_s, "knownS": asleep_s + inferred_s + sampled_s},
        "loadedUnused": {"value": (unused / loaded) if loaded > 0 else None, "unusedS": unused, "loadedS": loaded},
        "answering": answering,
        "jobs": jobs,
    }


# ---- findings by construction -----------------------------------------------------------------
def _dur(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds < 90:
        return "%d s" % round(seconds)
    if seconds < 5400:
        return "%d min" % round(seconds / 60.0)
    return "%.1f h" % (seconds / 3600.0)


def _hm(at: float) -> str:
    return _dt.datetime.fromtimestamp(at, _dt.timezone.utc).strftime("%H:%MZ")


def findings_by_construction(samples: List[dict], events: List[dict], box: str, segments: List[dict], t0: float, t1: float, now: float, day_key: str) -> List[dict]:
    """Findings that need no history. Each: id, kind, box, from, to, open, seen, expected, means, suggest, marks."""
    end = min(t1, now)
    out: List[dict] = []

    # 1. wakes with nothing behind them: one finding per box and day, so a night is one item, not eight
    ws = wakes(samples, events, box, t0, t1)
    stray = [w for w in ws if not w["explained"]]
    if stray:
        sources = sorted({w["source"] for w in stray})
        slept = [w["at"] - w["sleepAt"] for w in stray if w["sleepAt"]]
        seen = "%s woke %d time%s with nothing behind it: %s." % (box, len(stray), "" if len(stray) == 1 else "s", ", ".join(_hm(w["at"]) for w in stray))
        if slept:
            seen += " It had been asleep %s to %s each time." % (_dur(min(slept)), _dur(max(slept))) if len(slept) > 1 else " It had been asleep %s." % _dur(slept[0])
        seen += " Windows names the wake source as: %s." % "; ".join(sources)
        explained = [w for w in ws if w["explained"]]
        expected = "Every wake has a doorman burst for this box in the %d s before it (a knock or a scheduled job), or the owner's own input at that moment. The doorman recorded none for these" % WAKE_MATCH_BEFORE_S
        expected += (" (it did for %d other wake%s that day: %s)." % (len(explained), "" if len(explained) == 1 else "s", "; ".join("%s, %s" % (_hm(w["at"]), w["explained"]["text"]) for w in explained))) if explained else "."
        out.append({
            "id": "wake.unexplained:%s:%s" % (box, day_key), "kind": "wake.unexplained", "box": box,
            "from": stray[0]["at"], "to": stray[-1]["at"], "open": False, "seen": seen, "expected": expected,
            "means": "Something other than the doorman is waking this box: network traffic that matches a wake pattern, a wake timer, or a device. The wake source Windows names is not evidence of who did it.",
            "suggest": "On that box, in an elevated PowerShell: powercfg /lastwake, powercfg /waketimers and Get-NetAdapterPowerManagement; leave only the magic packet armed on the adapter the doorman wakes (WakeOnPattern Disabled).",
            "marks": [w["at"] for w in stray],
        })

    # 2. a service something depends on, not answering
    for name in service_names(samples, events, box):
        for b in service_bands(samples, events, box, name, segments, end):
            if b["state"] != "down" or b["to"] <= t0 or b["from"] >= t1:
                continue
            still = (not b["closed"]) and b["to"] >= end - SILENT_GAP_S
            length = b["to"] - b["from"]
            if length < SERVICE_DOWN_MIN_S and not (b["said"] and still):
                continue
            who = b["by"] or "something"
            seen = "%s on %s did not answer from %s" % (name, box, iso(b["from"]))
            seen += " and still does not." if still else " to %s (%s)." % (iso(b["to"]), _dur(length))
            if b["said"]:
                seen += " First said by %s itself" % who
                if b["said"].get("basis"):
                    seen += " (%s)" % b["said"]["basis"]
                seen += "."
            if b.get("closedSaid") and b["closedSaid"].get("basis"):
                seen += " The time it answered again is from: %s." % b["closedSaid"]["basis"]
            out.append({
                "id": "service.down:%s:%s:%s" % (box, name, iso(b["from"])), "kind": "service.down", "box": box,
                "from": b["from"], "to": b["to"], "open": still, "seen": seen,
                "expected": "%s answers whenever %s depends on it." % (name, who),
                "means": "%s ran without %s for that time; what it does with it was degraded or off." % (who[:1].upper() + who[1:], name),
                "suggest": "Start it on that box: scripts\\cynco-services.ps1 start %s" % name if still else "It is back. If nothing restarted it on purpose, look at what stopped it: scripts\\cynco-services.ps1 shows its task and the last line of its log.",
                "marks": [b["from"]],
            })

    # 3. a model in memory with nothing using it
    for b in model_bands(samples):
        if b["longestIdleFrom"] is None or b["longestIdleS"] < MODEL_UNUSED_MIN_S:
            continue
        a = b["longestIdleFrom"]
        z = a + b["longestIdleS"]
        if z <= t0 or a >= t1:
            continue
        still = z >= end - SILENT_GAP_S
        out.append({
            "id": "model.unused:%s:%s" % (box, iso(a)), "kind": "model.unused", "box": box, "from": a, "to": z, "open": still,
            "seen": "%s sat loaded on %s (%s) with no request for %s, from %s%s." % (b["model"], box, b["server"] or "its server", _dur(b["longestIdleS"]), iso(a), " and is still loaded" if still else ""),
            "expected": "A model is in memory only while something is using it; the owner's rule is that loaded-and-unused time is near zero. The chat engine's own idle unload is 15 minutes.",
            "means": "Whatever loaded it does not unload it when idle, or nothing owns it any more (a leftover server).",
            "suggest": "Look at who holds the GPU on the timeline for that time. For the CynCo engine, LOCALCODE_LLAMA_IDLE_UNLOAD_MS sets the unload; for an app, close it or let CynCo manage it (Missions tab, Apps).",
            "marks": [a],
        })

    # 4. silence nobody announced
    for g in segments:
        if g["state"] != "silent":
            continue
        if g["to"] >= end - 1.0 and t1 > now:
            continue  # still silent now: a status on the page, not yet a finding (it may be asleep and say so later)
        out.append({
            "id": "box.silent:%s:%s" % (box, iso(g["from"])), "kind": "box.silent", "box": box, "from": g["from"], "to": g["to"], "open": False,
            "seen": "%s stopped reporting at %s and was next heard from at %s (%s). Its System log shows no sleep or shutdown for that time." % (box, iso(g["from"]), iso(g["to"]), _dur(g["to"] - g["from"])),
            "expected": "A box that is awake reports every minute, and one that sleeps or shuts down says so when it is back.",
            "means": "Its reporter was not running, the box could not reach the doorman, or the box hung or lost power.",
            "suggest": "On that box: scripts\\cynco-services.ps1 (the watch row) and the end of %USERPROFILE%\\.cynco\\box-reporter.log.",
            "marks": [g["from"]],
        })
    return out


# ---- the filter (wrong by comparison) ---------------------------------------------------------
class Cusum:
    """Cumulative-sum change detector, the definition of `CusumDetector` in
    engine/cybernetics-core/src/metrics/index.ts, written again for the doorman."""

    def __init__(self, threshold: float, slack: float) -> None:
        self.threshold = threshold
        self.slack = slack
        self.upper = 0.0
        self.lower = 0.0

    def update(self, deviation: float) -> bool:
        self.upper = max(0.0, self.upper + deviation - self.slack)
        self.lower = max(0.0, self.lower - deviation - self.slack)
        return self.upper > self.threshold or self.lower > self.threshold

    def reset(self) -> None:
        self.upper = 0.0
        self.lower = 0.0


def _scale(hist: List[float], mid: float) -> float:
    mad = statistics.median(abs(v - mid) for v in hist)
    return max(1.4826 * mad, 0.05 * abs(mid), 0.5)


def classify(readings: List[Tuple[float, float]]) -> dict:
    """Class every reading of one series as noise, a transient, a change of slope or a step.

    Returns {"state": "learning"|"ok", "need": str, "points": [{"at","value","cls"}], "changes": [...]}.
    A series with too little history is `learning`: its points are charted with no class and nothing
    is flagged. Only `changes` (slope, step) are findings; noise and transients are charted only.
    """
    readings = sorted(readings)
    n = len(readings)
    span = (readings[-1][0] - readings[0][0]) if n else 0.0
    if n < MIN_READINGS or span < MIN_SPAN_DAYS * 86400.0:
        need = "needs %d readings over %g days; has %d over %.1f" % (MIN_READINGS, MIN_SPAN_DAYS, n, span / 86400.0)
        return {"state": "learning", "need": need, "points": [{"at": a, "value": v, "cls": None} for a, v in readings], "changes": []}
    cls: List[Optional[str]] = [None] * n
    changes: List[dict] = []
    base: List[float] = []  # the readings the baseline is made of, since the last change
    cusum = Cusum(CUSUM_H, CUSUM_K)
    up_start = lo_start = 0  # where each running sum last left zero
    pending: List[int] = []  # outliers in a row, all on one side
    side = 0

    def flush_transients() -> None:
        for j in pending:
            cls[j] = "transient"
        pending.clear()

    for i, (at, x) in enumerate(readings):
        hist = base[-WINDOW:]
        if len(hist) < MIN_READINGS:
            flush_transients()
            cls[i] = "noise"  # the baseline is still being learned (at the start, and after a change)
            base.append(x)
            continue
        mid = statistics.median(hist)
        z = (x - mid) / _scale(hist, mid)
        if abs(z) >= Z_OUT:
            s = 1 if z > 0 else -1
            if pending and s != side:
                flush_transients()
            side = s
            pending.append(i)
            if len(pending) >= SUSTAIN:
                first = pending[0]
                level = statistics.median(readings[j][1] for j in pending)
                cls[first] = "step"
                for j in pending[1:]:
                    cls[j] = "noise"
                changes.append({"at": readings[first][0], "cls": "step", "from": mid, "to": level})
                base = [readings[j][1] for j in pending]
                cusum.reset()
                up_start = lo_start = i + 1
                pending.clear()
            continue
        flush_transients()
        if cusum.upper == 0.0:
            up_start = i
        if cusum.lower == 0.0:
            lo_start = i
        if cusum.update(z):
            onset = up_start if cusum.upper > cusum.threshold else lo_start
            recent = [readings[j][1] for j in range(onset, i + 1)]
            cls[i] = "noise"
            cls[onset] = "slope"
            changes.append({"at": readings[onset][0], "cls": "slope", "from": mid, "to": statistics.median(recent)})
            base = recent
            cusum.reset()
            up_start = lo_start = i + 1
        else:
            cls[i] = "noise"
            base.append(x)
    flush_transients()  # a trailing outlier is a transient until more readings say otherwise
    return {"state": "ok", "need": "", "points": [{"at": a, "value": v, "cls": cls[i]} for i, (a, v) in enumerate(readings)], "changes": changes}


def series(samples: List[dict]) -> Dict[str, dict]:
    """The comparison series of one box: hourly medians of each GPU's temperature, idle and under load.

    {"gpu0.tempIdle": {"label", "unit", "readings": [(at, value)]}}. An hour needs five samples.
    """
    buckets: Dict[str, Dict[int, List[float]]] = {}
    names: Dict[str, str] = {}
    for s in samples:
        for g in s.get("gpus") or []:
            if not isinstance(g, dict) or not isinstance(g.get("tempC"), (int, float)) or not isinstance(g.get("utilPct"), (int, float)):
                continue
            which = "tempIdle" if g["utilPct"] < 10 else ("tempBusy" if g["utilPct"] >= 50 else None)
            if which is None:
                continue
            key = "gpu%s.%s" % (g.get("i", 0), which)
            names[key] = "%s, %s" % (g.get("name") or "GPU %s" % g.get("i", 0), "idle" if which == "tempIdle" else "under load")
            buckets.setdefault(key, {}).setdefault(int(s["at"] // 3600), []).append(float(g["tempC"]))
    out = {}
    for key, hours in buckets.items():
        readings = [(h * 3600.0, statistics.median(v)) for h, v in sorted(hours.items()) if len(v) >= 5]
        if readings:
            out[key] = {"label": "%s temperature" % names[key], "unit": "°C", "readings": readings}
    return out


def findings_by_comparison(series_map: Dict[str, dict], box: str, t0: float, t1: float) -> Tuple[List[dict], List[dict], Dict[str, dict]]:
    """(findings, learning, classified). Learning: [{"series","label","need"}]."""
    findings: List[dict] = []
    learning: List[dict] = []
    classified: Dict[str, dict] = {}
    for key, sr in sorted(series_map.items()):
        c = classify(sr["readings"])
        classified[key] = {**sr, **c}
        if c["state"] == "learning":
            learning.append({"series": key, "box": box, "label": sr["label"], "need": c["need"]})
            continue
        for ch in c["changes"]:
            if not (t0 <= ch["at"] < t1):
                continue
            word = "stepped" if ch["cls"] == "step" else "has been drifting"
            findings.append({
                "id": "change:%s:%s:%s" % (box, key, iso(ch["at"])), "kind": "change." + ch["cls"], "box": box,
                "from": ch["at"], "to": ch["at"], "open": False,
                "seen": "%s on %s %s from about %.1f to %.1f %s at %s." % (sr["label"], box, word, ch["from"], ch["to"], sr["unit"], iso(ch["at"])),
                "expected": "About %.1f %s: the median of its last %d readings for this box." % (ch["from"], sr["unit"], WINDOW),
                "means": "A lasting change, not a blip: %s." % ("three readings in a row beyond three sigma" if ch["cls"] == "step" else "a slow move that added up past the threshold"),
                "suggest": "Look at the timeline at that time for what started or stopped.",
                "marks": [ch["at"]],
            })
    return findings, learning, classified


# ---- the day ----------------------------------------------------------------------------------
def day_bounds(day: str, tz_offset_min: int) -> Tuple[float, float]:
    """The owner's local day as epoch seconds [t0, t1). Raises ValueError for a day that is not one."""
    d = _dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
    t0 = d.timestamp() - tz_offset_min * 60.0
    return t0, t0 + 86400.0


def day_of(at: float, tz_offset_min: int) -> str:
    return _dt.datetime.fromtimestamp(at + tz_offset_min * 60.0, _dt.timezone.utc).strftime("%Y-%m-%d")


def day_report(store: Any, day: str, now: float, tz_offset_min: int) -> dict:
    """Everything the note and the charts show for one local day."""
    t0, t1 = day_bounds(day, tz_offset_min)
    end = min(t1, now)
    margin = 86400.0
    events = store.events(t0 - margin, t1 + 2 * margin)
    boxes = []
    findings: List[dict] = []
    learning: List[dict] = []
    for box in [b for b in store.boxes() if b != DOORMAN_BOX]:
        near = store.samples(box, t0 - 6 * 3600.0, t1 + SILENT_GAP_S)
        inside = [s for s in near if t0 <= s["at"] < t1]
        segs = timeline(near, events, box, t0, t1, now)
        found = findings_by_construction(near, events, box, segs, t0, t1, now, day)
        history = store.samples(box, t1 - HISTORY_DAYS * 86400.0, t1)
        cmp_found, cmp_learning, classified = findings_by_comparison(series(history), box, t0, t1)
        findings.extend(found + cmp_found)
        learning.extend(cmp_learning)
        last = store.last_seen(box)
        state = segs[-1]["state"] if segs else "unknown"
        temps = []
        for s in inside:
            for g in s.get("gpus") or []:
                if isinstance(g, dict) and isinstance(g.get("tempC"), (int, float)):
                    temps.append({"at": s["at"], "gpu": g.get("i", 0), "name": g.get("name") or "", "tempC": float(g["tempC"])})
        boxes.append({
            "box": box, "lastSeen": last, "state": state, "since": segs[-1]["from"] if segs else None,
            "segments": segs, "wakes": wakes(near, events, box, t0, t1),
            "holders": [h for h in holder_bands(near) if h["to"] > t0 and h["from"] < t1],
            "services": {name: [b for b in service_bands(near, events, box, name, segs, end) if b["to"] >= t0 and b["from"] < t1] for name in service_names(near, events, box)},
            "models": [b for b in model_bands(near) if b["to"] > t0 and b["from"] < t1],
            "temps": temps,
            "jobs": [{"at": e["at"], **e["data"]} for e in events if e["box"] == box and e["kind"] == "job.run" and t0 <= e["at"] < t1],
            "blocked": [{"at": e["at"], **e["data"]} for e in events if e["box"] == box and e["kind"] == "engine.loop_blocked" and t0 <= e["at"] < t1],
            "measures": measures(near, events, box, segs, t0, t1),
            "series": {k: v for k, v in classified.items()},
            "samples": len(inside),
        })
    # What is still true comes first, and among the rest the oldest: an item that stays true rises
    # up the page from day to day. It does not become an alert.
    findings.sort(key=lambda f: (not f["open"], f["from"]))
    bursts = [{"at": e["at"], **e["data"]} for e in events if e["box"] == DOORMAN_BOX and e["kind"] == "doorman.burst" and t0 <= e["at"] < t1]
    sched = [e for e in events if e["box"] == DOORMAN_BOX and e["kind"] == "doorman.schedule" and e["at"] < t1]
    return {
        "day": day, "t0": t0, "t1": t1, "now": now, "tzOffsetMin": tz_offset_min, "generatedAt": now,
        "boxes": boxes, "findings": findings, "learning": learning, "bursts": bursts,
        "schedule": sched[-1]["data"] if sched else None,
    }
