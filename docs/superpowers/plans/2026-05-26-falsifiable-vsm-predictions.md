# Falsifiable VSM Predictions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VSM governance scientifically provable with 8 falsifiable hypotheses, live prediction tracking in GovernanceDB, and an ablation benchmark framework for A/B testing.

**Architecture:** New `PredictionTracker` class integrated into `CyberneticsGovernance.onTurnComplete()`. Predictions stored in GovernanceDB `predictions` table. New `AblationRunner` class for structured governance vs no-governance comparison. Two new slash commands: `/governance report` and `/ablation run`.

**Tech Stack:** TypeScript (Bun), SQLite (GovernanceDB), Vitest

**Depends on:** Cybernetics Library Integration (Plan B) must be complete — needs `agreementRatio`, `observerDivergence`, `axiomHealth` fields.

---

### Task 1: Add predictions table to GovernanceDB

**Files:**
- Modify: `engine/vsm/governanceDb.ts`
- Test: `engine/__tests__/predictionDb.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/predictionDb.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GovernanceDB } from '../vsm/governanceDb.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('GovernanceDB predictions table', () => {
  let db: GovernanceDB
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gov-test-'))
    db = new GovernanceDB(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('recordPrediction inserts a row', () => {
    db.recordPrediction({
      sessionId: 'test-session',
      hypothesis: 'H1',
      triggerTurn: 5,
      triggerContext: JSON.stringify({ varietyBalance: 'critical' }),
      predictedOutcome: 'failure',
    })
    const preds = db.getPredictions('test-session')
    expect(preds.length).toBe(1)
    expect(preds[0].hypothesis).toBe('H1')
    expect(preds[0].correct).toBeNull()
  })

  it('evaluatePrediction updates outcome', () => {
    db.recordPrediction({
      sessionId: 'test-session',
      hypothesis: 'H2',
      triggerTurn: 3,
      triggerContext: '{}',
      predictedOutcome: 'stuck',
    })
    const preds = db.getPredictions('test-session')
    db.evaluatePrediction(preds[0].id, 'stuck', true, 8)
    const updated = db.getPredictions('test-session')
    expect(updated[0].correct).toBe(true)
    expect(updated[0].actualOutcome).toBe('stuck')
    expect(updated[0].evaluationTurn).toBe(8)
  })

  it('getHypothesisStats returns hit rate', () => {
    for (let i = 0; i < 10; i++) {
      db.recordPrediction({
        sessionId: `s-${i}`,
        hypothesis: 'H1',
        triggerTurn: 1,
        triggerContext: '{}',
        predictedOutcome: 'failure',
      })
    }
    const preds = db.getPredictions('s-0')
    // Evaluate 7 correct, 3 wrong
    const allPreds = db.getAllPredictions('H1')
    for (let i = 0; i < allPreds.length; i++) {
      db.evaluatePrediction(allPreds[i].id, 'failure', i < 7, i + 2)
    }
    const stats = db.getHypothesisStats('H1')
    expect(stats.total).toBe(10)
    expect(stats.correct).toBe(7)
    expect(stats.hitRate).toBeCloseTo(0.7, 2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/predictionDb.test.ts`
Expected: FAIL — recordPrediction, getPredictions, evaluatePrediction, getHypothesisStats don't exist

- [ ] **Step 3: Add predictions table and methods to GovernanceDB**

In `engine/vsm/governanceDb.ts`, add the predictions table to the constructor's CREATE TABLE statements:

```typescript
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        trigger_turn INTEGER NOT NULL,
        trigger_context TEXT,
        predicted_outcome TEXT NOT NULL,
        actual_outcome TEXT,
        correct INTEGER,
        evaluation_turn INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
```

Add the methods:

