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
  // `commits` / `maxCallsWithoutCommit` are declared but not yet filled: the
  // wave commits through Bash, so the count has to come from a HEAD poll in the
  // driver rather than from a tool name. Until that lands they are a hard 0,
  // which reads as "committed nothing" when it means "nobody counted". Do not
  // read them as measurement yet.
  "toolStats": {
    "total": 12, "errors": 1,
    "byName": { "Read": 4, "Edit": 2, "Bash": 6 },
    "byClass": { "sourceEdit": 2, "fileWrite": 0, "inspect": 10 },
    "maxCallsWithoutSourceEdit": 7,
    "commits": 0, "maxCallsWithoutCommit": 0
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
