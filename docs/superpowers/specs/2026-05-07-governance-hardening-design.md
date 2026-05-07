# Governance Hardening: From Thesis to Proof

**Date:** 2026-05-07
**Status:** Design approved
**Branch:** TBD (from feat/deep-research)

---

## Problem

CynCo's VSM cybernetics architecture calculates rich governance signals — variety balance, homeostatic stability, drift detection, heterarchy authority, performance metrics — but ~80% of them are decorative. They're injected into the system prompt as advisory text the model can ignore, or logged without enforcement. The gap between what CynCo's governance *computes* and what it *enforces* means the architecture is a thesis, not a proof.

Competitors have simpler architectures (flat agent loops) but their safety mechanisms — Docker sandboxing (OpenHands), human-in-the-loop approval (Cline), git-commit undo (Aider) — are 100% enforced. CynCo's governance must be equally real.

## Goal

Make every governance signal either enforce behavioral change, surface an actionable recommendation to the user, or feed the training pipeline. No signal should exist only as system prompt text. S5 becomes the single enforcer — the conversation loop obeys S5 unconditionally.

## Success Criteria

- S5Decision.tools hard-filters the tool set (tools not in the list are unavailable, not just deprioritized)
- Every field of S5Decision is enforced by the conversation loop
- RuleBasedS5 has rules for every governance signal, tiered as critical/warning/info
- Warning-tier recommendations are visible in the TUI with accept/dismiss
- Dismissed recommendations are logged as negative training signal
- Advisory prompt injection is removed for all governed signals
- S2 agent kill decisions actually kill agents
- S5 rule weights adjust across sessions based on outcomes
- All existing tests pass; new tests cover enforcement paths

## Non-Goals

- LoRA fine-tuning pipeline for ModelS5 (data format is locked, training is out of scope)
- TUI visual design for governance notifications (use existing approval UI pattern)
- New governance signals (we harden what exists, not add new ones)

---

## Design

### 1. S5 Decision Enforcement in the Conversation Loop

The conversation loop unconditionally respects every field of S5Decision.

| S5Decision field | Current behavior | New behavior |
|-----------------|-----------------|-------------|
| `tools` | Reorder only, never remove | **Hard filter** — only listed tools available. `null` = all tools. |
| `model` | Ignored | **Switch model** via `loop.updateModel()` before next turn. |
| `contextAction` | `compact` works, `warn` ignored | `compact` = force compaction. `warn` = emit `context.warning` to TUI. |
| `spawnAgent` | Ignored | **Spawn agent** with specified task and tools. |
| `priority` | Logged | Inject as binding system prompt directive, not suggestion. |
| `revert` | Ignored | **Trigger snapshot revert.** Surface confirmation to TUI first (warning-tier). |
| `workflow` | Ignored | **Start workflow** via `loop.startWorkflow()`. |

**Key implementation detail:** The comment `// log but NEVER restrict tools` and the line `iterationTools = toolDefs` are replaced with:

```typescript
if (s5Decision.tools) {
  const allowed = new Set(s5Decision.tools)
  iterationTools = toolDefs.filter(t => allowed.has(t.name))
}
```

Tool filtering must happen AFTER workflow tool filtering (workflow phase restrictions take precedence if active) but BEFORE the model call.

### 2. Hardened RuleBasedS5

Expand from ~6 rules to ~20, organized by enforcement tier.

#### Critical Tier (auto-enforce, no user approval)

| ID | Signal | Condition | S5Decision |
|----|--------|-----------|------------|
| C1 | Kill switch active | `governance.status === 'halted'` | `tools: ['Read', 'Glob', 'Grep', 'Ls']` |
| C2 | Consecutive tool failures | 3+ recent failures in same tool | `tools: exclude(failingTool)` |
| C3 | Context overflow | `contextUsage >= 0.90` | `contextAction: 'compact'` |
| C4 | Doom loop detected | 3+ identical tool calls with same args | `tools: exclude(loopingTool)` |
| C5 | Agent resource exhaustion | GPU util > 0.95 for 3+ turns | `spawnAgent: null` (block new agents), signal S2 to kill lowest-priority queued agent |
| C6 | Variety critical imbalance | `varietyBalance === 'critical'` | `tools: top-5 by recent success rate` |

#### Warning Tier (surface to TUI via governance.recommendation)

