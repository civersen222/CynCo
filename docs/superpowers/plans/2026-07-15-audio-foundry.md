# CivKings Audio Foundry (Mode A) Implementation Plan

> **For agentic workers:** This plan is executed by **CynCo missions**, not a subagent. Each task below is authored as a CynCo mission brief (dispatched via `scripts/cynco-mission-driver.mjs`), then verified and ledger-labeled by the operator (Claude). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a build-time audio foundry in the civkings repo that mass-produces the game's voice/SFX/ambience library as plain WAV/OGG assets from existing event/dynasty content.

**Architecture:** A Python package `tools/audio_foundry/` alongside `tools/validate_events.py`. Pure derivation logic (`derive.py`, `roster.py`) + real engine adapters (`openmoss`, `thinksound`) with a `--dry-run` path so CynCo verifies headlessly without model weights. Mass batch produces a review manifest; nothing enters committed `assets/audio/` until human-reviewed.

**Tech Stack:** Python 3, `pwilkin/openmoss` (TTS CLI), `pwilkin/thinksound.cpp` (SFX CLI), existing civkings `music_manager`/`sound_manager`.

**Spec:** `docs/superpowers/specs/2026-07-15-civkings-audio-stack-design.md`

**Execution ground rules (from CynCo mission discipline):**
- Fresh engine per mission (kill :9160 tree + llama-server, relaunch). `LOCALCODE_S5_ENFORCE=false`, `LOCALCODE_APPROVE_ALL=true`.
- One mission in flight. cwd `C:\Users\civer\civkings`. Forward-slash brief paths. 900s timeout (1200s for game.py-heavy).
- Operator (Claude) never hand-edits civkings code — CynCo applies briefs; operator dispatches/verifies/labels.
- On driver TIMEOUT: do a final `git log` marker check before labeling failure (F9 late-landing remedy).
- Per-mission verify: AST-parse each touched file, run civkings pytest (baseline 25, no regression), run the brief's smoke script (must print OK), full-diff review vs brief. Patch ledger `verified:true` only if landed AND all checks pass.

---

## Task A1: Scaffold the audio_foundry package

**Files (CynCo creates in civkings repo):**
- Create: `tools/audio_foundry/__init__.py`
- Create: `tools/audio_foundry/config.py`
- Create: `tools/audio_foundry/LICENSES.md`
- Create: `tools/audio_foundry/validate_audio.py`
- Create: `tools/audio_foundry/tests/__init__.py`
- Create: `tools/audio_foundry/tests/test_config.py`

- [ ] **Step 1: Author the mission brief** at `C:/tmp/cynco-audio-a1-brief.txt`

Brief goal: "Scaffold tools/audio_foundry/ package with config, license record, and an audio validator smoke tool." Give CynCo the verbatim file contents below.

`config.py`:
```python
"""Audio foundry configuration: engine paths, output dirs, formats."""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = REPO_ROOT / "assets" / "audio"
VOICE_DIR = ASSET_ROOT / "voice"
SFX_DIR = ASSET_ROOT / "sfx"
AMBIENCE_DIR = ASSET_ROOT / "ambience"

SAMPLE_RATE_TTS = 24000
SAMPLE_RATE_SFX = 44100

@dataclass
class EngineConfig:
    openmoss_cli: str = field(default_factory=lambda: os.environ.get("OPENMOSS_CLI", "moss-tts-cli"))
    thinksound_cli: str = field(default_factory=lambda: os.environ.get("THINKSOUND_CLI", "ts-generate"))

def ensure_dirs() -> None:
    for d in (VOICE_DIR, SFX_DIR, AMBIENCE_DIR):
        d.mkdir(parents=True, exist_ok=True)
```

`LICENSES.md`: a table recording engine + weight licenses (openmoss/MOSS-TTS, thinksound.cpp/ThinkSound, lemonade) with columns: Component, Upstream repo, License, Notes. Fill "TBD — verify at supervised build" in the License cell (this is a *record*, not a gate — informational only).

`validate_audio.py`:
```python
"""Smoke gate: verify produced audio files exist, are non-empty, and are WAV."""
from __future__ import annotations
import sys, wave
from pathlib import Path

def validate_file(path: Path) -> tuple[bool, str]:
    if not path.exists():
        return False, f"missing: {path}"
    if path.stat().st_size == 0:
        return False, f"empty: {path}"
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                if w.getnframes() == 0:
                    return False, f"zero frames: {path}"
        except wave.Error as e:
            return False, f"bad wav {path}: {e}"
    return True, f"ok: {path}"

def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv[1:]]
    if not paths:
        print("usage: validate_audio.py FILE [FILE ...]")
        return 2
    failed = False
    for p in paths:
        ok, msg = validate_file(p)
        print(msg)
        failed = failed or not ok
    print("VALIDATE OK" if not failed else "VALIDATE FAIL")
    return 1 if failed else 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

`tests/test_config.py`:
```python
from tools.audio_foundry import config

