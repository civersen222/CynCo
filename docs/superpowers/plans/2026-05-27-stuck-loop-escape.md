# Stuck Loop Escape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the stuck loop escape mechanism so the model actually breaks out of repetitive loops instead of spinning for 47+ turns.

**Architecture:** Four-tier escalating intervention (nudge → restrict → redirect → halt) wired into the existing S5 rule system and conversation loop. Smarter stuck detection using tool call signatures alongside response text.

**Tech Stack:** TypeScript (Bun), existing S5 rule framework, existing governance system.

**Spec:** `docs/superpowers/specs/2026-05-27-stuck-loop-escape-design.md`

---

## File Structure

**Modify:**
- `engine/vsm/cyberneticsGovernance.ts` — tool signature tracking, getStuckCount(), getRecentToolNames(), smarter comparison
- `engine/vsm/types.ts` — add `recentToolNames` to GovernanceReport
- `engine/s5/ruleBasedS5.ts` — new C7 critical rule, fix W3
- `engine/bridge/conversationLoop.ts` — system prompt injection, synthetic user message, hard halt

**Test:**
- `engine/__tests__/vsm/stuckDetection.test.ts` (new)
- `engine/__tests__/s5/ruleBasedS5.test.ts` (existing, add C7 + W3 tests)

---

### Task 1: Smarter stuck detection + expose getters

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts:130-145` (properties), `233-244` (onToolResult), `456-464` (stuck detection), `570-586` (getReport)
- Modify: `engine/vsm/types.ts:9-22` (GovernanceReport)
- Test: `engine/__tests__/vsm/stuckDetection.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vsm/stuckDetection.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

describe('stuck detection', () => {
  it('detects stuck via repeated tool signatures', () => {
    const gov = new CyberneticsGovernance()

    // Simulate 5 identical Read calls (same tool + same target)
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 100, 'file contents here')
      gov.onTurnComplete({
        toolsCalled: 1,
        thinkingTokens: 50,
        totalTokens: 200,
        latencyMs: 500,
        response: 'Different response text each time ' + i,  // responses differ!
      })
    }

    // Should be stuck because tool signatures are identical, even though response text differs
    expect(gov.getStuckCount()).toBeGreaterThanOrEqual(2)
  })

  it('does not mark as stuck when tool signatures vary', () => {
    const gov = new CyberneticsGovernance()

    const tools = ['Read', 'Grep', 'Edit', 'Write', 'Bash']
    for (let i = 0; i < 5; i++) {
      gov.onToolResult(tools[i], true, 100)
      gov.onTurnComplete({
        toolsCalled: 1,
        thinkingTokens: 50,
        totalTokens: 200,
        latencyMs: 500,
        response: 'Some response ' + i,
      })
    }

    expect(gov.getStuckCount()).toBe(0)
  })

  it('exposes recent tool names for C7 rule', () => {
    const gov = new CyberneticsGovernance()

    gov.onToolResult('Read', true, 100)
    gov.onToolResult('Read', true, 100)
    gov.onToolResult('Grep', true, 100)

    const names = gov.getRecentToolNames()
    expect(names).toContain('Read')
    expect(names).toContain('Grep')
  })

  it('includes recentToolNames in governance report', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 100)
    const report = gov.getReport()
    expect(report).toHaveProperty('recentToolNames')
    expect(Array.isArray(report.recentToolNames)).toBe(true)
  })

  it('resets stuck on successful write/edit operations', () => {
    const gov = new CyberneticsGovernance()

    // Get stuck first
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 100)
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 50, totalTokens: 200,
        latencyMs: 500, response: 'same response',
      })
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)

    // Write resets stuck
    gov.onToolResult('Edit', true, 100)
    expect(gov.getStuckCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/vsm/stuckDetection.test.ts`
Expected: FAIL — `gov.getStuckCount is not a function`

- [ ] **Step 3: Implement the changes**

In `engine/vsm/types.ts`, add `recentToolNames` to GovernanceReport (line 21, before closing `}`):

```typescript
  recentToolNames: string[]
```

In `engine/vsm/cyberneticsGovernance.ts`:

**Add property** after `private lastResponses: string[] = []` (around line 140):

```typescript
  private lastToolSignatures: string[] = []
