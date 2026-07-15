# CivKings Audio Runtime (Mode B) Implementation Plan

> **For agentic workers:** Executed by **CynCo missions** (dispatched via `scripts/cynco-mission-driver.mjs`), verified and ledger-labeled by the operator (Claude). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an optional runtime local-generation path so CivKings can voice per-run content live (the dynasty chronicle and event lines in a dynasty's cloned voice, optional locally-authored flavor text), hosted by Embeddable Lemonade, with graceful fallback to the Mode-A pre-baked assets whenever the runtime host is unavailable.

**Architecture:** A Lemonade host adapter + a runtime path that, at play time, tries live generation and falls back to the Mode-A asset lookup. Builds directly on the shared foundry core (`derive.py`, `roster.py`, `adapters/`) from the Mode-A plan. The core game NEVER hard-depends on Mode B.

**Tech Stack:** Python 3, `lemonade-sdk/lemonade` (embeddable portable binary, OpenAI/Anthropic/Ollama-compatible HTTP), the Mode-A `audio_foundry` package.

**Spec:** `docs/superpowers/specs/2026-07-15-civkings-audio-stack-design.md`

**Depends on:** `2026-07-15-audio-foundry.md` must land first (A1–A7 + the shared core). Mode B reuses `derive.py`, `roster.py`, and the A7 asset lookup for fallback.

**Execution ground rules:** identical to the Mode-A plan (fresh engine per mission, S5 enforce off, approve-all, one in flight, cwd `C:\Users\civer\civkings`, forward-slash briefs, final-marker-check on timeout, per-mission AST + pytest-25 + smoke + diff verify, ledger `verified:true` only on landed + all-pass).

---

## Task B1: Embeddable Lemonade host adapter

**Files (CynCo creates in civkings repo):**
- Create: `tools/audio_foundry/adapters/lemonade.py`
- Create: `tools/audio_foundry/tests/test_lemonade.py`

**Interface contract:**
- `class LemonadeHost` with:
  - `probe() -> HostCapability` — returns `HostCapability(available: bool, backend: str, detail: str)` by attempting a health request to the configured base URL; on connection failure returns `HostCapability(available=False, backend="none", detail=...)` (never raises).
  - `speak(text: str, out_path: Path, *, voice: str | None = None) -> Path` — request TTS from the host, write audio to `out_path`. Raises `HostUnavailable` if `probe()` is not available (caller handles fallback).
- Base URL from `LEMONADE_BASE_URL` env (default `http://localhost:8000`). **Exact endpoint paths/payload filled at supervised checkpoint** (mark real HTTP call lines `# VERIFY-AT-BUILD:`).

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-b1-brief.txt`. Provide verbatim:

```python
"""Embeddable Lemonade runtime host adapter."""
from __future__ import annotations
import os, urllib.request, urllib.error
from dataclasses import dataclass
from pathlib import Path

class HostUnavailable(RuntimeError):
    pass

@dataclass(frozen=True)
class HostCapability:
    available: bool
    backend: str
    detail: str

class LemonadeHost:
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.environ.get("LEMONADE_BASE_URL", "http://localhost:8000")).rstrip("/")

    def probe(self) -> HostCapability:
        url = f"{self.base_url}/api/v1/health"  # VERIFY-AT-BUILD: confirm health path
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                ok = r.status == 200
            return HostCapability(available=ok, backend="lemonade", detail=url)
        except (urllib.error.URLError, OSError) as e:
            return HostCapability(available=False, backend="none", detail=str(e))

    def speak(self, text: str, out_path: Path, *, voice: str | None = None) -> Path:
        cap = self.probe()
        if not cap.available:
            raise HostUnavailable(cap.detail)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # VERIFY-AT-BUILD: real TTS request to Lemonade, write bytes to out_path
        raise HostUnavailable("real speak() wired at supervised checkpoint")
```

`tests/test_lemonade.py`:
```python
from tools.audio_foundry.adapters.lemonade import LemonadeHost, HostUnavailable
import pytest

def test_probe_unavailable_when_no_server():
    cap = LemonadeHost("http://127.0.0.1:9").probe()  # unroutable port
    assert cap.available is False
    assert cap.backend == "none"

def test_speak_raises_when_unavailable(tmp_path):
    with pytest.raises(HostUnavailable):
        LemonadeHost("http://127.0.0.1:9").speak("hail", tmp_path / "x.wav")
