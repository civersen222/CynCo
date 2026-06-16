# Unified Runtime Config via Profiles — Design

**Date:** 2026-06-13
**Status:** Approved (design review with user)
**Branch:** new branch off `liveness-layer` (or `main` after it merges)
**Sibling spec:** `2026-06-12-mode-aware-governance-design.md` (Spec B — implemented after this)

## Problem

There is no single source of truth for what model CynCo runs. "Which model +
quant + context window + MTP flags" is implied by scattered, disagreeing
defaults across the engine, the TUI launcher, and an ad-hoc daemon launch
command. The defaults silently diverge, and the divergence produced a
real incident.

Ground truth on disk (2026-06-13):

| Folder | File | Role |
|---|---|---|
| `~/.cynco/models/qwen3.6/` | `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` | **retired** Q4 35B-A3B |
| `~/.cynco/models/qwen3.6-mtp/` | `Qwen3.6-27B-Q6_K.gguf` | **desired** Q6_K 27B (MTP) |

Disagreeing defaults found:

| Place | Model default | Context default | MTP flags |
|---|---|---|---|
| TUI `project_picker.py:190-191` | `gemma4:31b` | `65536` | none |
| TUI `config.py:35` | — | `32768` | — |
| engine `main.ts:170,193` | resolver "pick largest gguf" | `32768` | only if `LOCALCODE_SPEC_*` env set |
| `engine/llama/processManager.ts:26` | — | `32768` | from `ServerConfig` |
| `engine/ollama/probe.ts:29` | — | `262144` (ignored on llama-cpp path) | — |
| daemon launch (the `2026-06-12-mfl-lineup-trade` plan's command) | `LOCALCODE_MODEL=qwen3.6` → Q4 35B | `32768` | none |

Consequence: the liveness daemon, launched with bare `LOCALCODE_MODEL=qwen3.6`
and no profile, ran **triply wrong** versus the user's interactive setup — the
retired Q4 35B model, a 32k window, and MTP disabled. The 2026-06-13
morning-brief produced a generic, data-poor result; the wrong-model + small
window were contributing factors (the compaction/governance causes are Spec B).

The root structural defects:

1. **`modelResolver` "picks the largest gguf"** in a model dir — actively
   dangerous; it is exactly why `qwen3.6` resolved to the retired Q4 35B.
2. **The daemon never loads a profile.** `taskRunner` spawns
   `bun engine/main.ts --run-task …` inheriting `process.env`; `main.ts` calls
   `loadConfig`, which *can* load a profile — but the daemon was given env-only
   with no `LOCALCODE_PROFILE`, so it fell through to built-in defaults.
3. **The profile schema cannot express a full launch config** — no explicit
   gguf file, no MTP/spec block, no gpu/batch/flash/threads/cache/reasoning.
   So even a profile could not have fully pinned the runtime.

## Goal

One profile file fully describes the runtime. The daemon, the TUI, and manual
launches all resolve the **same** model, quant, context window, and MTP config,
and cannot silently diverge.

## Non-Goals

- No changes to governance, the context compactor, tool budgeting, or the
  mission/notification path — those are Spec B.
- No new provider; llama-cpp only. The Ollama path is unaffected beyond shared
  config plumbing.
- No model downloads or quant conversion. Both ggufs already exist on disk.
- No retuning of `context_length` beyond setting the canonical 65536 (64k); the
  model supports more but 64k is the chosen VRAM-safe target for 27B-Q6_K on the
  32 GB RTX 5090.

## Precedence (unchanged, one new tier)

```
env (LOCALCODE_*)  >  LOCALCODE_PROFILE profile  >  default.yaml (if present)  >  built-in defaults
```

The only new behavior is the `default.yaml` fallback tier (Section 2).
`LOCALCODE_*` env vars still win for one-off overrides.

---

## Section 1 — Profile schema extension

Extend `Profile` (`engine/profiles/types.ts`) and `ResolvedProfile` with
optional launch-config fields so a profile fully describes a runnable model.

```yaml
model: qwen3.6-27b-q6k              # model dir under ~/.cynco/models/ (renamed — Section 3)
model_file: Qwen3.6-27B-Q6_K.gguf  # NEW — exact gguf filename; kills "pick largest"
context_length: 65536              # existing — drives BOTH --ctx-size and compaction threshold
temperature: 0.7                   # existing
runtime:                           # NEW — llama-cpp launch params (1:1 with ServerConfig)
  spec_type: mtp
  spec_draft_n: 3
  gpu_layers: 999
  batch_size: 2048
  flash_attn: true
  cache_ram: 0
  reasoning_budget: 256
```

- New TS types: a `RuntimeConfig` object on `Profile`/`ResolvedProfile` with all
  fields optional, plus a top-level optional `model_file?: string`.
- Every `runtime.*` key maps 1:1 onto `ServerConfig` in
  `engine/llama/processManager.ts`. Omitted keys keep today's built-in defaults
  (`buildServerArgs` already has `?? <default>` for each).
- `cache_ram` and `reasoning_budget` become `ServerConfig` fields so they are
  profile-driven; today they are read only from `process.env` inside
  `buildServerArgs` (`LOCALCODE_CACHE_RAM`, `LOCALCODE_REASONING_BUDGET`). Env
  still overrides via the config merge.

## Section 2 — Canonical default profile + auto-default loading

**Live file:** `~/.cynco/profiles/default.yaml` — the one true runtime
definition:

```yaml
name: default
model: qwen3.6-27b-q6k
model_file: Qwen3.6-27B-Q6_K.gguf
context_length: 65536
temperature: 0.7
runtime:
  spec_type: mtp
  spec_draft_n: 3
```

**Repo template:** `engine/profiles/templates/default.yaml` ships in git for
reproducibility. The live `~/.cynco/profiles/default.yaml` is created from it
during rollout (same pattern as `mission.json` living outside the repo). Rollout
copies the template only if the live file does not already exist (never clobber
a user-edited profile).

**Auto-default behavior:** when `LOCALCODE_PROFILE` is unset, `loadConfig` looks
for a profile named `default` (via the existing profile loader / search path)
and loads it if present. This is the single new fallback tier in the precedence
chain above. If `default.yaml` is absent, behavior is exactly as today
(built-in defaults).

**Both entry points inherit this automatically:**

- **TUI** (`tui/localcode_tui/screens/project_picker.py:190-191`): once
  auto-default exists, the hardcoded `gemma4:31b` and `65536` fallbacks are dead
  and are removed. The launcher stops injecting `LOCALCODE_MODEL` /
  `LOCALCODE_CONTEXT_LENGTH` unless the user has explicitly set them in their
  environment; the profile is the source of truth.
- **Daemon**: `taskRunner` spawns `main.ts` inheriting env; with no
  `LOCALCODE_PROFILE` and no `LOCALCODE_MODEL`, it picks up `default.yaml`. The
  ad-hoc `LOCALCODE_MODEL=qwen3.6` is dropped from the documented daemon launch
  command (in the liveness/MFL plan and any wrapper).

Net: deleting the model/ctx args from both launch paths makes daemon and TUI
provably run the same 27B-Q6_K / 64k / MTP configuration, because both read the
same file.

## Section 3 — Resolver hardening + directory cleanup

**`engine/llama/modelResolver.ts`** new logic (replaces "pick largest"):

1. `LOCALCODE_MODEL_PATH` (explicit full path) → wins outright (unchanged).
2. `model_file` provided (from profile/config) → use exactly
   `modelsDir/<model>/<model_file>`; throw `ModelNotFoundError` if it does not
   exist.
3. No `model_file`, folder has exactly **one** `.gguf` → use it.
4. No `model_file`, folder has **multiple** `.gguf` → **throw** an error listing
   the candidates and instructing the user to set `model_file`. Never silently
   pick.

`resolveModel`'s signature gains the optional `modelFile` argument; `main.ts`
passes `config.modelFile`.

**Directory cleanup** — standardize on `<family>-<params>-<quant>[-mtp]`:

| Now | Becomes |
|---|---|
| `qwen3.6-mtp/` (Q6_K 27B) | `qwen3.6-27b-q6k/` |
| `qwen3.6/` (Q4 35B, retired) | `qwen3.6-35b-a3b-q4km/` |

The retired Q4 35B is **kept** (rename only; it is 22 GB but harmless on disk).
After rename, no code names these folders directly — the profile's `model:` is
the only reference. The wire-check confirms no leftover `qwen3.6` (bare) or
`qwen3.6-mtp` literals remain.

## Section 4 — Wiring

Profile → running server data flow:

- `engine/config.ts`: map resolved-profile `model_file` and `runtime.*` into new
  `LocalCodeConfig` fields (`modelFile?: string`, `runtime?: RuntimeConfig`),
  preserving env-override precedence. Add the `default.yaml` auto-load when
  `LOCALCODE_PROFILE` is unset.
- `engine/main.ts`: pass `config.modelFile` into `resolveModel(...)`; build the
  `ProcessManager` config from `config.runtime` (replacing the direct
  `process.env.LOCALCODE_SPEC_*` reads at `main.ts:175-176`). Set both the
  server `--ctx-size` and the loop `contextLength` from the single
  `config.contextLength` (already the case at `main.ts:170,193` — just sourced
  from the profile now).
- `engine/llama/processManager.ts`: extend `ServerConfig` with `cacheRam` and
  `reasoningBudget`; `buildServerArgs` reads them from config first, env second,
  default third. The existing `specType`/`specDraftN`/`gpuLayers`/`batchSize`/
  `flashAttn`/`threads` are now fed from the profile.

## Verification

- **Unit tests:**
  - `modelResolver`: explicit `model_file` resolves; single-gguf folder
    resolves; multi-gguf folder with no `model_file` throws and lists
    candidates; missing `model_file` throws.
  - config merge precedence: env > `LOCALCODE_PROFILE` > `default.yaml` >
    built-in, for `model`, `model_file`, `context_length`, and each `runtime.*`
    key.
  - `buildServerArgs`: from the canonical profile, emits
    `--ctx-size 65536`, `--spec-type mtp`, `--spec-draft-n-max 3`,
    `--cache-ram 0`, `--reasoning-budget 256`.
  - auto-default: with no `LOCALCODE_PROFILE` and a present `default.yaml`,
    `loadConfig` returns the canonical values; with `default.yaml` absent,
    returns built-in defaults.
- **Live verification:** restart the daemon with **no** `LOCALCODE_MODEL` /
  `LOCALCODE_CONTEXT_LENGTH` / `LOCALCODE_SPEC_*` env; confirm `daemon.log`
  shows the spawned llama-server command contains
  `Qwen3.6-27B-Q6_K.gguf … --ctx-size 65536 … --spec-type mtp … --spec-draft-n-max 3`,
  and a real task completes with `ok: true`.
- **Blocking wire-check** (standing user rule — final implementation step):
  grep every new symbol (`model_file`/`modelFile`, `runtime` + each
  `runtime.*` key, `cacheRam`, `reasoningBudget`, the auto-default loader entry
  point) and confirm each is read on the live path, not only in tests. Grep that
  no bare `qwen3.6`, `qwen3.6-mtp`, `gemma4:31b`, or silent `32768` fallback
  literals remain in the daemon launch, `project_picker.py`, `main.ts`, or
  `config.ts`.
- **Full suite vs. baseline:** `npx vitest run` — must stay at 0 failures (the
  current green baseline after `cf75f8e`).

## Risks / trade-offs

- **Renaming model folders** breaks any current shell alias or env the user has
  that points at `qwen3.6` / `qwen3.6-mtp`. Mitigation: the canonical profile
  encodes the new names; the rollout updates the daemon launch command; the
  user's interactive launch should switch to the profile (or `default.yaml`
  auto-load) and drop the old `LOCALCODE_MODEL` export.
- **Auto-default magic** could surprise someone expecting built-in defaults.
  Mitigation: it only triggers when `LOCALCODE_PROFILE` is unset *and*
  `default.yaml` exists; it is logged at load (`[config] loaded profile
  'default'`); env still overrides.
- **Env-vs-profile precedence confusion**: a stale `LOCALCODE_MODEL` in the
  user's shell would still override the profile (by design). The wire-check and
  live verification explicitly assert the daemon runs with no such env so this
  is caught.
