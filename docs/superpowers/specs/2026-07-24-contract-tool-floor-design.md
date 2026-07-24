# Contract Tool Floor and Enforcement Resolution — Design

**Date:** 2026-07-24
**Status:** Approved, ready for planning

## Problem

A CivKings dogfood run (`/tdd` workflow, Qwen3.6-27B via llama-server) burned 115 iterations
and ~44,000 tokens of a single runaway turn, committed unrelated files, and exited without
ever verifying its own work. The engine log tells the whole story:

```
line    78: [contract] Auto-created: 2 assertions
line  2338: Enforcement round 1: 2 pending, 0 failed
line  3951: Enforcement round 2: 2 pending, 0 failed
line  4931: Enforcement round 3: 2 pending, 0 failed
line  6341: Enforcement round 4: 2 pending, 0 failed
line  7364: Enforcement round 5: 2 pending, 0 failed
line  8732: Allowing completion after 6 enforcement rounds
        ... rounds 7, 8, 9, 10, 11, 12, 13 ...
line 20468: Allowing completion after 14 enforcement rounds   <- run exits
```

`2 pending, 0 failed` from the first round to the last. Not one assertion was ever marked.

### Root cause: the engine demanded an action the tool layer forbade

Contract enforcement injects a hardcoded instruction (`conversationLoop.ts:2319-2322`):

> Run the test suite NOW with Bash to verify your changes work. [...] Then use
> ContractAssertPass to mark completed assertions.

The active TDD workflow phase restricted the toolset to
`['Read','Glob','Grep','Write','Edit','SubAgent','CollectAgent']`
(`workflows/definitions/tdd.ts:12` and `:26`) — containing neither `Bash` nor
`ContractAssertPass`.

Both tools are registered and `core: true` (`tools/contract.ts:242`, `tools/impl/bash.ts:19`,
`tools/registry.ts:40`). They were dropped **solely** by the workflow filter at
`conversationLoop.ts:811-816`, which reassigns from `ALL_TOOLS` rather than intersecting,
making it an absolute whitelist with no protected-tool floor:

```ts
if (this.workflowEngine.isActive) {
  const allowed = this.workflowEngine.getAllowedTools()
  if (allowed) {
    activeTools = ALL_TOOLS.filter(t => allowed.includes(t.name))
  }
}
```

So the model was told five times to perform an action it structurally could not perform.
Two subsystems, each correct in isolation, jointly describing an impossible act.

### Secondary causes

1. **Enforcement expires into an unverified pass.** `conversationLoop.ts:2316` nudges for
   rounds 1-5; round 6+ falls through to a `console.log` at `:2327` and abandons the contract.
   No event, no failure, no outcome record. This is the same mechanism that produced the
   S4_DET2 false success report, where the outcome JSON claimed a passing suite that was
   never run.

2. **The nudge budget is consumed by the wrong event.** `readLoopEvasion` at `:2313`
   (`i > 0 && i % 8 === 0`) shares the `enforcementRounds` counter with genuine stop attempts.
   During the read loop the budget was spent by the periodic probe, so by the time the model
   actually tried to finish, enforcement had already expired.

3. **The run ended by coincidence.** After round 6 the engine had abdicated, but the loop was
   re-entered eight more times by unrelated subsystems (summary injection, steering follow-ups,
   workflow gate auto-advance). It exited at round 14 only when those all went quiet in the
   same iteration. Everything after line 8732 — roughly 12,000 log lines, iterations 30-115,
   and the entire runaway generation — occurred after the engine's own completion authority
   had already decided to stop caring.

4. **No output cap.** `engine/callModel.ts:368-374` sets no `max_tokens`, with the comment
   "let the model generate as much as it needs". One turn reached 44,000+ tokens and was
   ended only by llama-server truncating at its own 65535 context ceiling.

5. **No commit scope guard.** The run's commit swept in a 995-line unrelated plan document,
   `COMPLETION_PLAN.md`, and two junk files it had created whose entire contents were
   `# delete me`.

## Goals

- Make "the engine demands an action no available tool can perform" structurally impossible,
  for every gating layer, present and future — not just for `tdd.ts`.
- Ensure contract enforcement always *resolves* (pass or fail) and never expires into an
  unverified pass.
- Terminate promptly once completion authority is settled, rather than drifting to a
  coincidental stop.
- Bound single-turn generation.
- Prevent overly broad commits before they happen.

