# Tool-Selection Visibility + Context-Hygiene Attractor Break — Design

**Date:** 2026-07-22
**Status:** Approved (brainstorming)
**Author:** CynCo self-development session

## Motivation

Reading the most recent CynCo session (`~/.cynco/sessions/session-1784670687735.jsonl`)
surfaced a hard failure. The user asked CynCo to read financial CSVs in
`C:\Users\civer\finances\` and write a Python script that generates an HTML budget.
CynCo **never emitted a single `Write`** during the finances task — ~40 `Read` +
56 `Grep` calls, then an infinite loop of `Read` → `[read-loop] DENIED` → `Read`.
The `ReadLoopGate` correctly disabled reads and named `Write/Edit` as the escape;
the user even typed *"do not use the Read tool. Write a python script now"* — and the
very next emission was another `Read`. The session ended in the halt-at-5 safety.

The Brain replay of that session (`session-1784670687735.thinking.jsonl`) shows *why we
were blind*: the **thinking** channel reasons correctly and repeatedly ("I need to use
the Write tool… stop trying to read and just write"), with healthy thinking entropy
(0.03–1.5). But **`output` entropy is `null` on every turn**. The model emits almost no
free text on these turns — just a tool call — and the tool-call token (the Read-vs-Write
decision) is never observed by the uncertainty tracker. The single most
governance-relevant token in the whole turn is invisible to the Brain.

### Root cause (two stacked problems)

1. **A Read attractor the model can't escape.** After dozens of `Read` calls fill the
   context, the autoregressive prior on the `Read` tool-name token dominates the
   tool-selection position. The reasoning breaks free; the emission collapses back to
   `Read`. This is the exact failure class the P4.3 fingerprint detector *flags*, but
   nothing actually breaks the model out — `Read` is disabled, so it just eats `DENIED`
   forever.

2. **The Brain is blind to the fatal token.** `conversationLoop.ts` calls
   `observeUncertainty('output', …)` only on `text_delta` and `('thinking', …)` on
   `thinking_delta`. Native tool calls arrive as `tool_use` blocks via `input_json_delta`,
   which carry no logprobs into the tracker — and empirically the patched brain
   llama-server drops logprobs on tool-call chunks entirely (verified live: 9 tool_call
   chunks, 0 with `logprobs.content`).

## Goals

- **Feature 1 — Tool-selection entropy (Brain Tier-1 extension):** make the tool-name /
  tool-argument token entropy a first-class, default-on Brain stream, visualized on the
  Brain tab, with a divergence alarm when the model confidently emits a tool the governor
  has disabled.
- **Feature 2 — Context-hygiene attractor break (non-bandaid):** when the read-loop /
  fingerprint counters (guaranteed trigger) OR the tool-entropy divergence signal (early
  trigger) fire, deflate the context that *created* the attractor by pruning the
  zero-information `Read`+`DENIED` exchanges, then re-decode.

Explicitly **not** a bandaid: we do not force `tool_choice` nor blindly strip `Read` from
the toolset. We attack the autoregressive prior at its source (context poisoning) and give
the model a clean context to re-decide in.

## Non-Goals

- Path A (text-emitted `<tool_call>` XML + token-level resampling) — rejected in
  brainstorming in favor of Path B (patch the native server, keep native tools).
- Retraining / fine-tuning the model to avoid the attractor.
- Changing the `protocol.ts` / `protocol.py` typed contract — all Brain streams flow via
  `dashboardBroadcast` only (standing rule, unchanged).

## Architecture

Three layers, in dependency order:

```
┌────────────────────────────────────────────────────────────────────────┐
│ C++  llama.cpp (C:\Users\civer\llama.cpp @ b9529)                        │
│   server-chat.cpp  to_json_oaicompat_chat_stream                         │
│     attach per-token logprobs.content (already in generated_token_probs) │
│     to chunks whose delta is a tool_calls diff                           │
│   → rebuild llama-server.exe → redeploy ~/.cynco/bin-brain/              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                 │  SSE: tool_calls chunk now carries logprobs
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Engine (TypeScript / Bun)                                                │
│   format.ts fromOpenAIStreamChunk  → thread lp onto tool-call events     │
│   UncertaintyTracker  → StreamKind gains 'tool'                          │
│   conversationLoop.ts → observeUncertainty('tool', …) on tool deltas;    │
│                         ToolDivergenceDetector; ContextHygiene           │
│   ReadLoopGate → consecutive-deny counter + certified-redundant registry │
│   thinkingRecorder TurnEntropy → gains 'tool'                            │
│   dashboardBroadcast → brain.toolUncertainty, brain.toolDivergence       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                 │  brain.* broadcasts (replayCache'd)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Dashboard (engine/dashboard/index.html, port 9161)                       │
│   Brain tab: tool-selection entropy sparkline + divergence markers       │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component 1: C++ patch — tool-call logprobs

**File:** `C:\Users\civer\llama.cpp\tools\server\server-chat.cpp`
(`to_json_oaicompat_chat_stream`, ~line 551) and whatever call site assembles the
streaming chunk's top-level `logprobs` field.

**What:** The server already collects per-token probabilities in
`server-context.cpp:317` (`generated_token_probs.push_back(token)`) and threads them onto
content chunks. The oaicompat chat-stream serializer omits the `logprobs` field on chunks
whose delta is a `tool_calls` diff. The patch attaches the same `logprobs.content` array
(built from the tokens consumed since the previous chunk) to tool-call chunks.

**Constraint:** a single `tool_calls` diff (e.g. the "name" chunk) may correspond to
multiple raw tokens. Our consumer only needs per-token entropy for the tokens emitted in
that chunk, so exact structural alignment to the tool-call JSON is unnecessary — attach the
raw per-token logprobs for the tokens consumed in the chunk.

**Build/deploy:** rebuild `llama-server` (`cmake --build build --config Release --target
llama-server -j`), copy the exe + any changed DLLs to `~/.cynco/bin-brain/`, record the
build tag. This is the long pole (~30–60 min rebuild).

**Provenance:** save the diff as `docs/research/llamacpp-toolcall-logprobs.patch` next to
the existing activation-tap patch, so the patched binary is reproducible.

### Component 2: Engine capture — the `tool` entropy stream

**`engine/ollama/format.ts`** (`fromOpenAIStreamChunk`, 225-248): when a tool-call chunk
carries `choice.logprobs.content`, attach the parsed `lp` to the emitted tool-call
`StreamEvent`s (`content_block_start` for the name token, `input_json_delta` for arg
tokens), mirroring how `text_delta`/`thinking_delta` already attach it (207/220).

**`engine/memory/uncertaintyTracker.ts`**: extend
`StreamKind = 'thinking' | 'output' | 'tool'`. `series`, `observe`, `digest`, `values`,
`reset` already key off `StreamKind` generically — the union widening is the only change
plus initializing the `tool` bucket.

**`engine/bridge/conversationLoop.ts`** (~1885, the `input_json_delta` branch, and the
`content_block_start` handling for tool_use): when a tool-call delta carries logprobs, call
`this.observeUncertainty('tool', delta.logprobs)`. Widen the `uncertaintyBatch` kind union
(241) and `observeUncertainty` signature (364). In `finalizeTurn` (1911-1918) add
`tool: this.uncertainty.digest('tool')`.

**`engine/memory/thinkingRecorder.ts`**: `TurnEntropy` (13) gains `tool: EntropyDigest |
null`; `aggregateSession` `agg('tool')` (the `agg` helper already generalizes).

**Broadcast:** a new `brain.toolUncertainty` event via `dashboardBroadcast` (batched
sparkline points, same shape as the existing thinking/output uncertainty batch), and
`brain.toolDivergence` for the alarm (below). Both replayCache'd so late-joining dashboard
clients see them.

### Component 3: ToolDivergenceDetector (the sensor)

**File:** `engine/brain/toolDivergence.ts` (new).

**Signal:** divergence = the tool-name token was emitted at **low entropy** (confident)
**AND** the emitted tool is one `ReadLoopGate` currently has **disabled** (i.e. the gate
would `deny` it). "Confident emission of a governor-forbidden tool" is the operational
definition of reasoning/action divergence — no fuzzy parse of the thinking channel needed,
because the gate already knows which tool is forbidden.

**Threshold:** entropy below a configured floor (default derived from the tool stream's own
running distribution, matching the spike logic in `UncertaintyTracker.digest` — reuse the
mean/σ approach rather than a magic constant). Exact calibration is a plan task with a test.

**Output:** emits `brain.toolDivergence` (dashboard marker) and a `governance.alert`
(evidence: tool name, entropy, consecutive-deny count). Also feeds Component 4 as the
*early* trigger.

### Component 4: Context hygiene (the actuator) — Option 3

**Guaranteed trigger — `engine/vsm/readLoopGate.ts`:** add a consecutive-deny counter keyed
by tool signature. Today the gate flips to permanent `deny` but does not count repeats.
Add: when the same signature is denied `N` times in a row (default 3, matching the P4.3
fingerprint 3-identical threshold), return a new verdict kind `{ kind: 'escalate' }` (or a
flag on the existing deny) that the loop routes to context hygiene. Track a registry of
*certified-redundant* exchange signatures (the re-reads the gate denied) so hygiene knows
exactly which messages are safe to prune.

**Early trigger:** the `ToolDivergenceDetector` signal trips hygiene before the counter
reaches N — as soon as the model confidently locks onto a disabled tool.

**The fix — `engine/bridge/contextHygiene.ts` (new):** operates on the in-memory
`messages` array in `conversationLoop`:
1. Identify the maximal run of `Read/Grep/Glob/Ls`+`DENIED` (or redundant-`Read`) exchange
   pairs the gate certified as zero-information.
2. Prune those assistant `tool_use` messages **and** their matching `tool_result` messages
   as pairs (message validity: every `tool_use` keeps its `tool_result`; role alternation
   preserved).
3. Replace the pruned run with one synthetic marker message:
   `[context-hygiene] Pruned N redundant re-read attempts that returned no new information.
   You have already read the relevant files — write the file now.`
4. Keep the most recent 1 exchange for continuity.
5. Re-decode the current turn against the deflated context.

**Safety invariant (critical):** hygiene may prune **only** exchanges the gate certified
redundant/denied — never task content, never the user's instructions, never a
non-redundant tool call. The full transcript remains on disk in the session JSONL; only the
live model context is deflated.

**Fallback:** if the model re-collapses to the disabled tool after hygiene has fired twice
in the same stuck region, fall through to the existing halt-at-5-consecutive-failures safety
(already present; fired in the repro session). Hygiene is the primary fix, not the last line
of defense.

**Alerting:** `governance.alert` on both surfaces (mission ledger + interactive) with
evidence: tool, consecutive-deny count, tool entropy at collapse, number of exchanges
pruned.

### Component 5: Dashboard — tool-entropy sparkline + divergence markers

**File:** `engine/dashboard/index.html` (Brain tab).

- New tool-selection entropy sparkline rendered beside the existing thinking/output
  uncertainty traces, fed by `brain.toolUncertainty` batches (reuse the existing sparkline
  widget + batching path).
- `brain.toolDivergence` events render as distinct markers (e.g. a red pip) on the tool
  sparkline at the collapse point, with a tooltip showing tool + entropy + deny count.
- Replay path: the tool stream and divergence markers must render for recorded sessions via
  the existing `/api/thinking/*` replay, so the finances session can be replayed and the
  divergence made visible after the fact.

## Data Flow (the fix, end to end)

1. Model emits `Read` at low tool-entropy while `ReadLoopGate` has `Read` disabled.
2. `format.ts` attaches tool-call logprobs → `observeUncertainty('tool', …)`.
3. `ToolDivergenceDetector` sees confident-emission-of-disabled-tool → `brain.toolDivergence`
   + `governance.alert`, and trips context hygiene (early trigger). (If entropy is
   unavailable, the consecutive-deny counter trips it at N — guaranteed trigger.)
4. `contextHygiene` prunes the certified-redundant `Read`+`DENIED` run, inserts the marker,
   re-decodes.
5. Deflated context → the `Read` prior collapses → the model emits `Write`.
6. Dashboard shows the tool-entropy collapse, the divergence marker, and (post-hygiene) the
   recovery.

## Testing Strategy

- **C++:** manual/live — after redeploy, re-run the tool-triggering probe against the brain
  server and assert tool_call chunks now carry `logprobs.content` (the exact probe used in
  brainstorming: 0/9 before, expect N/9 after).
- **format.ts:** unit — a fixture chunk with `tool_calls` + `logprobs.content` yields
  tool-call events carrying `logprobs`.
- **UncertaintyTracker / thinkingRecorder:** unit — `'tool'` stream digests and round-trips
  through `TurnEntropy`; `aggregateSession` includes `tool`.
- **ToolDivergenceDetector:** unit — confident emission of a gate-disabled tool → divergence;
  confident emission of an allowed tool → none; high-entropy emission of a disabled tool →
  none (it's genuine uncertainty, not a collapse).
- **ReadLoopGate:** unit — N consecutive denials of the same signature → escalate; a `Write`
  in between resets the counter; the certified-redundant registry lists exactly the denied
  re-reads.
- **contextHygiene:** unit — given a message array with a run of `Read`+`DENIED` pairs,
  prunes exactly those pairs (validity preserved: no orphan `tool_use`/`tool_result`),
  inserts one marker, keeps the most recent exchange, never touches user/task messages.
- **Guards:** `npm run audit:wiring` (protocol coverage, empty-catch ratchet, except-pass
  ratchet) must stay green. New `brain.toolUncertainty` / `brain.toolDivergence` are
  dashboardBroadcast-only, so they must NOT enter the protocol guard — confirm the guard
  still passes and they are not added to `protocol.ts`.
- **Live smoke (integration, BLOCKING):** reproduce the finances read-loop against the live
  brain stack and prove hygiene breaks it — the model emits `Write` and the task completes,
  where before it looped to halt. `session-1784670687735.jsonl` is the repro reference.

## Wire Check (BLOCKING, per standing rule)

The plan's final task greps every new symbol and proves it is imported and called on a live
path: `StreamKind 'tool'`, `observeUncertainty('tool'`, `ToolDivergenceDetector`,
`brain.toolUncertainty`, `brain.toolDivergence`, `contextHygiene`, the `ReadLoopGate`
escalate path, and the dashboard sparkline/marker handlers. No dead symbols.

## Risks & Mitigations

- **C++ rebuild breaks the baseline binary.** Mitigation: keep the current `bin-brain/`
  binary; build into a separate dir, smoke-test the logprobs probe, only then swap. Never
  kill/restart the shared server without the user (standing rule).
- **Pruning removes needed context.** Mitigation: the safety invariant — prune only
  gate-certified-redundant exchanges; full record on disk.
- **Divergence false positives** (confident emission of a disabled tool that was actually
  correct). Mitigation: the gate's "disabled" set is only ever redundant re-reads /
  post-stall reads, which are by construction not the right action; and hygiene's worst case
  is deflating context the gate already called zero-information.
- **Model re-collapses after hygiene.** Mitigation: the halt-at-5 fallback remains.

## Open Questions

None blocking. Calibration of the divergence entropy floor and the consecutive-deny `N` are
plan tasks with tests and sensible defaults (σ-based floor; N=3).
