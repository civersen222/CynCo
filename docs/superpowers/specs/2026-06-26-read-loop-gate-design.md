# Read-Loop Gate — Design

**Date:** 2026-06-26
**Branch:** liveness-layer (work to be done on a fresh branch)
**Status:** Approved design, ready for implementation plan

## Problem

An instrumented single-run trace (`_TRACE_STEERING=1`, pinned `city-yield-consumers`
rep, log `benchmark/true/results/trace-steering-1782502010.log`) proved that the
engine's read-loop interventions fire relentlessly but never change behavior. Over
74 iterations the model's cumulative reads climbed 0 → 35 while writes stayed at 0
until iter 71. Context bloated 436 → ~20,900 approx-tokens. The readLoop steer was
injected on essentially every model call from iter 7 onward and was ignored every
time. The single edit attempt (iter 71) tripped the grounding gate correctly, then
the model returned to reading. The 900s timeout — not the gate or the steers —
decided the score.

Four root causes were identified:

1. **The readLoop steer is soft and non-escalating** (`conversationLoop.ts:2196`):
   identical polite text every time, no teeth.
2. **Each steer injection feeds the timeout it tries to prevent**: a steer drains at
   the loop top and does `continue`, burning an iteration with no model call AND
   appending to context — accelerating the context bloat whose exhaustion causes the
   timeout.
3. **The escalating nudge ladder never escalates during a read-loop**: it only fires
   when the model stops *without* calling tools; while read-looping the model *is*
   calling tools, and `consecutiveNudges` resets to 0 on every tool batch
   (`conversationLoop.ts:2143`).
4. **The contract enforcer's budget is shared with assertions** (`contract.ts:247,282`):
   `ContractAssertPass`/`Fail` each increment `enforcementRounds` (capped at 5), so
   normal task-progress marking burns the enforcer's re-prompt budget before it can
   push back.

## Goal

Make read-loop intervention actually change behavior: detect *pathological* reading
(not healthy exploration) and deny the read at the point of execution, forcing the
model to act or stop — without adding context cost. Fix the contract-budget bug that
silently disarms the enforcer.

## Non-Goals

- No change to the grounding gate (under separate investigation on another branch).
- No generic tool-guard middleware refactor (YAGNI for a two-guard system).
- No change to the escalating nudge ladder itself (it works for its own trigger:
  model stops without tools).

## Approach

A dedicated `ReadLoopGate` module, instantiated once per `ConversationLoop`, wired
into the tool executor (`executeOneTool`) at the same slot the existing
`allowedTools` and grounding gates use. It denies a read by returning an `is_error`
tool_result with a directive and **no file payload** — mirroring the proven deny
pattern at `conversationLoop.ts:2294` and `:2446`. The soft steer at
`conversationLoop.ts:2196–2202` is deleted; its job moves earlier, with teeth, and
without burning a model round-trip.

Two detectors share one warn-once-then-deny state machine:

- **Redundancy** (primary): re-reading an already-seen file, or repeating an
  identical Grep/Glob/Ls. This is the common pathology from the trace.
- **Stall** (high-threshold backstop): `STALL_CAP = 20` distinct reads since the last
  write. Closes the rare "infinite *distinct* reads" hole. Framed as "reads since
  last write" so any interleaved write resets it and read-then-write tasks never trip.

Both detectors give one warning before denying, reset on a successful write, and use
independent warn flags so a redundancy warning does not consume the stall free-pass.

## Components

### `engine/vsm/readLoopGate.ts` (new)

```ts
export type ReadLoopVerdict =
  | { kind: 'allow' }
  | { kind: 'warn'; message: string }
  | { kind: 'deny'; message: string }

export class ReadLoopGate {
  private seen = new Set<string>()       // read signatures already executed
  private warnedRedundant = false        // redundancy free-pass spent?
  private redundancyArmed = false        // a redundant read happened, no write since
  private warnedStall = false            // stall free-pass spent?
  private readsSinceWrite = 0

  evaluate(toolName: string, input: any): ReadLoopVerdict
  onWrite(): void
  reset(): void
}
```

`STALL_CAP = 20` (module constant).

### Signatures

```ts
function signature(toolName: string, input: any): string | null {
  switch (toolName) {
    case 'Read':  return input.file_path ? `read:${normalize(input.file_path)}` : null
    case 'Grep':  return `grep:${input.pattern ?? ''}|${normalize(input.path ?? '.')}|${input.glob ?? ''}`
    case 'Glob':  return `glob:${input.pattern ?? ''}|${normalize(input.path ?? '.')}`
    case 'Ls':    return `ls:${normalize(input.path ?? '.')}`
    default:      return null   // not a read tool → evaluate() returns allow
  }
}
```

`normalize` = `path.resolve`, lowercased on win32, so `./foo` and `foo` collapse.
A different offset/limit re-read of the **same** `Read` file path still counts as
redundant — re-reading the same file is exactly the trace pathology and the content
is already in context.

### State machine (`evaluate`)

```
sig = signature(toolName, input)
if sig == null:                      return { kind: 'allow' }     # non-read tool
readsSinceWrite += 1
if sig in seen:                                                    # REDUNDANT
    if not warnedRedundant:
        warnedRedundant = true
        redundancyArmed = true
        return { kind: 'warn', message: REDUNDANCY_WARN }          # one free pass
    return { kind: 'deny', message: REDUNDANCY_DENY }              # teeth
else:                                                              # NEW read
    seen.add(sig)
    if readsSinceWrite >= STALL_CAP:
        if not warnedStall:
            warnedStall = true
            return { kind: 'warn', message: STALL_WARN }
        return { kind: 'deny', message: STALL_DENY }
    return { kind: 'allow' }
```

