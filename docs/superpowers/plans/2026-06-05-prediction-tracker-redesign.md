# Prediction Tracker Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 8 miscalibrated hypotheses with 8 that fire frequently, predict observable behavior, and use empirical baselines.

**Architecture:** Rewrite `predictionTracker.ts` trigger/evaluation logic. Keep the existing `PredictionTracker` class, `Prediction` type, `PredictionStats` type, and `wilsonScore` math unchanged. Replace `NULL_BASELINES`, `EVAL_WINDOWS`, `checkTriggers`, `checkExtendedTriggers`, `evaluateOpen`, and `_evaluate`. Update call sites in `cyberneticsGovernance.ts` to pass new trigger data. Update tests.

**Tech Stack:** TypeScript, Bun, Vitest

---

### Task 1: Rewrite hypothesis definitions and baselines

**Files:**
- Modify: `engine/vsm/predictionTracker.ts:123-146`

- [ ] **Step 1: Replace NULL_BASELINES and EVAL_WINDOWS**

```typescript
// Replace lines 123-146 with:

/** Hypothesis metadata — names, null baselines, evaluation windows */
export const HYPOTHESES: Record<HypothesisId, { name: string; nullBaseline: number; evalWindow: number }> = {
  H1: { name: 'Stuck Escape',        nullBaseline: 0.40, evalWindow: 3 },
  H2: { name: 'Nudge Response',      nullBaseline: 0.50, evalWindow: 1 },
  H3: { name: 'Contract Completion', nullBaseline: 0.50, evalWindow: 20 },
  H4: { name: 'Read-to-Edit',        nullBaseline: 0.30, evalWindow: 2 },
  H5: { name: 'Thinking Efficiency', nullBaseline: 0.30, evalWindow: 1 },
  H6: { name: 'Temperature Effect',  nullBaseline: 0.33, evalWindow: 1 },
  H7: { name: 'S4 Reflection ROI',   nullBaseline: 0.50, evalWindow: 3 },
  H8: { name: 'Session Improvement', nullBaseline: 0.50, evalWindow: 0 },
}
```

- [ ] **Step 2: Update getStatistics to use HYPOTHESES**

In `getStatistics()` (line ~327), change:
```typescript
// OLD:
const nullBaseline = NULL_BASELINES[hyp]
// NEW:
const nullBaseline = HYPOTHESES[hyp].nullBaseline
```

- [ ] **Step 3: Update _openIf to use HYPOTHESES**

In `_openIf()` (line ~357), change:
```typescript
// OLD:
const window = EVAL_WINDOWS[hypothesis]
// NEW:
const window = HYPOTHESES[hypothesis].evalWindow
```

- [ ] **Step 4: Verify it compiles**

Run: `cd engine && npx tsc --noEmit vsm/predictionTracker.ts 2>&1 | head -5`
Expected: No errors (or only pre-existing Bun type errors)

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/predictionTracker.ts
git commit -m "refactor: replace hardcoded hypothesis baselines with HYPOTHESES metadata"
```

---

### Task 2: Rewrite checkTriggers with new H1, H2, H6 triggers

**Files:**
- Modify: `engine/vsm/predictionTracker.ts:174-216`
- Modify: `engine/vsm/cyberneticsGovernance.ts:515-521`

- [ ] **Step 1: Add new fields to checkTriggers signature**

Replace the `checkTriggers` method entirely:

```typescript
/**
 * Check H1 (Stuck Escape), H2 (Nudge Response), H6 (Temperature Effect) triggers.
 * Call this every turn from governance.onTurnComplete.
 */