```

Smoke: `pytest tools/audio_foundry/tests/test_lemonade.py -q`. Marker: `feat: audio_foundry lemonade runtime host adapter`

- [ ] **Step 2: Dispatch. Step 3: Verify** (pytest, probe-never-raises, VERIFY-AT-BUILD comments present). **Step 4: Label.**

## Task B2: Runtime voiced path with fallback to Mode-A assets

**Files:**
- Create: `tools/audio_foundry/runtime.py`
- Create: `tools/audio_foundry/tests/test_runtime.py`

**Contract:** `runtime.py` provides the play-time entry the game calls:
- `voice_event(event: dict, *, host: LemonadeHost, dynasty_id: str, out_path: Path, asset_lookup) -> tuple[Path, str]` — derive the line (`derive_for_event`), pick the voice (`roster` by `dynasty_id`), try `host.speak(...)`; on `HostUnavailable`, fall back to `asset_lookup(event_id)` (the A7 pre-baked clip) and return `(path, "live"|"prebaked"|"silent")`. If both fail, return the silent fallback and `"silent"` — NEVER raise into the game loop.
- `voice_chronicle(chronicle_text: str, *, host, dynasty_id, out_path, fallback_path) -> tuple[Path, str]` — same try-live-then-fallback shape for the X.4 dynasty chronicle.

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-b2-brief.txt`. Provide the full `runtime.py` implementing the above using `derive.derive_for_event`, `roster` voice lookup, `LemonadeHost.speak`, and an injected `asset_lookup` callable (so it's testable without the game). Provide `tests/test_runtime.py`:
```python
from pathlib import Path
from tools.audio_foundry import runtime
from tools.audio_foundry.adapters.lemonade import LemonadeHost

def test_falls_back_to_prebaked_when_host_down(tmp_path):
    prebaked = tmp_path / "pre.wav"
    from tools.audio_foundry.adapters import write_silent_wav
    write_silent_wav(prebaked, 24000)
    def lookup(_eid): return prebaked
    host = LemonadeHost("http://127.0.0.1:9")  # down
    path, mode = runtime.voice_event(
        {"id": "e1", "title": "War", "desc": "Border clash."},
        host=host, dynasty_id="d1", out_path=tmp_path / "o.wav", asset_lookup=lookup)
    assert mode == "prebaked" and path == prebaked

def test_silent_when_no_prebaked(tmp_path):
    def lookup(_eid): return None
    host = LemonadeHost("http://127.0.0.1:9")
    path, mode = runtime.voice_event(
        {"id": "e2"}, host=host, dynasty_id="d1",
        out_path=tmp_path / "o.wav", asset_lookup=lookup)
    assert mode == "silent"
    assert path.exists()  # a silent wav was written, game never starved
```
Emphasize: **the game loop must never see an exception from this path.** Smoke: `pytest test_runtime.py -q`. Marker: `feat: audio_foundry runtime voiced path with prebaked fallback`

- [ ] **Step 2: Dispatch. Step 3: Verify** (pytest, both fallback branches, no-raise guarantee via diff). **Step 4: Label.**

## Task B3: Optional local flavor-text LLM → voiced

**Files:**
- Create: `tools/audio_foundry/flavor.py`
- Create: `tools/audio_foundry/tests/test_flavor.py`

**Contract:** `flavor.py` provides `author_line(event: dict, *, host: LemonadeHost) -> str | None` — ask the Lemonade-hosted LLM (chat endpoint) to write one short in-world flavor sentence for the event; return `None` (never raise) if host unavailable, so `runtime.voice_event` can fall back to `derive_for_event`'s plain line. This is the "narrates its own saga" hook, strictly additive.

- [ ] **Step 1: Author brief** at `C:/tmp/cynco-audio-b3-brief.txt`. Provide `flavor.py` with a chat request to `LemonadeHost` (mark the real HTTP call `# VERIFY-AT-BUILD:`), returning `None` on `HostUnavailable`/any host error. Wire it optionally into `runtime.voice_event` (if a `flavor_host` is passed and returns a line, voice that; else voice the derived line). Test asserts `author_line` returns `None` when host is down (no raise). Smoke: `pytest test_flavor.py -q`. Marker: `feat: audio_foundry optional local flavor-text authoring`
- [ ] **Step 2: Dispatch. Step 3: Verify** (pytest, None-on-unavailable, optional wiring doesn't break B2 tests). **Step 4: Label.**

## SUPERVISED CHECKPOINT (human, not a CynCo mission)

- [ ] **S1:** Install/launch Embeddable Lemonade on the RTX 5090 box; confirm it hosts openmoss TTS. Record its license in `LICENSES.md`.
- [ ] **S2:** Read Lemonade's real API (health, TTS, chat endpoints); fill the `# VERIFY-AT-BUILD:` lines in `lemonade.py` and `flavor.py` (small brief authored from observed API, or supervised edit).
- [ ] **S3:** With Lemonade up, run `runtime.voice_event` and `voice_chronicle` live; **listen** and confirm the chronicle reads aloud in the dynasty voice. Kill Lemonade and confirm the game falls back to pre-baked assets with no error.

## Game integration (final wiring mission)

- [ ] **Author brief** at `C:/tmp/cynco-audio-b-integrate-brief.txt`: wire `runtime.voice_event` / `voice_chronicle` into the actual game event-resolution and chronicle-view code paths, passing a shared `LemonadeHost` and the A7 `asset_lookup`. Guard behind a settings flag `audio_runtime_enabled` (default off) so Mode B is opt-in; when off, the game uses only Mode-A pre-baked assets. game.py-adjacent → 1200s timeout. Marker: `feat: wire runtime audio into game events + chronicle (opt-in)`
- [ ] **Verify:** AST-parse touched game files, full civkings pytest green, confirm the settings flag gates the runtime path and that flag-off uses pure Mode-A. **Label.**

## Wire-check (final plan step — BLOCKING)

- [ ] Grep the civkings repo for every new symbol and confirm it's imported/called/used:
  - `LemonadeHost.probe` / `.speak` — used by `runtime.py` (and `flavor.py`)
  - `runtime.voice_event` / `runtime.voice_chronicle` — called by the game event/chronicle code (integration mission)
  - `flavor.author_line` — optionally called by `runtime.voice_event`
  - `asset_lookup` — the A7 pre-baked lookup, passed into `runtime.*` for fallback
- [ ] Confirm the `audio_runtime_enabled` settings flag exists, defaults off, and gates the runtime path.
- [ ] Confirm with flag OFF the game path uses only Mode-A assets and passes all tests (Mode B never on the critical path).
