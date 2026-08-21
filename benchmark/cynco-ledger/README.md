# CynCo Mission Outcome Ledger

Step 1 of the governance falsification program: **no governance signal has ever
been calibrated against ground truth.** Every headless CynCo mission is a free
labeled trial — a binary, externally verified outcome paired with the full
per-turn governance signal vector. This ledger is the dataset that makes the
VSM/S5 layer falsifiable.

Motivating case (F7, docs/cynco-failure-log.md): S5 crisis mode locked a
healthy reused session read-only and killed mission 4 — signals like
`s3s4Balance: critical`, `varietyRatio: overload`, `agreementRatio: 0.00`
fire identically during *successful* missions. With enforcement active we
cannot even tell whether a signal predicted failure or caused it, which is why
missions run with `LOCALCODE_S5_ENFORCE=false` (S5 capped at recommend;
decisions still recorded here).

## Files

- `missions.jsonl` — one JSON record per mission, appended by
  `scripts/cynco-mission-driver.mjs`. Committed to git: the dataset is the
  deliverable.

## Record schema (v1)

```jsonc
{
  "schema": 1,
  "missionId": "cynco-mission6-brief-1783550000000",  // brief basename + epoch
  "briefFile": "C:/tmp/cynco-mission6-brief.txt",
  "marker": "commit-marker substring",
  "cwd": "C:\\Users\\civer\\civkings",
  "dispatchedAt": "2026-07-11T22:00:00.000Z",
  "durationS": 412,
  "outcome": "landed",      // "landed" | "timeout" | "zero_tool_fail"
  "verified": null,         // STRUCTURAL: the check-cmd's exit code. null = UNMEASURED
  "verify": {               // what produced `verified`; null when no check-cmd was given
    "command": "python3 -m pytest -q", "exitCode": 0,
    "timedOut": false, "spawnFailed": false, "durationMs": 70303, "outputTail": "..."
  },
  "mutationSweep": null,    // BEHAVIOURAL: null = UNMEASURED, never "clean"
  // { "command": "...", "killed": 1, "total": 7, "survived": ["W1","W5"], "note": "..." }
  // The commits this mission made. `base` is HEAD at dispatch, `head` is HEAD
  // after the check script ran, so `base..head` is exactly the mission's diff —
  // which is what a DERIVED sweep mutates. null when either end was unreadable;
  // never half a range, because a `head: null` invites substituting HEAD-now and
  // sweeping everything committed since. base === head is the measured answer
  // "committed nothing", not a missing measurement.
  //
  // Absent on every row before 2026-08-21. That absence is why 150 of the first
  // 226 rows can never be swept: the range existed only as prose inside
  // verify.outputTail ("REV 5dc9510 vs BASE c1bff64").
  "commitRange": { "base": "43434ca...", "head": "9f21bd0..." },
  "turns": [                // one per governance.status event (per turn)
    { "t": 1783550000000, "health": "healthy", "s3s4Balance": "critical",
      "toolSuccessRate": 0.9, "stuckTurns": 0, "varietyRatio": 9,
      "varietyBalance": "overload", "algedonicAlerts": 0, "axiomHealth": "red",
      "consecutiveUnstable": 3, "agreementRatio": 0.0 }
  ],
  "s5Decisions": [          // one per s5.decision event
    { "t": 1783550000000, "ruleIds": ["C7"], "reasoning": "...",
      "contextAction": null, "toolRestriction": "read-only",
      "modelSwitch": null, "enforced": false }
  ],
  "controlSignals": [
    { "t": 1783550000000, "temperatureAdjust": 0, "temperature": 0.7,
      "bestOfNBudget": 1, "widenToolSet": false }
  ],
  "toolTransport": [        // one per toolcall.transport event (P1.8 repair ladder); absent in pre-P1.8 records
    { "t": 1783550000000, "stage": "repaired", "toolName": "Read", "detail": "..." }
  ],
  // `errors` counts tool.complete events carrying isError, which for Bash means
  // "exited non-zero" — a red pytest run during a normal TDD loop is counted
  // here. It is NOT a count of tool faults, and nothing grades on it. The
  // fault-vs-verdict distinction lives in governance's toolSuccessRate, which
  // exempts red test suites and the contract's own verification commands
  // (engine/bridge/benignToolResult.ts). Read this field as "non-zero exits".
  //
  // `byClass` splits the verbs three ways because the two-way split was hiding
  // the finding. Counting "delivery" as Edit+Write reads 4.9-8.3% across
  // 11k4/11L/11M/11N and looks survivable; splitting it shows source edits at
  // 1.2-2.2% with scratch Writes (base_realm.py copies, probe dumps) running
  // 2-3x higher. An unrecognised tool counts as `inspect` rather than being
  // dropped, so the three classes always sum to `total`.
  //
  // `maxCallsWithoutSourceEdit` is the longest run of calls that changed no
  // source file. Replayed off the real 11N engine log it is 417, and off 11M
  // 340 — the number that a per-name histogram cannot express at all, because
  // it is a property of the ORDER and byName has thrown the order away.
  //
  // `commits` / `maxCallsWithoutCommit` come from the driver's 30s HEAD poll,
  // not from a tool name — the wave commits through Bash, so there is nothing in
  // the tool stream to watch for. The dispatch baseline is seeded before the
  // first poll, so the commit the mission was dispatched ON is never counted as
  // one it made. `maxCallsWithoutCommit` is the longest run of calls that saved
  // nothing, and the poll period bounds its precision: calls made between a
  // commit and the next poll are still charged to the previous gap, which
  // over-reports by at most one interval. This is the number to read against the
  // eight consecutive runs that ended with an uncommitted tree — 11N managed 2
  // commits in 1805 calls; 11k4, 11L and 11M managed none.
  //
  // Rows written before 2026-08-18 carry a hard `0` in both fields, which on
  // those rows means "nobody counted", not "committed nothing". Records with
  // `commits: 0` AND `maxCallsWithoutCommit: 0` while `total > 0` are the
  // unmeasured ones; a measured mission that never committed has
  // `maxCallsWithoutCommit === total`.
  "toolStats": {
    "total": 13, "errors": 1,
    "byName": { "Read": 7, "Grep": 1, "Edit": 1, "Bash": 4 },
    "byClass": { "sourceEdit": 1, "fileWrite": 0, "inspect": 12 },
    "maxCallsWithoutSourceEdit": 9,
    "commits": 2, "maxCallsWithoutCommit": 6
  }
}
```

