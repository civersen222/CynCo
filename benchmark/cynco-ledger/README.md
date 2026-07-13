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
  "verified": null,         // patched to true/false after independent verification
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
  "toolStats": { "total": 12, "errors": 1, "byName": { "Read": 4, "Edit": 2, "Bash": 6 } }
}
```

## Labeling rule

Ground truth for signal validation (step 2, per-rule precision/recall):

- **success** = `outcome === "landed" && verified === true`
- **failure** = anything else

`outcome` is assigned by the driver (commit marker found in `git log` /
timeout / F7 zero-tool fast-fail). `verified` is patched in manually after
independent verification of the landed commit (diff review against the brief,
test suite, smoke check) — a landed-but-broken commit is a failure.

## Step 2 gate

Do not redesign the H1-H8 predictions or grant any S5 rule enforcement
authority until this file has **30-50 labeled missions**. Each rule must then
demonstrate predictive precision here ("when X fires, mission fails within N
turns at ≥Y% rate") before it earns back `enforce`.
