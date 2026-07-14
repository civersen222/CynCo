# Phase 1 Exit Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satisfy the STATE doc's falsifiable Phase 1 exit criterion — one scripted 12-turn test session whose ledger record contains ≥1 algedonic signal, ≥1 opened-and-evaluated prediction, persisted S4 scores, ≥1 snapshot hash, a windowed-variety series, and a heterarchy context series; plus a deliberately malformed tool call that is retried (never silently discarded) through the real transport repair ladder.

**Architecture:** First extract the 4×-duplicated gated-live-test harness (defaultConfig / defaultCapabilities / mockProvider / textResponse / toolCall) into a shared module `engine/__tests__/harness/liveHarness.ts` (standing directive: no deferred cleanup — the new test would otherwise be a 5th copy). Then add one gated test, `engine/__tests__/vsm/phase1Exit.test.ts`, that scripts a single 12-model-call session through a real `ConversationLoop`, feeds all events into the real `createMissionCollector`, builds a mission record via `buildMissionRecord`, and asserts every exit-criterion signal on that record. Finally amend the STATE doc and run the BLOCKING wire check.

**Tech Stack:** TypeScript, vitest (NEVER `bun test`), gated via `CYNCO_INTEGRATION=1`.

**Branch:** `phase1-exit-gate` (already created from main @ 25d402c).

---

## Design facts (verified against source — do not re-derive)

- `vitest.config.ts` include glob is `engine/__tests__/**/*.test.ts` (+3 others) — a harness file named `liveHarness.ts` is NOT collected as a test.
- The four existing live tests are `engine/__tests__/vsm/{algedonicLive,predictionsLive,s4Live,snapshotLive}.test.ts`. Their harness helpers are copies; the ONLY behavioral divergence is mockProvider exhaustion: algedonicLive silently ends the stream (`if (gen) yield* gen()`), the other three throw `mock provider script exhausted`.
- algedonicLive Test A uses an inline provider with its own `callCount` variable and asserts `callCount <= 8` — the shared mockProvider must expose a `callCount()` accessor.
- `MALFORMED_KEY = '__malformed'` (engine/engine/toolCallRepair.ts:14). `repairToolCall('[1,2,3]')` returns `ok:false` deterministically: `JSON.parse` succeeds but the result is an array (not a plain object), and jsonrepair reproduces the same array → error `arguments must be a JSON object, got array`. callModel.ts:530 then sets `input = { __malformed: true, raw, error }` on the block. So a scripted tool_use whose `input_json_delta.partial_json` is the literal string `[1,2,3]` exercises the REAL repair ladder (not a pre-marked input).
- conversationLoop.ts:2402-2432: `isMalformedInput` → first offense emits `{ type: 'toolcall.transport', stage: 'retried', toolId, toolName, detail }`, feeds a synthetic error tool result, and the loop continues (the next scripted response is consumed normally). It does NOT call `governance.onToolResult`, so it cannot contribute to the algedonic kill-switch streak. Counter resets on healthy parse (:2434) and per user message (:535).
- Every failed tool result emits `AlgedonicFired` with severity `'Warning'` (cyberneticsGovernance.ts:290-294), and `getReport().algedonicAlerts` counts all non-Info AlgedonicFired events on the bus (:692-694). So a SINGLE failing Read yields `algedonicAlerts ≥ 1` cumulatively on all later governance.status events — no need to approach the 5-consecutive-failure halt.
- H4 timeline (copied exactly from predictionsLive, which passes): the read-loop gate denies a 3rd same-file Read within one user turn, so 3 consecutive Reads need two user messages. Turn numbering: user turn 1 = turns 1-3 (Read, Read, done-text), user turn 2 = turns 4-7 (Read → consecutiveReads=3; Edit at turn 5 → H4 OPENS, window 2, due turn 7; Read at turn 6; done-text at turn 7 → H4 EVALUATES).
- Snapshot: one approved Write fires the after-batch snapshot → `snapshot.taken` event → `turn.snapshot` in the collector (snapshotLive proves this; requires `cwd: tempDir` in the constructor AND `loop.setCwd(tempDir)`).
- S4: `loop.getGovernance().getReflector().setFrequency(3)` → reflection fires at iteration 3 via sideQuery, which calls global `fetch` on `/api/chat` (bypasses the mock provider) — must be stubbed. S2 polls `/api/ps`. Any other URL must throw loudly.
- Ledger: `createMissionCollector(now)` ingests protocol events; `governance.status` → one entry in `collector.turns` per loop iteration; `toolcall.transport` → `collector.toolTransport` entries `{t, stage, toolName, detail}`. `buildMissionRecord(collector, meta)` (scripts/cynco-ledger.mjs:103) wraps them into the mission-record schema. Both are exported.
- Standard per-test hygiene (all four live tests do this; the new one must too): `delete process.env._ABLATION_VSM_DISABLED`, `resetEventBus()`, `globalContract.clear()`, `globalContract.setEnforcementEnabled(false)`, temp-dir cwd (P1.4 — never let initSnapshot stage the repo root), `fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })` in afterEach.
- Baselines that must not change: un-gated `npx vitest run` = 1882 passed / 32 skipped (Task 1 must keep exactly this; Task 2 adds 1 skipped → 1882 / 33). Gated run of the live files = 8 passed (Task 2 makes it 9).
- Run tests from repo root only (`C:\Users\civer\localcode`). Git commands from repo root only (embedded git repos in engine/ and tui/). Verify branch `phase1-exit-gate` before every commit.

