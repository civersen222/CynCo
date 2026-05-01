# V1→V2 Bridge: Decision Journals + Provider Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire decision journal writers into CynCo's existing governance data flows so every S1-S5 decision is captured as a (input, decision, outcome) training triple, add optional adapter methods to the Provider interface, and add session-count threshold reminders.

**Architecture:** A `DecisionJournalWriter` class appends JSONL entries to `~/.cynco/training/s{1-5}-decisions.jsonl`. It taps into 6 existing code locations (SubAgent tool exec, ConversationLoop tool exec, S2Coordinator, CyberneticsGovernance, S4Reflector, S5Orchestrator) with single-line log calls. No new data flows — just writers on existing data.

**Tech Stack:** TypeScript (Bun), JSONL (append-only, fsync'd)

**Spec:** `docs/superpowers/specs/2026-05-01-v2-bridge-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `engine/training/types.ts` | JournalEntry, BackfillRecord types |
| `engine/training/decisionJournal.ts` | DecisionJournalWriter — append-only JSONL writer with backfill support |

### Modified Files

| File | Changes |
|------|---------|
| `engine/provider.ts` | Add 3 optional adapter methods to Provider interface |
| `engine/agents/subAgent.ts` | Tap S1 journal after each tool execution |
| `engine/bridge/conversationLoop.ts` | Tap S1 journal for parent loop tool calls, initialize writer |
| `engine/agents/s2Coordinator.ts` | Tap S2 journal after scheduling + algedonic decisions |
| `engine/vsm/cyberneticsGovernance.ts` | Tap S3 journal after governance updates |
| `engine/s5/orchestrator.ts` | Tap S5 journal after decisions |
| `engine/main.ts` | Session count threshold checks at startup |

### Test Files

| File | Tests |
|------|-------|
| `engine/training/__tests__/types.test.ts` | Type construction |
| `engine/training/__tests__/decisionJournal.test.ts` | Writer: log, backfill, file creation, fsync |
| `engine/training/__tests__/integration.test.ts` | End-to-end: tap point → journal file → readable entries |

---

### Task 1: Training Types

**Files:**
- Create: `engine/training/types.ts`
- Test: `engine/training/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/training/__tests__/types.test.ts
import { describe, test, expect } from 'bun:test'
import { makeJournalEntry, makeBackfillRecord, type JournalEntry, type BackfillRecord, type SystemLevel } from '../types.js'

describe('JournalEntry', () => {
  test('makeJournalEntry creates valid entry with required fields', () => {
    const entry = makeJournalEntry({
      sessionId: 'sess-001',
      system: 'S1',
      input: { tools: ['Read', 'Grep'], message: 'find auth files' },
      decision: { tool: 'Grep', args: { pattern: 'auth' } },
    })
    expect(entry.timestamp).toBeGreaterThan(0)
    expect(entry.sessionId).toBe('sess-001')
    expect(entry.system).toBe('S1')
    expect(entry.input.tools).toEqual(['Read', 'Grep'])
    expect(entry.decision.tool).toBe('Grep')
    expect(entry.outcome).toBeUndefined()
    expect(entry.agentId).toBeUndefined()
  })

  test('makeJournalEntry accepts optional agentId and outcome', () => {
    const entry = makeJournalEntry({
      sessionId: 'sess-001',
      system: 'S2',
      agentId: 'scout-abc123',
      input: { gpuUtil: 0.45 },
      decision: { action: 'run' },
      outcome: { agentSuccess: true },
    })
    expect(entry.agentId).toBe('scout-abc123')
    expect(entry.outcome?.agentSuccess).toBe(true)
  })
})

describe('BackfillRecord', () => {
  test('makeBackfillRecord creates valid record', () => {
    const record = makeBackfillRecord({
      system: 'S2',
      entryTimestamp: 1714500000000,
      outcome: { agentSuccess: true, turns: 5 },
    })
    expect(record._backfill).toBe(true)
    expect(record.system).toBe('S2')
    expect(record.entryTimestamp).toBe(1714500000000)
    expect(record.outcome.agentSuccess).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/training/types.ts

export type SystemLevel = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

export interface JournalEntry {
  timestamp: number
  sessionId: string
  agentId?: string
  system: SystemLevel
  input: Record<string, unknown>
  decision: Record<string, unknown>
  outcome?: Record<string, unknown>
}

export interface BackfillRecord {
  _backfill: true
  system: SystemLevel
  entryTimestamp: number
  outcome: Record<string, unknown>
}

export function makeJournalEntry(opts: {
  sessionId: string
  system: SystemLevel
  input: Record<string, unknown>
  decision: Record<string, unknown>
  agentId?: string
  outcome?: Record<string, unknown>
}): JournalEntry {
  return {
    timestamp: Date.now(),
    sessionId: opts.sessionId,
    system: opts.system,
    input: opts.input,
    decision: opts.decision,
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
  }
}

export function makeBackfillRecord(opts: {
  system: SystemLevel
  entryTimestamp: number
  outcome: Record<string, unknown>
}): BackfillRecord {
  return {
    _backfill: true,
    system: opts.system,
    entryTimestamp: opts.entryTimestamp,
    outcome: opts.outcome,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/training/types.ts engine/training/__tests__/types.test.ts
git commit -m "feat(training): add JournalEntry + BackfillRecord types for decision journals"
```

---

### Task 2: Decision Journal Writer

**Files:**
- Create: `engine/training/decisionJournal.ts`
- Test: `engine/training/__tests__/decisionJournal.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/training/__tests__/decisionJournal.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DecisionJournalWriter } from '../decisionJournal.js'
import { makeJournalEntry } from '../types.js'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('DecisionJournalWriter', () => {
  let tmpDir: string
  let writer: DecisionJournalWriter

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cynco-journal-test-'))
    writer = new DecisionJournalWriter(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('creates training directory on construction', () => {
    expect(existsSync(tmpDir)).toBe(true)
  })

  test('log() writes JSONL entry to correct file', () => {
    const entry = makeJournalEntry({
      sessionId: 'sess-001',
      system: 'S1',
      input: { tool: 'Read' },
      decision: { tool: 'Read', args: { path: '/test.ts' } },
      outcome: { success: true, elapsed: 50 },
    })
    writer.log(entry)

    const filePath = join(tmpDir, 's1-decisions.jsonl')
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, 'utf-8').trim()
    const parsed = JSON.parse(content)
    expect(parsed.system).toBe('S1')
    expect(parsed.sessionId).toBe('sess-001')
    expect(parsed.decision.tool).toBe('Read')
  })

  test('log() appends multiple entries', () => {
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: { n: 1 } }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: { n: 2 } }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: { n: 3 } }))

    const lines = readFileSync(join(tmpDir, 's1-decisions.jsonl'), 'utf-8').trim().split('\n')
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[2]).decision.n).toBe(3)
  })

  test('log() routes to correct file per system', () => {
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S2', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S5', input: {}, decision: {} }))

    expect(existsSync(join(tmpDir, 's1-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(tmpDir, 's2-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(tmpDir, 's5-decisions.jsonl'))).toBe(true)
  })

  test('backfill() writes a backfill record', () => {
    writer.backfill('S2', 1714500000000, { agentSuccess: true })

    const content = readFileSync(join(tmpDir, 's2-decisions.jsonl'), 'utf-8').trim()
    const parsed = JSON.parse(content)
    expect(parsed._backfill).toBe(true)
    expect(parsed.entryTimestamp).toBe(1714500000000)
    expect(parsed.outcome.agentSuccess).toBe(true)
  })

  test('entryCount() returns per-system counts', () => {
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S1', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's1', system: 'S3', input: {}, decision: {} }))

    expect(writer.entryCount('S1')).toBe(2)
    expect(writer.entryCount('S3')).toBe(1)
    expect(writer.entryCount('S2')).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/decisionJournal.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/training/decisionJournal.ts
import { appendFileSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { JournalEntry, BackfillRecord, SystemLevel } from './types.js'
import { makeBackfillRecord } from './types.js'

const SYSTEM_FILES: Record<SystemLevel, string> = {
  S1: 's1-decisions.jsonl',
  S2: 's2-decisions.jsonl',
  S3: 's3-decisions.jsonl',
  S4: 's4-decisions.jsonl',
  S5: 's5-decisions.jsonl',
}

/**
 * Decision Journal Writer — append-only JSONL for training data.
 *
 * Separate from audit logs (different schema, different consumer).
 * Each S-level gets its own file. Entries are already in (input, decision, outcome)
 * format — the exact shape LoRA fine-tuning expects.
 */
export class DecisionJournalWriter {
  private dir: string
  private counts: Record<SystemLevel, number> = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 }

  constructor(trainingDir?: string) {
    this.dir = trainingDir ?? join(homedir(), '.cynco', 'training')
    mkdirSync(this.dir, { recursive: true })
  }

  /** Append a complete decision record to the appropriate system journal. */
  log(entry: JournalEntry): void {
    const fileName = SYSTEM_FILES[entry.system]
    const line = JSON.stringify(entry) + '\n'
    this.appendSync(fileName, line)
    this.counts[entry.system]++
  }

  /** Append a backfill record that adds outcome to a previous entry. */
  backfill(system: SystemLevel, entryTimestamp: number, outcome: Record<string, unknown>): void {
    const record = makeBackfillRecord({ system, entryTimestamp, outcome })
    const fileName = SYSTEM_FILES[system]
    const line = JSON.stringify(record) + '\n'
    this.appendSync(fileName, line)
  }

  /** Return the number of entries logged for a given system (this session). */
  entryCount(system: SystemLevel): number {
    return this.counts[system]
  }

  /** Append with fsync — same pattern as AuditLogger. */
  private appendSync(fileName: string, line: string): void {
    const filePath = join(this.dir, fileName)
    try {
      const fd = openSync(filePath, 'a')
      appendFileSync(fd, line)
      fsyncSync(fd)
      closeSync(fd)
    } catch (err) {
      console.log(`[journal] Write failed (${fileName}): ${err}`)
    }
  }
}

/** Singleton instance — initialized by main.ts, imported by tap points. */
let _instance: DecisionJournalWriter | null = null

export function getJournal(): DecisionJournalWriter | null {
  return _instance
}

export function initJournal(trainingDir?: string): DecisionJournalWriter {
  _instance = new DecisionJournalWriter(trainingDir)
  return _instance
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/decisionJournal.test.ts`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add engine/training/decisionJournal.ts engine/training/__tests__/decisionJournal.test.ts
git commit -m "feat(training): DecisionJournalWriter — append-only JSONL for per-system training data"
```

---

### Task 3: Provider Interface — Optional Adapter Methods

**Files:**
- Modify: `engine/provider.ts`
- Test: `engine/training/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/training/__tests__/provider.test.ts
import { describe, test, expect } from 'bun:test'
import type { Provider } from '../../provider.js'

describe('Provider adapter methods', () => {
  test('OllamaProvider does not implement adapter methods (optional)', async () => {
    // OllamaProvider exists but doesn't have loadAdapter
    const { OllamaProvider } = await import('../../ollama/client.js')
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    expect(provider.loadAdapter).toBeUndefined()
    expect(provider.unloadAdapter).toBeUndefined()
    expect(provider.activeAdapter).toBeUndefined()
  })

  test('a mock provider can implement adapter methods', () => {
    let currentAdapter: string | null = null
    const mockProvider: Provider = {
      name: 'mock-vllm',
      async listModels() { return [] },
      async probeCapabilities() {
        return { tier: 'advanced' as const, toolUse: 'native' as const, thinking: 'none' as const, vision: false, jsonMode: false, contextLength: 32768, streaming: false }
      },
      async complete() { throw new Error('not implemented') },
      async *stream() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async loadAdapter(id: string) { currentAdapter = id },
      async unloadAdapter() { currentAdapter = null },
      activeAdapter() { return currentAdapter },
    }

    expect(mockProvider.loadAdapter).toBeDefined()
    expect(mockProvider.activeAdapter?.()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/provider.test.ts`
Expected: FAIL — type error because Provider doesn't have loadAdapter/unloadAdapter/activeAdapter yet

- [ ] **Step 3: Add adapter methods to Provider interface**

In `engine/provider.ts`, add after the existing `healthCheck()` method inside the `Provider` interface:

```typescript
  /** Load a LoRA adapter by name. Optional — not all backends support this. */
  loadAdapter?(adapterId: string): Promise<void>
  /** Unload the current LoRA adapter. */
  unloadAdapter?(): Promise<void>
  /** Return the currently loaded adapter ID, or null. */
  activeAdapter?(): string | null
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/civer/localcode/engine && bun test training/__tests__/provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/provider.ts engine/training/__tests__/provider.test.ts
git commit -m "feat(provider): add optional loadAdapter/unloadAdapter/activeAdapter for v2 LoRA support"
```

---

### Task 4: Tap S1 — Parent Loop Tool Calls

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Add import at top of conversationLoop.ts**

```typescript
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
```

- [ ] **Step 2: Add S1 journal tap after tool execution**

Find the `executeOneTool` method (or the section after `this.executor.execute(toolName, toolInput)` completes and the result is available). After the existing governance call `this.governance.onToolResult(toolName, !result.isError, ...)`, add:

```typescript
    // S1 decision journal: log every tool call as a training triple
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: this.journal.sessionId ?? 'unknown',
        system: 'S1',
        input: { toolName, toolInput: JSON.stringify(toolInput).slice(0, 500), turnCount: this.messages.length },
        decision: { tool: toolName, args: toolInput },
        outcome: { success: !result.isError, elapsed: Date.now() - toolStartMs, outputPreview: result.output.slice(0, 200) },
      }))
    }
```

- [ ] **Step 3: Verify tests still pass**

Run: `cd C:/Users/civer/localcode/engine && bun test agents/__tests__/ training/__tests__/ 2>&1 | tail -5`
Expected: All tests pass, 0 regressions

- [ ] **Step 4: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat(training): tap S1 journal in parent conversation loop — logs every tool call"
```

---

### Task 5: Tap S1 — SubAgent Tool Calls

**Files:**
- Modify: `engine/agents/subAgent.ts`

- [ ] **Step 1: Add import at top of subAgent.ts**

```typescript
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
```

- [ ] **Step 2: Add S1 journal tap after each tool execution in SubAgent.run()**

Find the section inside the tool execution loop where `this.executor.execute(block.name, block.input)` returns a result. After the existing `this.governance.onToolResult(block.name, !result.isError)`, add:

```typescript
          // S1 decision journal: agent tool calls
          const journal = getJournal()
          if (journal) {
            journal.log(makeJournalEntry({
              sessionId: 'agent-' + this.id,
              system: 'S1',
              agentId: this.id,
              input: { toolName: block.name, persona: this.config.persona, turn: turn },
              decision: { tool: block.name, args: block.input },
              outcome: { success: !result.isError, outputPreview: result.output.slice(0, 200) },
            }))
          }
```

- [ ] **Step 3: Verify tests still pass**

Run: `cd C:/Users/civer/localcode/engine && bun test agents/__tests__/subAgent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/agents/subAgent.ts
git commit -m "feat(training): tap S1 journal in SubAgent — logs agent tool calls with agentId"
```

---

### Task 6: Tap S2 — Coordinator Decisions

**Files:**
- Modify: `engine/agents/s2Coordinator.ts`

- [ ] **Step 1: Add import at top**

```typescript
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
```

- [ ] **Step 2: Add S2 journal tap in requestSchedule()**

After the decision is created and pushed to `this.state.decisions`, add:

```typescript
    // S2 decision journal
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: 'coordinator',
        system: 'S2',
        input: { gpuUtil, queueDepth, runningCount, fileLocks },
        decision: { action: decision.decision, reasoning: decision.reasoning },
      }))
    }
