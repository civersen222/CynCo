# P4.1 Task Error + CUSUM Trend (Task Homeostat core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every governed turn computes `taskError` (fraction of unmet contract assertions, external to the model) and `errorTrend` (CUSUM alarm state over the taskError series), carried through GovernanceReport → protocol → ledger turn records → S5 input — STATE doc Phase 4(b)+(c) core, file-level spec in "Phase 4 details".

**Architecture:** New `engine/vsm/taskModel.ts` (`TaskModel` class) reads `globalContract.snapshot()` each sealed turn and feeds a `CusumDetector` from the vendored cybernetics library (same one `vsm/performanceMetrics.ts` already uses). `CyberneticsGovernance` owns a TaskModel and seals it next to `windowedVariety` — BEFORE the ablation early-return (measurement organ, not authority; Phase 3 needs the series from ablated runs too). Plumbing copies the proven P1.5 `varietyWindowed` pattern exactly: report field → protocol optional field → conversationLoop emit → ledger collector → S5Input.

**Tech Stack:** TypeScript (Bun runtime, `.js` import extensions), vitest (NEVER `bun test`; run from repo root), plain `.mjs` ledger.

**Branch:** `p4-taskmodel` (already created from main @ 1dee514).

---

## Design facts (verified against source — do not re-derive)

- Contract: `engine/tools/contract.ts` — `AssertionStatus = 'pending'|'passed'|'failed'|'skipped'` (:15), `ContractSnapshot { title, brief, active, complete, assertions: Assertion[] }` (:23-29), `Assertion { text, status, evidence? }` (:17-21), `snapshot(): ContractSnapshot` deep-copy (:139-140), `clear()` (:151), singleton `export const globalContract = new ContractState()` (:164).
- CUSUM: `engine/cybernetics-core/src/metrics/index.ts:115-148` — `class CusumDetector { constructor(threshold, slack); update(deviation): boolean; upper(); lower(); reset() }`. Import pattern (from `vsm/performanceMetrics.ts:11,17,28`): `import { metrics } from '../cybernetics-core/src/index.js'` then `new metrics.CusumDetector(3.0, 0.5)`; field type `InstanceType<typeof metrics.CusumDetector>`.
- Governance: `engine/vsm/cyberneticsGovernance.ts` — `private windowedVariety = new WindowedVarietyMeter()` at :147; `onTurnComplete(metrics)` seals `this.windowedVariety.onTurnComplete()` at :384 with comment "before the ablation return — measurement, not authority", ablation return at :385-387; `getReport()` at :634, returns object with `varietyWindowed: this.windowedVariety.count()` at :690.
- Report type: `engine/vsm/types.ts:46-67` `GovernanceReport`.
- Protocol: `engine/bridge/protocol.ts:167-219` `GovernanceStatusEvent` — file stays import-free by convention; unions widened to `string` on the wire; new fields optional.
- Emit: `engine/bridge/conversationLoop.ts:1848-1869` — `const turnReport = this.governance.getReport()` then `this.emit({ type: 'governance.status', ... })`; fields listed explicitly.
- Ledger: `scripts/cynco-ledger.mjs:26-45` — `case 'governance.status':` pushes a turn object of `m.X ?? null` fields.
- S5: `engine/s5/types.ts:3-32` `S5Input`; `engine/s5/orchestrator.ts:56-84` maps into it. `OrchestratorInput.governance` IS typed `GovernanceReport` (orchestrator.ts:15) — once the report type gains the fields, typed access works directly (the `as any` on `agreementRatio` at :79 is historical; do not copy it for the new fields).
- Type hygiene: vitest strips types without checking them, so GovernanceReport/S5Input literals in tests missing new REQUIRED fields won't fail at runtime — they must still be updated (no type errors left in the repo). Exhaustive literal sites listed in Task 3 Step 3f.
- Test exemplar: `engine/__tests__/vsm/varietyWindowedReport.test.ts` — governance report + ablation-survival pattern (resetEventBus, `_ABLATION_VSM_DISABLED`, full `onTurnComplete` metrics arg with a long response string).
- `engine/__tests__/harness/cyncoLedger.test.ts` imports from `'bun:test'` (shimmed to vitest — do not change) and has 18 tests; new tests append inside the top-level describe.
- No test asserts the exact full shape of `getReport()` — additive fields are safe (checked: only `axiomHealth.violations` uses `toEqual`).
- Baselines: un-gated `npx vitest run` = **1889 passed / 33 skipped**. This plan adds 6 + 3 + 2 = 11 tests → expect **1900 passed / 33 skipped**. Run tests from repo root only; git from repo root only; verify branch `p4-taskmodel` before every commit; CRLF warnings benign.