---

### Task 1: Extract shared live-test harness

**Files:**
- Create: `engine/__tests__/harness/liveHarness.ts`
- Modify: `engine/__tests__/vsm/algedonicLive.test.ts`
- Modify: `engine/__tests__/vsm/predictionsLive.test.ts`
- Modify: `engine/__tests__/vsm/s4Live.test.ts`
- Modify: `engine/__tests__/vsm/snapshotLive.test.ts`

This is a pure refactor: NO test behavior may change. Both suite counts must be identical before/after.

- [ ] **Step 1: Create the harness module**

Write `engine/__tests__/harness/liveHarness.ts` with exactly this content:

```typescript
/**
 * Shared harness for gated live-wiring tests (CYNCO_INTEGRATION=1).
 *
 * Extracted from the four Phase 1 live tests (algedonicLive, predictionsLive,
 * s4Live, snapshotLive), which each carried an identical copy. NOT named
 * *.test.ts on purpose — vitest.config.ts collects engine/__tests__/**\/*.test.ts.
 */
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

export function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — the routing
    // pre-call would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume the mock provider's
    // scripted responses before the main loop runs.
    noScouts: true,
    approveAll: true,
  }
}

export function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

export type ScriptedProvider = Provider & { callCount(): number }

/**
 * Provider that replays a scripted response per model call.
 * Default: throws on script exhaustion — misalignment must be loud.
 * `lenient: true`: yields an empty stream instead (algedonicLive Test A relies
 * on this — the halt path stops consuming mid-script).
 */
export function mockProvider(
  responses: Array<() => Generator<StreamEvent>>,
  opts: { lenient?: boolean } = {},
): ScriptedProvider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      if (!gen) {
        if (opts.lenient) return
        throw new Error(`mock provider script exhausted at call ${callIdx}`)
      }
      yield* gen()
    },
    callCount() { return callIdx },
  }
}

export function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

/**
 * Tool call whose arguments arrive as a RAW partial_json string — callModel's
 * repair ladder (JSON.parse → jsonrepair → malformed marker) sees exactly this
 * text. Pass deliberately unparseable-as-object payloads (e.g. '[1,2,3]') to
 * exercise the P1.8 malformed path end-to-end.
 */
export function* rawToolCall(i: number, name: string, partialJson: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: `m${i}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${i}`, name, input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

export function* toolCall(i: number, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield* rawToolCall(i, name, JSON.stringify(input))
}
```

- [ ] **Step 2: Refactor `algedonicLive.test.ts`**

Delete its local `defaultConfig`, `defaultCapabilities`, `mockProvider`, `textResponse`, and `failingRead` definitions (lines ~21-85 in the current file). Add after the existing type imports:

```typescript
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'
```

Replace every `failingRead(N)` call with:

```typescript
toolCall(N, 'Read', { file_path: `C:/nonexistent-algedonic-${N}.txt` })
```

