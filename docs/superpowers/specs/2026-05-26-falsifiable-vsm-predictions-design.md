# Falsifiable VSM Predictions

**Date:** 2026-05-26
**Status:** Approved
**Depends on:** Cybernetics Library Integration (Spec B) must be complete first
**Scope:** Define testable hypotheses, live prediction tracking, ablation benchmark framework

## Problem

The investor critique: *"Show one thing VSM does that error counters can't."* Every current governance behavior is three if-statements. The VSM layer needs falsifiable predictions — specific claims about system behavior that can be proven or disproven with data. Without this, cybernetic governance is just branding.

## Solution: Three Components

### 1. Falsifiable Hypotheses

Define 8 predictions the governance system makes. Each has:
- **Claim**: A specific, measurable statement
- **Trigger condition**: When to evaluate
- **Success criteria**: How to measure
- **Null hypothesis**: What simple counters would predict instead

#### H1: Variety-Task Mismatch Predicts Failure
**Claim:** When variety balance is `critical` or `overload`, the next 3 tool calls fail at a rate > 60% (vs baseline ~25%).
**Trigger:** `varietyBalance` transitions to `critical` or `overload`.
**Measure:** Tool success rate in the 3 turns following the transition.
**Null:** Simple counter: "when tool failure rate > 40%, next tools also fail > 60%." (Tests whether variety adds signal beyond raw failure rate.)

#### H2: S3/S4 Imbalance Predicts Stuck States
**Claim:** When `s3s4Balance` is `s3_dominant` or `s4_dominant` for 3+ consecutive turns, the session enters a stuck state (5+ turns with no file changes) within 5 turns, at a rate > 50%.
**Trigger:** 3 consecutive turns of imbalanced S3/S4.
**Measure:** Whether stuck state occurs within 5 turns.
**Null:** Simple counter: "3 turns without file changes predicts stuck within 5 turns." (Tests whether S3/S4 balance adds signal beyond activity tracking.)

#### H3: Heterarchy Authority Shift Improves Recovery
**Claim:** When the system is stuck and heterarchy shifts commander from S3 to S5 (crisis mode), recovery (file change within 3 turns) occurs > 70% of the time, vs < 40% without the shift.
**Trigger:** Stuck state detected + heterarchy commander changes.
**Measure:** Whether file changes resume within 3 turns.
**Null:** Simple counter: "inject a nudge message when stuck for 3 turns." (Tests whether authority-aware tool restriction beats generic nudges.)
**Depends on:** Spec B Step 6 (heterarchy wired).

#### H4: Observer Divergence Precedes Errors
**Claim:** When S3 and S4 disagree on success rate (divergence > 0.2), the next 2 turns have tool failure rate > 50%, vs < 25% when observers agree.
**Trigger:** `observerDivergence` exceeds 0.2.
**Measure:** Tool failure rate in next 2 turns.
**Null:** Simple counter: "when tool failure rate > 30% in last turn, next turn also fails." (Tests whether dual-observer perspective detects issues that single metrics miss.)
**Depends on:** Spec B Step 8 (observer effects wired).

#### H5: Agreement Ratio Predicts Task Completion
**Claim:** Sessions with `agreementRatio` > 0.7 complete their stated goal > 80% of the time, vs < 50% for sessions with ratio < 0.4.
**Trigger:** Session end.
**Measure:** Correlation between final agreementRatio and session outcome (viable/marginal/non-viable).
**Null:** Simple counter: "sessions with fewer stuck turns complete more often." (Tests whether user-system alignment predicts outcomes beyond raw productivity.)
**Depends on:** Spec B Step 7 (conversation theory wired).

#### H6: Homeostat Perturbation Restores Viability
**Claim:** When SessionHomeostat detects essential variable breach and perturbs parameters, viability is restored within 3 turns > 60% of the time.
**Trigger:** `SessionHomeostat.update()` returns `perturbed: true`.
**Measure:** Whether essential variables return to viable bounds within 3 turns.
**Null:** Simple counter: "do nothing when variables breach — they self-correct > 60% of the time anyway." (Tests whether perturbation actively helps vs natural variance.)

#### H7: Algedonic Kill Switch Prevents Cascading Failure
**Claim:** When the kill switch activates (5 consecutive pain signals), allowing the session to continue without the failing tool prevents further failures > 80% of the time, vs > 50% continued failure rate without the switch.
**Trigger:** Kill switch activation.
**Measure:** Tool failure rate in the 5 turns after kill switch (with restricted tools) vs ablated baseline.
**Null:** Simple counter: "exclude the last-failed tool." (Tests whether the full algedonic channel with severity routing beats simple tool exclusion.)

#### H8: Axiom Violations Correlate with Non-Viable Sessions
**Claim:** Sessions where 2+ Beer axioms are violated at any point end as `non-viable` > 70% of the time, vs < 20% for sessions with 0 violations.
**Trigger:** Session end.
**Measure:** Correlation between max axiom violations during session and session outcome.
**Null:** Simple counter: "sessions with > 5 tool failures are non-viable." (Tests whether formal cybernetic axiom checking predicts viability beyond error counting.)
**Depends on:** Spec B Step 10 (axiom checks wired).

### 2. Live Prediction Tracking

**Schema addition to GovernanceDB:**