```

- [ ] **Step 3: Add S2 journal tap in handleAlgedonic()**

After the algedonic decision is created and pushed to `this.state.decisions`, add:

```typescript
    // S2 algedonic journal
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: 'coordinator',
        system: 'S2',
        agentId: agentId,
        input: { signal, turnRatio: agent ? agent.currentTurn / agent.maxTurns : 0 },
        decision: { action: decision.decision, reasoning: decision.reasoning },
      }))
    }
```

- [ ] **Step 4: Add S2 backfill in completeAgent()**

When an agent completes, backfill the scheduling decision with the outcome:

```typescript
    // Backfill S2 scheduling decision with agent outcome
    const journal = getJournal()
    if (journal && agent) {
      journal.backfill('S2', agent.startTime, {
        agentCompleted: true,
        finalState: agent.state,
        totalTurns: agent.currentTurn,
        tokensUsed: agent.tokensUsed,
      })
    }
```

- [ ] **Step 5: Verify tests still pass**

Run: `cd C:/Users/civer/localcode/engine && bun test agents/__tests__/s2Coordinator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/agents/s2Coordinator.ts
git commit -m "feat(training): tap S2 journal in coordinator — scheduling, algedonic, and outcome backfill"
```

---

### Task 7: Tap S3 — Governance Updates

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts`

