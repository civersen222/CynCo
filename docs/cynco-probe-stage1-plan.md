# Stage 1: S3* In-Loop Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mission driver runs a cheap public check at every turn boundary and, on FAIL, injects the verbatim output and keeps the mission alive — CynCo can no longer end a mission on a self-report the check contradicts.

**Architecture:** A new pure-logic module `scripts/cynco-probe.mjs` (tested, vitest) makes every decision; `scripts/cynco-mission-driver.mjs` (untested by policy — decisions live in tested modules, see the `countGraderProbes` comment at driver line ~198) wires it into the existing wait loop at the point where `waitExitReason` resolves. Probe execution reuses `runCheck` from `scripts/cynco-verify.mjs`. The ledger row grows a `probe` block via `buildMissionRecord`.

**Tech Stack:** Bun + Node ESM (.mjs), vitest for tests, existing driver/bridge protocol (`user.message` frames).

**Spec:** docs/cynco-self-orchestration-spec.md §3. One deviation discovered during planning and folded back into the spec (Task 0): the engine **ignores** `user.message` while a turn is open (`engine/bridge/conversationLoop.ts:872` — "Already processing, ignoring message"), so injection happens at turn boundaries, not mid-turn. The probe therefore fires when the driver's exit decision resolves (`engine_closed_the_turn` / `quiet_heuristic`), which is also exactly where GVS5H runs its verifier (between worker turns). Commit-triggered mid-turn probes are dropped — YAGNI, they could never inject.

**Key existing facts an implementer needs:**
- Driver argv: `const [taskFile, marker, cwdArg, timeoutArg, checkCmd] = process.argv.slice(2)` (driver:58).
- Fail-closed timeout pattern to copy: driver:125-131 (`CYNCO_CHECK_TIMEOUT_MS` must be operator-set when a check-cmd is given).
- Wait loop: driver:430-476. `exitReason = waitExitReason({...})` at :468; when truthy the loop logs and sets `quiet = true`. Exit reasons: `engine_error`, `engine_gone`, `engine_closed_the_turn`, `quiet_heuristic` (cynco-ledger.mjs:379-399).
- `runCheck(command, cwd, timeoutMs)` → `{ verified: true|false|null, exitCode, timedOut, spawnFailed, durationMs, outputTail }` (cynco-verify.mjs:61-87). Synchronous; `verified: null` means timed out / spawn-failed (said nothing).
- Dispatch frame shape (driver:288-295): `{ type: 'user.message', text, cwd, readOnlyPaths, unattended: true, contract? }`. `readOnlyPaths` is currently a local inside `dispatchMission()` (driver:287) — Task 3 hoists it.
- `wsClosed` (driver:356-359): the engine may close the mission socket at turn-loop end while still running (F131 residual). A closed socket cannot carry an injection.
- `buildMissionRecord(collector, meta)` (cynco-ledger.mjs:603) — fields follow the pattern `field: meta.field ?? null`.
- Tests are vitest, live in `scripts/__tests__/`, run with `bunx vitest run <file>`.

---

### Task 0: Fold the turn-boundary reality back into the spec

**Files:**
- Modify: `docs/cynco-self-orchestration-spec.md` (§3 items 2-4)

- [ ] **Step 1: Edit §3.** Replace mechanics items 2 and 3 (the "commit detection, debounced" trigger and the mid-mission injection) with:

```markdown
2. **Trigger: turn boundaries.** The engine ignores `user.message` while a turn is open
   (`conversationLoop.ts:872`), so mid-turn injection is impossible and mid-turn probes could
   never act. The probe runs where the driver's exit decision resolves (`waitExitReason` →
   `engine_closed_the_turn` or `quiet_heuristic`) **and** the mission has landed at least one
   commit — the same place GVS5H runs its verifier: between worker turns. Perf-measuring
   commands are forbidden as probes (wall-clock contention, C5 lesson) — stated in dispatch docs.
3. **Injection: verbatim, prefixed, over the live socket.** On FAIL the driver sends a
   `user.message` (same shape as dispatch, `unattended: true`) quoting the probe's exit code and
   outputTail verbatim, and the wait loop continues instead of ending — this IS the hard
   override: a marker commit with a failing probe does not end the mission. On PASS, silence;
   the mission ends as today. If the mission socket is already closed (F131 residual) the
   injection is impossible; the ledger records it as blocked and the mission ends normally.
```

