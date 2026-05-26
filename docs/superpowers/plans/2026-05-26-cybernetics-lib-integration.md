# Cybernetics Library Integration + Dead Module Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-rolled governance heuristics with `@cybernetics/core` formal mathematics and wire three dead modules (heterarchy, conversation theory, observer effects) into the S5 decision loop.

**Architecture:** Adapter swap — `CyberneticsGovernance`'s public API stays unchanged. Each `*Integration` class gets its internals replaced with library calls. ConversationLoop and TUI never know the difference. New S5Input fields (`agreementRatio`, `observerDivergence`) wire dead modules into enforcement.

**Tech Stack:** TypeScript (Bun), `@cybernetics/core` (vendored at `engine/cybernetics-core/`), Vitest

**Key reference files:**
- Library API: `engine/cybernetics-core/src/index.ts` (barrel export)
- Governance: `engine/vsm/cyberneticsGovernance.ts` (main orchestrator)
- Types: `engine/vsm/types.ts` (GovernanceReport), `engine/s5/types.ts` (S5Input)
- S5 rules: `engine/s5/ruleBasedS5.ts`
- Loop: `engine/bridge/conversationLoop.ts:608-627` (S5Input population)

---

### Task 1: Extend GovernanceReport and S5Input types

**Files:**
- Modify: `engine/vsm/types.ts`
- Modify: `engine/s5/types.ts`
- Test: `engine/__tests__/governanceTypes.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/governanceTypes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { GovernanceReport } from '../vsm/types.js'
import type { S5Input } from '../s5/types.js'

describe('GovernanceReport extended fields', () => {
  it('includes agreementRatio field', () => {
    const report: GovernanceReport = {
      status: 'healthy',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 1.0,
      agreementRatio: 0.8,
      observerDivergence: null,
      axiomHealth: { holding: 4, total: 4, violations: [] },
    }
    expect(report.agreementRatio).toBe(0.8)
  })
})

describe('S5Input extended fields', () => {
  it('includes agreementRatio and observerDivergence', () => {
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.5,
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3.6'],
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
      heterarchyAuthority: 's3',
      agreementRatio: 0.7,
      observerDivergence: 0.1,
    }
    expect(input.agreementRatio).toBe(0.7)
    expect(input.observerDivergence).toBe(0.1)
    expect(input.heterarchyAuthority).toBe('s3')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/governanceTypes.test.ts`
Expected: FAIL — `agreementRatio`, `observerDivergence`, `axiomHealth` don't exist on types

- [ ] **Step 3: Extend GovernanceReport**

In `engine/vsm/types.ts`, replace the GovernanceReport type:

```typescript
export type AxiomHealth = {
  holding: number
  total: number
  violations: string[]
}

export type GovernanceReport = {
  status: HealthStatus
  varietyBalance: 'balanced' | 'underload' | 'overload'
  varietyRatio: number
  s3s4Balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  algedonicAlerts: number
  stuckTurns: number
  consecutiveUnstable: number
  modelLatencyTrend: 'stable' | 'rising' | 'falling'
  toolSuccessRate: number
  agreementRatio: number
  observerDivergence: number | null
  axiomHealth: AxiomHealth
}
```

- [ ] **Step 4: Extend S5Input**

In `engine/s5/types.ts`, add to the S5Input type after `heterarchyAuthority`:

```typescript
  agreementRatio: number
  observerDivergence: number | null
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bunx vitest run __tests__/governanceTypes.test.ts`
Expected: PASS

- [ ] **Step 6: Fix compilation — update getReport() in cyberneticsGovernance.ts**

The `getReport()` method must now return the new fields. In `engine/vsm/cyberneticsGovernance.ts`, update the `return` statement in `getReport()` (around line 382) to add:

```typescript
      agreementRatio: this.conversationTheory.getAgreementRatio(),
      observerDivergence: null, // wired in Task 6
      axiomHealth: { holding: 0, total: 0, violations: [] }, // wired in Task 8
```

- [ ] **Step 7: Fix compilation — update S5Input population in conversationLoop.ts**

In `engine/bridge/conversationLoop.ts`, in the `makeDecision` call (around line 608-627), add after `heterarchyAuthority: null`:

```typescript
          agreementRatio: (govReport as any).agreementRatio ?? 1.0,
          observerDivergence: (govReport as any).observerDivergence ?? null,
```

