"""watchnote — the daily note and its charts, as one page that takes no input.

Design: docs/decisions/2026-11-11-metasystem-design.md (slice 1, "The note", "The charts"). The page is
rendered on the doorman from a report (`watchmodel.day_report`) and is readable when every other box is
asleep. It has no script, no form and nothing fetched from anywhere: the charts are inline SVG, the
only links are to the day before and after. Every string that came from a box is escaped.

Colour: five categorical slots in a fixed order (awake, one-shot, engine, app, not CynCo's) and the
reserved status colours for up/down and ok/failed, validated in both modes with the dataviz
validator; identity never rests on colour alone (row labels, a legend, a title on every mark, and
the tables under each chart).
Python 3 standard library only. Pure: a report in, a string out.
"""
from __future__ import annotations

import datetime as _dt
import html
from typing import Any, Dict, List, Optional

from watchmodel import MODEL_UNUSED_MIN_S, SILENT_GAP_S, WAKE_MATCH_BEFORE_S
from watchstore import iso

ANSWER_NOTE = "This page takes no input. Findings are answered on the CynCo dashboard (that was me / that is normal now / that is wrong), which passes the answer on."

KIND_TITLE = {
    "wake.unexplained": "Wakes with nothing behind them",
    "service.down": "A service was not answering",
    "model.unused": "A model sat loaded and unused",
    "box.silent": "A box went silent without saying why",
    "change.step": "A lasting change (a step)",
    "change.slope": "A lasting change (a slope)",
}
ANSWER_WORDS = {"me": "that was me", "normal": "that is normal now", "wrong": "that is wrong"}

W = 960  # the chart's own coordinate width; the SVG scales to the page
GUTTER = 128
PAD_R = 16

CSS = """
:root{color-scheme:light dark;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--rest:#c3c2b7;--good:#0ca30c;--serious:#ec835a;--critical:#d03b3b;--ring:rgba(11,11,11,.10)}
@media (prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--rest:#52514e;--ring:rgba(255,255,255,.10)}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:0 0 6px}
p{margin:6px 0}.sub{color:var(--ink2)}.small{font-size:13px;color:var(--ink2)}
nav{display:flex;gap:16px;margin:8px 0 0}a{color:inherit}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px;margin:10px 0}
.finding dl{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;margin:6px 0 0}
.finding dt{color:var(--ink2)}.finding dd{margin:0;overflow-wrap:anywhere}
.tag{display:inline-block;font-size:12px;border:1px solid var(--axis);border-radius:999px;padding:0 8px;margin-left:8px;color:var(--ink2);vertical-align:middle}
.status{display:flex;flex-wrap:wrap;gap:6px 18px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:3px 10px 3px 0;border-bottom:1px solid var(--grid);vertical-align:top}
th{color:var(--ink2);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.meter{display:inline-block;width:120px;height:8px;border-radius:4px;background:var(--grid);vertical-align:middle;margin-right:8px;overflow:hidden}
.meter i{display:block;height:8px;background:var(--s1)}
svg{display:block;width:100%;height:auto}
svg text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink2)}
svg .lab{fill:var(--ink)}svg .tick{fill:var(--muted)}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.awake{fill:var(--s1)}.asleep{fill:var(--rest)}.off{fill:none;stroke:var(--axis);stroke-width:1}.silent{fill:var(--serious)}
.oneshot{fill:var(--s2)}.engine{fill:var(--s3)}.app{fill:var(--s4)}.foreign{fill:var(--s5)}
.up{fill:var(--good)}.down{fill:var(--critical)}.idle{fill:var(--rest)}
.ok{fill:var(--good);stroke:var(--surface);stroke-width:2}.fail{stroke:var(--critical);stroke-width:2.5;stroke-linecap:round}
.stall{fill:var(--ink2);stroke:var(--surface);stroke-width:2}.woke{fill:var(--surface);stroke:var(--ink);stroke-width:1.5}
.temp{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.t0{stroke:var(--s1)}.t1{stroke:var(--s2)}.t2{stroke:var(--s3)}
.flag{stroke:var(--ink);stroke-width:1}.flagtip{fill:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--ink2);margin:8px 0 0}
.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{display:inline-block;width:12px;height:10px;border-radius:2px}
details{margin:8px 0 0}summary{cursor:pointer;color:var(--ink2);font-size:13px}
@media (max-width:640px){.finding dl{grid-template-columns:1fr}.finding dt{margin-top:6px}}
"""


