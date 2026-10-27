# Review: locally-uncensored vs CynCo (2026-10-27)

Source reviewed: https://github.com/PurpleDoubleD/locally-uncensored at commit `762cc712` (3.0.8 fixes, 2026-10-27).
Tauri v2 + Rust backend, React front end, 5,600 files, AGPL-3.0. Read in a shallow clone in the
session scratchpad; nothing from it was executed. Five read-only passes, one per area, each
reading LU's code and CynCo's code side by side; the strongest claims were re-checked by hand.

The purpose is the owner's question: what does LU do that CynCo lacks or does worse, and what
should CynCo adopt so it is the best governed local coding agent and answers without
model-maker refusals. The cybernetic core (VSM, S5, sealed gates, ledger) stays.

## 1. What LU is, and what we deliberately do not port

LU is a consumer **studio**: chat, image/video generation through a managed ComfyUI, a coding
agent, an agent with MCP, voice, computer control, a phone app, an optional paid cloud. CynCo is
an **engine**: one conversation loop under governance, run interactively from the dashboard or
unattended under sealed gates. Most of LU's surface is therefore out of scope:

- Create lanes (image/video/music/LoRA training), voice, computer control, LU Cloud, the Tauri
  desktop shell, signed installers and updater, the native phone app, group chat, personas and
  character cards, ChatGPT/Claude import. Our `engine/imagegen` already covers the one Create
  piece CynCo wants (ComfyUI behind RenderUI).
- **Settings changed from chat** (`src/api/mcp/settings-tools.ts:103-161`). It is the model
  changing its own policy. That is a listed review trigger in `AGENTS.md`; S5's
  advisory → earned-enforce ladder is our answer, not a settings tool.
- **Public tunnel** (Cloudflare, `src-tauri/src/commands/remote.rs:3872-3990`) and a `0.0.0.0`
  LAN bind. Rejected in `docs/decisions/2026-10-22-phone-access.md`; tailnet only.

## 2. "Uncensored": how LU does it, and what CynCo should do

LU's claim rests on four mechanisms. Only the first is what the README advertises.

| Mechanism | LU | CynCo today |
|---|---|---|
| **Abliterated model catalog** | `src/api/discover.ts:1007-1101`: community GGUFs with refusal directions removed, each paired with its vision `mmproj` (`src/api/image-parts.ts`). LU warns that abliteration can dent tool calling (`discover.ts:1010-1013`). | Default profile is stock `Qwen3.8-27B-NVFP4-MTP` (`~/.cynco/profiles/default.yaml`); README lists no abliterated build. |
| **House system prompt** | `src/lib/system-prompt.ts:35-53`: "Answer the request that was actually made. Do not add disclaimers, warnings or moral commentary"; "Every subject the user brings up is yours to answer in full". Names no category and never says "uncensored" (comment `:19-28`). LU measured on 2026-09-10 that a role-naming prompt flipped 6 catalog models from refusing to answering, "stronger than temperature" (`:7-11`). | `engine/engine/systemPromptText.ts` has no refusal language at all. |
| **Refusal detection + notice** | `src/lib/refusal-detect.ts:74-88`: `looksLikeRefusal` = under 60 words and the first 160 chars match an opener list; `<think>` stripped; skipped on tool turns and agent/code mode. On hit, a notice says a refusal in history is copied by later turns and offers a fresh chat. No logit bias, no auto-retry. | Nothing. A refusal in a mission is invisible to the ledger. |
| **In-app abliteration** | `src-tauri/src/commands/abliterate/{mod,plan}.rs` + `resources/abliterate/lu_abliterate.py`: wraps Heretic 1.4.0 headless (harmful/harmless Alpaca sets, Optuna over ablation params, pick fewest refusals under a KL cap of 0.1/0.2/0.4), merges the LoRA, converts with a pinned `convert_hf_to_gguf.py`, re-quantizes, then measures 50 JailbreakBench + 50 benign + 50 MMLU prompts at temp 0. Capped at 14-15B params; bf16 needs 2P+3 GB. Status per CHANGELOG: "has run end to end from the command line on a Mac; the run through the built app is still open." | Nothing, rightly. |