def test_asset_dirs_under_repo():
    assert config.VOICE_DIR.name == "voice"
    assert config.SFX_DIR.parent == config.ASSET_ROOT

def test_engine_config_defaults():
    ec = config.EngineConfig()
    assert ec.openmoss_cli
    assert ec.thinksound_cli
```

Brief smoke check (CynCo runs, must print OK): `python -c "import ast,glob; [ast.parse(open(f,encoding='utf-8').read()) for f in glob.glob('tools/audio_foundry/**/*.py',recursive=True)]; print('SMOKE OK')"` then `python -m pytest tools/audio_foundry/tests/ -q`.

Commit marker (in brief, CynCo's final action): `chore: scaffold audio_foundry package`

- [ ] **Step 2: Dispatch** — `bun scripts/cynco-mission-driver.mjs C:/tmp/cynco-audio-a1-brief.txt "scaffold audio_foundry package" C:/Users/civer/civkings 900`
- [ ] **Step 3: Verify** — AST-parse the 4 new .py files; run `python -m pytest tools/audio_foundry/tests/ -q` (expect pass) + full civkings pytest (expect 25 baseline still green); confirm smoke printed OK; full-diff review vs brief.
- [ ] **Step 4: Label ledger** — append record; patch `verified:true` iff landed + all checks pass. On timeout, do final marker check first.

## Task A2: Real engine adapters with dry-run path

**Files:**
- Create: `tools/audio_foundry/adapters/__init__.py`
- Create: `tools/audio_foundry/adapters/openmoss.py`
- Create: `tools/audio_foundry/adapters/thinksound.py`
- Create: `tools/audio_foundry/tests/test_adapters.py`

**Interface contract (both adapters honor this exactly):**
- `generate(text: str, out_path: Path, *, voice: str | None = None, dry_run: bool = False) -> Path`
- When `dry_run=True`: write a valid 0.1s silent WAV at `out_path` at the engine's sample rate (no external process). This lets CynCo verify wiring with no weights installed.
- When `dry_run=False`: invoke the real CLI. **The exact CLI flags are filled in at the supervised checkpoint** (after `moss-tts-cli --help` / `ts-generate --help` are read on the built binaries). The brief instructs CynCo to implement the dry-run path fully and stub the real path with a single `subprocess.run([...])` call using the config CLI name + documented-but-unverified flags, marked with a `# VERIFY-AT-BUILD:` comment on the argv line.

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a2-brief.txt`. Provide verbatim the dry-run silent-WAV writer (below) and the adapter skeleton.

Silent-WAV helper (shared, put in `adapters/__init__.py`):
```python
"""Engine adapters. Shared dry-run helper."""
from __future__ import annotations
import wave, struct
from pathlib import Path

def write_silent_wav(out_path: Path, sample_rate: int, seconds: float = 0.1) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = int(sample_rate * seconds)
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack("<" + "h" * n, *([0] * n)))
    return out_path
```

`openmoss.py`:
```python
"""openmoss TTS adapter (text -> speech, optional cloned voice)."""
from __future__ import annotations
import subprocess
from pathlib import Path
from . import write_silent_wav
from ..config import EngineConfig, SAMPLE_RATE_TTS

def generate(text: str, out_path: Path, *, voice: str | None = None,
             dry_run: bool = False, cfg: EngineConfig | None = None) -> Path:
    if dry_run:
        return write_silent_wav(out_path, SAMPLE_RATE_TTS)
    cfg = cfg or EngineConfig()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    argv = [cfg.openmoss_cli, "--text", text, "--out", str(out_path)]  # VERIFY-AT-BUILD: confirm flags via `moss-tts-cli --help`
    if voice:
        argv += ["--voice", voice]  # VERIFY-AT-BUILD
    subprocess.run(argv, check=True)
    return out_path
```

`thinksound.py`: same shape, `SAMPLE_RATE_SFX`, `cfg.thinksound_cli`, argv `["--caption", text, "--out", str(out_path)]  # VERIFY-AT-BUILD`, no `voice` param.

`tests/test_adapters.py`:
```python
from pathlib import Path
from tools.audio_foundry.adapters import openmoss, thinksound
from tools.audio_foundry.validate_audio import validate_file

def test_openmoss_dry_run(tmp_path):
    p = openmoss.generate("hail the king", tmp_path / "v.wav", dry_run=True)
    ok, msg = validate_file(p)
    assert ok, msg

def test_thinksound_dry_run(tmp_path):
    p = thinksound.generate("sword clash", tmp_path / "s.wav", dry_run=True)
    ok, _ = validate_file(p)
    assert ok
```

