# S5 Outcome-Grounded Training Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make S5 policy decisions trainable by joining each logged decision to its real session outcome, persisting the (already-computed-but-dropped) prediction evaluations, and exporting a reward-filtered `{input, output}` JSONL that `fine_tune_s5.py` can consume end-to-end.

**Architecture:** One join key — `sessionId`. Decisions are journaled to `~/.cynco/training/s5-decisions.jsonl`; outcomes are recorded to `~/.cynco/governance/governance.db` (`sessions` table). Today two *unsynced* session ids exist (`conversationLoop.sessionId` vs `CyberneticsGovernance._sessionId`) and the orchestrator journals a *timestamp* instead of a session id, so the join is impossible. We unify the id, fix the orchestrator stamp, add a session-end bridge that flushes `PredictionTracker.completedPredictions` into `governance.db`, then add a join-at-export step (read journal, look up outcome by sessionId, keep only `viable` sessions) that emits training data. The existing rule-distillation exporter (`trainingData.ts` + `aggregate_training_data.py`) is deleted.

**Tech Stack:** TypeScript (Bun runtime; tests via `vitest run` with `bun:test`/`bun:sqlite` shims), Python (`fine_tune_s5.py`, Unsloth LoRA), SQLite (`bun:sqlite`).

---

## File Structure

**Modified (TypeScript):**
- `engine/vsm/cyberneticsGovernance.ts` — add `setSessionId()`, `flushPredictions()`; fix banned empty `catch {}` at ~1016.
- `engine/bridge/conversationLoop.ts` — call `governance.setSessionId(this.sessionId)` at both id-assignment sites; pass `sessionId` into the S5 decision call.
- `engine/s5/orchestrator.ts` — add `sessionId?` to `OrchestratorInput`; journal the real session id.
- `engine/vsm/governanceDb.ts` — write-guard `totalTurns<=0` in `recordSession`; add `recordCompletedPrediction()` and `purgeDegenerateSessions()`.
- `engine/main.ts` — call `purgeDegenerateSessions()` once at startup; flush predictions at both session-end sites; repoint `--export-training` to the new exporter.
- `scripts/fine_tune_s5.py` — repoint `DEFAULT_TRAINING_DATA` to `~/.cynco`; add `--validate-only`; update the deleted-script hint.

**Created (TypeScript):**
- `engine/s5/exportTrainingData.ts` — `formatJournalInput`, `joinViableExamples`, `loadOutcomesFromDb`, `exportViableExamples`, `import.meta.main` CLI.
- `engine/__tests__/s5/exportTrainingData.test.ts` — unit tests for the pure join + format + file export.

**Deleted:**
- `engine/s5/trainingData.ts`
- `engine/__tests__/s5/trainingData.test.ts`
- `scripts/aggregate_training_data.py`

---

### Task 1: Canonical session id — `setSessionId()` on governance

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (add method near `getGovernanceDb()` ~1019)
- Modify: `engine/bridge/conversationLoop.ts:337-341` (fresh) and `:466-468` (resume)
- Test: `engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

describe('CyberneticsGovernance.setSessionId', () => {
  it('overrides the auto-generated session id used for outcome persistence', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('session-canonical-123')
    expect(gov.getSessionId()).toBe('session-canonical-123')
  })

  it('is idempotent and takes the last value', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('a')
    gov.setSessionId('b')
    expect(gov.getSessionId()).toBe('b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts`
Expected: FAIL — `gov.setSessionId is not a function` (and/or `getSessionId` missing).

- [ ] **Step 3: Add `setSessionId` + `getSessionId`**

In `engine/vsm/cyberneticsGovernance.ts`, immediately after `getGovernanceDb()` (the method that `return this._db`, ~line 1021), add:

```ts
  /**
   * Overwrite the auto-generated session id so it matches the conversation
   * loop's canonical id. Required for the decision-journal → outcome join:
   * decisions are journaled under conversationLoop.sessionId, and this makes
   * recordSessionOutcome() and flushPredictions() write under the same id.
   */
  setSessionId(id: string): void {
    this._sessionId = id
  }

  /** The session id used for outcome + prediction persistence. */
  getSessionId(): string {
    return this._sessionId
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the setter into conversationLoop (both id sites)**

In `engine/bridge/conversationLoop.ts`, the fresh-session block currently reads:

```ts
    this.sessionId = `session-${Date.now()}`
    this.journal = new JSONLStore(this.sessionId)
    // Stamp the session id so SaveLearning tags learnings for AWM promotion.
    process.env.LOCALCODE_SESSION_ID = this.sessionId
```

Add the governance sync right after the `process.env` stamp:

```ts
    this.sessionId = `session-${Date.now()}`
    this.journal = new JSONLStore(this.sessionId)
    // Stamp the session id so SaveLearning tags learnings for AWM promotion.
    process.env.LOCALCODE_SESSION_ID = this.sessionId
    // Unify governance's session id with the conversation loop's so the
    // decision journal and the outcome/prediction rows share one join key.
    this.governance.setSessionId(this.sessionId)