(The stream shapes are identical — failingRead was toolCall with a hardcoded nonexistent path.)

In Test A, delete the inline `provider` object and the `let callCount = 0` variable; replace with:

```typescript
const provider = mockProvider(responses, { lenient: true })
```

and change the final assertion from `expect(callCount).toBeLessThanOrEqual(8)` to:

```typescript
expect(provider.callCount()).toBeLessThanOrEqual(8)
```

Remove now-unused imports: `Provider`, `ModelCapabilities`, `CompletionRequest`, and `LocalCodeConfig` type imports if nothing else in the file uses them (`StreamEvent` is still used by the `responses` array type annotations — keep it). Layer 1 (un-gated governance-level) tests are untouched.

- [ ] **Step 3: Refactor `predictionsLive.test.ts`, `s4Live.test.ts`, `snapshotLive.test.ts`**

In each: delete the local `defaultConfig`, `defaultCapabilities`, `mockProvider`, `textResponse`, `toolCall` definitions (the "Harness helpers" section) and add:

```typescript
import { defaultConfig, mockProvider, textResponse, toolCall } from '../harness/liveHarness.js'
```

Remove now-unused type imports (`Provider`, `ModelCapabilities`, `CompletionRequest`, `LocalCodeConfig`) — keep `StreamEvent` (used in `responses` annotations). No other line changes.

- [ ] **Step 4: Run the gated live tests — all must pass**

From repo root:

```bash
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts > /tmp/gated.log 2>&1; tail -20 /tmp/gated.log
```

Expected: 8 passed (5 algedonic incl. 3 un-gated layer-1, 1 predictions, 1 s4, 1 snapshot), 0 failed.

- [ ] **Step 5: Run the full un-gated suite — counts must be UNCHANGED**

```bash
npx vitest run > /tmp/vitest.log 2>&1; tail -15 /tmp/vitest.log
```