## Design decisions (locked)

- `taskError` = (pending + failed) / (total − skipped), from `globalContract.snapshot()`. `null` when: contract inactive, zero assertions, or all assertions skipped. Computed externally by the governor — never a model self-estimate (VI.3 hard rule (a)).
- `errorTrend`: CUSUM over the taskError series. Deviation = current error − EMA baseline (α = 0.3, seeded with the first observation so the first deviation is 0). Detector `new metrics.CusumDetector(0.5, 0.05)` — taskError ∈ [0,1], slack 0.05 tolerates jitter, threshold 0.5 means a sustained ~0.5 cumulative shift alarms. On alarm: `'rising'` if `upper() >= lower()` else `'falling'`; no alarm: `'flat'`. `null` turns (no contract) do NOT feed the CUSUM and report trend `null`.
- Detector is NOT reset on alarm — the alarm state persisting is itself signal for the per-turn series; Phase 3 discrimination analysis consumes the raw series either way.
- Ledger/protocol carry exactly two new flat fields: `taskError`, `errorTrend` (per STATE doc "ledger +`taskError`,`errorTrend`").

---

### Task 1: `TaskModel` + unit tests

**Files:**
- Create: `engine/vsm/taskModel.ts`
- Create: `engine/__tests__/vsm/taskModel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/vsm/taskModel.test.ts`:

```typescript
// P4.1: taskError = unmet-assertion fraction from the global contract,
// computed by the governor (never a model self-estimate — VI.3 rule (a));
// errorTrend = CUSUM alarm state over the series. Null when no contract:
// absence of a contract is not zero error.
import { describe, expect, it } from 'vitest'
import { TaskModel } from '../../vsm/taskModel.js'
import type { ContractSnapshot } from '../../tools/contract.js'

function snap(statuses: ('pending' | 'passed' | 'failed' | 'skipped')[], active = true): ContractSnapshot {
  return {
    title: 't',
    brief: 'b',
    active,
    complete: statuses.length > 0 && statuses.every(s => s === 'passed' || s === 'skipped'),
    assertions: statuses.map((status, i) => ({ text: `a${i}`, status })),
  }
}

describe('TaskModel (P4.1)', () => {
  it('no active contract → taskError and errorTrend are null', () => {
    const tm = new TaskModel(() => snap([], false))
    tm.onTurnComplete()
    expect(tm.snapshot()).toEqual({ taskError: null, errorTrend: null })
  })

  it('unmet fraction: pending and failed are unmet; passed is met', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['pending', 'pending', 'failed', 'passed']
    const tm = new TaskModel(() => snap(statuses))
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0.75)
    statuses = ['passed', 'passed', 'failed', 'passed']
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0.25)
    statuses = ['passed', 'passed', 'passed', 'passed']
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(0)
  })

  it('skipped assertions leave the denominator; all-skipped → null', () => {
    const tm = new TaskModel(() => snap(['skipped', 'pending']))
    tm.onTurnComplete()
    expect(tm.snapshot().taskError).toBe(1) // 1 unmet of 1 countable
    const allSkipped = new TaskModel(() => snap(['skipped', 'skipped']))
    allSkipped.onTurnComplete()
    expect(allSkipped.snapshot().taskError).toBeNull()
  })

  it('sustained error jump drives errorTrend to rising', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['passed', 'passed']
    const tm = new TaskModel(() => snap(statuses))
    for (let i = 0; i < 3; i++) tm.onTurnComplete() // baseline settles at 0
    expect(tm.snapshot().errorTrend).toBe('flat')
    statuses = ['failed', 'failed'] // error jumps 0 → 1; deviation ~1 > threshold
    tm.onTurnComplete()
    expect(tm.snapshot().errorTrend).toBe('rising')
  })

  it('sustained error drop drives errorTrend to falling', () => {
    let statuses: ('pending' | 'passed' | 'failed' | 'skipped')[] = ['pending', 'pending']
    const tm = new TaskModel(() => snap(statuses))
    for (let i = 0; i < 3; i++) tm.onTurnComplete() // baseline settles at 1
    expect(tm.snapshot().errorTrend).toBe('flat')
    statuses = ['passed', 'passed'] // error drops 1 → 0
    tm.onTurnComplete()
    expect(tm.snapshot().errorTrend).toBe('falling')
  })

  it('contractless turns do not feed the CUSUM and later turns resume cleanly', () => {
    let current: ContractSnapshot = snap([], false)
    const tm = new TaskModel(() => current)
    tm.onTurnComplete()
    tm.onTurnComplete()
    expect(tm.snapshot()).toEqual({ taskError: null, errorTrend: null })
    current = snap(['pending'])
    tm.onTurnComplete() // first observation seeds the EMA — deviation 0, no alarm
    expect(tm.snapshot()).toEqual({ taskError: 1, errorTrend: 'flat' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root: `npx vitest run engine/__tests__/vsm/taskModel.test.ts`
Expected: FAIL — cannot resolve `../../vsm/taskModel.js`.

- [ ] **Step 3: Write the module**

Create `engine/vsm/taskModel.ts`:

```typescript
// Task Homeostat core (STATE-AND-VISION Phase 4b/4c; prior art in VI.3).
//
// taskError: fraction of unmet (pending|failed) assertions on the global
// contract, over the countable (non-skipped) assertions. Computed here, by
// the governor, from contract state — NEVER by asking the executing model
// for a mid-run self-estimate (RePro: online progress prompting is
// counterproductive; VI.3 hard rule (a)).
//
// errorTrend: CUSUM alarm state over the taskError series (deviation from an
// EMA baseline). CUSUM-on-task-error is the novel piece of the thesis —
// the per-turn series lands in the ledger so Phase 3 can measure whether it
// out-discriminates the activity signals.
//
// null semantics: no active contract / nothing countable → taskError null,
// errorTrend null, and the CUSUM is NOT fed — absence of a contract is not
// zero error.

