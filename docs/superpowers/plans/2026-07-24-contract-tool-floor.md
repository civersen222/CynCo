# Contract Tool Floor and Enforcement Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for the engine to demand an action no available tool can perform, ensure contract enforcement always resolves rather than expiring into an unverified pass, bound single-turn output, and refuse repo-wide git staging.

**Architecture:** Two new pure predicate modules (`toolFloor.ts`, `commitScope.ts`) wired into `conversationLoop.ts` at existing chokepoints, plus a resolution method on `ContractState` and a one-line output cap in `callModel.ts`. The pure modules hold all logic and are unit-tested in isolation; the loop changes are thin wiring that follows patterns already present in the file.

**Tech Stack:** TypeScript, Bun, Vitest. Run tests with `bunx vitest run <path>` from `C:/Users/civer/localcode`.

**Spec:** `docs/superpowers/specs/2026-07-24-contract-tool-floor-design.md`

---

## Background for the implementer

You have not seen the incident that motivated this. Briefly: contract enforcement injects a hardcoded message telling the model *"Run the test suite NOW with Bash [...] Then use ContractAssertPass to mark completed assertions"* (`engine/bridge/conversationLoop.ts:2319-2322`). Meanwhile the active TDD workflow phase had restricted the tool set to `['Read','Glob','Grep','Write','Edit','SubAgent','CollectAgent']` — no `Bash`, no `ContractAssertPass`. The model was told five times to do something it could not do, the contract sat at "2 pending, 0 failed" for the entire run, and enforcement then silently expired and let the run report success. The run burned 115 iterations and a single 44,000-token turn.

Eight separate layers can narrow the offered tool set. Rather than patch the one workflow definition, we install a floor downstream of all of them.

**Important context on file size:** `conversationLoop.ts` is very large (~3000 lines). Do not restructure it. Every change below is a small, local insertion at a specified line, following a pattern that already exists nearby. Read the surrounding 30 lines before editing so your insertion matches local style.

---

## File Structure

**Create:**
- `engine/bridge/toolFloor.ts` — pure: decides which enforcement-required tools to restore, or reports the contract unsatisfiable
- `engine/__tests__/bridge/toolFloor.test.ts`
- `engine/bridge/commitScope.ts` — pure: detects repo-wide git staging
- `engine/__tests__/bridge/commitScope.test.ts`

**Modify:**
- `engine/engine/callModel.ts:~373` — set `max_tokens`
- `engine/tools/contract.ts` — add `resolveUnverified()` to `ContractState`
- `engine/__tests__/contract.test.ts` — cover the new method
- `engine/bridge/conversationLoop.ts` — four insertions: commit guard (~2779), tool floor (~1933), enforcement resolution + counter split (~2311-2327), outcome recording

---

## Task 1: Cap single-turn output

**Files:**
- Modify: `engine/engine/callModel.ts` (around line 368-374)

Context: one turn generated 44,000+ tokens and stopped only because llama-server truncated at its own 65535 ceiling. `LocalCodeConfig.maxOutputTokens` already exists (`engine/config.ts:77`, parsed at `:181-184` from `LOCALCODE_MAX_OUTPUT_TOKENS` or `profile.max_output_tokens`, default 16384, returned at `:222`), is settable from `/config` and the dashboard, and **both providers already forward it conditionally** (`engine/llama/provider.ts:304`, `engine/providers/openaiCompat.ts:116`). Nothing in the main request path reads it. This task un-orphans it.

- [ ] **Step 1: Read the request construction**

Read `engine/engine/callModel.ts` lines 340-390. Confirm the `CompletionRequest` literal and that a `config` object with `maxOutputTokens` is in scope. Current state:

```ts
const request: CompletionRequest = {
  model,
  messages: convertedMessages,
  system,
  temperature: effectiveTemperature,
  // No max_tokens — let the model generate as much as it needs
}
```

If `config` is NOT in scope under that name, find the config value's actual accessor before proceeding — do not invent one.

- [ ] **Step 2: Set the cap**

Replace the comment line with the field:

