# Serving recipe: RTX 5090 + Qwen3.6-27B Q6_K + MTP

This is the reference llama.cpp serving setup for LocalCode's primary backend on a
single **RTX 5090 (32 GB)**. It maps the recipe to the *actual* flags LocalCode
emits in `engine/llama/processManager.ts` (`buildServerArgs`), the `LOCALCODE_*`
env vars in `engine/config.ts`, and the profile `runtime:` block.

> Source of the tuning ideas: the `club-3090` repo (serving recipes for the same
> Qwen3.x / llama.cpp / consumer-NVIDIA stack). See the `reference_club3090`
> memory. This doc is **documentation only** — it does not change the defaults
> baked into `buildServerArgs`. Those defaults are already tuned for this machine;
> only override when you have a measured reason.

---

## TL;DR — what LocalCode already launches

When you run LocalCode with the llama-cpp provider, `startProcess()` spawns
`llama-server` with args built by `buildServerArgs()`. With the defaults that
means roughly:

```
llama-server \
  --model <modelPath> \
  --port 8081 \
  --host 127.0.0.1 \
  --ctx-size 32768 \
  --n-gpu-layers 999 \
  --batch-size 2048 \
  --flash-attn on \
  --parallel 1 \
  --cache-ram 0 \
  --reasoning-budget 256
```

Add `--spec-type draft-mtp --spec-draft-n-max 3` (via the profile `runtime:`
block) to turn on Qwen3.6's built-in MTP draft head. That is the single biggest
throughput win on this model — expect roughly ~100 tok/s decode.

---

## Flag-by-flag mapping

| llama-server flag | `buildServerArgs` default | Env override | Profile `runtime:` key | Notes for 5090 + Qwen3.6-27B Q6_K |
|---|---|---|---|---|
| `--model` | `config.modelPath` | `LOCALCODE_MODEL_PATH` | — | Point at the local Q6_K GGUF. HuggingFace GGUFs only. |
| `--port` | `8081` | `LOCALCODE_PORT` | — | LocalCode's provider + benches assume 8081. |
| `--host` | `127.0.0.1` | — | — | Loopback only; never bind publicly. |
| `--ctx-size` | `32768` | — | (via config `contextLength`) | 32K fits comfortably in 32 GB at Q6_K with FA on. 64K is possible but eats KV; verify VRAM headroom first. |
| `--n-gpu-layers` | `999` | `LOCALCODE_GPU_LAYERS` | `gpu_layers` | 999 = offload everything. A 27B Q6_K (~22 GB weights) fits fully on the 5090, so keep all layers on GPU. |
| `--batch-size` | `2048` | `LOCALCODE_BATCH_SIZE` | `batch_size` | Governs prefill chunk size → prompt-eval throughput. 2048 is a good prefill/VRAM balance; the agentic bench (`benchAgentic.ts`) measures TTFT slope if you tune this. |
| `--flash-attn` | `on` | `LOCALCODE_FLASH_ATTN` (`false` to disable) | `flash_attn` | Keep ON. FlashAttention cuts KV memory and speeds long-context prefill — essential for 32K on 32 GB. |
| `--threads` | (unset unless provided) | `LOCALCODE_THREADS` | `threads` | Only matters for CPU-side work; with full GPU offload leave unset. |
| `--spec-type` | (only if set) | — | `spec_type` | Set to `draft-mtp` to use Qwen3.6's native multi-token-prediction draft head. No separate draft model needed. |
| `--spec-draft-n-max` | `2` (when spec on) | — | `spec_draft_n` | `3` is the sweet spot for Qwen3.6 MTP per the live setup. Higher = more speculative tokens per step but more rejection cost. |
| `--parallel` | `1` | — | — | Single slot. LocalCode processes one request at a time; don't raise. |
| `--cache-ram` | `0` | `LOCALCODE_CACHE_RAM` | `cache_ram` | **Keep 0 for Qwen3.6.** It uses Sliding Window Attention, which invalidates the KV cache every call — prompt caching wastes 1–2 GB VRAM and ~700 ms/iter for zero benefit. Set `2048` ONLY for non-SWA models (Llama/Mistral/Phi). |
| `--reasoning-budget` | `256` | `LOCALCODE_REASONING_BUDGET` | `reasoning_budget` | Caps thinking tokens. >256 hurts tool-call accuracy and uncapped reasoning can burn 30K+ invisible tokens (5+ min/iter). Raise only if a task genuinely needs deeper deliberation. |
| `--lora` | (only if `loraPath`) | — | — | Set at runtime via the adapter swap path, not statically. |