checkTriggers(
  turn: number,
  context: {
    stuckTurns: number,
    toolsRestricted: boolean,  // C7 fired
    nudgeInjected: boolean,    // governance nudge was sent this turn
    temperatureLowered: boolean, // temperature was overridden for stuck
    recentTools: string[],     // last 5 tool names
  },
): void {
  // H1: Stuck Escape — stuck >= 5 AND tools restricted by C7
  if (context.stuckTurns >= 5 && context.toolsRestricted) {
    this._openIf('H1', turn, `stuck=${context.stuckTurns},restricted=true`, 'Edit/Write within 3 turns')
  }

  // H2: Nudge Response — governance nudge was injected
  if (context.nudgeInjected) {
    this._openIf('H2', turn, 'nudge_injected', 'tool type changes on next call')
  }

  // H6: Temperature Effect — temperature lowered for stuck turn
  if (context.temperatureLowered) {
    this._openIf('H6', turn, 'temperature_lowered', 'different tool than last 3 calls')
  }
}
```

- [ ] **Step 2: Update governance call site**

In `engine/vsm/cyberneticsGovernance.ts` around line 515-521, replace:

```typescript
// OLD:
const toolResults = this.toolHistory.slice(-10).map(t => ({ tool: t.name, success: t.success }))
const report = this.getReport()
this._predictionTracker.checkTriggers(this.turnCount, report, toolResults)

// NEW:
const report = this.getReport()
this._predictionTracker.checkTriggers(this.turnCount, {
  stuckTurns: this.stuckCount,
  toolsRestricted: this._toolsRestricted ?? false,
  nudgeInjected: this._nudgeInjectedThisTurn ?? false,
  temperatureLowered: this._temperatureLoweredThisTurn ?? false,
  recentTools: this.lastToolSignatures.slice(-5),
})
```

- [ ] **Step 3: Add tracking flags to governance**

In `cyberneticsGovernance.ts`, add private fields after `_workflowReadOnlyPhase`:

```typescript
private _toolsRestricted = false
private _nudgeInjectedThisTurn = false
private _temperatureLoweredThisTurn = false

/** Called by conversation loop when C7 restricts tools */
setToolsRestricted(restricted: boolean): void { this._toolsRestricted = restricted }

/** Called by conversation loop when a nudge is injected */
markNudgeInjected(): void { this._nudgeInjectedThisTurn = true }

/** Called by conversation loop when temperature is lowered */
markTemperatureLowered(): void { this._temperatureLoweredThisTurn = true }

/** Reset per-turn flags — call at start of each turn */
resetTurnFlags(): void {
  this._nudgeInjectedThisTurn = false
  this._temperatureLoweredThisTurn = false
}
```

- [ ] **Step 4: Commit**

```bash
git add engine/vsm/predictionTracker.ts engine/vsm/cyberneticsGovernance.ts
git commit -m "feat: H1 Stuck Escape, H2 Nudge Response, H6 Temperature Effect triggers"
```

---

### Task 3: Rewrite checkExtendedTriggers with H3, H4, H5, H7

**Files:**
- Modify: `engine/vsm/predictionTracker.ts:222-242`

- [ ] **Step 1: Replace checkExtendedTriggers**

```typescript
/**
 * Check H3 (Contract Completion), H4 (Read-to-Edit), H5 (Thinking Efficiency),
 * H7 (S4 Reflection ROI) triggers.
 */
checkExtendedTriggers(
  turn: number,
  context: {
    contractCreated: boolean,         // new contract auto-created this turn
    consecutiveReadsSameFile: number,  // count of consecutive Read on same file
    thinkingTokensLastTurn: number,   // reasoning tokens in last model call
    s4ReflectionRan: boolean,         // S4 reflector ran this turn
  },
): void {
  // H3: Contract Completion — new contract was created
  if (context.contractCreated) {
    this._openIf('H3', turn, 'contract_created', 'all assertions pass within 20 iterations')
  }

  // H4: Read-to-Edit — 3+ consecutive reads of same file
  if (context.consecutiveReadsSameFile >= 3) {
    this._openIf('H4', turn, `consecutive_reads=${context.consecutiveReadsSameFile}`, 'Edit follows within 2 turns')
  }

  // H5: Thinking Efficiency — thinking tokens > 100
  if (context.thinkingTokensLastTurn > 100) {
    this._openIf('H5', turn, `thinking_tokens=${context.thinkingTokensLastTurn}`, 'next tool is action tool (Edit/Write/Bash)')
  }

  // H7: S4 Reflection ROI — S4 reflection ran
  if (context.s4ReflectionRan) {
    this._openIf('H7', turn, 's4_reflection_ran', 'model behavior changes within 3 turns')
  }
}
```

- [ ] **Step 2: Update governance call site**

In `cyberneticsGovernance.ts`, replace the `checkExtendedTriggers` call:

```typescript
// OLD:
this._predictionTracker.checkExtendedTriggers(this.turnCount, report, heterarchyShifted, this.stuckCount >= 3)