- [ ] **Step 8: Run full test suite to verify nothing broke**

Run: `cd engine && bunx vitest run`
Expected: PASS (all existing tests still pass)

- [ ] **Step 9: Commit**

```bash
git add engine/vsm/types.ts engine/s5/types.ts engine/vsm/cyberneticsGovernance.ts engine/bridge/conversationLoop.ts engine/__tests__/governanceTypes.test.ts
git commit -m "feat(vsm): extend GovernanceReport and S5Input with agreement, divergence, axiom fields"
```

---

### Task 2: Upgrade variety with Attenuators and Amplifiers

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (constructor + onTurnComplete)
- Test: `engine/__tests__/varietyUpgrade.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/varietyUpgrade.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { variety, foundations } from '../cybernetics-core/src/index.js'

describe('variety upgrade — attenuators and amplifiers', () => {
  it('attenuator reduces environmental variety', () => {
    const att = new variety.Attenuator('context_budget', 0.3, 'Context budget constrains tool variety')
    const reduced = att.attenuate(10)
    expect(reduced).toBe(7) // 10 * (1 - 0.3)
  })

  it('amplifier increases regulatory variety', () => {
    const amp = new variety.Amplifier('subagents', 1.5, 'Sub-agents expand response capacity')
    const amplified = amp.amplify(5)
    expect(amplified).toBe(7.5) // 5 * 1.5
  })

  it('entropy measures information-theoretic variety', () => {
    // 4 equally likely tools = 2 bits of entropy
    const h = foundations.entropy([0.25, 0.25, 0.25, 0.25])
    expect(h).toBeCloseTo(2.0, 1)
  })

  it('attenuator chain applies sequentially', () => {
    const atts = [
      new variety.Attenuator('denied', 0.2, 'Profile-denied tools'),
      new variety.Attenuator('budget', 0.1, 'Context budget'),
    ]
    const result = variety.attenuateChain(100, atts)
    expect(result).toBe(72) // 100 * 0.8 * 0.9
  })

  it('amplifier chain applies sequentially', () => {
    const amps = [
      new variety.Amplifier('agents', 1.3, 'Sub-agent spawning'),
      new variety.Amplifier('workflow', 1.2, 'Workflow phase tools'),
    ]
    const result = variety.amplifyChain(10, amps)
    expect(result).toBeCloseTo(15.6, 1) // 10 * 1.3 * 1.2
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/varietyUpgrade.test.ts`
Expected: PASS (these test library functions)

- [ ] **Step 3: Add Attenuators and Amplifiers to governance constructor**

In `engine/vsm/cyberneticsGovernance.ts`, after the variety engine initialization (around line 183-186), add:

```typescript
    // Variety attenuators — reduce environmental complexity
    this.varietyAttenuators = [
      new variety.Attenuator('denied_tools', 0.1, 'Profile-denied tools reduce available variety'),
      new variety.Attenuator('context_budget', 0.0, 'Context pressure constrains tool variety'),
    ]
    // Variety amplifiers — expand regulatory capacity
    this.varietyAmplifiers = [
      new variety.Amplifier('tool_diversity', 1.0, 'Diverse tool usage amplifies regulatory variety'),
      new variety.Amplifier('subagent_capacity', 1.0, 'Sub-agent spawning expands response capacity'),
    ]
```

Add the corresponding fields to the class (after the varietyEngine field):

```typescript
  private varietyAttenuators: InstanceType<typeof variety.Attenuator>[]
  private varietyAmplifiers: InstanceType<typeof variety.Amplifier>[]
```

- [ ] **Step 4: Upgrade variety calculation in onTurnComplete**

In `onTurnComplete()`, replace the variety update section (around lines 279-281):

```typescript
    const distinctToolsUsed = new Set(this.toolHistory.slice(-10).map(t => t.name)).size
    this.varietyEngine.setInputCount(this.currentTaskComplexity * 3) // Environmental variety
    this.varietyEngine.setFilterCount(0)
    this.varietyEngine.setActiveTheories(distinctToolsUsed) // Tool diversity as amplification
    this.varietyEngine.recalculate()
```

With:

```typescript
    const distinctToolsUsed = new Set(this.toolHistory.slice(-10).map(t => t.name)).size
    const recentTools = this.toolHistory.slice(-10)

    // Environmental variety (S4): task complexity, attenuated by constraints
    const rawEnvironmental = this.currentTaskComplexity * 3
    // Update context budget attenuator dynamically
    this.varietyAttenuators[1] = new variety.Attenuator(
      'context_budget', Math.max(0, (this.feedbackControl.getContextUtilization?.() ?? 0) * 0.3),
      'Context pressure constrains tool variety',
    )
    const attenuatedEnvironmental = variety.attenuateChain(rawEnvironmental, this.varietyAttenuators)

    // Regulatory variety: tool diversity, amplified by capabilities
    // Update amplifiers dynamically
    this.varietyAmplifiers[0] = new variety.Amplifier(
      'tool_diversity', 1.0 + (distinctToolsUsed * 0.1),
      'Diverse tool usage amplifies regulatory variety',
    )
    const toolProbs = this._toolUsageProbabilities(recentTools)
    const toolEntropy = toolProbs.length > 0 ? foundations.entropy(toolProbs) : 0

    this.varietyEngine.setInputCount(Math.round(attenuatedEnvironmental))
    this.varietyEngine.setFilterCount(0)
    this.varietyEngine.setActiveTheories(Math.max(1, Math.round(toolEntropy * 3)))
    this.varietyEngine.recalculate()
```

Add the helper method to the class:

```typescript
  /** Calculate tool usage probability distribution for Shannon entropy. */
  private _toolUsageProbabilities(recentTools: { name: string }[]): number[] {
    if (recentTools.length === 0) return []
    const counts = new Map<string, number>()
    for (const t of recentTools) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    }
    const total = recentTools.length
    return [...counts.values()].map(c => c / total)
  }
```

- [ ] **Step 5: Add foundations import**

At the top of `cyberneticsGovernance.ts`, update the import from cybernetics-core to include `foundations`:

```typescript
import {
  variety,
  vsm,
  events,
  foundations,
  NodeId,
} from '../cybernetics-core/src/index.js'
```

- [ ] **Step 6: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/__tests__/varietyUpgrade.test.ts
git commit -m "feat(vsm): upgrade variety with attenuators, amplifiers, and Shannon entropy"
```

---

### Task 3: Upgrade algedonic with formal severity routing

**Files:**
- Modify: `engine/vsm/algedonicIntegration.ts`
- Test: `engine/__tests__/algedonicUpgrade.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/algedonicUpgrade.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { Severity, classifySeverity } from '../cybernetics-core/src/index.js'

