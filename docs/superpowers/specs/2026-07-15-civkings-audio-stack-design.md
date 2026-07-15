# CivKings Audio Stack (X.9) — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design), pending user review of this document
**Source:** `docs/civkings-master-plan.md` §X.9 (in-flight edit). This spec turns X.9 into an implementable design.

---

## Purpose

Give CivKings a full generative audio library — voiced event narration, per-dynasty cloned voices, era ambience beds, and a large bespoke SFX set — produced by a local, offline generative stack instead of licensed packs. Two modes:

- **Mode A — build-time foundry:** run the engines on the dev box to mass-produce ordinary WAV/OGG assets that ship as plain files (no weights, no runtime GPU dependency).
- **Mode B — runtime generation:** an embeddable local host (Lemonade) that generates per-run content live (chronicle read aloud in a dynasty's cloned voice, live event lines/SFX), with graceful fallback to Mode-A assets when unavailable.

Both modes read content the game already has (event `title`/`desc`, the 8 leader dynasties, the dynasty chronicle), so voiced-and-scored output is a *derivation* of existing content, not new authoring.

## Framing note (non-commercial)

CivKings is not being sold; the "commercial Steam game" language in the master plan is a prompt-framing device, not a literal goal. Consequences for this spec, deliberately diverging from the master-plan text:

- **Licensing is recorded, not gating.** The master plan calls license verification a "hard shipping gate / blocking first mission." For a personal/research project on the developer's own hardware, that is over-weighted. We record each engine's and model's license in a `LICENSES.md` as a checklist item inside the scaffold mission — informational, not a merge-blocker.
- **Mode B is in scope now, not revenue-gated.** The master plan stages Mode B as an "S4-gated experimental track post the S3 revenue signal." With no sales gate and the play box == the dev box (RTX 5090), that staging rationale evaporates. Mode B is a real feature we build, sequenced after the shared foundry core.

The *quality bar* the commercial framing implies (polish, editorial review, "would a real player accept this") is retained.

## Engines (external, offline, pure C++/GGML)

| Engine | Role | Interface |
|--------|------|-----------|
| `pwilkin/openmoss` | Text→speech, voice cloning (MOSS-TTS port) | `moss-tts-cli` (one-shot), `moss-tts-server` (HTTP) |
| `pwilkin/thinksound.cpp` | Text→SFX / ambience (ThinkSound) | `ts-generate`, `ts-server` |
| `lemonade-sdk/lemonade` | Runtime host (embeddable portable binary), auto-detects NPU/GPU/CPU, lists openmoss as a backend | OpenAI/Anthropic/Ollama-compatible HTTP |

## Ownership & execution model

- **All tooling authored by CynCo missions**, in the **civkings repo**, alongside `tools/validate_events.py` (VII.3 content-pipeline template). I never hand-edit civkings code; I dispatch/verify/label per the CynCo mission discipline.
- **Adapters are real engine wrappers, not stubs.** They call the actual `moss-tts-cli` / `ts-generate` / Lemonade HTTP endpoints.
- **One supervised real-generation checkpoint.** Building the C++/GGML repos and fetching model weights is a human-supervised step (not a headless CynCo mission). After the adapters and derivation logic exist, the user + I build/install the engines, fetch weights, and run one real TTS line + one real SFX, listen, and verify quality before any mass batch. Missions before that checkpoint verify via a `--dry-run` code path (deterministic silent/placeholder audio) so CynCo can prove wiring headlessly without weights present.

## Directory layout (in civkings repo)

```
tools/audio_foundry/
  __init__.py
  config.py            # engine paths, output dirs, voice roster, sample rates
  LICENSES.md          # recorded licenses for openmoss / thinksound / lemonade + weights
  adapters/
    openmoss.py        # TTS wrapper (real CLI/HTTP + --dry-run path)
    thinksound.py      # SFX wrapper (real CLI + --dry-run path)
    lemonade.py        # runtime host launcher + client (Mode B)
  derive.py            # event title/desc -> (tts_line, sfx_caption); pure, testable
  roster.py            # 8 leader dynasties -> cloned-voice profiles
  batch.py             # Mode-A batch runner: derive -> generate -> manifest
  review.py            # editorial review manifest gate (VII.4 bar)
  validate_audio.py    # smoke gate: files exist, non-empty, correct format/sample rate
assets/audio/
  voice/               # per-event + per-dynasty voiced lines (Mode A output)
  sfx/                 # event stings + bespoke effects
  ambience/            # 5 era beds
```

## Component boundaries

- **`derive.py`** is pure (event dict → prompts). No I/O. Fully unit-testable. This is the shared heart both modes use.
- **`adapters/*`** are the only modules that touch external processes. Each exposes a real generate call plus a `dry_run` flag returning a valid-but-placeholder audio file, so higher layers are testable without weights.
- **`batch.py` (Mode A)** orchestrates derive→adapter→manifest; never ships raw — writes a review manifest.
- **`review.py`** enforces the VII.4 human editorial gate: nothing enters `assets/audio/` (committed) until reviewed.
- **`adapters/lemonade.py` + runtime path (Mode B)** host the engines live and MUST fall back to Mode-A assets when the host is unavailable — the core game never hard-depends on Mode B.
- **Game wiring (A7)** extends existing `music_manager`/`sound_manager` (master plan X.5) to play pre-baked assets, detect-and-degrade on a missing clip.

## Two plans (per user decision)

The shared core (A1–A4) plus build-time tail (A5–A7) form one independently-shippable subsystem; the runtime tail (B1–B3) is a second independent subsystem built on top. **One spec (this doc), two plan files:**

1. `docs/superpowers/plans/2026-07-15-audio-foundry.md` — Mode A (A1–A7), includes the shared core.
2. `docs/superpowers/plans/2026-07-15-audio-runtime.md` — Mode B (B1–B3), depends on the shared core landing first.

### Mode A missions (plan 1)

| # | Mission | Verifies (CynCo smoke) |
|---|---------|------------------------|
| A1 | Scaffold `tools/audio_foundry/` package, `config.py`, `LICENSES.md`, empty `validate_audio.py` | import package, `validate_audio.py --help` |
| A2 | Real adapters `openmoss.py` + `thinksound.py` with `--dry-run` placeholder path | dry-run generates a valid WAV; unit tests pass |
| A3 | `derive.py`: event `title`/`desc` → `(tts_line, sfx_caption)` | pure-function unit tests over sample events |
| A4 | `roster.py`: 8 dynasties → voice profiles | roster loads, covers all 8 leaders (VIII/III.2) |
| A5 | `batch.py` + `review.py` editorial gate | dry-run batch produces manifest; review blocks unreviewed |
| A6 | Era ambience beds (×5) + expanded SFX definitions | derive+dry-run coverage for beds/SFX set |
| A7 | Wire pre-baked assets into `music_manager`/`sound_manager`, detect-and-degrade | game imports; missing-clip fallback test |
| **SUPERVISED** | Build engines + fetch weights + run one real TTS line & one real SFX; verify quality | human review of real audio |

### Mode B missions (plan 2)

| # | Mission | Verifies |
|---|---------|----------|
| B1 | `adapters/lemonade.py`: embeddable host launcher, hardware auto-detect, health probe | probe returns capability; dry-run when absent |
| B2 | Runtime path: chronicle (X.4) + event lines voiced live in dynasty voice, **fallback to A-assets** | fallback test when Lemonade down |
| B3 | Optional local flavor-text LLM → voiced ("narrates its own saga") | end-to-end dry-run path |

## Testing strategy

- **Unit:** `derive.py`, `roster.py` are pure and fully unit-tested.
- **Dry-run integration:** every adapter has a `--dry-run` path producing a valid placeholder file, so batch/review/wiring are testable headlessly with no weights.
- **Smoke gate:** `validate_audio.py` checks each produced file exists, is non-empty, and matches expected format/sample rate — the CynCo per-mission smoke check.
- **No-regression:** existing civkings pytest suite (baseline 25) must stay green each mission.
- **Supervised acceptance:** the one real-generation checkpoint is human-verified by listening, not automated.

## Non-goals

- No composing/authoring of music by hand (engines derive from existing text).
- No shipping model weights inside the base game for Mode A (plain files only).
- No hard game dependency on Mode B (always falls back to Mode A).
- Licensing is recorded, not a gate (see framing note).

## Open risks

- External C++/GGML repos may not build cleanly on the target machine — surfaced at the supervised checkpoint, not during CynCo missions (which use dry-run).
- Voice-clone quality per dynasty is a human-judgment call (A4 + supervised checkpoint).