```

In the `resume()` method, after `process.env.LOCALCODE_SESSION_ID = sessionId`:

```ts
      this.sessionId = sessionId
      this.thinkingRecorder = new ThinkingRecorder(this.sessionId)
      process.env.LOCALCODE_SESSION_ID = sessionId
      this.governance.setSessionId(sessionId)
```

- [ ] **Step 6: Verify governance is constructed before both sites**

Run: `npx vitest run engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts && grep -n "this.governance = new" engine/bridge/conversationLoop.ts`
Expected: test PASS; grep prints the `this.governance = new GovernanceLayer(` line at ~305 (proves `this.governance` exists before line 337 — construction precedes id assignment).

- [ ] **Step 7: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/bridge/conversationLoop.ts engine/__tests__/vsm/cyberneticsGovernance.setSessionId.test.ts
git commit -m "feat(s5): unify governance session id with conversation loop for outcome join"
```

---

### Task 2: Orchestrator journals the real session id

**Files:**
- Modify: `engine/s5/orchestrator.ts:10-31` (type) and `:131-142` (journal call)
- Modify: `engine/bridge/conversationLoop.ts:947` (pass `sessionId`)
- Test: `engine/__tests__/s5/orchestratorSessionId.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/s5/orchestratorSessionId.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { initJournal } from '../../training/decisionJournal.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { GovernanceReport } from '../../vsm/types.js'

function baseGovernance(): GovernanceReport {
  return {
    status: 'healthy', s3s4Balance: 'balanced', modelLatencyTrend: 'stable',
    stuckTurns: 0, toolSuccessRate: 1.0,
    taskError: null, errorTrend: null, fingerprintAlarm: null,
    infoGain: null, progressRate: null, explorationState: null,
  } as unknown as GovernanceReport
}

describe('S5Orchestrator journal session id', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'journal-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('stamps the passed sessionId (not a timestamp) on the journal entry', async () => {
    initJournal(dir)
    const orch = new S5Orchestrator(new RuleBasedS5())
    await orch.makeDecision({
      userMessage: 'hi', activeWorkflow: null, currentPhase: null,
      contextUsagePercent: 0.5, governance: baseGovernance(),
      recentToolResults: [], availableModels: ['qwen3:8b'], turnCount: 1,
      sessionId: 'session-XYZ',
    })
    const file = join(dir, 's5-decisions.jsonl')
    expect(existsSync(file)).toBe(true)
    const line = readFileSync(file, 'utf-8').trim().split('\n')[0]
    expect(JSON.parse(line).sessionId).toBe('session-XYZ')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/s5/orchestratorSessionId.test.ts`
Expected: FAIL — `sessionId` on the journal entry is a numeric timestamp string, not `session-XYZ` (and `OrchestratorInput` has no `sessionId`, so a TS/shape error may surface first).

- [ ] **Step 3: Add `sessionId` to `OrchestratorInput`**

In `engine/s5/orchestrator.ts`, extend the type (after `promptDifficulty?` at line 30):

```ts
  promptDifficulty?: DifficultyLevel
  /** Canonical session id — the join key for the decision-journal → outcome join. */
  sessionId?: string
}
```

- [ ] **Step 4: Journal the real session id**

In `engine/s5/orchestrator.ts`, change the journal call (line 131-142) from `sessionId: entry.timestamp.toString(),` to a real id with fallbacks:

```ts
      journal.log(makeJournalEntry({
        sessionId: input.sessionId ?? process.env.LOCALCODE_SESSION_ID ?? entry.timestamp.toString(),
        system: 'S5',
        input: { ...s5Input, userMessage: s5Input.userMessage?.slice(0, 200) },
        decision: {
          workflow: decision.workflow,
          contextAction: decision.contextAction,
          priority: decision.priority,
          reasoning: decision.reasoning,
        },
      }))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/s5/orchestratorSessionId.test.ts`
Expected: PASS.

- [ ] **Step 6: Pass `sessionId` from the live call site**

In `engine/bridge/conversationLoop.ts`, the `this.s5.makeDecision({ ... })` object ends with `promptDifficulty: this.difficultyClassifier.getLevel(),` (line 947). Add the session id as the final field:

```ts
          demotedTools: this.executor.getToolScorer?.()?.getDemotedTools() ?? [],
          promptDifficulty: this.difficultyClassifier.getLevel(),
          sessionId: this.sessionId,
        })
```

- [ ] **Step 7: Commit**

```bash
git add engine/s5/orchestrator.ts engine/bridge/conversationLoop.ts engine/__tests__/s5/orchestratorSessionId.test.ts
git commit -m "feat(s5): journal real session id instead of decision timestamp"
```

---

### Task 3: governanceDb write-guard + degenerate purge

**Files:**
- Modify: `engine/vsm/governanceDb.ts:146-163` (guard) and add `purgeDegenerateSessions()`
- Test: `engine/__tests__/vsm/governanceDb.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `engine/__tests__/vsm/governanceDb.test.ts` inside the top-level `describe('GovernanceDB', ...)` block:

```ts
  it('refuses to record a degenerate session with totalTurns <= 0', () => {
    db.recordSession({
      sessionId: 'sess-degenerate', outcome: 'viable', configIndex: 0,
      strategy: 'default', toolSuccessRate: 1.0, stuckTurns: 0,
      totalTurns: 0, filesChanged: 0,
    })
    expect(db.getRecentSessions(10)).toHaveLength(0)
  })

  it('purges pre-existing degenerate rows and reports the count', () => {
    // Backdoor a degenerate row via a second connection so the write-guard
    // doesn't block the setup, simulating legacy data written before the guard.
    const raw = new (require('bun:sqlite').Database)(join(tmpDir, 'governance.db'))
    raw.exec(`INSERT INTO sessions (session_id, outcome, config_index, strategy, tool_success_rate, stuck_turns, total_turns, files_changed) VALUES ('legacy-0', 'viable', 0, 'default', 1.0, 0, 0, 0)`)
    raw.close()

    db.recordSession({
      sessionId: 'sess-good', outcome: 'viable', configIndex: 0,
      strategy: 'default', toolSuccessRate: 1.0, stuckTurns: 0,
      totalTurns: 12, filesChanged: 2,
    })

    const purged = db.purgeDegenerateSessions()
    expect(purged).toBe(1)
    const rows = db.getRecentSessions(10)
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe('sess-good')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/vsm/governanceDb.test.ts`
Expected: FAIL — degenerate row gets recorded (guard missing); `db.purgeDegenerateSessions is not a function`.

- [ ] **Step 3: Add the write-guard**

In `engine/vsm/governanceDb.ts`, at the top of `recordSession()` (before building the stmt, line ~147):

```ts
  recordSession(record: SessionRecord): void {
    // Write-guard: a session with no turns carries no learnable signal and
    // pollutes the outcome join. Drop it at the boundary.
    if (record.totalTurns <= 0) {
      console.warn(`[govdb] skipping degenerate session ${record.sessionId} (totalTurns=${record.totalTurns})`)
      return
    }
    const stmt = this.db.prepare(`
```

- [ ] **Step 4: Add `purgeDegenerateSessions`**

In `engine/vsm/governanceDb.ts`, add after `getRecentSessions()` (~line 184):

```ts
  /**
   * Delete legacy degenerate sessions (total_turns <= 0) written before the
   * write-guard existed. Returns the number of rows removed. Idempotent.
   */
  purgeDegenerateSessions(): number {
    const before = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    this.db.exec('DELETE FROM sessions WHERE total_turns <= 0')
    const after = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    return before - after
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/vsm/governanceDb.test.ts`
Expected: PASS (all existing cases + the 2 new ones).

- [ ] **Step 6: Commit**

```bash
git add engine/vsm/governanceDb.ts engine/__tests__/vsm/governanceDb.test.ts
git commit -m "feat(govdb): reject and purge degenerate zero-turn sessions"
```

---

### Task 4: `recordCompletedPrediction` on governanceDb

**Files:**
- Modify: `engine/vsm/governanceDb.ts` (add method after `evaluatePrediction()` ~350)
- Test: `engine/__tests__/vsm/governanceDb.test.ts` (append case)

- [ ] **Step 1: Write the failing test**

Append inside `describe('GovernanceDB', ...)` in `engine/__tests__/vsm/governanceDb.test.ts`:

```ts
  it('records an already-evaluated prediction in a single insert', () => {
    db.recordCompletedPrediction({
      sessionId: 'sess-pred', hypothesis: 'H1', triggerTurn: 5,
      triggerContext: 'stuck=5,restricted=true', predictedOutcome: 'Edit/Write within 3 turns',
      actualOutcome: 'action_tools_used=true', correct: true, evaluationTurn: 8,
    })
    const rows = db.getPredictions('sess-pred')
    expect(rows).toHaveLength(1)
    expect(rows[0].hypothesis).toBe('H1')
    expect(rows[0].correct).toBe(1)
    expect(rows[0].actual_outcome).toBe('action_tools_used=true')
    expect(rows[0].evaluation_turn).toBe(8)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vsm/governanceDb.test.ts`
Expected: FAIL — `db.recordCompletedPrediction is not a function`.

- [ ] **Step 3: Add the method**

In `engine/vsm/governanceDb.ts`, after `evaluatePrediction()` (~line 350):

```ts
  /**
   * Insert a prediction that was already opened AND evaluated in-memory by
   * PredictionTracker. Unlike recordPrediction()/evaluatePrediction() (open
   * then update), this is a single write used by the session-end flush.
   */
  recordCompletedPrediction(record: {
    sessionId: string
    hypothesis: string
    triggerTurn: number
    triggerContext: string
    predictedOutcome: string
    actualOutcome: string
    correct: boolean
    evaluationTurn: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO predictions
        (session_id, hypothesis, trigger_turn, trigger_context,
         predicted_outcome, actual_outcome, correct, evaluation_turn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.sessionId,
      record.hypothesis,
      record.triggerTurn,
      record.triggerContext,
      record.predictedOutcome,
      record.actualOutcome,
      record.correct ? 1 : 0,
      record.evaluationTurn,
    )
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vsm/governanceDb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/governanceDb.ts engine/__tests__/vsm/governanceDb.test.ts
git commit -m "feat(govdb): add recordCompletedPrediction single-insert path"
```

---

### Task 5: `flushPredictions()` bridge + fix banned empty catch

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts` (add `flushPredictions()`; fix `catch {}` at ~1016)
- Test: `engine/__tests__/vsm/cyberneticsGovernance.flush.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vsm/cyberneticsGovernance.flush.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { GovernanceDB } from '../../vsm/governanceDb.js'

describe('CyberneticsGovernance.flushPredictions', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'flush-')) })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('writes completed predictions to governance.db under the canonical session id', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('sess-flush')
    // Directly seed a completed prediction via the live tracker.
    const tracker = gov.getPredictionTracker()
    tracker.completedPredictions.push({
      hypothesis: 'H2', triggerTurn: 3, triggerContext: 'nudge_injected',
      predictedOutcome: 'tool type changes', evaluationWindow: 1,
      correct: true, actualOutcome: 'before=[Read] after=Edit',
    })

    const db = new GovernanceDB(join(tmpDir, 'governance.db'))
    const n = gov.flushPredictions(db)
    expect(n).toBe(1)

    const rows = db.getPredictions('sess-flush')
    expect(rows).toHaveLength(1)
    expect(rows[0].hypothesis).toBe('H2')
    expect(rows[0].evaluation_turn).toBe(4) // triggerTurn + evaluationWindow
    db.close()
  })

  it('returns 0 when there are no completed predictions', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('sess-empty')
    const db = new GovernanceDB(join(tmpDir, 'governance.db'))
    expect(gov.flushPredictions(db)).toBe(0)
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vsm/cyberneticsGovernance.flush.test.ts`
Expected: FAIL — `gov.flushPredictions is not a function`.

- [ ] **Step 3: Add `flushPredictions` and fix the banned empty catch**

In `engine/vsm/cyberneticsGovernance.ts`, first fix the banned empty `catch {}` in `recordSessionOutcome` (line 1016):

```ts
      console.log(`[vsm] Session outcome persisted: ${outcome}`)
    } catch (e) {
      console.error(`[vsm] Session outcome persist failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
```

Then add `flushPredictions` after `getPredictionTracker()` (~line 1026):

```ts
  /**
   * Persist every in-memory completed prediction to governance.db under the
   * canonical session id. PredictionTracker evaluates H1-H7 live each turn but
   * never persists — this is the session-end bridge. Returns rows written.
   * Accepts the db explicitly so the caller (main.ts) reuses its open handle;
   * falls back to the governance-owned _db when omitted. H8 is out of scope
   * (never opened — see spec).
   */
  flushPredictions(db?: import('./governanceDb.js').GovernanceDB): number {
    const target = db ?? this._db
    if (!target) return 0
    let written = 0
    for (const p of this._predictionTracker.completedPredictions) {
      if (p.correct === undefined || p.actualOutcome === undefined) continue
      target.recordCompletedPrediction({
        sessionId: this._sessionId,
        hypothesis: p.hypothesis,
        triggerTurn: p.triggerTurn,
        triggerContext: p.triggerContext,
        predictedOutcome: p.predictedOutcome,
        actualOutcome: p.actualOutcome,
        correct: p.correct,
        evaluationTurn: p.triggerTurn + p.evaluationWindow,
      })
      written++
    }
    return written
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vsm/cyberneticsGovernance.flush.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no banned empty catch remains in the file**

Run: `grep -nE "catch\s*(\([^)]*\))?\s*\{\s*\}" engine/vsm/cyberneticsGovernance.ts || echo "CLEAN"`
Expected: `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/__tests__/vsm/cyberneticsGovernance.flush.test.ts
git commit -m "feat(vsm): flush completed predictions to governance.db at session end"
```

---

### Task 6: Wire flush + purge into main.ts session lifecycle

**Files:**
- Modify: `engine/main.ts:237-244` (startup purge), `:390-401` (cleanShutdown flush), `:946-966` (handoff flush)

No new unit test — this is wiring of already-tested methods; the Task 10 wire-check greps prove the calls are live, and the E2E dry-run exercises the path.

- [ ] **Step 1: Purge degenerate sessions once at startup**

In `engine/main.ts`, the startup block (line 237-244) opens the db for v2 threshold checks. Add a one-time purge right after `const db = new GovernanceDB(dbPath)`:

```ts
  const dbPath = path.join(os.homedir(), '.cynco', 'governance', 'governance.db')
  const db = new GovernanceDB(dbPath)
  const purged = db.purgeDegenerateSessions()
  if (purged > 0) console.log(`[govdb] purged ${purged} degenerate (zero-turn) session(s)`)
  const sessions = db.getRecentSessions(9999)
```

- [ ] **Step 2: Flush predictions on clean shutdown**

In `engine/main.ts` `cleanShutdown()` (line 393-401), after `recordSessionOutcome(...)`:

```ts
      loop.getGovernance().recordSessionOutcome(outcome, 'default', 0, loop.getFileTracker?.()?.getModifiedFiles?.()?.length ?? 0)
      const flushed = loop.getGovernance().flushPredictions?.()
      if (flushed) console.log(`[vsm] flushed ${flushed} completed prediction(s)`)
    }
  } catch (e) {
    console.error(`[shutdown] governance outcome/flush failed: ${e instanceof Error ? e.message : String(e)}`)
  }
```

(Note: this replaces the existing `} catch {}` on line 401 — that empty catch is banned; the replacement logs.)

- [ ] **Step 3: Flush predictions at the handoff session-end site**

In `engine/main.ts` (line 953), after the `recordSessionOutcome(...)` call in the handoff block:

```ts
          loop.getGovernance().recordSessionOutcome(outcome, 'default', 0, loop.getFileTracker?.()?.getModifiedFiles?.()?.length ?? 0)
          console.log(`[governance] Session outcome: ${outcome}`)
          const flushed = loop.getGovernance().flushPredictions?.()
          if (flushed) console.log(`[governance] flushed ${flushed} completed prediction(s)`)