// NEW:
this._predictionTracker.checkExtendedTriggers(this.turnCount, {
  contractCreated: this._contractCreatedThisTurn ?? false,
  consecutiveReadsSameFile: this._consecutiveReadsSameFile ?? 0,
  thinkingTokensLastTurn: this._thinkingTokensLastTurn ?? 0,
  s4ReflectionRan: this._s4ReflectionRanThisTurn ?? false,
})
```

- [ ] **Step 3: Add tracking fields to governance**

```typescript
private _contractCreatedThisTurn = false
private _consecutiveReadsSameFile = 0
private _lastReadFile = ''
private _thinkingTokensLastTurn = 0
private _s4ReflectionRanThisTurn = false

setContractCreated(): void { this._contractCreatedThisTurn = true }
setThinkingTokens(count: number): void { this._thinkingTokensLastTurn = count }
setS4ReflectionRan(): void { this._s4ReflectionRanThisTurn = true }

/** Call from onToolResult to track consecutive reads */
trackReadPattern(toolName: string, filePath: string): void {
  if (toolName === 'Read' && filePath === this._lastReadFile) {
    this._consecutiveReadsSameFile++
  } else if (toolName === 'Read') {
    this._lastReadFile = filePath
    this._consecutiveReadsSameFile = 1
  } else {
    this._consecutiveReadsSameFile = 0
    this._lastReadFile = ''
  }
}
```

Add to `resetTurnFlags`:
```typescript
resetTurnFlags(): void {
  this._nudgeInjectedThisTurn = false
  this._temperatureLoweredThisTurn = false
  this._contractCreatedThisTurn = false
  this._thinkingTokensLastTurn = 0
  this._s4ReflectionRanThisTurn = false
}
```

- [ ] **Step 4: Commit**

```bash
git add engine/vsm/predictionTracker.ts engine/vsm/cyberneticsGovernance.ts
git commit -m "feat: H3 Contract, H4 Read-to-Edit, H5 Thinking, H7 S4 ROI triggers"
```

---

### Task 4: Rewrite _evaluate for all 8 hypotheses

**Files:**
- Modify: `engine/vsm/predictionTracker.ts:377-452`

- [ ] **Step 1: Replace _evaluate method**

```typescript
private _evaluate(
  p: Prediction,
  report: GovernanceReport,
  recentTools: string[],
): { correct: boolean; actualOutcome: string } {
  const ACTION_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Bash', 'ApplyPatch']
  const lastN = (n: number) => recentTools.slice(-n)

  switch (p.hypothesis) {
    case 'H1': {
      // Stuck Escape: did Edit/Write happen within window?
      const hasAction = recentTools.some(t => ACTION_TOOLS.includes(t))
      return { correct: hasAction, actualOutcome: `action_tools_used=${hasAction}, recent=[${lastN(3).join(',')}]` }
    }

    case 'H2': {
      // Nudge Response: did tool type change from the last 3?
      const beforeNudge = recentTools.slice(-4, -1)
      const afterNudge = recentTools.slice(-1)[0]
      const changed = afterNudge ? !beforeNudge.includes(afterNudge) : false
      return { correct: changed, actualOutcome: `before=[${beforeNudge.join(',')}] after=${afterNudge || 'none'}` }
    }

    case 'H3': {
      // Contract Completion: are all assertions passed?
      // Check via report — if status is healthy and no stuck, contract likely completed
      const completed = report.stuckTurns === 0 && report.toolSuccessRate > 0.7
      return { correct: completed, actualOutcome: `stuck=${report.stuckTurns}, successRate=${report.toolSuccessRate.toFixed(2)}` }
    }

    case 'H4': {
      // Read-to-Edit: did an Edit follow the read loop?
      const hasEdit = recentTools.slice(-2).some(t => t === 'Edit' || t === 'Write' || t === 'MultiEdit')
      return { correct: hasEdit, actualOutcome: `recent=[${lastN(2).join(',')}]` }
    }

    case 'H5': {
      // Thinking Efficiency: was next tool an action tool?
      const nextTool = recentTools[recentTools.length - 1]
      const isAction = nextTool ? ACTION_TOOLS.includes(nextTool) : false
      return { correct: isAction, actualOutcome: `next_tool=${nextTool || 'none'}` }
    }

    case 'H6': {
      // Temperature Effect: did tool differ from last 3?
      const last3 = recentTools.slice(-4, -1)
      const current = recentTools[recentTools.length - 1]
      const different = current ? !last3.includes(current) : false
      return { correct: different, actualOutcome: `last3=[${last3.join(',')}] current=${current || 'none'}` }
    }

    case 'H7': {
      // S4 Reflection ROI: did behavior change within 3 turns?
      const before = new Set(recentTools.slice(-6, -3))
      const after = new Set(recentTools.slice(-3))
      const changed = ![...after].every(t => before.has(t))
      return { correct: changed, actualOutcome: `before=[${[...before].join(',')}] after=[${[...after].join(',')}]` }
    }

    case 'H8': {
      // Session Improvement: evaluated at session end only
      return { correct: false, actualOutcome: 'H8 evaluated at session end' }
    }
  }
}
```

- [ ] **Step 2: Update evaluateOpen signature to pass recentTools**

```typescript
evaluateOpen(
  turn: number,
  report: GovernanceReport,
  recentTools: string[],
): void {
  const stillOpen: Prediction[] = []
  for (const p of this.openPredictions) {
    const dueAt = p.triggerTurn + p.evaluationWindow
    if (turn < dueAt) { stillOpen.push(p); continue }
    const result = this._evaluate(p, report, recentTools)
    p.correct = result.correct
    p.actualOutcome = result.actualOutcome
    this.completedPredictions.push(p)
  }
  this.openPredictions = stillOpen
}
```

- [ ] **Step 3: Update governance call site for evaluateOpen**

In `cyberneticsGovernance.ts` line 521:

```typescript
// OLD:
this._predictionTracker.evaluateOpen(this.turnCount, report, toolResults)