## Labeling rule

Ground truth for signal validation (step 2, per-rule precision/recall):

- **success** = `outcome === "landed" && verified === true && mutationSweep` has
  no survivor that a DoD item claimed to own
- **failure** = anything else
- **unlabeled** = `verified === null` or `mutationSweep === null`. An unmeasured
  mission is not a passing one. Exclude it; do not default it.

`outcome` is assigned by the driver (commit marker found in `git log` /
timeout / F7 zero-tool fast-fail).

### `verified` is structural, and it is narrower than the brief

`verified` is **one check command's exit code** — nothing more. It says the
suite collected, the counts held, the process exited 0. It does not say the
delivery did what the brief asked, and reading it as acceptance is how a
broken row gets trained on as a success.

Record #60 (`mission_ui8`) is the case to remember. It is `landed` +
`verified: true`, because its check-cmd was `python3 -m pytest -q` and the
suite was green at 1070. The brief it was dispatched against carried **sixteen
gated DoD items, three of which the delivery did not do** — and a withheld
mutation set then found six rules the new tests do not own. The value of
`verified` was correct. The claim this file used to make about its meaning
("patched in manually after independent verification … diff review against the
brief") was not: the driver patches it automatically, and nobody had reviewed
the diff when it was written.

Two consequences, both now standing practice:

1. **Dispatch each wave with its own DoD gate as the check-cmd**, not with the
   project's test command. The check-cmd is also what `scripts/cynco-contract.mjs`
   turns into the mission's contract, so a one-assertion check-cmd trains the
   model on a one-assertion definition of done.
2. **`mutationSweep` is the behavioural label** and must be patched separately.
   Scope it to mutations that *survived on the pre-wave tree* — one already
   killed at base measures the old suite, not this delivery — and length-check
   `survived.length === total - killed` before committing it.

### Spot-audit cadence

Every 5th record, the driver prints `SPOT-AUDIT DUE`. The audit's question is
not "does this label look right?" but **"what does this label measure, and does
this file's claim about it survive contact with the rows on disk?"** Both audits
run so far (#33, #60) found the value correct and the documented meaning wrong.

## Step 2 gate

Do not redesign the H1-H8 predictions or grant any S5 rule enforcement
authority until this file has **30-50 labeled missions**. Each rule must then
demonstrate predictive precision here ("when X fires, mission fails within N
turns at ≥Y% rate") before it earns back `enforce`.

## Step 2 result — 2026-08-21, 75 labeled missions

The gate above is cleared: 226 rows, **75 labeled**, 47 failures, base failure
rate 62.7%. Run it yourself with `node scripts/cynco-signal-validation.mjs`.

> **Corrected 2026-08-21.** The first version of this section read 28 failures
> and a 37.3% base rate, because `labelOf` implemented `landed && verified` and
> dropped the rest of the rule three paragraphs above it: success also requires
> the sweep to leave **no survivor a DoD item claimed to own**. Nineteen rows —
> `mission_ui7e` at 0/8, `mission_i4d1` at 0/20, `mission_ui8` at 1/7 — had
> landed, passed their check-cmd, and left most of their own claimed rules
> unpinned, and were being counted as examples of what success looks like. The
> conclusion below did not change, which is the only reassuring thing about it.

Note the gap between 226 and 75. The other 151 rows are excluded because
`mutationSweep` was never patched — the labeling rule at the top of this file
says an unmeasured mission is not a passing one, and 151 of them is the cost of
treating that patch step as optional. A count of "landed and verified" reads
111; that is not the labeled set and must not be used as one.

**No rule earns enforcement authority.**

| rule | fired | labeled | precision | lift vs base | p (Holm) | verdict |
|------|-------|---------|-----------|--------------|----------|---------|
| I4 | 223 | 74 | 62.2% | −0.5pp | 1.000 | fires on 223 of 226 missions — a constant, not a signal |
| I3 | 116 | 23 | 78.3% | +15.6pp | 0.432 | best candidate; not significant even uncorrected |
| I1 | 106 | 51 | 54.9% | −7.8pp | 0.432 | points the wrong way — fires more on successes |
| W8 | 86 | 40 | 55.0% | −7.7pp | 0.638 | no evidence |
| W7 | 27 | 15 | 46.7% | −16.0pp | 0.696 | no evidence |
| C2 | 17 | 5 | 20.0% | −42.7pp | 0.430 | too few |
| W6 | 14 | 3 | 100.0% | +37.3pp | 0.696 | too few |
| C4 | 1 | 0 | — | — | — | never fired on a labeled mission |

Not one rule reaches 0.05 even before correction — the smallest raw p is 0.061,
on C2, which fired on five labeled missions. Holm is still applied and still
reported, because seven rules is seven chances and the correction has to be in
place before a rule ever does clear the bar, not added afterwards once someone
dislikes the answer.

Under the earlier, wrong labeling I3 read p=0.037 and I1 read p=0.045, and the
write-up leaned on Holm to explain them away. Both were artifacts of counting
nineteen unpinned missions as successes. It is worth noticing that the *stated*
conclusion survived a bug large enough to move the base rate by 25 points —
that is a sign the conclusion is coarse, not a sign the analysis was careful.

Three things follow.

1. **I4 is not a signal.** It fires on 98.7% of missions, so its precision
   *cannot* differ from the base rate. Whatever it is measuring, it is not a
   property that distinguishes one mission from another.
2. **I1 is a candidate to retire or reverse**, not to enforce. It is the second
   most active rule and its association runs backwards.
3. **The binding constraint is `mutationSweep`, not mission count.** Another
   150 missions dispatched the same way adds ~0 labeled rows. Patching the
   sweep on existing rows is worth more than any number of new runs.

   Two changes remove that constraint, and both were needed.

   First, **`commitRange` is now on every new row** (`{base, head}`). A derived
   sweep mutates the lines the mission added, so it needs the mission's diff;
   the driver has always known the dispatch HEAD and printed it, and never
   wrote it down. On the 226 rows written before this, the only trace of a
   range is prose in `verify.outputTail`, which is why those rows are
   unsweepable rather than merely unswept. Every row from here on can be
   labeled *later*; that is the difference between the ledger growing and the
   labeled set growing.

   Second, `scripts/cynco-mutation-sweep.py` exists to run it. Sweeps
   were null on 151 rows because they were hand-authored per stage after
   reading the landed code; that tool derives them instead from the mission's
   own diff — mutate the source lines the mission added, run the tests it
   delivered. Record a derived sweep with `--kind derived`: its survivors are
   findings about test coverage, not unmet DoD claims, so they label the row
   without failing the mission.

4. **62.7% of labeled missions failed.** Two thirds. That number is not the
   S5 rules' fault and no amount of rule analysis addresses it; it is the
   thing the rules were supposed to predict, and it is the thing to fix.

### On training

This is why step 3 is not next. Fine-tuning an S5 model on these decisions
would teach it to imitate one constant, one backwards rule, and five rules the
data cannot distinguish from noise — at 75 examples, one to two orders of
magnitude short of a LoRA regardless. The ledger is doing its job: it just
falsified the thing it was built to test.