What CynCo should adopt, in order:

1. **A refusal counter in the ledger.** Port `looksLikeRefusal` (pure, about 60 lines) and
   Heretic's stricter marker list as two per-mission counters in `toolStats`-style ledger
   fields, applied only to tool-less assistant turns. It is the measurement that makes every
   other step here falsifiable, which is how `docs/BENCHMARKS.md` says a mechanism earns the
   word "effective".
2. **A house-conduct section in the static system prompt**, behind a `LOCALCODE_*` switch and
   measured by the counter above against the same mission set. LU's wording is the right shape:
   name the model's role as the owner's own, forbid disclaimers and lectures, name no category.
3. **An abliterated profile beside the default.** Same base as our default, so the comparison
   is clean: `bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF` Q5_K_M/Q6_K (21-23 GB) or
   `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` Q4_K (17 GB) on the 5090;
   `Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF` Q4_K_M (21 GB) as the MoE option. For the
   16 GB node: Qwen 3.8 27B Uncensored IQ4_XS (15.6 GB) or
   `culturerevolt/gemma-4-12b-heretic-abliterated-GGUF` Q6_K (9.8 GB). The cost is real: none
   of these exist as NVFP4+MTP builds, so the profile gives up MTP speculative decoding, and
   tool-call success per the ledger must be compared before it becomes a default. Downloads need
   the owner's approval and are pre-staged for missions (`feedback_download_approval`).
4. **Not now: running Heretic ourselves.** It adds a Python/torch/transformers venv, a pinned
   llama.cpp converter and hours of GPU time, and LU itself has not finished it in-app. The
   community builds in step 3 are the same method already run. Revisit only if a model we need
   has no public abliteration, and then as an offline `scripts/` job with a decision record.

## 3. Gap review by area

Verdicts: **lacks** / **weaker** / **has it** / **better**. File refs are the evidence; a name
in a README was never counted.

### 3.1 Coding agent and tool loop

| Capability | LU | CynCo | Verdict |
|---|---|---|---|
| Per-repo rules file | `.lurules` read from the work dir, 10 kB cap, appended to the system prompt (`src/lib/lurules.ts:48-90`) | No read site for any instruction file in the target repo; only global learnings and `~/.cynco/skills` | **lacks** |
| Repo map | PageRank map, 60 s cache, 2,400 chars (`src/api/agents/repo-map.ts:36-94`) | `indexer.buildRepoMap`, 2,000 chars, first turn (`engine/bridge/conversationLoop.ts:2020-2033`) | **has it** |
| Ask / Plan / Bypass per conversation | Knobs {confirmExec, stageWrites, readOnly, planPrompt}, stricter-of-two, read-only shell classifier (`src/lib/codex-mode.ts:102-212`, `shell-command-classify.ts:46-140`) | `approveAll` + per-tool trust/deny + sealed paths (`engine/tools/approvalGate.ts:18-31`); no conversation-level mode, no read-only shell classifier | **weaker** (fine for missions, thin for interactive and phone chats) |
| Stage-and-approve diff before writing | Writes queue a disk→final unified diff; reads are answered from the queue; the model hears the real outcome (`src/hooks/codex/staged-writes.ts:106-245`) | Writes land at once; undo via `WorkspaceSnapshot`/`/undo` afterwards; `ApplyPatch --check` dry run | **weaker** |
| Background shell tasks | `shell_execute background:true` → task id; `task status/list/kill` (`src/api/mcp/builtin-tools.ts:389-414`) | Bash is synchronous under `bashMaxTimeoutMs` (`engine/tools/impl/bash.ts`); nothing detaches | **lacks** |
| Background agents that wake the parent | Finished results bundled into a wake turn (`src/lib/agent-wake.ts`) | Non-blocking `SubAgent`, model must poll `CollectAgent`; no wake. S2 GPU scheduling is stronger than LU's cap of 4 | **weaker** on delivery, **better** on scheduling |
| Continue / resume | Persisted tool chain + todo anchor + "false done" steer twice (`src/lib/plan-resume.ts`, `plan-reconcile.ts`) | JSONL journal resume, contract enforcement rounds, `saysDone` nudges | **better** (a verified contract beats a self-reported todo) |
| Typed git | Folded into shell with parsed summaries | argv-based `Git` tool, force-push and `-c` blocked (`engine/tools/impl/git.ts:3-50`) | **better**; no `gh pr` wrapper either side we need |
| Test runner / failure reading | 4 runners | 13 frameworks, hard-error guard, consumed by bestOfN (`engine/bridge/testSummary.ts`) | **better** |
| In-turn read cache | Identical reads served from cache, never for mutating tools (`src/api/agents/in-turn-cache.ts:46-72`) | No dedupe; doom-loop and read-loop gate deny repeats instead | **lacks** |
| Loop guards | 5 detectors incl. A/B/A alternation, repeated narration | Stuck tiers, doom loop, circuit breaker, read-loop gate | **comparable** |

