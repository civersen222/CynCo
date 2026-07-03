# Prefill Elimination: Checkpoint Caching + Append-Only Prompts — Design

**Date:** 2026-07-01
**Status:** Approved
**Sub-project:** A of 3 (B = token-waste cleanup, C = harness quality — separate specs later)

## Problem

Every agentic iteration re-prefills the entire prompt (25-30K tokens at steady
state) because llama.cpp cannot roll back Qwen3.6's recurrent state. This is
LocalCode's single largest wall-clock cost: TTFT grows linearly with context
length, costing tens of seconds per turn in long sessions.

Root cause (research, 2026-07-01): Qwen3.6-27B is a **hybrid Gated DeltaNet +
Gated Attention** model, not plain SWA. Our `--cache-ram 0` decision was correct
for the llama.cpp of the time, but llama.cpp has since added **context
checkpoints** (`--ctx-checkpoints` / `--checkpoint-min-step`) that snapshot
recurrent state during prefill and roll back to the nearest checkpoint instead
of reprocessing from token 0. Confirmed working on Qwen3.6-35B-A3B (same
family) in ggml-org/llama.cpp#21831. `--swa-full` does NOT work for hybrid
models (#19794) and must not be used.

Hard prerequisite (ggerganov, #20225): the client's prompt must be strictly
**append-only**. Our engine currently violates this in three places.

## Goal

Warm-turn TTFT stops growing with context length: benchAgentic TTFT slope
(ms per 1K prompt tokens) drops >80% vs baseline, with no streaming, tool-call,
or quality regression.

## Design

### 1. Serving layer

`engine/llama/processManager.ts` (`buildServerArgs`) + `engine/config.ts`.
New defaults, each following the existing env + profile `runtime:` override
pattern:

| Flag | New default | Env override | Profile `runtime:` key |
|---|---|---|---|
| `--ctx-checkpoints` | `64` | `LOCALCODE_CTX_CHECKPOINTS` | `ctx_checkpoints` |
| `--checkpoint-min-step` | `1024` | `LOCALCODE_CHECKPOINT_MIN_STEP` | `checkpoint_min_step` |
| `--ubatch-size` | `2048` | `LOCALCODE_UBATCH_SIZE` | `ubatch_size` |
| `--cache-ram` | llama.cpp default (drop the hardcoded `'0'` fallback) | `LOCALCODE_CACHE_RAM` (existing) | `cache_ram` (existing) |

Also:
- Rewrite the stale SWA comment in `buildServerArgs` — the accurate story is
  hybrid DeltaNet + context checkpoints, and `--cache-ram 0` is no longer the
  right default.
- Update `docs/serving/rtx-5090-qwen3.6-27b.md`: replace the "keep cache-ram 0"
  guidance with the checkpoint recipe, add the new flags to the mapping table,
  note the append-only client requirement, and warn against `--swa-full`.

VRAM budget: checkpoints observed ~75 MiB each on a comparable hybrid model;
64 checkpoints ≈ 2-2.5 GB. Must fit alongside ~22 GB weights + KV at 32K ctx
on the 32 GB RTX 5090 (verification gate 6). `--ubatch-size 2048` adds ~1-2 GB
compute buffer.

### 2. Engine append-only discipline

Three prefix mutators, all fixed:

1. **Tool prompt churn** — `engine/engine/callModel.ts:267` rebuilds the
   simulated tool prompt (`buildSimulatedToolPrompt(toolDefs)`) every call.
   Fix: build once per conversation, cached keyed on the tool set (e.g. sorted
   tool names + schema hash); rebuild only when the tool set actually changes.
   Result must be byte-identical across turns for an unchanged tool set.

2. **Governance/stuck rebuild** — `engine/bridge/conversationLoop.ts:1613-1627`
   injects governance signals by rewriting the system prompt when
   `currentStuck >= 3`, invalidating the whole cache during long stuck sessions
   (exactly when re-prefill hurts most). Fix: deliver governance signals as an
   **appended message** at the tail of the conversation instead of mutating the
   system prompt. VSM semantics preserved — the model still sees the signal,
   the prefix stays stable.

3. **Compressor append-alongside** — `engine/bridge/conversationLoop.ts:1522`:
   the compressed summary is injected as a new message while the original
   messages remain. Fix (minimal, scoped): compaction **replaces** the
   compressed messages in place. One full re-prefill immediately after a
   compaction event is accepted (industry norm — compaction is rare). The
   deeper compressor rework (dedup, microcompact eviction) belongs to
   sub-project B, not here.

### 3. Prefix-stability regression test

New test (vitest, alongside existing engine tests) that simulates a multi-turn
conversation loop — including a stuck-governance event (stuck >= 3) and a
repeated call with an unchanged tool set — and asserts that the serialized
request messages for turn N are a **byte-prefix** of turn N+1's serialized
messages (new content only ever appended). This is the durability guarantee:
any future feature that silently mutates the prefix fails CI.

Exception handling in the test: a compaction event legitimately breaks the
prefix once; the test asserts prefix stability resumes on the turns after
compaction.

### 4. Verification phase (gates, in order)

1. **Baseline first:** run `bun benchmark/true/benchAgentic.ts` on current
   flags; record TTFT slope and decode tok/s.
2. Apply all changes → rerun benchAgentic: warm-turn TTFT slope must drop
   **>80%** vs baseline.
3. `bun benchmark/true/streamToolcallProbe.ts`: all PASS, zero DROP.
4. Full vitest suite green (`npx vitest run`).
5. **Spec-draft A/B:** `--spec-draft-n-max 2` vs `3` via benchAgentic decode
   tok/s plus draft-acceptance counters from llama-server timings. Winner
   becomes the recommended profile value (documented in the serving doc).
   Context: external benchmark measured 1.73x at n=2 on this exact dense 27B.
6. **VRAM check:** `nvidia-smi` confirms checkpoint budget fits with headroom
   at 32K ctx.
7. **Live session:** one real CynCo session end-to-end to confirm normal
   behavior (verify-before-moving-on).

### Failure path

If the dense 27B does not reproduce the 35B-A3B checkpoint result (TTFT slope
does not collapse): keep sections 2-3 (append-only discipline and the test are
harmless and enable any future caching), revert the checkpoint/cache-ram flag
defaults, present the measurements to the user, and decide next steps together
(candidates: llama.cpp version bump, SGLang investigation).

## Out of scope

- Advisor gating, tool-routing call removal, file-read dedup, microcompact
  eviction, edit-error truncation, H1-H8 dead code (sub-project B).
- Edit-repair cascade, lint gate, repo map, lazy-grammar tool calling
  (sub-project C).
- KV cache quantization (`-ctk`/`-ctv`) — hybrid KV is already small; revisit
  only if the VRAM gate fails.
- RPC / second-GPU work.

## Decisions log

- Build-all (serving + engine in one plan), verify at the end — user chose over
  experiment-gated sequencing.
- New defaults in `buildServerArgs()` (not profile opt-in, not env gate).
- Fix all three prefix mutators; include prefix-stability regression test.
- Include the spec-draft-n-max 2v3 A/B in verification.