// NEW:
this._predictionTracker.evaluateOpen(this.turnCount, report, this.lastToolSignatures)
```

- [ ] **Step 4: Rewrite evaluateSessionEnd for H8**

```typescript
evaluateSessionEnd(
  editsPerMinute: number,
  rollingAvgEditsPerMinute: number,
): void {
  const h8Open = this.openPredictions.filter(p => p.hypothesis === 'H8')
  for (const p of h8Open) {
    const improved = editsPerMinute > rollingAvgEditsPerMinute
    p.correct = improved
    p.actualOutcome = `current=${editsPerMinute.toFixed(1)}/min, avg=${rollingAvgEditsPerMinute.toFixed(1)}/min`
    this.completedPredictions.push(p)
  }
  this.openPredictions = this.openPredictions.filter(p => p.hypothesis !== 'H8')
}
```

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/predictionTracker.ts engine/vsm/cyberneticsGovernance.ts
git commit -m "feat: rewrite _evaluate for all 8 redesigned hypotheses"
```

---

### Task 5: Update dashboard hypothesis names

**Files:**
- Modify: `engine/dashboard/index.html`

- [ ] **Step 1: Find and update the prediction table rendering**

Search for the `renderPredictions` function. The hypothesis names are currently shown from the API response. The API returns `PredictionStats` which has `hypothesis` (H1-H8) but no name field.