### 3.2 Model and engine management

| Capability | LU | CynCo | Verdict |
|---|---|---|---|
| Pin the engine to one GPU | `--device` chosen by name via `--list-devices` (`gpu_roles.rs:133-198`, `engine.rs:4278-4282`) | `buildServerArgs` emits `--n-gpu-layers 999` only; `readGpuMemory` parses nvidia-smi's first line (`engine/llama/hostResources.ts:72-75`) | **lacks**. Harmless today: the 5090 box has one card and the 4070 Ti Super is in another PC. Becomes a defect the day a second card lands in the same box |
| VRAM plan from the tensor table + one-click fixes | Per-layer weights and KV, `-ngl`/`--n-cpu-moe` placement, fit advice with actions, post-start check against `-lv 4` buffer lines, learned driver overhead (`vram_plan.rs:808-1300`) | Host-side checkpoint cost from the header, calibrated live (F89/F91); VRAM floor is file size + 2 GiB (`hostResources.ts:112-119`) | **weaker** on VRAM, **better** on the prompt-cache budget (LU's `cache_ram_cap` is a RAM-share guess) |
| Spawn diagnosis and fallback | GGUF precheck before killing the healthy engine; stderr classifier (library → model → port → GPU); health timeout 60 s + 4 s/GiB; sanity probe then `-fa off` → `-ngl 0` ladder (`engine.rs:2619-2915`, `3937-3965`) | F140 pre-spawn refusal, fixed 300 s health, 3-in-600 s restart budget; exits surface as "exited with code N" | **weaker** on naming the failure, **better** on refusing early (LU has no commit-charge check) |
| Model download | Range resume, 416 handling, exact size via HEAD/Range, sha256 with prefix replay, disk guard (`download.rs:1157-2016`) | No GGUF download; binary zip fetched whole into memory | **lacks** (as an interactive, owner-approved `scripts/` fetch) |
| Vision `mmproj` pairing | `<model>.mmproj.gguf` convention, `--mmproj`, slot save disabled when loaded (`engine.rs:174-330`, `2105-2115`) | `modelResolver.ts:15-66` throws on a second `.gguf` in the folder; no mmproj field | **lacks** |
| Reuse Ollama / LM Studio model blobs | Manifest → blob path, served by llama-server without a copy (`engine.rs:4882-4946`) | `~/.cynco/models/<name>/` only | **lacks** |
| Local OpenAI-compatible API | Port 8129, token required even on loopback, caller auth stripped (`local_api.rs`) | None | **lacks**, low priority |
| Children die with the app | One shared KILL_ON_JOB_CLOSE job (`process.rs:38-148`) | `engine/security/jobObject.ts` (F131) | **parity** |
| Benchmark / compare | Per-GGUF microbench: tok/s, TTFT, think share, answer correctness, side by side (`src/lib/benchmark-run.ts`) | `benchmark/cli.ts --compare`, true-bench and ledger grade task outcomes | **better** on outcomes; **lacks** a 2-minute per-quant microbench |

### 3.3 Chat, memory, context, research

| Capability | LU | CynCo | Verdict |
|---|---|---|---|
| Memory store | Flat, per-type, embedded | Bitemporal `LearningStore` with evidence-gated promotion (`engine/memory/learningStore.ts`, `promotionGate.ts:98`) | **better** |
| Memory extraction and recall | Every 3rd turn a silent extraction; ADD/UPDATE/NOOP by cosine band; recall 0.6 semantic / 0.25 BM25 / 0.15 recency with a raw-cosine floor; injected as a turn note, not the system prompt, to keep the prefix cache (`src/hooks/useMemory.ts`, `memory-retrieval.ts:35-75`, `turn-context.ts:50`) | Recall once on the first message and replayed byte-identically (`engine/engine/callModel.ts:378-421`); saving is model-initiated; `markHelpful/markHarmful` have no caller | **lacks** |
| Document chat | 500-char chunks, IndexedDB vectors, 0.7 cosine + 0.3 BM25 | Heading-bounded chunks, sqlite-vec, RRF fusion, numbered citations, cross-project (`engine/projects/search.ts:59`) | **better** |
| Auto-compact | Provenance-margin trigger; seven-section summary; later compactions merge into one; `keepVerbatimFromPrevious` restores any dropped request or vanished path/number literal (`src/lib/compact-summary.ts:273`, `:820`) | 0.4/0.8 triggers, server `prompt_tokens` floor, pins contract + task + last 6 user turns (F129, `engine/context/compressor.ts`) | **comparable** trigger and anchors; **weaker** on merge-and-verify |
| Tool-result age decay | Results older than 2 iterations capped head+tail at 4,000 chars deterministically; dropped steps become a run ledger (`src/lib/context-decay.ts:223`) | Truncated once at write time, never aged | **weaker** |
| Per-turn thinking effort | `thinking_budget_tokens` per request, effort ladder per model (`src/lib/think-budget.ts:70`) | Static `chat_template_kwargs` per profile | **lacks** |
| Image attachments | 5 images, re-encoded, healed on text-only models | `user.message` is text only (`engine/bridge/protocol.ts:800`) | **lacks** |
| Web search ranking | None: first tier with hits wins | Domain routing, keyword/recency/authority/corroboration scoring, URL dedup (`engine/research/resultScorer.ts`) | **better** |
| Web search failure semantics | Tiers return `Hits / Empty / Failed`; a DDG bot-check page is Failed, not Empty; one shared deadline; the model reads a `[Tried: …]` line and a one-sentence "do not retry" (`search_tiers.rs:167-228`, `:730`) | `searchWithFallback` swallows throws into `[]` (`engine/research/engineRouter.ts:67`); DDG treats a CAPTCHA as empty and retries 3× with sleeps; no deadline | **weaker** |
| SSRF guard | Resolve DNS, block private/mapped/NAT64/multicast, then pin the vetted addresses into the socket (`src/dev/ssrf-policy.ts`, `proxy.rs:407-520`) | Literal-IP and spelling checks, redirects re-validated (`engine/tools/impl/webFetch.ts:63-155`); the hostname is never resolved | **weaker**: a public name resolving to 127.0.0.1:9161 passes |

### 3.4 Remote, phone, security

| Capability | LU | CynCo | Verdict |
|---|---|---|---|
| Pairing | 6-digit code, 15 min TTL, 3 wrong → 60 s cooldown; QR; new device approved at the desk within 2 min (`remote.rs:31-39`, `remote_sealed.rs:95`) | Single-use code rotated on every use and on lockout, 5 wrong → 10 min, constant-time (`engine/dashboard/access.ts:161-216`) | **better** on brute force; **lacks** QR and desk-side approval |
| Device tokens | JWT 1 h sliding, 24 h hard cap, idle eviction (`remote.rs:285-296`, `:598-628`) | `device-<8hex>` record, no expiry, no `lastSeen` (`localToken.ts:194-203`) | **weaker** hygiene, **better** scope separation (management desk-only by construction; LU had to patch a device writing its own permissions, `remote.rs:2762`) |
| Device list / revoke | List, disconnect one, revoke-all with a 409 reconnect notice, per-device rights | List + revoke one (`server.ts:1012-1056`) | **has it**; lacks revoke-all and rights granularity |
| Reconnect after the phone was away | Per-chat event buffer ≤2,000, `stream?after=<seq>`, paged messages (`remote_chats.rs:43`, `:929-1025`) | `/api/session` serves pending decisions only; streamed text is lost | **lacks** (NOW Next 4) |
| Push when the agent waits | None | `ntfyChannel.ts` exists, not fired on `approval.request` | both lack; CynCo is one wiring step ahead (NOW Next 5) |
| Uploads from the phone | Chunked, sha per piece, per-owner 8 files / 64 MB, total 256 MB, pictures/PDF/text only, no-follow writes (`remote_create.rs:53-116`) | Upload exists but is `management` scope, unreachable from a phone | **lacks** (NOW Next 1) |
| Stop propagation | Cancel registry with tombstones (cancel-before-register), 30 s TTL (`cancel_registry.rs`); fetch aborted | `abort()` ends the turn (F180) but the signal never reaches the provider fetch; Bash child not killed | **weaker** (NOW Next 2) |
| Exposure | `0.0.0.0:11435` + optional Cloudflare tunnel | Tailnet listener only, never wildcard | different by design; ours is the stated posture |

## 4. Where CynCo is ahead

So the review is not read as "LU is better": governance (S1–S5, homeostat, stuck tiers, S5
advisory/enforce), sealed calibrated gates and the outcome ledger, the contract system, the
checkpoint-cost budget derived from the GGUF header and calibrated live, pre-spawn refusal on
commit charge, project RAG with citations, scoped tokens with desk-only management, the
code index with hybrid rank, and 13-framework test summaries. LU has none of these. LU is a
polished product; CynCo is a governed engine with a thinner interactive surface.

## 5. Ranked shortlist for CynCo

Each item is one vertical slice with a test at the layer where the work happens. Items 1–3 serve
the owner's "runs uncensored" aim; the rest close verified gaps.

| # | Slice | Why | Touches |
|---|---|---|---|
| 1 | Refusal counter in the ledger (`looksLikeRefusal` + Heretic markers, tool-less turns only) | Makes "uncensored" measurable per mission before anything is changed | `benchmark/cynco-ledger`, `scripts/cynco-mission-driver.mjs` |
| 2 | House-conduct section in the static system prompt behind a `LOCALCODE_*` switch | LU measured it flips refusing models; cheapest lever; A/B via item 1 | `engine/engine/systemPromptText.ts` |
| 3 | Abliterated profile beside the default, pre-staged with owner approval, tool-call rate compared in the ledger | The weights are where refusals live; the MTP loss and tool-call dent must be measured, not assumed | `~/.cynco/profiles`, README Recommended Models |
| 4 | Background Bash: `background` flag → task id, `status/kill` action, children under the F131 job | Long suites eat the turn against `bashMaxTimeoutMs` (F142) | `engine/tools/impl/bash.ts` |
| 5 | Search failure semantics: tri-state tier outcome, DDG bot-check = Failed, shared deadline, `[Tried: …]` line | Missions loop on "the web has nothing" when a CAPTCHA cost 15 s of sleeps | `engine/research/engineRouter.ts:61-85`, `engines/duckduckgo.ts` |
| 6 | Resolve-then-pin in `WebFetch` + numeric IPv6 prefixes | The engine fetches model-chosen URLs on a box whose bridge sits on loopback; DNS is the one bypass left. Tightens a boundary: owner should see it | `engine/tools/impl/webFetch.ts` |
| 7 | Per-repo rules file (`AGENTS.md`/`CLAUDE.md` of the target repo, ~10 kB cap) into the system prompt | CivKings conventions live only in the brief today | `engine/bridge/conversationLoop.ts` near the repo-map injection |
| 8 | Sub-agent wake: bundle finished results into one `SteeringQueue` steer | Non-blocking `SubAgent` is only useful if the model remembers to poll | `engine/bridge/conversationLoop.ts:5480-5512` |
| 9 | Cursor-based event buffer + session id on `/api/session` | Closes NOW Next 4 with LU's proven shape | `engine/dashboard/server.ts` |
| 10 | Abort threading into the provider fetch + Bash child kill, with a cancel tombstone | Closes F180's open item (NOW Next 2) | `engine/engine/callModel.ts:249-257`, `llama/provider.ts`, `ollama/client.ts` |
| 11 | Compaction merge + verbatim-loss check (`literalTokens`) | A summary of a summary can still lose a path or number (F129's class) | `engine/context/compressor.ts` |
| 12 | Age-based tool-result decay, deterministic at one boundary | Cuts 40-step mission cost before compaction fires; keeps the prefix byte-identical | `engine/bridge/conversationLoop.ts:205` |
| 13 | Stderr failure classifier + GGUF precheck + health timeout scaled to file size | Turns "exited with code 1" into a named refusal (F140 path) | `engine/llama/processManager.ts` |
| 14 | `mmproj` sibling pairing in `resolveModel`, slot snapshots off when present | Qwen3.6/3.8 are vision-capable; a dropped-in projector breaks resolution today | `engine/llama/modelResolver.ts:15-66` |
| 15 | Per-turn memory recall as a turn note + ADD/UPDATE/NOOP write decision | Keeps our better store; fixes recall-once and the uncalled `markHelpful/markHarmful` | `engine/engine/callModel.ts`, `engine/memory` |
| 16 | Device hygiene: `lastSeen`, idle expiry, revoke-all, desk approval of a new device | NOW Next 6 | `engine/dashboard/access.ts`, `localToken.ts` |
| 17 | Phone uploads at `inference` scope with LU's caps | NOW Next 1 | `engine/dashboard/server.ts:1190-1208` |
| 18 | GPU pin by name (`--device`, nvidia-smi line choice) | Only when a second card lands in the 5090 box | `engine/llama/processManager.ts:70`, `hostResources.ts:72` |

Lower, kept for the record: resumable verified GGUF fetch script, Ollama-blob reuse, per-quant
microbench, per-turn `thinking_budget_tokens`, image attachments in project chats, in-turn read
cache, stage-and-approve diffs for interactive chats, Ask/Plan/Bypass modes.

## 6. Two checks the passes flagged, done by hand

The verdicts rest on reading both codebases, not on running LU. Two things the passes flagged
were then checked in CynCo's source:

- **Sub-agent approval gate.** LU made per-call approval mandatory in sub-agents after finding
  writes slipping past it (`tool-executor.ts:104-127`). CynCo's `SubAgent` builds its
  `ToolExecutor` with `approveAll: true` and a `requestApproval` that always answers yes
  (`engine/agents/subAgent.ts:72-76`), but `getToolsForTier` returns the read-only set
  (`Read, Glob, Grep, CodeIndex, Ls, ImageView, Git`) for **every** tier; the specialist and
  full tiers fall back to it (`engine/agents/trustTier.ts:9-16`). So the hole does not exist.
  Two side findings: the README's "kraken — test-driven implementation" and "spark — targeted
  bug fixes" personas cannot write anything today, which overstates the capability; and `Git` sits
  in the read-only set although it can commit. If item 8 (sub-agent wake) ever widens a tier, the
  per-call gate becomes the real boundary and should be wired first.
- **`--no-verify`.** LU refuses it in its shell tool (`builtin-tools.ts:964`). Nothing in
  `engine/tools/bashSafety.ts` or `engine/tools/impl/bash*.ts` mentions it, so a mission can skip
  the target repo's hooks. Small, belongs with item 4.