```

**In `onToolResult()`** (line 233), add tool signature tracking after the existing `this.toolHistory.push` block (after line 244):

```typescript
    // Track tool signatures for smarter stuck detection
    this.lastToolSignatures.push(name)
    if (this.lastToolSignatures.length > 5) this.lastToolSignatures = this.lastToolSignatures.slice(-5)
```

**In `onTurnComplete()`** (lines 456-464), replace the stuck detection block:

```typescript
    // Stuck detection: check BOTH response text AND tool signatures
    this.lastResponses.push(metrics.response?.slice(0, 100) ?? '')
    if (this.lastResponses.length > 5) this.lastResponses = this.lastResponses.slice(-5)
    const uniqueResponses = new Set(this.lastResponses).size
    const uniqueToolSigs = new Set(this.lastToolSignatures).size
    const responseStuck = this.lastResponses.length >= 3 && uniqueResponses === 1
    const toolStuck = this.lastToolSignatures.length >= 3 && uniqueToolSigs === 1
    if (responseStuck || toolStuck) {
      this.stuckCount++
    } else {
      this.stuckCount = Math.max(0, this.stuckCount - 1)
    }
```

**Add getters** before the closing `}` of the class:

```typescript
  getStuckCount(): number {
    return this.stuckCount
  }

  getRecentToolNames(): string[] {
    return [...this.lastToolSignatures]
  }
```

**In `getReport()`** (line 570-585), add `recentToolNames` to the returned object:

```typescript
      recentToolNames: this.getRecentToolNames(),
```

Add it after the `axiomHealth` line (line 584).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/vsm/stuckDetection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/vsm/types.ts engine/__tests__/vsm/stuckDetection.test.ts
git commit -m "feat: smarter stuck detection — tool signatures + getStuckCount/getRecentToolNames"
```

---

### Task 2: New C7 critical rule + fix W3

**Files:**
- Modify: `engine/s5/ruleBasedS5.ts:193-209` (W3), after C6 (new C7), `411-418` (ALL_RULES)
- Test: `engine/__tests__/s5/ruleBasedS5.test.ts` (existing or new)

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/s5/stuckRules.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { ALL_RULES } from '../../s5/ruleBasedS5.js'

describe('C7: stuck loop — restrict to unused tools', () => {
  const C7 = ALL_RULES.find(r => r.id === 'C7')!

  it('exists and is critical tier', () => {
    expect(C7).toBeDefined()
    expect(C7.tier).toBe('critical')
  })

  it('fires when stuckTurns >= 5 regardless of tool success rate', () => {
    const result = C7.evaluate({
      turnCount: 20,
      contextUsagePercent: 0.5,
      modelLatencyTrend: 'stable',
      s3s4Balance: 'balanced',
      varietyBalance: 'balanced',
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
      agreementRatio: 1.0,
      observerDivergence: null,
      demotedTools: [],
      recentToolResults: [],
      availableModels: ['qwen3:8b'],
      governance: {
        stuckTurns: 7,
        toolSuccessRate: 1.0,  // 100% success — W3 would NOT fire
        recentToolNames: ['Read', 'Read', 'Read', 'Read', 'Read'],
      },
    } as any)

    expect(result).not.toBeNull()
    expect(result!.tools).toBeDefined()
    // Should include action tools but NOT Read (which was recently used)
    expect(result!.tools).toContain('Edit')
    expect(result!.tools).toContain('Write')
    expect(result!.tools).toContain('Bash')
  })

  it('does not fire when stuckTurns < 5', () => {
    const result = C7.evaluate({
      turnCount: 5,
      contextUsagePercent: 0.5,
      modelLatencyTrend: 'stable',
      s3s4Balance: 'balanced',
      varietyBalance: 'balanced',
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
      agreementRatio: 1.0,
      observerDivergence: null,
      demotedTools: [],
      recentToolResults: [],
      availableModels: ['qwen3:8b'],
      governance: { stuckTurns: 3, toolSuccessRate: 1.0, recentToolNames: ['Read'] },
    } as any)

    expect(result).toBeNull()
  })
})

