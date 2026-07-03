# Read-Loop Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make read-loop intervention actually change behavior by denying redundant/stalled reads at the executor, and fix the contract enforcer budget being burned by assertion marking.

**Architecture:** A new `ReadLoopGate` class (one per `ConversationLoop`) tracks read signatures and reads-since-write. It is consulted in `executeOneTool` before a read dispatches; a redundant read (re-read of an already-seen file/Grep) or a stall (20+ distinct reads with no write) gets one warning, then a hard `is_error` deny with no file payload. The soft non-escalating steer is deleted; the contract budget bug is fixed by removing two stray increments.

**Tech Stack:** TypeScript (Bun runtime), `bun:test` for unit tests, vitest as the package test runner. Backend for the integration smoke test: qwen3.6-27b-q6k via llama-cpp.

**Spec:** `docs/superpowers/specs/2026-06-26-read-loop-gate-design.md`

> **IMPORTANT — line numbers drift.** All `file:line` references are from the pre-implementation state and will shift as earlier tasks edit `conversationLoop.ts`. Always locate the insertion point by the quoted **anchor text**, not the line number.

---

## File Structure

- **Create** `engine/vsm/readLoopGate.ts` — the gate: signatures, warn-once-then-deny state machine, `evaluate`/`onWrite`/`reset`. One responsibility, no engine dependencies.
- **Create** `engine/vsm/readLoopGate.test.ts` — unit tests for the gate (`bun:test`).
- **Create** `engine/tools/contract.test.ts` — regression test that marking assertions no longer burns the enforcer budget (`bun:test`).
- **Modify** `engine/bridge/conversationLoop.ts` — instantiate + reset the gate, call it in `executeOneTool`, call `onWrite()` after successful writes, prepend warn text, delete the soft steer block.
- **Modify** `engine/tools/contract.ts` — delete the two `enforcementRounds += 1` lines.
- **Already-modified (uncommitted), committed in Task 0** `engine/bridge/conversationLoop.ts` + `benchmark/true/grounding/abRun.ts` — the `_TRACE_STEERING`/`_PIN_GROUNDING` diagnostic instrumentation the integration smoke test depends on.

---

### Task 0: Commit the trace instrumentation (prerequisite)

The repo has uncommitted `_TRACE_STEERING=1` (per-model-call trace line) and `_PIN_GROUNDING=1` (A/B pin) instrumentation. Task 7's integration smoke test depends on `_TRACE_STEERING`. Commit it first so the working tree is clean before new work.

**Files:**
- Modify (already edited, just commit): `engine/bridge/conversationLoop.ts`, `benchmark/true/grounding/abRun.ts`

- [ ] **Step 1: Confirm the diff is only the instrumentation**

Run: `git diff --stat engine/bridge/conversationLoop.ts benchmark/true/grounding/abRun.ts`
Expected: two files changed; conversationLoop ~29 insertions (the `traceLastInjected` field, the `[trace]` block, the three `traceLastInjected` assignments, the `_PIN_GROUNDING` condition), abRun ~21 changed (pin toggle + PINNED banner + output filename).

- [ ] **Step 2: Commit only those two files**

```bash
git add engine/bridge/conversationLoop.ts benchmark/true/grounding/abRun.ts
git commit -m "feat: _TRACE_STEERING + _PIN_GROUNDING diagnostic instrumentation

_TRACE_STEERING=1 emits one [trace] line per model call (context size,
read/write split, injected intervention source) for exploration-efficiency
analysis. _PIN_GROUNDING=1 pins the grounding gate's firing side armed,
bypassing the self-tuning back-off, for A/B isolation."
```

- [ ] **Step 3: Verify the working tree is clean of source changes**

Run: `git status --short -- engine benchmark/true/grounding`
Expected: no `M` lines for those paths (untracked `??` result logs may remain — leave them).

---

### Task 1: ReadLoopGate signatures + redundancy (warn-once-then-deny)

Create the gate with signature computation and the redundancy path only. Stall path is added in Task 2.