def e(s: Any) -> str:
    return html.escape("" if s is None else str(s), quote=True)


def _local(at: float, off_min: int, fmt: str = "%H:%M") -> str:
    return _dt.datetime.fromtimestamp(at + off_min * 60.0, _dt.timezone.utc).strftime(fmt)


def _zone(off_min: int) -> str:
    sign = "+" if off_min >= 0 else "−"
    h, m = divmod(abs(off_min), 60)
    return "UTC%s%d%s" % (sign, h, (":%02d" % m) if m else "")


def _dur(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds < 90:
        return "%d s" % round(seconds)
    if seconds < 5400:
        return "%d min" % round(seconds / 60.0)
    return "%.1f h" % (seconds / 3600.0)


def _span(a: float, b: float, off: int) -> str:
    return "%s to %s (%s) · %s to %s" % (_local(a, off), _local(b, off), _dur(b - a), iso(a), iso(b))


def _shift_day(day: str, by: int) -> str:
    d = _dt.datetime.strptime(day, "%Y-%m-%d") + _dt.timedelta(days=by)
    return d.strftime("%Y-%m-%d")


# ---- the chart of one box ---------------------------------------------------------------------
def _holder_class(unit: str) -> Optional[str]:
    if unit.startswith("oneshot"):
        return "oneshot"
    if unit == "engine":
        return "engine"
    if unit.startswith("app"):
        return "app"
    if unit == "foreign":
        return "foreign"
    return None


def box_chart(box: dict, report: dict, marks: List[dict]) -> str:
    """Inline SVG: the box's day on one time axis. `marks` are {"at","text"} for flagged times."""
    t0, t1, off = report["t0"], report["t1"], report["tzOffsetMin"]
    plot_w = W - GUTTER - PAD_R

    def x(at: float) -> float:
        return GUTTER + (min(max(at, t0), t1) - t0) / (t1 - t0) * plot_w

    rows: List[str] = []
    y = 22.0

    def label(text: str, at_y: float) -> str:
        return '<text class="lab" x="%d" y="%.1f" text-anchor="end">%s</text>' % (GUTTER - 10, at_y, e(text))

    def band(a: float, b: float, top: float, h: float, cls: str, title: str) -> str:
        xa, xb = x(a), x(b)
        w = max(xb - xa - 1.0, 0.8)  # a surface gap between neighbours; never thinner than a hairline
        return '<rect class="%s" x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2"><title>%s</title></rect>' % (cls, xa, top, w, h, e(title))

    # 1. awake / asleep / off / silent
    rows.append(label("state", y + 13))
    for g in box["segments"]:
        if g["state"] == "unknown":
            continue
        rows.append(band(g["from"], g["to"], y, 18, g["state"], "%s %s · %s" % (g["state"], _span(g["from"], g["to"], off), g["basis"])))
    for w in box["wakes"]:
        if w["explained"]:
            rows.append('<circle class="woke" cx="%.1f" cy="%.1f" r="4"><title>%s</title></circle>' % (x(w["at"]), y + 9, e("woke %s (%s): %s" % (_local(w["at"], off), iso(w["at"]), w["explained"]["text"]))))
    y += 18 + 12

    # 2. who held the GPU, by CynCo's own reckoning
    rows.append(label("GPU held by", y + 13))
    for h in box["holders"]:
        cls = _holder_class(h["unit"])
        if cls:
            rows.append(band(h["from"], h["to"], y, 18, cls, "%s · %s" % (h["unit"], _span(h["from"], h["to"], off))))
    y += 18 + 12

    # 3. a row per service
    for name, bands in box["services"].items():
        rows.append(label(name, y + 10))
        for b in bands:
            if b["to"] <= b["from"]:
                continue
            top, hh = (y + 4, 4) if b["state"] == "idle" else (y, 12)
            word = {"up": "answering", "down": "NOT answering", "idle": "not wanted"}[b["state"]]
            rows.append(band(b["from"], b["to"], top, hh, b["state"], "%s %s · %s" % (name, word, _span(b["from"], b["to"], off))))
            if b["state"] == "down" and x(b["to"]) + 70 < W - PAD_R:
                rows.append('<text x="%.1f" y="%.1f">down %s</text>' % (x(b["to"]) + 5, y + 10, e(_dur(b["to"] - b["from"]))))
        y += 12 + 10

    # 4. scheduled jobs, and the engine's stalls
    if box["jobs"] or box["blocked"]:
        rows.append(label("jobs", y + 12))
        for j in box["jobs"]:
            cx = x(j["at"])
            title = e("%s/%s %s at %s (%s)" % (j.get("mission"), j.get("triggerId"), "ok" if j.get("ok") else "FAILED", _local(j["at"], off), iso(j["at"])))
            if j.get("ok"):
                rows.append('<circle class="ok" cx="%.1f" cy="%.1f" r="5"><title>%s</title></circle>' % (cx, y + 8, title))
            else:
                rows.append('<g class="fail"><title>%s</title><line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/><line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f"/></g>' % (title, cx - 4, y + 4, cx + 4, y + 12, cx - 4, y + 12, cx + 4, y + 4))
        for s in box["blocked"]:
            cx = x(s["at"])
            rows.append('<path class="stall" d="M%.1f %.1f l5 5 l-5 5 l-5 -5 z"><title>%s</title></path>' % (cx, y + 3, e("the engine's event loop was blocked %s s (until %s)" % (s.get("seconds"), s.get("until")))))
        y += 16 + 10

    # 5. temperature, one line per card, one axis
    temps = box["temps"]
    plot_top = y + 4
    if temps:
        lo = min(t["tempC"] for t in temps)
        hi = max(t["tempC"] for t in temps)
        lo_t = int(lo // 10) * 10
        hi_t = int(-(-hi // 10)) * 10
        if hi_t == lo_t:
            hi_t += 10
        ph = 90.0

        def ty(v: float) -> float:
            return plot_top + ph - (v - lo_t) / (hi_t - lo_t) * ph

        rows.append(label("GPU °C", plot_top + 12))
        step = 10 if hi_t - lo_t <= 40 else 20
        v = lo_t
        while v <= hi_t:
            rows.append('<line class="grid" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/><text class="tick" x="%d" y="%.1f" text-anchor="end">%d</text>' % (GUTTER, ty(v), W - PAD_R, ty(v), GUTTER - 10, ty(v) + 4, v))
            v += step
        gpus = sorted({t["gpu"] for t in temps})
        for n, gid in enumerate(gpus[:3]):
            pts = [t for t in temps if t["gpu"] == gid]
            runs: List[List[dict]] = [[]]
            for i, p in enumerate(pts):
                if i and p["at"] - pts[i - 1]["at"] > SILENT_GAP_S:
                    runs.append([])
                runs[-1].append(p)
            for run in runs:
                if len(run) == 1:
                    rows.append('<circle class="t%d" style="fill:currentColor;stroke:none" cx="%.1f" cy="%.1f" r="1.5"/>' % (n, x(run[0]["at"]), ty(run[0]["tempC"])))
                elif run:
                    rows.append('<polyline class="temp t%d" points="%s"><title>%s</title></polyline>' % (n, " ".join("%.1f,%.1f" % (x(p["at"]), ty(p["tempC"])) for p in run), e("%s: %.0f to %.0f °C" % (pts[0]["name"] or "GPU %s" % gid, min(p["tempC"] for p in run), max(p["tempC"] for p in run)))))
            last = pts[-1]
            if x(last["at"]) + 110 < W:
                rows.append('<text x="%.1f" y="%.1f">%s %.0f °C</text>' % (x(last["at"]) + 6, ty(last["tempC"]) + 4, e(last["name"] or "GPU %s" % gid), last["tempC"]))
        y = plot_top + ph + 8
    bottom = y + 2

    # the time axis: local hours, a hairline every three
    axis: List[str] = ['<line class="axis" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>' % (GUTTER, bottom, W - PAD_R, bottom)]
    for hour in range(0, 25, 3):
        at = t0 + hour * 3600.0
        axis.append('<line class="grid" x1="%.1f" y1="14" x2="%.1f" y2="%.1f"/>' % (x(at), x(at), bottom))
        axis.append('<text class="tick" x="%.1f" y="%.1f" text-anchor="middle">%02d:00</text>' % (x(at), bottom + 14, hour % 24))

    flags: List[str] = []
    for m in marks:
        if not (t0 <= m["at"] < t1):
            continue
        fx = x(m["at"])
        flags.append('<g class="mark"><title>%s</title><line class="flag" x1="%.1f" y1="12" x2="%.1f" y2="%.1f"/><path class="flagtip" d="M%.1f 4 h8 l-4 8 z"/></g>' % (e("flagged %s (%s): %s" % (_local(m["at"], off), iso(m["at"]), m["text"])), fx, fx, bottom, fx - 4))

    height = bottom + 22
    return '<svg viewBox="0 0 %d %d" role="img" aria-label="%s">%s%s%s</svg>' % (
        W, height, e("The day of %s on one time axis: state, GPU holder, services, jobs and temperature" % box["box"]), "".join(axis), "".join(rows), "".join(flags))


def _legend(box: dict, has_marks: bool) -> str:
    items = [("awake", "awake"), ("asleep", "asleep"), ("off", "off (hollow)"), ("silent", "silent, unexplained")]
    if box["holders"]:
        items += [("oneshot", "a scheduled one-shot"), ("engine", "the CynCo engine"), ("app", "one of the owner's apps"), ("foreign", "not CynCo's")]
    if box["services"]:
        items += [("up", "service answering"), ("down", "service not answering"), ("idle", "not wanted (thin)")]
    out = []
    for cls, text in items:
        style = "border:1px solid var(--axis)" if cls == "off" else "background:var(--%s)" % {"awake": "s1", "asleep": "rest", "silent": "serious", "oneshot": "s2", "engine": "s3", "app": "s4", "foreign": "s5", "up": "good", "down": "critical", "idle": "rest"}[cls]
        out.append('<span><i style="%s"></i>%s</span>' % (style, e(text)))
    if box["jobs"]:
        out.append("<span>● job ran ok</span><span>✕ job failed</span>")
    if box["wakes"]:
        out.append("<span>○ a wake the doorman or the owner caused</span>")
    if has_marks:
        out.append("<span>▼ flagged in the note</span>")
    return '<div class="legend">%s</div>' % "".join(out)


def _tables(box: dict, report: dict) -> str:
    off = report["tzOffsetMin"]
    parts: List[str] = []
    if box["wakes"]:
        rows = "".join(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                e("%s (%s)" % (_local(w["at"], off), iso(w["at"]))),
                e(_dur(w["at"] - w["sleepAt"]) if w["sleepAt"] else "not given"),
                e(w["source"]),
                e(w["explained"]["text"]) if w["explained"] else "<strong>nothing: no doorman burst in the %d s before it, no owner input</strong>" % WAKE_MATCH_BEFORE_S,
            ) for w in box["wakes"])
        parts.append("<details><summary>Wakes (%d)</summary><table><tr><th>woke</th><th>had slept</th><th>Windows' wake source</th><th>what was behind it</th></tr>%s</table></details>" % (len(box["wakes"]), rows))
    stretches = [(name, b) for name, bands in box["services"].items() for b in bands if b["state"] == "down"]
    if stretches:
        rows = "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (e(name), e(_span(b["from"], b["to"], off)), e(b["by"])) for name, b in stretches)
        parts.append("<details><summary>Service outages (%d)</summary><table><tr><th>service</th><th>not answering</th><th>wanted by</th></tr>%s</table></details>" % (len(stretches), rows))
    if box["models"]:
        rows = "".join("<tr><td>%s</td><td>%s</td><td>%s</td><td class=\"n\">%s</td></tr>" % (e(m["model"]), e(m["server"]), e(_span(m["from"], m["to"], off)), e(_dur(m["unusedS"]))) for m in box["models"])
        parts.append("<details><summary>Models loaded (%d)</summary><table><tr><th>model</th><th>server</th><th>loaded</th><th class=\"n\">of which unused</th></tr>%s</table></details>" % (len(box["models"]), rows))
    if box["jobs"]:
        rows = "".join("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (e("%s (%s)" % (_local(j["at"], off), iso(j["at"]))), e("%s/%s" % (j.get("mission"), j.get("triggerId"))), "ok" if j.get("ok") else "<strong>failed</strong>", e(str(j.get("summary") or "")[:200])) for j in box["jobs"])
        parts.append("<details><summary>Scheduled jobs (%d)</summary><table><tr><th>ran</th><th>job</th><th>outcome</th><th>summary</th></tr>%s</table></details>" % (len(box["jobs"]), rows))
    if box["blocked"]:
        rows = "".join("<tr><td>%s</td><td class=\"n\">%s s</td></tr>" % (e("%s (%s)" % (_local(s["at"], off), iso(s["at"]))), e(s.get("seconds"))) for s in box["blocked"])
        parts.append("<details><summary>The engine's event loop was blocked (%d)</summary><table><tr><th>seen</th><th class=\"n\">for</th></tr>%s</table></details>" % (len(box["blocked"]), rows))
    return "".join(parts)


def _measures(box: dict) -> str:
    m = box["measures"]

    def meter(v: Optional[float]) -> str:
        if v is None:
            return '<span class="small">nothing to measure yet</span>'
        return '<span class="meter"><i style="width:%d%%"></i></span>%.2f' % (round(max(0.0, min(1.0, v)) * 100), v)

    a = m["asleepWhenCould"]
    lu = m["loadedUnused"]
    rows = [
        ("Asleep when it could be", meter(a["value"]), "%s asleep of %s in which nothing needed the box%s" % (_dur(a["asleepS"]), _dur(a["notNeededS"]), (" (%s of that read from idle sleeps, not samples)" % _dur(a["inferredS"])) if a["inferredS"] else "") if a["value"] is not None else "higher is better"),
        ("Loaded and unused", meter(lu["value"]), "%s unused of %s loaded; a stretch over %s is flagged" % (_dur(lu["unusedS"]), _dur(lu["loadedS"]), _dur(MODEL_UNUSED_MIN_S)) if lu["value"] is not None else "lower is better"),
    ]
    for name, v in m["answering"].items():
        rows.append(("Answering when wanted: %s" % name, meter(v["value"]), "%s answering of %s wanted" % (_dur(v["upS"]), _dur(v["wantedS"])) if v["value"] is not None else "no sample said it was wanted"))
    for name, j in m["jobs"].items():
        rows.append(("Job: %s" % name, meter(j["rate"]), "%d of %d runs ok" % (j["ok"], j["runs"])))
    body = "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (e(k), v, e(note)) for k, v, note in rows)
    return "<table><tr><th>measure (0 to 1)</th><th>value</th><th>from</th></tr>%s</table>" % body


def _box_status(box: dict, report: dict) -> str:
    now, off = report["now"], report["tzOffsetMin"]
    if box["lastSeen"] is None:
        return "%s: never reported" % box["box"]
    heard = "last heard %s ago" % _dur(now - box["lastSeen"])
    if report["t1"] <= now:
        return "%s: %s (this is a past day)" % (box["box"], heard)
    since = (" since %s" % _local(box["since"], off)) if box["since"] else ""
    words = {"awake": "awake", "asleep": "asleep", "off": "off", "silent": "silent, with no sleep or shutdown reported yet", "unknown": "nothing reported"}[box["state"]]
    return "%s: %s%s, %s" % (box["box"], words, since, heard)


def render(report: dict) -> str:
    day, off = report["day"], report["tzOffsetMin"]
    weekday = _dt.datetime.strptime(day, "%Y-%m-%d").strftime("%A")
    out: List[str] = []
    out.append("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
    out.append("<title>Watcher note %s</title><style>%s</style></head><body><main>" % (e(day), CSS))
    out.append("<h1>The note for %s %s</h1>" % (e(weekday), e(day)))
    out.append('<p class="sub">Times are the owner\'s local time (%s); every mark\'s tooltip and table row also gives UTC. Written %s.</p>' % (e(_zone(off)), e(iso(report["generatedAt"]))))
    out.append('<nav><a href="/day/%s">← the day before</a><a href="/day/%s">the day after →</a><a href="/">today</a></nav>' % (e(_shift_day(day, -1)), e(_shift_day(day, 1))))

    boxes = report["boxes"]
    if not boxes:
        out.append('<div class="card"><p>No box has pushed anything yet. The main PC\'s reporter (the task "CynCo box reporter") sends its state here once <code>LOCALCODE_WATCHER_URL</code> names this address.</p></div>')
    else:
        out.append('<div class="card status">%s</div>' % "".join("<span>%s</span>" % e(_box_status(b, report)) for b in boxes))

    fs = report["findings"]
    out.append("<h2>Flagged (%d)</h2>" % len(fs))
    if not fs:
        out.append('<p class="sub">Nothing was flagged for this day.</p>')
    for f in fs:
        tags = ""
        if f["open"]:
            tags += '<span class="tag">still true</span>'
        if f.get("answer"):
            tags += '<span class="tag">answered: %s</span>' % e(ANSWER_WORDS.get(f["answer"], f["answer"]))
        out.append(
            '<article class="card finding" id="%s"><h3>%s<span class="tag">%s</span>%s</h3><dl>'
            "<dt>What was seen</dt><dd>%s</dd><dt>What was expected</dt><dd>%s</dd>"
            "<dt>What the watcher believes it means</dt><dd>%s</dd><dt>Suggested</dt><dd>%s</dd></dl></article>"
            % (e(f["id"]), e(KIND_TITLE.get(f["kind"], f["kind"])), e(f["box"]), tags, e(f["seen"]), e(f["expected"]), e(f["means"]), e(f["suggest"]))
        )
    out.append('<p class="small">%s An item nobody has answered that is still true the next day moves up this list; it does not become an alert.</p>' % e(ANSWER_NOTE))

    if report["learning"]:
        out.append("<h2>Still learning (%d)</h2><div class=\"card\"><table><tr><th>series</th><th>box</th><th>before it can be compared</th></tr>%s</table>"
                   "<p class=\"small\">A series is charted from its first reading and flags nothing until it has a baseline.</p></div>"
                   % (len(report["learning"]), "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (e(x["label"]), e(x["box"]), e(x["need"])) for x in report["learning"])))

    for b in boxes:
        marks = [{"at": m, "text": KIND_TITLE.get(f["kind"], f["kind"])} for f in fs if f["box"] == b["box"] for m in f["marks"]]
        out.append("<h2>%s</h2><div class=\"card\">" % e(b["box"]))
        if not b["segments"] or all(g["state"] == "unknown" for g in b["segments"]) and not b["services"] and not b["jobs"]:
            out.append('<p class="sub">Nothing was recorded for this box on this day.</p>')
        else:
            out.append(box_chart(b, report, marks))
            out.append(_legend(b, bool(marks)))
            out.append(_tables(b, report))
        out.append("</div><div class=\"card\">%s</div>" % _measures(b))

    if report["bursts"]:
        rows = "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (e("%s (%s)" % (_local(x["at"], off), iso(x["at"]))), e(x.get("target")), e(x.get("cause"))) for x in report["bursts"])
        out.append("<h2>The doorman's own record</h2><div class=\"card\"><details><summary>Wake bursts it sent (%d)</summary><table><tr><th>started</th><th>target</th><th>cause</th></tr>%s</table></details></div>" % (len(report["bursts"]), rows))

    out.append('<p class="small">The watcher never asks a box for anything: each box pushes its own state, and what a box did not report is shown as unknown or silent, not guessed. Kept on the doorman in one SQLite file.</p>')
    out.append("</main></body></html>")
    return "".join(out)


def findings_json(report: dict) -> dict:
    """The note's findings as data: the same ids as the page."""
    return {
        "day": report["day"],
        "generatedAt": iso(report["generatedAt"]),
        "findings": [
            {"id": f["id"], "kind": f["kind"], "title": KIND_TITLE.get(f["kind"], f["kind"]), "box": f["box"], "from": iso(f["from"]), "to": iso(f["to"]), "open": f["open"],
             "seen": f["seen"], "expected": f["expected"], "means": f["means"], "suggest": f["suggest"], "marks": [iso(m) for m in f["marks"]], "answer": f.get("answer")}
            for f in report["findings"]
        ],
        "learning": report["learning"],
        "boxes": [{"box": b["box"], "state": b["state"], "lastSeen": iso(b["lastSeen"]) if b["lastSeen"] is not None else None} for b in report["boxes"]],
    }