`onWrite()`: `readsSinceWrite = 0; warnedRedundant = false; redundancyArmed = false;
warnedStall = false`.
`reset()`: clears `seen` and all of the above.

### Messages

- `REDUNDANCY_WARN` (non-error, prepended to the real result):
  `"[read-loop] You already read <target> this session. Re-reading the same source
  rarely surfaces new information. If you have what you need, make an edit now."`
- `REDUNDANCY_DENY` (is_error, directive only — no file payload):
  `"[read-loop] DENIED: you are re-reading sources you've already seen without making
  any change. You must now either (a) call Write/Edit/MultiEdit to act on what you've
  learned, or (b) end your turn if the task is genuinely complete. Reading is disabled
  until you make an edit."`
- `STALL_WARN` (non-error, prepended):
  `"[read-loop] <N> reads since your last edit. Consider whether you have enough to
  start implementing — use Write or Edit."`
- `STALL_DENY` (is_error, directive only):
  `"[read-loop] DENIED: <N> reads since your last edit with no change made. Make an
  edit now, or end your turn if complete."`

(The `<target>` and `<N>` are filled at message-build time; `evaluate` returns the
finished string.)

## Wiring (`engine/bridge/conversationLoop.ts`)

1. **Field + reset.** Add `private readLoopGate = new ReadLoopGate()`. Call
   `this.readLoopGate.reset()` in the conversation reset paths near lines 477 and 508
   (where `consecutiveNudges = 0`).

2. **Gate call in `executeOneTool`.** Insert after the existing
   `allowedTools`/`offeredToolNames` deny blocks (after ~line 2331), before dispatch:

   ```ts
   const verdict = this.readLoopGate.evaluate(toolName, toolInput)
   if (verdict.kind === 'deny') {
     console.log(`[read-loop] DENIED ${toolName}`)
     if (process.env._TRACE_STEERING === '1') this.traceLastInjected = 'readLoopGate-deny'
     this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
     this.emit({ type: 'tool.complete', toolId, toolName, result: verdict.message, isError: true })
     toolResults.push({ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: verdict.message }], is_error: true })
     toolsUsedThisTurn.push(toolName); toolResultsThisTurn.push('denied'); toolsUsedInSession.push(toolName)
     return   // read never executes: no file payload appended (bloat fix)
   }
   const readLoopWarn = verdict.kind === 'warn' ? verdict.message : null
   ```

   In the `warn` case the tool runs normally; `readLoopWarn` is prepended to the
   success `tool_result` text (one extra line, non-error).

3. **`onWrite()` reset.** After a write tool (`Write`/`Edit`/`MultiEdit`/`ApplyPatch`)
   completes with a `'success'` result, call `this.readLoopGate.onWrite()`.

4. **Delete the soft steer.** Remove the `inReadLoop` steer block at lines 2196–2202.

## Contract-budget fix (`engine/tools/contract.ts`)

Delete `globalContract.enforcementRounds += 1` from `contractAssertPass.execute`
(line 247) and `contractAssertFail.execute` (line 282). `enforcementRounds` is then
incremented only at the genuine enforcer site (`conversationLoop.ts:2020`), so all 5
re-prompts remain available regardless of how many assertions the model marks. Only
`create()` (resets to 0 per rep) and the enforcer block otherwise touch the counter,
so the change is self-contained.

## Testing (TDD)

### Unit — `engine/vsm/readLoopGate.test.ts`
- 10 distinct reads → all `allow`.
- Re-read same file: 1st redundant → `warn`, 2nd redundant (no write between) → `deny`.
- `Grep` signature: identical pattern+path → redundant; different pattern → new.
- `onWrite()` re-arms: redundant → warn → `onWrite()` → redundant → warn (not deny).
- Path normalization: `./foo.ts` and absolute `foo.ts` collapse to one signature.
- Stall: 20 distinct reads, 0 writes → 21st distinct → `deny`; a write at read 10
  resets so 20 more distinct reads are needed before stall.
- Independent flags: a redundancy warn does not consume the stall free-pass.
- Non-read tools (`Bash`, `Write`) → always `allow`.

### Contract regression — `engine/tools/contract.test.ts`
- Create contract; call `ContractAssertPass` 5×; assert `enforcementRounds === 0`.

### Integration smoke — trace harness
- Re-run the pinned `city-yield-consumers` rep with `_TRACE_STEERING=1`; assert from
  the log that (a) a `[read-loop] DENIED` line appears, and (b) `writes` reaches ≥1
  earlier than iter 71 (gate forces an edit attempt sooner than the un-gated
  baseline). Falsifiable behavior-change check, directly comparable to
  `trace-steering-1782502010.log`.

### Wire-check (standing rule)
Final grep proving every new symbol is imported and called: `ReadLoopGate`,
`readLoopGate` field, `evaluate`, `onWrite`, `reset` in `conversationLoop.ts`; soft
steer block confirmed deleted; both `enforcementRounds += 1` confirmed gone.

## Known Limitation

Redundancy-only would miss a model that alternates forever among never-before-seen
reads; the stall backstop (`STALL_CAP = 20` reads since last write) covers that case.
A legitimately exploration-heavy task that needs 20+ distinct reads before its first
edit will get one stall warning (not an instant wall) and, on the next read, a deny
whose escape is "end your turn if complete." `STALL_CAP = 20` is set conservatively
high (trace hit 33/0) to keep this rare.