| ID | Signal | Condition | Proposed S5Decision |
|----|--------|-----------|---------------------|
| W1 | Context pressure | `contextUsage >= 0.75` | `contextAction: 'warn'` |
| W2 | Model switch | `modelLatencyTrend === 'rising'` for 5+ turns AND alternative available | `model: alternativeModel` |
| W3 | Workspace revert | `stuckTurns >= 5 AND toolSuccessRate < 0.5` | `revert: true` |
| W4 | Drift detected | CUSUM signals degradation | `contextAction: 'compact'` + `tools: exclude tools with >50% failure rate in drift window` |
| W5 | Homeostatic instability | `homeostatStable === false` for 3+ consecutive checks | If S3 pressure > S4: `priority: 's4'`. If S4 > S3: `priority: 's3'`. Else: `contextAction: 'compact'` |
| W6 | S3/S4 imbalance | `s3s4Balance` dominant for 5+ turns | If S3-heavy: `spawnAgent: {task: 'scout for broader context'}`. If S4-heavy: `priority: 's3'` |
| W7 | Tool mode mismatch | `recommendedToolMode` disagrees with actual usage for 3+ turns | `tools: recommended set` |

#### Info Tier (journal only)

| ID | Signal | Condition | Action |
|----|--------|-----------|--------|
| I1 | Variety balance shift | Any change in `varietyBalance` | Log governance snapshot |
| I2 | Homeostatic adjustment | Weight perturbation triggered | Log perturbation details |
| I3 | Performance metric update | Each turn | Log actuality/capability/potentiality |
| I4 | Heterarchy authority change | Authority shift | Log authority + context |
| I5 | Structural coupling drift | Pearson correlation shift | Log correlation delta |

**Rule conflict resolution:** When multiple rules fire, the highest-tier wins (critical > warning > info). Within a tier, rules combine: tool restrictions intersect (most restrictive wins), context actions take the strongest (compact > warn > none).

**Rule weights:** Each rule has a weight (default 1.0) loaded from `~/.cynco/training/s5-weights.json`. When multiple warning-tier rules fire, highest-weight rule's recommendation is surfaced first. Weights adjust across sessions (see Section 6).

### 3. TUI Governance Recommendation Event

New protocol event for warning-tier actions:

```typescript
export type GovernanceRecommendationEvent = {
  type: 'governance.recommendation'
  requestId: string
  severity: 'warning'
  signal: string              // e.g. 'drift_detected', 'model_switch', 'revert'
  title: string               // "Performance Drift Detected"
  description: string         // what's happening and why
  action: Partial<S5Decision> // the proposed decision
  autoApplyAfterMs?: number   // auto-apply if user doesn't respond (null = wait forever)
}
```

Added to the `EngineEvent` union type.

User responds via existing `approval.response` mechanism. `approved: true` = apply the partial S5Decision. `approved: false` = dismiss and log as negative outcome.

`autoApplyAfterMs` values:
- Context compaction warnings: 30000 (30s)
- Model switch: null (wait for user)
- Revert: null (wait for user)
- All others: 60000 (60s)

### 4. Signal Rewiring — Remove Advisory Prompt Injection

**Remove from system prompt generation** (conversationLoop.ts, lines ~570-620):
- Variety balance warning text
- Homeostatic stability warning text
- Heterarchy authority suggestions
- Performance metrics alerts ("PERFORMANCE ALERT", "DRIFT DETECTED")
- Drift detection alerts
- Tool mode recommendations
- Stuck turns "try different approach" text

**Add to S5Input** (new fields):
```typescript
varietyBalance: 'balanced' | 'underload' | 'overload' | 'critical'
varietyRatio: number
homeostatStable: boolean
homeostatConsecutiveUnstable: number
driftDetected: boolean
driftDirection: 'improving' | 'degrading' | null
performanceHealth: 'healthy' | 'warning' | 'critical'
productivityRatio: number
recommendedToolMode: string | null
heterarchyAuthority: 's3' | 's4' | 's5' | null
```

These fields are populated from `CyberneticsGovernance` before each S5 decision call. S5 rules consume them and produce enforcement decisions. The system prompt stays clean.

**Exception:** `context.status` event (utilization bar in TUI sidebar) stays — it's user visibility, not governance.

### 5. S2 Algedonic Action Enforcement

The S2 coordinator holds references to active SubAgent instances (not just IDs).