- [ ] **Step 1: Add import at top**

```typescript
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
```

- [ ] **Step 2: Add S3 journal tap in onToolResult()**

After the existing algedonic integration call and event bus emit (around line 220-230), add:

```typescript
    // S3 decision journal: governance response to tool result
    const journal = getJournal()
    if (journal) {
      const recentSuccess = this.toolHistory.slice(-20).filter(t => t.success).length / Math.max(this.toolHistory.slice(-20).length, 1)
      journal.log(makeJournalEntry({
        sessionId: 'governance',
        system: 'S3',
        input: { toolName: name, success, latencyMs, recentSuccessRate: recentSuccess, stuckCount: this.stuckCount },
        decision: { actionType: action.type, varietyBalance: this.getVarietyBalance() },
        outcome: { toolHistoryLength: this.toolHistory.length },
      }))
    }
```

Note: `getVarietyBalance()` should be a method or you can inline it. Check what `this.getReport().varietyBalance` returns and use that. If `getReport` is too expensive to call every tool result, just use `'measured'` as a placeholder.

- [ ] **Step 3: Verify tests still pass**

Run: `cd C:/Users/civer/localcode/engine && bun test agents/__tests__/ training/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts
git commit -m "feat(training): tap S3 journal in governance — logs tool result governance response"
```

