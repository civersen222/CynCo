"""The integrity latch a box reports (wave 19): the model names a set latch, the note shows it, never a path.

A box's reporter sends `integrity: {"state", "summary"}` in each sample (engine/power/reporter/types.ts,
IntegrityRow; `deskIntegrity` in engine/integrity.ts): `clear`, `latched` (no unattended run starts and
no queued command runs on that box until the owner clears it at its desk) or `unusable` (its guard
folder cannot be used, which stops the same). A sample from an older reporter has no such field.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import watchmodel as wm  # noqa: E402
import watchnote  # noqa: E402
from watchstore import Store, iso, parse_iso  # noqa: E402

P = parse_iso
DAY0 = P("2026-11-11T07:00:00Z")  # the owner's local midnight (UTC-7)
DAY1 = DAY0 + 86400
OFF = -420
T = P("2026-11-11T16:00:00Z")
LATCHED = "1 change(s) in protected folders (first: PRESENCE); set 2026-11-11T16:03:00.000Z by daemon (presence). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear"
UNUSABLE = "the guard folder cannot be used, so no unattended run starts; bun scripts/cynco-guard.mjs status says why"


def samples(states, start=T, step=60.0):
    """One sample a minute; each item is a state, None (the field could not be read) or "-" (no field: an older reporter)."""
    out = []
    for i, st in enumerate(states):
        s = {"at": start + i * step, "idleS": 20}
        if st == "-":
            pass
        elif st is None:
            s["integrity"] = None
        else:
            s["integrity"] = {"state": st, "summary": {"clear": "no integrity latch", "latched": LATCHED, "unusable": UNUSABLE}.get(st, "x")}
        out.append(s)
    return out


def construct(ss, now=None):
    if now is None:
        now = max(s["at"] for s in ss) + 30
    segs = wm.timeline(ss, [], "main", DAY0, DAY1, now)
    return wm.findings_by_construction(ss, [], "main", segs, DAY0, DAY1, now, "2026-11-11")


def kinds(found):
    return [f["kind"] for f in found]


# ---- the model --------------------------------------------------------------------------------
def test_bands_follow_the_reported_state_and_skip_samples_that_carry_none():
    ss = samples(["clear", "clear", "latched", None, "-", "latched", "clear"])
    ss[5]["integrity"]["summary"] = "the latest words"
    b = wm.integrity_bands(ss)
    assert [x["state"] for x in b] == ["clear", "latched", "clear"]
    assert b[1]["from"] == T + 120 and b[1]["last"] == T + 300
    assert b[1]["summary"] == "the latest words", "a stretch shows what the box said last"
    assert b[1]["endedAt"] == T + 360 and b[1]["endedBy"] == "clear"
    assert b[2]["endedAt"] is None


def test_a_set_latch_is_wrong_by_construction_and_still_true_while_the_last_report_says_so():
    found = construct(samples(["clear", "clear", "latched", "latched", "latched"]))
    assert kinds(found) == ["integrity.latched"]
    f = found[0]
    assert f["id"] == "integrity.latched:main:%s" % iso(T + 120)
    assert f["open"] is True and f["from"] == T + 120 and f["marks"] == [T + 120]
    assert "main reported the integrity latch set from 2026-11-11T16:02:00Z and still does." in f["seen"]
    assert "1 change(s) in protected folders (first: PRESENCE)" in f["seen"]
    assert "bun scripts/cynco-guard.mjs status" in f["suggest"]


def test_a_latch_the_box_later_reports_clear_is_a_closed_finding_that_says_when():
    found = construct(samples(["latched", "latched", "clear", "clear"]))
    assert kinds(found) == ["integrity.latched"]
    f = found[0]
    assert f["open"] is False and f["to"] == T + 120
    assert "from 2026-11-11T16:00:00Z to 2026-11-11T16:02:00Z (2 min), when it reported it clear." in f["seen"]


def test_an_unusable_guard_folder_is_named_too():
    found = construct(samples(["clear", "unusable", "unusable"]))
    assert kinds(found) == ["integrity.unusable"]
    assert "the guard folder cannot be used" in found[0]["seen"]


def test_clear_none_unknown_states_and_older_reporters_are_no_finding():
    assert construct(samples(["clear", "clear", "clear"])) == []
    assert construct(samples(["-", "-", "-"])) == []
    assert construct(samples([None, None])) == []
    ss = samples(["clear", "clear"])
    ss[1]["integrity"] = {"state": "maybe", "summary": "?"}
    ss.append({"at": T + 180, "integrity": "latched"})  # not an object
    ss.append({"at": T + 240, "integrity": {"state": "latched", "summary": 7}})  # a summary that is not text: the state still counts
    found = construct(ss)
    assert kinds(found) == ["integrity.latched"]
    assert found[0]["from"] == T + 240
    assert wm.integrity_bands(ss)[-1]["summary"] == ""


def test_a_latch_outside_the_day_is_not_this_days_finding():
    before = samples(["latched", "clear"], start=DAY0 - 3 * 3600)
    assert construct(before + samples(["clear"])) == []


def _latched_report(tmp_path, first, n, now):
    """A store whose box reported its latch set n times a minute apart from `first`, and nothing after."""
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(first + i * 60), "idleS": 20, "integrity": {"state": "latched", "summary": LATCHED}} for i in range(n)], now)
    return wm.day_report(store, "2026-11-11", now, OFF)


def test_a_latch_whose_box_slept_through_the_start_of_the_day_is_still_that_days_finding(tmp_path):
    # Check E19-1: the box reported its latch set at 21:00 local the evening before and then slept: on
    # the next day nothing new came, and the latch (a file on the box) still stands.
    first = DAY0 - 3 * 3600
    r = _latched_report(tmp_path, first, 3, DAY0 + 12 * 3600)
    assert kinds(r["findings"]) == ["integrity.latched"]
    f = r["findings"][0]
    assert f["open"] is True and f["from"] == first and f["id"] == "integrity.latched:main:%s" % iso(first)
    assert f["to"] == DAY0 + 12 * 3600, "an open stretch reaches the end of what the day has seen"
    assert "and still does." in f["seen"]
    assert r["boxes"][0]["integrity"] == {"state": "latched", "summary": LATCHED, "at": first + 120}
    assert "; integrity latch set" in watchnote.render(r)


def test_a_latch_first_reported_two_days_before_keeps_its_true_start_and_shows_with_no_report_that_day(tmp_path):
    first = DAY0 - 2 * 86400
    # Reported once more inside the day: the stretch starts where the box first said so, not 6 h before the day.
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(a), "idleS": 20, "integrity": {"state": "latched", "summary": LATCHED}} for a in (first, first + 60, T)], T + 100)
    r = wm.day_report(store, "2026-11-11", T + 100, OFF)
    assert kinds(r["findings"]) == ["integrity.latched"]
    assert r["findings"][0]["from"] == first and r["findings"][0]["id"] == "integrity.latched:main:%s" % iso(first)
    # Asleep since then, more than 30 h before the day's end: the card and the status line still show it.
    (tmp_path / "b").mkdir()
    r = _latched_report(tmp_path / "b", first, 2, DAY0 + 3600)
    assert kinds(r["findings"]) == ["integrity.latched"] and r["findings"][0]["from"] == first
    assert r["boxes"][0]["integrity"]["state"] == "latched"
    page = watchnote.render(r)
    assert "; integrity latch set" in page and "Integrity latch: set (as last reported at" in page


def test_a_latch_cleared_before_the_day_is_still_no_finding_with_the_longer_look_back(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(DAY0 - 2 * 86400 + i * 60), "idleS": 20, "integrity": {"state": st, "summary": LATCHED if st == "latched" else "no integrity latch"}}
                       for i, st in enumerate(["latched", "latched", "clear"])], T)
    r = wm.day_report(store, "2026-11-11", T, OFF)
    assert r["findings"] == []
    assert r["boxes"][0]["integrity"]["state"] == "clear"


def test_the_summary_cuts_shares_with_slashes_relative_backslash_paths_file_urls_and_the_tail_after_a_cut():
    # Check E19-2: the forms the first pattern let through.
    assert wm.public_summary("at //nas/home/photos now") == "at [a path]"
    assert wm.public_summary("at civer\\.ssh") == "at [a path]"
    assert wm.public_summary("at %USERPROFILE%\\.ssh") == "at [a path]"
    assert wm.public_summary("at file:///home/civer/x") == "at [a path]"
    assert wm.public_summary("at FILE://nas/x") == "at [a path]"
    assert wm.public_summary("at C:\\Program Files (x86)\\X\\y") == "at [a path] (x86)[a path]"
    assert wm.public_summary("at C:\\Users\\a,b\\c") == "at [a path],[a path]"
    assert wm.public_summary("at C:\\Users\\O'Brien\\x") == "at [a path]'[a path]"
    # Check E19b-5: a share written with three slashes.
    assert wm.public_summary("at ///nas/x") == "at [a path]"
    # Check E19b-4: the tail after a cut is cut when written with forward slashes too, and when a space
    # in the name came after the cut; a clause that begins after a space is a new clause and is kept.
    assert wm.public_summary("at C:/Users/O'Brien/x") == "at [a path]'[a path]"
    assert wm.public_summary("at C:/Users/a,b/c") == "at [a path],[a path]"
    assert wm.public_summary("at C:/Users/a,b,c/d") == "at [a path],[a path]"
    assert wm.public_summary("at C:/Users/O'Brien Smith/x") == "at [a path]'[a path]"
    assert wm.public_summary("at C:\\Users\\O'Brien Smith\\x") == "at [a path]'[a path]"
    assert wm.public_summary("at C:/x(y/z) now") == "at [a path]([a path]) now"
    assert wm.public_summary("at C:/x, then a/b") == "at [a path], then a/b"
    assert wm.public_summary("at C:/x,y") == "at [a path],y"
    assert wm.public_summary("at C:/x,y/z (presence)") == "at [a path],[a path] (presence)"
    # What is not a path stays: the engine's own words, a fraction, and/or, a closing tag, and a relative
    # path written with forward slashes only (it cannot be told from words like and/or).
    for kept in (LATCHED, UNUSABLE, "1/2 and/or </b>", "scripts/cynco-guard.mjs", "the box's scripts/cynco-guard.mjs"):
        assert wm.public_summary(kept) == kept, kept
    # A web address is over-redacted from the letter before its colon (read as a drive), never shown.
    assert wm.public_summary("see http://host/x") == "see htt[a path]"


def test_the_summary_never_carries_a_path_control_characters_or_unbounded_length():
    raw = "lost C:\\Users\\civer\\Documents\\secret plan.txt; \\\\nas\\home\\photos, /home/civer/.ssh/id; ~/no\x07tes; C:/x/y; kept: bun scripts/cynco-guard.mjs clear (first: PRESENCE) 1/2 and/or </script>"
    out = wm.public_summary(raw)
    for leak in ("Users", "civer", "secret", "plan.txt", "nas", "photos", ".ssh", "notes", "C:/x", "\x07"):
        assert leak not in out, (leak, out)
    assert out.count("[a path]") == 5, out
    assert out.startswith("lost [a path]; [a path], [a path]; [a path]; [a path]; kept: "), out
    assert "bun scripts/cynco-guard.mjs clear (first: PRESENCE) 1/2 and/or </script>" in out
    # A path runs to the end of its clause: a name with a space in it is not cut in two.
    assert wm.public_summary("C:\\a b\\c d and more; next") == "[a path]; next"
    assert wm.public_summary("set at C:\\x (presence)") == "set at [a path] (presence)"
    long = wm.public_summary("x " * 1000)
    assert len(long) <= wm.INTEGRITY_SUMMARY_MAX and long.endswith("...")
    assert wm.public_summary(None) == "" and wm.public_summary(5) == ""
    # Check E19-5: a line break and an escape character are control characters too.
    assert wm.public_summary("a\nb\x1bc\rd\x7fe") == "a b c d e"


def test_a_path_a_box_sends_reaches_neither_the_finding_nor_the_page(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    leaky = "1 change(s) in protected folders (first: PRESENCE) at C:\\Users\\civer\\.ssh"
    store.add("main", [{"t": "sample", "at": iso(T + i * 60), "idleS": 20, "integrity": {"state": "latched", "summary": leaky}} for i in range(3)], T + 200)
    r = wm.day_report(store, "2026-11-11", T + 200, OFF)
    assert kinds(r["findings"]) == ["integrity.latched"]
    page = watchnote.render(r)
    data = watchnote.findings_json(r)
    for text in (page, repr(data)):
        assert "civer" not in text and ".ssh" not in text
    assert "[a path]" in page


# ---- the note ---------------------------------------------------------------------------------
def test_the_note_shows_the_latch_in_the_status_line_the_box_card_and_the_flagged_list(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(T + i * 60), "idleS": 20, "integrity": {"state": "latched" if i >= 2 else "clear", "summary": LATCHED if i >= 2 else "no integrity latch"}} for i in range(5)], T + 300)
    r = wm.day_report(store, "2026-11-11", T + 270, OFF)
    assert r["boxes"][0]["integrity"] == {"state": "latched", "summary": LATCHED, "at": T + 240}
    page = watchnote.render(r)
    assert "main: awake since 09:00, last heard" in page and "; integrity latch set" in page
    assert "Integrity latch: set (as last reported at 09:04, 2026-11-11T16:04:00Z)" in page
    assert watchnote.e(LATCHED) in page
    assert "The integrity latch is set" in page and "still true" in page
    data = watchnote.findings_json(r)
    assert data["findings"][0]["kind"] == "integrity.latched" and data["findings"][0]["title"] == "The integrity latch is set"
    assert data["boxes"][0]["integrity"] == {"state": "latched", "summary": LATCHED, "at": "2026-11-11T16:04:00Z"}


def test_a_clear_latch_is_one_quiet_line_and_a_box_that_never_said_shows_nothing_of_it(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(T + i * 60), "idleS": 20, "integrity": {"state": "clear", "summary": "no integrity latch"}} for i in range(3)], T + 200)
    store.add("image", [{"t": "sample", "at": iso(T + i * 60), "idleS": 20} for i in range(3)], T + 200)
    r = wm.day_report(store, "2026-11-11", T + 150, OFF)
    page = watchnote.render(r)
    assert "Integrity latch: none (as last reported at 09:02, 2026-11-11T16:02:00Z)" in page
    assert page.count("Integrity latch:") == 1, "the box with no such field says nothing about it"
    assert "integrity latch set" not in page and "Flagged (0)" in page
    assert [b.get("integrity") for b in watchnote.findings_json(r)["boxes"]] == [None, {"state": "clear", "summary": "no integrity latch", "at": "2026-11-11T16:02:00Z"}]


def test_a_box_whose_guard_folder_is_unusable_says_so_in_words_in_its_status_line_and_card(tmp_path):
    # Check E19-5: the second state's words, which no case read before.
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(T + i * 60), "idleS": 20, "integrity": {"state": "unusable", "summary": UNUSABLE}} for i in range(3)], T + 200)
    r = wm.day_report(store, "2026-11-11", T + 150, OFF)
    page = watchnote.render(r)
    assert "; integrity guard folder unusable" in page
    assert "Integrity latch: the guard folder cannot be used (as last reported at 09:02, 2026-11-11T16:02:00Z)" in page
    assert "The guard folder could not be used" in page
    assert watchnote.findings_json(r)["boxes"][0]["integrity"]["state"] == "unusable"


def test_a_past_days_note_shows_the_latch_as_it_stood_at_the_end_of_that_day(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    end = DAY1 - 120
    store.add("main", [{"t": "sample", "at": iso(end + i * 60), "idleS": 20, "integrity": {"state": st, "summary": LATCHED if st == "latched" else "no integrity latch"}}
                       for i, st in enumerate(["latched", "latched", "clear"])], DAY1 + 100)
    r = wm.day_report(store, "2026-11-11", DAY1 + 3600, OFF)
    assert r["boxes"][0]["integrity"]["state"] == "latched", "the clear report came after the day ended"
    assert "(this is a past day); integrity latch set" in watchnote.render(r)
    # Wave 19b: the finding still sees the clear report just after the day, so it is closed, not "still does".
    assert kinds(r["findings"]) == ["integrity.latched"] and r["findings"][0]["open"] is False


def test_a_past_days_open_latch_runs_to_the_last_report_after_that_day(tmp_path):
    # Check E19b-5: the box kept reporting its latch set for 4 minutes after the day ended, and said
    # nothing more; asked an hour later, the open stretch runs to that last report, not to the day's end.
    store = Store(str(tmp_path / "w.db"))
    store.add("main", [{"t": "sample", "at": iso(DAY1 - 120 + i * 60), "idleS": 20, "integrity": {"state": "latched", "summary": LATCHED}}
                       for i in range(7)], DAY1 + 300)
    r = wm.day_report(store, "2026-11-11", DAY1 + 3600, OFF)
    assert kinds(r["findings"]) == ["integrity.latched"]
    f = r["findings"][0]
    assert f["open"] is True and f["from"] == DAY1 - 120
    assert f["to"] == DAY1 + 240, "the last report after the day, not the day's end"


def test_what_a_box_sent_in_its_latch_is_escaped(tmp_path):
    store = Store(str(tmp_path / "w.db"))
    evil = '<script>alert(1)</script>"><b>'
    store.add("main", [{"t": "sample", "at": iso(T + i * 60), "integrity": {"state": "latched", "summary": evil}} for i in range(3)], T + 200)
    page = watchnote.render(wm.day_report(store, "2026-11-11", T + 150, OFF))
    assert "<script" not in page and "<b>" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    assert not re.search(r"\bon[a-z]+\s*=", page)
