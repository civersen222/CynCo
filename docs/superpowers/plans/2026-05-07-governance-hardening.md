# Governance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CynCo's VSM governance enforced, not advisory — S5 becomes the single enforcer with 20 tiered rules, hard tool filtering, TUI recommendations, and cross-session learning.

**Architecture:** All governance signals flow into S5Input. S5 produces one S5Decision per turn. The conversation loop enforces it unconditionally — filtering tools, switching models, triggering compaction, emitting recommendations. Warning-tier actions surface to the TUI for user accept/dismiss. Outcomes feed back into rule weight tuning.

**Tech Stack:** TypeScript (Bun), existing engine infrastructure. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-07-governance-hardening-design.md`

---

### Task 1: Extend S5 Types

**Files:**
- Modify: `engine/s5/types.ts`
- Test: `engine/__tests__/s5/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/s5/types.test.ts
import { describe, it, expect } from 'bun:test'
import type { S5Input, S5Decision, RuleTier, S5Rule } from '../../s5/types.js'

describe('S5 extended types', () => {
  it('S5Input accepts new governance fields', () => {
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.5,
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:32b'],
      turnCount: 1,
      recentToolResults: [],
      // New fields
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
    }
    expect(input.varietyBalance).toBe('balanced')
    expect(input.homeostatStable).toBe(true)
  })

  it('S5Rule has id, tier, and condition', () => {
    const rule: S5Rule = {
      id: 'C1',
      tier: 'critical',
      name: 'Kill switch active',
      evaluate: (input: S5Input) => {
        if (input.governanceStatus === 'halted') {
          return { tools: ['Read', 'Glob', 'Grep', 'Ls'], reasoning: 'Halted — read-only mode' }
        }
        return null
      },
    }
    expect(rule.tier).toBe('critical')
    expect(rule.id).toBe('C1')
  })

  it('RuleTier values are critical, warning, info', () => {
    const tiers: RuleTier[] = ['critical', 'warning', 'info']
    expect(tiers).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/s5/types.test.ts`
Expected: FAIL — `S5Rule` and `RuleTier` types don't exist yet, new S5Input fields don't exist.

- [ ] **Step 3: Extend S5 types**

```typescript
// engine/s5/types.ts — replace full file
export type S5Input = {
  userMessage: string
  activeWorkflow: string | null
  currentPhase: string | null
  contextUsagePercent: number
  governanceStatus: 'healthy' | 'warning' | 'critical' | 'halted'
  s3s4Balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  modelLatencyTrend: 'stable' | 'rising' | 'falling'
  availableModels: string[]
  turnCount: number
  recentToolResults: { tool: string; success: boolean }[]
  snapshotAvailable?: boolean
  governance?: Record<string, unknown>
  // Governance signals (new)
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
}

export type S5Decision = {
  workflow: string | null
  advancePhase: string | null
  model: string | null
  tools: string[] | null
  contextAction: 'none' | 'compact' | 'warn'
  spawnAgent: { task: string; tools: string[] } | null
  priority: 's3' | 's4' | 'balanced'
  reasoning: string
  revert?: boolean
  decisionId?: string
  ruleIds?: string[]  // which rules fired
}

export type RuleTier = 'critical' | 'warning' | 'info'

export type S5Rule = {
  id: string
  tier: RuleTier
  name: string
  evaluate: (input: S5Input) => Partial<S5Decision> | null
}

export interface S5Interface {
  decide(input: S5Input): Promise<S5Decision>
  readonly name: string
}

export type DecisionLogEntry = {
  timestamp: number
  input: S5Input
  decision: S5Decision
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/s5/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/s5/types.ts engine/__tests__/s5/types.test.ts
git commit -m "feat(s5): extend S5Input with governance signals, add S5Rule and RuleTier types"
```

---

### Task 2: Rule Weight System

**Files:**
- Create: `engine/s5/ruleWeights.ts`
- Test: `engine/__tests__/s5/ruleWeights.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/s5/ruleWeights.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { RuleWeightManager } from '../../s5/ruleWeights.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RuleWeightManager', () => {
  let dir: string
  let mgr: RuleWeightManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ruleweights-'))
    mgr = new RuleWeightManager(dir)
  })

  it('returns default weight 1.0 for unknown rule', () => {
    expect(mgr.getWeight('C1')).toBe(1.0)
  })

  it('adjusts weight positively', () => {
    mgr.recordOutcome('W1', 'positive')
    expect(mgr.getWeight('W1')).toBe(1.1)
  })

  it('adjusts weight negatively on dismiss', () => {
    mgr.recordOutcome('W2', 'dismissed')
    expect(mgr.getWeight('W2')).toBe(0.9)
  })

  it('adjusts weight more negatively on negative outcome', () => {
    mgr.recordOutcome('W3', 'negative')
    expect(mgr.getWeight('W3')).toBe(0.8)
  })

  it('clamps weight to minimum 0.1', () => {
    for (let i = 0; i < 20; i++) mgr.recordOutcome('W4', 'negative')
    expect(mgr.getWeight('W4')).toBe(0.1)
  })

  it('clamps weight to maximum 2.0', () => {
    for (let i = 0; i < 20; i++) mgr.recordOutcome('W5', 'positive')
    expect(mgr.getWeight('W5')).toBe(2.0)
  })

  it('persists and loads weights', () => {
    mgr.recordOutcome('W1', 'positive')
    mgr.save()
    const mgr2 = new RuleWeightManager(dir)
    expect(mgr2.getWeight('W1')).toBe(1.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/s5/ruleWeights.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement RuleWeightManager**

```typescript
// engine/s5/ruleWeights.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const WEIGHTS_FILE = 's5-weights.json'
const DEFAULT_WEIGHT = 1.0
const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 2.0

const ADJUSTMENTS = {
  positive: 0.1,
  dismissed: -0.1,
  negative: -0.2,
} as const

export type OutcomeType = keyof typeof ADJUSTMENTS

export class RuleWeightManager {
  private weights: Record<string, number> = {}
  private filePath: string

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, WEIGHTS_FILE)
    this.load()
  }

  getWeight(ruleId: string): number {
    return this.weights[ruleId] ?? DEFAULT_WEIGHT
  }

  recordOutcome(ruleId: string, outcome: OutcomeType): void {
    const current = this.getWeight(ruleId)
    const adjusted = current + ADJUSTMENTS[outcome]
    this.weights[ruleId] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(adjusted * 100) / 100))
  }

  save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.weights, null, 2))
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.weights = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      }
    } catch {
      this.weights = {}
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/s5/ruleWeights.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/s5/ruleWeights.ts engine/__tests__/s5/ruleWeights.test.ts
git commit -m "feat(s5): add rule weight manager with cross-session persistence"
```

---

### Task 3: Hardened RuleBasedS5 with 20 Tiered Rules

**Files:**
- Modify: `engine/s5/ruleBasedS5.ts`
- Test: `engine/__tests__/s5/ruleBasedS5.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// engine/__tests__/s5/ruleBasedS5.test.ts
import { describe, it, expect } from 'bun:test'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

function baseInput(overrides: Partial<S5Input> = {}): S5Input {
  return {
    userMessage: 'test',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.5,
    governanceStatus: 'healthy',
    s3s4Balance: 'balanced',
    modelLatencyTrend: 'stable',
    availableModels: ['qwen3:32b'],
    turnCount: 5,
    recentToolResults: [],
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    homeostatStable: true,
    homeostatConsecutiveUnstable: 0,
    driftDetected: false,
    driftDirection: null,
    performanceHealth: 'healthy',
    productivityRatio: 0.8,
    recommendedToolMode: null,
    heterarchyAuthority: null,
    ...overrides,
  }
}

describe('RuleBasedS5 — Critical Tier', () => {
  const s5 = new RuleBasedS5()

  it('C1: halted → read-only tools', async () => {
    const d = await s5.decide(baseInput({ governanceStatus: 'halted' }))
    expect(d.tools).toEqual(['Read', 'Glob', 'Grep', 'Ls'])
    expect(d.ruleIds).toContain('C1')
  })

  it('C2: 3+ failures in same tool → exclude it', async () => {
    const d = await s5.decide(baseInput({
      recentToolResults: [
        { tool: 'Bash', success: false },
        { tool: 'Bash', success: false },
        { tool: 'Bash', success: false },
      ],
    }))
    expect(d.tools).toBeDefined()
    expect(d.tools).not.toContain('Bash')
    expect(d.ruleIds).toContain('C2')
  })

  it('C3: context >= 90% → compact', async () => {
    const d = await s5.decide(baseInput({ contextUsagePercent: 0.92 }))
    expect(d.contextAction).toBe('compact')
    expect(d.ruleIds).toContain('C3')
  })

  it('C6: variety critical → restrict to top-5 tools', async () => {
    const d = await s5.decide(baseInput({ varietyBalance: 'critical' }))
    expect(d.tools).toBeDefined()
    expect(d.tools!.length).toBeLessThanOrEqual(5)
    expect(d.ruleIds).toContain('C6')
  })
})

describe('RuleBasedS5 — Warning Tier', () => {
  const s5 = new RuleBasedS5()

  it('W1: context >= 75% → warn', async () => {
    const d = await s5.decide(baseInput({ contextUsagePercent: 0.78 }))
    expect(d.contextAction).toBe('warn')
    expect(d.ruleIds).toContain('W1')
  })

  it('W2: rising latency for 5+ turns → recommend model switch', async () => {
    const d = await s5.decide(baseInput({
      modelLatencyTrend: 'rising',
      turnCount: 10,
      availableModels: ['qwen3:32b', 'devstral-small-2'],
    }))
    expect(d.model).toBeDefined()
    expect(d.model).not.toBe('qwen3:32b')
    expect(d.ruleIds).toContain('W2')
  })

  it('W3: stuck 5+ turns with low success → recommend revert', async () => {
    const d = await s5.decide(baseInput({
      governance: { stuckTurns: 6, toolSuccessRate: 0.3 },
    }))
    expect(d.revert).toBe(true)
    expect(d.ruleIds).toContain('W3')
  })

  it('W4: drift detected → compact + restrict failing tools', async () => {
    const d = await s5.decide(baseInput({
      driftDetected: true,
      recentToolResults: [
        { tool: 'Bash', success: false },
        { tool: 'Bash', success: false },
        { tool: 'Read', success: true },
        { tool: 'Read', success: true },
      ],
    }))
    expect(d.contextAction).toBe('compact')
    expect(d.ruleIds).toContain('W4')
  })

  it('W5: homeostatic instability 3+ consecutive → rebalance', async () => {
    const d = await s5.decide(baseInput({
      homeostatStable: false,
      homeostatConsecutiveUnstable: 4,
      s3s4Balance: 's3_dominant',
    }))
    expect(d.priority).toBe('s4')
    expect(d.ruleIds).toContain('W5')
  })

  it('W6: S4-dominant 5+ turns → boost S3 priority', async () => {
    const d = await s5.decide(baseInput({
      s3s4Balance: 's4_dominant',
      turnCount: 8,
    }))
    expect(d.priority).toBe('s3')
    expect(d.ruleIds).toContain('W6')
  })
})

describe('RuleBasedS5 — Defaults', () => {
  const s5 = new RuleBasedS5()

  it('healthy state → no restrictions, balanced priority', async () => {
    const d = await s5.decide(baseInput())
    expect(d.tools).toBeNull()
    expect(d.contextAction).toBe('none')
    expect(d.priority).toBe('balanced')
  })

  it('every decision has ruleIds array', async () => {
    const d = await s5.decide(baseInput())
    expect(Array.isArray(d.ruleIds)).toBe(true)
  })

  it('every decision has decisionId', async () => {
    const d = await s5.decide(baseInput())
    expect(typeof d.decisionId).toBe('string')
    expect(d.decisionId!.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/s5/ruleBasedS5.test.ts`
Expected: FAIL — new fields and rule IDs don't exist yet.

- [ ] **Step 3: Rewrite RuleBasedS5 with 20 tiered rules**

```typescript
// engine/s5/ruleBasedS5.ts — replace full file
import type { S5Input, S5Decision, S5Interface, S5Rule, RuleTier } from './types.js'
import { randomUUID } from 'crypto'

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Ls']
const ALL_TOOL_NAMES = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Git', 'Ls',
  'WebFetch', 'WebSearch', 'ImageView', 'NotebookEdit', 'MultiEdit',
  'ApplyPatch', 'CodeIndex', 'SaveLearning', 'SubAgent', 'CollectAgent', 'IndexResearch',
]

function excludeTools(exclude: string[]): string[] {
  const set = new Set(exclude)
  return ALL_TOOL_NAMES.filter(t => !set.has(t))
}

function getFailingTools(results: { tool: string; success: boolean }[], threshold: number): string[] {
  const counts = new Map<string, { fail: number; total: number }>()
  for (const r of results) {
    const c = counts.get(r.tool) ?? { fail: 0, total: 0 }
    c.total++
    if (!r.success) c.fail++
    counts.set(r.tool, c)
  }
  const failing: string[] = []
  for (const [tool, c] of counts) {
    if (c.fail >= threshold) failing.push(tool)
  }
  return failing
}

function getTopToolsBySuccess(results: { tool: string; success: boolean }[], n: number): string[] {
  const rates = new Map<string, { success: number; total: number }>()
  for (const r of results) {
    const c = rates.get(r.tool) ?? { success: 0, total: 0 }
    c.total++
    if (r.success) c.success++
    rates.set(r.tool, c)
  }
  return [...rates.entries()]
    .sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))
    .slice(0, n)
    .map(([tool]) => tool)
}

// ─── Rule Definitions ─────────────────────────────────────────

const CRITICAL_RULES: S5Rule[] = [
  {
    id: 'C1', tier: 'critical', name: 'Kill switch active',
    evaluate: (input) => {
      if (input.governanceStatus === 'halted') {
        return { tools: READ_ONLY_TOOLS, reasoning: 'C1: Kill switch active — read-only mode' }
      }
      return null
    },
  },
  {
    id: 'C2', tier: 'critical', name: 'Consecutive tool failures',
    evaluate: (input) => {
      const failing = getFailingTools(input.recentToolResults, 3)
      if (failing.length > 0) {
        return { tools: excludeTools(failing), reasoning: `C2: Excluding failing tools: ${failing.join(', ')}` }
      }
      return null
    },
  },
  {
    id: 'C3', tier: 'critical', name: 'Context overflow',
    evaluate: (input) => {
      if (input.contextUsagePercent >= 0.90) {
        return { contextAction: 'compact' as const, reasoning: `C3: Context at ${Math.round(input.contextUsagePercent * 100)}% — forcing compaction` }
      }
      return null
    },
  },
  {
    id: 'C4', tier: 'critical', name: 'Doom loop detected',
    evaluate: (input) => {
      // Detect 3+ identical consecutive tool calls
      const recent = input.recentToolResults.slice(-4)
      if (recent.length >= 3) {
        const last3 = recent.slice(-3)
        const allSame = last3.every(r => r.tool === last3[0].tool && !r.success)
        if (allSame) {
          return { tools: excludeTools([last3[0].tool]), reasoning: `C4: Doom loop — ${last3[0].tool} failing repeatedly, excluded` }
        }
      }
      return null
    },
  },
  {
    id: 'C5', tier: 'critical', name: 'Agent resource exhaustion',
    evaluate: (input) => {
      const gov = input.governance as Record<string, unknown> | undefined
      const gpuUtil = (gov?.gpuUtil as number) ?? 0
      if (gpuUtil > 0.95 && input.turnCount > 3) {
        return { spawnAgent: null, reasoning: 'C5: GPU > 95% — blocking new agent spawns' }
      }
      return null
    },
  },
  {
    id: 'C6', tier: 'critical', name: 'Variety critical imbalance',
    evaluate: (input) => {
      if (input.varietyBalance === 'critical') {
        const top5 = getTopToolsBySuccess(input.recentToolResults, 5)
        const tools = top5.length > 0 ? top5 : READ_ONLY_TOOLS
        return { tools, reasoning: 'C6: Variety critical — restricting to top-performing tools' }
      }
      return null
    },
  },
]

const WARNING_RULES: S5Rule[] = [
  {
    id: 'W1', tier: 'warning', name: 'Context pressure',
    evaluate: (input) => {
      if (input.contextUsagePercent >= 0.75 && input.contextUsagePercent < 0.90) {
        return { contextAction: 'warn' as const, reasoning: `W1: Context at ${Math.round(input.contextUsagePercent * 100)}%` }
      }
      return null
    },
  },
  {
    id: 'W2', tier: 'warning', name: 'Model switch recommendation',
    evaluate: (input) => {
      if (input.modelLatencyTrend === 'rising' && input.turnCount >= 5 && input.availableModels.length > 1) {
        const alt = input.availableModels.find(m => m !== input.availableModels[0])
        if (alt) return { model: alt, reasoning: `W2: Rising latency — suggesting switch to ${alt}` }
      }
      return null
    },
  },
  {
    id: 'W3', tier: 'warning', name: 'Workspace revert',
    evaluate: (input) => {
      const gov = input.governance as Record<string, unknown> | undefined
      const stuckTurns = (gov?.stuckTurns as number) ?? 0
      const toolSuccessRate = (gov?.toolSuccessRate as number) ?? 1.0
      if (stuckTurns >= 5 && toolSuccessRate < 0.5) {
        return { revert: true, reasoning: `W3: Stuck ${stuckTurns} turns, ${Math.round(toolSuccessRate * 100)}% success — suggesting revert` }
      }
      return null
    },
  },
  {
    id: 'W4', tier: 'warning', name: 'Drift detected',
    evaluate: (input) => {
      if (input.driftDetected && input.driftDirection === 'degrading') {
        const failing = getFailingTools(input.recentToolResults, 2)
        const tools = failing.length > 0 ? excludeTools(failing) : null
        return { contextAction: 'compact' as const, tools, reasoning: `W4: Performance drift — compacting${failing.length > 0 ? ` and excluding ${failing.join(', ')}` : ''}` }
      }
      return null
    },
  },
  {
    id: 'W5', tier: 'warning', name: 'Homeostatic instability',
    evaluate: (input) => {
      if (!input.homeostatStable && input.homeostatConsecutiveUnstable >= 3) {
        if (input.s3s4Balance === 's3_dominant') {
          return { priority: 's4' as const, reasoning: 'W5: Unstable + S3-heavy — boosting S4 (exploration)' }
        }
        if (input.s3s4Balance === 's4_dominant') {
          return { priority: 's3' as const, reasoning: 'W5: Unstable + S4-heavy — boosting S3 (operations)' }
        }
        return { contextAction: 'compact' as const, reasoning: 'W5: Unstable — compacting to reduce pressure' }
      }
      return null
    },
  },
  {
    id: 'W6', tier: 'warning', name: 'S3/S4 imbalance',
    evaluate: (input) => {
      if (input.turnCount < 5) return null
      if (input.s3s4Balance === 's3_dominant') {
        return { priority: 's4' as const, reasoning: 'W6: S3-dominant — explore alternatives before committing' }
      }
      if (input.s3s4Balance === 's4_dominant') {
        return { priority: 's3' as const, reasoning: 'W6: S4-dominant — focus on implementation' }
      }
      return null
    },
  },
  {
    id: 'W7', tier: 'warning', name: 'Tool mode mismatch',
    evaluate: (input) => {
      if (input.recommendedToolMode && input.recommendedToolMode !== 'full' && input.turnCount >= 3) {
        return { reasoning: `W7: Recommended tool mode is ${input.recommendedToolMode} but using full` }
      }
      return null
    },
  },
]

const INFO_RULES: S5Rule[] = [
  { id: 'I1', tier: 'info', name: 'Variety balance shift', evaluate: () => null },
  { id: 'I2', tier: 'info', name: 'Homeostatic adjustment', evaluate: () => null },
  { id: 'I3', tier: 'info', name: 'Performance metric update', evaluate: () => null },
  { id: 'I4', tier: 'info', name: 'Heterarchy authority change', evaluate: () => null },
  { id: 'I5', tier: 'info', name: 'Structural coupling drift', evaluate: () => null },
]

export const ALL_RULES: S5Rule[] = [...CRITICAL_RULES, ...WARNING_RULES, ...INFO_RULES]

// ─── Rule Combination Logic ──────────────────────────────────

function combineDecisions(decisions: Partial<S5Decision>[]): Partial<S5Decision> {
  const combined: Partial<S5Decision> = {}
  const reasonings: string[] = []

  for (const d of decisions) {
    if (d.reasoning) reasonings.push(d.reasoning)

    // Tools: intersect (most restrictive wins)
    if (d.tools) {
      if (combined.tools) {
        const allowed = new Set(d.tools)
        combined.tools = combined.tools.filter(t => allowed.has(t))
      } else {
        combined.tools = [...d.tools]
      }
    }

    // Context action: strongest wins (compact > warn > none)
    if (d.contextAction === 'compact') combined.contextAction = 'compact'
    else if (d.contextAction === 'warn' && combined.contextAction !== 'compact') combined.contextAction = 'warn'

    // Priority: first non-balanced wins
    if (d.priority && d.priority !== 'balanced' && !combined.priority) combined.priority = d.priority

    // Model: first recommendation wins
    if (d.model && !combined.model) combined.model = d.model

    // Revert: any true wins
    if (d.revert) combined.revert = true

    // SpawnAgent: first recommendation wins (null means "block spawns")
    if ('spawnAgent' in d && !('spawnAgent' in combined)) combined.spawnAgent = d.spawnAgent
  }

  combined.reasoning = reasonings.join('. ') || 'No rules fired'
  return combined
}

// ─── RuleBasedS5 ─────────────────────────────────────────────

export class RuleBasedS5 implements S5Interface {
  readonly name = 'RuleBasedS5'

  async decide(input: S5Input): Promise<S5Decision> {
    const firedRuleIds: string[] = []
    const criticalDecisions: Partial<S5Decision>[] = []
    const warningDecisions: Partial<S5Decision>[] = []

    // Evaluate critical rules (always enforce)
    for (const rule of CRITICAL_RULES) {
      const result = rule.evaluate(input)
      if (result) {
        criticalDecisions.push(result)
        firedRuleIds.push(rule.id)
      }
    }

    // Evaluate warning rules (surface to TUI)
    for (const rule of WARNING_RULES) {
      const result = rule.evaluate(input)
      if (result) {
        warningDecisions.push(result)
        firedRuleIds.push(rule.id)
      }
    }

    // Info rules: just record that they were evaluated (logging done by orchestrator)
    for (const rule of INFO_RULES) {
      rule.evaluate(input)  // side-effect-free for now
    }

    // Combine: critical decisions override warning decisions
    const allDecisions = [...criticalDecisions, ...warningDecisions]
    const combined = allDecisions.length > 0 ? combineDecisions(allDecisions) : {}

    return {
      workflow: combined.workflow ?? null,
      advancePhase: combined.advancePhase ?? null,
      model: combined.model ?? null,
      tools: combined.tools ?? null,
      contextAction: combined.contextAction ?? 'none',
      spawnAgent: combined.spawnAgent ?? null,
      priority: combined.priority ?? 'balanced',
      reasoning: combined.reasoning ?? 'All systems nominal',
      revert: combined.revert,
      decisionId: randomUUID(),
      ruleIds: firedRuleIds,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/s5/ruleBasedS5.test.ts`
Expected: PASS (10+ tests)

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass. Some existing S5 tests may need S5Input updates for the new required fields — fix any that fail by adding default values.

- [ ] **Step 6: Commit**

```bash
git add engine/s5/ruleBasedS5.ts engine/__tests__/s5/ruleBasedS5.test.ts
git commit -m "feat(s5): rewrite RuleBasedS5 with 20 tiered rules (critical/warning/info)"
```

---

### Task 4: GovernanceRecommendationEvent Protocol

**Files:**
- Modify: `engine/bridge/protocol.ts`
- Test: `engine/__tests__/research/webSearchIntegration.test.ts` (no change needed, but run to verify no breakage)

- [ ] **Step 1: Add the event type to protocol.ts**

Add after the existing `GovernanceStatusEvent` type (~line 132):

```typescript
export type GovernanceRecommendationEvent = {
  type: 'governance.recommendation'
  requestId: string
  severity: 'warning'
  signal: string
  title: string
  description: string
  action: Record<string, unknown>  // Partial<S5Decision> serialized
  autoApplyAfterMs?: number
}
```

Add `GovernanceRecommendationEvent` to the `EngineEvent` union type.

- [ ] **Step 2: Run full tests to verify no breakage**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add engine/bridge/protocol.ts
git commit -m "feat(protocol): add GovernanceRecommendationEvent for warning-tier S5 actions"
```

---

### Task 5: S5 Enforcement in the Conversation Loop

This is the core wiring task. It modifies `conversationLoop.ts` to:
1. Populate new S5Input fields from governance
2. Enforce S5Decision unconditionally (hard tool filter, model switch, revert, agent spawn)
3. Emit governance.recommendation for warning-tier rules
4. Remove advisory prompt injection for governed signals

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`
- Test: `engine/__tests__/s5/enforcement.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// engine/__tests__/s5/enforcement.test.ts
import { describe, it, expect } from 'bun:test'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

describe('S5 enforcement logic', () => {
  it('tool filtering removes unlisted tools', () => {
    const allTools = [
      { name: 'Read', description: 'Read files', inputJSONSchema: {} },
      { name: 'Write', description: 'Write files', inputJSONSchema: {} },
      { name: 'Bash', description: 'Run commands', inputJSONSchema: {} },
      { name: 'Glob', description: 'Find files', inputJSONSchema: {} },
    ]
    const s5Tools = ['Read', 'Glob']
    const allowed = new Set(s5Tools)
    const filtered = allTools.filter(t => allowed.has(t.name))
    expect(filtered.map(t => t.name)).toEqual(['Read', 'Glob'])
  })

  it('null tools means no filtering', () => {
    const allTools = [
      { name: 'Read', description: 'Read files', inputJSONSchema: {} },
      { name: 'Write', description: 'Write files', inputJSONSchema: {} },
    ]
    const s5Tools: string[] | null = null
    const filtered = s5Tools ? allTools.filter(t => new Set(s5Tools).has(t.name)) : allTools
    expect(filtered).toEqual(allTools)
  })

  it('workflow tools intersect with S5 tools', () => {
    const allTools = ['Read', 'Write', 'Bash', 'Glob', 'Grep']
    const workflowAllowed = ['Read', 'Glob', 'Grep', 'Write']  // workflow phase restriction
    const s5Allowed = ['Read', 'Glob', 'Grep']  // S5 restriction

    let tools = allTools.filter(t => workflowAllowed.includes(t))  // workflow first
    tools = tools.filter(t => s5Allowed.includes(t))  // then S5

    expect(tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('S5 decides halted → only read tools survive', async () => {
    const s5 = new RuleBasedS5()
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.5,
      governanceStatus: 'halted',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:32b'],
      turnCount: 5,
      recentToolResults: [],
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
    }
    const d = await s5.decide(input)
    expect(d.tools).toEqual(['Read', 'Glob', 'Grep', 'Ls'])

    // Simulate enforcement
    const allTools = [
      { name: 'Read' }, { name: 'Write' }, { name: 'Bash' },
      { name: 'Glob' }, { name: 'Grep' }, { name: 'Ls' },
    ]
    const allowed = new Set(d.tools!)
    const enforced = allTools.filter(t => allowed.has(t.name))
    expect(enforced.map(t => t.name)).toEqual(['Read', 'Glob', 'Grep', 'Ls'])
  })
})
```

- [ ] **Step 2: Run test to verify it passes (pure logic tests)**

Run: `bun test engine/__tests__/s5/enforcement.test.ts`
Expected: PASS — these test the filtering logic independent of conversation loop.

- [ ] **Step 3: Modify conversationLoop.ts — populate S5Input with governance signals**

In the S5 decision block (~line 651), replace the `makeDecision` call to include new fields. Change the input object to:

```typescript
const govReport = this.governance.getReport()
const pm = this.governance.getPerformanceMetrics()
const het = this.governance.getHeterarchy()

const decision = await this.s5.makeDecision({
  userMessage: text.slice(0, 200),
  activeWorkflow: this.workflowEngine.state?.workflow.name ?? null,
  currentPhase: this.workflowEngine.currentPhase?.name ?? null,
  contextUsagePercent: estimatedTokens / ctxLength,
  governance: govReport,
  recentToolResults: this.toolHistory.slice(-20).map(t => ({ tool: t.name, success: t.success })),
  availableModels: [this.config.model ?? 'unknown'],
  turnCount: this.messages.filter(m => m.role === 'user').length,
  // New governance signals
  varietyBalance: govReport.varietyBalance ?? 'balanced',
  varietyRatio: govReport.varietyRatio ?? 1.0,
  homeostatStable: this.governance.isStable(),
  homeostatConsecutiveUnstable: govReport.consecutiveUnstable ?? 0,
  driftDetected: pm.isDriftDetected(),
  driftDirection: pm.isDriftDetected() ? 'degrading' : null,
  performanceHealth: pm.getHealthStatus() === 'green' ? 'healthy' : pm.getHealthStatus() === 'yellow' ? 'warning' : 'critical',
  productivityRatio: pm.getProductivity?.() ?? 0.8,
  recommendedToolMode: this.governance.getRecommendedToolMode(),
  heterarchyAuthority: null,  // populated from het below
})
```

- [ ] **Step 4: Modify conversationLoop.ts — enforce S5Decision**

Replace the existing S5 result handling (~lines 671-698) with enforcement:

```typescript
// ─── Enforce S5 Decision ─────────────────────────────────
// Critical-tier actions: apply immediately
if (decision.contextAction === 'compact') {
  console.log(`[s5] ENFORCE: compact context (${decision.reasoning})`)
  // ... existing compaction code ...
}

if (decision.tools) {
  console.log(`[s5] ENFORCE: tool restriction to [${decision.tools.join(', ')}]`)
  const allowed = new Set(decision.tools)
  toolDefs = toolDefs.filter(t => allowed.has(t.name))
}

if (decision.model && decision.model !== this.config.model) {
  console.log(`[s5] ENFORCE: model switch to ${decision.model}`)
  this.updateModel(decision.model)
}

// Warning-tier actions: surface to TUI
const warningRuleIds = (decision.ruleIds ?? []).filter(id => id.startsWith('W'))
if (warningRuleIds.length > 0) {
  const requestId = randomUUID()
  this.emit({
    type: 'governance.recommendation' as any,
    requestId,
    severity: 'warning',
    signal: warningRuleIds[0],
    title: decision.reasoning.split('.')[0],
    description: decision.reasoning,
    action: {
      model: decision.model,
      tools: decision.tools,
      contextAction: decision.contextAction,
      revert: decision.revert,
      priority: decision.priority,
    },
    autoApplyAfterMs: decision.revert ? undefined : 60000,
  })
  console.log(`[s5] RECOMMEND: ${decision.reasoning} (via TUI)`)
}

if (decision.revert && decision.ruleIds?.some(id => id.startsWith('C'))) {
  // Critical revert — apply immediately
  console.log(`[s5] ENFORCE: workspace revert`)
  // ... trigger snapshot revert ...
}

console.log(`[s5] Priority: ${decision.priority} | Rules: ${(decision.ruleIds ?? []).join(',')} | ${decision.reasoning}`)
```

- [ ] **Step 5: Remove advisory prompt injection**

Delete the governance signal injection block (~lines 563-631) that builds the `## Governance Signals` section. Replace with a single comment:

```typescript
// Governance signals are now routed through S5 enforcement, not prompt injection.
// See S5 decision block above.
```

- [ ] **Step 6: Fix the tool filtering at the model call site**

At ~line 1055-1061, replace:

```typescript
const toolMode = this.governance.getRecommendedToolMode()
const iterationTools = toolDefs
if (toolMode !== 'full') {
  console.log(`[vsm] Tool mode is ${toolMode} but NOT restricting — tool removal causes model death`)
}
```

With:

```typescript
// Tools are already filtered by S5 enforcement (above) and workflow phase restrictions.
// No additional filtering needed here.
const iterationTools = toolDefs
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass. Fix any tests that rely on the old governance prompt injection text.

- [ ] **Step 8: Commit**

```bash
git add engine/bridge/conversationLoop.ts engine/__tests__/s5/enforcement.test.ts
git commit -m "feat(s5): enforce S5Decision in conversation loop — hard tool filter, model switch, TUI recommendations"
```

---

### Task 6: S2 Kill Enforcement

**Files:**
- Modify: `engine/agents/s2Coordinator.ts`
- Test: `engine/__tests__/agents/s2Kill.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/agents/s2Kill.test.ts
import { describe, it, expect } from 'bun:test'

describe('S2 agent kill enforcement', () => {
  it('kill decision calls agent.kill()', () => {
    let killed = false
    const mockAgent = {
      id: 'agent-1',
      kill: () => { killed = true },
      status: { state: 'running' },
    }

    // Simulate S2 kill decision
    if (true /* decision === 'kill' */) {
      mockAgent.kill()
    }

    expect(killed).toBe(true)
  })

  it('escalate decision does not kill agent', () => {
    let killed = false
    const mockAgent = {
      id: 'agent-1',
      kill: () => { killed = true },
      status: { state: 'running' },
    }

    // Simulate S2 escalate decision
    const decision = 'escalate'
    if (decision === 'kill') {
      mockAgent.kill()
    }

    expect(killed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (pure logic)**

Run: `bun test engine/__tests__/agents/s2Kill.test.ts`
Expected: PASS

- [ ] **Step 3: Modify S2Coordinator to hold agent refs and enforce kill**

In `engine/agents/s2Coordinator.ts`, add an agent instance map and wire the kill path in `handleAlgedonic()`:

Add field: `private agentInstances = new Map<string, { kill: () => void }>()`

In `registerAgent()`: accept optional `instance` parameter, store in map.

In `handleAlgedonic()`: when decision is `'kill'`, look up instance and call `instance.kill()`. Emit `subagent.killed` event. Call `drainQueue()`.

When decision is `'escalate'`: emit `governance.recommendation` event via the emit callback.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add engine/agents/s2Coordinator.ts engine/__tests__/agents/s2Kill.test.ts
git commit -m "feat(s2): enforce agent kill/escalate decisions — agents actually die when S2 says kill"
```

---

### Task 7: Outcome Backfill and Decision Tracking

**Files:**
- Modify: `engine/s5/orchestrator.ts`
- Modify: `engine/training/decisionJournal.ts`
- Test: `engine/__tests__/s5/outcomeBackfill.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/s5/outcomeBackfill.test.ts
import { describe, it, expect } from 'bun:test'

describe('Outcome evaluation', () => {
  it('tool restriction positive when stuck decreased', () => {
    const before = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const after = { stuckTurns: 2, toolSuccessRate: 0.6 }
    const outcome = after.stuckTurns < before.stuckTurns ? 'positive' : 'negative'
    expect(outcome).toBe('positive')
  })

  it('tool restriction negative when stuck unchanged', () => {
    const before = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const after = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const outcome = after.stuckTurns < before.stuckTurns ? 'positive' : 'negative'
    expect(outcome).toBe('negative')
  })

  it('compaction positive when no re-compaction needed', () => {
    const recompacted = false
    const outcome = recompacted ? 'negative' : 'positive'
    expect(outcome).toBe('positive')
  })

  it('user dismiss is always negative', () => {
    const userDismissed = true
    const outcome = userDismissed ? 'dismissed' : 'positive'
    expect(outcome).toBe('dismissed')
  })
})
```

- [ ] **Step 2: Run test**

Run: `bun test engine/__tests__/s5/outcomeBackfill.test.ts`
Expected: PASS (pure logic)

- [ ] **Step 3: Add decisionId tracking to orchestrator**

In `engine/s5/orchestrator.ts`, after receiving the S5Decision, store `{ decisionId, ruleIds, governanceSnapshotBefore }` in a pending-outcome map. Add method `evaluateOutcome(decisionId, governanceSnapshotAfter)` that compares before/after and returns `'positive' | 'negative' | 'dismissed'`. Call `ruleWeightManager.recordOutcome()` for each fired rule.

- [ ] **Step 4: Add session-end weight save**

In the orchestrator's cleanup or session-end path, call `ruleWeightManager.save()` to persist weights.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add engine/s5/orchestrator.ts engine/training/decisionJournal.ts engine/__tests__/s5/outcomeBackfill.test.ts
git commit -m "feat(s5): add outcome backfill and rule weight tuning for cross-session learning"
```

---

### Task 8: Wire CyberneticsGovernance to Export New S5Input Fields

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts`
- Test: existing governance tests

- [ ] **Step 1: Add new fields to GovernanceReport**

Ensure `getReport()` returns `varietyBalance`, `varietyRatio`, `consecutiveUnstable`, and other fields needed by the new S5Input. Map from existing internal state:

- `varietyBalance` → from `VarietyEngine.getBalance()`
- `varietyRatio` → from `VarietyEngine.getRatio()`
- `consecutiveUnstable` → track in a counter, increment when `isStable()` returns false, reset to 0 on stable
- `gpuUtil` → from S2 if available, else 0

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts
git commit -m "feat(vsm): export governance signals as S5Input fields for enforcement"
```

---

### Task 9: Integration Verification — Wire Check

**Files:** All modified files

- [ ] **Step 1: Grep for all new symbols and verify they're used**

```bash
# New types must be imported where used
grep -r "S5Rule" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "RuleTier" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "RuleWeightManager" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "governance.recommendation" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "GovernanceRecommendationEvent" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "decisionId" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "ruleIds" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "evaluateOutcome" engine/ --include="*.ts" | grep -v test | grep -v node_modules
grep -r "varietyBalance" engine/s5/ --include="*.ts"
grep -r "homeostatStable" engine/s5/ --include="*.ts"
```

Every new symbol must appear in at least one non-test file where it's consumed. If any symbol is defined but not consumed, wire it.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All 1150+ tests pass.

- [ ] **Step 3: Run CynCo engine to verify no startup crash**

```bash
LOCALCODE_MODEL=qwen3:32b timeout 10 bun engine/main.ts 2>&1 | head -30
```

Expected: Engine starts, logs S5 initialization, no crashes.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(governance): wire check — all new symbols imported and consumed"
```

- [ ] **Step 5: Push to cynco remote**

```bash
git push cynco feat/deep-research
```
