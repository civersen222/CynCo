# CivKings C6 Vertical Slice — Supervision-Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to dispatch Campaign C6 (menu → play → ending vertical slice) as one CynCo mission: staged CC0 audio, sealed gate_c6 + perturb_c6, c6-wave1 brief, Rule-11 calibration at the post-6B BASE, dispatch.

**Architecture:** Game code is CynCo-mission-only (CynCo-Only Scope). This plan builds the supervision artifacts: assets are pre-staged outside the repo (missions cannot download; they copy from staging), the gate defines the pinned surfaces (absent surface = clean FAIL, never a gate error), the perturb stub proves the gate catches a lazy claim, and calibration measures every threshold (F89: never invented).

**Tech Stack:** Python/pygame (gate), bash + curl (staging), CynCo dispatch harness (`scripts/dispatch-mission.sh`), sealed gates at `~/.cynco/heldout/civkings-redesign/c6/`.

**Spec:** `docs/superpowers/specs/2026-08-28-civkings-aaa-roadmap-design.md`

**Pinned surfaces (single source of truth — gate, perturb, and brief all use exactly these):**
- `gilded.ui.app.new_app_state(seed, ..., start="game")` — new keyword; `start="menu"` boots to a drawn main menu with `s.game is None`; the default `start="game"` keeps every prior surface byte-identical (C1..C6B regression depends on it).
- Menu regions: `group="menu"`, actions `{"menu": "new_game"|"continue"|"settings"|"quit"}`; Continue is `RegionState.DISABLED` with a non-empty `.reason` when no `gilded_quicksave.gsave` exists in cwd; pressing `new_game` constructs `GildedGame(seed)` into `s.game`; pressing `continue` loads the save.
- `gilded.settings`: `load_settings(path=None) -> Settings`, `save_settings(settings, path=None)`; file `gilded_settings.json` in cwd; fields `window_size`, `narrate`, `volume`, `mute`. Settings regions: `group="settings"`, action `{"setting": <field>}`; pressing one changes the value AND writes the file.
- `gilded.audio`: `SOUND_EVENTS` (dict, at least the 6 events `ui_press`, `end_turn`, `war_declared`, `beat`, `ending`, `ambient`), `resolve(event) -> abs path`, `play(event, settings) -> bool` (False when muted or mixer unavailable; never raises). Assets live in `gilded/assets/audio/` with `LICENSES.md`.
- Clarity: after `view.draw(screen)`, `view.text_rows` is a list of `(pygame.Rect, str)` — one entry per text line drawn on the active tab.
- Cold-open onboarding: beats with `kind="onboarding"`, facets `{"win","orders","ambitions","war","turn"}`, all five landing within the first 5 turns.
- Depth chains: beats with `kind="chain"`, `facet=<chain id>`; ≥3 distinct chain ids over a 70-turn seed-42 run, each with ≥3 beats spanning ≥2 turns.
- Ending: `gilded.endings.check_ending(game, house)` returns non-None within 70 turns of the seed-42 menu-started run; `judge(game, house)` yields an Epilogue with non-empty text.

---

### Task 1: Stage the CC0 audio pack

**Files:**
- Create: `C:\Users\civer\.cynco\staged-assets\c6-audio\` (6+ sound files)
- Create: `C:\Users\civer\.cynco\staged-assets\c6-audio\LICENSES.md`

- [ ] **Step 1: Download the three Kenney CC0 packs** (delegated by user for this task)

```bash
mkdir -p ~/.cynco/staged-assets/c6-audio/_packs && cd ~/.cynco/staged-assets/c6-audio/_packs
curl -L -o interface-sounds.zip "https://kenney.nl/media/pages/assets/interface-sounds/*/kenney_interface-sounds.zip" || true
curl -L -o ui-audio.zip "https://kenney.nl/media/pages/assets/ui-audio/*/kenney_ui-audio.zip" || true
curl -L -o digital-audio.zip "https://kenney.nl/media/pages/assets/digital-audio/*/kenney_digital-audio.zip" || true
```

Note: kenney.nl download URLs are versioned; if the globbed URLs 404, fetch the asset pages (`https://kenney.nl/assets/interface-sounds`, `.../ui-audio`, `.../digital-audio`) with WebFetch and extract the real zip hrefs, then curl those. All three packs are CC0 (confirmed by research 2026-08-28).