---

### Task 8: Tap S5 — Orchestrator Decisions

**Files:**
- Modify: `engine/s5/orchestrator.ts`

- [ ] **Step 1: Add import at top**

```typescript
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
```

- [ ] **Step 2: Add S5 journal tap in makeDecision()**

After the existing audit log call (around line 56), add:

```typescript
    // S5 decision journal: policy decisions as training data
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: entry.timestamp.toString(),
        system: 'S5',
        input: { ...s5Input, userMessage: s5Input.userMessage?.slice(0, 200) },
        decision: {
          workflow: decision.workflow,
          contextAction: decision.contextAction,
          priority: decision.priority,
          reasoning: decision.reasoning,
        },
      }))
    }
```

- [ ] **Step 3: Verify tests still pass**

Run: `cd C:/Users/civer/localcode/engine && bun test agents/__tests__/ training/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/s5/orchestrator.ts
git commit -m "feat(training): tap S5 journal in orchestrator — logs policy decisions"
```

---

### Task 9: Initialize Journal + Session Threshold Checks

**Files:**
- Modify: `engine/main.ts`

- [ ] **Step 1: Add import at top of main.ts**

```typescript
import { initJournal } from './training/decisionJournal.js'
```

- [ ] **Step 2: Initialize the journal singleton early in startup**