```ts
const request: CompletionRequest = {
  model,
  messages: convertedMessages,
  system,
  temperature: effectiveTemperature,
  // Bound a single turn. A runaway turn once reached 44k tokens and was ended
  // only by the server truncating at its context ceiling.
  max_tokens: config.maxOutputTokens,
}
```

- [ ] **Step 3: Verify it typechecks and the suite still passes**

Run: `bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: no new errors mentioning `callModel.ts`.

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -20`
Expected: same pass/fail counts as before your change. **Baseline note:** seven `workflowParity` tests fail already on master. Those seven are expected. Any *other* failure is yours.

- [ ] **Step 4: Commit**

```bash
git add engine/engine/callModel.ts
git commit -m "fix(callModel): cap single-turn output with config.maxOutputTokens"
```

---

## Task 2: Commit scope predicate

**Files:**
- Create: `engine/bridge/commitScope.ts`
- Test: `engine/__tests__/bridge/commitScope.test.ts`

Context: commits go through plain `Bash`. A `Git` tool exists (`engine/tools/impl/git.ts:64-80`) but `engine/engine/systemPromptText.ts:87` explicitly instructs the model to use Bash instead, and its safety layer only covers destructive operations, not staging breadth. `engine/tools/bashSafety.ts` contains no git patterns at all. So this predicate is the only check.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/bridge/commitScope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { checkCommitScope } from '../../bridge/commitScope.js'

const bash = (command: string) => ({ command })

