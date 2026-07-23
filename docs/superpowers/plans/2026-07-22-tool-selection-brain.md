# Tool-Selection Brain Visibility + Context-Hygiene Attractor Break — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tool-selection token entropy a first-class, default-on Brain stream (patching llama.cpp to emit logprobs on tool-call chunks), and break the "Read attractor" that traps the model by pruning gate-certified-redundant context and re-decoding.

**Architecture:** C++ patch surfaces per-token logprobs on native tool-call SSE chunks → engine parses them into a new `'tool'` entropy stream → a `ToolDivergenceDetector` alarms when the model confidently emits a governor-disabled tool → context hygiene deflates the poisoned context (Option 3: robust consecutive-deny counter + divergence early trigger) → the Brain tab visualizes the tool-entropy sparkline + divergence markers.

**Tech Stack:** llama.cpp (C++/CMake/CUDA), TypeScript (Bun), vitest, the engine dashboard (vanilla JS in `engine/dashboard/index.html`).

**Spec:** `docs/superpowers/specs/2026-07-22-tool-selection-brain-design.md`

**Standing rules honored:** `protocol.ts`/`protocol.py` untouched (all `brain.*` via `dashboardBroadcast`); no empty catches (log or emit); never kill/restart the shared llama-server without the user; verify-before-moving-on; the final task is a BLOCKING wire check.

---

## File Structure

**Create:**
- `docs/research/llamacpp-toolcall-logprobs.patch` — the reproducible C++ diff (provenance for the patched binary).
- `engine/brain/toolDivergence.ts` — `ToolDivergenceDetector`: confident-emission-of-disabled-tool sensor.
- `engine/bridge/contextHygiene.ts` — pure function that prunes gate-certified-redundant `Read`+`DENIED` message pairs.
- `engine/__tests__/brain/toolDivergence.test.ts`
- `engine/__tests__/bridge/contextHygiene.test.ts`

**Modify:**
- `C:\Users\civer\llama.cpp\tools\server\server-context.cpp` — populate token probs during tool-call/grammar-constrained sampling.
- `engine/ollama/format.ts` — thread tool-call chunk logprobs onto `content_block_start`/`input_json_delta` events.
- `engine/types.ts` — add `logprobs?` to the `input_json_delta` and `content_block_start` stream-event/`ContentBlock` shapes as needed.
- `engine/memory/uncertaintyTracker.ts` — `StreamKind` gains `'tool'`.
- `engine/memory/thinkingRecorder.ts` — `TurnEntropy` gains `tool`.
- `engine/vsm/readLoopGate.ts` — consecutive-deny counter + certified-redundant registry + `escalate` verdict.
- `engine/bridge/conversationLoop.ts` — observe `'tool'` stream; broadcast `brain.toolUncertainty`; run divergence detector; invoke context hygiene.
- `engine/dashboard/index.html` — tool-entropy sparkline coloring + `brain.toolDivergence` markers.

**Test (existing files, extend):**
- `engine/__tests__/ollama/logprobsParse.test.ts` (or the nearest `format`/`fromOpenAIStreamChunk` test)
- `engine/__tests__/memory/uncertaintyTracker.test.ts`
- `engine/__tests__/memory/thinkingRecorder.test.ts`
- `engine/__tests__/vsm/` — new `readLoopGate.test.ts` if none exists

---

## Task 1: C++ — emit logprobs on tool-call SSE chunks

**Files:**
- Modify: `C:\Users\civer\llama.cpp\tools\server\server-context.cpp`
- Create: `docs/research/llamacpp-toolcall-logprobs.patch`

**Context for the implementer:** `server-task.cpp:1543-1551` already attaches `logprobs.content` to the *last* delta of each streaming chat chunk, but only when `prob_output.probs.size() > 0`. `server-context.cpp:1806-1808` copies `prob_output = tkn` for every decoded token when `n_probs > 0`. Empirically (live probe against the running brain server) **0 of 9 tool_call chunks carry `logprobs.content`**, so `prob_output.probs` is empty specifically for the tokens decoded during native tool-call (grammar-constrained) generation. The two leading hypotheses: (H1) `populate_token_probs` (`server-context.cpp:1683`) is skipped or produces empty `probs` when the sampler is grammar-constrained for the tool call; (H2) the tool-call tokens are decoded on a path where `text_to_send` is empty and probs population is gated on non-empty content.

- [ ] **Step 1: Write the failing test (the live probe).** With the current (unpatched) brain server running on 9197, run the probe and confirm 0 tool_call chunks carry logprobs:

```bash
curl -s -m 40 http://127.0.0.1:9197/v1/chat/completions -H 'Content-Type: application/json' -d '{
 "model":"qwen3.6","stream":true,"logprobs":true,"top_logprobs":5,"max_tokens":120,
 "tools":[{"type":"function","function":{"name":"Write","description":"Write a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}}}],
 "tool_choice":"auto",
 "messages":[{"role":"user","content":"Create a file /tmp/hi.txt containing the word hello. Use the Write tool."}]
}' > "C:/Users/civer/toolstream.txt"
```