- [ ] **Step 2: Unzip and inspect**

```bash
cd ~/.cynco/staged-assets/c6-audio/_packs
for z in *.zip; do unzip -o -q "$z" -d "${z%.zip}"; done
find . -name "*.ogg" | head -30
```

- [ ] **Step 3: Select and rename 5 event sounds** — pick by listening names (clicks/confirmations/bells); exact source files chosen at execution, recorded in LICENSES.md:

```bash
cd ~/.cynco/staged-assets/c6-audio
cp _packs/interface-sounds/Audio/click_001.ogg ui_press.ogg          # or nearest click
cp _packs/interface-sounds/Audio/confirmation_001.ogg end_turn.ogg   # bell-like confirm
cp _packs/digital-audio/Audio/powerUp1.ogg war_declared.ogg          # rising stinger
cp _packs/ui-audio/Audio/switch2.ogg beat.ogg                        # soft tick
cp _packs/digital-audio/Audio/highUp.ogg ending.ogg                  # resolving sting
```

(If a named file does not exist in the pack, pick the closest-named sibling; the requirement is 5 distinct, short, UI-appropriate sounds.)

- [ ] **Step 4: Synthesize the ambient loop ourselves** (no CC0 ambience in these packs; we author it, so licensing is trivial)

```bash
python - <<'EOF'
import math, struct, wave, os
path = os.path.expanduser("~/.cynco/staged-assets/c6-audio/ambient.wav")
rate, secs = 22050, 8
n = rate * secs
frames = bytearray()
for i in range(n):
    t = i / rate
    fade = min(t / 0.5, (secs - t) / 0.5, 1.0)   # loop-friendly edges
    v = (0.20 * math.sin(2 * math.pi * 110 * t)
         + 0.12 * math.sin(2 * math.pi * 164.8 * t)
         + 0.08 * math.sin(2 * math.pi * 220 * t + 0.7))
    frames += struct.pack("<h", int(32767 * 0.35 * fade * v))
with wave.open(path, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(bytes(frames))
print(path, os.path.getsize(path), "bytes")
EOF
```

Expected: `ambient.wav` ~352 KB.

- [ ] **Step 5: Write LICENSES.md**

```markdown
# C6 staged audio — licenses

| file | source | license |
|---|---|---|
| ui_press.ogg | Kenney Interface Sounds (kenney.nl/assets/interface-sounds), <original filename> | CC0 1.0 |
| end_turn.ogg | Kenney Interface Sounds, <original filename> | CC0 1.0 |
| war_declared.ogg | Kenney Digital Audio (kenney.nl/assets/digital-audio), <original filename> | CC0 1.0 |
| beat.ogg | Kenney UI Audio (kenney.nl/assets/ui-audio), <original filename> | CC0 1.0 |
| ending.ogg | Kenney Digital Audio, <original filename> | CC0 1.0 |
| ambient.wav | synthesized in-house (this repo's supervision tooling), 2026-08-28 | CC0 1.0 (authored by us, dedicated) |
```

Fill `<original filename>` with the real names from Step 3.

- [ ] **Step 6: Validate every staged file loads under the dummy audio driver**

```bash
cd ~/.cynco/staged-assets/c6-audio && SDL_AUDIODRIVER=dummy python - <<'EOF'
import glob, pygame
pygame.mixer.init()
files = [f for f in glob.glob("*.*") if f.endswith((".ogg", ".wav"))]
assert len(files) >= 6, files
for f in files:
    pygame.mixer.Sound(f)   # raises on a corrupt file
print("OK:", sorted(files))
EOF
```

Expected: `OK: ['ambient.wav', 'beat.ogg', ...]` — 6 files. Then `rm -rf _packs` is NOT run — keep the packs for later campaigns (C8 needs more).

---

### Task 2: Author gate_c6.py (draft — thresholds finalized in Task 5)

**Files:**
- Create: `C:\Users\civer\.cynco\heldout\civkings-redesign\c6\gate_c6.py`

- [ ] **Step 1: Write the gate** (BASE line and TEXT_ROWS_FLOOR are placeholders until calibration):