New table `predictions`:
```sql
CREATE TABLE predictions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,          -- 'H1', 'H2', ..., 'H8'
  trigger_turn INTEGER NOT NULL,     -- turn where prediction was made
  trigger_context TEXT,              -- JSON: the governance state at trigger time
  predicted_outcome TEXT NOT NULL,   -- 'failure', 'stuck', 'recovery', etc.
  actual_outcome TEXT,               -- filled in when evaluation window closes
  correct BOOLEAN,                   -- was the prediction right?
  evaluation_turn INTEGER,           -- turn where outcome was measured
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**PredictionTracker class** (`engine/vsm/predictionTracker.ts`):

```typescript
class PredictionTracker {
  // Called by CyberneticsGovernance when trigger conditions are met
  recordPrediction(hypothesis: string, turn: number, context: object, predicted: string): void
  
  // Called each turn to check if any open predictions can be evaluated
  evaluateOpenPredictions(turn: number, currentState: GovernanceReport): void
  
  // Returns prediction statistics for /governance report command
  getStatistics(): PredictionStats[]
  
  // Returns per-hypothesis hit rate with confidence interval
  getHypothesisReport(hypothesis: string): HypothesisReport
}

type PredictionStats = {
  hypothesis: string
  total: number
  correct: number
  hitRate: number
  confidenceInterval: [number, number]  // Wilson score interval
  nullBaselineRate: number              // what simple counters predict
  significantlyBetter: boolean          // hitRate > nullBaselineRate at p < 0.05
}
```

**Integration into CyberneticsGovernance:**
- `onTurnComplete()`: check trigger conditions for each hypothesis, record predictions, evaluate open predictions
- `getReport()`: include prediction summary (active predictions count, recent hit rates)
- Session end: evaluate all remaining open predictions with available data

**`/governance report` command:**
Outputs a table:
```
Hypothesis | Samples | Hit Rate | Null Rate | Significant?
H1 Variety | 23      | 68%      | 42%       | YES (p=0.02)
H2 S3/S4   | 15      | 53%      | 38%       | NO  (p=0.18)
H3 Heterar  | 8      | 75%      | 35%       | YES (p=0.04)
...
```

### 3. Ablation Benchmark Framework

**Purpose:** Run identical tasks with and without governance, compare outcomes.

**Existing infrastructure:**
- `_ABLATION_VSM_DISABLED=1` already disables governance (line 136 of cyberneticsGovernance.ts)
- GovernanceDB records session outcomes
- Decision journals record all decisions

**New: AblationRunner** (`engine/vsm/ablationRunner.ts`):

```typescript
class AblationRunner {
  // Define a test case: task description + expected outcome
  addTestCase(name: string, task: string, expectedFiles: string[], maxTurns: number): void
  
  // Run all test cases twice: governance ON, governance OFF
  // Returns comparison report
  run(): Promise<AblationReport>
}

type AblationReport = {
  testCases: AblationTestResult[]
  summary: {
    governedWinRate: number      // % of cases where governed was better
    ungovernedWinRate: number
    tiedRate: number
    governedAvgTurns: number
    ungovernedAvgTurns: number
    governedAvgSuccess: number
    ungovernedAvgSuccess: number
  }
}

type AblationTestResult = {
  name: string
  governed: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  ungoverned: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  winner: 'governed' | 'ungoverned' | 'tied'
}
```

**`/ablation run` command:**
- Accepts a test suite file (JSON array of test cases)
- Runs each case twice (governed + ungoverned) in isolated worktrees
- Stores results in GovernanceDB
- Prints comparison table

**Test suite format:**
```json
[
  {
    "name": "Fix import error",
    "task": "Fix the import error in src/main.ts — the module './utils' doesn't export 'formatDate'",
    "expectedFiles": ["src/main.ts", "src/utils.ts"],
    "maxTurns": 15
  },
  {
    "name": "Add search feature",
    "task": "Add a search bar to the header component that filters the item list",
    "expectedFiles": ["src/components/Header.tsx", "src/components/ItemList.tsx"],
    "maxTurns": 30
  }
]
```

## Files Changed

| File | Change |
|------|--------|
| `engine/vsm/predictionTracker.ts` | **New:** PredictionTracker class with hypothesis evaluation |
| `engine/vsm/ablationRunner.ts` | **New:** AblationRunner for A/B governance testing |
| `engine/vsm/governanceDb.ts` | Add predictions table, prediction query methods |
| `engine/vsm/cyberneticsGovernance.ts` | Integrate PredictionTracker into onTurnComplete + session end |
| `engine/vsm/types.ts` | Add prediction stats to GovernanceReport |
| `engine/main.ts` | Add `/governance report` and `/ablation run` commands |

## Testing

- **Unit tests:** Each hypothesis trigger/evaluation function tested with mock governance states
- **Integration test:** Run a short session, verify predictions are recorded and evaluated
- **Ablation test:** Run 2 test cases with/without governance, verify comparison report generated
- **Statistics test:** Verify Wilson score confidence interval calculation is correct

## Wire Check

- [ ] PredictionTracker is created in CyberneticsGovernance constructor
- [ ] Each hypothesis trigger condition is checked in onTurnComplete
- [ ] Open predictions are evaluated each turn
- [ ] Predictions are persisted to GovernanceDB predictions table
- [ ] `/governance report` command is in main.ts handler AND in HELP_TEXT
- [ ] `/ablation run` command is in main.ts handler AND in HELP_TEXT
- [ ] Ablation results are stored in GovernanceDB
- [ ] PredictionStats appears in governance report events to TUI