```

- [ ] **Step 4: Verify the file still type-checks / tests still pass**

Run: `npx vitest run engine/__tests__/vsm/`
Expected: PASS (no regressions in vsm suite).

- [ ] **Step 5: Verify no banned empty catch remains in main.ts near the shutdown sites**

Run: `grep -nE "catch\s*(\([^)]*\))?\s*\{\s*\}" engine/main.ts || echo "CLEAN"`
Expected: `CLEAN` (the `} catch {}` at old line 401 is now a logging catch).

- [ ] **Step 6: Commit**

```bash
git add engine/main.ts
git commit -m "feat: purge degenerate sessions at startup and flush predictions at session end"
```

---

### Task 7: Outcome-joined reward-filter exporter

**Files:**
- Create: `engine/s5/exportTrainingData.ts`
- Test: `engine/__tests__/s5/exportTrainingData.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/s5/exportTrainingData.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { formatJournalInput, joinViableExamples, exportViableExamples } from '../../s5/exportTrainingData.js'
import type { JournalEntry } from '../../training/types.js'

function entry(sessionId: string): JournalEntry {
  return {
    timestamp: 1, sessionId, system: 'S5',
    input: { userMessage: 'fix the bug', activeWorkflow: null, contextUsagePercent: 0.5,
             turnCount: 4, recentToolResults: [{ tool: 'Read', success: true }],
             governanceStatus: 'healthy', varietyBalance: 'balanced', promptDifficulty: 'medium' },
    decision: { workflow: null, contextAction: 'none', priority: 'balanced', reasoning: 'ok' },
  }
}