Then count with the analysis snippet (Windows python, since `/tmp` isn't visible to it):

```python
import json
lines=[l[6:] for l in open(r'C:\Users\civer\toolstream.txt',encoding='utf-8') if l.startswith('data: ') and 'DONE' not in l]
tc=sum(1 for l in lines if 'tool_calls' in l)
tclp=sum(1 for l in lines if 'tool_calls' in l and json.loads(l)['choices'][0].get('logprobs',{}) and json.loads(l)['choices'][0]['logprobs'].get('content'))
print('tool_call chunks:',tc,'with logprobs:',tclp)
```

Expected (baseline): `tool_call chunks: 9 with logprobs: 0`.

- [ ] **Step 2: Instrument to locate the empty-probs point.** In a *separate build dir* (`build-brain-probe`, never overwrite `bin-brain/` yet), add a one-line `LOG_INF` in `server-context.cpp` right where `res->prob_output = tkn` is set (line ~1806) printing `slot.n_decoded`, `tkn.text_to_send` length, and `tkn.probs.size()`. Rebuild only `llama-server`, run it on a scratch port (e.g. 9198), re-run the probe, and read the log to confirm which decoded tokens have `probs.size()==0`. This proves H1 vs H2 before changing behavior.

Run:
```bash
cd /c/Users/civer/llama.cpp && cmake -B build-brain-probe -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build-brain-probe --config Release --target llama-server -j
```
Expected: build succeeds; log shows tool-call-region tokens with `probs.size()==0` (confirming the gap).

- [ ] **Step 3: Apply the minimal fix.** Based on Step 2's finding, ensure token probs are populated for the tool-call tokens. Most likely fix (H1): in `populate_token_probs` / its call site (`server-context.cpp:1683` and the sampling loop that gates it on `need_pre_sample_logits`, line ~1514), ensure the pre-sample distribution is captured for tool-call tokens the same as content tokens (do not gate probs population on `text_to_send` being non-empty). Remove the instrumentation `LOG_INF` from Step 2. Keep the change surgical — it must not alter sampling, only probs *reporting*.

- [ ] **Step 4: Rebuild and re-probe (the passing test).**

```bash
cd /c/Users/civer/llama.cpp && cmake --build build-brain-probe --config Release --target llama-server -j
```
Restart the scratch server on 9198 with the new exe and re-run the Step 1 probe against 9198. Expected: `tool_call chunks: 9 with logprobs: >0` (every tool-call token position now carries `logprobs.content` with `top_logprobs`).

- [ ] **Step 5: Save the patch for provenance.**

```bash
cd /c/Users/civer/llama.cpp && git diff > /c/Users/civer/localcode/.worktrees/tool-brain/docs/research/llamacpp-toolcall-logprobs.patch
```
Expected: the `.patch` file contains only the `server-context.cpp` change.

- [ ] **Step 6: Redeploy to bin-brain (guarded).** DO NOT kill the user's running shared server without asking. With the user's go-ahead, stop the brain llama-server, copy `build-brain-probe/bin/Release/llama-server.exe` (and any changed `*.dll`) over `~/.cynco/bin-brain/`, and record the new build tag in a note beside the binary. Restart the full brain stack (engine spawns it) and re-run the probe against 9197 to confirm the deployed binary emits tool-call logprobs.

- [ ] **Step 7: Commit.**

```bash
cd /c/Users/civer/localcode/.worktrees/tool-brain
git add -f docs/research/llamacpp-toolcall-logprobs.patch
git commit -m "feat(brain): patch llama.cpp to emit logprobs on tool-call chunks"
```

---

## Task 2: format.ts — thread tool-call logprobs onto stream events

**Files:**
- Modify: `engine/types.ts`
- Modify: `engine/ollama/format.ts:224-249`
- Test: `engine/__tests__/ollama/logprobsParse.test.ts`

- [ ] **Step 1: Write the failing test.** Add to the format/logprobs test file:

```typescript
import { describe, it, expect } from 'vitest'
import { fromOpenAIStreamChunk } from '../../ollama/format.js'

describe('fromOpenAIStreamChunk tool-call logprobs', () => {
  it('attaches logprobs to the tool-call name (content_block_start) and arg (input_json_delta) events', () => {
    const chunk = {
      id: 'c1', model: 'm',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'Read', arguments: '{"file' } }] },
        finish_reason: null,
        logprobs: { content: [{ token: 'Read', logprob: -0.01, top_logprobs: [
          { token: 'Read', logprob: -0.01 }, { token: 'Write', logprob: -4.2 },
        ] }] },
      }],
    }
    const events = fromOpenAIStreamChunk(chunk as any)
    const start = events.find(e => e.type === 'content_block_start') as any
    const arg = events.find(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') as any
    expect(start.content_block.logprobs?.[0]?.token).toBe('Read')
    expect(arg.delta.logprobs?.[0]?.top?.[1]?.token).toBe('Write')
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd engine && npx vitest run __tests__/ollama/logprobsParse.test.ts`
Expected: FAIL (`logprobs` undefined on the tool-call events).

- [ ] **Step 3: Widen the types.** In `engine/types.ts` (the `StreamEventDelta` union, ~line 113 and the `ContentBlock`/`content_block_start` around 118), add optional `logprobs?: TokenLogprob[]`:

```typescript
  | { type: 'input_json_delta'; partial_json: string; logprobs?: TokenLogprob[] }
```
and on the `content_block_start` content_block (tool_use) shape add `logprobs?: TokenLogprob[]` (place it on the emitted event object; keep `ContentBlock` itself clean if it is shared — attach `logprobs` to the event, mirroring how `text_delta` carries it).

- [ ] **Step 4: Implement.** In `engine/ollama/format.ts`, inside the `if (choice.delta.tool_calls)` block (224-249), attach the already-parsed `lp` (from `parseChunkLogprobs(choice)` at line 200):

```typescript
  if (choice.delta.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        events.push({
          type: 'content_block_start',
          index: tc.index + 1,
          content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {}, ...(lp ? { logprobs: lp } : {}) },
        })
      }
      if (tc.function?.arguments) {
        events.push({
          type: 'content_block_delta',
          index: tc.index + 1,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments, ...(lp ? { logprobs: lp } : {}) },
        })
      }
    }
  }
```

- [ ] **Step 5: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/ollama/logprobsParse.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add engine/types.ts engine/ollama/format.ts engine/__tests__/ollama/logprobsParse.test.ts
git commit -m "feat(brain): parse tool-call chunk logprobs into stream events"
```

---

## Task 3: UncertaintyTracker — add the `'tool'` stream kind

**Files:**
- Modify: `engine/memory/uncertaintyTracker.ts:9,12`
- Test: `engine/__tests__/memory/uncertaintyTracker.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
it('tracks a tool stream independently and digests it', () => {
  const t = new UncertaintyTracker()
  t.observe('tool', [{ token: 'Read', logprob: -0.01, top: [
    { token: 'Read', logprob: -0.01 }, { token: 'Write', logprob: -4.2 },
  ] }])
  const d = t.digest('tool')
  expect(d).not.toBeNull()
  expect(d!.mean).toBeGreaterThanOrEqual(0)
  expect(t.digest('output')).toBeNull() // isolation
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/memory/uncertaintyTracker.test.ts`
Expected: FAIL (TypeScript: `'tool'` not assignable to `StreamKind`).

- [ ] **Step 3: Implement.** In `engine/memory/uncertaintyTracker.ts`:

```typescript
export type StreamKind = 'thinking' | 'output' | 'tool'
```
and line 12:
```typescript
  private series: Record<StreamKind, number[]> = { thinking: [], output: [], tool: [] }
```
and in `reset()` (51):
```typescript
    this.series = { thinking: [], output: [], tool: [] }
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/memory/uncertaintyTracker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add engine/memory/uncertaintyTracker.ts engine/__tests__/memory/uncertaintyTracker.test.ts
git commit -m "feat(brain): add tool stream to UncertaintyTracker"
```

---

## Task 4: thinkingRecorder — carry `tool` in TurnEntropy

**Files:**
- Modify: `engine/memory/thinkingRecorder.ts:13,111-120`
- Test: `engine/__tests__/memory/thinkingRecorder.test.ts`

- [ ] **Step 1: Write the failing test.** Extend the existing round-trip/aggregate test to include a `tool` digest and assert `aggregateSession` returns a non-null `tool`:

```typescript
it('round-trips and aggregates the tool entropy digest', () => {
  const dir = mkTempSessions() // reuse existing helper in this test file
  const rec = new ThinkingRecorder('s-tool', dir)
  rec.finalizeTurn({ tokenCount: 3, durationMs: 10, entropy: {
    thinking: { mean: 0.2, max: 0.4, spikeCount: 0 },
    output: null,
    tool: { mean: 1.1, max: 1.1, spikeCount: 0 },
  } })
  const agg = ThinkingRecorder.aggregateSession('s-tool', dir)
  expect(agg?.tool?.mean).toBeCloseTo(1.1)
})
```
(Match the existing test file's fixture helpers and `ThinkingRecorder` constructor signature — read the file first.)

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/memory/thinkingRecorder.test.ts`
Expected: FAIL (`tool` not on `TurnEntropy`).

- [ ] **Step 3: Implement.** In `engine/memory/thinkingRecorder.ts:13`:

```typescript
export type TurnEntropy = { thinking: EntropyDigest | null; output: EntropyDigest | null; tool: EntropyDigest | null }
```
and in `aggregateSession` (120) return:
```typescript
    return { thinking: agg('thinking'), output: agg('output'), tool: agg('tool') }
```
(The `agg` helper at 111 already accepts any `'thinking' | 'output'` key — widen its parameter type to include `'tool'`.)

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/memory/thinkingRecorder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add engine/memory/thinkingRecorder.ts engine/__tests__/memory/thinkingRecorder.test.ts
git commit -m "feat(brain): carry tool entropy in TurnEntropy"
```

---

## Task 5: conversationLoop — observe tool stream + broadcast `brain.toolUncertainty`

**Files:**
- Modify: `engine/bridge/conversationLoop.ts:241,364-383,1866-1918`
- Test: covered by the integration wiring test in `engine/__tests__/bridge/brainWiring.test.ts` (extend it)

- [ ] **Step 1: Write the failing test.** In `engine/__tests__/bridge/brainWiring.test.ts`, add a case asserting that when a tool-call delta carrying logprobs flows through the loop's stream handler, a `brain.toolUncertainty` message is broadcast with `kind: 'tool'` points. (Follow the existing test's harness for driving `dashboardBroadcast` capture; if it stubs the provider stream, feed a `content_block_delta` with `input_json_delta` + `logprobs`.)

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/bridge/brainWiring.test.ts`
Expected: FAIL (no `brain.toolUncertainty` emitted).

- [ ] **Step 3: Implement.**
  1. Widen the batch + method unions:
     - `conversationLoop.ts:241`: `kind: 'thinking' | 'output' | 'tool'`
     - `:364`: `private observeUncertainty(kind: 'thinking' | 'output' | 'tool', ...)`
  2. In `flushUncertainty` (375-383), split the batch by kind and broadcast tool points on a separate event so the dashboard can route them:

```typescript
  private flushUncertainty(): void {
    if (this.uncertaintyBatch.length === 0 || !this.dashboardBroadcast) return
    const toolPts = this.uncertaintyBatch.filter(p => p.kind === 'tool')
    const restPts = this.uncertaintyBatch.filter(p => p.kind !== 'tool')
    try {
      if (restPts.length) this.dashboardBroadcast({ type: 'brain.uncertainty', points: restPts })
      if (toolPts.length) this.dashboardBroadcast({ type: 'brain.toolUncertainty', points: toolPts })
    } catch (err) {
      console.log(`[brain] uncertainty broadcast failed: ${err}`)
    }
    this.uncertaintyBatch = []
  }
```
  3. In the stream handler, observe tool logprobs. In the `input_json_delta` branch (1885-1887) and the `content_block_start` handling for `tool_use`, call:

```typescript
              if (delta?.type === 'input_json_delta') {
                tokenCount++
                if ((delta as any).logprobs?.length) this.observeUncertainty('tool', (delta as any).logprobs)
              }
```
     and where `content_block_start` with a `tool_use` block is handled, if `content_block.logprobs?.length` observe them as `'tool'` too (the name token).
  4. In `finalizeTurn` (1911-1918) add `tool: this.uncertainty.digest('tool')`.

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/bridge/brainWiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add engine/bridge/conversationLoop.ts engine/__tests__/bridge/brainWiring.test.ts
git commit -m "feat(brain): observe tool-selection entropy and broadcast brain.toolUncertainty"
```

---

## Task 6: ToolDivergenceDetector

**Files:**
- Create: `engine/brain/toolDivergence.ts`
- Test: `engine/__tests__/brain/toolDivergence.test.ts`

**Definition:** divergence = the tool-name token was emitted at **low entropy** (confident) AND the emitted tool is currently **disabled by the read-loop gate**. Confidence floor is derived from the tool stream's running mean/σ (a *low*-entropy outlier: `h < mean - 1σ`, and below an absolute cap `Math.log(2)` so a genuinely flat distribution never counts), NOT a magic constant.

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest'
import { ToolDivergenceDetector } from '../../brain/toolDivergence.js'

describe('ToolDivergenceDetector', () => {
  it('flags a confident emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    // seed the running distribution with some spread
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    const verdict = d.check({ tool: 'Read', entropy: 0.05, isDisabled: true })
    expect(verdict.diverged).toBe(true)
    expect(verdict.tool).toBe('Read')
  })

  it('does NOT flag a confident emission of an allowed tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Write', entropy: 0.05, isDisabled: false }).diverged).toBe(false)
  })

  it('does NOT flag a high-entropy (genuinely uncertain) emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Read', entropy: 1.5, isDisabled: true }).diverged).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/brain/toolDivergence.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```typescript
/**
 * Reasoning/action divergence sensor: the model confidently emits a tool the
 * read-loop gate has disabled. "Confident" = a low-entropy outlier vs the tool
 * stream's own running distribution (not a magic constant), capped below ln(2)
 * so a genuinely flat distribution never counts as a collapse.
 */
export type DivergenceInput = { tool: string; entropy: number; isDisabled: boolean }
export type DivergenceVerdict = { diverged: boolean; tool: string; entropy: number; floor: number }

export class ToolDivergenceDetector {
  private xs: number[] = []
  private static readonly ABS_CAP = Math.log(2)

  observeEntropy(h: number): void {
    if (Number.isFinite(h)) this.xs.push(h)
  }

  private floor(): number {
    if (this.xs.length < 3) return ToolDivergenceDetector.ABS_CAP
    const mean = this.xs.reduce((a, b) => a + b, 0) / this.xs.length
    const sd = Math.sqrt(this.xs.reduce((a, x) => a + (x - mean) ** 2, 0) / this.xs.length)
    return Math.min(mean - sd, ToolDivergenceDetector.ABS_CAP)
  }

  check(input: DivergenceInput): DivergenceVerdict {
    this.observeEntropy(input.entropy)
    const floor = this.floor()
    const diverged = input.isDisabled && input.entropy <= floor
    return { diverged, tool: input.tool, entropy: input.entropy, floor }
  }

  reset(): void { this.xs = [] }
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/brain/toolDivergence.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit.**

```bash
git add engine/brain/toolDivergence.ts engine/__tests__/brain/toolDivergence.test.ts
git commit -m "feat(brain): ToolDivergenceDetector — confident emission of a disabled tool"
```

---

## Task 7: ReadLoopGate — consecutive-deny counter + certified-redundant registry + escalate

**Files:**
- Modify: `engine/vsm/readLoopGate.ts`
- Test: `engine/__tests__/vsm/readLoopGate.test.ts` (create)

**Behavior:** the gate already denies redundant/stalled reads. Add: (a) count *consecutive* denials of the same signature; at `ESCALATE_AFTER` (default 3) return `{ kind: 'escalate', message, signatures }` where `signatures` is the set of certified-redundant read signatures observed since the last write; (b) `onWrite()` resets the consecutive counter and clears the registry; (c) expose `isDisabled(toolName, input)` so the divergence detector / loop can ask whether a given tool would be denied right now.

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest'
import { ReadLoopGate } from '../../vsm/readLoopGate.js'

describe('ReadLoopGate escalation', () => {
  it('escalates after 3 consecutive denials of the same signature', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    expect(g.evaluate('Read', inp).kind).toBe('allow')   // first read: seen
    expect(g.evaluate('Read', inp).kind).toBe('warn')    // 1st redundant
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 2nd
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 3rd
    const v = g.evaluate('Read', inp)                    // 4th → escalate
    expect(v.kind).toBe('escalate')
    if (v.kind === 'escalate') expect(v.signatures.length).toBeGreaterThan(0)
  })

  it('isDisabled reflects whether a read would be denied', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp) // now in deny mode for this sig
    expect(g.isDisabled('Read', inp)).toBe(true)
    expect(g.isDisabled('Write', { file_path: 'C:/x/a.txt' })).toBe(false)
  })

  it('onWrite resets escalation', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp)
    g.onWrite()
    expect(g.evaluate('Read', { file_path: 'C:/x/b.txt' }).kind).toBe('allow')
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/vsm/readLoopGate.test.ts`
Expected: FAIL (`escalate`/`isDisabled` don't exist).

- [ ] **Step 3: Implement.** Extend `engine/vsm/readLoopGate.ts`:
  - Add to `ReadLoopVerdict`: `| { kind: 'escalate'; message: string; signatures: string[] }`.
  - Add fields: `private consecutiveDenies = 0`, `private lastDeniedSig: string | null = null`, `private redundantSigs = new Set<string>()`, `private static ESCALATE_AFTER = 3`.
  - In `evaluate`, when returning a `deny` (either the redundant branch or the stall branch), first record the certified-redundant signature (`this.redundantSigs.add(sig)`), increment `consecutiveDenies` if `sig === lastDeniedSig` else reset it to 1, set `lastDeniedSig = sig`; if `consecutiveDenies >= ESCALATE_AFTER` return `{ kind: 'escalate', message: <existing deny text>, signatures: [...this.redundantSigs] }`.
  - Add `isDisabled(toolName, input): boolean` — returns true iff `signature()` is non-null AND (`this.seen.has(sig)` with `warnedRedundant` already tripped, i.e. it would deny) — mirror the deny condition without mutating state.
  - In `onWrite()` and `reset()` also clear `consecutiveDenies`, `lastDeniedSig`, `redundantSigs`.

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/vsm/readLoopGate.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit.**

```bash
git add engine/vsm/readLoopGate.ts engine/__tests__/vsm/readLoopGate.test.ts
git commit -m "feat(governance): ReadLoopGate escalation + certified-redundant registry + isDisabled"
```

---

## Task 8: contextHygiene — prune certified-redundant exchanges (pure function)

**Files:**
- Create: `engine/bridge/contextHygiene.ts`
- Test: `engine/__tests__/bridge/contextHygiene.test.ts`

**Contract:** `pruneRedundantReads(messages, redundantSigs, sigOf)` returns a NEW messages array where the maximal run(s) of assistant `tool_use`+matching `tool_result` pairs whose read signature is in `redundantSigs` are removed and replaced by ONE synthetic marker user message, keeping the most recent such exchange for continuity. Never touches non-tool messages, user task instructions, or tool calls whose signature isn't certified redundant. Message validity preserved: an assistant `tool_use` is only pruned together with its matching `tool_result` (matched by `tool_use_id`).

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest'
import { pruneRedundantReads } from '../../bridge/contextHygiene.js'

const sigOf = (name: string, input: any) => name === 'Read' ? `read:${input.file_path}` : null

describe('pruneRedundantReads', () => {
  it('prunes certified-redundant Read+DENIED pairs, keeps the most recent, inserts one marker', () => {
    const mk = (i: number) => ([
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: 'a.csv' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'DENIED' }], is_error: true }] },
    ])
    const messages = [
      { role: 'user', content: 'write the budget script' },       // task — must survive
      ...mk(1), ...mk(2), ...mk(3), ...mk(4),
    ]
    const out = pruneRedundantReads(messages as any, new Set(['read:a.csv']), sigOf)
    // task message survives
    expect(out[0]).toEqual(messages[0])
    // exactly one marker inserted
    const markers = out.filter((m: any) => typeof m.content === 'string' && m.content.includes('[context-hygiene]'))
    expect(markers.length).toBe(1)
    // most-recent exchange (t4) retained
    const ids = JSON.stringify(out)
    expect(ids).toContain('t4')
    expect(ids).not.toContain('t1')
    // no orphaned tool_use / tool_result
    const useIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id) : [])
    const resIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) : [])
    expect(new Set(useIds)).toEqual(new Set(resIds))
  })

  it('does not touch messages when nothing is certified redundant', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(pruneRedundantReads(messages as any, new Set(), sigOf)).toEqual(messages)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/bridge/contextHygiene.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```typescript
/**
 * Context hygiene: deflate the autoregressive prior that creates a tool-call
 * attractor by removing gate-certified-redundant Read+DENIED exchange pairs.
 * Pure function — the caller swaps the returned array into its live context.
 * Safety: only prunes assistant tool_use blocks whose read signature is in
 * `redundantSigs`, together with the matching tool_result (by tool_use_id).
 * Keeps the most recent such exchange for continuity; inserts ONE marker.
 */
type Msg = { role: string; content: any }
type SigOf = (toolName: string, input: any) => string | null

const MARKER =
  '[context-hygiene] Pruned redundant re-read attempts that returned no new information. ' +
  'You have already read the relevant files — write the file now.'

export function pruneRedundantReads(messages: Msg[], redundantSigs: Set<string>, sigOf: SigOf): Msg[] {
  if (redundantSigs.size === 0) return messages

  // A redundant exchange = an assistant message that is EXACTLY one tool_use
  // whose read signature is certified redundant, immediately followed by the
  // matching tool_result user message.
  const isRedundantAssistant = (m: Msg): string | null => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || m.content.length !== 1) return null
    const b = m.content[0]
    if (b?.type !== 'tool_use') return null
    const sig = sigOf(b.name, b.input)
    return sig && redundantSigs.has(sig) ? b.id : null
  }

  // Collect indices of redundant (assistant, result) pairs.
  const pairs: { a: number; r: number }[] = []
  for (let i = 0; i < messages.length - 1; i++) {
    const id = isRedundantAssistant(messages[i])
    if (!id) continue
    const next = messages[i + 1]
    const matches = next.role === 'user' && Array.isArray(next.content) &&
      next.content.some((b: any) => b?.type === 'tool_result' && b.tool_use_id === id)
    if (matches) { pairs.push({ a: i, r: i + 1 }); i++ }
  }

  if (pairs.length <= 1) return messages // nothing to collapse (0 or 1 — keep it)

  // Keep the most recent redundant pair; prune all earlier ones.
  const keep = pairs[pairs.length - 1]
  const pruned = new Set<number>()
  for (const p of pairs.slice(0, -1)) { pruned.add(p.a); pruned.add(p.r) }

  const out: Msg[] = []
  let markerInserted = false
  for (let i = 0; i < messages.length; i++) {
    if (pruned.has(i)) {
      if (!markerInserted) { out.push({ role: 'user', content: MARKER }); markerInserted = true }
      continue
    }
    out.push(messages[i])
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/bridge/contextHygiene.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit.**

```bash
git add engine/bridge/contextHygiene.ts engine/__tests__/bridge/contextHygiene.test.ts
git commit -m "feat(governance): context-hygiene prune of certified-redundant reads"
```

---

## Task 9: Wire divergence + hygiene into conversationLoop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts` (imports; the read-loop deny path ~2621-2637; the tool-observe path from Task 5; turn-boundary reset)
- Test: `engine/__tests__/bridge/brainWiring.test.ts` (extend) + a focused loop test if the harness supports it

- [ ] **Step 1: Write the failing test.** Assert that when `readLoopGate.evaluate` returns `escalate`, the loop (a) calls `pruneRedundantReads` on `this.messages` with the gate's `signatures`, (b) emits a `governance.alert`, and (c) emits `brain.toolDivergence`. Drive it by feeding the same denied read signature 4× through the tool-execution path. (Follow the existing loop-test harness; if direct unit invocation of the private path is hard, assert on the observable outputs: `dashboardBroadcast` receiving `brain.toolDivergence` and the messages array shrinking.)

- [ ] **Step 2: Run to verify it fails.**

Run: `cd engine && npx vitest run __tests__/bridge/brainWiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  1. Import at top: `import { ToolDivergenceDetector } from '../brain/toolDivergence.js'` and `import { pruneRedundantReads } from './contextHygiene.js'`.
  2. Add field `private toolDivergence = new ToolDivergenceDetector()` near `readLoopGate` (210).
  3. In `observeUncertainty` when `kind === 'tool'`, feed each token entropy to `this.toolDivergence.observeEntropy(h)`; when the emitted tool is known and `this.readLoopGate.isDisabled(toolName, input)` is true, run `this.toolDivergence.check(...)` and if `diverged`, broadcast `brain.toolDivergence` (`dashboardBroadcast`) + emit a `governance.alert`, and set a flag to trigger hygiene before the next model call. (The tool name is available at the tool-execution site; the cleanest wiring is to run the divergence check in the read-loop deny path where both the tool identity and `isDisabled` are known — see step 4.)
  4. In the read-loop deny path (2621-2637): change to handle `escalate`:

```typescript
    const readLoopVerdict = this.readLoopGate.evaluate(toolName, toolInput)
    if (readLoopVerdict.kind === 'deny' || readLoopVerdict.kind === 'escalate') {
      console.log(`[read-loop] ${readLoopVerdict.kind.toUpperCase()} ${toolName}`)
      if (readLoopVerdict.kind === 'escalate') {
        const before = this.messages.length
        this.messages = pruneRedundantReads(this.messages, new Set(readLoopVerdict.signatures), (n, inp) => (this.readLoopGate as any).sigOf?.(n, inp) ?? sigForHygiene(n, inp))
        const pruned = before - this.messages.length
        this.dashboardBroadcast?.({ type: 'brain.toolDivergence', tool: toolName, prunedMessages: pruned, signatures: readLoopVerdict.signatures })
        this.emit({ type: 'governance.alert', level: 'warn', message: `[context-hygiene] Broke a ${toolName} attractor: pruned ${pruned} redundant re-read messages.` } as any)
        console.log(`[context-hygiene] pruned ${pruned} messages to break ${toolName} attractor`)
      }
      // ... existing deny emit + tool_result push (unchanged) ...
    }
```
     Provide a small local `sigForHygiene` mirroring `readLoopGate`'s `signature()` (or export `signature` from `readLoopGate.ts` and reuse — preferred, DRY). Export it from Task 7 if not already.
  5. Reset `this.toolDivergence.reset()` wherever `readLoopGate.reset()` is called (598, 643).
  6. Ensure `governance.alert` is an EXISTING protocol event (it is — used across the codebase). Do NOT add a new protocol type. `brain.toolDivergence` is dashboardBroadcast-only.

- [ ] **Step 4: Run test to verify it passes.**

Run: `cd engine && npx vitest run __tests__/bridge/brainWiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add engine/bridge/conversationLoop.ts engine/vsm/readLoopGate.ts engine/__tests__/bridge/brainWiring.test.ts
git commit -m "feat(governance): break tool attractors via context hygiene on read-loop escalation"
```

---

## Task 10: Dashboard — tool-entropy sparkline + divergence markers

**Files:**
- Modify: `engine/dashboard/index.html` (dispatch ~1050-1061; sparkline ~2417-2453; brain state)

- [ ] **Step 1: Add dispatch cases.** After the `brain.uncertainty` case (1052) add:

```javascript
    case 'brain.toolUncertainty':
      brainOnToolUncertainty(event.points || []);
      break;
    case 'brain.toolDivergence':
      brainOnToolDivergence(event);
      break;
```

- [ ] **Step 2: Store tool points + divergence marks.** In the brain state object, add `toolEntropies: []` and `divergences: []`. Implement `brainOnToolUncertainty(points)` to push `{ ...p }` into `brain.toolEntropies` (cap length like `brain.entropies`) and call `drawSparkline()`. Implement `brainOnToolDivergence(ev)` to push `{ at: brain.toolEntropies.length, tool: ev.tool }` into `brain.divergences` and redraw.

- [ ] **Step 3: Render tool stream + markers.** In `drawSparkline` (2417), after drawing the thinking/output series, overlay the tool series in a distinct color (e.g. `#d8a24a` amber) using `brain.toolEntropies`, and draw each `brain.divergences` entry as a red pip (`#e05555`, a small filled triangle at the top) at its `at` x-position, with the existing tooltip extended to show `tool` + entropy on hover. Keep the existing thinking(blue)/output(green) coloring at 2435.

- [ ] **Step 4: Manual verification (live + replay).** Restart the brain stack, drive a turn that calls tools, and confirm via a CDP screenshot that the amber tool sparkline renders. Then trigger the finances repro (Task 12) and confirm a red divergence pip appears at the collapse and that replay of the recorded session also shows it.

Run: `bun C:/Users/civer/.cynco/brain-screenshot.ts C:/Users/civer/.cynco/brain-screens/tool-entropy.png "switchTab('brain')"`
Expected: screenshot shows thinking/output/tool series; divergence pip present after the repro.

- [ ] **Step 5: Commit.**

```bash
git add engine/dashboard/index.html
git commit -m "feat(brain): tool-entropy sparkline + divergence markers on the Brain tab"
```

---

## Task 11: Guards + full suites

- [ ] **Step 1: Run the protocol/empty-catch/except-pass guards.**

Run: `cd engine && npm run audit:wiring`
Expected: PASS. Specifically confirm the protocol coverage guard still passes and that `brain.toolUncertainty` / `brain.toolDivergence` were NOT added to `protocol.ts` (they are dashboardBroadcast-only, like the other `brain.*` events). If the empty-catch ratchet trips on any new `catch`, add a `console.log` (never a bare catch) and, if the baseline legitimately grew, regenerate it via `node engine/__tests__/guards/genBaseline.mjs` with a written reason in the commit.

- [ ] **Step 2: Full engine suite.**

Run: `cd engine && npm test`
Expected: green (prior baseline 2079 passed; new tests add to it; 0 failures — re-run once if the known-flaky saveLearning teardown appears).

- [ ] **Step 3: TUI + jlens suites (unchanged surfaces, prove no regression).**

Run: `cd tui && python -m pytest tests/ -q` (expect 340) and `cd jlens && python -m pytest -q` (expect 8).

- [ ] **Step 4: Commit any guard-baseline updates.**

```bash
git add -A
git commit -m "test: guards + baselines green for tool-selection brain"
```

---

## Task 12: Live smoke — reproduce the finances read-loop and prove hygiene breaks it (BLOCKING)

**Reference repro:** `~/.cynco/sessions/session-1784670687735.jsonl` — the model looped Read→DENIED to halt without ever emitting Write.

- [ ] **Step 1: Bring up the full brain stack** (patched binary from Task 1 deployed):

```bash
cd C:/Users/civer/localcode/.worktrees/tool-brain/jlens && python -m jlens_service.server   # bg
LOCALCODE_MODEL=qwen3.6 LOCALCODE_PROVIDER=llama-cpp LOCALCODE_MODEL_PATH='C:\Users\civer\.cynco\models\qwen3.6-27b-nvfp4\Qwen3.6-27B-NVFP4-MTP.gguf' LOCALCODE_LLAMA_SERVER='C:\Users\civer\.cynco\bin-brain\llama-server.exe' LOCALCODE_PORT=9197 LLAMA_ACTIVATIONS_LAYERS=24,32,40,48,56 bun engine/main.ts   # bg
```
Confirm `[brain] tier: live (tap=true lens=true)` and dashboard 9161 up.

- [ ] **Step 2: Drive the repro turn.** Point it at a directory with a couple of CSVs and instruct: "read the CSVs then write a python script that generates an HTML budget." Let it run (CynCo patience: 15+ min). 

Expected (the fix working): the read-loop reaches escalation, `[context-hygiene] pruned N messages to break Read attractor` appears in the engine log, and the model **emits a `Write`** and produces the script — where the reference session looped to halt. Capture the engine log lines as evidence.

- [ ] **Step 3: Verify the Brain tab.** CDP screenshot showing the amber tool-entropy series, the low-entropy collapse on the disabled `Read`, and a red divergence pip at that point; confirm `Write` follows.

```bash
bun C:/Users/civer/.cynco/brain-screenshot.ts C:/Users/civer/.cynco/brain-screens/hygiene-recovery.png "switchTab('brain')"
```

- [ ] **Step 4: Tier + logprobs sanity.** Re-run the Task 1 probe against 9197 to confirm the deployed binary still emits tool-call logprobs (`with logprobs: >0`), and confirm the engine logged `brain.toolUncertainty` broadcasts.

- [ ] **Step 5: Kill the stack** (Windows): `powershell -Command 'Stop-Process -Name bun,llama-server -Force'` and kill the jlens listener by port 9163. Never reuse — always restart fresh.

---

## Task 13: Wire check (BLOCKING) + finish

- [ ] **Step 1: Grep every new symbol and prove it is imported and called on a live path.**

```bash
cd C:/Users/civer/localcode/.worktrees/tool-brain
for s in "'tool'" "observeUncertainty('tool'" ToolDivergenceDetector pruneRedundantReads "kind: 'escalate'" isDisabled "brain.toolUncertainty" "brain.toolDivergence" toolEntropies brainOnToolDivergence; do
  echo "=== $s ==="; grep -rn --include=*.ts --include=*.html "$s" engine | grep -v __tests__ | head
done
```
Expected: each symbol appears in BOTH a definition site and a live call/dispatch site (not only tests). Any symbol that appears only in a test or only at its definition is a dead-wire BUG — fix before finishing.

- [ ] **Step 2: Confirm protocol files untouched.**

```bash
git diff --name-only origin/main | grep -E 'protocol\.(ts|py)' && echo "VIOLATION: protocol changed" || echo "OK: protocol untouched"
```
Expected: `OK: protocol untouched`.

- [ ] **Step 3: Finish the branch.** Announce and use **superpowers:finishing-a-development-branch** — verify suites, then push + PR + merge on GitHub (web is source of truth), then pull main. Include in the PR body: the root-cause writeup, the 0/9→N/9 logprobs probe result, the hygiene-recovery evidence (engine log + screenshot), and the suite counts.

---

## Self-Review (completed by plan author)

- **Spec coverage:** C++ patch (T1), engine capture/`tool` stream (T2-T5), divergence sensor (T6), gate escalation (T7), context hygiene (T8) + wiring (T9), dashboard sparkline+markers (T10), guards (T11), BLOCKING live smoke (T12), BLOCKING wire check (T13). All five spec components covered.
- **Placeholder scan:** C++ Task 1 is intentionally an investigate→fix→verify sequence (the exact C++ line to change depends on H1/H2, which Step 2 resolves empirically) — the *test* (live probe, 0/9→N/9) and file/line anchors are concrete, not placeholders. All TS tasks carry complete test + impl code.
- **Type consistency:** `StreamKind`/`TurnEntropy` gain `'tool'` consistently (T3/T4/T5); `ReadLoopVerdict` `escalate` shape (`signatures: string[]`) is produced in T7 and consumed in T9; `pruneRedundantReads(messages, redundantSigs, sigOf)` signature identical in T8 def and T9 call; `brain.toolUncertainty`/`brain.toolDivergence` event names identical across T5/T9 (emit) and T10 (dispatch) and T13 (grep).
- **Standing rules:** protocol untouched (guarded in T11 + T13); no empty catches (T11); wire check is the final BLOCKING task (T13); shared-server redeploy gated on user consent (T1 Step 6).
