# J-Lens for Qwen3.6-27B — Artifact & Feasibility Research (2026-07-16)

Research agent report, verbatim. Feeds sub-project 5 (J-space Workspace) of the
"Expanding the Brain" program. Companion report: `2026-07-16-llamacpp-activation-tap.md`.

## 1. Method (paper + official repo)

The paper ([Verbalizable Representations Form a Global Workspace](https://transformer-circuits.pub/2026/workspace/index.html))
defines J_l = E[dh_final,t'/dh_l,t] averaged over source positions, all current-and-future
target positions, and ~1000 pretraining-like prompts (128 tokens each). The exact estimator
is in the official companion repo [anthropics/jacobian-lens](https://github.com/anthropics/jacobian-lens)
(`jlens/fitting.py`): **reverse-mode with batched cotangents** — one forward pass with the
prompt replicated `dim_batch` times, then `ceil(d_model/dim_batch)` backward passes per
prompt; each backward injects a one-hot cotangent at one output dimension at *every valid
target position simultaneously*, giving one row of J_l per batch element. First 16 positions
are skipped (attention sinks). Appendix variants: frozen attention patterns, present-only
targets, varying context counts; **quality saturates fast (§9.3) — ~100 prompts is usable**.
Readout: `softmax(W_U norm(J_l h_l))`. Applied to Claude Sonnet/Haiku/Opus 4.5; open-model
readouts released via Neuronpedia.

## 2. Precomputed artifacts — YES, for exactly our model

HF repo **[neuronpedia/jacobian-lens](https://huggingface.co/neuronpedia/jacobian-lens)**
contains pre-fitted lenses for ~30 open models (Gemma 2/3/4 incl. gemma-4-31b,
Llama 3.1-8B/3.3-70B, Qwen 2.5/3/3.5/3.6, OLMo-3, gpt-oss-20b, GPT-2, Pythia). Critically:

- **`qwen3.6-27b/jlens/Salesforce-wikitext/Qwen3.6-27B_jacobian_lens_n1000.pt` — 3.30 GB**,
  fit on 1000 wikitext-103 prompts by Anthropic's Mateusz Piotrowski (per CREDIT.md).
  Apache-2.0.
- Format (from `jlens/lens.py`): torch save of
  `{"J": {layer: fp16 [d_model, d_model]}, n_prompts, source_layers, d_model}`.
  3.30 GB / (5120^2 x 2B) ~= **all ~63 source layers included**. Loadable via
  `JacobianLens.load()` / `from_pretrained()`; `lens.transport(h)` gives bare J_l*h.
- Sibling config (qwen3.5-27b) documents the exact fit command: `dim_batch 64,
  max_seq_len 128, bf16`, on one B200 (180GB); convergence-stopped at 672 prompts with
  mean-rel-change 0.0016. Community lenses also exist
  ([gghfez/jacobian-lens-GGUF](https://huggingface.co/gghfez/jacobian-lens-GGUF),
  qwen3.5-27b variants).

## 3. Cost if we computed it ourselves (moot, but assessed)

Per prompt at dim_batch=8 (32GB budget): ~640 backwards through a 27B. In bf16 the model
doesn't fit; QLoRA-style 4-bit backprop **is valid for activation gradients** (gradients
w.r.t. h flow through dequantized weights; arguably *more* faithful to your quantized
serving copy, though it estimates J of the quantized model, not the bf16 one). With gradient
checkpointing + NF4, expect ~0.5-1.5 s/backward at 128 tokens on a 5090 → ~5-15 min/prompt
→ **~1-2 days for 100 prompts, ~1-2 weeks for full 1000** (parallelizable via `fit()` on
slices + `merge()`; J accumulators, 63 x 5120^2 fp32 ~= 6.6GB, can live in system RAM).
Alternatives: random-probe VJP + low-rank reconstruction would need ~2-4x rank probes
(Fig. 28 shows nontrivial effective dimensionality — risky); forward-mode JVPs give columns
not rows, same count; regression between (h_l, h_final) is **not sanctioned** — the paper
explicitly contrasts with the tuned lens' trained linear maps and does not adopt fitting.
Computing only ~5 layers cuts nothing (backward cost is dominated by the full pass; you get
all layers' rows free per cotangent).

## 4. Storage/runtime

Confirmed: 52.4 MB/layer fp16; 5 layers ~= 262 MB, all 63 ~= 3.3 GB. Online cost per
readout: J_l*h ~= 52 MFLOP + norm + W_U matvec (151k x 5120 ~= 1.5 GFLOP) — sub-millisecond
on GPU, a few ms on CPU. **Pre-folding W_U*J_l (1.5 GB/layer) is not just wasteful — it's
mathematically wrong**: the RMSNorm sits between J_l and W_U (`W_U norm(J_l h)`), so they
can't be legally folded. Keep one shared W_U, do the two-step matvec, `topk` on logits.
No fancy MIPS needed.

## 5. Replications/critiques

- [tao-hpu/jspace-replication](https://github.com/tao-hpu/jspace-replication) — independent
  replication on small open models.
- [LessWrong review](https://www.lesswrong.com/posts/zFJ3ZdQwrTWE9jT5S/a-review-of-anthropic-s-global-workspace-paper)
  — mixed: multi-fact editing replicated cleanly; rhyme-planning and mental-arithmetic
  **failed to replicate**; J-lens produces false positives. Collaborators reproduced core
  phenomena **on Qwen 3.6-27B specifically**.
- [HF blog: J-Space, yet another mind reader?](https://huggingface.co/blog/dlouapre/j-space)
  — cautions J-lens gives noisy directions; easy to over-read.

## Recommendation

**Reuse the artifact.** Download `Qwen3.6-27B_jacobian_lens_n1000.pt` (3.3 GB), slice the
~5 layers you want (~260 MB), and `pip install` the Apache-2.0 `jlens` package for the
readout. **Effort: ~1-2 days** — the real work is capturing h_l from your llama.cpp-served
copy, not the lens. **Biggest risk:** the lens was fit on bf16 residuals; your NVFP4+MTP
llama.cpp stack (a) doesn't natively expose per-layer residual streams and (b) has
quantization-shifted activation statistics — validate readout quality on known examples
(the ASCII-face demo) before trusting the live visualization; fall back to a HF-side shadow
pass if llama.cpp extraction stalls.

## Sources

- [Workspace paper](https://transformer-circuits.pub/2026/workspace/index.html)
- [anthropics/jacobian-lens](https://github.com/anthropics/jacobian-lens)
- [neuronpedia/jacobian-lens (HF)](https://huggingface.co/neuronpedia/jacobian-lens)
- [neuronpedia.org/jlens](https://www.neuronpedia.org/jlens)
- [LessWrong review](https://www.lesswrong.com/posts/zFJ3ZdQwrTWE9jT5S/a-review-of-anthropic-s-global-workspace-paper)
- [jspace-replication](https://github.com/tao-hpu/jspace-replication)
- [dlouapre J-Space blog](https://huggingface.co/blog/dlouapre/j-space)
- [Forbes coverage](https://www.forbes.com/sites/johnwerner/2026/07/12/anthropic-illuminates-llm-j-space-with-j-lens/)