---

## Profile `runtime:` block (recommended)

Put the speculative-decoding + tuning knobs in your YAML profile so they survive
restarts. Keys are snake_case and map to `RuntimeConfig` in `engine/config.ts`:

```yaml
# profiles/<name>.yaml
model: qwen3.6-27b
model_path: /path/to/Qwen3.6-27B-Q6_K.gguf   # or set LOCALCODE_MODEL_PATH
runtime:
  spec_type: draft-mtp     # → --spec-type draft-mtp  (Qwen3.6 native MTP head)
  spec_draft_n: 3          # → --spec-draft-n-max 3
  gpu_layers: 999          # → --n-gpu-layers 999      (full offload)
  batch_size: 2048         # → --batch-size 2048
  flash_attn: true         # → --flash-attn on
  cache_ram: 0             # → --cache-ram 0           (SWA: keep 0)
  reasoning_budget: 256    # → --reasoning-budget 256
```

Equivalent env-var form (for one-off runs):

```bash
LOCALCODE_MODEL=qwen3.6-27b \
LOCALCODE_MODEL_PATH=/path/to/Qwen3.6-27B-Q6_K.gguf \
LOCALCODE_GPU_LAYERS=999 \
LOCALCODE_BATCH_SIZE=2048 \
LOCALCODE_FLASH_ATTN=true \
LOCALCODE_CACHE_RAM=0 \
LOCALCODE_REASONING_BUDGET=256 \
bun engine/main.ts
```

(`spec_type` / `spec_draft_n` have no env override — they come from the profile
`runtime:` block only.)

---

## VRAM budget (32 GB, Q6_K, FA on)

Rough back-of-envelope so you know how much context you can afford:

- **Weights (Q6_K, 27B):** ~22 GB resident on the GPU at `--n-gpu-layers 999`.
- **KV cache:** with FlashAttention on, scales ~linearly with `--ctx-size`.
  At 32K it leaves comfortable headroom inside 32 GB. Pushing to 64K starts to
  compete with weights — check `nvidia-smi` before committing.
- **MTP draft head:** small, included in the model; negligible extra VRAM but
  buys most of the decode speedup.
- **Prompt cache:** 0 by design (SWA). Don't re-introduce it for Qwen3.6.

If you OOM at startup: lower `--ctx-size` first (it's the elastic term), not
`--n-gpu-layers` — partial offload tanks throughput far more than a shorter
context costs you.

---

## Power / thermal

A single 5090 at full decode draws a lot of sustained power. If you see clock
throttling or want a quieter box, apply a power cap at the driver level (this is
outside llama.cpp — LocalCode does not manage it):

```bash
# Linux example — cap board power (watts). Tune to your PSU/cooling.
nvidia-smi -pl 450
```

A modest power cap usually costs only a few percent of tok/s while dropping temps
and noise substantially, because the last few hundred MHz are the least
efficient. Measure before/after with the agentic bench.

---

## Verifying the recipe

1. **Streaming tool-call health** — `bun benchmark/true/streamToolcallProbe.ts`
   drives tool-requiring prompts through `provider.stream()` and flags any DROP
   (markup leaked into content, or a silent empty turn — the 0-token-EOS failure
   class). Run after any change to `--reasoning-budget`, grammar, or the spec
   flags, since those are what historically broke tool-call streaming.

2. **Prefill / decode throughput** — `bun benchmark/true/benchAgentic.ts`
   replays a 12-turn agentic conversation with a growing context and reports
   TTFT, the TTFT-vs-prompt-size slope, and decode tok/s. Use it to confirm MTP
   is actually engaged (decode should jump toward ~100 tok/s) and to compare
   `--batch-size` values.

Both benches assume llama-server on port 8081 and read the live model from
`/v1/models`.