describe('checkCommitScope', () => {
  it('refuses git add -A', () => {
    expect(checkCommitScope('Bash', bash('git add -A')).allowed).toBe(false)
  })

  it('refuses git add --all and git add -u', () => {
    expect(checkCommitScope('Bash', bash('git add --all')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git add -u')).allowed).toBe(false)
  })

  it('refuses git add .', () => {
    expect(checkCommitScope('Bash', bash('git add .')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git add . && git commit -m "x"')).allowed).toBe(false)
  })

  it('refuses git commit -a, -am, and --all', () => {
    expect(checkCommitScope('Bash', bash('git commit -a -m "x"')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git commit -am "x"')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git commit --all -m "x"')).allowed).toBe(false)
  })

  it('permits explicit pathspecs', () => {
    expect(checkCommitScope('Bash', bash('git add game.py test_wonder.py')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git add ./src/foo.ts')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git add src/a.ts && git commit -m "msg"')).allowed).toBe(true)
  })

  it('does not treat --amend or -m as staging-all', () => {
    expect(checkCommitScope('Bash', bash('git commit --amend --no-edit')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git commit -m "add all the things"')).allowed).toBe(true)
  })

  it('is not fooled by a quoted occurrence', () => {
    expect(checkCommitScope('Bash', bash('echo "git add -A" >> notes.txt')).allowed).toBe(true)
  })

  it('ignores non-git commands and non-Bash tools', () => {
    expect(checkCommitScope('Bash', bash('python -m pytest')).allowed).toBe(true)
    expect(checkCommitScope('Edit', bash('git add -A')).allowed).toBe(true)
  })

  it('explains what to do instead when it refuses', () => {
    const v = checkCommitScope('Bash', bash('git add -A'))
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/by name/i)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bunx vitest run engine/__tests__/bridge/commitScope.test.ts`
Expected: FAIL — cannot resolve `../../bridge/commitScope.js`.

- [ ] **Step 3: Write the implementation**

Create `engine/bridge/commitScope.ts`:

```ts
/**
 * Refuse repo-wide git staging.
 *
 * A commit is hard to reverse once it exists, so this is prevention rather than
 * an after-the-fact flag. Motivating incident: a run asked to make a nine-line
 * bugfix swept a 995-line unrelated plan document, an unrelated checklist, and
 * two scratch files whose entire contents were "# delete me" into its commit.
 *
 * Commits go through plain Bash — engine/systemPromptText.ts:87 routes the model
 * around the Git tool, and bashSafety.ts has no git patterns — so this predicate
 * is the only staging-breadth check in the system.
 */

export interface CommitScopeVerdict {
  allowed: boolean
  /** Guidance returned to the model when refused. */
  reason?: string
}

/** Blank out quoted spans so `echo "git add -A"` isn't read as staging. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/** `git add` with -A, --all, -u, or a bare `.` pathspec. */
const ADD_ALL = /\bgit\s+add\b[^\n]*?\s(?:-A\b|--all\b|-u\b|\.(?=\s|$|;|&|\)))/

/** `git commit` with a combined short flag containing `a` (-a, -am, -a -m). */
const COMMIT_SHORT_ALL = /\bgit\s+commit\b[^\n]*?\s-[A-Za-z]*a[A-Za-z]*\b/
/** `git commit --all`. Kept separate so `--amend` cannot match. */
const COMMIT_LONG_ALL = /\bgit\s+commit\b[^\n]*?\s--all\b/

const ADD_REASON =
  'Repo-wide staging (git add -A / . / -u) is not allowed — it sweeps in files ' +
  'you did not change. Stage the files you actually modified by name, e.g. ' +
  '`git add path/to/file.py path/to/test_file.py`.'

const COMMIT_REASON =
  '`git commit -a` stages every modified file, including ones unrelated to your ' +
  'change. Stage the files you modified by name with `git add <paths>` first, ' +
  'then run `git commit -m "..."`.'

/**
 * True-by-default: only an explicitly recognized repo-wide staging form is
 * refused. Anything unrecognized is allowed through.
 */
export function checkCommitScope(toolName: string, toolInput: unknown): CommitScopeVerdict {
  if (toolName !== 'Bash') return { allowed: true }
  const raw = (toolInput as { command?: unknown })?.command
  if (typeof raw !== 'string') return { allowed: true }

  const command = stripQuoted(raw)
  if (ADD_ALL.test(command)) return { allowed: false, reason: ADD_REASON }
  if (COMMIT_SHORT_ALL.test(command) || COMMIT_LONG_ALL.test(command)) {
    return { allowed: false, reason: COMMIT_REASON }
  }
  return { allowed: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run engine/__tests__/bridge/commitScope.test.ts`
Expected: PASS, 9/9.

If the `-am` case fails, check `COMMIT_SHORT_ALL`: the character class must allow letters on both sides of the `a`. Do not weaken a test to make it pass — fix the pattern.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/commitScope.ts engine/__tests__/bridge/commitScope.test.ts
git commit -m "feat(bridge): predicate refusing repo-wide git staging"
```

---

## Task 3: Wire the commit guard into the loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts` (insert just before line ~2779)

- [ ] **Step 1: Read the surrounding pattern**

Read `engine/bridge/conversationLoop.ts:2735-2800`. You will see two execution-time veto blocks (`allowedTools` pin at `:2738-2753`, offered-set check at `:2760-2777`) followed by the read-loop gate at `:2779-2784`. Your insertion goes **between** the offered-set block and the read-loop gate, and must follow the same shape: log, emit `tool.start` + `tool.complete` with `isError: true`, push a `tool_result` with `is_error: true`, push to the three tracking arrays, `return`.

- [ ] **Step 2: Add the import**

At the top of the file, alongside the other `./` bridge imports:

```ts
import { checkCommitScope } from './commitScope.js'
```

- [ ] **Step 3: Insert the guard**

Immediately before the `// ─── Read-loop gate ───` comment at ~line 2779:

```ts
    // ─── Commit scope guard ────────────────────────────────────────
    // Prevention, not a rescue: a commit is hard to reverse once made, and an
    // unattended run runs with approveAll so nothing else will stop it.
    const commitVerdict = checkCommitScope(toolName, toolInput)
    if (!commitVerdict.allowed) {
      console.log(`[commit-scope] BLOCKED ${toolName}: repo-wide staging`)
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'tool.complete', toolId, toolName, result: commitVerdict.reason!, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: commitVerdict.reason! }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return
    }
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: no new errors. If `toolResultsThisTurn` or `toolsUsedThisTurn` is not in scope at your insertion point, you inserted in the wrong function — compare against the block at `:2738-2753`.

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -20`
Expected: baseline (seven `workflowParity` failures, nothing new).

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat(bridge): block repo-wide git staging at tool execution time"
```

---

## Task 4: Contract resolution method

**Files:**
- Modify: `engine/tools/contract.ts` (add a method to `ContractState`, near `assertSkip` at `:77-81`)
- Test: `engine/__tests__/contract.test.ts` (extend)

Context: enforcement currently expires by falling through to a `console.log` and abandoning the contract with assertions still pending. That is how an unverified run reported success. The contract must instead *resolve*.

- [ ] **Step 1: Write the failing tests**

Append to `engine/__tests__/contract.test.ts`, inside the existing `describe` block (match the local style — the existing tests use a `c` fixture created in a `beforeEach`):

```ts
  it('resolveUnverified fails every pending assertion and returns their texts', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertPass(0)
    const forced = c.resolveUnverified()
    expect(forced).toEqual(['b', 'c'])
    expect(c.failedCount()).toBe(2)
    expect(c.pendingCount()).toBe(0)
  })

  it('resolveUnverified leaves passed and skipped assertions untouched', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertPass(0, 'verified')
    c.assertSkip(1, 'n/a')
    c.resolveUnverified()
    expect(c.failedCount()).toBe(1)
    expect(c.isComplete()).toBe(false)
  })

  it('resolveUnverified records why the assertion was failed', () => {
    c.create('T', '', ['a'])
    c.resolveUnverified()
    expect(c.getStatus()).toMatch(/never verified/i)
  })

  it('resolveUnverified on a fully passed contract changes nothing', () => {
    c.create('T', '', ['a'])
    c.assertPass(0)
    expect(c.resolveUnverified()).toEqual([])
    expect(c.isComplete()).toBe(true)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/contract.test.ts`
Expected: FAIL — `c.resolveUnverified is not a function`.

- [ ] **Step 3: Implement**

In `engine/tools/contract.ts`, add to `ContractState` immediately after `assertSkip` (`:77-81`):

```ts
  /**
   * Enforcement budget exhausted with work still unverified. Force every
   * pending assertion to failed so the contract RESOLVES rather than silently
   * expiring — an unverified run must never report success. Returns the texts
   * of the assertions that were forced, for reporting.
   */
  resolveUnverified(reason: string = 'enforcement budget exhausted — never verified'): string[] {
    const forced: string[] = []
    for (const a of this.assertions) {
      if (a.status === 'pending') {
        a.status = 'failed'
        a.evidence = reason
        forced.push(a.text)
      }
    }
    return forced
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `bunx vitest run engine/__tests__/contract.test.ts`
Expected: PASS, all tests including the four new ones.

`getStatus()` already prints each assertion's evidence, so the third test passes without changing it. If it does not, read `getStatus()` at `:107-130` and confirm — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add engine/tools/contract.ts engine/__tests__/contract.test.ts
git commit -m "feat(contract): resolveUnverified fails pending assertions instead of expiring"
```

---

## Task 5: Enforcement resolves and terminates; split the counters

**Files:**
- Modify: `engine/bridge/conversationLoop.ts:2308-2328`

Two coupled changes to the same block, so they land together.

**Change A — counter split.** `readLoopEvasion` (`:2313`, `i > 0 && i % 8 === 0`) shares `enforcementRounds` with genuine stop attempts. In the incident the budget was consumed by the periodic probe, so by the time the model actually tried to finish, enforcement had already expired. Only a real stop attempt should spend the budget, and the evasion probe needs its own small budget so it cannot nag forever.

**Change B — resolve instead of expire.** On exhaustion, resolve the contract as failed, report it, and **terminate the turn directly** rather than falling through to `:2330` and into the re-entry scatter (summary injection, steering follow-ups, workflow-gate auto-advance). In the incident, those re-entries kept a run alive for eight more rounds after the engine had already given up on it.

- [ ] **Step 1: Read the current block**

Read `engine/bridge/conversationLoop.ts:2305-2335`. Note that `return` is the established way to end the turn here — see the HALT path at `:1785-1788`, which returns after emitting `message.complete`.

- [ ] **Step 2: Declare the evasion counter**

Find the top of `runModelLoop` where per-turn locals are declared (near `summaryInjected`). Add:

```ts
    /** Evasion probes get their own small budget so they cannot consume the
     *  stop-attempt enforcement budget, and cannot nag indefinitely. */
    let evasionNudges = 0
```

- [ ] **Step 3: Replace the enforcement block**

Replace lines `:2311-2328` (from `const contractActive = ...` through the closing brace after the `Allowing completion` log) with:

```ts
      // Contract enforcement: don't let the model finish while the contract is
      // incomplete. Fires when the model stops without tool calls, or
      // periodically to catch read-loop evasion.
      const contractActive = globalContract.isActive() && !globalContract.isComplete() && globalContract.isEnforcementEnabled()
      const modelStopping = toolUseBlocks.length === 0 && stopReason === 'end_turn'
      const readLoopEvasion = contractActive && i > 0 && i % 8 === 0 && evasionNudges < 3
      if (contractActive && (modelStopping || readLoopEvasion)) {
        // Only a genuine stop attempt spends the enforcement budget. The
        // periodic evasion probe has its own, so it cannot exhaust enforcement
        // before the model has tried to finish even once.
        if (modelStopping) globalContract.enforcementRounds++
        else evasionNudges++

        if (globalContract.enforcementRounds <= 5) {
          const pending = globalContract.pendingCount()
          const failed = globalContract.failedCount()
          const runTests = 'Run the test suite NOW with Bash to verify your changes work. If tests fail, fix the errors.'
          this.addMessage({
            role: 'user',
            content: [{ type: 'text', text: `[System] You are NOT done. Contract has ${pending} assertions pending, ${failed} failed. ${runTests} Then use ContractAssertPass to mark completed assertions. Do NOT keep reading files — ACT.` }],
          })
          console.log(`[contract] Enforcement round ${globalContract.enforcementRounds}: ${pending} pending, ${failed} failed`)
          continue
        }

        // Budget exhausted. Resolve the contract as failed rather than allowing
        // an unverified completion, and end the turn here instead of drifting
        // through the other re-entry paths for several more rounds.
        const unverified = globalContract.resolveUnverified()
        console.log(`[contract] UNRESOLVED after ${globalContract.enforcementRounds} rounds — failing ${unverified.length} unverified assertion(s)`)
        this.emit({
          type: 'stream.token',
          text: `\n[System] Contract unresolved — ${unverified.length} assertion(s) were never verified:\n${unverified.map(t => `  - ${t}`).join('\n')}\n`,
        })
        this.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
        return
      }
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: no new errors. If `i` is not in scope, you are outside the iteration loop — re-read `:2305-2335`.

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -20`
Expected: baseline only.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "fix(bridge): enforcement resolves and terminates instead of expiring silently"
```

---

## Task 6: Tool floor predicate

**Files:**
- Create: `engine/bridge/toolFloor.ts`
- Test: `engine/__tests__/bridge/toolFloor.test.ts`

The core of the change. Read the Background section above before starting.

Key design point — **the operator pin is respected, not overridden.** If the caller-supplied `allowedTools` (from a one-shot task JSON, applied at `conversationLoop.ts:818-821`) omits a required tool, we do NOT restore it. The engine must not override a human's explicit allowlist, but it also must not pretend to verify — so it reports the contract unsatisfiable and enforcement gets disabled. Tools removed by any *automatic* layer are restored.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/bridge/toolFloor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyToolFloor, attributeRemoval, ENFORCEMENT_REQUIRED_TOOLS } from '../../bridge/toolFloor.js'

const t = (name: string) => ({ name })
const ALL = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ContractAssertPass', 'ContractAssertFail', 'ContractStatus'].map(t)

describe('applyToolFloor', () => {
  it('is a no-op when enforcement is not active', () => {
    const offered = [t('Read')]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: false })
    expect(v.kind).toBe('ok')
    expect(v.tools).toBe(offered)
  })

  it('is a no-op when every required tool is already offered', () => {
    const offered = [t('Read'), ...ENFORCEMENT_REQUIRED_TOOLS.map(t)]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    expect(v.kind).toBe('ok')
  })

  it('restores tools an automatic layer removed (the TDD workflow phase case)', () => {
    // The tdd write_test phase allows Read/Glob/Grep/Write/Edit/SubAgent/
    // CollectAgent; the last two aren't in this fixture's ALL, so five here.
    const offered = ['Read', 'Glob', 'Grep', 'Write', 'Edit'].map(t)
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    expect(v.kind).toBe('restored')
    if (v.kind !== 'restored') return
    expect(v.restored).toContain('Bash')
    expect(v.restored).toContain('ContractAssertPass')
    expect(v.tools.map(x => x.name)).toEqual(expect.arrayContaining(['Read', 'Bash', 'ContractAssertPass']))
  })

  it('does not duplicate a tool that was only partly missing', () => {
    const offered = [t('Bash'), t('Read')]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    if (v.kind !== 'restored') throw new Error('expected restored')
    const names = v.tools.map(x => x.name)
    expect(names.filter(n => n === 'Bash')).toHaveLength(1)
  })

  it('reports unsatisfiable rather than overriding an operator pin', () => {
    // The real S4_DET2 task JSON: no ContractAssertPass.
    const offered = ['Read', 'Write', 'Edit', 'Bash'].map(t)
    const v = applyToolFloor({
      offered,
      allTools: ALL,
      operatorPin: ['Read', 'Write', 'Edit', 'Bash'],
      enforcementActive: true,
    })
    expect(v.kind).toBe('unsatisfiable')
    if (v.kind !== 'unsatisfiable') return
    expect(v.missing).toContain('ContractAssertPass')
    expect(v.tools).toBe(offered) // untouched
  })

  it('still restores automatic removals when the operator pin permits them', () => {
    const pin = ['Read', 'Bash', 'ContractAssertPass', 'ContractAssertFail', 'ContractStatus']
    const offered = [t('Read')] // a workflow phase stripped the rest
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: pin, enforcementActive: true })
    expect(v.kind).toBe('restored')
  })

  it('ignores required tools that are not registered at all', () => {
    const skinny = [t('Read'), t('Bash')]
    const v = applyToolFloor({ offered: [t('Read')], allTools: skinny, operatorPin: null, enforcementActive: true })
    if (v.kind !== 'restored') throw new Error('expected restored')
    expect(v.restored).toEqual(['Bash'])
  })
})

describe('attributeRemoval', () => {
  it('names the workflow phase when its allowedTools excludes the tool', () => {
    expect(attributeRemoval('Bash', { phaseName: 'write_test', phaseAllowed: ['Read', 'Edit'], demoted: [] }))
      .toMatch(/write_test/)
  })

  it('names trust demotion when the phase permits the tool but trust dropped it', () => {
    expect(attributeRemoval('Bash', { phaseName: 'x', phaseAllowed: ['Bash'], demoted: ['Bash'] }))
      .toMatch(/trust/i)
  })

  it('falls back to a generic label', () => {
    expect(attributeRemoval('Bash', { phaseName: null, phaseAllowed: null, demoted: [] }))
      .toMatch(/gating/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run engine/__tests__/bridge/toolFloor.test.ts`
Expected: FAIL — cannot resolve `../../bridge/toolFloor.js`.

- [ ] **Step 3: Implement**

Create `engine/bridge/toolFloor.ts`:

```ts
/**
 * A floor under the offered tool set, for tools that active contract
 * enforcement will demand.
 *
 * Contract enforcement injects a message telling the model to run tests with
 * Bash and mark assertions with ContractAssertPass. Eight separate layers can
 * narrow the offered tool set (core/extended split, workflow phase allowedTools,
 * caller pin, S5 restriction, trust demotion, tool router, S5 live re-eval,
 * toolgate attenuation) and none of them knows enforcement is active.
 *
 * Real incident: the TDD workflow phase restricted the set to seven tools
 * including neither Bash nor ContractAssertPass. The model was told five times
 * to perform an action it had no tool for, the contract never advanced past
 * "2 pending", and enforcement then expired into an unverified pass.
 *
 * Applied downstream of every narrowing layer, this makes that contradiction
 * structurally impossible rather than fixed in one workflow definition.
 */

export interface ToolLike {
  name: string
}

/**
 * The tools the enforcement message (conversationLoop.ts:2319-2322) demands.
 * Keep in sync with that text: if the message changes what it asks for, this
 * list must change too.
 */
export const ENFORCEMENT_REQUIRED_TOOLS = [
  'Bash',
  'ContractAssertPass',
  'ContractAssertFail',
  'ContractStatus',
] as const

export type FloorVerdict<T extends ToolLike> =
  /** Nothing to do. */
  | { kind: 'ok'; tools: T[] }
  /** Required tools were removed by an automatic layer and have been restored. */
  | { kind: 'restored'; tools: T[]; restored: string[] }
  /** The operator's explicit pin omits required tools — enforcement cannot be satisfied. */
  | { kind: 'unsatisfiable'; tools: T[]; missing: string[] }

export function applyToolFloor<T extends ToolLike>(opts: {
  /** The final offered set, after every narrowing layer. */
  offered: T[]
  /** Every registered tool, in the same shape as `offered`. */
  allTools: T[]
  /** Caller-supplied allowedTools pin, or null when unpinned. */
  operatorPin: string[] | null
  enforcementActive: boolean
}): FloorVerdict<T> {
  const { offered, allTools, operatorPin, enforcementActive } = opts
  if (!enforcementActive) return { kind: 'ok', tools: offered }

  // Only require tools that actually exist in this build.
  const registered = new Set(allTools.map(t => t.name))
  const required = ENFORCEMENT_REQUIRED_TOOLS.filter(n => registered.has(n))

  // The operator's explicit allowlist wins over the floor. If it omits a
  // required tool the contract can never be satisfied — report that instead of
  // overriding a human's decision or nagging for an impossible action.
  if (operatorPin) {
    const pin = new Set(operatorPin)
    const missing = required.filter(n => !pin.has(n))
    if (missing.length > 0) return { kind: 'unsatisfiable', tools: offered, missing }
  }

  const have = new Set(offered.map(t => t.name))
  const restored = required.filter(n => !have.has(n))
  if (restored.length === 0) return { kind: 'ok', tools: offered }

  const byName = new Map(allTools.map(t => [t.name, t]))
  const additions = restored.map(n => byName.get(n)!).filter(Boolean)
  return { kind: 'restored', tools: [...offered, ...additions], restored }
}

/**
 * Best-effort label for WHY a tool went missing, used only in the log line.
 * Attribution never affects the decision.
 */
export function attributeRemoval(
  name: string,
  ctx: { phaseName?: string | null; phaseAllowed?: string[] | null; demoted?: string[] },
): string {
  if (ctx.phaseAllowed && !ctx.phaseAllowed.includes(name)) {
    return `workflow phase '${ctx.phaseName ?? 'unknown'}'`
  }
  if (ctx.demoted?.includes(name)) return 'trust demotion'
  return 'governance gating'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run engine/__tests__/bridge/toolFloor.test.ts`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add engine/bridge/toolFloor.ts engine/__tests__/bridge/toolFloor.test.ts
git commit -m "feat(bridge): tool floor for contract-enforcement-required tools"
```

---

## Task 7: Wire the tool floor into the loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts` (insert just before line ~1933)

- [ ] **Step 1: Read the insertion site**

Read `engine/bridge/conversationLoop.ts:1914-1945`. The last narrowing layer is `applyToolGate` at `:1921-1928`. Line `:1933` writes `this.offeredToolNames`, and `:1938` passes `iterationTools` to the model. Your insertion goes **after the toolgate block and before `:1933`** — that ordering matters, because `offeredToolNames` gates execution at `:2760` and must include the restored tools or they'd be blocked when called.

Confirm that `demoted` (declared `:1793`) is in scope at your insertion point. It is in the same block.

- [ ] **Step 2: Add the import**

```ts
import { applyToolFloor, attributeRemoval } from './toolFloor.js'
```

`ALL_TOOLS` and `globalContract` are already imported in this file — confirm before adding either.

- [ ] **Step 3: Declare the event buffer**

Add a field to the class alongside the other instance state (near `offeredToolNames`). Do this
before Step 4, which uses it:

```ts
  /** Loud record of every tool-floor rescue this run, for the outcome report. */
  floorEvents: string[] = []
```

- [ ] **Step 4: Insert the floor**

Immediately before `this.offeredToolNames = new Set(...)` at `:1933`:

```ts
      // ── Contract tool floor ─────────────────────────────────────────
      // Enforcement will demand Bash + ContractAssertPass. Any of the narrowing
      // layers above may have removed them without knowing that. Restore them,
      // or — if the operator's own pin omits them — stop pretending we can
      // verify and disable enforcement loudly.
      if (globalContract.isActive() && !globalContract.isComplete() && globalContract.isEnforcementEnabled()) {
        const allDefs = ALL_TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputJSONSchema: t.inputSchema,
        }))
        const verdict = applyToolFloor({
          offered: iterationTools as any[],
          allTools: allDefs,
          operatorPin: this.allowedTools ?? null,
          enforcementActive: true,
        })
        if (verdict.kind === 'restored') {
          const phaseAllowed = this.workflowEngine.isActive ? this.workflowEngine.getAllowedTools() : null
          const why = verdict.restored
            .map(n => `${n} (removed by ${attributeRemoval(n, {
              phaseName: this.workflowEngine.currentPhase?.name,
              phaseAllowed,
              demoted: [...demoted],
            })})`)
            .join(', ')
          console.log(`[tool-floor] Restored ${why} — required by active contract enforcement`)
          this.floorEvents.push(`restored ${verdict.restored.join(', ')}`)
          iterationTools = verdict.tools as any
        } else if (verdict.kind === 'unsatisfiable') {
          console.log(`[tool-floor] Contract enforcement DISABLED — allowedTools omits ${verdict.missing.join(', ')}; cannot verify completion`)
          this.floorEvents.push(`enforcement disabled: pin omits ${verdict.missing.join(', ')}`)
          globalContract.setEnforcementEnabled(false)
        }
      }
```

- [ ] **Step 5: Verify**

Run: `bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: no new errors.

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -20`
Expected: baseline only (seven `workflowParity` failures).

- [ ] **Step 6: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat(bridge): apply the contract tool floor after all narrowing layers"
```

---

## Task 8: Surface rescues in the one-shot outcome

**Files:**
- Modify: `engine/daemon/oneShot.ts`

The design requires that every rescue be visible, not just logged — a mission that needed three rescues must look different from one that ran clean.

- [ ] **Step 1: Read how the outcome is built**

Read `engine/daemon/oneShot.ts:106-200`, specifically `runGovernedLoop` and where the `TaskOutcome` object is constructed after the loop finishes. Identify the outcome object literal and the `TaskOutcome` type (likely in `engine/daemon/types.ts`).

- [ ] **Step 2: Add the field to the type**

In `engine/daemon/types.ts`, on the `TaskOutcome` interface:

```ts
  /** Engine self-corrections applied during the run (tool-floor rescues,
   *  enforcement disabled). Empty on a clean run. */
  rescues?: string[]
```

- [ ] **Step 3: Populate it**

Where the outcome is constructed in `oneShot.ts`, add:

```ts
    rescues: loop.floorEvents,
```

Use whatever the local variable for the loop instance is actually called — read the surrounding code rather than assuming `loop`.

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: no new errors.

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -20`
Expected: baseline only.

- [ ] **Step 5: Commit**

```bash
git add engine/daemon/oneShot.ts engine/daemon/types.ts
git commit -m "feat(daemon): report engine self-corrections in the task outcome"
```

---

## Final verification

- [ ] **Full engine suite**

Run: `bunx vitest run engine/__tests__ 2>&1 | tail -30`
Expected: all pass except the seven pre-existing `workflowParity` failures. If any of those seven now pass or a new one fails, investigate — do not assume.

- [ ] **Typecheck**

Run: `bunx tsc --noEmit -p . 2>&1 | head -30`
Expected: clean, or unchanged from the pre-existing baseline.

- [ ] **Behavioral check against the incident**

Start the engine in a scratch git repo and send `/tdd <a small task>`. Watch `.cynco-engine.log` for:

- `[tool-floor] Restored Bash, ContractAssertPass (removed by workflow phase 'write_test')` on the first iteration — this proves the contradiction existed and is now corrected.
- Bash actually being called during `write_test`, rather than the model writing a `subprocess.run(pytest)` script it cannot execute.
- No `Allowing completion after N enforcement rounds` line anywhere — that log no longer exists.
- If the model does stall, `[contract] UNRESOLVED after 6 rounds` and immediate termination, rather than drifting to round 14.

Report what you observe. A run that no longer reproduces the deadlock is the acceptance criterion.
