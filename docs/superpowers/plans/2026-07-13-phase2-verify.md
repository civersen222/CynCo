# Phase 2(b) Automated Mission Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mission driver runs a brief-supplied check command post-mission and writes `verified: true|false` (plus a `verify` detail object) into the ledger record automatically — no human labeling on the happy path (STATE doc Phase 2(b)).

**Architecture:** New tiny module `scripts/cynco-verify.mjs` exports `runCheck(command, cwd, timeoutMs)` (spawnSync + shell, cross-runtime: works under Bun and under vitest/node). `scripts/cynco-ledger.mjs#buildMissionRecord` gains `verified`/`verify` passthrough from `meta` (additive; schema stays 1; default stays `null`). `scripts/cynco-mission-driver.mjs` gains an optional 5th CLI arg `check-cmd`: after the outcome is determined it runs the command in the mission cwd and feeds the result into the record. A 1-in-5 spot-audit reminder prints based on the ledger line count.

**Tech Stack:** Plain .mjs (node:child_process), vitest for tests (NEVER `bun test`; run from repo root).

**Branch:** `phase2-verify` (already created from main @ faabcb2).

---

## Design facts (verified against source — do not re-derive)

- Driver: `scripts/cynco-mission-driver.mjs` (123 lines). CLI parse at :24 `const [taskFile, marker, cwdArg, timeoutArg] = process.argv.slice(2)`. Outcome determined at :103. `buildMissionRecord(collector, meta)` call at :105-113 with meta `{missionId, briefFile, marker, cwd, dispatchedAt, durationS, outcome}`. Ledger append at :114-115 (`appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n')`). Manual-patch hint at :117.
- Ledger: `scripts/cynco-ledger.mjs#buildMissionRecord` (:103-120) hardcodes `verified: null` at :113.
- Existing tests: `engine/__tests__/harness/cyncoLedger.test.ts` — test "buildMissionRecord produces the schema-1 labeled record" asserts `rec.verified` is null when meta carries no verified (keep passing).
- Labeling policy (document in code): exit code 0 → `verified: true`; nonzero exit, timeout, or spawn error → `verified: false` with detail in `verify` (a broken check harness surfaces via the recorded detail + human 1-in-5 spot-audit; erring toward failure labels is safe — Phase 2's exit criterion NEEDS ≥5 genuine failures, and false-negatives are caught on audit).
- Cross-platform command execution: `spawnSync(command, { shell: true, cwd, timeout, encoding: 'utf8' })` — cmd.exe on Windows, /bin/sh elsewhere. Timeout kills the child and sets `result.error.code === 'ETIMEDOUT'`.
- Cross-runtime test trick: `process.execPath` is the current JS runtime (node under vitest, bun under Bun) and both support `-e "<code>"` — use it for deterministic exit-code and slow-command fixtures instead of platform-specific shell builtins.
- Daemon path (`engine/daemon/runs.jsonl`) is OUT OF SCOPE: Phase 2's exit criterion counts `benchmark/cynco-ledger/missions.jsonl` records, which only the driver writes.
- Baselines: un-gated `npx vitest run` = 1882 passed / 33 skipped; TUI untouched by this plan. Run tests from repo root only; git from repo root only; verify branch `phase2-verify` before every commit. CRLF warnings on commit are benign.

---

### Task 1: `runCheck` module + tests

**Files:**
- Create: `scripts/cynco-verify.mjs`
- Create: `engine/__tests__/harness/cyncoVerify.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `engine/__tests__/harness/cyncoVerify.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
// @ts-ignore — untyped harness module
import { runCheck } from '../../../scripts/cynco-verify.mjs'

// process.execPath is the current JS runtime (node under vitest, bun under
// Bun) — both support -e. Quoted for paths with spaces.
const RUNTIME = `"${process.execPath}"`

describe('cynco mission check runner (Phase 2b)', () => {
  it('exit code 0 → verified true, exitCode 0, output captured', () => {
    const r = runCheck(`${RUNTIME} -e "console.log('smoke ok'); process.exit(0)"`, process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.outputTail).toContain('smoke ok')
    expect(typeof r.durationMs).toBe('number')
  })

  it('nonzero exit → verified false with the real exit code', () => {
    const r = runCheck(`${RUNTIME} -e "console.error('3 tests failed'); process.exit(3)"`, process.cwd(), 30000)
    expect(r.verified).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.outputTail).toContain('3 tests failed')
  })

  it('timeout → verified false, exitCode null, timedOut flag', () => {
    const r = runCheck(`${RUNTIME} -e "setTimeout(() => {}, 60000)"`, process.cwd(), 1500)
    expect(r.verified).toBe(false)
    expect(r.exitCode).toBeNull()
    expect(r.timedOut).toBe(true)
  })

  it('output tail is bounded to 2000 chars', () => {
    const r = runCheck(`${RUNTIME} -e "process.stdout.write('x'.repeat(10000))"`, process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.outputTail.length).toBeLessThanOrEqual(2000)
  })

  it('runs in the given cwd', () => {
    const r = runCheck(`${RUNTIME} -e "console.log(process.cwd())"`, process.cwd(), 30000)
    // Normalize slashes — Windows spawnSync reports backslashes.
    expect(r.outputTail.replace(/\\/g, '/')).toContain(process.cwd().replace(/\\/g, '/'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root: `npx vitest run engine/__tests__/harness/cyncoVerify.test.ts`
Expected: FAIL — cannot resolve `../../../scripts/cynco-verify.mjs`.

- [ ] **Step 3: Write the module**

Create `scripts/cynco-verify.mjs`:

```javascript
// Post-mission verification runner (STATE-AND-VISION Phase 2(b)).
//
// Each mission brief ships with a check command (pytest/smoke/grep) that the
// driver runs AFTER the outcome is determined, in the mission's cwd. Exit
// code 0 → verified:true; nonzero exit, timeout, or spawn failure →
// verified:false. Erring toward failure labels is deliberate: the Phase 2
// exit criterion needs genuine failures, and a broken check harness is
// visible in the recorded `verify` detail + the 1-in-5 human spot-audit.
//
// Plain .mjs on node:child_process so it runs under Bun (driver) AND under
// vitest/node (tests) unchanged.

import { spawnSync } from 'node:child_process'

const OUTPUT_TAIL_CHARS = 2000

/**
 * Run a shell check command in `cwd` with a hard timeout.
 * Returns { verified, exitCode, timedOut, durationMs, outputTail }.
 */
export function runCheck(command, cwd, timeoutMs) {
  const start = Date.now()
  const result = spawnSync(command, {
    shell: true, // cmd.exe on Windows, /bin/sh elsewhere
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  })
  const durationMs = Date.now() - start
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const spawnFailed = Boolean(result.error) && !timedOut
  const exitCode = typeof result.status === 'number' ? result.status : null
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}` +
    (timedOut ? `\n[check] TIMED OUT after ${timeoutMs}ms` : '') +
    (spawnFailed ? `\n[check] SPAWN FAILED: ${result.error.message}` : '')
  return {
    verified: exitCode === 0 && !timedOut && !spawnFailed,
    exitCode,
    timedOut,
    durationMs,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/harness/cyncoVerify.test.ts`
Expected: 5 passed. (The timeout test takes ~1.5s by design.)

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: phase2-verify
git add scripts/cynco-verify.mjs engine/__tests__/harness/cyncoVerify.test.ts
git commit -m "feat: runCheck post-mission verification runner — exit 0 => verified, timeout/spawn-fail => false (Phase 2b)"
```

---

### Task 2: `buildMissionRecord` verified/verify passthrough + tests

**Files:**
- Modify: `scripts/cynco-ledger.mjs:113`
- Modify: `engine/__tests__/harness/cyncoLedger.test.ts` (append tests)

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `engine/__tests__/harness/cyncoLedger.test.ts` (after the last `it(...)`):

```typescript
  it('buildMissionRecord passes verified + verify detail through from meta (Phase 2b)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-verify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'landed',
      verified: true,
      verify: { command: 'pytest -q tests/smoke.py', exitCode: 0, timedOut: false, durationMs: 4200, outputTail: '3 passed' },
    })
    expect(rec.verified).toBe(true)
    expect(rec.verify.exitCode).toBe(0)
    expect(rec.verify.command).toBe('pytest -q tests/smoke.py')
  })

  it('buildMissionRecord without verified/verify stays null (manual-patch path unchanged)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-noverify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'timeout',
    })
    expect(rec.verified).toBeNull()
    expect(rec.verify).toBeNull()
  })
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run engine/__tests__/harness/cyncoLedger.test.ts`
Expected: the two new tests FAIL (`rec.verify` undefined / `rec.verified` null-vs-true); all pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `scripts/cynco-ledger.mjs`, replace line 113:

```javascript
    verified: null, // patched after independent verification of the landed commit
```

with:

```javascript
    // Phase 2(b): set by the driver's post-mission check script (exit 0 =>
    // true); null when no check command was supplied (manual-patch path).
    verified: meta.verified ?? null,
    verify: meta.verify ?? null, // { command, exitCode, timedOut, durationMs, outputTail }
```

Also update the meta shape comment above `buildMissionRecord` (:101-102) to read:

```javascript
// meta: { missionId, briefFile, marker, cwd, dispatchedAt, durationS,
//         outcome: 'landed' | 'timeout' | 'zero_tool_fail',
//         verified?: boolean, verify?: object } // Phase 2(b) check-script result
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run engine/__tests__/harness/cyncoLedger.test.ts`
Expected: all pass (13 prior + 2 new = 15).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print: phase2-verify
git add scripts/cynco-ledger.mjs engine/__tests__/harness/cyncoLedger.test.ts
git commit -m "feat: mission record carries verified + verify check detail from meta; null without a check (Phase 2b)"
```

---

### Task 3: Driver wiring + spot-audit reminder

**Files:**
- Modify: `scripts/cynco-mission-driver.mjs`

No automated test covers the driver script itself (it needs a live engine on :9160); its diff is small and reviewed. The logic it delegates to (`runCheck`, `buildMissionRecord`) is unit-tested by Tasks 1-2.

- [ ] **Step 1: Update the usage header (lines 3-7 and 15-17)**

Replace:

```javascript
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
```

with:

```javascript
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
//   check-cmd:     shell command run in cwd AFTER the mission ends (Phase 2b);
//                  exit 0 => verified:true, else verified:false. Omit => null.
```

and replace:

```javascript
// Every mission appends one labeled record to benchmark/cynco-ledger/missions.jsonl
// (governance falsification program, step 1). Patch `verified` after
// independently verifying the landed commit.
```

with:

```javascript
// Every mission appends one labeled record to benchmark/cynco-ledger/missions.jsonl
// (governance falsification program, step 1). With a check-cmd the driver sets
// `verified` itself; without one, patch it after independent verification.
// Human spot-audit every 5th record either way (STATE doc Phase 2(b)).
```

- [ ] **Step 2: Parse the new arg**

Replace line 24:

```javascript
const [taskFile, marker, cwdArg, timeoutArg] = process.argv.slice(2)
```

with:

```javascript
const [taskFile, marker, cwdArg, timeoutArg, checkCmd] = process.argv.slice(2)
```

and update the usage error string on line 26 to:

```javascript
  console.error('usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd]')
```

- [ ] **Step 3: Import runCheck**

After line 22 (`import { createMissionCollector, buildMissionRecord } from './cynco-ledger.mjs'`) add:

```javascript
import { runCheck } from './cynco-verify.mjs'
```

Also add `readFileSync` to the fs import on line 20:

```javascript
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
```

- [ ] **Step 4: Run the check and feed the record**

Replace the ledger block (currently lines 102-120, starting `// Append the labeled mission record...` and ending with the catch) with:

```javascript
// Phase 2(b): brief-supplied check command labels the record automatically.
// Runs for EVERY outcome — a timeout mission that somehow landed working code
// earns verified:true, and a "landed" commit that breaks the check earns
// verified:false. Both are exactly the labels the falsification program needs.
const CHECK_TIMEOUT_MS = 300000
let verified
let verify = null
if (checkCmd) {
  console.log(`[verify] running check in ${CWD}: ${checkCmd}`)
  const r = runCheck(checkCmd, CWD, CHECK_TIMEOUT_MS)
  verified = r.verified
  verify = { command: checkCmd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: r.outputTail }
  console.log(`[verify] ${verified ? 'PASS' : 'FAIL'} (exit=${r.exitCode ?? 'none'}${r.timedOut ? ', TIMED OUT' : ''}, ${r.durationMs}ms)`)
  if (!verified) console.log(`[verify] output tail:\n${r.outputTail}`)
}

// Append the labeled mission record to the outcome ledger
const outcome = landed ? 'landed' : zeroToolCompletion ? 'zero_tool_fail' : 'timeout'
try {
  const record = buildMissionRecord(collector, {
    missionId,
    briefFile: taskFile,
    marker,
    cwd: CWD,
    dispatchedAt,
    durationS: Math.round((Date.now() - start) / 1000),
    outcome,
    verified,
    verify,
  })
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n')
  console.log(`[ledger] ${outcome} record ${missionId} appended (${collector.turns.length} turns, ${collector.s5Decisions.length} S5 decisions) → ${LEDGER_PATH}`)
  if (!checkCmd) console.log('[ledger] no check-cmd given — patch "verified": true|false after independent verification')
  // 1-in-5 human spot-audit cadence (STATE doc Phase 2(b)).
  try {
    const count = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).length
    if (count % 5 === 0) console.log(`[ledger] SPOT-AUDIT DUE: record #${count} — human-verify this mission's label (1-in-5 cadence)`)
  } catch {}
} catch (e) {
  console.log(`[ledger] FAILED to write record: ${e?.message ?? e}`)
}
```

NOTE: the `const outcome = ...` line moves inside this replacement unchanged; do not duplicate it. `existsSync` is imported for symmetry with `readFileSync` but if you find it unused after implementing, drop it from the import (do not leave an unused import).

- [ ] **Step 5: Syntax-check the driver without a live engine**

```bash
bun build --no-bundle scripts/cynco-mission-driver.mjs > /dev/null && echo DRIVER_SYNTAX_OK
bun -e "import('./scripts/cynco-verify.mjs').then(m => console.log('runCheck export:', typeof m.runCheck))"
```

Expected: `DRIVER_SYNTAX_OK` and `runCheck export: function`. (Do NOT run the driver itself — it would try to reach ws://localhost:9160.)

- [ ] **Step 6: Full suite**

```bash
npx vitest run > /tmp/vitest-p2.log 2>&1; tail -6 /tmp/vitest-p2.log
```

Expected: 1889 passed / 33 skipped (baseline 1882 + 5 cyncoVerify + 2 cyncoLedger).

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must print: phase2-verify
git add scripts/cynco-mission-driver.mjs
git commit -m "feat: driver runs brief-supplied check-cmd post-mission to auto-set verified; 1-in-5 spot-audit reminder (Phase 2b)"
```

---

### Task 4: STATE doc amendment

**Files:**
- Modify: `docs/STATE-AND-VISION-2026-07-12.md` (Phase 2 paragraph, line ~292)

- [ ] **Step 1: Amend Phase 2(b)**

In the Phase 2 paragraph, replace:

```
**(b)** Automate verification: each brief ships with a check script (pytest/smoke) the driver runs post-mission to set `verified` without human labeling; human spot-audit 1 in 5.
```

with:

```
**(b)** ✅ **(tooling shipped 2026-07-13)** Automate verification: each brief ships with a check script (pytest/smoke) the driver runs post-mission to set `verified` without human labeling; human spot-audit 1 in 5. Shipped: `scripts/cynco-verify.mjs#runCheck` (exit 0 → true; nonzero/timeout/spawn-fail → false — erring toward failure labels, which the exit criterion needs), driver `check-cmd` 5th arg, `verified`+`verify` detail in the record, 1-in-5 spot-audit reminder off the ledger line count. Operational half (briefs actually shipping checks) runs with the mission cadence.
```

(If the exact sentence differs slightly, match on the "**(b)** Automate verification" anchor and preserve the surrounding sentence structure.)

- [ ] **Step 2: Commit**

```bash
git branch --show-current   # must print: phase2-verify
git add docs/STATE-AND-VISION-2026-07-12.md
git commit -m "docs: Phase 2(b) verification tooling shipped — check-cmd driver arg + runCheck + verified/verify record fields"
```

---

### Task 5: BLOCKING wire check

- [ ] **Step 1: Greps — every new symbol imported AND called**

```bash
grep -n "runCheck" scripts/cynco-verify.mjs scripts/cynco-mission-driver.mjs engine/__tests__/harness/cyncoVerify.test.ts
grep -n "verified\|verify" scripts/cynco-ledger.mjs | head
grep -n "checkCmd" scripts/cynco-mission-driver.mjs
```

Expected: `runCheck` defined in cynco-verify.mjs, imported+called in the driver and the test; `meta.verified ?? null` and `meta.verify ?? null` in cynco-ledger.mjs; `checkCmd` parsed and used (arg parse, runCheck call, meta, no-check hint guard).

- [ ] **Step 2: No unused imports left in the driver**

```bash
grep -n "existsSync" scripts/cynco-mission-driver.mjs
```

Expected: either used, or absent from the import list (unused import = fix before shipping).

- [ ] **Step 3: Suites green at expected counts (repo root)**

```bash
npx vitest run > /tmp/wire-p2.log 2>&1; tail -6 /tmp/wire-p2.log
```

Expected: **1889 passed / 33 skipped**. TUI untouched — no TUI run needed.

- [ ] **Step 4: Ship (git-web-flow)**

```bash
git branch --show-current   # must print: phase2-verify
git push -u origin phase2-verify
gh pr create --title "Phase 2(b): automated mission verification — check-cmd => verified labels" --body "<summary + verification>"
# merge on GitHub, then:
git checkout main && git pull
```