## Non-goals

- Refactoring the full termination scatter into a single arbiter. The remaining re-entry
  sources (summary injection, steering follow-ups, workflow gate) keep their current shape.
  This is a reasonable follow-up if the narrow fix proves insufficient.
- Adding a `ContractAssertSkip` tool. `ContractState.assertSkip()` exists
  (`tools/contract.ts:77-81`) and `isComplete()` honors skipped assertions (`:94`), but no
  tool can call it, so the model cannot dismiss an inapplicable assertion. This is a
  capability gap, not a contradiction; deliberately out of scope.
- Changing the TDD workflow's phase structure or its `allowedTools` lists. The floor makes
  the current definition safe without editing it.

## Design posture

Self-correct, but **loudly**. Every rescue emits a distinct, greppable warning and lands in
the outcome JSON as a flagged event, so a mission that needed three rescues is visibly
different from one that ran clean. Silent correction would have hidden this very
contradiction — the run would have looked like it worked.

The commit guard is the exception: it is **prevention**, not an announced rescue. A commit is
hard to reverse once it exists, so the guard belongs before the action.

## Components

### 1. Tool floor — `engine/bridge/toolFloor.ts` (new)

A pure module. Given the offered tool list, the set of tools required by active enforcement,
and the origin of each removal, it returns the corrected list plus a record of what was
restored.

**Insertion point: `conversationLoop.ts:1933`**, where `iterationTools` is finalized and
`this.offeredToolNames` is written, immediately before the array is handed to the provider at
`:1938`. This sits downstream of all eight narrowing layers:

| Layer | Location | Kind |
|---|---|---|
| Core/extended split | `conversationLoop.ts:808-810` | whitelist |
| Workflow phase `allowedTools` | `conversationLoop.ts:811-816` | whitelist, reassigns from `ALL_TOOLS` |
| Caller-pinned `allowedTools` | `conversationLoop.ts:818-821` | intersection |
| S5 turn restriction | `conversationLoop.ts:1060-1071` | whitelist |
| Trust demotion | `conversationLoop.ts:1791-1799` | subtraction, no floor |
| Two-stage tool router | `conversationLoop.ts:1801-1832` | replacement |
| S5 live re-eval | `conversationLoop.ts:1898-1907` | whitelist |
| `applyToolGate` | `conversationLoop.ts:1914-1928` | subtraction |

A single insertion covers all of them. Patching `tdd.ts` would cover one.

**Origin tracking is a prerequisite.** Today the layers simply filter; none records what it
removed or why, so at `:1933` the loop knows only the final list. The implementation must add
a lightweight removal ledger — each layer that narrows the set records
`(toolName, layerLabel)` — so the floor can apply the origin split below and name the culprit
in its warning. The ledger is per-iteration and discarded after use. Keep it additive: the
layers' existing filtering logic should not change, only report.

**Required set.** When a contract is active with enforcement enabled:
`[Bash, ContractAssertPass, ContractAssertFail, ContractStatus]`.

**Origin split.** The correction depends on *who* removed the tool:

- **Removed by an automatic layer** (workflow phase, trust demotion, toolgate, S5, router):
  restore it, and log loudly.

  ```
  [tool-floor] Restored Bash, ContractAssertPass — required by active contract
               enforcement, removed by workflow phase 'write_test'
  ```

- **Absent from the caller-pinned `allowedTools`** (`:818-821`, supplied by the operator in
  the task JSON): do **not** restore. Instead disable contract enforcement for the run and
  log loudly.

  ```
  [tool-floor] Contract enforcement DISABLED — task allowedTools omits
               ContractAssertPass; cannot verify completion
  ```

  Rationale: the engine must not demand what the operator explicitly forbade, but it equally
  must not pretend to verify. S4_DET2's task JSON specified
  `["Read","Write","Edit","Bash"]` — no `ContractAssertPass` — so under this rule it would
  have reported an unverifiable brief instead of nagging five times and then claiming false
  success. That correctly categorizes the failure as a spec defect rather than an engine one.

Both outcomes emit an event that reaches the outcome JSON.

### 2. Enforcement resolution — `conversationLoop.ts:2316-2327`, `tools/contract.ts`

Rounds 1-5 keep their current nudge behavior. On budget exhaustion, replace the
`console.log` + fall-through with:

1. Mark every still-pending assertion **failed**, with evidence
   `"enforcement budget exhausted — never verified"`.