Expected: **1882 passed / 32 skipped** — exactly the pre-refactor baseline. Any drift = the refactor changed behavior; fix before committing.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print: phase1-exit-gate
git add engine/__tests__/harness/liveHarness.ts engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts
git commit -m "refactor: extract shared gated-live-test harness into engine/__tests__/harness/liveHarness.ts"
```

---

### Task 2: Phase 1 exit-gate test — one scripted 12-turn session

**Files:**
- Create: `engine/__tests__/vsm/phase1Exit.test.ts`

- [ ] **Step 1: Write the gated test**

Create `engine/__tests__/vsm/phase1Exit.test.ts` with exactly this content:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
// @ts-ignore — untyped harness module
import { createMissionCollector, buildMissionRecord } from '../../../scripts/cynco-ledger.mjs'
import { defaultConfig, mockProvider, textResponse, toolCall, rawToolCall } from '../harness/liveHarness.js'
import type { StreamEvent } from '../../types.js'

// ── Gate ─────────────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/phase1Exit.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

// ── Phase 1 exit criterion (STATE-AND-VISION-2026-07-12.md, Phase 1 Exit) ────
// "a scripted 12-turn test session produces a ledger record containing:
//  ≥1 algedonic signal, ≥1 opened-and-evaluated prediction, persisted S4
//  scores, ≥1 snapshot hash, windowed-variety series, heterarchy context
//  series; plus a tool-call transport test where a deliberately malformed
//  call is repaired or retried, never silently discarded."
// The four per-item live tests prove each nerve separately; this test proves
// they coexist in ONE session and land in ONE buildMissionRecord() record.

describe('Phase 1 exit gate — combined scripted session (gated: CYNCO_INTEGRATION=1)', () => {
  let tempDir = ''
  let tempFile = ''
  let outFile = ''

  beforeEach(() => {
    // Ablation env var must be absent so CyberneticsGovernance activates.
    delete process.env._ABLATION_VSM_DISABLED
    // Fresh event bus per test — the singleton accumulates otherwise.
    resetEventBus()
    // Reset the global contract singleton: auto-created "pending" assertions
    // can never be satisfied by the mock provider and would block end_turn.
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)

    // Real temp file so scripted Reads SUCCEED (5 consecutive failures would
    // halt the loop). Own temp DIR as loop cwd so the constructor's
    // initSnapshot never stages the repo root (P1.4 fix).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-phase1-exit-'))
    tempFile = path.join(tempDir, 'exit-target.txt')
    outFile = path.join(tempDir, 'exit-output.txt')
    fs.writeFileSync(tempFile, 'hello phase 1 exit gate\nsecond line for good measure\n')

    // Loud URL-guard fetch stub: the S4 sideQuery calls Ollama /api/chat
    // directly (bypassing the mock provider); S2 polls /api/ps. Anything else
    // must fail loudly, not pass vacuously.
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url)
      if (u.includes('/api/chat')) {
        return new Response(
          JSON.stringify({
            message: { content: 'Progress: 7\nConfidence: 6\nTool Quality: 8\nStuckness: 2' },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/api/ps')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      throw new Error(`phase1Exit fetch stub intercepted unexpected URL: ${u}`)
    })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
    vi.unstubAllGlobals()
  })

  it.skipIf(SKIP)('one 12-turn session lands all six signals plus a retried malformed call in a single mission record', async () => {
    // Dynamically import to avoid blowing up the un-gated suite.
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const filePath = tempFile.replace(/\\/g, '/')
    const outPath = outFile.replace(/\\/g, '/')
    const missingPath = `${tempDir.replace(/\\/g, '/')}/nonexistent-exit.txt`
    const events: any[] = []

    // Timeline (turn = governance turnCount, increments at each message_stop;
    // S4 reflector frequency set to 3 below):
    //
    //   User turn 1 ("read that file..."):
    //     t1: Read tempFile            → consecutiveReads=1
    //     t2: Read tempFile (warn)     → consecutiveReads=2 (gate denies a 3rd
    //         same-file Read within one user turn — predictionsLive timeline)
    //     t3: done-text; S4 REFLECTION fires at iteration 3 (freq 3) via the
    //         stubbed fetch → scores persist into governance.status
    //   User turn 2 ("read once more then edit") — gate reset, counter persists:
    //     t4: Read tempFile            → consecutiveReads=3
    //     t5: Edit tempFile            → H4 OPENS (trigger=5, window=2, due t7)
    //     t6: Read tempFile            → keeps loop alive, H4 still open
    //     t7: done-text               → evaluateOpen COMPLETES H4
    //   User turn 3 ("write the summary; check the other file"):
    //     t8: Write outFile            → after-batch snapshot → snapshot.taken
    //     t9: Read missingPath FAILS   → AlgedonicFired severity=Warning
    //         (streak=1 — nowhere near the 5-failure halt)
    //     t10: Read with raw args '[1,2,3]' — valid JSON but not an object, so
    //          JSON.parse AND jsonrepair both reject it → callModel marks the
    //          block __malformed → conversationLoop emits toolcall.transport
    //          stage 'retried' and feeds an error-feedback tool result
    //     t11: done-text (the "re-issued" call after the retry feedback)
    //   User turn 4 ("confirm complete"):
    //     t12: done-text               → 12-turn session
    // Spare done-texts follow in case governance nudges add extra model calls.
    const doneText = 'task complete — everything requested has been read, edited, and written; all done.'
    const responses: Array<() => Generator<StreamEvent>> = [
      // user turn 1
      () => toolCall(1, 'Read', { file_path: filePath }),
      () => toolCall(2, 'Read', { file_path: filePath }),
      () => textResponse(doneText),
      // user turn 2
      () => toolCall(3, 'Read', { file_path: filePath }),
      () => toolCall(4, 'Edit', { file_path: filePath, old_string: 'hello', new_string: 'hola' }),
      () => toolCall(5, 'Read', { file_path: filePath }),
      () => textResponse(doneText),
      // user turn 3
      () => toolCall(6, 'Write', { file_path: outPath, content: 'summary of findings\n' }),
      () => toolCall(7, 'Read', { file_path: missingPath }),
      () => rawToolCall(8, 'Read', '[1,2,3]'),
      () => textResponse(doneText),
      // user turn 4
      () => textResponse(doneText),
      // spares (nudges/context checks may consume extra scripted responses)
      () => textResponse(doneText),
      () => textResponse(doneText),
      () => textResponse(doneText),
    ]

    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      cwd: tempDir,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })
    // Production re-root path (main.ts user.message handler) — snapshot,
    // executor, and LSP all point at the temp project dir.
    loop.setCwd(tempDir)
    // Minimum reflector frequency so S4 fires within the session.
    loop.getGovernance().getReflector().setFrequency(3)

    await loop.handleUserMessage('please read that file and report what you find')
    await loop.handleUserMessage('read it once more then edit it')
    await loop.handleUserMessage('now write the summary to the output file and check the other one')
    await loop.handleUserMessage('confirm the task is complete')

    // The session must never halt — the single deliberate failure and the
    // malformed call are both below every kill-switch threshold.
    const halted = events.filter((e: any) => e.type === 'message.complete' && e.stopReason === 'halted')
    expect(halted.length).toBe(0)

    // The Write actually landed (the snapshot hash is of a real change).
    expect(fs.readFileSync(outFile, 'utf8')).toBe('summary of findings\n')

    // ── Build the ONE ledger record the exit criterion demands ──────────────
    const collector = createMissionCollector(() => 1000)
    for (const e of events) collector.ingest(e)
    const record = buildMissionRecord(collector, {
      missionId: 'phase1-exit-gate',
      briefFile: null,
      marker: null,
      cwd: tempDir,
      dispatchedAt: 0,
      durationS: 0,
      outcome: 'landed',
    })

    expect(record.turns.length).toBeGreaterThanOrEqual(6) // a real series, not a point
    const lastTurn = record.turns[record.turns.length - 1]

    // 1. ≥1 algedonic signal (cumulative non-Info AlgedonicFired count).
    expect(lastTurn.algedonicAlerts).toBeGreaterThanOrEqual(1)

    // 2. ≥1 opened-and-evaluated prediction — H4 specifically, so an unrelated
    //    hypothesis completing cannot mask an H4 miss.
    expect(lastTurn.predictions.completed).toBeGreaterThanOrEqual(1)
    expect(lastTurn.predictions.stats.some((s: any) => s.hypothesis === 'H4' && s.total >= 1)).toBe(true)

    // 3. Persisted S4 scores (freq-3 reflection through the stubbed sideQuery).
    const s4Turn = record.turns.find((t: any) => t.s4 && t.s4.scores)
    expect(s4Turn).toBeDefined()
    expect(s4Turn.s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })

    // 4. ≥1 snapshot hash (after-batch snapshot of the Write).
    expect(record.turns.some((t: any) => t.snapshot && typeof t.snapshot.hash === 'string')).toBe(true)

    // 5. Windowed-variety series — every turn record carries the number.
    for (const t of record.turns) expect(typeof t.varietyWindowed).toBe('number')

    // 6. Heterarchy context series — every turn record carries the snapshot.
    for (const t of record.turns) {
      expect(typeof t.heterarchy?.context).toBe('string')
      expect(typeof t.heterarchy?.commander).toBe('string')
      expect(typeof t.heterarchy?.shifted).toBe('boolean')
    }

    // 7. Transport: the deliberately malformed call was RETRIED — surfaced to
    //    the ledger, never silently discarded, and never escalated to discard
    //    (a single malformed call is within the one-bounded-retry budget).
    expect(record.toolTransport.some((x: any) => x.stage === 'retried' && x.toolName === 'Read')).toBe(true)
    expect(record.toolTransport.some((x: any) => x.stage === 'discarded')).toBe(false)
  }, 60000)
})
```