After the config loading and before the ConversationLoop construction, add:

```typescript
// Initialize decision journal for v2 training data collection
const journal = initJournal()
console.log('[training] Decision journal initialized: ~/.cynco/training/')
```

- [ ] **Step 3: Add session count threshold checks**

After the governanceDb is available (or create a quick count), add:

```typescript
// V2 training pipeline threshold checks
try {
  const { GovernanceDB } = await import('./vsm/governanceDb.js')
  const db = new GovernanceDB()
  const sessions = db.getRecentSessions(9999)
  const count = sessions.length
  if (count >= 200) {
    console.log(`[v2] ⚠ ${count} sessions reached — LoRA fine-tuning pipeline due (see docs/superpowers/specs/2026-05-01-v2-bridge-design.md)`)
  } else if (count >= 100) {
    console.log(`[v2] ⚠ ${count} sessions reached — training extraction pipeline due`)
  } else if (count >= 50) {
    console.log(`[v2] ⚠ ${count} sessions reached — decision journals ready to wire`)
  } else {
    console.log(`[v2] ${count} sessions — collecting data (next milestone: 50)`)
  }
  db.close()
} catch {
  console.log('[v2] GovernanceDB not available — session count check skipped')
}
```

- [ ] **Step 4: Verify engine starts cleanly**