Add the names to the dashboard JS:

```javascript
var HYPOTHESIS_NAMES = {
  H1: 'Stuck Escape', H2: 'Nudge Response', H3: 'Contract Completion',
  H4: 'Read-to-Edit', H5: 'Thinking Efficiency', H6: 'Temperature Effect',
  H7: 'S4 Reflection ROI', H8: 'Session Improvement'
};
```

In the rendering loop, replace the name column with:
```javascript
HYPOTHESIS_NAMES[s.hypothesis] || s.hypothesis
```

- [ ] **Step 2: Update verdict logic**

Change verdict display to use minimum 10 samples:
```javascript
var verdict = s.total < 10 ? 'need more data'
  : s.significantlyBetter ? 'better than null'
  : 'worse than null';
var verdictClass = s.total < 10 ? '' : s.significantlyBetter ? 'green' : 'red';
```

- [ ] **Step 3: Commit**

```bash
git add engine/dashboard/index.html
git commit -m "feat: update dashboard with new hypothesis names and 10-sample minimum"
```

---

### Task 6: Rewrite tests

**Files:**
- Modify: `engine/__tests__/predictionTracker.test.ts`

- [ ] **Step 1: Rewrite tests for new trigger signatures**

```typescript
import { describe, it, expect } from 'vitest'
import { PredictionTracker, wilsonScore, HYPOTHESES } from '../vsm/predictionTracker.js'

describe('PredictionTracker — redesigned H1-H8', () => {
  it('H1: triggers on stuck >= 5 with tools restricted', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.length).toBe(1)
    expect(t.openPredictions[0].hypothesis).toBe('H1')
  })

  it('H1: does NOT trigger when stuck < 5', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(3, { stuckTurns: 3, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.length).toBe(0)
  })

  it('H2: triggers on nudge injection', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 0, toolsRestricted: false, nudgeInjected: true, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.some(p => p.hypothesis === 'H2')).toBe(true)
  })

  it('H4: triggers on 3+ consecutive reads', () => {
    const t = new PredictionTracker('test')
    t.checkExtendedTriggers(5, { contractCreated: false, consecutiveReadsSameFile: 3, thinkingTokensLastTurn: 0, s4ReflectionRan: false })
    expect(t.openPredictions.some(p => p.hypothesis === 'H4')).toBe(true)
  })

  it('H5: triggers on thinking tokens > 100', () => {
    const t = new PredictionTracker('test')
    t.checkExtendedTriggers(5, { contractCreated: false, consecutiveReadsSameFile: 0, thinkingTokensLastTurn: 150, s4ReflectionRan: false })
    expect(t.openPredictions.some(p => p.hypothesis === 'H5')).toBe(true)
  })

  it('H1 evaluates correctly when Edit follows restriction', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    const report = { status: 'healthy', stuckTurns: 0, toolSuccessRate: 0.9 } as any
    t.evaluateOpen(8, report, ['Read', 'Read', 'Edit'])
    expect(t.completedPredictions.length).toBe(1)
    expect(t.completedPredictions[0].correct).toBe(true)
  })

  it('H1 evaluates false when only Read after restriction', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    const report = { status: 'warning', stuckTurns: 8, toolSuccessRate: 0.5 } as any
    t.evaluateOpen(8, report, ['Read', 'Read', 'Read'])
    expect(t.completedPredictions.length).toBe(1)
    expect(t.completedPredictions[0].correct).toBe(false)
  })

  it('does not duplicate predictions in same window', () => {
    const t = new PredictionTracker('test')
    t.checkTriggers(5, { stuckTurns: 5, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    t.checkTriggers(6, { stuckTurns: 6, toolsRestricted: true, nudgeInjected: false, temperatureLowered: false, recentTools: [] })
    expect(t.openPredictions.filter(p => p.hypothesis === 'H1').length).toBe(1)
  })

  it('HYPOTHESES has names for all 8', () => {
    expect(Object.keys(HYPOTHESES).length).toBe(8)
    for (const h of Object.values(HYPOTHESES)) {
      expect(h.name.length).toBeGreaterThan(0)
      expect(h.nullBaseline).toBeGreaterThan(0)
      expect(h.evalWindow).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('wilsonScore', () => {
  it('returns CI for 70% with 100 samples', () => {
    const [lo, hi] = wilsonScore(70, 100, 0.05)
    expect(lo).toBeGreaterThan(0.5)
    expect(hi).toBeLessThan(0.85)
  })

  it('returns [0,1] for empty data', () => {
    const [lo, hi] = wilsonScore(0, 0, 0.05)
    expect(lo).toBe(0)
    expect(hi).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd engine && bun test __tests__/predictionTracker.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add engine/__tests__/predictionTracker.test.ts
git commit -m "test: rewrite prediction tracker tests for redesigned H1-H8"
```