import { metrics } from '../cybernetics-core/src/index.js'
import { globalContract } from '../tools/contract.js'
import type { ContractSnapshot } from '../tools/contract.js'

const CUSUM_THRESHOLD = 0.5
const CUSUM_SLACK = 0.05
const EMA_ALPHA = 0.3

export type TaskErrorSnapshot = {
  /** Unmet-assertion fraction in [0,1], or null when nothing is countable. */
  taskError: number | null
  /** CUSUM alarm state over the series; null when taskError is null. */
  errorTrend: 'rising' | 'falling' | 'flat' | null
}

export class TaskModel {
  private readonly getContract: () => ContractSnapshot
  private readonly cusum: InstanceType<typeof metrics.CusumDetector>
  private ema: number | null = null
  private last: TaskErrorSnapshot = { taskError: null, errorTrend: null }

  constructor(getContract: () => ContractSnapshot = () => globalContract.snapshot()) {
    this.getContract = getContract
    this.cusum = new metrics.CusumDetector(CUSUM_THRESHOLD, CUSUM_SLACK)
  }

  /** Seal the turn: read the contract, compute error, feed the CUSUM. */
  onTurnComplete(): void {
    const error = this.computeError(this.getContract())
    if (error === null) {
      this.last = { taskError: null, errorTrend: null }
      return
    }
    if (this.ema === null) this.ema = error // seed: first deviation is 0
    const alarm = this.cusum.update(error - this.ema)
    const errorTrend = alarm
      ? (this.cusum.upper() >= this.cusum.lower() ? 'rising' as const : 'falling' as const)
      : 'flat' as const
    this.ema = this.ema + EMA_ALPHA * (error - this.ema)
    this.last = { taskError: error, errorTrend }
  }

  /** Last sealed values — what the report/ledger/S5 see for this turn. */
  snapshot(): TaskErrorSnapshot {
    return { ...this.last }
  }