- [ ] **Step 2: Renumber/adjust old item 4** ("The hard override") — it is now merged into item 3 above; keep the `MAX_OVERRIDES` sentence by appending to item 3: `Bounded by CYNCO_MAX_PROBE_OVERRIDES (default 3); on exhaustion the mission ends and the ledger records the probe block with exhausted: true.` Keep item 5 (ledger) as item 4.

- [ ] **Step 3: Commit**

```bash
git add docs/cynco-self-orchestration-spec.md
git commit -m "spec: stage 1 probes fire at turn boundaries — the engine ignores mid-turn messages"
```

---

### Task 1: `cynco-probe.mjs` — decision logic (TDD)

**Files:**
- Create: `scripts/cynco-probe.mjs`
- Test: `scripts/__tests__/cynco-probe.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { probeConfigError, shouldProbe, overrideDecision, probeMessage } from '../cynco-probe.mjs'

describe('probeConfigError', () => {
  it('refuses a probe command without an operator-chosen cap', () => {
    expect(probeConfigError('pytest -q', undefined)).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
  })
  it('accepts a probe command with an explicit cap', () => {
    expect(probeConfigError('pytest -q', '600000')).toBeNull()
  })
  it('accepts no probe at all', () => {
    expect(probeConfigError(undefined, undefined)).toBeNull()
  })
  it('refuses a cap that is not a positive integer', () => {
    expect(probeConfigError('pytest -q', 'soon')).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
    expect(probeConfigError('pytest -q', '0')).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
  })
})

describe('shouldProbe', () => {
  const base = { probeCmd: 'pytest -q', landed: true, exitReason: 'engine_closed_the_turn' }
  it('probes a landed mission at a quiescent turn boundary', () => {
    expect(shouldProbe(base)).toBe(true)
    expect(shouldProbe({ ...base, exitReason: 'quiet_heuristic' })).toBe(true)
  })
  it('never probes without a probe command', () => {
    expect(shouldProbe({ ...base, probeCmd: undefined })).toBe(false)
  })
  it('never probes an unlanded mission — the probe would grade the base, not the work', () => {
    expect(shouldProbe({ ...base, landed: false })).toBe(false)
  })
  it('never probes a dead harness — engine_error and engine_gone cannot continue', () => {
    expect(shouldProbe({ ...base, exitReason: 'engine_error' })).toBe(false)
    expect(shouldProbe({ ...base, exitReason: 'engine_gone' })).toBe(false)
  })
})

describe('overrideDecision', () => {
  const base = { verified: false, overridesUsed: 0, maxOverrides: 3, socketOpen: true }
  it('injects on FAIL with budget and a live socket', () => {
    expect(overrideDecision(base)).toEqual({ inject: true, why: 'probe FAIL — overriding the exit (1/3)' })
  })
  it('never injects on PASS', () => {
    expect(overrideDecision({ ...base, verified: true }).inject).toBe(false)
  })
  it('never injects on UNMEASURED — a probe that said nothing overrides nothing', () => {
    const d = overrideDecision({ ...base, verified: null })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/UNMEASURED/)
  })
  it('stops at the override budget and says exhausted', () => {
    const d = overrideDecision({ ...base, overridesUsed: 3 })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/exhausted/)
  })
  it('cannot inject over a closed socket and says so', () => {
    const d = overrideDecision({ ...base, socketOpen: false })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/socket/)
  })
})

describe('probeMessage', () => {
  it('quotes the probe verbatim — sha, exit code, tail', () => {
    const msg = probeMessage({ sha: 'abc1234', exitCode: 1, timedOut: false, spawnFailed: false, outputTail: '2 failed, 40 passed' })
    expect(msg).toContain('[PROBE]')
    expect(msg).toContain('abc1234')
    expect(msg).toContain('exit=1')
    expect(msg).toContain('2 failed, 40 passed')
    expect(msg).toContain('NOT done')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run scripts/__tests__/cynco-probe.test.mjs`