```python
# gate_c6.py — sealed. Campaign C6: the vertical slice (menu -> play -> ending).
# Contract: docs/civkings-redesign-briefs/c6-wave1.txt.
# BASE: <PINNED AT CALIBRATION — post-6B head>.
# Required surfaces this gate defines (absent = clean FAIL, not a gate error):
# see the PINNED SURFACES block of the brief — new_app_state(start="menu"),
# menu/settings regions, gilded.settings, gilded.audio, view.text_rows,
# onboarding/chain beats, endings within 70 turns at seed 42.
# TEXT_ROWS_FLOOR: MEASURED at calibration by counting font-render blits on
# the BASE House tab (floor = half the measured count). F89: never invented.
import json
import os
import subprocess
import sys
import tempfile

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
REPO = r"C:\Users\civer\civkings"
sys.path.insert(0, REPO)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FAILS = []
SEED = 42
ENDING_TURNS = 70
TEXT_ROWS_FLOOR = None   # set at calibration; gate FAILS if left None
ONBOARD_FACETS = {"win", "orders", "ambitions", "war", "turn"}
SOUND_EVENTS_REQUIRED = ("ui_press", "end_turn", "war_declared",
                         "beat", "ending", "ambient")


def check(name, cond, detail=""):
    print(f"{name}: {'PASS' if cond else 'FAIL'} {detail}")
    if not cond:
        FAILS.append(name)


def press(s, region):
    from gilded.ui.app import _apply_action
    try:
        action = s.view.handle_click(region.rect.center)
        if action is None:
            return f"no action (state={region.state} reason={getattr(region, 'reason', None)!r})"
        _apply_action(s, action)
        return None
    except Exception as e:
        return f"{type(e).__name__}: {e}"


def regions(s, group):
    s.view.draw(s.screen)
    return [r for r in s.view.regions._regions
            if getattr(r, "group", "") == group
            and isinstance(r.action, dict)]


def boot_menu(seed=SEED):
    from gilded.ui.app import new_app_state
    try:
        return new_app_state(seed=seed, start="menu")
    except TypeError:
        return None   # surface absent at BASE -> clean FAIL downstream


workdir = tempfile.mkdtemp(prefix="gate_c6_")
os.chdir(workdir)   # menu/save/settings surfaces key off cwd

from gilded.ui.widgets import RegionState  # noqa: E402

# ── C6.1 menu boots, four verbs drawn, Continue is an honest refusal ────────
s = boot_menu()
if s is None:
    check("C6.1a.menu-boots", False, 'new_app_state(start="menu") not accepted')
else:
    menu = {r.action.get("menu"): r for r in regions(s, "menu")}
    check("C6.1a.menu-boots", s.game is None and len(menu) >= 4,
          f"game={s.game!r} verbs={sorted(k for k in menu if k)}")
    cont = menu.get("continue")
    check("C6.1b.continue-refusal",
          cont is not None and cont.state == RegionState.DISABLED
          and bool((getattr(cont, "reason", "") or "").strip()),
          "omitted" if cont is None else
          f"state={cont.state} reason={getattr(cont, 'reason', None)!r}")
    # ── C6.1c New Game press actually constructs a playable world ───────────
    ng = menu.get("new_game")
    err = press(s, ng) if ng is not None else "no new_game region"
    playable = (err is None and s.game is not None
                and len(getattr(s.game, "houses", [])) >= 6)
    if playable:
        try:
            s.game.end_turn()
            s.view.draw(s.screen)
        except Exception as e:
            playable, err = False, f"{type(e).__name__}: {e}"
    check("C6.1c.new-game-press", playable, f"err={err}")

# ── C6.2 Continue loads a real save ─────────────────────────────────────────
if s is not None and s.game is not None:
    from gilded.save import save_game  # pinned in gilded/save.py at BASE
    for _ in range(4):
        s.game.end_turn()
    save_game(s.game, s.save_path) if hasattr(sys.modules.get("gilded.save"),
                                              "save_game") else None
    s2 = boot_menu()
    menu2 = {r.action.get("menu"): r for r in regions(s2, "menu")} if s2 else {}
    cont2 = menu2.get("continue")
    ok = cont2 is not None and cont2.state == RegionState.ENABLED
    err = press(s2, cont2) if ok else "continue not ENABLED with a save present"
    loaded = ok and err is None and s2.game is not None \
        and getattr(s2.game, "turn", 0) >= 4
    check("C6.2.continue-loads", loaded,
          f"err={err} turn={getattr(getattr(s2, 'game', None), 'turn', None)}")
else:
    check("C6.2.continue-loads", False, "no playable game from C6.1c")

# ── C6.3 settings press persists across a fresh process ─────────────────────
s3 = boot_menu()
persisted = False
detail = "menu unreachable"
if s3 is not None:
    menu3 = {r.action.get("menu"): r for r in regions(s3, "menu")}
    err = press(s3, menu3["settings"]) if menu3.get("settings") else "no settings verb"
    if err is None:
        setts = {r.action.get("setting"): r for r in regions(s3, "settings")}
        mute = setts.get("mute")
        err = press(s3, mute) if mute is not None else "no mute control drawn"
    if err is None:
        p = subprocess.run(
            [sys.executable, "-c",
             "from gilded.settings import load_settings; "
             "import sys; sys.exit(0 if load_settings().mute else 1)"],
            cwd=workdir, env={**os.environ, "PYTHONPATH": REPO},
            capture_output=True, text=True, timeout=120)
        persisted = p.returncode == 0
        detail = f"fresh-process load_settings().mute rc={p.returncode} " \
                 f"file={os.path.exists(os.path.join(workdir, 'gilded_settings.json'))}"
    else:
        detail = f"err={err}"
check("C6.3.settings-persist", persisted, detail)

# ── C6.4 audio registry is real and honors mute ─────────────────────────────
try:
    from gilded import audio
    missing = [e for e in SOUND_EVENTS_REQUIRED if e not in audio.SOUND_EVENTS]
    ghosts = [e for e in SOUND_EVENTS_REQUIRED if e not in missing
              and not os.path.isfile(audio.resolve(e))]
    check("C6.4a.audio-registry", not missing and not ghosts,
          f"missing={missing} files-absent={ghosts}")
    from gilded.settings import Settings
    muted = Settings(mute=True) if "Settings" in dir(sys.modules["gilded.settings"]) else None
    check("C6.4b.audio-mute",
          muted is not None and audio.play("ui_press", muted) is False,
          "play() must return False when muted")
    lic = os.path.join(REPO, "gilded", "assets", "audio", "LICENSES.md")
    check("C6.4c.audio-licenses", os.path.isfile(lic), lic)
except ImportError as e:
    check("C6.4a.audio-registry", False, f"gilded.audio absent: {e}")
    check("C6.4b.audio-mute", False, "gilded.audio absent")
    check("C6.4c.audio-licenses", False, "gilded.audio absent")

# ── C6.5 clarity: no two drawn text rows collide, page is populated ─────────
from gilded.ui.app import new_app_state  # noqa: E402
sc = new_app_state(seed=SEED)
for turn_stop in (0, 10, 40):
    while getattr(sc.game, "turn", 0) < turn_stop:
        sc.game.end_turn()
    for tab in ("House", "Powers", "Atlas"):
        sc.view.active_tab = tab
        sc.view.draw(sc.screen)
        rows = getattr(sc.view, "text_rows", None)
        if rows is None:
            check(f"C6.5.t{turn_stop}.{tab}", False, "view.text_rows absent")
            continue
        hits = []
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                if rows[i][0].colliderect(rows[j][0]):
                    hits.append((rows[i][1][:30], rows[j][1][:30]))
        floor_ok = (tab != "House" or turn_stop != 0
                    or (TEXT_ROWS_FLOOR is not None
                        and len(rows) >= TEXT_ROWS_FLOOR))
        check(f"C6.5.t{turn_stop}.{tab}", not hits and floor_ok,
              f"rows={len(rows)} overlaps={len(hits)} first={hits[:2]}")

# ── C6.6/7/8 one seeded slice run: cold-open, chains, ending ────────────────
s = boot_menu()
run_ok = False
if s is not None:
    menu = {r.action.get("menu"): r for r in regions(s, "menu")}
    if menu.get("new_game") is not None and press(s, menu["new_game"]) is None \
            and s.game is not None:
        run_ok = True
if not run_ok:
    for nm in ("C6.6.cold-open", "C6.7.chains", "C6.8.ending"):
        check(nm, False, "no menu-started game")
else:
    g, house = s.game, s.house
    from gilded.endings import check_ending, judge
    ended_at = None
    for t in range(1, ENDING_TURNS + 1):
        g.end_turn()
        if ended_at is None and check_ending(g, house):
            ended_at = t
    beats = list(g.beats.log)
    ob = {getattr(b, "facet", "") for b in beats
          if getattr(b, "kind", "") == "onboarding"
          and getattr(b, "turn", 99) <= 5}
    check("C6.6.cold-open", ONBOARD_FACETS <= ob,
          f"facets in first 5 turns: {sorted(ob)} (need {sorted(ONBOARD_FACETS)})")
    chains = {}
    for b in beats:
        if getattr(b, "kind", "") == "chain":
            chains.setdefault(b.facet, []).append(b)
    good = [cid for cid, bs in chains.items()
            if len(bs) >= 3 and len({b.turn for b in bs}) >= 2]
    check("C6.7.chains", len(good) >= 3,
          f"chains={{{', '.join(f'{c}:{len(bs)}' for c, bs in chains.items())}}} "
          f"qualifying={good}")
    ep = judge(g, house) if ended_at else None
    check("C6.8.ending", ended_at is not None and ep is not None
          and bool(ep and getattr(ep, 'ending_key', '') and str(ep)),
          f"ended_at={ended_at} (cap {ENDING_TURNS})")

# ── C6.9 — C1..C6B regression chain ─────────────────────────────────────────
os.chdir(os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get("CYNCO_GATE_SKIP_PRIOR"):
    prior = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "..", "6b", "gate_6b.py")
    code = open(prior, encoding="utf-8").read()
    cut = code.rindex("sys.exit(0 if not FAILS else 1)")
    code = code[:cut] + code[cut + len("sys.exit(0 if not FAILS else 1)"):]
    ns = {"__file__": prior}
    exec(compile(code, prior, "exec"), ns)
    for f in ns["FAILS"]:
        FAILS.append(f"6b-regression.{f}")
    check("C6.9", not ns["FAILS"], f"{len(ns['FAILS'])} prior-campaign regressions")

print("GATE:", "PASS" if not FAILS else f"MISS ({len(FAILS)} fails)")
sys.exit(0 if not FAILS else 1)
```