  private computeError(contract: ContractSnapshot): number | null {
    if (!contract.active) return null
    const countable = contract.assertions.filter(a => a.status !== 'skipped')
    if (countable.length === 0) return null
    const unmet = countable.filter(a => a.status === 'pending' || a.status === 'failed').length
    return unmet / countable.length
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/vsm/taskModel.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: p4-taskmodel
git add engine/vsm/taskModel.ts engine/__tests__/vsm/taskModel.test.ts
git commit -m "feat: TaskModel — external taskError from contract assertions + CUSUM errorTrend (P4.1)"
```

---

### Task 2: Governance wiring + report fields + report tests

**Files:**
- Modify: `engine/vsm/types.ts` (GovernanceReport, :46-67)
- Modify: `engine/vsm/cyberneticsGovernance.ts` (field ~:147, seal ~:384, report ~:686-690)
- Create: `engine/__tests__/vsm/taskErrorReport.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/vsm/taskErrorReport.test.ts`:

```typescript
// P4.1: GovernanceReport carries taskError + errorTrend, sealed per turn from
// the REAL globalContract. Must survive ablation — measurement organ, not
// authority organ (Phase 3 needs the series from ablated runs too). Pattern
// copied from varietyWindowedReport.test.ts (P1.5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

const TURN = {
  toolsCalled: 1,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 500,
  response: 'a sufficiently long response so no summary machinery misfires.',
}

describe('GovernanceReport.taskError/errorTrend (P4.1)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    globalContract.clear()
  })
  afterEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    globalContract.clear()
  })

  it('no contract → null; live contract → unmet fraction that falls as assertions pass', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBeNull()
    expect(gov.getReport().errorTrend).toBeNull()

    globalContract.create('demo', 'brief', ['a1', 'a2'])
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
    expect(gov.getReport().errorTrend).toBe('flat') // first observation seeds the EMA

    globalContract.assertPass(0, 'done')
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(0.5)
  })

  it('still measures when ablated (_ABLATION_VSM_DISABLED=1)', () => {
    process.env._ABLATION_VSM_DISABLED = '1'
    const gov = new CyberneticsGovernance()
    globalContract.create('demo', 'brief', ['a1'])
    // Ablated onTurnComplete returns early — but only AFTER the seal.
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
  })

  it('report values are per-turn sealed, not live reads', () => {
    const gov = new CyberneticsGovernance()
    globalContract.create('demo', 'brief', ['a1'])
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
    // Contract state changes mid-turn — report must not move until next seal.
    globalContract.assertPass(0)
    expect(gov.getReport().taskError).toBe(1)
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run engine/__tests__/vsm/taskErrorReport.test.ts`
Expected: FAIL — `taskError` is `undefined` on the report (property missing), not `null`.

- [ ] **Step 3: Implement**

**3a.** In `engine/vsm/types.ts`, inside `GovernanceReport` (after the `varietyWindowed: number` line at ~:53), add:

```typescript
  /** P4.1: fraction of unmet (pending|failed) contract assertions at turn
   *  seal, over countable (non-skipped) assertions; null when no active
   *  contract. Computed by the governor, never by the model (VI.3). */
  taskError: number | null
  /** P4.1: CUSUM alarm state over the taskError series; null with taskError. */
  errorTrend: 'rising' | 'falling' | 'flat' | null
```

**3b.** In `engine/vsm/cyberneticsGovernance.ts`:

Add the import (next to the other `./` imports at the top of the file):

```typescript
import { TaskModel } from './taskModel.js'
```

Add the field directly below `private windowedVariety = new WindowedVarietyMeter()` (~:147):

```typescript
  private taskModel = new TaskModel()
```

In `onTurnComplete()`, directly below `this.windowedVariety.onTurnComplete()` (~:384, still BEFORE the `if (this._ablated || this._paused)` return):

```typescript
    // P4.1: seal taskError/errorTrend from the global contract (before the
    // ablation return — measurement, not authority).
    this.taskModel.onTurnComplete()
```

In `getReport()`, directly below `varietyWindowed: this.windowedVariety.count(),` (~:690), add:

```typescript
      taskError: this.taskModel.snapshot().taskError,
      errorTrend: this.taskModel.snapshot().errorTrend,
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run engine/__tests__/vsm/taskErrorReport.test.ts engine/__tests__/vsm/taskModel.test.ts engine/__tests__/governanceTypes.test.ts`
Expected: all pass (3 + 6 + existing governanceTypes suite).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: p4-taskmodel
git add engine/vsm/types.ts engine/vsm/cyberneticsGovernance.ts engine/__tests__/vsm/taskErrorReport.test.ts
git commit -m "feat: governance seals TaskModel per turn; GovernanceReport carries taskError + errorTrend (P4.1)"
```

---

### Task 3: Protocol + emit + ledger + S5 input

**Files:**
- Modify: `engine/bridge/protocol.ts` (GovernanceStatusEvent, ~:217)
- Modify: `engine/bridge/conversationLoop.ts` (emit block, ~:1848-1869)
- Modify: `scripts/cynco-ledger.mjs` (collector ingest, ~:26-45)
- Modify: `engine/s5/types.ts` (S5Input, ~:3-32)
- Modify: `engine/s5/orchestrator.ts` (mapping, ~:56-84)
- Modify: `engine/__tests__/harness/cyncoLedger.test.ts` (append 2 tests)
- Modify (type-literal updates only): `engine/__tests__/governanceTypes.test.ts`, `engine/__tests__/s5/enforcement.test.ts`, `engine/__tests__/s5/orchestrator.test.ts`, `engine/__tests__/s5/promptDifficulty.test.ts`, `engine/__tests__/s5/modelS5.test.ts`, `engine/__tests__/s5/types.test.ts`, `engine/__tests__/s5/ruleBasedS5.test.ts`

- [ ] **Step 1: Write the failing ledger tests**

Append inside the top-level `describe` of `engine/__tests__/harness/cyncoLedger.test.ts` (after the last `it(...)`):

```typescript
  it('turn records carry taskError + errorTrend from governance.status (P4.1)', () => {
    const c = createMissionCollector(() => 42)
    c.ingest({ type: 'governance.status', health: 'healthy', taskError: 0.5, errorTrend: 'rising' })
    expect(c.turns[0].taskError).toBe(0.5)
    expect(c.turns[0].errorTrend).toBe('rising')
  })

  it('turn records default taskError + errorTrend to null when absent (P4.1)', () => {
    const c = createMissionCollector(() => 42)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].taskError).toBeNull()
    expect(c.turns[0].errorTrend).toBeNull()
  })
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run engine/__tests__/harness/cyncoLedger.test.ts`
Expected: the two new tests FAIL (`taskError` undefined on the turn record); all 18 pre-existing tests still pass.

- [ ] **Step 3: Implement the plumbing (four files)**

**3a.** `engine/bridge/protocol.ts` — inside `GovernanceStatusEvent`, directly above the `suggestion: string | null` line (~:218), add:

```typescript
  /** P4.1: unmet-assertion fraction at turn seal; null when no active
   *  contract. Mirrors GovernanceReport.taskError (file stays import-free). */
  taskError?: number | null
  /** P4.1: CUSUM alarm state over the taskError series — widened to string
   *  on the wire; do not copy the union here. */
  errorTrend?: string | null
```

**3b.** `engine/bridge/conversationLoop.ts` — in the `governance.status` emit (~:1850-1869), directly below `varietyWindowed: turnReport.varietyWindowed,`, add:

```typescript
                taskError: turnReport.taskError,
                errorTrend: turnReport.errorTrend,
```

**3c.** `scripts/cynco-ledger.mjs` — in the `case 'governance.status':` turn object (~:27-44), directly below `varietyWindowed: m.varietyWindowed ?? null,`, add:

```javascript
            taskError: m.taskError ?? null,
            errorTrend: m.errorTrend ?? null,
```

**3d.** `engine/s5/types.ts` — inside `S5Input`, directly below `promptDifficulty: DifficultyLevel` (~:31), add:

```typescript
  // P4.1: task homeostat — external DoD error + CUSUM trend (VI.3)
  taskError: number | null
  errorTrend: 'rising' | 'falling' | 'flat' | null
```

**3e.** `engine/s5/orchestrator.ts` — in the `makeDecision()` S5Input mapping, directly below the `observerDivergence:` line (~:80), add (typed access — `OrchestratorInput.governance` is `GovernanceReport`, which now carries both fields):

```typescript
      taskError: input.governance.taskError,
      errorTrend: input.governance.errorTrend,
```

**3f.** Update every test literal of the two widened types — add the two lines

```typescript
    taskError: null,
    errorTrend: null,
```

to each base object literal (exact sites, verified by grep):

- `GovernanceReport` literals: `engine/__tests__/governanceTypes.test.ts` :23, :47, :75, :217 (the :68 literal spreads :47 — no change); `engine/__tests__/s5/enforcement.test.ts` `makeGovernance` base object (:36); `engine/__tests__/s5/orchestrator.test.ts` `makeGovernance` base object (:7); `engine/__tests__/s5/promptDifficulty.test.ts` `govReport` literal (:16).
- `S5Input` literals: `engine/__tests__/governanceTypes.test.ts` :104, :135; `engine/__tests__/s5/modelS5.test.ts` `baseInput` (:7); `engine/__tests__/s5/types.test.ts` (:6); `engine/__tests__/s5/ruleBasedS5.test.ts` `baseInput` function's returned literal (:5).

(Line numbers may drift a line or two — match on the declaration, which is exact. If you find ADDITIONAL literal sites via `grep -rn ": GovernanceReport = {\|: S5Input = {\|Partial<GovernanceReport> = {}\|Partial<S5Input> = {}" engine/`, update those too and report the extras.)

- [ ] **Step 4: Run to verify all pass + no type breakage**

```bash
npx vitest run engine/__tests__/harness/cyncoLedger.test.ts
npx vitest run > /tmp/vitest-p4.log 2>&1; tail -6 /tmp/vitest-p4.log
```

Expected: cyncoLedger 20 passed; full suite **1900 passed / 33 skipped** (1889 + 6 taskModel + 3 taskErrorReport + 2 cyncoLedger).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: p4-taskmodel
git add engine/bridge/protocol.ts engine/bridge/conversationLoop.ts scripts/cynco-ledger.mjs engine/s5/types.ts engine/s5/orchestrator.ts engine/__tests__/harness/cyncoLedger.test.ts engine/__tests__/governanceTypes.test.ts engine/__tests__/s5/enforcement.test.ts engine/__tests__/s5/orchestrator.test.ts engine/__tests__/s5/promptDifficulty.test.ts engine/__tests__/s5/modelS5.test.ts engine/__tests__/s5/types.test.ts engine/__tests__/s5/ruleBasedS5.test.ts
git commit -m "feat: taskError + errorTrend plumbed report→protocol→ledger→S5 input (P4.1)"
```

---

### Task 4: STATE doc amendment

**Files:**
- Modify: `docs/STATE-AND-VISION-2026-07-12.md` (Phase 4 paragraph, ~:299)

- [ ] **Step 1: Amend Phase 4(b)/(c)**

In the Phase 4 paragraph, find the sentence beginning `**(b)** Compute per-turn task error` and insert immediately before `**(b)**`:

```
**(b/c core ✅ shipped 2026-07-14: `vsm/taskModel.ts` — taskError from globalContract at turn seal, CUSUM errorTrend, plumbed report→protocol→ledger→S5Input; survives ablation; remaining 4(b) signals + 4(a)/(d)/(e) pending)**
```

(Match on the `**(b)** Compute per-turn task error` anchor; do not otherwise alter the paragraph.)

- [ ] **Step 2: Commit**

```bash
git branch --show-current   # must print: p4-taskmodel
git add docs/STATE-AND-VISION-2026-07-12.md
git commit -m "docs: Phase 4 b/c core shipped — taskModel taskError + CUSUM errorTrend wired end to end"
```

---

### Task 5: BLOCKING wire check

- [ ] **Step 1: Greps — every new symbol imported AND called**

```bash
grep -n "TaskModel\|taskModel" engine/vsm/taskModel.ts engine/vsm/cyberneticsGovernance.ts | head
grep -n "taskError" engine/vsm/types.ts engine/bridge/protocol.ts engine/bridge/conversationLoop.ts scripts/cynco-ledger.mjs engine/s5/types.ts engine/s5/orchestrator.ts
grep -n "errorTrend" engine/bridge/conversationLoop.ts scripts/cynco-ledger.mjs engine/s5/orchestrator.ts
```

Expected: `TaskModel` defined in taskModel.ts, imported + instantiated + sealed (`onTurnComplete`) + read (`snapshot()`) in cyberneticsGovernance.ts; `taskError`/`errorTrend` present in ALL six plumbing files (type → protocol → emit → ledger → S5 type → S5 mapping). Any file missing = wiring gap = fix before shipping.

- [ ] **Step 2: Full suites green at expected counts (repo root)**

```bash
npx vitest run > /tmp/wire-p4.log 2>&1; tail -6 /tmp/wire-p4.log
```

Expected: **1900 passed / 33 skipped**. TUI untouched (protocol additions are optional fields) — no TUI run needed.

- [ ] **Step 3: Commit the plan file, then ship (git-web-flow)**

```bash
git branch --show-current   # must print: p4-taskmodel
git add -f docs/superpowers/plans/2026-07-14-p4-task-error.md
git commit -m "docs: P4.1 taskError implementation plan"
git push -u origin p4-taskmodel
gh pr create --title "P4.1: taskError + CUSUM errorTrend — the Task Homeostat core" --body "<summary + verification>"
# merge on GitHub, then:
git checkout main && git pull
```