Brief smoke: `python -m pytest tools/audio_foundry/tests/test_adapters.py -q` (must pass), plus AST parse. Marker: `feat: audio_foundry engine adapters (dry-run verified)`

- [ ] **Step 2: Dispatch** (same driver pattern, marker `"audio_foundry engine adapters"`).
- [ ] **Step 3: Verify** — AST + `pytest test_adapters.py` + full pytest 25 + diff review. Confirm every real-CLI argv line carries a `# VERIFY-AT-BUILD:` comment.
- [ ] **Step 4: Label ledger.**

## Task A3: Event → prompt derivation (pure)

**Files:**
- Create: `tools/audio_foundry/derive.py`
- Create: `tools/audio_foundry/tests/test_derive.py`

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a3-brief.txt`. First instruct CynCo to `grep` how events store `title`/`desc` (Appendix C schema) and confirm the field names before writing — do NOT assume. Then provide:

`derive.py`:
```python
"""Derive TTS lines and SFX captions from event content. Pure, no I/O."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class AudioPrompts:
    event_id: str
    tts_line: str      # narration text spoken aloud
    sfx_caption: str   # short caption describing the event's sound

def derive_for_event(event: dict) -> AudioPrompts:
    eid = str(event.get("id") or event.get("event_id") or "unknown")
    title = (event.get("title") or "").strip()
    desc = (event.get("desc") or event.get("description") or "").strip()
    tts_line = f"{title}. {desc}".strip(". ").strip() or title or eid
    sfx_caption = title or desc[:80] or "generic event sting"
    return AudioPrompts(event_id=eid, tts_line=tts_line, sfx_caption=sfx_caption)

def derive_all(events: list[dict]) -> list[AudioPrompts]:
    return [derive_for_event(e) for e in events]
```

`tests/test_derive.py`:
```python
from tools.audio_foundry.derive import derive_for_event

def test_uses_title_and_desc():
    p = derive_for_event({"id": "e1", "title": "The Harvest Fails", "desc": "Famine grips the land."})
    assert "Harvest" in p.tts_line and "Famine" in p.tts_line
    assert p.sfx_caption == "The Harvest Fails"

def test_missing_fields_fallback():
    p = derive_for_event({"id": "e2"})
    assert p.tts_line == "e2"
    assert p.sfx_caption == "generic event sting"
```

Note in brief: if the grep shows the real field names differ (e.g. `name` not `title`), CynCo must adapt `derive_for_event` to the actual schema — a correct deviation. Smoke: `pytest test_derive.py -q`. Marker: `feat: audio_foundry event-to-prompt derivation`

- [ ] **Step 2: Dispatch.** **Step 3: Verify** (pytest + confirm field names match real event schema via diff). **Step 4: Label.**

## Task A4: Voice roster for the 8 leader dynasties

**Files:**
- Create: `tools/audio_foundry/roster.py`
- Create: `tools/audio_foundry/tests/test_roster.py`

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a4-brief.txt`. Instruct CynCo to grep the 8 curated leader dynasties (Part VIII / III.2 data — likely a dynasties/leaders data file) and build `roster.py` mapping each dynasty id → a `VoiceProfile(dynasty_id, display_name, voice_ref)` where `voice_ref` is a cloned-voice identifier string (a reference sample path or a named preset, resolved at the supervised checkpoint). Test asserts all 8 dynasties are covered and ids are unique. Marker: `feat: audio_foundry dynasty voice roster`
- [ ] **Step 2: Dispatch. Step 3: Verify** (all 8 present, unique ids, matches real dynasty data). **Step 4: Label.**

## Task A5: Batch runner + editorial review gate

**Files:**
- Create: `tools/audio_foundry/batch.py`
- Create: `tools/audio_foundry/review.py`
- Create: `tools/audio_foundry/tests/test_batch.py`

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a5-brief.txt`. Contract:
  - `batch.py`: `run_batch(events, *, dry_run) -> manifest_path` — for each event, derive → call openmoss (voice) + thinksound (SFX) → write to a *staging* dir (`assets/audio/_staging/`), and write `manifest.json` listing every clip with `{event_id, kind, path, prompt, reviewed: false}`.
  - `review.py`: `approved_clips(manifest) -> list[path]` returns only entries with `reviewed: true`; `promote(manifest)` moves approved clips from staging into `assets/audio/{voice,sfx}/` and refuses to promote any unreviewed clip (raises).
  - Test: dry-run batch over 2 sample events produces a manifest with all `reviewed:false`; `promote` on that manifest raises (nothing unreviewed ships); after flipping `reviewed:true`, `promote` moves files and `validate_audio` passes on them.
  - Emphasize the VII.4 gate: **nothing enters committed `assets/audio/` without review**. Marker: `feat: audio_foundry batch runner + editorial review gate`
- [ ] **Step 2: Dispatch. Step 3: Verify** (pytest, staging vs committed separation, promote-refuses-unreviewed). **Step 4: Label.**

## Task A6: Era ambience beds + expanded SFX definitions

**Files:**
- Create: `tools/audio_foundry/content_sets.py`
- Create: `tools/audio_foundry/tests/test_content_sets.py`

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a6-brief.txt`. Define data-only descriptors: 5 era ambience beds (era_id → caption for thinksound) matching the game's 5 eras, and an SFX set (name → caption) covering the master-plan SFX list (end turn, battle, build complete, event sting, succession bell) plus additional bespoke ones. `content_sets.py` exposes `ERA_BEDS: dict[str,str]` and `SFX_SET: dict[str,str]`. Test asserts 5 beds keyed by the real era ids (grep era enum first) and that the 5 named core SFX are present. These feed `batch.py` for ambience/SFX generation. Marker: `feat: audio_foundry era beds + SFX definitions`
- [ ] **Step 2: Dispatch. Step 3: Verify** (5 beds match real era ids, core SFX present). **Step 4: Label.**

## Task A7: Wire pre-baked assets into the game audio managers

**Files (CynCo modifies existing civkings game code):**
- Modify: the game's `music_manager` / `sound_manager` module(s) (grep to locate — master plan X.5)
- Create/Modify: a test under civkings tests covering missing-clip fallback

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-a7-brief.txt`. Instruct CynCo to grep and read `music_manager`/`sound_manager` first, then add a lookup that plays a pre-baked clip from `assets/audio/{voice,sfx,ambience}/` by event_id / sfx name / era_id, and **detect-and-degrade**: if the clip file is absent, log and fall back to current behavior (silence or existing placeholder) — never crash. Add a unit test asserting a missing clip returns gracefully (no exception). This is game.py-adjacent → 1200s timeout. Marker: `feat: play pre-baked audio_foundry assets with missing-clip fallback`
- [ ] **Step 2: Dispatch** (1200s timeout). **Step 3: Verify** — AST-parse touched game files, full civkings pytest (baseline + new fallback test green), smoke, diff review that fallback path exists. **Step 4: Label.**

## SUPERVISED CHECKPOINT (human, not a CynCo mission)

- [ ] **S1:** Operator + user build `pwilkin/openmoss` and `pwilkin/thinksound.cpp` on the RTX 5090 box; fetch MOSS-TTS + ThinkSound weights. Record actual licenses into `LICENSES.md` (replace the TBD cells).
- [ ] **S2:** Read `moss-tts-cli --help` and `ts-generate --help`; fill the real argv in `adapters/openmoss.py` / `thinksound.py`, replacing each `# VERIFY-AT-BUILD:` line. (This is a small CynCo brief authored *from observed help output*, or a direct supervised edit — user's call at the time.)
- [ ] **S3:** Run one real TTS line and one real SFX with `dry_run=False`; **listen** and confirm quality. Run a small non-dry batch (2–3 events), review clips in the manifest, `promote`, and confirm `validate_audio` passes on the real files.
- [ ] **S4:** Only after S3 passes: run a full non-dry batch, human-review the manifest, promote approved clips. (Ongoing content op, not a plan task.)

## Wire-check (final plan step — BLOCKING)

- [ ] Grep the civkings repo for every new symbol and confirm it's imported/called/used, not orphaned:
  - `config.ensure_dirs`, `EngineConfig` — used by `batch.py`
  - `adapters.openmoss.generate`, `adapters.thinksound.generate` — called by `batch.py`
  - `write_silent_wav` — used by both adapters
  - `derive.derive_for_event` / `derive_all` — called by `batch.py`
  - `roster.VoiceProfile` — used by `batch.py` to pick a voice
  - `batch.run_batch`, `review.approved_clips`, `review.promote` — the runner + gate
  - `content_sets.ERA_BEDS`, `content_sets.SFX_SET` — consumed by `batch.py`
  - The A7 lookup function — called by the game's audio manager on event/sfx/era playback
- [ ] Confirm `assets/audio/` committed dirs contain ONLY reviewed, promoted clips (no `_staging/` content committed; add `_staging/` to civkings `.gitignore`).
- [ ] Confirm `validate_audio.py` passes on all committed clips.