| S2 Decision | Current | New |
|-------------|---------|-----|
| `absorb` | Log only | No change (correct behavior) |
| `escalate` | Log only | Emit `governance.recommendation` to TUI with agent status, stuck details, and proposed action (kill or continue). |
| `kill` | Log only | Call `agent.abort()`, emit `subagent.killed` event, free resources, call `drainQueue()`. |

**Implementation:** `S2Coordinator.registerAgent()` accepts the SubAgent instance (not just config). `handleAlgedonic()` uses the instance reference to abort when `decision === 'kill'`.

### 6. Closed-Loop Training

#### 6a: Outcome Backfill

Each S5 decision is assigned a `decisionId` (UUID). At end-of-turn, the conversation loop evaluates the outcome:

| Decision type | Positive outcome | Negative outcome |
|---------------|-----------------|-----------------|
| Tool restriction | Stuck turns decreased, success rate increased | Stuck turns same or increased |
| Context compaction | Conversation continued, no repeated compaction needed | Immediate re-compaction triggered |
| Model switch | Latency decreased | Latency same or increased |
| Agent spawn | Agent completed successfully | Agent stuck or killed |
| User dismissed recommendation | — | Always negative for that rule |

Outcomes are written to the decision journal via `journal.backfill(decisionId, outcome)`.

#### 6b: Rule Weight Tuning

File: `~/.cynco/training/s5-weights.json`
```json
{
  "C1": 1.0, "C2": 1.0, ...,
  "W1": 1.0, "W2": 1.0, ...,
  "I1": 1.0, ...
}
```

At session end, weights adjust:
- Positive outcome: weight += 0.1
- User dismissed: weight -= 0.1
- Negative outcome: weight -= 0.2
- Clamped to [0.1, 2.0]

Loaded at startup. When multiple warning-tier rules fire, highest weight wins.

Critical-tier rules always have effective weight = Infinity (they always fire regardless of learned weight). Info-tier rules don't have weights (they always log).

#### 6c: ModelS5 Training Gate

At startup, count decision journal entries with outcomes. Log thresholds:
- 50+: `[v2] {count} S5 decisions with outcomes — journal accumulating`
- 200+: `[v2] {count} S5 decisions — extraction pipeline ready`
- 500+: `[v2] {count} S5 decisions — LoRA fine-tuning ready. Run cynco-train-s5.`

The journal format is the locked training format: `{ input: S5Input, decision: S5Decision, outcome: OutcomeScore }`.

---

## Files Modified

| File | Change |
|------|--------|
| `engine/bridge/conversationLoop.ts` | S5 enforcement, remove prompt injection, outcome backfill |
| `engine/s5/ruleBasedS5.ts` | Expand to 20 rules, three tiers, rule weights |
| `engine/s5/types.ts` | Add new S5Input fields, rule weight types |
| `engine/s5/orchestrator.ts` | Decision ID tracking, outcome backfill |
| `engine/s5/ruleWeights.ts` | New: load/save/adjust weights |
| `engine/bridge/protocol.ts` | Add GovernanceRecommendationEvent |
| `engine/vsm/cyberneticsGovernance.ts` | Export new S5Input fields from governance report |
| `engine/agents/s2Coordinator.ts` | Hold agent refs, enforce kill/escalate |
| `engine/agents/subAgent.ts` | Add abort() method if missing |
| `engine/training/decisionJournal.ts` | Outcome backfill method |

## New Files

| File | Purpose |
|------|---------|
| `engine/s5/ruleWeights.ts` | Load/save/adjust rule weights across sessions |
| `engine/__tests__/s5/ruleBasedS5.test.ts` | Tests for all 20 rules |
| `engine/__tests__/s5/enforcement.test.ts` | Tests for conversation loop enforcement |
| `engine/__tests__/s5/ruleWeights.test.ts` | Tests for weight tuning |
| `engine/__tests__/s5/outcomeBackfill.test.ts` | Tests for outcome evaluation |

## Testing Strategy

- Unit tests for each S5 rule (input → expected decision)
- Unit tests for tool filtering logic
- Unit tests for rule weight loading, adjustment, clamping
- Unit tests for outcome evaluation (positive/negative classification)
- Integration test: mock governance signals → S5 decision → verify conversation loop actually restricts tools
- Integration test: warning-tier rule fires → governance.recommendation event emitted
- Integration test: S2 kill decision → agent.abort() called