- [ ] **Step 2: Run the new gated test — must pass**

```bash
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/phase1Exit.test.ts > /tmp/exit.log 2>&1; tail -30 /tmp/exit.log
```

Expected: 1 passed. If it fails, read the failure — likely causes and fixes:
- `halted.length` not 0 → a scripted Read is failing; check temp-file path slashes.
- `predictions.completed` = 0 → turn numbering drifted from the predictionsLive timeline; compare governance.status turn sequence against the timeline comment (do NOT change trigger/window constants — fix the script).
- `toolTransport` empty → the rawToolCall payload was repaired instead of marked; it must be exactly `[1,2,3]` (an array — objects get repaired).
- Script exhausted error → nudges consumed spares; add more spare done-texts.

- [ ] **Step 3: Run the full un-gated suite**

```bash
npx vitest run > /tmp/vitest2.log 2>&1; tail -15 /tmp/vitest2.log
```

Expected: **1882 passed / 33 skipped** (the new gated test adds exactly one skip when un-gated).

- [ ] **Step 4: Run all five gated live files together**

```bash
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts engine/__tests__/vsm/phase1Exit.test.ts > /tmp/gated2.log 2>&1; tail -20 /tmp/gated2.log
```

Expected: **9 passed** (8 prior + phase1Exit), 0 failed.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: phase1-exit-gate
git add engine/__tests__/vsm/phase1Exit.test.ts
git commit -m "test: Phase 1 exit gate — one scripted 12-turn session proves all six ledger signals + retried malformed tool call (phase1Exit.test.ts)"
```

---

### Task 3: STATE doc — mark the Phase 1 exit criterion satisfied

**Files:**
- Modify: `docs/STATE-AND-VISION-2026-07-12.md:290`

- [ ] **Step 1: Amend the Exit line**

Line 290 currently begins:

```
**Exit (falsifiable):** a scripted 12-turn test session produces a ledger record containing: ...
```

Change the line's opening to `**Exit (falsifiable):** ✅ **(satisfied 2026-07-13)** a scripted 12-turn...` and append this sentence at the very end of the same line (after "...never `bun test` on Windows)."):

```
 Satisfied by `engine/__tests__/vsm/phase1Exit.test.ts` (gated `CYNCO_INTEGRATION=1`): one scripted 12-turn session through a real ConversationLoop lands all six signals in a single `buildMissionRecord()` record, and a genuinely malformed `[1,2,3]` args payload traverses the real callModel repair ladder to a `retried` (never `discarded`) `toolTransport` entry; shared harness extracted to `engine/__tests__/harness/liveHarness.ts`.