describe('exportTrainingData', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'export-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('formatJournalInput renders a stable, non-empty prompt string', () => {
    const s = formatJournalInput(entry('s1').input)
    expect(s).toContain('User: fix the bug')
    expect(s).toContain('Context: 50%')
    expect(s.length).toBeGreaterThan(0)
  })

  it('joinViableExamples keeps only viable-session decisions and preserves the real decision as output', () => {
    const entries = [entry('viable-1'), entry('nonviable-1'), entry('missing-1')]
    const outcomes = new Map([['viable-1', 'viable'], ['nonviable-1', 'non-viable']])
    const examples = joinViableExamples(entries, outcomes)
    expect(examples).toHaveLength(1)
    expect(JSON.parse(examples[0].output).reasoning).toBe('ok')
  })

  it('exportViableExamples writes JSONL for viable sessions', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [entry('v'), entry('nv')].map(e => JSON.stringify(e)).join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
    expect(existsSync(out)).toBe(true)
    const line = JSON.parse(readFileSync(out, 'utf-8').trim())
    expect(line).toHaveProperty('input')
    expect(line).toHaveProperty('output')
  })

  it('exportViableExamples writes nothing and reports 0 when no viable sessions match', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, JSON.stringify(entry('nv')) + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['nv', 'non-viable']]) })
    expect(res.written).toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  it('exportViableExamples skips _backfill records and malformed lines', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(entry('v')),
      JSON.stringify({ _backfill: true, system: 'S5', entryTimestamp: 1, outcome: {} }),
      '{ this is not json',
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/s5/exportTrainingData.test.ts`
Expected: FAIL — module `../../s5/exportTrainingData.js` not found.

- [ ] **Step 3: Implement the exporter**

Create `engine/s5/exportTrainingData.ts`:

```ts
/**
 * Outcome-joined, reward-filtered S5 training exporter.
 *
 * Reads the S5 decision journal (~/.cynco/training/s5-decisions.jsonl), joins
 * each entry to its session outcome by sessionId (from governance.db), and
 * emits {input, output} JSONL for ONLY the decisions made in `viable` sessions
 * (rejection sampling on outcome). The output is the REAL logged S5 decision —
 * not a rule-derived one — so the model learns from good trajectories rather
 * than distilling the rule engine. Consumed by scripts/fine_tune_s5.py.
 */

import type { JournalEntry } from '../training/types.js'

export type TrainingExample = { input: string; output: string }

/** Render a journaled S5Input object into the model's readable "input view". */
export function formatJournalInput(input: Record<string, unknown>): string {
  const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)
  const toolResults = Array.isArray(input.recentToolResults)
    ? (input.recentToolResults as { tool?: string; success?: boolean }[])
        .map(t => `${t.tool ?? '?'}:${t.success ? 'ok' : 'fail'}`)
        .join(', ')
    : ''
  const lines = [
    `User: ${String(input.userMessage ?? '')}`,
    `Workflow: ${input.activeWorkflow ?? 'none'}`,
    `Phase: ${input.currentPhase ?? 'none'}`,
    `Context: ${Math.round(num(input.contextUsagePercent) * 100)}%`,
    `Turn: ${num(input.turnCount)}`,
    `Governance: ${String(input.governanceStatus ?? 'unknown')}`,
    `Variety: ${String(input.varietyBalance ?? 'balanced')}`,
    `Difficulty: ${String(input.promptDifficulty ?? 'unknown')}`,
    `Recent tools: ${toolResults || 'none'}`,
  ]
  return lines.join('\n')
}

