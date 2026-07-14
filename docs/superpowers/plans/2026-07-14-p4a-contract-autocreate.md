# P4.2 — Contract Auto-Creation (STATE doc Phase 4(a)) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DoD contract creation automatic on all three surfaces — workspace (roll over stale-complete contracts so taskError measures the *current* task), vibe (synthesize one assertion per locked D-XX decision at BUILD start), mission (the driver sends the check-cmd as a one-assertion contract on `user.message`) — so P4.1's taskError/errorTrend series is populated in every mode.

**Architecture:** Extract the existing intent-classified auto-create block out of `conversationLoop.handleUserMessage` into a pure, unit-testable module `engine/bridge/contractAutoCreate.ts` (functions take an injectable `ContractState`). Extend the `user.message` protocol with an optional `contract` field (harness-supplied contract, applied before auto-create). Vibe controller calls `globalContract.create()` with D-XX-derived assertions right before dispatching the BUILD mega-prompt (preempting the junk auto-contract it gets today from the mega-prompt text).

**Tech Stack:** TypeScript (Bun), vitest (`npx vitest run` from repo root — NEVER `bun test`), one gated integration test (CYNCO_INTEGRATION=1).

**Design decisions (locked):**
- **Stale-contract rollover:** a COMPLETE active contract is replaced on the next user message; an INCOMPLETE one is kept (live task / follow-up message). Without this, the first task's contract persists forever (`clear()` is never called in production) and taskError measures the wrong task.
- **Harness contracts keep default enforcement.** The 2026-06-12 weekly-digest incident was about miscalibrated *interactive auto-assertions* on pinned-tool runs (that skip stands); harness assertions are mission-authored and precise, and enforcement caps at 5 rounds (conversationLoop.ts:2098-2114) so risk is bounded.
- **Vibe contract replaces unconditionally at BUILD start** — BUILD start is a task boundary; a re-BUILD resets the taskError series, which reads as a fresh attempt in the ledger.
- **protocol.ts stays import-free** — the `contract` field type is inlined, not imported.
- **No S5/governance behavior change** — this only populates the measurement channel shipped in P4.1 (PR #45). No new authority.

**Baselines (main @ 32fa749):** un-gated `npx vitest run` = 1900 passed / 33 skipped; gated (CYNCO_INTEGRATION=1) = 9 passed. **Expected after this plan:** un-gated **1914 passed / 34 skipped** (+11 contractAutoCreate, +3 decisionContract; +1 skipped = the new gated loop test); gated conversationLoop file **20 passed** (+1 harness-contract loop test).

**File structure:**
- Create: `engine/bridge/contractAutoCreate.ts` — pure contract-origination logic (synthesizeMessageAssertions, maybeAutoCreateContract, applyHarnessContract)
- Create: `engine/__tests__/bridge/contractAutoCreate.test.ts` — 11 unit tests
- Create: `engine/__tests__/vibe/decisionContract.test.ts` — 3 unit tests
- Modify: `engine/bridge/conversationLoop.ts` — replace inline auto-create block (:542-589) with calls; `handleUserMessage` gains optional `opts.contract`
- Modify: `engine/bridge/protocol.ts` — `UserMessageCommand` gains optional `contract` field
- Modify: `engine/main.ts` — pass `command.contract` through (:428)
- Modify: `engine/vibe/controller.ts` — exported `synthesizeDecisionAssertions` + private `createContractFromDecisions()` called before BUILD dispatch (:571)
- Modify: `scripts/cynco-mission-driver.mjs` — send `contract` on `user.message` when check-cmd supplied
- Modify: `engine/__tests__/tools/conversationLoop.test.ts` — 1 gated integration test
- Modify: `docs/STATE-AND-VISION-2026-07-12.md` — Phase 4(a) shipped marker

---

### Task 1: contractAutoCreate module + unit tests + conversationLoop rewire

**Files:**
- Create: `engine/bridge/contractAutoCreate.ts`
- Create: `engine/__tests__/bridge/contractAutoCreate.test.ts`
- Modify: `engine/bridge/conversationLoop.ts:542-589`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/bridge/contractAutoCreate.test.ts`:

```typescript
// P4.2: contract origination — intent-classified auto-create (with stale-
// complete rollover, STATE doc Phase 4(a)) and harness-supplied contracts.
// Pure unit tests against an injected ContractState (no loop spin-up).
import { describe, expect, it } from 'vitest'
import { ContractState } from '../../tools/contract.js'
import {
  applyHarnessContract,
  maybeAutoCreateContract,
} from '../../bridge/contractAutoCreate.js'

describe('maybeAutoCreateContract (P4.2)', () => {
  it('edit message → file-modified assertion + commit assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('fix the parser in engine/parser.ts', c)).toBe(true)
    const snap = c.snapshot()
    expect(snap.active).toBe(true)
    expect(snap.assertions.map(a => a.text)).toEqual([
      'File engine/parser.ts was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('create-file message → file-exists assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('create a new file utils/helper.ts with helpers', c)).toBe(true)
    expect(c.snapshot().assertions[0].text).toBe('File utils/helper.ts exists after changes')
  })

  it('analysis message → answer assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('explain how the streaming translator works', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Analysis or answer was provided to the user',
      'Response directly addresses what the user asked',
    ])
  })

  it('run message → execution assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('run the full suite now please', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Command was executed',
      'Output or result was reported to the user',
    ])
  })

  it('general message → single default assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('hello there my good friend', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Task was completed — user request fully addressed',
    ])
  })

  it('short message (≤15 chars) → no contract', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('fix bug', c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('INCOMPLETE active contract is kept (live task / follow-up)', () => {
    const c = new ContractState()
    c.create('original task', 'brief', ['still pending'])
    expect(maybeAutoCreateContract('also update the readme documentation', c)).toBe(false)
    expect(c.snapshot().title).toBe('original task')
  })

  it('COMPLETE active contract is replaced (P4.2 rollover — taskError must measure the current task)', () => {
    const c = new ContractState()
    c.create('finished task', 'brief', ['done'])
    c.assertPass(0)
    expect(c.isComplete()).toBe(true)
    expect(maybeAutoCreateContract('explain how the streaming translator works', c)).toBe(true)
    expect(c.snapshot().title).toBe('explain how the streaming translator works')
    expect(c.snapshot().assertions.every(a => a.status === 'pending')).toBe(true)
  })
})