**Files:**
- Create: `engine/vsm/readLoopGate.ts`
- Test: `engine/vsm/readLoopGate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/vsm/readLoopGate.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { ReadLoopGate } from './readLoopGate.js'

describe('ReadLoopGate — redundancy', () => {
  let gate: ReadLoopGate
  beforeEach(() => { gate = new ReadLoopGate() })

  test('distinct reads always allow', () => {
    for (let n = 0; n < 10; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/file${n}.ts` }).kind).toBe('allow')
    }
  })

  test('re-reading the same file warns once then denies', () => {
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('allow')
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn')
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('deny')
  })

  test('Grep signature: same pattern+path redundant, different pattern new', () => {
    expect(gate.evaluate('Grep', { pattern: 'foo', path: '/a' }).kind).toBe('allow')
    expect(gate.evaluate('Grep', { pattern: 'foo', path: '/a' }).kind).toBe('warn')
    expect(gate.evaluate('Grep', { pattern: 'bar', path: '/a' }).kind).toBe('allow')
  })

  test('onWrite re-arms the redundancy free pass', () => {
    gate.evaluate('Read', { file_path: '/a/x.ts' })          // allow (seen)
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn')
    gate.onWrite()
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn') // not deny
  })

  test('path normalization collapses ./foo and absolute foo', () => {
    const rel = gate.evaluate('Read', { file_path: './foo.ts' })
    expect(rel.kind).toBe('allow')
    const abs = gate.evaluate('Read', { file_path: `${process.cwd()}/foo.ts` })
    expect(abs.kind).toBe('warn') // same resolved path → redundant
  })

  test('non-read tools always allow', () => {
    expect(gate.evaluate('Bash', { command: 'ls' }).kind).toBe('allow')
    expect(gate.evaluate('Write', { file_path: '/a/x.ts' }).kind).toBe('allow')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test engine/vsm/readLoopGate.test.ts`
Expected: FAIL — `Cannot find module './readLoopGate.js'` (module does not exist yet).

- [ ] **Step 3: Implement the gate (redundancy only)**

Create `engine/vsm/readLoopGate.ts`:

```ts
import { resolve } from 'node:path'

export type ReadLoopVerdict =
  | { kind: 'allow' }
  | { kind: 'warn'; message: string }
  | { kind: 'deny'; message: string }

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Ls'])

function norm(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function signature(toolName: string, input: any): string | null {
  switch (toolName) {
    case 'Read': return input?.file_path ? `read:${norm(input.file_path)}` : null
    case 'Grep': return `grep:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}|${input?.glob ?? ''}`
    case 'Glob': return `glob:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}`
    case 'Ls':   return `ls:${norm(input?.path ?? '.')}`
    default:     return null
  }
}

function describe(toolName: string, input: any): string {
  switch (toolName) {
    case 'Read': return input?.file_path ?? 'this file'
    case 'Grep': return `Grep "${input?.pattern ?? ''}"`
    case 'Glob': return `Glob "${input?.pattern ?? ''}"`
    case 'Ls':   return `Ls ${input?.path ?? '.'}`
    default:     return 'this read'
  }
}

export class ReadLoopGate {
  private seen = new Set<string>()
  private warnedRedundant = false
  private warnedStall = false
  private readsSinceWrite = 0

  evaluate(toolName: string, input: any): ReadLoopVerdict {
    const sig = signature(toolName, input)
    if (sig === null) return { kind: 'allow' }
    this.readsSinceWrite += 1
    if (this.seen.has(sig)) {
      if (!this.warnedRedundant) {
        this.warnedRedundant = true
        return { kind: 'warn', message: `[read-loop] You already read ${describe(toolName, input)} this session. Re-reading the same source rarely surfaces new information. If you have what you need, make an edit now.` }
      }
      return { kind: 'deny', message: `[read-loop] DENIED: you are re-reading sources you've already seen without making any change. You must now either (a) call Write/Edit/MultiEdit to act on what you've learned, or (b) end your turn if the task is genuinely complete. Reading is disabled until you make an edit.` }
    }
    this.seen.add(sig)
    return { kind: 'allow' }
  }

  onWrite(): void {
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
  }

  reset(): void {
    this.seen.clear()
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
  }
}
```

(`READ_TOOLS` and `warnedStall` are defined now but unused until Task 2; leaving them avoids a second edit to the same lines. `READ_TOOLS` is referenced by the stall logic in Task 2.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test engine/vsm/readLoopGate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/readLoopGate.ts engine/vsm/readLoopGate.test.ts
git commit -m "feat: ReadLoopGate redundancy detection (warn-once-then-deny)"
```

---

### Task 2: Add the stall backstop (STALL_CAP = 20)

**Files:**
- Modify: `engine/vsm/readLoopGate.ts`
- Test: `engine/vsm/readLoopGate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `engine/vsm/readLoopGate.test.ts`:

```ts
describe('ReadLoopGate — stall backstop', () => {
  let gate: ReadLoopGate
  beforeEach(() => { gate = new ReadLoopGate() })

  test('20 distinct reads warns on the 20th, denies on the 21st', () => {
    for (let n = 0; n < 19; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/f${n}.ts` }).kind).toBe('allow')
    }
    expect(gate.evaluate('Read', { file_path: '/a/f19.ts' }).kind).toBe('warn')  // 20th
    expect(gate.evaluate('Read', { file_path: '/a/f20.ts' }).kind).toBe('deny')  // 21st
  })

  test('a write resets the stall counter', () => {
    for (let n = 0; n < 10; n++) gate.evaluate('Read', { file_path: `/a/g${n}.ts` })
    gate.onWrite()
    for (let n = 10; n < 29; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/g${n}.ts` }).kind).toBe('allow')
    }
    expect(gate.evaluate('Read', { file_path: '/a/g29.ts' }).kind).toBe('warn')  // 20th since write
  })

  test('a redundancy warn does not consume the stall free pass', () => {
    gate.evaluate('Read', { file_path: '/a/dup.ts' })                 // allow, seen
    expect(gate.evaluate('Read', { file_path: '/a/dup.ts' }).kind).toBe('warn') // redundancy warn
    // push to 20 distinct reads; the stall path must still get its own warn
    for (let n = 0; n < 17; n++) gate.evaluate('Read', { file_path: `/a/s${n}.ts` })
    // reads so far: dup(1) + dup(2) + 17 = 19 → next distinct is the 20th
    expect(gate.evaluate('Read', { file_path: '/a/s17.ts' }).kind).toBe('warn')  // stall warn
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test engine/vsm/readLoopGate.test.ts`
Expected: FAIL — the two stall tests get `allow` where `warn`/`deny` is expected (stall path not implemented).

- [ ] **Step 3: Add the stall logic**

In `engine/vsm/readLoopGate.ts`, add the constant near the top (after `READ_TOOLS`):

```ts
const STALL_CAP = 20
```

Then in `evaluate`, replace the final `this.seen.add(sig); return { kind: 'allow' }` lines with:

```ts
    this.seen.add(sig)
    if (this.readsSinceWrite >= STALL_CAP) {
      if (!this.warnedStall) {
        this.warnedStall = true
        return { kind: 'warn', message: `[read-loop] ${this.readsSinceWrite} reads since your last edit. Consider whether you have enough to start implementing — use Write or Edit.` }
      }
      return { kind: 'deny', message: `[read-loop] DENIED: ${this.readsSinceWrite} reads since your last edit with no change made. Make an edit now, or end your turn if complete.` }
    }
    return { kind: 'allow' }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test engine/vsm/readLoopGate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/readLoopGate.ts engine/vsm/readLoopGate.test.ts
git commit -m "feat: ReadLoopGate stall backstop (20 reads since last write)"
```

---

### Task 3: Wire the gate into ConversationLoop (field + reset)

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Add the import**

Near the other `vsm` imports (anchor: `import { evaluateGrounding, extractAddedText, extractTargetPaths } from '../vsm/groundingTrigger.js'`), add below it:

```ts
import { ReadLoopGate } from '../vsm/readLoopGate.js'
```

- [ ] **Step 2: Add the field**

Anchor: `private steering = new SteeringQueue()`. Add directly below it:

```ts
  private readLoopGate = new ReadLoopGate()
```

- [ ] **Step 3: Reset on conversation reset (both sites)**

There are two reset sites, each containing the line `this.consecutiveNudges = 0` inside the conversation-reset methods (NOT the two occurrences inside the run loop at the nudge/tool-batch points). Identify them: the two near the top of the class (the reset/clearHistory methods). After the `this.consecutiveNudges = 0` line in EACH of those two methods, add:

```ts
    this.readLoopGate.reset()
```

To disambiguate from the in-loop occurrences: the two correct sites are the ones NOT immediately preceded by nudge/tool-execution logic — they sit among other field re-initializations (e.g. near `this.messages = ...`). Verify with: `grep -n "this.consecutiveNudges = 0" engine/bridge/conversationLoop.ts` — the two lowest line numbers are the reset methods.

- [ ] **Step 4: Type-check compiles**

Run: `bunx tsc --noEmit -p engine 2>&1 | head -20` (or the project's configured type-check). Expected: no new errors referencing `readLoopGate` or `ReadLoopGate`.
If the project has no `tsconfig` at `engine`, run `bun build engine/bridge/conversationLoop.ts --target=bun > /dev/null` and expect no error.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: instantiate + reset ReadLoopGate in ConversationLoop"
```

---

### Task 4: Call the gate in executeOneTool (deny + warn-prepend + onWrite)

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Insert the gate evaluation before the Vibe Guardian block**

Anchor: the comment `// Vibe Guardian: check risk level before execution` inside `executeOneTool` (it follows the `offeredToolNames` deny block that ends with `toolsUsedInSession.push(toolName)\n      return\n    }`). Immediately ABOVE the `// Vibe Guardian` comment, insert:

```ts
    // ─── Read-loop gate ────────────────────────────────────────────
    // Deny redundant / stalled reads at execution time so the model is forced
    // to act or stop, instead of reading itself into the context-bloat timeout.
    const readLoopVerdict = this.readLoopGate.evaluate(toolName, toolInput)
    if (readLoopVerdict.kind === 'deny') {
      console.log(`[read-loop] DENIED ${toolName}`)
      if (process.env._TRACE_STEERING === '1') this.traceLastInjected = 'readLoopGate-deny'
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'tool.complete', toolId, toolName, result: readLoopVerdict.message, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: readLoopVerdict.message }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return // read never executes: no file payload appended (bloat fix)
    }
    const readLoopWarn = readLoopVerdict.kind === 'warn' ? readLoopVerdict.message : null
```

- [ ] **Step 2: Prepend the warning to the successful result text**

Anchor: `const resultText = withReflexion(toolName, result.isError, result.output, truncatedOutput)`. Replace that single line with:

```ts
    const baseResultText = withReflexion(toolName, result.isError, result.output, truncatedOutput)
    const resultText = readLoopWarn ? `${readLoopWarn}\n\n${baseResultText}` : baseResultText
```

- [ ] **Step 3: Call onWrite after a successful write**

Anchor: `this.toolHistory.push(toolName)` (immediately after `toolResultsThisTurn.push(result.isError ? 'failure' : 'success')` and `toolsUsedInSession.push(toolName)`). Directly BELOW the `if (this.toolHistory.length > 50) this.toolHistory = this.toolHistory.slice(-50)` line, insert:

```ts
    // Re-arm the read-loop gate whenever the model actually changes something.
    if (!result.isError && ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'].includes(toolName)) {
      this.readLoopGate.onWrite()
    }
```

- [ ] **Step 4: Type-check compiles**

Run: `bunx tsc --noEmit -p engine 2>&1 | head -20` (or `bun build engine/bridge/conversationLoop.ts --target=bun > /dev/null`).
Expected: no errors; `readLoopWarn`, `readLoopVerdict`, `baseResultText` all resolve.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: enforce ReadLoopGate in executeOneTool (deny/warn/onWrite)"
```

---

### Task 5: Delete the soft read-loop steer

The old soft steer is now superseded — it fired after execution, only steered the next call, never denied, and burned an iteration via the steering-queue `continue`.

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Locate the block**

Anchor: the comment `// Read loop detection: track consecutive read-only tool calls.` It is followed by a `const READ_ONLY = new Set(...)`, `const WRITE_TOOLS = new Set(...)`, `totalReads`/`totalWrites`/`recentTools`/`inReadLoop` locals, and an `if (inReadLoop && totalReads > (totalWrites + 1) * 3) { ... this.steering.steer( ... 'readLoop') }` block.

- [ ] **Step 2: Delete the whole block**

Remove from the `// Read loop detection:` comment through the closing `}` of the `if (inReadLoop ...)` block (the lines defining `READ_ONLY`, `WRITE_TOOLS`, `totalReads`, `totalWrites`, `recentTools`, `inReadLoop`, and the `this.steering.steer(...)` call). Do NOT remove the following `// Add tool results as a user message` block.

- [ ] **Step 3: Verify no dangling references**

Run: `grep -n "inReadLoop\|readLoop'" engine/bridge/conversationLoop.ts`
Expected: zero matches for `inReadLoop`; zero matches for the `'readLoop'` steer source. (The new `'readLoopGate-deny'` trace label is fine and will NOT match `readLoop'` — confirm by reading any hit.)

Run: `grep -n "totalReads\|totalWrites" engine/bridge/conversationLoop.ts`
Expected: zero matches (they existed only in the deleted block). If any remain, they belong to other logic — re-read and leave those.

- [ ] **Step 4: Type-check compiles**

Run: `bunx tsc --noEmit -p engine 2>&1 | head -20` (or `bun build engine/bridge/conversationLoop.ts --target=bun > /dev/null`).
Expected: no errors, no "unused variable" complaints for the removed locals.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "refactor: remove superseded soft read-loop steer (ReadLoopGate replaces it)"
```

---

### Task 6: Fix the contract enforcer budget bug

`ContractAssertPass`/`Fail` each increment `enforcementRounds` (the enforcer's re-prompt budget, capped at 5), so marking assertions silently disarms the enforcer. The counter must only advance at the genuine enforcer site.

**Files:**
- Modify: `engine/tools/contract.ts`
- Test: `engine/tools/contract.test.ts`

- [ ] **Step 1: Write the failing regression test**

Create `engine/tools/contract.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { globalContract, contractCreateTool, contractAssertPassTool } from './contract.js'

describe('contract enforcer budget', () => {
  beforeEach(async () => {
    await contractCreateTool.execute({
      title: 'budget test',
      assertions: ['a one', 'a two', 'a three', 'a four', 'a five'],
    })
  })

  test('marking assertions does not consume enforcementRounds', async () => {
    expect(globalContract.enforcementRounds).toBe(0)
    for (let i = 0; i < 5; i++) {
      await contractAssertPassTool.execute({ index: i })
    }
    expect(globalContract.enforcementRounds).toBe(0)
  })
})
```

(`contractCreateTool` requires `title` and `assertions`; `globalContract`,
`contractCreateTool`, `contractAssertPassTool` are all exported from
`engine/tools/contract.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test engine/tools/contract.test.ts`
Expected: FAIL — `expect(globalContract.enforcementRounds).toBe(0)` receives `5` (each assertPass incremented it).

- [ ] **Step 3: Remove the stray increments**

In `engine/tools/contract.ts`, in `contractAssertPassTool.execute`, delete the line:

```ts
    globalContract.enforcementRounds += 1
```

(anchor: it sits between `globalContract.assertPass(index, input.evidence as string | undefined)` and `return { output: globalContract.getStatus(), isError: false }`).

In `contractAssertFailTool.execute`, delete the matching line:

```ts
    globalContract.enforcementRounds += 1
```

(anchor: between `globalContract.assertFail(index, input.evidence as string | undefined)` and its `return`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test engine/tools/contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/tools/contract.ts engine/tools/contract.test.ts
git commit -m "fix: contract assertion marking no longer burns enforcer budget"
```

---

### Task 7: Integration smoke — gate forces an earlier edit

Re-run the pinned single rep with tracing and confirm the gate (a) denies at least once and (b) makes the model attempt a write earlier than the un-gated baseline (iter 71 in `trace-steering-1782502010.log`).

**Files:**
- No source changes. Uses `benchmark/true/grounding/abRun.ts` (committed in Task 0) and the engine changes from Tasks 1–6.

- [ ] **Step 1: Run the traced pinned rep**

> Backend: qwen3.6-27b-q6k via llama-cpp (the bootstrapProvider default). This is a real model run and may take up to the task timeout (~900s). Per the project's "run to completion" rule, let it finish without per-phase checkpoints. Kill the benchmark before the OFF arm starts (we only need the ON/governed rep).

```bash
mkdir -p benchmark/true/results
_TRACE_STEERING=1 bun benchmark/true/grounding/abRun.ts --task city-yield-consumers --reps 1 \
  > benchmark/true/results/readloopgate-smoke-$(date +%s).log 2>&1 &
```

Note the log path. Let it run; the governed (ON) rep runs first.

- [ ] **Step 2: Confirm the gate fired and forced an earlier write**

Once the governed rep completes (a `[grounding-ab]   -> grounding=ON` line appears, OR the trace stops advancing for >60s at the timeout), inspect the log:

```bash
L=benchmark/true/results/readloopgate-smoke-*.log
grep -c '\[read-loop\] DENIED' $L            # expect >= 1
grep '\[trace\]' $L | grep -m1 'writes=1'     # first iteration with a write
```

Expected: at least one `[read-loop] DENIED` line, AND the first `writes=1` trace line has a LOWER `iter=` than 71 (the un-gated baseline). Record both numbers in the commit message.

> If the gate denied but the model STILL never wrote (no `writes=1` line) before timeout, that is a finding, not a pass: the deny worked but the model chose to end/stall. Capture the log and report it — do not force a green checkmark.

- [ ] **Step 3: Kill the benchmark before the OFF arm**

```bash
# find the benchmark bun (largest RSS, NOT the ~7MB idle ones) and its llama-server
tasklist //FI "IMAGENAME eq bun.exe" //FO CSV //NH
tasklist //FI "IMAGENAME eq llama-server.exe" //FO CSV //NH
# taskkill //PID <benchmark-bun-pid> //F   and   //PID <llama-server-pid> //F
```

- [ ] **Step 4: Commit the evidence**

```bash
git add -f benchmark/true/results/readloopgate-smoke-*.log
git commit -m "test: ReadLoopGate integration smoke — DENIED fired, first write at iter <N> (was 71)"
```

(Replace `<N>` with the observed iteration.)

---

### Task 8: Full test suite + wire-check (BLOCKING)

**Files:**
- No changes unless the checks reveal a gap.

- [ ] **Step 1: Run the gate + contract unit suites**

Run: `bun test engine/vsm/readLoopGate.test.ts engine/tools/contract.test.ts`
Expected: PASS (9 + 1 tests).

- [ ] **Step 2: Run the package test runner for regressions**

Run: `npm test` (i.e. `vitest run`).
Expected: no NEW failures versus the pre-change baseline. (Some `bun:test` files are not picked up by vitest; that is the pre-existing split, not a regression. Compare against `git stash` baseline if unsure.)

- [ ] **Step 3: Wire-check — every new symbol is imported and used**

Run each and confirm the expected result:

```bash
grep -n "import { ReadLoopGate }" engine/bridge/conversationLoop.ts   # 1 hit (import)
grep -n "new ReadLoopGate()" engine/bridge/conversationLoop.ts        # 1 hit (field init)
grep -n "this.readLoopGate.reset()" engine/bridge/conversationLoop.ts # 2 hits (both reset sites)
grep -n "this.readLoopGate.evaluate(" engine/bridge/conversationLoop.ts # 1 hit (executeOneTool)
grep -n "this.readLoopGate.onWrite()" engine/bridge/conversationLoop.ts # 1 hit (after write)
grep -n "readLoopWarn" engine/bridge/conversationLoop.ts              # >=2 hits (assign + use)
```

Expected: every count as annotated above. If `reset()` shows fewer than 2, the second reset site was missed — fix it.

- [ ] **Step 4: Wire-check — superseded code is gone**

```bash
grep -n "inReadLoop" engine/bridge/conversationLoop.ts        # 0 hits
grep -n "'readLoop')" engine/bridge/conversationLoop.ts       # 0 hits (old steer source)
grep -rn "enforcementRounds += 1" engine/tools/contract.ts    # 0 hits
grep -rn "enforcementRounds++" engine/bridge/conversationLoop.ts # 1 hit (the legit enforcer site only)
```

Expected: counts as annotated. Any deviation is a blocking defect — fix before proceeding.

- [ ] **Step 5: Final commit (only if Step 3/4 required a fix)**

```bash
git add engine/bridge/conversationLoop.ts engine/tools/contract.ts
git commit -m "fix: wire-check corrections for read-loop gate"
```

If no fixes were needed, skip this step.

---

## Definition of Done

- `engine/vsm/readLoopGate.ts` exists; 9 unit tests pass.
- The gate is instantiated, reset at both conversation-reset sites, consulted in `executeOneTool`, and re-armed via `onWrite()` after successful writes.
- The soft steer block and the `'readLoop'` steer source are deleted.
- Both `enforcementRounds += 1` lines in `contract.ts` are removed; the contract regression test passes.
- The integration smoke produced at least one `[read-loop] DENIED` and a first `writes=1` at an iteration earlier than 71 (or a documented finding if the model stalled instead).
- Wire-check (Task 8 Steps 3–4) passes with the exact counts.