describe('W3: fires on stuck alone (no tool success requirement)', () => {
  const W3 = ALL_RULES.find(r => r.id === 'W3')!

  it('fires when stuckTurns >= 5 even with 100% tool success', () => {
    const result = W3.evaluate({
      turnCount: 20,
      contextUsagePercent: 0.5,
      modelLatencyTrend: 'stable',
      s3s4Balance: 'balanced',
      varietyBalance: 'balanced',
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
      agreementRatio: 1.0,
      observerDivergence: null,
      demotedTools: [],
      recentToolResults: [],
      availableModels: ['qwen3:8b'],
      governance: { stuckTurns: 7, toolSuccessRate: 1.0, recentToolNames: [] },
    } as any)

    expect(result).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/s5/stuckRules.test.ts`
Expected: FAIL — C7 not found, W3 doesn't fire at 100% success

- [ ] **Step 3: Add C7 and fix W3**

In `engine/s5/ruleBasedS5.ts`:

**Add C7** after C6 (after line 157):

```typescript
const C7: S5Rule = {
  id: 'C7',
  tier: 'critical',
  name: 'Stuck loop — restrict to unused tools',
  evaluate(input) {
    const gov = input.governance as Record<string, unknown> | undefined
    const stuckTurns = (gov?.stuckTurns as number) ?? 0
    if (stuckTurns >= 5) {
      const recentTools = (gov?.recentToolNames as string[]) ?? []
      const recentSet = new Set(recentTools)
      // Get tools NOT used in last 5 turns, plus always include action tools
      const forcedTools = new Set<string>(['Edit', 'Write', 'Bash', 'Grep'])
      for (const t of ALL_TOOL_NAMES) {
        if (!recentSet.has(t)) forcedTools.add(t)
      }
      return {
        tools: [...forcedTools],
        reasoning: `stuck for ${stuckTurns} turns — restricting to unused tools to force new approach`,
      }
    }
    return null
  },
}
```

**Fix W3** (line 193-209) — remove `toolSuccessRate < 0.5` condition:

```typescript
const W3: S5Rule = {
  id: 'W3',
  tier: 'warning',
  name: 'Revert recommendation — stuck',
  evaluate(input) {
    const gov = input.governance as Record<string, unknown> | undefined
    const stuckTurns = (gov?.stuckTurns as number) ?? 0
    if (stuckTurns >= 5) {
      const toolSuccessRate = (gov?.toolSuccessRate as number) ?? 1.0
      return {
        revert: true,
        reasoning: `stuck for ${stuckTurns} turns (${Math.round(toolSuccessRate * 100)}% tool success) — recommending revert`,
      }
    }
    return null
  },
}
```

**Add C7 to ALL_RULES** (line 413):

Change:
```typescript
  C1, C2, C3, C4, C5, C6,
```
to:
```typescript
  C1, C2, C3, C4, C5, C6, C7,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/s5/stuckRules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/s5/ruleBasedS5.ts engine/__tests__/s5/stuckRules.test.ts
git commit -m "feat: C7 critical rule for stuck loops + fix W3 to fire regardless of tool success"
```

---

### Task 3: System prompt injection (stuck >= 3)

**Files:**
- Modify: `engine/bridge/conversationLoop.ts:608` (replace blank comment with injection)

- [ ] **Step 1: Implement governance signal injection**

In `engine/bridge/conversationLoop.ts`, replace line 608:

```typescript
    // Governance signals routed through S5 enforcement, not prompt injection.
```

with:

```typescript
    // Governance signal injection: tell the model it's stuck
    const stuckCount = this.governance.getStuckCount()
    if (stuckCount >= 3) {
      const severity = stuckCount >= 5 ? 'CRITICAL' : 'WARNING'
      const signal = stuckCount >= 5
        ? `## Governance Signal — CRITICAL\n\n` +
          `CRITICAL: You have been stuck for ${stuckCount} turns. Your tools have been restricted.\n\n` +
          `You MUST change your approach NOW. Do something completely different from your last 5 actions.\n` +
          `- If you have been reading files, STOP reading and start editing or writing\n` +
          `- If editing has been failing, try a completely different file or strategy\n` +
          `- Summarize what you know and what specific problem is blocking you`
        : `## Governance Signal\n\n` +
          `WARNING: You have been repeating similar actions for ${stuckCount} turns without progress.\n\n` +
          `REQUIRED: Change your approach immediately.\n` +
          `- If reading files: stop reading and start writing or editing\n` +
          `- If editing fails: try a different file or approach\n` +
          `- If searching: stop searching and act on what you already know\n` +
          `- Summarize what you know and what specific problem is blocking you`
      promptParts.push('')
      promptParts.push(signal)
      console.log(`[vsm] Injected ${severity} governance signal (stuck ${stuckCount} turns)`)
    }
```

- [ ] **Step 2: Verify by reading the code around the edit**

Read lines 600-625 of conversationLoop.ts to confirm the injection is between the strategy section and the contract section, and that `promptParts.push` is the correct way to append.

- [ ] **Step 3: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: inject governance signals into system prompt when stuck >= 3 turns"
```

---

### Task 4: Synthetic user message (stuck >= 10) + hard halt (stuck >= 15)

**Files:**
- Modify: `engine/bridge/conversationLoop.ts:996-1008` (runModelLoop, at top of iteration)

- [ ] **Step 1: Add synthetic message and halt check**

In `engine/bridge/conversationLoop.ts`, inside `runModelLoop()`, at the top of the for loop (after line 996 `for (let i = 0; i < maxIterations; i++) {` and before the iteration start), add:

```typescript
      // ── Stuck loop escape: escalating intervention ──
      const stuckCount = this.governance.getStuckCount()

      // Tier 4: Hard halt at 15+ stuck turns
      if (stuckCount >= 15) {
        console.log(`[vsm] HALT: stuck for ${stuckCount} turns — stopping model loop`)
        this.emit({
          type: 'stream.token',
          text: '\n\n---\n**Session halted** — stuck for ' + stuckCount +
            ' turns without progress. Send a message to redirect.\n',
          messageId: '',
        } as any)
        this.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' } as any)
        break
      }

      // Tier 3: Synthetic user message at 10+ stuck turns (inject once)
      if (stuckCount >= 10 && stuckCount % 5 === 0) {
        console.log(`[vsm] REDIRECT: injecting synthetic user message (stuck ${stuckCount} turns)`)
        this.messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: 'STOP. You have been repeating the same actions for ' + stuckCount + ' turns without making progress. ' +
              'Before your next action, answer these questions:\n' +
              '1. What are you trying to accomplish?\n' +
              '2. What specific problem is preventing progress?\n' +
              '3. What completely different approach could you try?\n\n' +
              'Do NOT repeat any tool call you have made in the last 5 turns.',
          }],
        })
      }
```

This goes right after the `for` line and before `const iterationStartMs = Date.now()`.

- [ ] **Step 2: Verify the injection point**

Read lines 996-1010 of conversationLoop.ts to confirm:
- The halt `break` exits the for loop correctly
- The synthetic message gets added before the model call
- The existing steering check (lines 999-1008) still runs after our check

- [ ] **Step 3: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: synthetic user message at stuck >= 10, hard halt at stuck >= 15"
```

---

### Task 5: Wire check + integration verification

**Files:** None created (verification only)

- [ ] **Step 1: Verify getStuckCount is called from conversationLoop**

```bash
cd engine && grep -n "getStuckCount" bridge/conversationLoop.ts vsm/cyberneticsGovernance.ts
```

Expected: defined in cyberneticsGovernance.ts, called in conversationLoop.ts (system prompt + runModelLoop)

- [ ] **Step 2: Verify getRecentToolNames flows to S5**

```bash
cd engine && grep -n "recentToolNames" vsm/cyberneticsGovernance.ts vsm/types.ts s5/ruleBasedS5.ts
```

Expected: added to GovernanceReport type, returned in getReport(), read by C7 rule

- [ ] **Step 3: Verify C7 is in ALL_RULES**

```bash
cd engine && grep -n "C7" s5/ruleBasedS5.ts
```

Expected: C7 definition + C7 in ALL_RULES array

- [ ] **Step 4: Verify W3 no longer checks toolSuccessRate**

```bash
cd engine && grep -A5 "id: 'W3'" s5/ruleBasedS5.ts
```

Expected: condition is `stuckTurns >= 5` with no `toolSuccessRate < 0.5`

- [ ] **Step 5: Verify governance signal injection replaces the blank comment**

```bash
cd engine && grep -n "Governance signal" bridge/conversationLoop.ts
```

Expected: "Governance signal injection" replacing "Governance signals routed through S5"

- [ ] **Step 6: Verify synthetic message + halt in runModelLoop**

```bash
cd engine && grep -n "HALT\|REDIRECT\|stuck loop escape" bridge/conversationLoop.ts
```

Expected: halt at >= 15, redirect at >= 10

- [ ] **Step 7: Run all tests**

```bash
cd engine && bun test
```

Expected: All existing + new tests pass

- [ ] **Step 8: Commit fixups if needed**

```bash
git add -A && git commit -m "fix: wire check fixups for stuck loop escape"
```

Only if fixups were required.