Expected: FAIL — cannot resolve `../cynco-probe.mjs`.

- [ ] **Step 3: Implement `scripts/cynco-probe.mjs`**

```js
// Stage 1 of docs/cynco-self-orchestration-spec.md: the S3* audit channel.
//
// GVS5H's finding, transplanted: the manager cannot be trusted to declare
// "done" — only a check that actually ran can close the loop. Here the
// "manager" is the mission itself: F133's 142 broken tests rode a green run
// because "suite green" was prose. The probe is the assertion.
//
// Every function is pure. The driver (untested by policy) only wires them.

/**
 * Fail-closed, same shape as the check-cmd guard (driver:125): a probe with no
 * operator-chosen cap would inherit a default nobody chose, and a probe killed
 * at that cap reports UNMEASURED at the exact moment it was needed.
 * Returns an error string, or null when the configuration is dispatchable.
 */
export function probeConfigError(probeCmd, timeoutEnv) {
  if (!probeCmd) return null
  if (timeoutEnv === undefined) {
    return 'a probe command was given but CYNCO_PROBE_TIMEOUT_MS is unset — set it explicitly, e.g. CYNCO_PROBE_TIMEOUT_MS=600000'
  }
  const n = parseInt(timeoutEnv, 10)
  if (!Number.isFinite(n) || n <= 0 || String(n) !== String(timeoutEnv).trim()) {
    return `CYNCO_PROBE_TIMEOUT_MS must be a positive integer of milliseconds — got "${timeoutEnv}"`
  }
  return null
}

/**
 * Does this turn boundary get a probe? Only a landed mission at a quiescent
 * exit: an unlanded probe would grade the pre-mission repo and file the verdict
 * under this mission's id, and a dead harness (engine_error / engine_gone)
 * cannot be asked to continue whatever the probe finds.
 */
export function shouldProbe({ probeCmd, landed, exitReason }) {
  if (!probeCmd || !landed) return false
  return exitReason === 'engine_closed_the_turn' || exitReason === 'quiet_heuristic'
}

/**
 * The hard override, as a decision with a name. GVS5H line 583: sample tests
 * FAILED overrides the manager's "done". `verified: null` (timeout/spawn-fail)
 * never overrides — a probe that said nothing about the delivery cannot keep
 * the mission alive on its say-so.
 */
export function overrideDecision({ verified, overridesUsed, maxOverrides, socketOpen }) {
  if (verified === true) return { inject: false, why: 'probe PASS — the exit stands' }
  if (verified === null) return { inject: false, why: 'probe UNMEASURED — it said nothing, and nothing overrides nothing' }
  if (!socketOpen) return { inject: false, why: 'probe FAIL but the mission socket is closed — cannot inject, the exit stands' }
  if (overridesUsed >= maxOverrides) return { inject: false, why: `probe FAIL but the override budget is exhausted (${overridesUsed}/${maxOverrides})` }
  return { inject: true, why: `probe FAIL — overriding the exit (${overridesUsed + 1}/${maxOverrides})` }
}

/**
 * The injection text. Verbatim tail, never a paraphrase — the standing
 * brief-authoring rule applies to machine-authored messages too: MISS briefs
 * that quote the gate verbatim turn a 600-turn flail into a 40-turn fix.
 */
export function probeMessage({ sha, exitCode, timedOut, spawnFailed, outputTail }) {
  const status = timedOut ? 'TIMED OUT' : spawnFailed ? 'FAILED TO SPAWN' : `FAILED (exit=${exitCode})`
  return [
    `[PROBE] An automated check just ran against your work at commit ${sha} and ${status}.`,
    'Verbatim output tail:',
    '```',
    outputTail,
    '```',
    'The mission is NOT done. Fix exactly what this output shows, commit the fix, and finish.',
    'Committing your marker does not end the mission while this check fails — it will run again.',
  ].join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run scripts/__tests__/cynco-probe.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/cynco-probe.mjs scripts/__tests__/cynco-probe.test.mjs