/** Keep only decisions from viable sessions; output is the real logged decision. */
export function joinViableExamples(
  entries: JournalEntry[],
  outcomeBySession: Map<string, string>,
): TrainingExample[] {
  const out: TrainingExample[] = []
  for (const e of entries) {
    if (outcomeBySession.get(e.sessionId) !== 'viable') continue
    if (!e.input || !e.decision) continue
    out.push({ input: formatJournalInput(e.input), output: JSON.stringify(e.decision) })
  }
  return out
}

/** Build sessionId → outcome map from governance.db (bun:sqlite; kept off the test path). */
export function loadOutcomesFromDb(dbPath: string): Map<string, string> {
  const { GovernanceDB } = require('../vsm/governanceDb.js')
  const db = new GovernanceDB(dbPath)
  const map = new Map<string, string>()
  for (const s of db.getRecentSessions(1_000_000)) map.set(s.sessionId, s.outcome)
  db.close()
  return map
}

/** Read journal, join to outcomes, write viable-only JSONL. Empty → no file written. */
export function exportViableExamples(opts: {
  journalPath: string
  outPath: string
  outcomeBySession: Map<string, string>
}): { written: number } {
  const { readFileSync, writeFileSync, existsSync } = require('fs')
  if (!existsSync(opts.journalPath)) return { written: 0 }

  const raw = readFileSync(opts.journalPath, 'utf-8')
  const entries: JournalEntry[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec: any
    try {
      rec = JSON.parse(t)
    } catch {
      skipped++
      continue
    }
    if (rec && rec._backfill) continue
    if (rec && rec.sessionId && rec.input && rec.decision) entries.push(rec as JournalEntry)
  }
  if (skipped > 0) console.warn(`[export] skipped ${skipped} malformed journal line(s)`)

  const examples = joinViableExamples(entries, opts.outcomeBySession)
  if (examples.length === 0) return { written: 0 }
  writeFileSync(opts.outPath, examples.map(e => JSON.stringify(e)).join('\n') + '\n')
  return { written: examples.length }
}