```typescript
  recordPrediction(record: {
    sessionId: string
    hypothesis: string
    triggerTurn: number
    triggerContext: string
    predictedOutcome: string
  }): void {
    this.db.run(
      `INSERT INTO predictions (session_id, hypothesis, trigger_turn, trigger_context, predicted_outcome)
       VALUES (?, ?, ?, ?, ?)`,
      [record.sessionId, record.hypothesis, record.triggerTurn, record.triggerContext, record.predictedOutcome],
    )
  }

  getPredictions(sessionId: string): any[] {
    return this.db.query(
      `SELECT id, session_id, hypothesis, trigger_turn, trigger_context, predicted_outcome, actual_outcome, correct, evaluation_turn
       FROM predictions WHERE session_id = ? ORDER BY id`,
    ).all(sessionId) as any[]
  }

  getAllPredictions(hypothesis: string): any[] {
    return this.db.query(
      `SELECT id, session_id, hypothesis, trigger_turn, trigger_context, predicted_outcome, actual_outcome, correct, evaluation_turn
       FROM predictions WHERE hypothesis = ? ORDER BY id`,
    ).all(hypothesis) as any[]
  }

  evaluatePrediction(id: number, actualOutcome: string, correct: boolean, evaluationTurn: number): void {
    this.db.run(
      `UPDATE predictions SET actual_outcome = ?, correct = ?, evaluation_turn = ? WHERE id = ?`,
      [actualOutcome, correct ? 1 : 0, evaluationTurn, id],
    )
  }

  getHypothesisStats(hypothesis: string): { total: number; correct: number; hitRate: number } {
    const row = this.db.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as correct
       FROM predictions WHERE hypothesis = ? AND correct IS NOT NULL`,
    ).get(hypothesis) as any
    const total = row?.total ?? 0
    const correct = row?.correct ?? 0
    return { total, correct, hitRate: total > 0 ? correct / total : 0 }
  }
```

- [ ] **Step 4: Run test**

Run: `cd engine && bunx vitest run __tests__/predictionDb.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/governanceDb.ts engine/__tests__/predictionDb.test.ts
git commit -m "feat(vsm): add predictions table to GovernanceDB for falsifiable hypothesis tracking"
```

---

### Task 2: Create PredictionTracker class

**Files:**
- Create: `engine/vsm/predictionTracker.ts`
- Test: `engine/__tests__/predictionTracker.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/predictionTracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { PredictionTracker, wilsonScore } from '../vsm/predictionTracker.js'
import type { GovernanceReport } from '../vsm/types.js'

describe('PredictionTracker', () => {
  const makeReport = (overrides: Partial<GovernanceReport> = {}): GovernanceReport => ({
    status: 'healthy',
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    s3s4Balance: 'balanced',
    algedonicAlerts: 0,
    stuckTurns: 0,
    consecutiveUnstable: 0,
    modelLatencyTrend: 'stable',
    toolSuccessRate: 0.8,
    agreementRatio: 0.9,
    observerDivergence: null,
    axiomHealth: { holding: 4, total: 4, violations: [] },
    ...overrides,
  })

  it('records a prediction for H1 when variety is critical', () => {
    const tracker = new PredictionTracker('test-session')
    const report = makeReport({ varietyBalance: 'overload' })
    tracker.checkTriggers(5, report, [])
    expect(tracker.openPredictions.length).toBe(1)
    expect(tracker.openPredictions[0].hypothesis).toBe('H1')
  })

  it('does not duplicate predictions for same hypothesis in same window', () => {
    const tracker = new PredictionTracker('test-session')
    const report = makeReport({ varietyBalance: 'overload' })
    tracker.checkTriggers(5, report, [])
    tracker.checkTriggers(6, report, [])
    // Should still be 1 — same hypothesis in evaluation window
    expect(tracker.openPredictions.length).toBe(1)
  })

  it('evaluates H1 after 3 turns', () => {
    const tracker = new PredictionTracker('test-session')
    // Trigger at turn 5
    tracker.checkTriggers(5, makeReport({ varietyBalance: 'overload' }), [])
    // Tools fail in turns 6-8
    const failResults = [
      { tool: 'Edit', success: false },
      { tool: 'Bash', success: false },
      { tool: 'Write', success: false },
    ]
    tracker.evaluateOpen(8, makeReport(), failResults)
    expect(tracker.openPredictions.length).toBe(0)
    expect(tracker.completedPredictions.length).toBe(1)
    expect(tracker.completedPredictions[0].correct).toBe(true) // > 60% failure
  })
})