git commit -m "feat: probe decision logic — S3* audit channel, pure and tested (stage 1)"
```

---

### Task 2: Ledger `probe` block

**Files:**
- Modify: `scripts/cynco-ledger.mjs:603-627` (`buildMissionRecord`)
- Test: `scripts/__tests__/cynco-ledger-telemetry.test.mjs` (append a describe block)

- [ ] **Step 1: Write the failing test.** Open `scripts/__tests__/cynco-ledger-telemetry.test.mjs`, note how existing tests construct a collector/meta for `buildMissionRecord` (follow the file's own pattern for the minimal meta), and append:

```js
describe('buildMissionRecord probe block', () => {
  it('carries the probe block verbatim and defaults to null', () => {
    // build the same minimal collector+meta the neighbouring tests use, then:
    const probe = { command: 'pytest -q', runs: 2, fails: 1, overrides: 1, lastExit: 0, lastVerified: true, exhausted: false, blockedBySocket: 0 }
    const withProbe = buildMissionRecord(collector, { ...minimalMeta, probe })
    expect(withProbe.probe).toEqual(probe)
    const without = buildMissionRecord(collector, minimalMeta)
    expect(without.probe).toBeNull()
  })
})
```

(If the file has no reusable `minimalMeta`, construct the smallest meta object its other `buildMissionRecord` tests pass — copy theirs.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run scripts/__tests__/cynco-ledger-telemetry.test.mjs`
Expected: FAIL — `record.probe` is `undefined`, not `null`.

- [ ] **Step 3: Implement.** In `buildMissionRecord`'s returned object (cynco-ledger.mjs, after the `verify` field at :627), add:

```js
    // Stage 1 (S3*): what the in-loop probe saw and did. null = no probe-cmd
    // was dispatched, which an absent field could not distinguish from an old
    // driver. { command, runs, fails, overrides, lastExit, lastVerified,
    // exhausted, blockedBySocket } — see scripts/cynco-probe.mjs.
    probe: meta.probe ?? null,
```

- [ ] **Step 4: Run the whole ledger test file**