// ─── CLI ────────────────────────────────────────────────────────────
if (import.meta.main) {
  const os = require('os')
  const path = require('path')
  const journalPath = process.argv[2] ?? path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl')
  const dbPath = process.argv[3] ?? path.join(os.homedir(), '.cynco', 'governance', 'governance.db')
  const outPath = process.argv[4] ?? path.join(os.homedir(), '.cynco', 'training', 's5_training_data.jsonl')
  const outcomeBySession = loadOutcomesFromDb(dbPath)
  const { written } = exportViableExamples({ journalPath, outPath, outcomeBySession })
  console.log(`[export] wrote ${written} viable-session example(s) to ${outPath}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/s5/exportTrainingData.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/s5/exportTrainingData.ts engine/__tests__/s5/exportTrainingData.test.ts
git commit -m "feat(s5): add outcome-joined reward-filter training exporter"
```

---

### Task 8: Repoint `--export-training`; delete rule-distillation exporters

**Files:**
- Modify: `engine/main.ts:121-132`
- Delete: `engine/s5/trainingData.ts`, `engine/__tests__/s5/trainingData.test.ts`, `scripts/aggregate_training_data.py`

- [ ] **Step 1: Repoint the CLI**

In `engine/main.ts`, replace the `--export-training` block (line 121-132):

```ts
// ─── Export S5 training data (outcome-joined, reward-filtered -> JSONL) ──
const exportTrainingIdx = process.argv.indexOf('--export-training')
if (exportTrainingIdx !== -1) {
  const os = await import('os')
  const path = await import('path')
  const outPath = process.argv[exportTrainingIdx + 1]
    ?? path.join(os.homedir(), '.cynco', 'training', 's5_training_data.jsonl')
  const journalPath = path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl')
  const dbPath = path.join(os.homedir(), '.cynco', 'governance', 'governance.db')
  const { loadOutcomesFromDb, exportViableExamples } = await import('./s5/exportTrainingData.js')
  const outcomeBySession = loadOutcomesFromDb(dbPath)
  const { written } = exportViableExamples({ journalPath, outPath, outcomeBySession })
  console.log(`[export-training] wrote ${written} viable-session example(s) to ${outPath}`)
  process.exit(0)
}
```

- [ ] **Step 2: Delete the superseded files**

```bash
git rm engine/s5/trainingData.ts engine/__tests__/s5/trainingData.test.ts scripts/aggregate_training_data.py
```

- [ ] **Step 3: Verify no references remain to the deleted symbols**

Run: `grep -rn "trainingData\.js\|s5/trainingData\|aggregate_training_data\|buildExamples\|toJsonl" engine scripts --include=*.ts --include=*.py | grep -v exportTrainingData || echo "NO STALE REFS"`
Expected: `NO STALE REFS`.

- [ ] **Step 4: Run the full engine suite to confirm nothing depended on the deleted module**

Run: `npx vitest run`
Expected: PASS (the deleted `trainingData.test.ts` is gone; no other suite imports the removed module).

- [ ] **Step 5: Commit**

```bash
git add engine/main.ts
git commit -m "refactor(s5): repoint --export-training to reward-filter exporter; delete rule-distillation path"
```

---

### Task 9: Point `fine_tune_s5.py` at ~/.cynco; add `--validate-only`

**Files:**
- Modify: `scripts/fine_tune_s5.py`

- [ ] **Step 1: Repoint the default data path**

In `scripts/fine_tune_s5.py`, change line 26:

```python
DEFAULT_TRAINING_DATA = Path.home() / ".cynco" / "training" / "s5_training_data.jsonl"
```

- [ ] **Step 2: Update the stale aggregate-script hint**

In `load_training_data()` (line 40-43), replace the hint that references the deleted aggregator:

```python
        print(
            "[hint] Generate it first: bun engine/main.ts --export-training",
            file=sys.stderr,
        )
```

- [ ] **Step 3: Add a `--validate-only` path**

In `main()`, add the argument (after the `--batch-size` arg, before `args = parser.parse_args()`):

```python
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Load and format the training data, print the example count, and exit (no unsloth import, no training).",
    )
    args = parser.parse_args()

    if args.validate_only:
        examples = load_training_data(args.training_data)
        chat = format_as_chat(examples)
        print(f"[validate] {len(chat)} example(s) ready for SFT from {args.training_data}")
        sys.exit(0)

    fine_tune(
```

(Remove the now-duplicated `args = parser.parse_args()` that previously sat right before `fine_tune(`.)

- [ ] **Step 4: Smoke-test `--validate-only` against a fixture (no GPU, no unsloth)**

```bash
TMP=$(mktemp -d)
printf '%s\n' '{"input":"User: hi\nContext: 50%","output":"{\"priority\":\"balanced\"}"}' > "$TMP/s5_training_data.jsonl"
python scripts/fine_tune_s5.py --validate-only --training-data "$TMP/s5_training_data.jsonl"
echo "exit=$?"
rm -rf "$TMP"
```

Expected: prints `[validate] 1 example(s) ready for SFT ...` and `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/fine_tune_s5.py
git commit -m "feat(train): point fine_tune_s5 at ~/.cynco data + add --validate-only"
```

---

### Task 10: End-to-end dry-run + BLOCKING wire check

**Files:** none created — verification only.

- [ ] **Step 1: End-to-end exporter → validator dry-run on a fixture**

This proves the exporter's output is directly loadable by the trainer (the whole point of the pipeline). Uses `bun` to drive the exporter's pure functions against a fixture journal + in-memory outcome map, then feeds the result to `--validate-only`.

```bash
TMP=$(mktemp -d)
cat > "$TMP/drive.ts" <<'EOF'
import { exportViableExamples } from './engine/s5/exportTrainingData.js'
import { writeFileSync } from 'fs'
import { join } from 'path'
const dir = process.argv[2]
const entry = (sid: string) => ({
  timestamp: 1, sessionId: sid, system: 'S5',
  input: { userMessage: 'add a feature', contextUsagePercent: 0.4, turnCount: 3,
           recentToolResults: [{ tool: 'Read', success: true }], governanceStatus: 'healthy' },
  decision: { workflow: null, contextAction: 'none', priority: 'balanced', reasoning: 'proceed' },
})
writeFileSync(join(dir, 's5-decisions.jsonl'),
  [entry('good'), entry('bad')].map(e => JSON.stringify(e)).join('\n') + '\n')
const res = exportViableExamples({
  journalPath: join(dir, 's5-decisions.jsonl'),
  outPath: join(dir, 's5_training_data.jsonl'),
  outcomeBySession: new Map([['good', 'viable'], ['bad', 'non-viable']]),
})
console.log(`[drive] wrote ${res.written}`)
EOF
bun "$TMP/drive.ts" "$TMP"
python scripts/fine_tune_s5.py --validate-only --training-data "$TMP/s5_training_data.jsonl"
echo "e2e-exit=$?"
rm -rf "$TMP"
```

Expected: `[drive] wrote 1`, then `[validate] 1 example(s) ready for SFT ...`, `e2e-exit=0`. (Confirms viable-only filtering AND trainer-loadable format.)

- [ ] **Step 2: BLOCKING wire check — grep every new symbol on a live path**

Run each; every command must print at least the expected call sites (not just the definition):

```bash
echo "== setSessionId (called in conversationLoop x2) ==" && grep -rn "setSessionId" engine/bridge/conversationLoop.ts
echo "== flushPredictions (called in main.ts x2) ==" && grep -rn "flushPredictions" engine/main.ts
echo "== purgeDegenerateSessions (called in main.ts startup) ==" && grep -rn "purgeDegenerateSessions" engine/main.ts
echo "== recordCompletedPrediction (called by flushPredictions) ==" && grep -rn "recordCompletedPrediction" engine/vsm/cyberneticsGovernance.ts
echo "== sessionId passed into S5 decision ==" && grep -rn "sessionId: this.sessionId" engine/bridge/conversationLoop.ts
echo "== orchestrator uses input.sessionId ==" && grep -rn "input.sessionId" engine/s5/orchestrator.ts
echo "== exporter imported by main --export-training ==" && grep -rn "exportViableExamples\|loadOutcomesFromDb" engine/main.ts
echo "== no stale distillation refs ==" && (grep -rn "s5/trainingData\|aggregate_training_data" engine scripts --include=*.ts --include=*.py || echo "NONE")
```

Expected:
- `setSessionId` → 2 call lines in conversationLoop (fresh + resume).
- `flushPredictions` → 2 call lines in main.ts (cleanShutdown + handoff).
- `purgeDegenerateSessions` → 1 call line in main.ts startup.
- `recordCompletedPrediction` → called inside `flushPredictions`.
- `sessionId: this.sessionId` → 1 line (the makeDecision call).
- `input.sessionId` → 1 line (orchestrator journal).
- exporter symbols → imported/called in main.ts.
- stale refs → `NONE`.

If any expected call site is missing, the feature is not wired — STOP and fix before proceeding.

- [ ] **Step 3: Full engine suite**

Run: `npx vitest run`
Expected: PASS, 0 failures.

- [ ] **Step 4: Guard/ratchet suite (banned empty catch, protocol, wiring)**

Run: `npx vitest run engine/__tests__/guards`
Expected: PASS — in particular the empty-`catch {}` ratchet (we removed two: cyberneticsGovernance ~1016 and main.ts ~401).

- [ ] **Step 5: TUI suite (no regressions)**

Run: `cd tui && python -m pytest tests/ -q`
Expected: PASS (unchanged; no Python engine-protocol surface touched).

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test(s5): e2e exporter→trainer dry-run + wire-check for outcome-grounded pipeline"
```

---

## Self-Review Notes

- **Spec coverage:** join-key unification (Tasks 1-2), legacy purge + write-guard (Task 3), prediction persistence bridge (Tasks 4-6), reward-filter exporter (Task 7), repoint + delete distillation (Task 8), trainer repoint + validate (Task 9), E2E + wire check (Task 10). All spec layers covered.
- **Type consistency:** `recordCompletedPrediction`'s params match `flushPredictions`'s call; `TrainingExample` `{input, output}` matches `fine_tune_s5.py`'s `load_training_data` (`"input"`/`"output"` required). `flushPredictions(db?)` optional-arg matches both the test (explicit db) and main.ts (falls back to `_db`).
- **Empty-catch ratchet:** two existing empty catches removed (cyberneticsGovernance:1016, main.ts:401); new catch in exporter increments `skipped` (non-empty). Step-level greps in Tasks 5/6 + guard suite in Task 10 enforce this.
- **bun:sqlite under vitest:** shimmed (`vitest.config.ts`); `loadOutcomesFromDb` uses lazy `require` so the exporter test never touches sqlite.