describe('wilsonScore', () => {
  it('returns confidence interval for 70% hit rate with 100 samples', () => {
    const [lo, hi] = wilsonScore(70, 100, 0.05)
    expect(lo).toBeGreaterThan(0.5)
    expect(hi).toBeLessThan(0.85)
    expect(lo).toBeLessThan(0.7)
    expect(hi).toBeGreaterThan(0.7)
  })

  it('returns [0, 1] for 0 samples', () => {
    const [lo, hi] = wilsonScore(0, 0, 0.05)
    expect(lo).toBe(0)
    expect(hi).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/predictionTracker.test.ts`
Expected: FAIL — PredictionTracker doesn't exist

- [ ] **Step 3: Create PredictionTracker**

Create `engine/vsm/predictionTracker.ts`:

```typescript
import type { GovernanceReport } from './types.js'

export type Prediction = {
  hypothesis: string
  triggerTurn: number
  triggerContext: Record<string, unknown>
  predictedOutcome: string
  evaluationWindow: number // turns after trigger to evaluate
  correct?: boolean
  actualOutcome?: string
}

export type PredictionStats = {
  hypothesis: string
  total: number
  correct: number
  hitRate: number
  confidenceInterval: [number, number]
  nullBaselineRate: number
  significantlyBetter: boolean
}

// Null baseline rates for each hypothesis (from spec)
const NULL_BASELINES: Record<string, number> = {
  H1: 0.42, // "when tool failure rate > 40%, next tools also fail > 60%"
  H2: 0.38, // "3 turns without file changes predicts stuck"
  H3: 0.35, // "inject a nudge message when stuck"
  H4: 0.30, // "when tool failure rate > 30%, next turn also fails"
  H5: 0.50, // "sessions with fewer stuck turns complete more often"
  H6: 0.60, // "variables self-correct without perturbation"
  H7: 0.50, // "exclude the last-failed tool"
  H8: 0.20, // "sessions with > 5 tool failures are non-viable"
}

/**
 * Wilson score confidence interval for a proportion.
 * Better than normal approximation for small samples.
 */
export function wilsonScore(successes: number, total: number, alpha: number = 0.05): [number, number] {
  if (total === 0) return [0, 1]
  const z = alpha === 0.05 ? 1.96 : 2.576 // z-score for 95% or 99%
  const p = successes / total
  const denom = 1 + z * z / total
  const centre = p + z * z / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
  return [
    Math.max(0, (centre - margin) / denom),
    Math.min(1, (centre + margin) / denom),
  ]
}

export class PredictionTracker {
  readonly sessionId: string
  readonly openPredictions: Prediction[] = []
  readonly completedPredictions: Prediction[] = []
  private lastTriggerTurn: Record<string, number> = {}

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /** Check trigger conditions for all hypotheses. Call each turn. */
  checkTriggers(
    turn: number,
    report: GovernanceReport,
    recentToolResults: { tool: string; success: boolean }[],
  ): void {
    // H1: Variety-Task Mismatch
    if ((report.varietyBalance === 'overload' || (report.varietyBalance as string) === 'critical')
        && !this._isOpen('H1', turn, 3)) {
      this._record('H1', turn, { varietyBalance: report.varietyBalance }, 'failure', 3)
    }

    // H2: S3/S4 Imbalance → Stuck
    if (report.s3s4Balance !== 'balanced' && report.s3s4Balance !== 'critical'
        && !this._isOpen('H2', turn, 5)) {
      this._record('H2', turn, { s3s4Balance: report.s3s4Balance }, 'stuck', 5)
    }

    // H6: Homeostat Perturbation
    if (report.consecutiveUnstable > 0 && !this._isOpen('H6', turn, 3)) {
      this._record('H6', turn, { consecutiveUnstable: report.consecutiveUnstable }, 'viability_restored', 3)
    }

    // H8: Axiom Violations (session-level — checked at end)
    // Recorded here but evaluated at session end
    if (report.axiomHealth.violations.length >= 2 && !this._isOpen('H8', turn, 999)) {
      this._record('H8', turn, { axiomViolations: report.axiomHealth.violations }, 'non_viable', 999)
    }
  }

  /** Check trigger conditions that need the new signals from Plan B. */
  checkExtendedTriggers(
    turn: number,
    report: GovernanceReport,
    heterarchyChanged: boolean,
    isStuck: boolean,
  ): void {
    // H3: Heterarchy Authority Shift
    if (heterarchyChanged && isStuck && !this._isOpen('H3', turn, 3)) {
      this._record('H3', turn, { heterarchyShift: true }, 'recovery', 3)
    }

    // H4: Observer Divergence
    if (report.observerDivergence != null && report.observerDivergence > 0.2
        && !this._isOpen('H4', turn, 2)) {
      this._record('H4', turn, { observerDivergence: report.observerDivergence }, 'failure', 2)
    }

    // H5: Agreement Ratio (session-level — evaluated at end)
    // Not triggered per-turn; evaluated at session end
  }

  /** Evaluate open predictions. Call each turn. */
  evaluateOpen(
    turn: number,
    report: GovernanceReport,
    recentToolResults: { tool: string; success: boolean }[],
  ): void {
    const toRemove: number[] = []

    for (let i = 0; i < this.openPredictions.length; i++) {
      const pred = this.openPredictions[i]
      const turnsElapsed = turn - pred.triggerTurn

      if (turnsElapsed < pred.evaluationWindow) continue
      if (pred.evaluationWindow === 999) continue // session-level, skip

      let correct = false
      let actualOutcome = 'unknown'

      switch (pred.hypothesis) {
        case 'H1': {
          // Check if tool failure rate > 60% in the window
          const windowResults = recentToolResults.slice(-pred.evaluationWindow * 2)
          const failRate = windowResults.length > 0
            ? windowResults.filter(r => !r.success).length / windowResults.length
            : 0
          correct = failRate > 0.6
          actualOutcome = `failure_rate=${failRate.toFixed(2)}`
          break
        }
        case 'H2': {
          // Check if stuck state occurred
          correct = report.stuckTurns >= 5
          actualOutcome = `stuck_turns=${report.stuckTurns}`
          break
        }
        case 'H3': {
          // Check if recovery happened (file changes)
          correct = report.stuckTurns === 0
          actualOutcome = correct ? 'recovered' : 'still_stuck'
          break
        }
        case 'H4': {
          // Check if tool failure rate > 50% in the window
          const windowResults2 = recentToolResults.slice(-4)
          const failRate2 = windowResults2.length > 0
            ? windowResults2.filter(r => !r.success).length / windowResults2.length
            : 0
          correct = failRate2 > 0.5
          actualOutcome = `failure_rate=${failRate2.toFixed(2)}`
          break
        }
        case 'H6': {
          // Check if viability restored
          correct = report.consecutiveUnstable === 0
          actualOutcome = correct ? 'viable' : `unstable=${report.consecutiveUnstable}`
          break
        }
      }

      pred.correct = correct
      pred.actualOutcome = actualOutcome
      this.completedPredictions.push(pred)
      toRemove.push(i)
    }

    // Remove evaluated predictions (reverse order to preserve indices)
    for (const i of toRemove.reverse()) {
      this.openPredictions.splice(i, 1)
    }
  }

  /** Evaluate session-level predictions (H5, H7, H8). Call at session end. */
  evaluateSessionEnd(sessionOutcome: 'viable' | 'marginal' | 'non-viable', report: GovernanceReport): void {
    for (let i = this.openPredictions.length - 1; i >= 0; i--) {
      const pred = this.openPredictions[i]

      if (pred.hypothesis === 'H8') {
        pred.correct = sessionOutcome === 'non-viable'
        pred.actualOutcome = sessionOutcome
        this.completedPredictions.push(pred)
        this.openPredictions.splice(i, 1)
      }
    }

    // H5 is special — always recorded at session end
    if (report.agreementRatio > 0.7) {
      this.completedPredictions.push({
        hypothesis: 'H5',
        triggerTurn: 0,
        triggerContext: { agreementRatio: report.agreementRatio },
        predictedOutcome: 'viable',
        evaluationWindow: 0,
        correct: sessionOutcome === 'viable',
        actualOutcome: sessionOutcome,
      })
    } else if (report.agreementRatio < 0.4) {
      this.completedPredictions.push({
        hypothesis: 'H5',
        triggerTurn: 0,
        triggerContext: { agreementRatio: report.agreementRatio },
        predictedOutcome: 'non_viable',
        evaluationWindow: 0,
        correct: sessionOutcome !== 'viable',
        actualOutcome: sessionOutcome,
      })
    }
  }

  /** Get statistics for all hypotheses. */
  getStatistics(): PredictionStats[] {
    const hypotheses = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']
    return hypotheses.map(h => {
      const completed = this.completedPredictions.filter(p => p.hypothesis === h)
      const total = completed.length
      const correct = completed.filter(p => p.correct).length
      const hitRate = total > 0 ? correct / total : 0
      const ci = wilsonScore(correct, total)
      const nullRate = NULL_BASELINES[h] ?? 0.5
      return {
        hypothesis: h,
        total,
        correct,
        hitRate,
        confidenceInterval: ci,
        nullBaselineRate: nullRate,
        significantlyBetter: ci[0] > nullRate, // lower bound of CI above null rate
      }
    }).filter(s => s.total > 0)
  }

  private _record(hypothesis: string, turn: number, context: Record<string, unknown>, predicted: string, window: number): void {
    this.openPredictions.push({
      hypothesis,
      triggerTurn: turn,
      triggerContext: context,
      predictedOutcome: predicted,
      evaluationWindow: window,
    })
    this.lastTriggerTurn[hypothesis] = turn
  }

  private _isOpen(hypothesis: string, turn: number, window: number): boolean {
    // Don't trigger if there's already an open prediction for this hypothesis
    if (this.openPredictions.some(p => p.hypothesis === hypothesis)) return true
    // Don't trigger if we just triggered recently
    const lastTurn = this.lastTriggerTurn[hypothesis] ?? -999
    return (turn - lastTurn) < window
  }
}
```

- [ ] **Step 4: Run test**

Run: `cd engine && bunx vitest run __tests__/predictionTracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/predictionTracker.ts engine/__tests__/predictionTracker.test.ts
git commit -m "feat(vsm): add PredictionTracker with 8 falsifiable hypotheses and Wilson score CI"
```

---

### Task 3: Integrate PredictionTracker into governance

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts`

- [ ] **Step 1: Import and instantiate PredictionTracker**

In `engine/vsm/cyberneticsGovernance.ts`, add import:

```typescript
import { PredictionTracker } from './predictionTracker.js'
```

Add field:

```typescript
  private _predictionTracker: PredictionTracker
```

In constructor, after `this._sessionId` assignment:

```typescript
    this._predictionTracker = new PredictionTracker(this._sessionId)
```

- [ ] **Step 2: Wire into onTurnComplete**

At the end of `onTurnComplete()`, add:

```typescript
    // Prediction tracking — check triggers and evaluate open predictions
    const toolResults = this.toolHistory.slice(-10).map(t => ({ tool: t.name, success: t.success }))
    const govReport2 = this.getReport()
    this._predictionTracker.checkTriggers(this.turnCount, govReport2, toolResults)
    this._predictionTracker.evaluateOpen(this.turnCount, govReport2, toolResults)

    // Persist completed predictions to GovernanceDB
    if (this._db) {
      for (const pred of this._predictionTracker.completedPredictions) {
        if (pred.correct !== undefined) {
          try {
            this._db.recordPrediction({
              sessionId: this._sessionId,
              hypothesis: pred.hypothesis,
              triggerTurn: pred.triggerTurn,
              triggerContext: JSON.stringify(pred.triggerContext),
              predictedOutcome: pred.predictedOutcome,
            })
          } catch {}
        }
      }
    }
```

- [ ] **Step 3: Add getter for prediction stats**

```typescript
  /** Get prediction tracker for statistics. */
  getPredictionTracker(): PredictionTracker { return this._predictionTracker }
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts
git commit -m "feat(vsm): integrate PredictionTracker into governance turn lifecycle"
```

---

### Task 4: Add /governance report command

**Files:**
- Modify: `engine/main.ts`

- [ ] **Step 1: Add the command handler**

In `engine/main.ts`, in the command switch statement, add:

```typescript
    case 'governance': {
      const subCommand = (command as any).args?.trim() ?? ''
      if (subCommand === 'report' || subCommand === '') {
        const tracker = loop.getGovernance?.()?.getPredictionTracker?.()
        if (!tracker) {
          wsServer.emit({ type: 'stream.token', text: 'No prediction data available yet.\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }
        const stats = tracker.getStatistics()
        if (stats.length === 0) {
          wsServer.emit({ type: 'stream.token', text: 'No predictions evaluated yet. Run some sessions to collect data.\n' })
        } else {
          let table = 'Hypothesis | Samples | Hit Rate | Null Rate | Significant?\n'
          table += '-----------|---------|----------|-----------|-------------\n'
          for (const s of stats) {
            const sig = s.significantlyBetter ? 'YES' : 'NO'
            const ci = `[${s.confidenceInterval[0].toFixed(2)}, ${s.confidenceInterval[1].toFixed(2)}]`
            table += `${s.hypothesis.padEnd(10)} | ${String(s.total).padEnd(7)} | ${(s.hitRate * 100).toFixed(0)}% ${ci.padEnd(5)} | ${(s.nullBaselineRate * 100).toFixed(0)}%       | ${sig}\n`
          }
          wsServer.emit({ type: 'stream.token', text: table })
        }
        wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
      }
      break
    }
```

- [ ] **Step 2: Add to HELP_TEXT**

Find the HELP_TEXT or help command handler in main.ts and add:

```
/governance report  — Show falsifiable prediction hit rates with confidence intervals
```

- [ ] **Step 3: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/main.ts
git commit -m "feat(vsm): add /governance report command for prediction statistics"
```

---

### Task 5: Create AblationRunner

**Files:**
- Create: `engine/vsm/ablationRunner.ts`
- Test: `engine/__tests__/ablationRunner.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/ablationRunner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { AblationRunner, type AblationTestCase } from '../vsm/ablationRunner.js'

describe('AblationRunner', () => {
  it('loads test cases from JSON', () => {
    const runner = new AblationRunner()
    runner.addTestCase({
      name: 'Fix import error',
      task: 'Fix the import error in src/main.ts',
      expectedFiles: ['src/main.ts'],
      maxTurns: 15,
    })
    expect(runner.testCases.length).toBe(1)
    expect(runner.testCases[0].name).toBe('Fix import error')
  })

  it('generates comparison summary from results', () => {
    const runner = new AblationRunner()
    const summary = runner.summarize([
      {
        name: 'Test 1',
        governed: { turns: 8, toolSuccess: 0.9, filesChanged: 3, outcome: 'viable' },
        ungoverned: { turns: 12, toolSuccess: 0.6, filesChanged: 2, outcome: 'marginal' },
        winner: 'governed',
      },
      {
        name: 'Test 2',
        governed: { turns: 10, toolSuccess: 0.7, filesChanged: 2, outcome: 'viable' },
        ungoverned: { turns: 10, toolSuccess: 0.7, filesChanged: 2, outcome: 'viable' },
        winner: 'tied',
      },
    ])
    expect(summary.governedWinRate).toBe(0.5)
    expect(summary.tiedRate).toBe(0.5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/ablationRunner.test.ts`
Expected: FAIL — AblationRunner doesn't exist

- [ ] **Step 3: Create AblationRunner**

Create `engine/vsm/ablationRunner.ts`:

```typescript
export type AblationTestCase = {
  name: string
  task: string
  expectedFiles: string[]
  maxTurns: number
}

export type AblationTestResult = {
  name: string
  governed: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  ungoverned: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  winner: 'governed' | 'ungoverned' | 'tied'
}

export type AblationSummary = {
  governedWinRate: number
  ungovernedWinRate: number
  tiedRate: number
  governedAvgTurns: number
  ungovernedAvgTurns: number
  governedAvgSuccess: number
  ungovernedAvgSuccess: number
}

export class AblationRunner {
  readonly testCases: AblationTestCase[] = []

  addTestCase(testCase: AblationTestCase): void {
    this.testCases.push(testCase)
  }

  loadFromJson(json: string): void {
    const cases = JSON.parse(json) as AblationTestCase[]
    for (const c of cases) {
      this.addTestCase(c)
    }
  }

  summarize(results: AblationTestResult[]): AblationSummary {
    if (results.length === 0) {
      return {
        governedWinRate: 0, ungovernedWinRate: 0, tiedRate: 0,
        governedAvgTurns: 0, ungovernedAvgTurns: 0,
        governedAvgSuccess: 0, ungovernedAvgSuccess: 0,
      }
    }
    const govWins = results.filter(r => r.winner === 'governed').length
    const ungovWins = results.filter(r => r.winner === 'ungoverned').length
    const tied = results.filter(r => r.winner === 'tied').length
    const n = results.length

    return {
      governedWinRate: govWins / n,
      ungovernedWinRate: ungovWins / n,
      tiedRate: tied / n,
      governedAvgTurns: results.reduce((s, r) => s + r.governed.turns, 0) / n,
      ungovernedAvgTurns: results.reduce((s, r) => s + r.ungoverned.turns, 0) / n,
      governedAvgSuccess: results.reduce((s, r) => s + r.governed.toolSuccess, 0) / n,
      ungovernedAvgSuccess: results.reduce((s, r) => s + r.ungoverned.toolSuccess, 0) / n,
    }
  }

  formatReport(results: AblationTestResult[], summary: AblationSummary): string {
    let out = 'Ablation Report\n'
    out += '===============\n\n'
    out += 'Test Case          | Governed    | Ungoverned  | Winner\n'
    out += '-------------------|-------------|-------------|----------\n'
    for (const r of results) {
      const govStr = `${r.governed.turns}t ${(r.governed.toolSuccess * 100).toFixed(0)}%`
      const ungovStr = `${r.ungoverned.turns}t ${(r.ungoverned.toolSuccess * 100).toFixed(0)}%`
      out += `${r.name.padEnd(18)} | ${govStr.padEnd(11)} | ${ungovStr.padEnd(11)} | ${r.winner}\n`
    }
    out += '\n'
    out += `Summary: Governed wins ${(summary.governedWinRate * 100).toFixed(0)}%, `
    out += `Ungoverned wins ${(summary.ungovernedWinRate * 100).toFixed(0)}%, `
    out += `Tied ${(summary.tiedRate * 100).toFixed(0)}%\n`
    out += `Avg turns: Governed ${summary.governedAvgTurns.toFixed(1)}, Ungoverned ${summary.ungovernedAvgTurns.toFixed(1)}\n`
    out += `Avg tool success: Governed ${(summary.governedAvgSuccess * 100).toFixed(0)}%, Ungoverned ${(summary.ungovernedAvgSuccess * 100).toFixed(0)}%\n`
    return out
  }
}
```

- [ ] **Step 4: Run test**

Run: `cd engine && bunx vitest run __tests__/ablationRunner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/ablationRunner.ts engine/__tests__/ablationRunner.test.ts
git commit -m "feat(vsm): add AblationRunner for structured governance A/B testing"
```

---

### Task 6: Wire check

- [ ] **Step 1: Verify PredictionTracker is instantiated in governance**

```bash
cd engine && grep -n "PredictionTracker\|predictionTracker" vsm/cyberneticsGovernance.ts
```

Expected: import, field, constructor instantiation, onTurnComplete usage, getter

- [ ] **Step 2: Verify predictions table exists in GovernanceDB**

```bash
cd engine && grep -n "predictions" vsm/governanceDb.ts
```

Expected: CREATE TABLE, recordPrediction, getPredictions, evaluatePrediction, getHypothesisStats

- [ ] **Step 3: Verify /governance command in main.ts**

```bash
cd engine && grep -n "governance.*report\|case.*governance" main.ts
```

Expected: command handler for 'governance' with 'report' subcommand

- [ ] **Step 4: Verify /governance in HELP_TEXT**

```bash
cd engine && grep -n "governance" main.ts | grep -i "help\|HELP"
```

Expected: entry in help text

- [ ] **Step 5: Run full test suite**

```bash
cd engine && bunx vitest run
cd tui && python -m pytest tests/ -v
```

Expected: ALL tests pass

- [ ] **Step 6: Commit wire check**

```bash
git commit --allow-empty -m "test: wire check — falsifiable VSM predictions verified end-to-end"
```