---

### Task 7: Wire trigger signals from conversation loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Call resetTurnFlags at start of each model iteration**

In `runModelLoop`, at the start of the loop body (after the iteration counter log), add:

```typescript
this.governance.resetTurnFlags()
```

- [ ] **Step 2: Mark nudge injected when steering nudges are sent**

Find where governance nudges are added (search for `Steering from readLoop` or `steering.followUp`). After each nudge injection, add:

```typescript
this.governance.markNudgeInjected()
```

- [ ] **Step 3: Mark temperature lowered when temperature override happens**

Find `temperature override to 0.1` or `_savedTemperature`. After the override, add:

```typescript
this.governance.markTemperatureLowered()
```

- [ ] **Step 4: Mark contract created when auto-contract fires**

Find `globalContract.create(` (around line 486). After contract creation, add:

```typescript
this.governance.setContractCreated()
```

- [ ] **Step 5: Track thinking tokens**

In the `message_stop` handler where `reasoningTokenCount` is logged, add:

```typescript
this.governance.setThinkingTokens(reasoningTokenCount)
```

- [ ] **Step 6: Track read patterns**

In the tool execution section, after each tool result, add:

```typescript
const filePath = (toolInput.file_path as string) ?? (toolInput.path as string) ?? ''
this.governance.trackReadPattern(toolName, filePath)
```

- [ ] **Step 7: Mark S4 reflection**

Find where S4 reflector runs (search for `reflector.shouldReflect`). After the reflection, add:

```typescript
this.governance.setS4ReflectionRan()
```

- [ ] **Step 8: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: wire prediction trigger signals from conversation loop to governance"
```

---

### Task 8: Integration test — verify predictions fire during a real run

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start engine and send a task**

```bash
LOCALCODE_PROVIDER=llama-cpp LOCALCODE_MODEL=qwen3.6:27b \
  LOCALCODE_MODEL_PATH=~/.cynco/models/qwen3.6-mtp/Qwen3.6-27B-Q6_K.gguf \
  LOCALCODE_SPEC_TYPE=draft-mtp LOCALCODE_SPEC_DRAFT_N=3 \
  LOCALCODE_APPROVE_ALL=true LOCALCODE_CONTEXT_LENGTH=65536 \
  bun engine/main.ts
```

Send a CivKings task via WebSocket.

- [ ] **Step 2: Check predictions API**

```bash
curl http://localhost:9161/api/predictions | python3 -m json.tool
```

Expected: At least H1 and H4 should have fired (stuck escape and read loops are common). Names should show "Stuck Escape", "Read-to-Edit", etc.

- [ ] **Step 3: Take dashboard screenshot and verify**

Check the Prediction Tracker panel shows new names, verdicts are "need more data" (gray) until 10 samples are reached.

- [ ] **Step 4: Commit any fixes discovered during integration**

```bash
git add -u
git commit -m "fix: prediction tracker integration fixes"
```