describe('applyHarnessContract (P4.2)', () => {
  it('valid spec → contract created verbatim', () => {
    const c = new ContractState()
    const ok = applyHarnessContract(
      { title: 'Mission: m1', brief: 'the brief', assertions: ['Verification command exits 0: exit 0'] },
      c,
    )
    expect(ok).toBe(true)
    const snap = c.snapshot()
    expect(snap.title).toBe('Mission: m1')
    expect(snap.brief).toBe('the brief')
    expect(snap.assertions.map(a => a.text)).toEqual(['Verification command exits 0: exit 0'])
  })

  it('empty assertions → rejected, no contract', () => {
    const c = new ContractState()
    expect(applyHarnessContract({ title: 't', assertions: [] }, c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('missing title or undefined spec → rejected', () => {
    const c = new ContractState()
    expect(applyHarnessContract({ title: '', assertions: ['a'] }, c)).toBe(false)
    expect(applyHarnessContract(undefined, c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run engine/__tests__/bridge/contractAutoCreate.test.ts`
Expected: FAIL — module `../../bridge/contractAutoCreate.js` does not exist.

- [ ] **Step 3: Create the module**

Create `engine/bridge/contractAutoCreate.ts`:

```typescript
// P4.2 (STATE doc Phase 4(a)): how contracts come into being at message time.
//
// maybeAutoCreateContract — intent-classified auto-contract from the user
// message (extracted verbatim from conversationLoop.handleUserMessage so it
// is unit-testable). A COMPLETE stale contract from a prior task is replaced
// — otherwise taskError (P4.1) measures the wrong task; an INCOMPLETE one is
// kept (live task / follow-up message).
//
// applyHarnessContract — harness-supplied contract (mission mode: the brief's
// check script IS the contract). Enforcement stays at its default: the
// 2026-06-12 weekly-digest incident was about miscalibrated interactive
// auto-assertions on pinned-tool runs, not harness-authored ones, and
// enforcement caps at 5 rounds.

import { ContractState, globalContract } from '../tools/contract.js'

export type HarnessContractSpec = {
  title: string
  brief?: string
  assertions: string[]
}

/** Intent-classified assertions for a user message (moved from conversationLoop). */
export function synthesizeMessageAssertions(text: string): string[] {
  const lowerText = text.toLowerCase()
  const assertions: string[] = []

  // Classify intent
  const isEditTask = /\b(edit|add|create|write|fix|change|modify|delete|remove|wire|implement|refactor|build|update|move|rename)\b/.test(lowerText)
  const isAnalysisTask = /\b(analyze|explain|describe|summarize|review|compare|investigate|trace|debug|diagnose|why|how does|what is|what are|tell me|show me|find|search|look at|check)\b/.test(lowerText)
  const isRunTask = /\b(run|test|execute|deploy|install|start|launch|build)\b/.test(lowerText)

  if (isEditTask) {
    // Extract file targets from the message
    const fileMatches = text.match(/[\w./\\-]+\.(py|ts|js|tsx|jsx|rs|go|java|c|cpp|h|html|css|json|yaml|yml|toml|md)\b/g)
    if (fileMatches) {
      for (const f of [...new Set(fileMatches)].slice(0, 3)) {
        if (/\b(create|write|new file)\b/i.test(text) && text.includes(f)) {
          assertions.push(`File ${f} exists after changes`)
        } else {
          assertions.push(`File ${f} was modified (git diff shows changes)`)
        }
      }
    }
    if (assertions.length === 0) {
      assertions.push('Code was modified to address the task')
    }
    assertions.push('Changes committed to git')
  } else if (isAnalysisTask) {
    assertions.push('Analysis or answer was provided to the user')
    assertions.push('Response directly addresses what the user asked')
  } else if (isRunTask) {
    assertions.push('Command was executed')
    assertions.push('Output or result was reported to the user')
  } else {
    // Default: treat as a general task
    assertions.push('Task was completed — user request fully addressed')
  }

  return assertions
}

/**
 * Auto-create a contract for this user message. Returns true when a contract
 * was created. Keeps an INCOMPLETE active contract; replaces a COMPLETE one.
 */
export function maybeAutoCreateContract(text: string, contract: ContractState = globalContract): boolean {
  if (contract.isActive() && !contract.isComplete()) return false
  if (text.length <= 15) return false
  contract.create(text.slice(0, 60), text.slice(0, 200), synthesizeMessageAssertions(text))
  return true
}

/** Apply a harness-supplied contract spec. Returns true when applied. */
export function applyHarnessContract(spec: HarnessContractSpec | undefined, contract: ContractState = globalContract): boolean {
  if (!spec || !spec.title || !Array.isArray(spec.assertions) || spec.assertions.length === 0) return false
  contract.create(spec.title, spec.brief ?? '', spec.assertions)
  return true
}
```

- [ ] **Step 4: Rewire conversationLoop**

In `engine/bridge/conversationLoop.ts`:

Add the import next to the existing `import { globalContract } from '../tools/contract.js'` (:56 — KEEP that import, it is used at :772 and :2098):

```typescript
import { applyHarnessContract, maybeAutoCreateContract, type HarnessContractSpec } from './contractAutoCreate.js'
```

Change the `handleUserMessage` signature (:518) from:

```typescript
  async handleUserMessage(text: string): Promise<void> {
```

to:

```typescript
  async handleUserMessage(text: string, opts?: { contract?: HarnessContractSpec }): Promise<void> {
```

Replace the ENTIRE auto-create block (:542-589 — from the comment `// Auto-create contract from EVERY user message` through `this.governance.setContractCreated()` and its closing `}`) with:

```typescript
    // P4.2: harness-supplied contract (mission mode — the brief's check script
    // IS the contract, STATE doc Phase 4(a)). Applied before auto-create.
    if (opts?.contract && applyHarnessContract(opts.contract)) {
      console.log(`[contract] Harness-supplied: "${opts.contract.title}" (${opts.contract.assertions.length} assertion(s))`)
      this.governance.setContractCreated()
    }
    // Auto-create contract from EVERY user message — the model must finish what
    // the user asked. A COMPLETE stale contract from a prior task is replaced
    // (P4.2 — otherwise taskError measures the wrong task); an INCOMPLETE one is
    // kept (live task / follow-up message). Skip in one-shot mission runs
    // (allowedTools pinned): the contract enforcer is calibrated for interactive
    // coding ("run the test suite NOW with Bash") and blocks a mission from
    // producing its final structured outcome (2026-06-12 weekly-digest incident).
    else if (!this.allowedTools && maybeAutoCreateContract(text)) {
      console.log(`[contract] Auto-created: ${globalContract.pendingCount()} assertions for "${text.slice(0, 50)}..."`)
      this.governance.setContractCreated()
    }
```

- [ ] **Step 5: Run to verify all pass**

Run: `npx vitest run engine/__tests__/bridge/contractAutoCreate.test.ts engine/__tests__/vsm/taskModel.test.ts engine/__tests__/vsm/taskErrorReport.test.ts`
Expected: 11 + 6 + 3 all pass.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print: p4a-contracts
git add engine/bridge/contractAutoCreate.ts engine/__tests__/bridge/contractAutoCreate.test.ts engine/bridge/conversationLoop.ts
git commit -m "feat: extract contract auto-create; stale-complete rollover + harness contract support (P4.2)"
```

---

### Task 2: Protocol field + main.ts pass-through + driver + gated loop test

**Files:**
- Modify: `engine/bridge/protocol.ts` (UserMessageCommand, :427-431)
- Modify: `engine/main.ts` (:428)
- Modify: `scripts/cynco-mission-driver.mjs` (ws.onopen, ~:50-53; header comment ~:8-9)
- Modify: `engine/__tests__/tools/conversationLoop.test.ts` (append 1 gated test)

- [ ] **Step 1: Protocol field**

In `engine/bridge/protocol.ts`, change `UserMessageCommand` (:427-431) to:

```typescript
export type UserMessageCommand = {
  type: 'user.message'
  text: string
  cwd?: string  // Optional: change working directory for this message
  /** P4.2: optional harness-supplied DoD contract (mission mode — the brief's
   *  check script is the contract). Applied before intent auto-create.
   *  Inlined type: this file stays import-free. */
  contract?: { title: string; brief?: string; assertions: string[] }
}
```

- [ ] **Step 2: main.ts pass-through**

In `engine/main.ts` (:428), change:

```typescript
      await loop.handleUserMessage(command.text)
```

to:

```typescript
      await loop.handleUserMessage(command.text, { contract: command.contract })
```

- [ ] **Step 3: Driver sends the check-cmd as a one-assertion contract**

In `scripts/cynco-mission-driver.mjs`, replace the `ws.onopen` handler (:50-53):

```javascript
ws.onopen = () => {
  console.log('[driver] connected, dispatching mission')
  ws.send(JSON.stringify({ type: 'user.message', text: task, cwd: CWD }))
}
```

with:

```javascript
ws.onopen = () => {
  console.log('[driver] connected, dispatching mission')
  // P4.2 (STATE doc Phase 4(a)): the check script IS the contract — the engine
  // creates a one-assertion DoD so taskError/errorTrend measure this mission.
  const contract = checkCmd
    ? { title: `Mission: ${marker}`, brief: task.slice(0, 200), assertions: [`Verification command exits 0: ${checkCmd}`] }
    : undefined
  ws.send(JSON.stringify({ type: 'user.message', text: task, cwd: CWD, ...(contract ? { contract } : {}) }))
}
```

Also amend the driver header comment: after the line `//   check-cmd:     shell command run in cwd AFTER the mission ends (Phase 2b);` and its continuation line, add one line:

```javascript
//                  Also sent as a one-assertion DoD contract with the mission
//                  dispatch (P4.2) so taskError/errorTrend measure the run.
```

- [ ] **Step 4: Gated integration test**

Append inside the `describe('ConversationLoop with tools', ...)` block of `engine/__tests__/tools/conversationLoop.test.ts` (after the last `it(...)`):

```typescript
  it.skipIf(SKIP)('applies a harness-supplied contract before auto-create (P4.2)', async () => {
    globalContract.clear()
    // Enough scripted responses to exhaust contract enforcement rounds (cap 5).
    const provider = mockProvider(Array.from({ length: 7 }, () => () => textResponse('done')))
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
    })
    await loop.handleUserMessage('carry out the mission described in the brief in full', {
      contract: { title: 'Mission: m1', assertions: ['Verification command exits 0: exit 0'] },
    })
    const snap = globalContract.snapshot()
    expect(snap.title).toBe('Mission: m1')
    expect(snap.assertions.length).toBe(1)
    globalContract.clear()
  })
```

Add the import at the top of the file (next to the other `../../` imports): `import { globalContract } from '../../tools/contract.js'`

If the enforcement loop needs a different mock-response count, pattern-match the weekly-digest tests in the same file (:324-445) and adjust — report the deviation.

- [ ] **Step 5: Run gated + un-gated**

```bash
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/tools/conversationLoop.test.ts
npx vitest run engine/__tests__/bridge/protocol.test.ts engine/__tests__/harness/cyncoLedger.test.ts
```

Expected: gated file all pass including the new test; protocol + ledger suites unchanged/green.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print: p4a-contracts
git add engine/bridge/protocol.ts engine/main.ts scripts/cynco-mission-driver.mjs engine/__tests__/tools/conversationLoop.test.ts
git commit -m "feat: user.message carries optional harness contract; mission driver sends check-cmd as DoD (P4.2)"
```

---

### Task 3: Vibe D-XX → contract synthesis

**Files:**
- Modify: `engine/vibe/controller.ts` (import; exported helper; private method; call at :571)
- Create: `engine/__tests__/vibe/decisionContract.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/vibe/decisionContract.test.ts`:

```typescript
// P4.2: vibe BUILD synthesizes the DoD contract from locked D-XX decisions
// (STATE doc Phase 4(a)) — same numbering scheme as writePlanFile.
import { describe, expect, it } from 'vitest'
import { synthesizeDecisionAssertions } from '../../vibe/controller.js'

describe('synthesizeDecisionAssertions (P4.2)', () => {
  it('one assertion per answered decision, D-XX numbered in order', () => {
    const out = synthesizeDecisionAssertions([
      { question: 'Support dark mode?', answer: 'Yes, via CSS vars' },
      { question: 'Persist settings?', answer: 'localStorage' },
    ])
    expect(out).toEqual([
      'D-01 implemented as decided: Support dark mode? → Yes, via CSS vars',
      'D-02 implemented as decided: Persist settings? → localStorage',
    ])
  })

  it('skips unanswered decisions and keeps numbering sequential', () => {
    const out = synthesizeDecisionAssertions([
      { question: 'Q1?', answer: '' },
      { question: 'Q2?', answer: 'A2' },
    ])
    expect(out).toEqual(['D-01 implemented as decided: Q2? → A2'])
  })

  it('no answered decisions → empty (auto-create then covers the build prompt)', () => {
    expect(synthesizeDecisionAssertions([])).toEqual([])
    expect(synthesizeDecisionAssertions([{ question: 'Q?', answer: '' }])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run engine/__tests__/vibe/decisionContract.test.ts`
Expected: FAIL — `synthesizeDecisionAssertions` is not exported.

- [ ] **Step 3: Implement**

In `engine/vibe/controller.ts`:

Add the import at the top (next to other engine imports):

```typescript
import { globalContract } from '../tools/contract.js'
```

Add the exported helper at module level (below the imports, above the class — or after the class; match file style):

```typescript
/** P4.2: one assertion per answered D-XX decision (same numbering as writePlanFile). */
export function synthesizeDecisionAssertions(answers: { question: string; answer: string }[]): string[] {
  const out: string[] = []
  let dIdx = 1
  for (const qa of answers) {
    if (qa.answer) {
      const dId = `D-${String(dIdx).padStart(2, '0')}`
      out.push(`${dId} implemented as decided: ${qa.question} → ${qa.answer}`)
      dIdx++
    }
  }
  return out
}
```

Add the private method inside the class (near `writePlanFile`, ~:378):

```typescript
  /** P4.2: synthesize the DoD contract from locked D-XX decisions so taskError
   *  measures decision satisfaction during BUILD (STATE doc Phase 4(a)).
   *  Replaces any prior contract — BUILD start is a task boundary; a re-BUILD
   *  resets the series (reads as a fresh attempt in the ledger). No-op when no
   *  decisions are locked (the loop's auto-create then covers the build prompt). */
  private createContractFromDecisions(): void {
    const assertions = synthesizeDecisionAssertions(this.answers)
    if (assertions.length === 0) return
    globalContract.create(
      `Vibe build: ${this.userDescription.slice(0, 50)}`,
      this.userDescription.slice(0, 200),
      assertions,
    )
    console.log(`[vibe] Contract synthesized from ${assertions.length} D-XX decisions`)
  }
```

At the BUILD dispatch (:569-571), change:

```typescript
    const buildPrompt = buildPromptOverride ?? await this.buildTaskPrompt()

    await this.loop.handleUserMessage(buildPrompt)
```

to:

```typescript
    const buildPrompt = buildPromptOverride ?? await this.buildTaskPrompt()

    // P4.2: D-XX contract BEFORE dispatch — preempts the junk auto-contract
    // the loop would otherwise synthesize from the mega-prompt text.
    this.createContractFromDecisions()
    await this.loop.handleUserMessage(buildPrompt)
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run engine/__tests__/vibe/`
Expected: decisionContract 3 pass + all pre-existing vibe suites green.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: p4a-contracts
git add engine/vibe/controller.ts engine/__tests__/vibe/decisionContract.test.ts
git commit -m "feat: vibe BUILD synthesizes DoD contract from locked D-XX decisions (P4.2)"
```

---

### Task 4: STATE doc amendment

**Files:**
- Modify: `docs/STATE-AND-VISION-2026-07-12.md` (Phase 4 paragraph, :299)

- [ ] **Step 1: Amend Phase 4(a)**

In the Phase 4 paragraph (:299), find the sentence beginning `**(a)** Make contract creation automatic` and insert immediately before `**(a)**`:

```
**(a ✅ shipped 2026-07-14: workspace auto-create now rolls over completed contracts (stale-contract fix, `bridge/contractAutoCreate.ts`); vibe BUILD synthesizes one assertion per D-XX; mission driver sends its check-cmd as a one-assertion contract via `user.message.contract`)**
```

(Match on the `**(a)** Make contract creation automatic` anchor; do not otherwise alter the paragraph.)

- [ ] **Step 2: Commit**

```bash
git branch --show-current   # must print: p4a-contracts
git add docs/STATE-AND-VISION-2026-07-12.md
git commit -m "docs: Phase 4(a) shipped — contract auto-creation on all three surfaces"
```

---

### Task 5: BLOCKING wire check + ship

- [ ] **Step 1: Greps — every new symbol imported AND called**

```bash
grep -n "maybeAutoCreateContract\|applyHarnessContract\|synthesizeMessageAssertions\|HarnessContractSpec" engine/bridge/contractAutoCreate.ts engine/bridge/conversationLoop.ts
grep -n "opts?.contract\|opts\.contract\|command.contract" engine/bridge/conversationLoop.ts engine/main.ts
grep -n "contract" scripts/cynco-mission-driver.mjs
grep -n "synthesizeDecisionAssertions\|createContractFromDecisions" engine/vibe/controller.ts
```

Expected: contractAutoCreate functions defined AND imported+called in conversationLoop; `command.contract` passed in main.ts; driver builds+sends `contract`; vibe helper exported, private method defined AND called before the BUILD `handleUserMessage`. Any gap = fix before shipping.

- [ ] **Step 2: Full suites green at expected counts (repo root)**

```bash
npx vitest run > /tmp/wire-p4a.log 2>&1; tail -6 /tmp/wire-p4a.log
CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/tools/conversationLoop.test.ts 2>&1 | tail -4
```

Expected: un-gated **1914 passed / 34 skipped**; gated conversationLoop file green including the new P4.2 test. TUI untouched (optional protocol field, TUI never sends it) — no TUI run needed.

- [ ] **Step 3: Commit the plan file, then ship (git-web-flow)**

```bash
git branch --show-current   # must print: p4a-contracts
git add -f docs/superpowers/plans/2026-07-14-p4a-contract-autocreate.md
git commit -m "docs: P4.2 contract auto-creation implementation plan"
git push -u origin p4a-contracts
gh pr create --title "P4.2: contract auto-creation on all three surfaces (Phase 4(a))" --body "<summary + verification>"
# merge on GitHub, then:
git checkout main && git pull
```