2. Emit a `contract.unresolved` event carrying the named pending assertions.
3. **Terminate the turn directly**, rather than falling through to `:2330` and into the
   re-entry scatter.

Step 3 is the single piece borrowed from the rejected "termination arbiter" approach. It
collapses rounds 6-14 into one and is what delivers "stop sooner". A new resolution method on
`ContractState` owns steps 1-2 so the loop change stays small.

Consequence: `isComplete()` returns false with failed assertions present, so `oneShot` writes
`ok:false`. An unverified run stops reporting success.

### 3. Counter split — `conversationLoop.ts:2313`

`readLoopEvasion` gets its own counter, independent of `enforcementRounds`. Only a genuine
`modelStopping` (no tool-use blocks and `stopReason === 'end_turn'`) consumes the stop-attempt
budget. The periodic evasion probe can no longer exhaust enforcement before the model has
tried to finish even once.

### 4. Output cap — `engine/callModel.ts:373`

Replace the `// No max_tokens` comment with `max_tokens: config.maxOutputTokens`.

No plumbing is required. `LocalCodeConfig.maxOutputTokens` already exists (`config.ts:77`),
is parsed from `LOCALCODE_MAX_OUTPUT_TOKENS` or `profile.max_output_tokens` with a default of
16384 (`config.ts:181-184`, returned at `:222`), is settable via `/config`
(`bridge/configHandlers.ts:35-41`) and the dashboard (`dashboard/server.ts:469-470`), and both
providers already forward it conditionally (`llama/provider.ts:304`,
`providers/openaiCompat.ts:116`). It is currently read by nothing in the main request path.
This change un-orphans existing configuration.

### 5. Commit scope guard — `engine/bridge/commitScope.ts` (new)

Commits go through plain `Bash`. A `Git` tool exists (`tools/impl/git.ts:64-80`) but
`engine/systemPromptText.ts:87` explicitly instructs the model to use Bash instead, and
`tools/bashSafety.ts` contains no git patterns. Under `oneShot.ts:131` the loop runs with
`approveAll: true`, so the `Git` tool's `tier: 'approval'` gate would be bypassed anyway.

A pure predicate inspects Bash commands and refuses repo-wide staging:

- `git add -A`, `git add --all`, `git add .`, `git add -u` with no pathspec
- `git commit -a` / `git commit --all`

The refusal returns feedback instructing the model to name the files it changed explicitly.

**Placement: `conversationLoop.ts:~2779`**, alongside the existing
`this.readLoopGate.evaluate(toolName, toolInput)` call at `:2782`. That is the established
pattern for a semantic execution-time veto that returns guidance to the model, and it sits
after the `allowedTools` execution checks at `:2738-2777`.

## Testing

Each new module is a pure predicate with unit tests, following the shape already established
and accepted for `engine/bridge/benignToolResult.ts`.

- **`toolFloor.test.ts`** — restores tools stripped by an automatic layer; does not restore
  tools absent from an operator pin, and signals enforcement-disable instead; no-op when the
  contract is inactive or enforcement already disabled; no-op when nothing was removed;
  correctly attributes the removing layer in its report.
- **`commitScope.test.ts`** — refuses each repo-wide staging form; permits explicit pathspecs
  including paths containing `.`; ignores non-git commands; is not fooled by a `git add -A`
  appearing inside a quoted string.
- **`contract.test.ts`** (extend) — resolution marks pending assertions failed with evidence;
  `isComplete()` stays false afterward; already-passed assertions are untouched.
- **`callModel`** — the built `CompletionRequest` carries `max_tokens` from config.
- **Regression:** full engine suite. The seven pre-existing `workflowParity` failures are the
  known baseline and are expected to remain.

## Verification against the incident

Replaying the failed run against this design:

- The tool floor restores `Bash` and `ContractAssertPass` at iteration 1, so the model can
  actually run tests and mark assertions. The `[tool-floor]` warning records that `tdd.ts`
  withheld them, which is the evidence that this class of bug exists.
- If enforcement still cannot be satisfied, it resolves as failed at round 6 instead of round
  14 — cutting roughly 12,000 log lines, 85 iterations, and the runaway turn.
- The runaway turn is capped at 16384 tokens rather than 44,000+.
- The commit is refused until the model names its files, so the 995-line plan document and the
  two `# delete me` files stay out.
- The outcome JSON reports `ok:false` with named unverified assertions, instead of silence.