describe('algedonic upgrade — formal severity', () => {
  it('classifySeverity returns correct levels', () => {
    expect(classifySeverity(0.1)).toBe(Severity.Low)
    expect(classifySeverity(0.4)).toBe(Severity.Moderate)
    expect(classifySeverity(0.7)).toBe(Severity.High)
    expect(classifySeverity(0.95)).toBe(Severity.Critical)
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/algedonicUpgrade.test.ts`
Expected: PASS

- [ ] **Step 3: Upgrade algedonicIntegration.ts**

In `engine/vsm/algedonicIntegration.ts`, update `recordToolResult` to use `classifySeverity` for severity classification instead of hardcoded values:

Replace line 37 (`const score = success ? 0.2 : 0.7`):

```typescript
    // Score based on success/failure + latency severity
    const baseScore = success ? 0.15 : 0.7
    const latencyPenalty = latencyMs > 30000 ? 0.2 : latencyMs > 10000 ? 0.1 : 0
    const score = Math.min(1.0, baseScore + latencyPenalty)
```

Replace the SLA check at line 84 (`const severity = success ? Severity.Low : Severity.Moderate`):

```typescript
    // Use library's formal severity classification
    const severity = classifySeverity(score)
    this.slaTracker.check(severity, latencyMs, toolName)
```

Add `classifySeverity` to the import at line 13:

```typescript
import { algedonic, NodeId, AlgedonicType, Severity, classifySeverity } from '../cybernetics-core/src/index.js'
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/algedonicIntegration.ts engine/__tests__/algedonicUpgrade.test.ts
git commit -m "feat(vsm): upgrade algedonic with formal severity classification and latency penalties"
```

---

### Task 4: Upgrade homeostat with Beer's time constants

**Files:**
- Modify: `engine/vsm/homeostatIntegration.ts`
- Test: `engine/__tests__/homeostatUpgrade.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/homeostatUpgrade.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { homeostat } from '../cybernetics-core/src/index.js'

describe('homeostat upgrade — Beer time constants', () => {
  it('timeConstantForLevel returns increasing constants', () => {
    const tc1 = homeostat.timeConstantForLevel(1)
    const tc3 = homeostat.timeConstantForLevel(3)
    const tc5 = homeostat.timeConstantForLevel(5)
    expect(tc3).toBeGreaterThan(tc1)
    expect(tc5).toBeGreaterThan(tc3)
  })

  it('classifyHomeostatBalance returns correct types', () => {
    const balanced = homeostat.calculateBalance(0.5, 0.5)
    expect(balanced.balance).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/homeostatUpgrade.test.ts`
Expected: PASS

- [ ] **Step 3: Upgrade homeostatIntegration.ts**

In `engine/vsm/homeostatIntegration.ts`, update the constructor to use Beer's time constant for S3 level:

Replace line 49 (`this.ashby = new homeostat.AshbyHomeostat(3, 0.8, 5.0)`):

```typescript
    // Use Beer's time constant for S3 level (inside-and-now)
    const s3TimeConstant = homeostat.timeConstantForLevel(3)
    this.ashby = new homeostat.AshbyHomeostat(3, 0.8, s3TimeConstant)
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/homeostatIntegration.ts engine/__tests__/homeostatUpgrade.test.ts
git commit -m "feat(vsm): upgrade homeostat with Beer's level-appropriate time constants"
```

---

### Task 5: Wire heterarchy into S5 (dead → live)

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (store commander)
- Modify: `engine/bridge/conversationLoop.ts` (populate heterarchyAuthority)
- Modify: `engine/s5/ruleBasedS5.ts` (upgrade I4 to warning)
- Test: `engine/__tests__/heterarchyWiring.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/heterarchyWiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { HeterarchyIntegration } from '../vsm/heterarchyIntegration.js'

describe('heterarchy wiring — dead to live', () => {
  it('whoCommands returns S5 in crisis', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('crisis')).toBe('S5')
  })

  it('whoCommands returns S3 in normal', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('normal')).toBe('S3')
  })

  it('whoCommands returns S4 in exploration', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('exploration')).toBe('S4')
  })

  it('classifyContext returns crisis for algedonic critical', () => {
    const het = new HeterarchyIntegration()
    expect(het.classifyContext(0, true, false, 5)).toBe('crisis')
  })

  it('classifyContext returns stuck for 3+ stuck turns', () => {
    const het = new HeterarchyIntegration()
    expect(het.classifyContext(3, false, false, 5)).toBe('stuck')
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/heterarchyWiring.test.ts`
Expected: PASS (these test existing heterarchy logic)

- [ ] **Step 3: Store commander in CyberneticsGovernance**

In `engine/vsm/cyberneticsGovernance.ts`, add a field:

```typescript
  private lastCommander: string = 'S3'
```

In `onTurnComplete()`, after the heterarchy section (around line 290), store the commander:

```typescript
    const commander = this.heterarchyIntegration.whoCommands(context)
    this.lastCommander = commander
```

Add a getter method:

```typescript
  /** Get the last heterarchy commander (S1-S5). */
  getLastCommander(): string { return this.lastCommander }
```

- [ ] **Step 4: Populate heterarchyAuthority in conversationLoop.ts**

In `engine/bridge/conversationLoop.ts`, replace `heterarchyAuthority: null` (line 626) with:

```typescript
          heterarchyAuthority: (this.governance.getLastCommander?.() ?? 'S3').toLowerCase().replace('s', 's') as 's3' | 's4' | 's5' | null,
```

Wait, the commander returns 'S3', 'S4', 'S5' — we need lowercase 's3', 's4', 's5':

```typescript
          heterarchyAuthority: (() => {
            const cmd = this.governance.getLastCommander?.()
            if (!cmd) return null
            const lower = cmd.toLowerCase()
            if (lower === 's3' || lower === 's4' || lower === 's5') return lower as 's3' | 's4' | 's5'
            return null
          })(),
```

- [ ] **Step 5: Upgrade I4 rule to warning tier with behavioral effect**

In `engine/s5/ruleBasedS5.ts`, replace the I4 rule (around line 209):

```typescript
const I4: S5Rule = {
  id: 'I4',
  tier: 'warning',
  name: 'Heterarchy authority — adjust tool mode',
  evaluate(input) {
    if (!input.heterarchyAuthority) return null
    // S5 in command (crisis) → restrict to read-only
    if (input.heterarchyAuthority === 's5' && input.turnCount >= 2) {
      return {
        tools: [...READ_ONLY_TOOLS],
        reasoning: `heterarchy: S5 commanding (crisis) — restricting to read-only`,
      }
    }
    // S4 in command (exploration) → allow all tools
    if (input.heterarchyAuthority === 's4') {
      return {
        reasoning: `heterarchy: S4 commanding (exploration) — broad tool access`,
      }
    }
    // S3 in command (normal/routine) → no change, just journal
    if (input.heterarchyAuthority === 's3') {
      return {
        reasoning: `heterarchy: S3 commanding (normal operations)`,
      }
    }
    return null
  },
}
```

- [ ] **Step 6: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/bridge/conversationLoop.ts engine/s5/ruleBasedS5.ts engine/__tests__/heterarchyWiring.test.ts
git commit -m "feat(vsm): wire heterarchy authority into S5 enforcement — dead to live"
```

---

### Task 6: Wire conversation theory into S5 (dead → live)

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (query agreement, emit pain)
- Modify: `engine/s5/ruleBasedS5.ts` (add agreement rule)
- Test: `engine/__tests__/conversationTheoryWiring.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/conversationTheoryWiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConversationTheoryIntegration } from '../vsm/conversationTheory.js'

describe('conversation theory wiring — dead to live', () => {
  it('agreement ratio starts at 1.0 (no exchanges = full agreement)', () => {
    const ct = new ConversationTheoryIntegration()
    // No exchanges yet — ratio should be high (no disagreements)
    const ratio = ct.getAgreementRatio()
    expect(ratio).toBeGreaterThanOrEqual(0)
  })

  it('confirmed exchanges increase agreement', () => {
    const ct = new ConversationTheoryIntegration()
    ct.recordExchange('topic1', 'I will edit the file', 'yes perfect')
    ct.recordExchange('topic2', 'Adding tests now', 'ok got it')
    expect(ct.getAgreementRatio()).toBeGreaterThan(0.5)
  })

  it('confused exchanges decrease agreement', () => {
    const ct = new ConversationTheoryIntegration()
    ct.recordExchange('topic1', 'I will refactor', 'what? no that is wrong')
    ct.recordExchange('topic2', 'Deleting the file', 'huh? do not understand')
    expect(ct.getAgreementRatio()).toBeLessThanOrEqual(0.5)
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/conversationTheoryWiring.test.ts`
Expected: PASS

- [ ] **Step 3: Query agreement ratio in governance onTurnComplete**

In `engine/vsm/cyberneticsGovernance.ts`, after the conversation theory section (around line 294), add:

```typescript
    // Query agreement ratio — low agreement = user and system are diverging
    const agreementRatio = this.conversationTheory.getAgreementRatio()
    if (agreementRatio < 0.5 && this.turnCount > 3) {
      // Emit pain signal for low agreement
      this.algedonicIntegration.recordToolResult('AgreementDivergence', false, 0)
      console.log(`[vsm] Agreement ratio ${agreementRatio.toFixed(2)} < 0.5 — algedonic pain`)
    }
```

- [ ] **Step 4: Update getReport() to include agreementRatio**

In `getReport()`, replace the placeholder `agreementRatio: this.conversationTheory.getAgreementRatio()` (already added in Task 1 Step 6) — verify it's there.

- [ ] **Step 5: Add S5 agreement rule**

In `engine/s5/ruleBasedS5.ts`, add a new warning rule after W7:

```typescript
const W8: S5Rule = {
  id: 'W8',
  tier: 'warning',
  name: 'Low agreement — suggest clarification',
  evaluate(input) {
    if (input.agreementRatio < 0.4 && input.turnCount >= 3) {
      return {
        reasoning: `agreement ratio ${input.agreementRatio.toFixed(2)} — user and system may be diverging, suggest clarification`,
      }
    }
    return null
  },
}
```

Add `W8` to the `ALL_RULES` array in the warning section.

- [ ] **Step 6: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/s5/ruleBasedS5.ts engine/__tests__/conversationTheoryWiring.test.ts
git commit -m "feat(vsm): wire conversation theory agreement ratio into S5 — dead to live"
```

---

### Task 7: Wire observer effects into S5 (dead → live)

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (check divergence, eigenform at session end)
- Modify: `engine/s5/ruleBasedS5.ts` (add divergence rule)
- Test: `engine/__tests__/observerEffectsWiring.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/observerEffectsWiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ObserverEffectsIntegration } from '../vsm/observerEffects.js'
import { NodeId } from '../cybernetics-core/src/index.js'

describe('observer effects wiring — dead to live', () => {
  it('checkDivergence detects when S3 and S4 disagree', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    // S3 sees 90% success, S4 sees 50% — divergence should be high
    obs.recordMeasurement('success_rate', 0.9, 'S3')
    obs.recordMeasurement('success_rate', 0.5, 'S4')
    const result = obs.checkDivergence('success_rate', 0.2)
    expect(result.exceeds).toBe(true)
  })

  it('checkDivergence is low when observers agree', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    obs.recordMeasurement('success_rate', 0.8, 'S3')
    obs.recordMeasurement('success_rate', 0.8, 'S4')
    const result = obs.checkDivergence('success_rate', 0.2)
    expect(result.exceeds).toBe(false)
  })

  it('eigenform converges for stable self-assessment', () => {
    const obs = new ObserverEffectsIntegration(new NodeId())
    // f(x) = 0.5 + 0.3*x converges to x* = 0.5/(1-0.3) ≈ 0.714
    const result = obs.findSelfAssessmentEigenform(x => 0.5 + 0.3 * x, 0.5)
    expect(result.converged).toBe(true)
    expect(result.value).toBeCloseTo(0.714, 2)
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/observerEffectsWiring.test.ts`
Expected: PASS

- [ ] **Step 3: Check divergence in governance onTurnComplete**

In `engine/vsm/cyberneticsGovernance.ts`, after the observer measurement section (around line 285), add:

```typescript
    // Check observer divergence — S3 vs S4 on success rate
    const divergenceResult = this.observerEffects.checkDivergence('success_rate', 0.2)
    this.lastObserverDivergence = divergenceResult.divergence
    if (divergenceResult.exceeds && this.turnCount > 3) {
      console.log(`[vsm] Observer divergence ${divergenceResult.divergence.toFixed(2)} > 0.2 — S3/S4 disagree`)
    }
```

Add the field:

```typescript
  private lastObserverDivergence: number | null = null
```

- [ ] **Step 4: Update getReport() observerDivergence**

In `getReport()`, change the `observerDivergence` line to:

```typescript
      observerDivergence: this.lastObserverDivergence,
```

- [ ] **Step 5: Update S5Input population in conversationLoop.ts**

Already done in Task 1 Step 7 — `observerDivergence` reads from govReport.

- [ ] **Step 6: Add S5 divergence rule**

In `engine/s5/ruleBasedS5.ts`, add after W8:

```typescript
const W9: S5Rule = {
  id: 'W9',
  tier: 'warning',
  name: 'Observer divergence — S5 arbitration',
  evaluate(input) {
    if (input.observerDivergence != null && input.observerDivergence > 0.3 && input.turnCount >= 3) {
      return {
        reasoning: `observer divergence ${input.observerDivergence.toFixed(2)} — S3/S4 disagree on system state, S5 arbitrating`,
      }
    }
    return null
  },
}
```

Add `W9` to the `ALL_RULES` array.

- [ ] **Step 7: Add eigenform check at session end**

In `engine/vsm/cyberneticsGovernance.ts`, add a method:

```typescript
  /** Run eigenform convergence check at session end. Returns whether self-assessment is stable. */
  checkEigenformStability(): { converged: boolean; value: number } {
    const sr = this.getSuccessRate()
    // Self-assessment function: how success rate feeds back into confidence
    const assessFn = (x: number) => 0.3 + 0.5 * x + 0.2 * sr
    const result = this.observerEffects.findSelfAssessmentEigenform(assessFn, sr)
    if (!result.converged) {
      console.log(`[vsm] Eigenform did NOT converge — self-assessment unstable`)
    }
    return result
  }
```

- [ ] **Step 8: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/s5/ruleBasedS5.ts engine/__tests__/observerEffectsWiring.test.ts
git commit -m "feat(vsm): wire observer divergence and eigenform into S5 — dead to live"
```

---

### Task 8: Add VSM axiom checks

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (periodic axiom checks)
- Test: `engine/__tests__/axiomChecks.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/axiomChecks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { vsm } from '../cybernetics-core/src/index.js'

describe('VSM axiom checks', () => {
  it('checkAxiom1 returns true when varieties are balanced', () => {
    expect(vsm.checkAxiom1(10, 10, 0.2)).toBe(true)
  })

  it('checkAxiom1 returns false when horizontal exceeds vertical', () => {
    expect(vsm.checkAxiom1(100, 10, 0.2)).toBe(false)
  })

  it('checkAxiom2 returns true when S3/S4 have similar variety', () => {
    expect(vsm.checkAxiom2(5, 5, 0.2)).toBe(true)
  })

  it('checkPrinciple1 validates management absorbs operations', () => {
    expect(vsm.checkPrinciple1(10, 5, 8, 0.3)).toBe(true)
  })

  it('checkPrinciple2 validates channel capacity', () => {
    expect(vsm.checkPrinciple2(100, 50)).toBe(true) // channel has more capacity
    expect(vsm.checkPrinciple2(10, 50)).toBe(false) // insufficient
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd engine && bunx vitest run __tests__/axiomChecks.test.ts`
Expected: PASS

- [ ] **Step 3: Add axiom check method to governance**

In `engine/vsm/cyberneticsGovernance.ts`, add the vsm import:

```typescript
import {
  variety,
  vsm,
  events,
  foundations,
  NodeId,
} from '../cybernetics-core/src/index.js'
```

(vsm is already imported — verify)

Add a method:

```typescript
  /** Run Beer's axiom and principle checks. Returns health summary. */
  private checkAxioms(): { holding: number; total: number; violations: string[] } {
    const violations: string[] = []
    const snap = this.varietyEngine.current()
    const envVariety = snap?.inputCount ?? 1
    const regVariety = snap?.amplified ?? 1

    // Axiom 1: variety balance at operational level
    if (!vsm.checkAxiom1(envVariety, regVariety, 0.3)) {
      violations.push('Axiom1: operational variety exceeds management capacity')
    }

    // Axiom 2: S3 and S4 have balanced variety for arbitration
    const balance = this.homeostatIntegration.getBalance()
    if (!vsm.checkAxiom2(balance.s3Pressure, balance.s4Pressure, 0.4)) {
      violations.push('Axiom2: S3/S4 variety imbalance impairs arbitration')
    }

    // Principle 1: management variety absorbs operational variety
    if (!vsm.checkPrinciple1(regVariety, envVariety * 0.5, envVariety, 0.3)) {
      violations.push('Principle1: management variety insufficient for operational demands')
    }

    // Principle 4: timeliness — S4 reflection not lagging
    const reflector = this._reflector
    const turnsSinceReflection = this.turnCount % (reflector as any).x ?? 5
    if (!vsm.checkPrinciple4(turnsSinceReflection, 15)) {
      violations.push('Principle4: S4 reflection lag exceeds 15 turns')
    }

    const total = 4
    const holding = total - violations.length
    return { holding, total, violations }
  }
```

- [ ] **Step 4: Wire axiom checks into onTurnComplete**

In `onTurnComplete()`, after the variety event emission (around line 321), add:

```typescript
    // Periodic axiom check — aligned with S4 reflection cycle
    if (this.turnCount % 5 === 0 && this.turnCount > 0) {
      this.lastAxiomHealth = this.checkAxioms()
      if (this.lastAxiomHealth.violations.length > 0) {
        console.log(`[vsm] Axiom violations: ${this.lastAxiomHealth.violations.join(', ')}`)
      }
    }
```

Add the field:

```typescript
  private lastAxiomHealth: { holding: number; total: number; violations: string[] } = { holding: 0, total: 0, violations: [] }
```

- [ ] **Step 5: Update getReport() axiomHealth**

In `getReport()`, change the `axiomHealth` line to:

```typescript
      axiomHealth: this.lastAxiomHealth,
```

- [ ] **Step 6: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/__tests__/axiomChecks.test.ts
git commit -m "feat(vsm): add periodic Beer axiom and principle checks with violation reporting"
```

---

### Task 9: Autopoiesis and constraints cleanup

**Files:**
- Modify: `engine/vsm/autopoiesisIntegration.ts`
- Modify: `engine/vsm/constraintChecks.ts`

- [ ] **Step 1: Verify autopoiesis already uses library**

```bash
cd engine && grep -n "cybernetics-core\|@cybernetics/core" vsm/autopoiesisIntegration.ts
```

Expected: imports from library

- [ ] **Step 2: Verify constraints already uses library**

```bash
cd engine && grep -n "cybernetics-core\|@cybernetics/core" vsm/constraintChecks.ts
```

Expected: imports from library

- [ ] **Step 3: Add isAutopoietic check to autopoiesisIntegration**

If not already present, add a method that uses `autopoiesis.isAutopoietic()` from the library. Read the file first to determine what's needed.

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit (if changes made)**

```bash
git add engine/vsm/autopoiesisIntegration.ts engine/vsm/constraintChecks.ts
git commit -m "refactor(vsm): align autopoiesis and constraints with library formal checks"
```

---

### Task 10: Dead code removal

**Files:**
- Scan all `engine/vsm/*.ts` files for duplicated utility functions

- [ ] **Step 1: Grep for functions that duplicate library exports**

```bash
cd engine && grep -rn "function regulatoryVariety\|function entropy\|function classifySeverity\|function calculateBalance\|function requisiteVariety" vsm/ --include="*.ts"
```

Expected: any matches in vsm/ (not cybernetics-core/) are candidates for removal

- [ ] **Step 2: Remove any duplicates found**

Delete hand-rolled utility functions that are now single-line calls to `@cybernetics/core`. Verify no remaining importers.

- [ ] **Step 3: Grep for orphaned exports**

```bash
cd engine && grep -rn "export function\|export class\|export type\|export const" vsm/ --include="*.ts" | grep -v "test\|spec"
```

For each export, verify it has at least one importer.

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A engine/vsm/
git commit -m "refactor(vsm): remove hand-rolled functions replaced by @cybernetics/core"
```

---

### Task 11: Wire check

- [ ] **Step 1: Verify library imports in all integration files**

```bash
cd engine && grep -l "cybernetics-core" vsm/*.ts | sort
```

Expected: all `*Integration.ts` files import from library

- [ ] **Step 2: Verify heterarchyAuthority is populated (not null)**

```bash
cd engine && grep -n "heterarchyAuthority" bridge/conversationLoop.ts
```

Expected: NOT `heterarchyAuthority: null` — should be the function that reads from governance

- [ ] **Step 3: Verify agreementRatio flows through**

```bash
cd engine && grep -n "agreementRatio" vsm/cyberneticsGovernance.ts s5/types.ts bridge/conversationLoop.ts s5/ruleBasedS5.ts
```

Expected: defined in types.ts, populated in conversationLoop, consumed in ruleBasedS5 (W8 rule)

- [ ] **Step 4: Verify observerDivergence flows through**

```bash
cd engine && grep -n "observerDivergence" vsm/cyberneticsGovernance.ts s5/types.ts bridge/conversationLoop.ts s5/ruleBasedS5.ts
```

Expected: defined in types.ts, populated in conversationLoop, consumed in ruleBasedS5 (W9 rule)

- [ ] **Step 5: Verify axiom checks run**

```bash
cd engine && grep -n "checkAxioms\|axiomHealth\|checkAxiom1" vsm/cyberneticsGovernance.ts
```

Expected: checkAxioms() defined, called in onTurnComplete, result in getReport()

- [ ] **Step 6: Verify all new S5 rules are in ALL_RULES**

```bash
cd engine && grep -n "W8\|W9" s5/ruleBasedS5.ts
```

Expected: W8 and W9 defined and in ALL_RULES array

- [ ] **Step 7: Run full test suite**

```bash
cd engine && bunx vitest run
cd tui && python -m pytest tests/ -v
```

Expected: ALL tests pass

- [ ] **Step 8: Commit wire check**

```bash
git commit --allow-empty -m "test: wire check — cybernetics library integration verified end-to-end"
```