- [ ] **Step 2: Syntax-check the draft**

Run: `python -m py_compile ~/.cynco/heldout/civkings-redesign/c6/gate_c6.py`
Expected: silent success. (Behavioral verification is Task 5 — surfaces don't exist yet.)

Known draft debt to resolve at calibration (Task 5): the exact `gilded.save` write entry point (audit showed `gilded/save.py` exists; confirm its public save function name at BASE and use it in C6.2), and `Settings(mute=True)` constructor shape.

---

### Task 3: Author perturb_c6.py (calibration cheat stub)

**Files:**
- Create: `C:\Users\civer\.cynco\heldout\civkings-redesign\c6\perturb_c6.py`

- [ ] **Step 1: Write the stub**

```python
# perturb_c6.py — calibration cheat stub for gate_c6.py.
# Installs a world that CLAIMS a slice: a fake menu whose regions draw with
# the right groups/actions but whose New Game press builds NOTHING, a fake
# gilded.audio whose SOUND_EVENTS point at files that do not exist, a fake
# gilded.settings that never writes to disk, and text_rows = [] (no page).
# EXPECTED to flip PASS: C6.1a (menu drawn), C6.1b (refusal present),
#   C6.4a's key-presence half is claimed (but file-absence keeps it FAIL).
# Discriminators that MUST still FAIL:
#   C6.1c (press builds no game), C6.2, C6.3 (nothing persists),
#   C6.4a/b (files absent, mute contract), C6.5 (rows floor), C6.6/7/8.
# Skips the prior-campaign chain (calibration harness only).
import os
import sys
import types

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
sys.path.insert(0, r"C:\Users\civer\civkings")

import pygame  # noqa: E402
import gilded.ui.app as app  # noqa: E402
from gilded.ui.widgets import RegionState  # noqa: E402


class _FakeRegion:
    def __init__(self, y, action, state, reason=""):
        self.rect = pygame.Rect(10, y, 200, 24)
        self.action = action
        self.state = state
        self.reason = reason
        self.group = "menu"


class _FakeRegions:
    def __init__(self, regs):
        self._regions = regs


class _FakeView:
    def __init__(self):
        self.active_tab = "Menu"
        self.text_rows = []
        self.regions = _FakeRegions([
            _FakeRegion(10, {"menu": "new_game"}, RegionState.ENABLED),
            _FakeRegion(40, {"menu": "continue"}, RegionState.DISABLED,
                        "no saved game"),
            _FakeRegion(70, {"menu": "settings"}, RegionState.ENABLED),
            _FakeRegion(100, {"menu": "quit"}, RegionState.ENABLED),
        ])

    def draw(self, screen):
        pass

    def handle_click(self, pos):
        for r in self.regions._regions:
            if r.rect.collidepoint(pos) and r.state == RegionState.ENABLED:
                return r.action
        return None


_real_new_app_state = app.new_app_state


def fake_new_app_state(seed, player_house=None, size=None, start="game"):
    if start != "menu":
        return _real_new_app_state(seed, player_house)
    pygame.init()
    screen = pygame.display.set_mode((640, 480))
    st = types.SimpleNamespace(game=None, view=_FakeView(), screen=screen,
                               house=None, clock=pygame.time.Clock(),
                               save_path=os.path.join(os.getcwd(),
                                                      "gilded_quicksave.gsave"))
    return st


app.new_app_state = fake_new_app_state

_real_apply = app._apply_action


def fake_apply(state, action):
    if isinstance(action, dict) and "menu" in action:
        return          # the cheat: presses are swallowed, nothing is built
    return _real_apply(state, action)


app._apply_action = fake_apply

# a claimed audio module whose files do not exist
fake_audio = types.ModuleType("gilded.audio")
fake_audio.SOUND_EVENTS = {e: f"{e}.ogg" for e in
                           ("ui_press", "end_turn", "war_declared",
                            "beat", "ending", "ambient")}
fake_audio.resolve = lambda e: os.path.join(
    r"C:\Users\civer\civkings", "gilded", "assets", "audio",
    fake_audio.SOUND_EVENTS[e])
fake_audio.play = lambda e, settings: True   # violates the mute contract
sys.modules["gilded.audio"] = fake_audio

# a claimed settings module that never touches disk
fake_settings = types.ModuleType("gilded.settings")


class Settings:
    def __init__(self, window_size=(1280, 900), narrate=True,
                 volume=1.0, mute=False):
        self.window_size, self.narrate = window_size, narrate
        self.volume, self.mute = volume, mute


fake_settings.Settings = Settings
fake_settings.load_settings = lambda path=None: Settings()
fake_settings.save_settings = lambda s, path=None: None
sys.modules["gilded.settings"] = fake_settings

import runpy  # noqa: E402
gate = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c6.py")
runpy.run_path(gate, run_name="__main__")
```

- [ ] **Step 2: Syntax-check**

Run: `python -m py_compile ~/.cynco/heldout/civkings-redesign/c6/perturb_c6.py`
Expected: silent success.

---

### Task 4: Write the c6-wave1 brief and commit spec-side artifacts

**Files:**
- Create: `C:\Users\civer\localcode\docs\civkings-redesign-briefs\c6-wave1.txt`

- [ ] **Step 1: Write the brief.** Same shape as `6b-wave1.txt` (which passed a live mission): MISSION header, BASE (placeholder until calibration), THE DIAGNOSIS quoting the 2026-08-28 audit verbatim (boot 4.26 s, 21 ms/frame, zero audio, no menu, no settings, House-tab overdraw, no onboarding, endings/save exist — do NOT rebuild them), THE DESIGN INTENT (the §4.1 slice paragraph), a SUCCESS CONTRACT table mapping 1:1 to gate check ids C6.1a–C6.9, HONESTY RULES (the perturb story: a menu that draws but builds nothing still MISSes C6.1c/2/3; audio keys without files still MISS C6.4; `text_rows=[]` still MISSes C6.5), PINNED SURFACES (copy the block from this plan's header verbatim), the staged-assets rule:

```
- NO downloads. The audio files are ALREADY STAGED for you at
  C:\Users\civer\.cynco\staged-assets\c6-audio\ (6 files + LICENSES.md).
  Copy them into gilded/assets/audio/ and commit them with LICENSES.md.
```

a SELF-CHECK (committed `gilded/tests/test_c6_contract.py`, a pytest mirror of C6.1–C6.8 exactly as the 6B brief embedded its contract test), the standard RULES block (CodeIndex first; wire-check greps in the final commit message; commit early and often; the automated probe runs the contract test whenever you go quiet; adapt prior tests honestly), and DONE WHEN with the marker line: `stage c6 complete`.

- [ ] **Step 2: Commit plan + brief via web flow**

```bash
cd /c/Users/civer/localcode
git checkout -b c6-supervision-artifacts
git add -f docs/superpowers/plans/2026-08-28-civkings-c6-vertical-slice.md docs/civkings-redesign-briefs/c6-wave1.txt
git commit -m "c6: supervision plan + wave-1 brief (BASE pinned after 6B verdict)"
git push -u origin c6-supervision-artifacts
gh pr create --title "c6: supervision plan + wave-1 brief" --body "Plan + brief for the C6 vertical slice; gate/perturb live in heldout. BASE + measured thresholds land after the 6B verdict."
gh pr merge --merge --delete-branch && git checkout main && git pull
```

---

### Task 5: Rule-11 calibration at the post-6B BASE  *(BLOCKED until watcher bi68v7l3r fires and the 6B verdict is recorded)*

**Files:**
- Modify: `~/.cynco/heldout/civkings-redesign/c6/gate_c6.py` (BASE line, TEXT_ROWS_FLOOR, save-API fixups)
- Modify: `docs/civkings-redesign-briefs/c6-wave1.txt` (BASE line)

- [ ] **Step 1: Pin BASE** — after the 6B verdict, `cd /c/Users/civer/civkings && git log -1 --format=%h` on the accepted head; write it into the gate header and the brief.

- [ ] **Step 2: Measure TEXT_ROWS_FLOOR at BASE** — count real text blits on the House tab (measured, not invented):

```bash
cd /c/Users/civer/civkings && SDL_VIDEODRIVER=dummy python - <<'EOF'
import os, sys
sys.path.insert(0, r"C:\Users\civer\civkings")
import pygame
count = [0]
_real = pygame.font.Font.render
def counting(self, text, *a, **k):
    if str(text).strip():
        count[0] += 1
    return _real(self, text, *a, **k)
pygame.font.Font.render = counting
from gilded.ui.app import new_app_state
s = new_app_state(seed=42)
s.view.active_tab = "House"
count[0] = 0
s.view.draw(s.screen)
print("House-tab text renders at BASE:", count[0])
EOF
```

Set `TEXT_ROWS_FLOOR = <measured> // 2` in the gate and record the measurement in the gate header comment.

- [ ] **Step 3: Confirm the save API** — `grep -n "^def " gilded/save.py` at BASE; fix the C6.2 block to call the real function (audit showed a versioned-header + pickle module with `quicksave_path()`); re-run `py_compile`.

- [ ] **Step 4: Clean-FAIL run at BASE**

Run: `CYNCO_GATE_SKIP_PRIOR=1 python ~/.cynco/heldout/civkings-redesign/c6/gate_c6.py; echo "exit=$?"`
Expected: every C6.1–C6.8 check prints FAIL with a *surface-absent* detail (no tracebacks, no gate errors), C6.5 FAILs on `text_rows absent`, exit=1. Any traceback = gate bug; fix before proceeding.

- [ ] **Step 5: Full-chain sanity at BASE**

Run: `python ~/.cynco/heldout/civkings-redesign/c6/gate_c6.py 2>&1 | tail -5`
Expected: C6.9 regression chain PASSES (BASE is the accepted post-6B head) while C6.1–C6.8 FAIL. If C6.9 fails, the 6B verdict was wrong — stop and investigate.

- [ ] **Step 6: Perturb run**

Run: `python ~/.cynco/heldout/civkings-redesign/c6/perturb_c6.py; echo "exit=$?"`
Expected: C6.1a and C6.1b flip PASS; C6.1c, C6.2, C6.3, C6.4a/b, C6.5.*, C6.6–C6.8 all still FAIL; exit=1. If any discriminator passes, strengthen the gate check it exposed, re-run Steps 4–6.

- [ ] **Step 7: Record calibration + commit brief BASE update** — gate header gets the calibration block (clean-FAIL date, perturb flip list, TEXT_ROWS measurement); brief BASE updated; commit the brief via web flow (`c6-calibration` branch, same PR pattern as Task 4 Step 2).

---

### Task 6: Dispatch C6 wave 1

- [ ] **Step 1: Pre-flight** — civkings clean at BASE (`git -C /c/Users/civer/civkings status --short` empty), no stale `test_c6_contract.py`, engine idle, staged assets present (`ls ~/.cynco/staged-assets/c6-audio/` shows 6 files + LICENSES.md).

- [ ] **Step 2: Dispatch** (same harness pattern that ran 6B):

```bash
cd /c/Users/civer/localcode
CYNCO_PROBE_TIMEOUT_MS=900000 CYNCO_BASH_TIMEOUT_MS=1800000 \
bash scripts/dispatch-mission.sh \
  docs/civkings-redesign-briefs/c6-wave1.txt \
  "stage c6 complete" \
  "C:\Users\civer\civkings" \
  21600 \
  "python -m pytest gilded/tests/test_c6_contract.py -q" \
  "python -m pytest gilded/tests/test_c6_contract.py -q"
```

(Probe = the contract test alone: the slice surfaces are new, so the contract test IS the discriminating fleet; the full 20-minute suite would block the driver's socket — same reasoning as 6B.)

- [ ] **Step 3: Arm the watcher**

```bash
until grep -qE "F131 teardown|ENGINE ERROR outcome" /c/tmp/driver_c6-wave1.log; do sleep 600; done; echo "=== c6 mission driver finished ==="; tail -80 /c/tmp/driver_c6-wave1.log
```

(run_in_background; verify the actual log filename the dispatch printed before arming.)

- [ ] **Step 4: Verdict work** — full gate by hand (incl. C6.9 chain), full civkings suite, ledger record + probe blocks, campaign-log verdict, CodeIndex adoption report, supervision-economics refresh, boot an idle engine so dashboard 9161 returns.

---

### Task 7: Wire check (BLOCKING, per standing rule)

- [ ] **Step 1: Prove every artifact is referenced from the live pipeline**

```bash
ls ~/.cynco/staged-assets/c6-audio/            # 6 files + LICENSES.md
grep -l "staged-assets" docs/civkings-redesign-briefs/c6-wave1.txt        # brief points at staging
grep -l "test_c6_contract" docs/civkings-redesign-briefs/c6-wave1.txt     # brief pins the self-check
grep -l "stage c6 complete" docs/civkings-redesign-briefs/c6-wave1.txt    # marker present
grep -l "gate_6b" ~/.cynco/heldout/civkings-redesign/c6/gate_c6.py        # regression chain wired
grep -l "gate_c6" ~/.cynco/heldout/civkings-redesign/c6/perturb_c6.py     # stub runs the real gate
```

Expected: every command prints its target path. Any silent miss = unwired artifact; fix before dispatch.

---

## Self-Review (done at write time)

- **Spec coverage:** §4.2 shell → C6.1/2/3 + brief; §4.3 audio → Task 1 + C6.4; §4.4 clarity/cold-open → C6.5/6; §4.5 chains → C6.7; §4.1 slice/ending → C6.8; §4.6 Rule-11 → Tasks 3+5; roadmap C7–C9 explicitly out of scope.
- **Placeholders:** the two intentional calibration placeholders (BASE, TEXT_ROWS_FLOOR) are marked MEASURED-AT-CALIBRATION with the exact measurement procedure in Task 5 — that is the F89 discipline, not a plan gap. Brief content is specified by section with the load-bearing text verbatim.
- **Consistency:** pinned-surface names identical across gate, perturb, and brief instructions (single block, copied verbatim); check ids C6.1a–C6.9 consistent between gate code and brief instruction.