Run: `bunx vitest run scripts/__tests__/cynco-ledger-telemetry.test.mjs`
Expected: PASS (new test and all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add scripts/cynco-ledger.mjs scripts/__tests__/cynco-ledger-telemetry.test.mjs
git commit -m "feat: mission records carry the probe block (stage 1 measurement instrument)"
```

---

### Task 3: Driver integration

**Files:**
- Modify: `scripts/cynco-mission-driver.mjs` — argv (:58), usage comment (:3-15), fail-closed guard (after :131), `readOnlyPaths` hoist (:287), wait loop (:468-476), record meta (:718-746)

- [ ] **Step 1: argv + usage.** Line 58 becomes:

```js
const [taskFile, marker, cwdArg, timeoutArg, checkCmd, probeCmd] = process.argv.slice(2)
```

Extend the usage comment block (after the check-cmd lines, :8-15) and the usage error string (:60) with:

```
//   probe-cmd:     Stage 1 (S3*, docs/cynco-self-orchestration-spec.md): cheap
//                  PUBLIC check run at every quiescent turn boundary once a
//                  commit has landed. FAIL => verbatim output injected as a new
//                  user turn and the mission continues (max CYNCO_MAX_PROBE_OVERRIDES,
//                  default 3). PASS/UNMEASURED => the exit stands. Requires
//                  CYNCO_PROBE_TIMEOUT_MS, fail-closed like check-cmd. Never a
//                  perf-measuring command: it shares the machine with the run.
```

- [ ] **Step 2: Fail-closed guard.** After the check-cmd guard (:131), add:

```js
import { probeConfigError, shouldProbe, overrideDecision, probeMessage } from './cynco-probe.mjs'  // (top of file with the other imports)

const probeError = probeConfigError(probeCmd, process.env.CYNCO_PROBE_TIMEOUT_MS)
if (probeError) {
  console.error(`[driver] ${probeError} — nothing was dispatched`)
  process.exit(2)
}
const PROBE_TIMEOUT_MS = probeCmd ? parseInt(process.env.CYNCO_PROBE_TIMEOUT_MS, 10) : 0
const MAX_PROBE_OVERRIDES = parseInt(process.env.CYNCO_MAX_PROBE_OVERRIDES ?? '3', 10)
const probeState = probeCmd
  ? { command: probeCmd, runs: 0, fails: 0, overrides: 0, lastExit: null, lastVerified: null, exhausted: false, blockedBySocket: 0 }
  : null
```

- [ ] **Step 3: Hoist `readOnlyPaths`.** Move `const readOnlyPaths = resolve(taskFile).replace(/\\/g, '/')`-line (driver:287) out of `dispatchMission()` to module scope (just above the function), keeping its comment. `dispatchMission` keeps using it unchanged.

- [ ] **Step 4: Wait-loop hook.** In the loop at :468-476, the current code is:

```js
  exitReason = waitExitReason({ landed, sawMessageComplete, msSinceActivity: Date.now() - lastActivityAt, engineError, engineProcessing, workBegun, engineGone: wsClosed && runStateSeen && engineProcessing === null })
  if (exitReason) {
    ...four log branches...
    quiet = true
  }
```

Insert the probe between `if (exitReason) {` and the log branches:

```js
  if (exitReason) {
    // Stage 1 (S3*): the exit decision is the turn boundary — the only moment
    // the engine will accept a message (conversationLoop:872 ignores frames
    // mid-turn). Probe now, and let the verdict decide whether this exit stands.
    if (probeState && shouldProbe({ probeCmd, landed, exitReason })) {
      const probedSha = gitHead(CWD)
      console.log(`[probe] running in ${CWD}: ${probeCmd} (cap ${PROBE_TIMEOUT_MS}ms, run ${probeState.runs + 1})`)
      const pr = runCheck(probeCmd, CWD, PROBE_TIMEOUT_MS)
      probeState.runs++
      probeState.lastExit = pr.exitCode
      probeState.lastVerified = pr.verified
      if (pr.verified === false) probeState.fails++
      const d = overrideDecision({ verified: pr.verified, overridesUsed: probeState.overrides, maxOverrides: MAX_PROBE_OVERRIDES, socketOpen: !wsClosed })
      console.log(`[probe] ${pr.verified === null ? 'UNMEASURED' : pr.verified ? 'PASS' : 'FAIL'} (exit=${pr.exitCode ?? 'none'}${pr.timedOut ? ', TIMED OUT' : ''}, ${pr.durationMs}ms) — ${d.why}`)
      if (pr.verified === false && wsClosed) probeState.blockedBySocket++
      if (d.inject) {
        probeState.overrides++
        console.log('[probe] injecting the verbatim FAIL and continuing the wait — the mission is not done')
        try {
          ws.send(JSON.stringify({ type: 'user.message', text: probeMessage({ sha: probedSha, ...pr }), cwd: CWD, readOnlyPaths, unattended: true }))
          sawMessageComplete = false
          lastActivityAt = Date.now()
          exitReason = null
          continue
        } catch (e) {
          console.log(`[probe] injection FAILED (${e?.message ?? e}) — the exit stands after all`)
        }
      } else if (pr.verified === false) {
        probeState.exhausted = probeState.overrides >= MAX_PROBE_OVERRIDES
      }
    }
    ...existing four log branches unchanged...
    quiet = true
  }
```

- [ ] **Step 5: Record meta.** In the `buildMissionRecord` call (:718-746), after `verify,` add:

```js
    probe: probeState,
```

- [ ] **Step 6: Syntax check + full test sweep**

Run: `node --check scripts/cynco-mission-driver.mjs && bunx vitest run scripts/__tests__/`
Expected: syntax OK; all test files PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/cynco-mission-driver.mjs
git commit -m "feat: driver probes at turn boundaries and overrides a failing exit (stage 1, S3*)"
```

---

### Task 4: Dispatch passthrough

**Files:**
- Modify: `scripts/dispatch-mission.sh:8,14-18,49-51,210-214`

- [ ] **Step 1: Add the 6th argument.** Usage line (:8) and header become:

```bash
# Usage: scripts/dispatch-mission.sh <brief-file> <marker> [cwd] [timeout-s] [check-cmd] [probe-cmd]
...
PROBE_CMD=${6:-}
```

After the `CYNCO_CHECK_TIMEOUT_MS` default (:51), add:

```bash
# Stage 1 probe cap (S3*). The probe is a cheap public check (suite count, a
# targeted pytest file) — never the sealed gate, never anything that measures
# wall-clock: it shares the machine with the run it is probing.
CYNCO_PROBE_TIMEOUT_MS=${CYNCO_PROBE_TIMEOUT_MS:-600000}
```

- [ ] **Step 2: Pass it to the driver.** The dispatch tail (:210-214) becomes:

```bash
CYNCO_CHECK_TIMEOUT_MS="$CYNCO_CHECK_TIMEOUT_MS" \
CYNCO_PROBE_TIMEOUT_MS="$CYNCO_PROBE_TIMEOUT_MS" \
CYNCO_TEARDOWN_ENGINE=1 \
  bun scripts/cynco-mission-driver.mjs \
    "$BRIEF" "$MARKER" "$MISSION_CWD" "$TIMEOUT_S" "${CHECK_CMD:-}" ${PROBE_CMD:+"$PROBE_CMD"} \
  > "$DRIVER_LOG" 2>&1 &
```

Note the check-cmd quoting change: `${CHECK_CMD:+"$CHECK_CMD"}` becomes `"${CHECK_CMD:-}"` **only if** a probe-cmd is given positionally after it — an empty 5th arg must still hold the position. Simplest correct form, since the driver treats an empty-string check-cmd as falsy: always pass `"${CHECK_CMD:-}"` and `${PROBE_CMD:+"$PROBE_CMD"}`. Verify with Step 3.

- [ ] **Step 3: Verify the driver treats `''` as no check-cmd.** `if (checkCmd && ...)` at driver:125/554 — empty string is falsy, so positional `''` is safe. Confirm by reading those lines, then run:

```bash
bash -n scripts/dispatch-mission.sh
```

Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add scripts/dispatch-mission.sh
git commit -m "feat: dispatch passes probe-cmd through with a fail-closed cap (stage 1)"
```

---

### Task 5: Wire check (BLOCKING)

- [ ] **Step 1: Grep every new symbol and verify it is imported and called:**

```bash
grep -n "probeConfigError\|shouldProbe\|overrideDecision\|probeMessage" scripts/cynco-mission-driver.mjs scripts/cynco-probe.mjs scripts/__tests__/cynco-probe.test.mjs
grep -n "probe" scripts/cynco-ledger.mjs | grep -i "meta.probe"
grep -n "PROBE_CMD\|CYNCO_PROBE_TIMEOUT_MS" scripts/dispatch-mission.sh
grep -n "probeState" scripts/cynco-mission-driver.mjs
```

Expected: each of the four module exports appears in BOTH the module and the driver import/call sites; `meta.probe` in the ledger; `PROBE_CMD` + cap in dispatch; `probeState` at declaration, wait-loop, and record meta. Any symbol that appears only at its definition is unwired — fix before proceeding.

- [ ] **Step 2: Full test sweep + syntax**

```bash
bunx vitest run scripts/__tests__/ && node --check scripts/cynco-mission-driver.mjs && bash -n scripts/dispatch-mission.sh
```

Expected: all PASS.

---

### Task 6: Live calibration — the Rule-11 analog (spec §8)

The probe path must demonstrate both behaviors against a real engine before any real dispatch: **injection + override on FAIL** and **silence on PASS**. This uses a scratch repo and a deliberately under-specified brief so the probe's verbatim output is the only way the model learns the real requirement.

- [ ] **Step 1: Build the scratch repo**

```bash
rm -rf /c/tmp/probe-cal && mkdir -p /c/tmp/probe-cal && cd /c/tmp/probe-cal && git init -b master
git config user.email cal@cal && git config user.name cal
cat > test_greet.py <<'EOF'
from greet import greeting
def test_greeting():
    assert greeting() == "hello world"
EOF
git add test_greet.py && git commit -m "cal base"
```

- [ ] **Step 2: Write the brief** to `/c/tmp/probe-cal-brief.txt`:

```
Create greet.py in this repo with a function greeting() that returns the string "hello".
Do not read or modify test_greet.py.
Commit with the message: cal probe stage1
That single commit is the whole mission.
```

(The brief says "hello"; the pre-staged test demands "hello world". The first probe MUST fail, and only the injected verbatim assertion output tells the model why.)

- [ ] **Step 3: Dispatch** (fresh engine via the canonical script; small budget):

```bash
CYNCO_CHECK_TIMEOUT_MS=120000 CYNCO_PROBE_TIMEOUT_MS=120000 \
  bash scripts/dispatch-mission.sh /c/tmp/probe-cal-brief.txt "cal probe stage1" C:/tmp/probe-cal 1800 \
  "python -m pytest test_greet.py -q" "python -m pytest test_greet.py -q"
```

- [ ] **Step 4: Watch the driver log** (`tail -f /c/tmp/driver_probe-cal-brief.log`) and verify, in order:
  1. `[probe] running in C:/tmp/probe-cal: python -m pytest test_greet.py -q` after the first commit lands and the turn closes.
  2. `[probe] FAIL ... — probe FAIL — overriding the exit (1/3)` and `[probe] injecting the verbatim FAIL`.
  3. A new turn begins (tool calls resume); the model edits greet.py to return "hello world" and commits.
  4. Second probe: `[probe] PASS ... — probe PASS — the exit stands`, then the normal verify runs and reports PASS.
  5. Ledger row's `probe` block: `runs: 2, fails: 1, overrides: 1, lastVerified: true, exhausted: false`.

Check the row:

```bash
tail -1 benchmark/cynco-ledger/missions.*.jsonl | python -c "import json,sys; r=json.loads(sys.stdin.read()); print(json.dumps(r.get('probe'), indent=2), r.get('verified'))"
```

Expected: the block above and `verified: True`.

- [ ] **Step 5: If any step diverges** — most likely candidates: the bridge refuses the second `user.message` (schema), or the engine's conversation state rejects a follow-up in unattended mode — STOP, read the engine log (`/c/tmp/engine_probe-cal-brief.log`, never the console), diagnose, fix, and re-run the calibration from Step 1. Do not proceed to real missions with an uncalibrated probe path. Log any engine-side fix as its own commit.

- [ ] **Step 6: Clean up + commit any calibration fixes**

```bash
rm -rf /c/tmp/probe-cal /c/tmp/probe-cal-brief.txt
git status  # commit anything the calibration forced you to fix
```

---

### Task 7: Push + PR (git web flow)

- [ ] **Step 1:**

```bash
git push -u origin cynco-self-orchestration
gh pr create --title "Stage 1: S3* in-loop probe — the driver overrides a failing exit" --body "..."
```

Merge on GitHub web, then `git checkout main && git pull` (standing directive).

---

## Self-review notes

- **Spec coverage:** §3.1 probe-cmd arg → Task 3/4; §3.2 trigger → Task 0 (revised) + Task 3 Step 4; §3.3 verbatim injection → Task 1 `probeMessage` + Task 3; §3.4 override + bound → Task 1 `overrideDecision` + Task 3; §3.5 ledger → Task 2; §8 tests + calibration → Tasks 1, 2, 6. Success-metric reporting (§3, §6) is supervision work at wave verdicts, not code — no task needed.
- **Deviation from spec, resolved in Task 0:** turn-boundary probes instead of mid-turn commit-triggered probes (engine ignores mid-turn messages; conversationLoop:872).
- **Type consistency:** `probeState` fields = ledger block fields = Task 2 test fields; `overrideDecision` inputs match driver call site; `probeMessage` inputs are `runCheck`'s outputs plus `sha`.
