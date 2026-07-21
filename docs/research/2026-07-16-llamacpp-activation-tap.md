# llama.cpp Residual-Stream Extraction — Feasibility Research (2026-07-16)

Research agent report, verbatim. Feeds sub-project 5 (J-space Workspace, Tier 3) of the
"Expanding the Brain" program. Companion report: `2026-07-16-jlens-artifacts-feasibility.md`.

Goal researched: patch llama.cpp so that during generation the residual stream vector h_l
(per-layer output, last token position) at a handful of chosen intermediate layers is copied
out and exposed live (ring buffer + HTTP/SSE endpoint on llama-server), to power a real-time
J-lens workspace readout.

## 1. Observation mechanism

llama.cpp has a first-class hook for this: `ggml_backend_sched_eval_callback` (declared in
`ggml/include/ggml-backend.h`), plumbed through as `llama_context_params.cb_eval` /
`cb_eval_user_data` (`include/llama.h`). It is installed per-context in
`llama_context::process_ubatch()` (`src/llama-context.cpp`) via
`ggml_backend_sched_set_eval_callback()` — so it fires on **every decode, including normal
server decode**; no special mode needed. Two in-tree consumers prove it:
`examples/eval-callback` (debug dump) and, most relevantly,
`tools/cvector-generator/cvector-generator.cpp`, which captures exactly the tensor we want:
it string-matches `t->name` against the prefix `"l_out"` in the ask-phase and copies with
`ggml_backend_tensor_get()` in the data-phase.

Tensor naming (verified in current master): the graph-build callback in
`llama_context::graph_get_cb()` does `ggml_format_name(cur, "%s-%d", name, il)`, and every
arch builder (e.g. `src/models/qwen3.cpp`) ends its layer loop with
`cur = ggml_add(ctx0, cur, ffn_inp); cur = build_cvec(cur, il); cb(cur, "l_out", il);`.
So the per-layer residual stream is literally named `l_out-0 ... l_out-N`, plus `ffn_out-i`,
`attn_out`/`kqv_out`, `result_norm`, `result_output`. This is exactly what the J-lens needs:
`l_out-l` **after** the residual add.

## 2. Performance

The callback path in `ggml_backend_sched_compute_splits()` (`ggml/src/ggml-backend.cpp`)
does not go fully node-by-node: it batches all consecutive "not needed" nodes into one
`ggml_graph_view` and computes them async, then calls `ggml_backend_synchronize()` at each
needed tensor. With 3-5 watched layers you get ~4-6 sync points + graph fragments per token
instead of one. The real cost: fragmented sub-graphs defeat **CUDA graph capture/replay**,
which NVIDIA measured as a substantial bs=1 win — expect roughly 15-40% throughput loss on
the 115 tok/s MTP setup. Also the callback fires for the draft/MTP graphs too.

**Cheaper approach (recommended):** `ggml_set_output()` / `GGML_TENSOR_FLAG_OUTPUT`.
Precedent already in-tree: `llm_graph_result::set_outputs()` (`src/llama-graph.cpp`) marks
`t_logits`, `t_embd`, and notably `t_h_nextn` — the MTP hidden state, i.e. llama.cpp already
exports a residual-stream tensor for our exact model path. Marking `l_out-{k}` as outputs
(a ~10-line patch in `graph_get_cb()` matching a configurable layer list) only prevents
allocator reuse of those buffers; the graph still executes as one monolithic async compute,
CUDA graphs intact. After decode read them with `ggml_backend_tensor_get_async()` alongside
the logits readback (same sync point, already paid). Copy cost is trivial:
d_model x 4B ~= 20 KB x 5 layers per token over PCIe ~= microseconds — well under 1% at
115 tok/s. Cost: slightly larger compute buffer (those tensors can't be recycled).

## 3. Prior art

- `tools/cvector-generator` — reads `l_out-*` via `cb_eval` (the read-mirror of control
  vectors). Control-vector **writes** happen in `llama_adapter_cvec`
  (`src/llama-adapter.cpp`): `cur = ggml_add(ctx, cur, layer_dir)` inserted via
  `build_cvec()` right before `l_out` naming — confirming that layer point is the canonical
  residual-stream location.
- `tools/imatrix` — production-grade cb_eval use during normal decode.
- [llama.mia](https://github.com/coolvision/llama.mia) — interpretability fork with logit
  lens on `l_out`/`kqv_out`/`ffn_out`; CPU-only, LLaMA-2-era, no server integration.
- Issue [#4224](https://github.com/ggml-org/llama.cpp/issues/4224) asked for intermediate
  layer outputs; no upstream API resulted. **No existing PR/fork exposes activations via
  llama-server** — we'd be first.

## 4. Server integration

Easy. `tools/server` is httplib-based, recently split into `server-http.cpp` (route
registration, `svr->Get(...)`) + `server-context.cpp` (handlers). `/metrics`, `/slots`,
`/props` are direct templates, and SSE streaming infrastructure already exists (used by
streaming completions, helpers in `tools/server/utils.hpp`). Adding `/activations` (ring
buffer snapshot) + an SSE variant is an afternoon.

## 5. Dtype

Quantization is weights-only. Graph activation tensors including `l_out` are
`GGML_TYPE_F32` (the cvector code asserts/reads F32; control vectors are created
F32 x n_embd). NVFP4 activation quantization happens transiently inside fused GEMM kernels;
the node outputs copied are fp32. So ~20 KB/layer/token for a 5120-dim model.

## Verdict: **weekend-patch**

Recommended mechanism: patch `graph_get_cb()` in `src/llama-context.cpp` to
`ggml_set_output()` on `l_out-{l}` for an env-configured layer list; copy them in
`llama_context::decode()`'s output readback into a ring buffer keyed by (seq, pos, token);
expose via a new `/activations` SSE route in `tools/server`. Avoid `cb_eval` for production
(CUDA-graph loss); keep it as a zero-patch prototyping path via `cparams.cb_eval` cloned
from cvector-generator. Watch out for MTP: accepted draft tokens arrive as multi-token
ubatches, so slice `l_out` columns by output position rather than assuming ne[1]==1.

## Sources

- [tools/cvector-generator](https://github.com/ggml-org/llama.cpp/blob/master/tools/cvector-generator/cvector-generator.cpp)
- [ggml-backend.cpp scheduler](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-backend.cpp)
- [src/llama-context.cpp](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-context.cpp)
- [src/models/qwen3.cpp](https://github.com/ggml-org/llama.cpp/blob/master/src/models/qwen3.cpp)
- [src/llama-adapter.cpp (cvec apply)](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-adapter.cpp)
- [Issue #4224 — intermediate layer outputs](https://github.com/ggml-org/llama.cpp/issues/4224)
- [llama.mia interpretability fork](https://grgv.xyz/blog/llama.mia/)
- [NVIDIA: CUDA Graphs in llama.cpp](https://developer.nvidia.com/blog/optimizing-llama-cpp-ai-inference-with-cuda-graphs/)
- [tools/server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