```

- [ ] **Step 2: Commit**

```bash
git branch --show-current   # must print: phase1-exit-gate
git add docs/STATE-AND-VISION-2026-07-12.md
git commit -m "docs: Phase 1 exit criterion satisfied — phase1Exit.test.ts combined session proof"
```

---

### Task 4: BLOCKING wire check

Nothing ships until every step here passes. No production code changed in this plan, so the wire check centers on the harness actually being consumed and baselines holding.

- [ ] **Step 1: Grep — harness is imported by all five live tests**

```bash
grep -l "harness/liveHarness.js" engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts engine/__tests__/vsm/phase1Exit.test.ts
```

Expected: all five paths printed.

- [ ] **Step 2: Grep — no duplicate harness copies survive**

```bash
grep -n "function defaultConfig\|function mockProvider\|function defaultCapabilities" engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts engine/__tests__/vsm/phase1Exit.test.ts
```

Expected: no output (exit code 1).

- [ ] **Step 3: Grep — every new harness export is consumed**

```bash
grep -rn "rawToolCall\|buildMissionRecord\|callCount()" engine/__tests__/vsm/*.test.ts
```

Expected: `rawToolCall` and `buildMissionRecord` used in phase1Exit.test.ts; `callCount()` used in algedonicLive.test.ts.

- [ ] **Step 4: Full suites green at expected counts (repo root)**

```bash
npx vitest run > /tmp/wire-vitest.log 2>&1; tail -15 /tmp/wire-vitest.log
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/algedonicLive.test.ts engine/__tests__/vsm/predictionsLive.test.ts engine/__tests__/vsm/s4Live.test.ts engine/__tests__/vsm/snapshotLive.test.ts engine/__tests__/vsm/phase1Exit.test.ts > /tmp/wire-gated.log 2>&1; tail -20 /tmp/wire-gated.log
```

Expected: un-gated **1882 passed / 33 skipped**; gated **9 passed / 0 failed**. (TUI suite untouched by this plan — no TUI files modified.)

- [ ] **Step 5: Ship (git-web-flow)**

```bash
git branch --show-current   # must print: phase1-exit-gate
git push -u origin phase1-exit-gate
gh pr create --title "Phase 1 exit gate: combined 12-turn session test + shared live-test harness" --body "..."
# merge on GitHub, then:
git checkout main && git pull
```