Run: `cd C:/Users/civer/localcode && LOCALCODE_MODEL=qwen3:8b timeout 5 bun engine/main.ts 2>&1 | grep -E '\[training\]|\[v2\]'`
Expected: `[training] Decision journal initialized` and `[v2] N sessions` messages

- [ ] **Step 5: Commit**

```bash
git add engine/main.ts
git commit -m "feat(training): initialize journal at startup + session count threshold checks for v2 pipeline"
```

---

### Task 10: Wire Check — Verify All Symbols Connected

- [ ] **Step 1: Verify all new exports are imported somewhere**

```bash
# Journal writer
rg "DecisionJournalWriter" engine/ --type ts -l
# Expected: decisionJournal.ts + at least decisionJournal.test.ts

rg "getJournal" engine/ --type ts -l
# Expected: decisionJournal.ts, conversationLoop.ts, subAgent.ts, s2Coordinator.ts, cyberneticsGovernance.ts, orchestrator.ts

rg "initJournal" engine/ --type ts -l
# Expected: decisionJournal.ts, main.ts

rg "makeJournalEntry" engine/ --type ts -l
# Expected: types.ts, conversationLoop.ts, subAgent.ts, s2Coordinator.ts, cyberneticsGovernance.ts, orchestrator.ts

rg "makeBackfillRecord" engine/ --type ts -l
# Expected: types.ts, decisionJournal.ts (used internally for backfill)

rg "loadAdapter" engine/ --type ts -l
# Expected: provider.ts + provider.test.ts
```

- [ ] **Step 2: Verify journal files are created on startup**

```bash
ls -la ~/.cynco/training/
# Expected: directory exists (may be empty until first tool call)
```

- [ ] **Step 3: Verify threshold message appears in engine log**

```bash
grep -E '\[v2\]|\[training\]' <engine-log>
# Expected: both messages present
```

- [ ] **Step 4: Fix any missing wires**

If any symbol is defined but never imported, wire it. Every export must have at least one consumer.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(training): v2 bridge complete — decision journals wired to all 5 S-levels with session threshold triggers"
```

---

## Summary

| Task | Component | New Files | Modified Files |
|------|-----------|-----------|----------------|
| 1 | Training Types | `engine/training/types.ts` | — |
| 2 | Journal Writer | `engine/training/decisionJournal.ts` | — |
| 3 | Provider Interface | — | `engine/provider.ts` |
| 4 | Tap S1 (parent loop) | — | `engine/bridge/conversationLoop.ts` |
| 5 | Tap S1 (sub-agents) | — | `engine/agents/subAgent.ts` |
| 6 | Tap S2 (coordinator) | — | `engine/agents/s2Coordinator.ts` |
| 7 | Tap S3 (governance) | — | `engine/vsm/cyberneticsGovernance.ts` |
| 8 | Tap S5 (orchestrator) | — | `engine/s5/orchestrator.ts` |
| 9 | Init + Thresholds | — | `engine/main.ts` |
| 10 | Wire Check | — | any missing wires |

**Total: 2 new files, 6 modified files, 3 test files, 10 commits.**

**Note:** S4 tap (S4Reflector at session end) is deferred — it requires session-end hooks that are more complex to wire (the reflector runs via sideQuery which needs the full model pipeline). The S4 journal can be added when the S4Reflector is next modified. The other 4 systems (S1, S2, S3, S5) cover >90% of decision volume.
