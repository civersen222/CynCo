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
  // Which campaign dispatched it, from CYNCO_CAMPAIGN_ID: "c8" for a wave,
  // "c9-author" for a gate-authoring mission, null outside a campaign. The
  // missionId cannot answer this — it is the brief's filename plus an epoch.
  "campaignId": "c8",
  "briefFile": "C:/tmp/cynco-mission6-brief.txt",
  "marker": "commit-marker substring",
  "cwd": "C:\\Users\\civer\\civkings",
  "dispatchedAt": "2026-07-11T22:00:00.000Z",
  "durationS": 412,
  "outcome": "landed",      // "landed" | "timeout" | "zero_tool_fail"
  // STRUCTURAL: the check-cmd's exit code. null = UNMEASURED. For a gate-AUTHORING
  // mission it is null by construction — the run cannot go quiet, so the driver
  // records the advisory and no verdict — and nothing may gate on it there: the
  // authoring verdict is the runner's own subprocess check (spec §10).
  "verified": null,
  "verify": {               // what produced `verified`; null when no check-cmd was given
    "command": "python3 -m pytest -q", "exitCode": 0,
    "timedOut": false, "spawnFailed": false, "durationMs": 70303, "outputTail": "..."
  },
  "mutationSweep": null,    // BEHAVIOURAL: null = UNMEASURED, never "clean"
  // { "command": "...", "killed": 1, "total": 7, "survived": ["W1","W5"], "note": "..." }
  // `kind` (absent = authored): "derived" = cynco-mutation-sweep.py over the
  // expressions the diff ADDED; "derived-full" (F164) = a derived sweep over
  // the whole files named by `--mutate` — the runner's retry, or a hand run.
  // The runner's retry: the derived sweep refused (exit 2) on the diff — an
  // import-only or otherwise unmutable change — and the grade retried it ONCE
  // with `--mutate` over every non-test `.py` the wave's diff touched,
  // mutating those files WHOLE. A hand `--mutate` run recorded before F164
  // says `derived`. The
  // grade writes `retried: false` on a first-call reading and `retried: true`
  // on a derived-full one; `cynco-ledger-sweep.mjs --kind derived-full` writes
  // the same shape for a hand relabel, and refuses it for a `--command` that
  // carries no `--mutate`. `cynco-mutation-sweep.py` itself prints
  // `"kind": "derived-full"` (and the `--kind derived-full` hint) for any run
  // given `--mutate`. The sources are the wave's diff read with
  // `--diff-filter=d`: a DELETED path is never named (under `--mutate` it would
  // be a refusal), and a deleted test file does not count as a shipped one. A
  // derived-full reading's mutants are not only the wave's own lines — the
  // kind says so, and both derived kinds label the row without a survivor
  // failing it (see "Labeling rule").
  // Written by the campaign runner's GRADE alongside `mutationSweep`: why a
  // derived sweep produced no reading ("timed out after 3600000 ms", "sweep
  // refused (exit 2)", "unparseable sweep output") — after the `--mutate`
  // retry when one ran. null = the sweep ran, or there was no diff to sweep.
  // Distinguishes "unmeasured because the instrument broke" from "unmeasured
  // because nothing was measured".
  "sweepFault": null,
  // Written by the same GRADE patch (and on the wave record): true when the
  // F164 `--mutate` retry RAN — so `sweepFault: "sweep refused (exit 2)"` with
  // `sweepRetried: true` is a refusal that survived its retry, and with
  // `false` one that was never retried (no non-test source to name). Absent on
  // rows graded before Phase 6.
  "sweepRetried": false,
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
      "consecutiveUnstable": 3, "agreementRatio": 0.0,
      // F165: the signal vector's version (1 when the frame carried none) and
      // the cumulative alert count (null on v1). See "Signals version (F165)".
      "signalsVersion": 2, "algedonicAlertsTotal": 21,
      // Task 4 (2a-iii): the Brain's telemetry for this turn (engine/bridge/
      // protocol.ts GovernanceStatusEvent.brain), verbatim. null when the
      // frame carried none — an older engine, Ollama, or a brain dep that
      // never started. `layerConvergence`/`toolEntropy` are independently
      // nullable inside a non-null `brain`: the tap can degrade mid-run.
      // `meanDepth` is a LAYER INDEX, not a fraction: `convergenceOf`
      // (engine/brain/layerConvergence.ts) reports the SHALLOWEST probed layer
      // that already agrees with the deepest one, and falls back to the deepest
      // layer itself when none does. With the default probe list
      // (LLAMA_ACTIVATIONS_LAYERS = 24,32,40,48,56) it reads somewhere in
      // [24, 56], and a value near 56 means the answer settled late. Only
      // `meanAgree` and `byLayer` are fractions. The numbers below are a real
      // turn from the 2026-09-22 smoke, not invented ones.
      "brain": { "tier": "live",
        "layerConvergence": { "n": 8, "meanAgree": 0.125, "meanDepth": 52,
          "byLayer": { "24": 0, "32": 0, "40": 0.125, "48": 0.375 } },
        "toolEntropy": { "mean": 0.0114, "max": 0.2125, "spikeCount": 2 } } }
  ],
  // `authority` (Phase 4): "earned" (every rule in ruleIds is PREDICTIVE in
  // ~/.cynco/datasets/rule-verdicts.json — see "Rule verdicts file" below),
  // "advisory" (one is not, or ruleIds is empty; never applied, so `enforced`
  // is false whatever LOCALCODE_S5_ENFORCE says), "legacy" (no verdict file;
  // LOCALCODE_S5_ENFORCE alone decides, as before), or null on a record from
  // an engine older than Phase 4.
  // `source` (F157): "stuck-reeval" for the stuck-loop live re-evaluation's
  // decision (stuck ≥ 5), null for the per-message decision. Rows written
  // before F157 carry no re-eval decisions at all, and their `enforced: false`
  // does not rule out a stuck re-eval tool restriction having been applied.
  "s5Decisions": [          // one per s5.decision event
    { "t": 1783550000000, "ruleIds": ["C7"], "reasoning": "...",
      "contextAction": null, "toolRestriction": "read-only",
      "modelSwitch": null, "enforced": false, "authority": "advisory",
      "source": null }
  ],
  "controlSignals": [
    { "t": 1783550000000, "temperatureAdjust": 0, "temperature": 0.7,
      "bestOfNBudget": 1, "widenToolSet": false }
  ],
  // Task 7 (2c-i): the notes an operator typed at the 9161 dashboard WHILE the
  // mission was running. One entry per note, not one per frame: the engine
  // emits `mission.operator_note` twice — queued, then its outcome — and the
  // second frame fills in the entry the first opened. The match is by frame
  // KIND, not by `queuedAt` alone: `queuedAt` is millisecond-resolution and two
  // sends can share it, so a queued frame always opens a new entry and an
  // outcome frame fills the first entry still open under that key.
  //
  // Every note ends in exactly one of three states:
  //   deliveredAtIteration: <n>      the model got it, at that runModelLoop
  //                                  iteration. `t` is when it was queued, so
  //                                  the gap is the operator's latency behind
  //                                  the model call already in flight.
  //   dropped: "queue full"          a newer note pushed it out (cap is 5 in
  //                                  flight); also on a low/operator alert.
  //   dropped: "mission ended"       the unattended message finished with it
  //                                  still queued. It was NOT carried into the
  //                                  next session — holding it over spliced a
  //                                  stale [operator] line into whatever ran
  //                                  next, including interactive sessions.
  // All three null = the collector saw it queued and never saw it resolved: a
  // run that died mid-mission. That is a finding, and is kept, not filtered.
  //
  // Only an UNATTENDED run can produce these. An interactive session keeps the
  // old drop-and-log — there is a person at the terminal who can resend — so
  // `[]` there is correct, not a gap.
  //
  // `source` says WHO sent it: "operator" — a person typing into the 9161 chat
  // box mid-mission — or "driver" — cynco-mission-driver.mjs re-injecting a
  // verbatim gate FAIL after its silence heuristic declared exit while the loop
  // was still working. Both arrive on the same busy guard, and before this
  // field the driver's probe was indistinguishable from something a human
  // typed. The engine decides it from the frame: the driver declares
  // `unattended: true` on everything it sends, the chat box never does. `null`
  // means the frame carried no `source` (a record from an engine older than
  // this field) — read it as unknown, never as "operator".
  "operatorNotes": [
    { "t": 1783550000000, "text": "stop editing app.py", "queuedAt": "2026-09-22T10:00:00.000Z",
      "source": "operator", "deliveredAtIteration": 41, "dropped": null },
    { "t": 1783550300000, "text": "PROBE FAIL C8.1a.tiers-pressable ...", "queuedAt": "2026-09-22T10:05:00.000Z",
      "source": "driver", "deliveredAtIteration": null, "dropped": "mission ended" }
  ],
  // Phase 5 ruling 8 (F162): one entry per `bestOfN.selected` frame — the
  // engine picked a winner among N candidates. `applied: false` is a winner
  // whose patch `git apply` refused; the turn then ran single-pass. Before
  // F162's fix every winner came back false (the diff's final newline was
  // trimmed), and nothing on the row said so. `winner` is the candidate's
  // 0-based index, `passRate` its test pass rate; a field the frame lacked is
  // null. `null` = best-of-N never started this mission (no `bestOfN.start`
  // frame — it runs only with `LOCALCODE_BEST_OF_N=true` and a detected test
  // framework); `[]` = it started and selected no winner; rows before Phase 5
  // have no field.
  "bestOfN": [
    { "t": 1783550000000, "winner": 1, "passRate": 0.75, "applied": true }
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
    "commits": 2, "maxCallsWithoutCommit": 6,
    "bashByEffect": { "read": 2, "write": 0, "run": 1, "commit": 1, "revert": 0, "other": 0 }
  },
  // `byClass.inspect` above keeps Bash's historical bucket — it is joined
  // against old rows and does not change. `bashByEffect` is the NEW, honest
  // count of what each Bash call actually DID, from the same classifier the
  // runtime regulator reads (engine/tools/bashEffect.ts) — C8 wave 1 found the
  // regulator counting by tool name while 233 read-shaped Bash calls slipped
  // past it uncounted. Every Bash call increments exactly one bucket; the
  // sums must equal `byName.Bash`.
  // F57. How the drive loop resolved. "timeout" is the only value assigned by
  // fallback; "never_dispatched" means no turn ever ran.
  "exitReason": "engine_closed_the_turn",
  "markerSeen": true,        // commit-marker substring found in `git log`
  "engineError": null,       // non-null when the engine process died (outcome "engine_error")
  // /api/run still reported an open run at exit. null = nothing ever answered
  // /api/run — an older engine cannot be read as a quiet one.
  "runStillOpen": false,
  "toolCallsAfterExit": 0,   // tool.start frames after the exit decision resolved
  // F33: join key to ~/.cynco/rewards/*.reward.json. `[]` = driver asked and
  // was told nothing; absent = record written before the question existed.
  "taskIds": ["task-54da9ac4"],
  // F38: from historyRewrite() — the only field that can say the surviving git
  // history is not all of it. null = reflog unreadable (unknown, not clean).
  "history": { "rewritten": false, "discarded": [] },
  // Stage 1 (S3*): what the in-loop probe saw and did. The driver runs the
  // probe-cmd at quiescent turn boundaries after a landed commit and injects a
  // FAIL's verbatim tail as a user message, capped by CYNCO_MAX_PROBE_OVERRIDES.
  // null when the mission was dispatched without a probe-cmd.
  "probe": { "command": "python -m pytest test_x.py -q", "runs": 2, "fails": 1,
    "overrides": 1, "lastExit": 0, "lastVerified": true,
    "exhausted": false, "blockedBySocket": 0 },
  // Grader-probe scan of tool.start inputs. null when no frame carried an
  // inspectable input (engine too old) — a measured `probes: 0` is a different
  // fact from an unmeasured one and must not collapse into it.
  "graderProbes": { "total": 13, "probes": 0, "uninspectable": 0,
    "byPattern": {}, "samples": [] },
  // Real token counts from the server's own timings (session.tokenStats,
  // cumulative — collector keeps the latest sum). null, not zeros, when the
  // run died before its first model turn: economics must fall back to its
  // labelled estimate, never mistake absence for a free mission.
  "tokenStats": { "prefillTokens": 29995, "cachedTokens": 252043,
    "decodeTokens": 4081, "measuredTurns": 23, "unmeasuredTurns": 0 },
  // P4.3/4(e): session-level regulator fidelity; null when the engine emitted
  // no session_fidelity event (no contract / older engine).
  "regulatorFidelity": { "hadContract": true, "resolutionRate": 1,
    "finalTaskError": 0, "contractReplacements": 0 },
  // Last `governance.status` snapshot wins (cumulative, like `tokenStats`
  // above — not an average or a history). null = the engine never sent one:
  // an interactive-style run, or an engine without Plan 2's invariant/
  // ultrastable telemetry.
  // `configuration` is the GATING state (derived from the caps: over either
  // cap = "edit-only"). `steps[].to` is the Ashby uniselector trace and is a
  // different thing: it oscillates full -> edit-only -> full while a violation
  // holds, because a 2-position Discrete step function re-steps every time a
  // dwell expires with the variable still out of bounds. Read `to` as "the
  // regulator tried another configuration here", never as "inspection was open
  // at this point" — the gate does not key on it. `restoredAfter` fills only
  // for the LAST step of an episode: it is how many observations later the
  // variable came back inside bounds, and it stays null on every step the
  // search passed through on the way.
  //
  // `denials` and `steps` are WINDOWS (last 50 / last 20), not the history:
  // the frame is re-emitted every model iteration, so the full-run facts live
  // in the counts and the aggregates beside them. `denialsByInvariant` and
  // `nextCallClassCounts` are over ALL denials, not the window, and each sums
  // to `denialCount` (`pending` = a denial whose next call was never observed,
  // i.e. the run ended on it).
  // `nextCallClassByInvariant` splits `nextCallClassCounts` by the invariant
  // that denied (edit-gap / commit-gap / revert), over ALL denials. This is
  // the per-invariant "did the denial change the next call" input for
  // scripts/cynco-signal-validation.mjs --denials; the `denials` window is
  // only the last 50 and cannot answer it for a long run.
  "invariants": { "configuration": "full",
    "denials": [], "denialCount": 0, "steps": [], "stepCount": 0,
    "denialsByInvariant": { "edit-gap": 0, "commit-gap": 0, "revert": 0 },
    "nextCallClassCounts": {},
    "nextCallClassByInvariant": { "edit-gap": {}, "commit-gap": {}, "revert": {} },
    "terminalRelents": [],
    "revertRefusals": 0, "codeIndexAssisted": 0 },
  // `terminalRelents` names the caps the gate GAVE UP on: three full relent
  // cycles (nine denials) on one variable and it stops withholding inspection
  // for that variable, because an unsatisfiable cap (nothing to commit, a
  // failing hook, a non-repo cwd) stops regulating and just throttles the run.
  // A row with a terminal relent was paced by one cap, not two, from that
  // point on — it is not comparable to a row that held both.
  //
  // `invariantsRejected: true` means caps WERE declared for this mission and
  // the engine threw them away as malformed. `invariants: null` alone cannot
  // say that — a mission dispatched without caps and a mission whose caps were
  // rejected are the same null — and only the second is a dispatch bug. Never
  // null: an engine that cannot say simply did not reject one.
  "invariantsRejected": false,
  // Phase 2b-ii verify-first routing (governance.status.routing, last frame
  // wins). The gate ladder's SECOND verb: a revert is still refused, but the
  // refusal first runs the mission's KEEP-GREEN command so it can say whether
  // there is anything to undo; and a source edit the model was uncertain about
  // (tool-token entropy) is executed and THEN measured, with the verdict
  // appended to the result it reads next.
  //
  // `count` is every route; `used` is how many KEEP-GREEN runs were actually
  // paid for out of `budget` (6 per mission) — cached verdicts and refused
  // routes cost nothing, so `used < count` is normal and `used == budget` is
  // how you see the budget bind. `entries` is the last 20; `byKind` and
  // `byOutcome` are over ALL routes, and every outcome key is present so a
  // mission that never timed out says zero rather than saying nothing.
  //
  // `entries[].nextCallClass` is the outcome record, exactly as it is for a
  // denial: what the model's NEXT call was (`classifyCall`) after it was told
  // the tree was green, or red, or unmeasurable. That is the only evidence
  // that an informed refusal changes behaviour where a bare refusal does not.
  //
  // null = the mission could NOT route: interactive, no invariants, or no
  // KEEP-GREEN assertion in the contract. A mission that could route and never
  // needed to arrives as a block with `count: 0` — a different fact.
  "routing": { "budget": 6, "used": 3, "count": 5,
    "byKind": { "revert": 2, "low-confidence-edit": 3 },
    "byOutcome": { "passed": 2, "failed": 1, "timeout": 0, "unrunnable": 0,
      "cached-passed": 1, "cached-failed": 0, "budget-exhausted": 1 },
    "entries": [ { "callIndex": 412, "kind": "revert", "entropy": 0.41,
      "outcome": "passed", "ms": 41200, "tail": "12 passed",
      "nextCallClass": "commit" } ] },
  // The legacy (session-feedback) ultrastable instance, last status frame
  // wins: `trace` is the last 20 adaptation steps (`traceLength` the total),
  // `margin` the viability margin. `retained` is the instance's retained-
  // configuration table (violation pattern -> configuration that restored
  // viability) and `retainedVersion` the last stored version of this
  // instance's table, in ~/.cynco/retained/session-feedback.json (the live
  // `retained` may have moved since; engine/vsm/retainedConfigStore.ts — the
  // version moves only when the table changes). `retainedVersion` null =
  // nothing stored yet; both null on a row from an engine that predates the
  // store. Memory only: nothing applies a retained configuration yet.
  "ultrastable": { "traceLength": 0, "trace": [], "margin": 0.4,
    "retained": { "ev0": { "Continuous": [0.75, 8192, 0.3] } }, "retainedVersion": 2 },
  // The ENGINE's live POSIWID reading (last governance.status frame): its
  // default purpose model against the session's executed tool classes
  // (vsm/constraintChecks.ts). Distinct from the runner-patched `posiwid`
  // block, which grades a wave against the campaign spec's own shares. Data
  // for the falsification programme; nothing branches on it.
  "posiwidLive": { "divergence": 0.31, "verdict": "Drifting", "dominantStated": "inspect", "dominantObserved": "inspect", "support": 931 },
  // IdentityGuard verdict at the last user-message end (vsm/identityGuard.ts).
  // `passed` is what decides the session outcome; `posiwidPass` is recorded so
  // its precision can be measured here before it is allowed to count.
  "identityGuard": { "passed": true, "posiwidPass": false, "violations": [], "details": ["..."] },
  // Task 4 (2a-iii): the Brain's per-turn `brain` frames (above), folded to one
  // row-level summary — computeBrainStats() in scripts/cynco-ledger.mjs. null
  // when NO frame ever carried a `brain` block (an older engine, Ollama, or a
  // brain dep that never started); never collapsed into a measured zero.
  // `turnsWithLens` and `meanAgree`/`meanDepth` are over turns whose
  // `layerConvergence` was non-null; `meanToolEntropy` is over turns whose
  // `toolEntropy` was non-null, independently — the two can differ because the
  // tap can degrade mid-run. `tier` is the LAST non-null tier seen on any
  // frame that carried a `brain` block. This is a MEASUREMENT, not a rule:
  // `scripts/cynco-signal-validation.mjs --signals` is what asks whether it
  // predicts anything, by cutting `meanAgree`/`meanToolEntropy` at quartiles
  // computed over labeled rows (`signalQuartiles`) into three candidate
  // signals (`signalsFired`: `LC-low`, `LC-high`, `TE-high`) and running the
  // same `analyse()` every S5 rule id goes through — thresholds live only in
  // that file, never here or in the engine.
  // `meanDepth` carries the same LAYER-INDEX unit as `turns[].brain` above —
  // never a fraction. These are the 2026-09-22 smoke's real numbers.
  "brainStats": { "tier": "live", "turnsWithLens": 28, "meanAgree": 0.0646,
    "meanDepth": 53.55, "meanToolEntropy": 0.0873 }
}
```

Two fields are patched in by hand and appear only on some rows:

- **`spotAudit`** — the every-5th-record audit result (see "Spot-audit cadence"
  below): `{ auditedAt, record, labelCorrect, wouldOwnTestsHaveCaughtIt,
  testsEditedOrSkipped, ... }`.
- **`verifyCorrection`** — a hand correction to `verified` with its evidence,
  written when an independent re-run contradicts the driver's patched value.

Two further blocks are patched on by the campaign runner
(`scripts/cynco-campaign.mjs` → `scripts/cynco-ledger-patch.mjs`) when it grades
a wave, so a mission row carries the sealed-gate reading that judged it:

- **`gate`** — the sealed campaign gate, parsed from its stdout by
  `scripts/cynco-gate-parse.mjs`:
  `{ sha, fails, passes, priorRegressions, suiteRegressions, harnessFault, terminator }`.
  `sha` is the HEAD the gate was run against; `fails` is an array of the FAIL
  LINES as strings, quoted verbatim (never paraphrased — the next wave's brief
  is generated from these strings); `passes` is the COUNT of PASS lines;
  `priorRegressions` is the head gate's prior-campaign-chain count (C8.9-style);
  `suiteRegressions` is the array of pytest node ids the suite gate found newly
  red against the campaign's standing-failure baseline; `terminator` is the
  gate's own last word (`PASS` / `MISS` / `null` when it printed none);
  `harnessFault` is `null` on a clean run and a short string when either the
  campaign gate or the suite gate could not be believed (timeout, traceback, no
  terminator, a suite gate refusing for want of a baseline). A row with
  `gate.harnessFault` set has `verified: null` — the gate measured nothing, and
  "not verified" would be a false claim about the work. The same patch writes
  `verified` and, when the mutation sweep produced a reading, `mutationSweep`.
- **`posiwid`** — the purpose-versus-behaviour reading for the wave, computed by
  `posiwidForRow` from `toolStats` against the campaign spec's stated shares:
  `{ divergence, verdict, dominantObserved }`. `divergence` is the KL divergence
  of the observed tool mix from the stated one and `dominantObserved` names the
  class the run actually spent itself on (`inspect`, `sourceEdit`, `commit`).
  `verdict` is one of four, in the order `posiwidDivergence` decides them
  (`engine/cybernetics-core/src/constraints/index.ts:249`): **`Insufficient`**
  — fewer than `minSupport` (50) observed calls, or none at all: no reading;
  **`Contradicted`** — the class the run spent itself on has a stated share of
  0 (it did something the purpose never mentions); **`Drifting`** — divergence
  above the threshold (0.1); **`Consistent`** — everything else. A campaign's
  stated shares are its own parameter (`posiwid.sourceEditShare` /
  `commitEvery` in the campaign spec), so `Drifting` is a reading against THAT
  declaration, not a universal one.

### The wave record's `governancePosiwid`

Not a ledger field — it lives on the campaign wave record
(`~/.cynco/campaigns/<id>/waves.jsonl`), computed from the graded ledger row —
but it is documented here because it is read off the same row and nothing else
describes it. `scripts/cynco-governance-posiwid.mjs` turns POSIWID on the
governance layer itself. `governanceCounts({ row, wave, proposalsDecided })`
gives three counts for the wave, and only these three names are ever used:

- **`denialsChanged`** — denials whose next call was NOT another look, i.e.
  the denial changed what the model did next (`denialRecords` in
  `scripts/cynco-triples.mjs`, summed over the records marked `changed`). Per
  spec ruling 10 this is deliberately weaker than "did the exact thing the
  denial asked for" — that is `complied`, which this count does not use.
- **`recommendationsConsumed`** — enforced S5 decisions (`s5Decisions[].enforced
  === true`), plus a followed ideation hypothesis, plus an applied
  `s4.workOrder`, plus proposals the operator decided this wave, plus
  `routing.entries[]` whose `nextCallClass` complied with what the route said.
- **`signalsLogged`** — everything the layer merely recorded: unenforced S5
  decisions and `controlSignals[]`. `turns[]` (status frames) are NOT a
  signal and are excluded (Phase 3 ruling 13) — a wave with many turns but no
  unenforced decisions or control signals logs zero.

`GOVERNANCE_PURPOSE` states `denialsChanged` 0.5 and `recommendationsConsumed`
0.5 and gives `signalsLogged` **no share at all**, so a wave the layer spent
logging reads `Contradicted` by construction — that is the point of the
measurement, not a bug in it. `GOVERNANCE_DRIFT.driftThreshold` is **0.5**
(the spec's naive 0.1 is amended): the zero-share bucket leaves the implicit
`other` mass a near-zero expectation and KL blows up on any logging at all, so
0.1 would call every real wave `Drifting` the moment it logged anything.

Every wave's counts are replayed through a fresh `PosiwidDrift` on each
verdict, so `onsetWave` is a function of the stored windows and a runner
restart cannot move it. `onsetWave` is the `wave` field of the window the drift
fired on, NOT its index: a campaign whose early waves were graded before this
measurement existed has no windows for them, so its first window can be wave 4,
and a wave that threw is never pushed at all. (Windows are 0-based inside
`PosiwidDrift`; the index is used only as a fallback, 1-based, when a stored
window carries no `wave`.)

The stored shape, below, is the synthetic smoke's second wave — counts
`2 / 1 / 30` after a first wave of `12 / 10 / 3` — and these are the module's
own numbers, not an illustration:

```jsonc
"governancePosiwid": { "verdict": "Contradicted", "divergence": 5.98,
  "dominantObserved": "signalsLogged", "support": 33, "onsetWave": 2,
  "windows": 2,
  "counts": { "denialsChanged": 2, "recommendationsConsumed": 1, "signalsLogged": 30 } }
```

`verdict`, `divergence`, `dominantObserved` and `support` are the LAST window's
reading — here 33 observations of which 30 were logging, so: past `minSupport`
20, and `signalsLogged` holds a stated share of 0, hence `Contradicted`. The
ladder is exactly the per-wave `posiwid` block's (`Insufficient` below
`minSupport` 20, then `Contradicted`, `Drifting`, `Consistent`). `onsetWave`
and `windows` are properties of the whole replayed history rather than of that
last window.

The campaign state keeps the raw windows under
`state.governancePosiwid.windows`; the verdict entry prints the reading as its
"Governance POSIWID" line, and `GET /api/campaign` hands the dashboard the last
wave's `verdict` and `onsetWave`.
`engine/__tests__/guards/ledgerGovernancePosiwidBlock.test.ts` re-runs the
module on this block's `counts` and fails if the reading moves (F149: a
documented number no code produces).

### The wave record's `autopoiesis`

Also not a ledger field — it lives on the campaign wave record and reads the
graded row beside everything else the VERDICT already holds. Phase 4 ruling 4:
`scripts/cynco-autopoiesis.mjs` `campaignAssessment` maps Maturana/Varela's six
criteria (the vendored core's `AutopoiesisAssessment`; `isAutopoietic` and
`missingCriteria` come from `engine/cybernetics-core` unchanged) to facts, never
to claims:

- **`hasBoundary`** — this wave's identity reading (`identity.intact`, the
  wave record's `identity`, `scripts/cynco-identity.mjs`).
- **`boundarySelfProduced`** — `spec.author === "cynco"`: the campaign's own
  gate-author seat wrote the bar. Every campaign up to c8 is `human`.
- **`internalProduction`** — this wave landed ≥ 1 commit.
- **`circularProduction`** — ledger → validation → proposal closed at least once
  in this campaign: a denial analysis ran (this wave or an earlier one) AND a
  cap proposal was ever raised from it (`facts.proposalFromDenials`: any
  proposal named `invariants/<cap>` — the one family the denial analysis itself
  raises; an `ideation/brief` or `gate-author/gate` promotion does not count),
  OR a brief carried the PACING "campaign to date" denial digest
  (`facts.pacingDigest`: any wave record's `s4.pacingFromDenials`, which the
  runner records from the brief generator's own `pacingDigestIncluded`
  predicate — never read off the brief's text).
- **`organizationallyClosed`** — the campaign's `ProductionNetwork` over
  `gate, brief, wave, ledger, validation, proposal, configuration, seat` is
  closed, given which productions occurred: seat→gate (CynCo-authored gate),
  brief→wave (≥ 1 graded wave), wave→ledger (≥ 1 campaign row),
  ledger→validation (a denial analysis), validation→proposal (a cap proposal
  raised), proposal→configuration (any approved), configuration→brief (an
  `invariantOverrides` entry, or a wave's `s4.workOrder.applied` — the runner
  writes `s4.workOrder` on every dispatched wave record from `workOrderFor`
  (`scripts/cynco-brief.mjs`), `{ applied, order }`, and `applied` is true only
  when the ideation seat is at its maximum authority AND its order actually
  moved a work item; an adopted wave records `workOrder: null`. Pinned by
  `scripts/__tests__/cynco-campaign.test.mjs` (the runWave record carries
  `rec.s4.workOrder`) and `cynco-brief.test.mjs` (`workOrderFor`). Phase 4's fix
  wave said nothing wrote the field; that was wrong, corrected in Phase 5
  Task 1),
  ledger→seat (gate-line or ideation evidence — the gate-lines summary is read
  ACROSS campaigns, not this campaign's lines only: the seat is one seat, so
  any campaign's graded gate lines close this edge; `facts.seatEvidence` can be
  true on a campaign with no lines of its own), configuration→seat (a seat's
  authority > 0, the retained seats store included).
- **`facts.commitsLanded`** — the runner's `commitsBetween`: `git log
  <base>..<head>` over the ledger row's `commitRange` (the dispatch BASE to the
  graded head), every commit in that range. It is NOT the driver's
  "N commit(s)" line, which counts `toolStats.commits` (the mission's
  commit-class Bash calls); the two are different instruments and may differ
  (3 vs 2 on the Phase 4 live s1 wave — the row counts from BASE).
- **`organizationMaintained`** — identity intact this wave AND on every
  earlier GRADED wave AND `identityGuard.passed === true` on every campaign
  row. Strict: a graded wave that predates the identity assertion, or a row
  whose engine never emitted the guard, is unread, and unread is not evidence
  of maintenance. Stop and fault records were never graded and are not
  readings.

The stored shape is the module's own output for a two-wave human-gated campaign
whose first row predates the guard (the facts below, re-run by
`scripts/__tests__/cynco-autopoiesis.test.mjs`):

```jsonc
"autopoiesis": {
  "criteria": { "hasBoundary": true, "boundarySelfProduced": false, "internalProduction": true,
                "circularProduction": true, "organizationallyClosed": false, "organizationMaintained": false },
  "isAutopoietic": false,
  "missing": ["boundarySelfProduced", "organizationallyClosed", "organizationMaintained"],
  "network": { "unproduced": ["gate", "brief", "configuration"],
               "productions": [["brief", "wave"], ["wave", "ledger"], ["ledger", "validation"],
                               ["validation", "proposal"], ["ledger", "seat"]] },
  "facts": { "gateAuthor": "human", "waves": 2, "rows": 2, "denialAnalysis": true, "proposalRaised": true,
             "proposalFromDenials": true, "proposalApproved": false, "configurationApplied": false, "seatEvidence": true, "seatAuthority": 0,
             "commitsLanded": 3, "pacingDigest": true,
             "identityHistory": { "waves": 1, "intact": 1, "rows": 2, "passed": 1 } } }
```

`missing` names the criteria by field, in the core's order; `facts` is
everything the reading was computed from, so a wrong mapping is fixed by
re-running `criteriaFromFacts(facts, identity)` over the stored facts and the
wave's stored `identity`, not by re-measuring. An
assessment that throws is stored as `{ "assessError": "<message>" }` and never
faults the wave. The verdict entry prints `- Autopoiesis: 3/6 — missing …`
(`6/6` when nothing is missing, `UNASSESSED — <message>` on a throw) into the
campaign log; `GET /api/campaign` hands the dashboard each wave's
`{ isAutopoietic, missing }` and the Campaign panel prints the last wave that
carries a reading (a later stop or fault record has none and is skipped);
`bun scripts/cynco-campaign.mjs <id>.campaign.json --autopoiesis` prints the
same checklist over a campaign that already ran, from its stored records, and
dispatches and writes nothing.

### Scoreboard

Not a ledger field either: the harness scoreboard (Phase 5 ruling 2) is
computed by `scripts/cynco-scoreboard.mjs` — one pure module, one spelling of
each definition, one exported function per definition — at every wave VERDICT
(stored on the wave record as `scoreboard`, printed as the entry's
`- Scoreboard:` line right after `- Autopoiesis:`) and by
`bun scripts/cynco-campaign.mjs <id>.campaign.json --scoreboard`. Per campaign
and pooled over RUNNER-DRIVEN campaigns (those with a
`~/.cynco/campaigns/<id>/waves.jsonl`; earlier hand-driven missions are
excluded and the exclusion is printed). The definitions, verbatim from the
spec (`docs/superpowers/specs/2026-09-26-evidence-engine-phase5-design.md`,
ruling 2):

- `passRatePerGpuHour` = decided-PASS campaigns (`pass` or `pass-with-survivors`) ÷ Σ `durationS`/3600 over every wave of every runner-driven campaign. Per campaign: `decision === PASS ? 1 : 0` ÷ that campaign's GPU-hours; an undecided campaign prints `open`.
- `wavesPerCampaign` = waves to the decision; undecided campaigns print `N so far (open)` and are excluded from the pooled mean.
- `gateLinesFixedPerLandedWave` = Σ over waves with ≥ 1 landed commit of max(0, failsBefore − failsAfter) ÷ the number of such waves, where failsBefore is the previous wave's `gate.fails.length` (wave 1: `calibration.baseFails.length`) and failsAfter is this wave's. A wave that graded no gate (fault) is excluded and counted.
- `humanInterventionsPerWave` = (operator notes delivered + proposals with `decidedBy` ≠ `auto` + supervisor refusals + reseals + `--adopt-inflight` records) ÷ waves. This is the stated PROXY for "supervisor minutes per wave": minutes are not recorded anywhere, so the count of human acts is what can be measured; the economics script's supervision dollars per wave print beside it.
- `perRulePrecision` = from `rule-verdicts.json`: predictive count ÷ total, and the single best rule with its precision, CI and verdict.

Unmeasured → `null` with the reason, never 0 (F16).

How each term is read off the records (the module's doc comments say the
same, next to the code):

- **Waves** are the SPENT wave records: every record in `waves.jsonl` except a
  `stop` (a refusal to dispatch spends nothing); a `fault` spent its wave and
  counts. **Decided** means the last spent wave's decision is `pass` or
  `pass-with-survivors`; `next`, `fault`, `budget` and `no-progress` are open —
  a budget stop is resumed with `--waves N` (C8's waves 1 and 2 both read
  `STOP (budget)`; wave 3 passed).
- **`durationS`** — the wave record's own (the runner writes `durationS` from
  the row from Phase 5 on), else the joined ledger row's. A FAULT record
  carries one too: the row's when the fault came after a row was read
  (`durationFrom: "row"`), else the wall clock since `dispatchedAt`
  (`durationFrom: "wall-clock"` — an upper bound: it includes waiting on a
  driver that may have died early); `null` only for a fault with no
  `dispatchedAt`. A wall-clock hour is counted, but it is a bound, not a
  measurement: the board names the wave in `gpuHoursUpperBound`, adds
  `gpuHours: wave N hours are a wall-clock upper bound (fault) — the rate is a
  floor` to `unmeasured`, keeps `passRatePerGpuHour` numeric with
  `passRatePerGpuHourIsLowerBound: true`, and every reader prints it as a floor
  — the entry line and the verb `PASS/GPU-h ≥ 0.065`, the dashboard row and the
  pooled line `≥` (pooled: the waves named `<id> wave N`). Fault records also carry a `scoreboard` reading, so the
  last board on the record never undercounts a trailing fault. A spent wave with
  neither (an older fault whose driver wrote no row) is named in `unmeasured` as
  `gpuHours: wave N has no durationS …` — the hours are then a floor, and a
  floor cannot be a denominator: `passRatePerGpuHour` is then null with
  `hours unmeasured for wave N` (pooled: `for <id> wave N`), never an
  overstated rate.
- **Landed commits** — the wave record's `outcome.commitsLanded`: the
  runner's `commitsBetween` count over the row's commit range (written from
  Phase 5 on; the same instrument as `facts.commitsLanded` above, NOT
  `toolStats.commits`). An older record reads `state.lastCommits.length` only
  when it is the wave the state last graded (the `--autopoiesis` reading);
  otherwise its commit count is unknown and the wave is excluded and named —
  never read as 0 commits. A null `gateLinesFixedPerLandedWave` says which it
  is: `no wave landed a commit` only when every graded wave has a known count
  of 0; otherwise `commit counts unknown`, `no known-count wave landed; N
  unknown`, or `every wave excluded — none graded a gate`.
- **Previous wave** for failsBefore is the previous GRADED wave: a fault in
  between graded nothing and does not reset it. A regression counts 0.
- **FAIL count** is `gate.fails.length` — the FAIL lines the gate printed and
  the record lists — never the terminator's own `failCount`. The two can
  disagree: the real C8 wave-1 record carries `failCount 10` (`MISS (10
  fails)`) beside 6 FAIL + 11 PASS lines of 17 and no ERROR line, so 10 is
  not a count of anything on the record. `fails.length` is the internally
  consistent reading (6 FAIL + 11 PASS = the 17 graded lines), it is what
  `decide()` and the brief's THE MISSES read, and it is the one the board
  takes.
- **Operator notes delivered** — this campaign's rows' `operatorNotes[]` with
  `deliveredAtIteration` set AND `source === "operator"`. The driver's
  re-injected probe (`source: "driver"`) is not a human act; a delivered note
  with `source: null` is unknown (see `operatorNotes` above: "never as
  operator"), is not counted, and is named in `unmeasured`.
- **Proposals with `decidedBy` ≠ `auto`** — `approved`/`rejected` proposals
  only (a pending one was decided by nobody). Only a `gate/<id>` seal at earned
  authority writes `decidedBy: "auto"`; the operator's `--approve-proposal` /
  `--reject-proposal` on an `ideation/`, `gate-author/` or `invariants/`
  proposal writes no `decidedBy` at all and IS a human decision.
- **Supervisor refusals** — every `state.authoring.<id>.refusals[]` entry.
  **Reseals** — `state.reseals[]`.
- **From the seal** (Phase 6 ruling 8; C9 counted its two AUTHORING-phase
  refusals as 1.00 intervention per wave, F164) — when the campaign's own
  authoring record carries `sealedAt` (`state.authoring[<spec.id>].sealedAt`,
  written by `sealGate` for a CynCo-authored gate), a refusal whose `at`, or a
  proposal decision whose `decidedAt`, is before it is an authoring-phase act:
  it shaped the gate, not a wave, and is NOT counted. The board names how many
  in `unmeasured` (`humanInterventionsPerWave: N act(s) before the seal (<sealedAt>)
  not counted — …`, pooled with the campaign id). An act with no readable date
  cannot be placed after the seal, so it IS counted and named (`N act(s) carry
  no date — counted …`) — never silently dropped. Reseals, notes and adoptions
  happen to waves and are post-seal by construction. A campaign with no seal
  record (a human-sealed gate) counts every act, as before.
- **`--adopt-inflight` records** — wave records with `adopted: true`. The
  runner writes it from Phase 5 on for every wave it graded from an adopted row
  (`--adopt-inflight`, or `scripts/cynco-campaign-adopt.mjs` — both are the
  operator handing a wave over) and for the fault `--adopt-inflight` records
  when the driver wrote no row. Earlier records carry no mark, so adoptions
  before Phase 5 are not counted.
- **Rules** — the S5 rules only: entries of `rule-verdicts.json` whose
  `source` is not `"model"`. The learner's `M1.*` rows (see "Outcome hindcast
  and the `M1.*` rows" below) share the file and the Holm family but are not
  rules — the engine never grants them authority — so they are neither in
  `predictive`/`total` nor ranked for `best`. The best of them, ranked the same
  way, is the sibling field `perRulePrecision.learner`
  (`{ id, precision, ci, verdict }`, null when the file has no `M1.*` row); the
  verdict line appends `| learner M1.gbt 50% NO EVIDENCE` and the verb prints a
  `learner …` line with its CI.
- **Best rule** — a `PREDICTIVE` rule first; then a rule with enough evidence
  to be read (not `TOO FEW`); then the highest precision; ties by id. The
  verdict line prints `best I3 58% NO EVIDENCE` (precision as a whole percent,
  the verdict's head before any ` — `); the verb prints the Wilson CI and the
  whole verdict.
- **Supervision dollars per wave** — the `$N SUPERVISING` figure of the
  economics script's `VERDICT:` line ÷ waves. The script prices the WHOLE
  supervision history, not one campaign, and the verb prints that scope beside
  the number. It is not on the verdict line. Both readers (every VERDICT and
  `--scoreboard`) spawn the script through `scoreboardEconomics`
  (`scripts/cynco-campaign.mjs`): `runSync` capped at `ECONOMICS_TIMEOUT_MS`
  (120 s); a timeout, fault or non-zero exit is null — `no economics line (the
  economics script did not run)` — never an empty reading.
- **Pooled** ratios are Σ numerator ÷ Σ denominator over the included
  campaigns' waves (not a mean of per-campaign ratios), through the SAME
  functions the campaign board uses (`ratePerGpuHour`, `perWave`,
  `linesFixedReason`); `wavesPerCampaign` is the mean over decided campaigns;
  `passRatePerGpuHour` is null until one campaign has decided, and null while
  any included wave's hours are unmeasured. Every campaign's per-wave
  exclusions (hours, lines fixed, unknown-source notes) reach the pooled
  `unmeasured`, prefixed with the campaign id. A board that threw or spent no
  wave is excluded and named, as is every campaign dir without a `waves.jsonl`
  and the count of ledger missions no runner-driven wave record names.

The stored shape (unrounded on the record; rounded here), for C8 reproduced from the campaign log (the fixture
`scripts/__tests__/fixtures/scoreboard/`, pinned by
`scripts/__tests__/cynco-scoreboard.test.mjs`):

```jsonc
"scoreboard": {
  "id": "c8", "decided": true, "decision": "pass", "waves": 3, "gpuHours": 15.3656, "gpuHoursMissing": [],
  "gpuHoursUpperBound": [],
  "passRatePerGpuHour": 0.06508, "passRatePerGpuHourIsLowerBound": false, "wavesPerCampaign": 3,
  "gateLinesFixedPerLandedWave": { "value": 4.667, "landedWaves": 3, "fixed": 14,
                                   "graded": 3, "known": 3, "unknown": 0, "reason": null },
  "humanInterventionsPerWave": { "value": 0.333, "notes": 1, "humanDecisions": 0, "refusals": 0,
                                 "reseals": 0, "adopted": 0, "reason": null },
  "perRulePrecision": { "predictive": 0, "total": 8,
                        "best": { "id": "I3", "precision": 0.58, "ci": [0.45, 0.70], "verdict": "NO EVIDENCE" },
                        "learner": null },
  "supervisionDollars": 4295.55, "supervisionDollarsPerWave": 1431.85,
  "unmeasured": [] }
```

and the entry line
`- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% NO EVIDENCE)`
(`PASS/GPU-h open | waves 2 so far (open)` while a campaign is undecided;
`null (<reason head>)` for anything unmeasured — the reason cut before its
first ` — ` or ` (`, at most 32 characters; the full reason is in
`unmeasured`). The line is capped at 200 characters (`ENTRY_LINE_MAX`): past
it the reasons are dropped and a bare `null` stays; if even that is over, the
learner's verdict is dropped too. A board that throws is stored as
`{ "error": "<message>" }`, prints `- Scoreboard: UNMEASURED — <message>`, and
never faults the wave. `--scoreboard` prints the campaign's line, one line per
definition with its parts and every `unmeasured` reason, then the pooled board
and its exclusions; it dispatches nothing, takes no lock and writes nothing
(exit 2 with the reason when the campaign has no state).

### The wave record's `gate.author`

Also not a ledger field: the wave record's `gate` block is the grader's reading
(`terminator`, `fails`, `passes`, `failCount`, `errors`, `priorRegressions`,
`harnessFault`, `exit`) plus one field the runner adds beside it —

- **`gate.author`** — `"cynco"` or `"human"`: who WROTE the bar this wave was
  judged against, copied from the campaign spec's `author` (`loadCampaignSpec`
  defaults it to `"human"`, which is what every campaign up to c8 was). Nothing
  in the grading reads it. It exists because a held gate line has to be
  attributable to the seat that sealed it — without the author on the record,
  the gate-lines dataset below has a numerator and no denominator.

### Gate lines dataset

`~/.cynco/datasets/gate-lines.jsonl`, written by `scripts/cynco-gate-lines.mjs`
at every wave verdict and readable as a table with
`bun scripts/cynco-signal-validation.mjs --gate-lines`.

**The evidence unit is the graded gate LINE, not the campaign.** A campaign is
one draw, and at one campaign every few weeks a gate-authoring seat would earn
its authority somewhere around 2030. A gate line is one falsifiable claim, and
one campaign ships 9–17 of them.

One row per (campaign, graded line). Both of these are real rows, copied out of
an export run against `~/.cynco/campaigns` — the first from c8's state dir, the
second from the history file:

```jsonc
{ "campaign": "c8", "author": "human", "sealedAt": "2026-09-17T10:55:46.162Z",
  "lineId": "C8.1a.tiers-pressable", "outcome": "held", "resealedAtWave": null,
  "firstPassWave": 3, "decided": true, "source": "runner" }
{ "campaign": "c7", "author": "human", "sealedAt": null,
  "lineId": "C7.3.branching", "outcome": "resealed", "resealedAtWave": null,
  "firstPassWave": null, "decided": true, "source": "history" }
```

- **`outcome`** is one of three:
  - **`held`** — the campaign reached a decision and nothing rewrote the line.
    The bar the author sealed is the bar the campaign was judged against.
  - **`resealed`** — the line's printed text changed, or it appeared, or it
    vanished, after the calibration that sealed it. A `resealed` line is the
    failure this dataset exists to catch: a "pass" against a line somebody
    rewrote mid-campaign proves nothing about the line that was sealed.
  - **`open`** — the campaign has not reached a decision yet. Not evidence
    either way, and excluded from every rate below.
- **`sealedAt`** — when this campaign's gate was sealed: the authoring record's
  own stamp (`state.authoring[<id>].sealedAt`) for a CynCo-authored campaign,
  and the campaign's first calibration (`state.calibration.calibratedAt`) for a
  human-sealed one, which has no authoring record because a human seals by
  writing the triple into the sealed tree by hand and nothing records the
  moment. `null` for a history row that does not state one, and for a campaign
  that has never calibrated.
- **`decided`** — the campaign's last wave record carries a decision it does
  not come back from: `pass`, `pass-with-survivors`, `budget` or `no-progress`.
  `fault` and `stop` are refusals to measure rather than readings, and `next`
  is a campaign still running.
- **`resealedAtWave`** — the wave count when the FIRST reseal that touched this
  line was recorded (a line reworded twice moved at the first rewrite);
  `firstPassWave` — the first wave whose `gate.passes` carried the id.
- **`source`** — `runner` (read from `~/.cynco/campaigns/<id>/`) or `history`
  (`docs/civkings-redesign-briefs/gate-lines.history.json`, the hand
  transcription for campaigns that ran before the runner did). A campaign in
  both is taken from the runner and skipped in the history; counting it twice
  would double its lines in the denominator.

Reseals are recorded by the runner at CALIBRATE time, from the calibration it
is about to overwrite (`recordReseal` in `scripts/cynco-campaign.mjs`,
`resealRecord` in `scripts/cynco-gate-lines.mjs`), and they live on the campaign
state as `state.reseals`. The comparison is over the printed line TEXT, not the
id set, because the id is a label and the text is the claim. That OVER-MARKS: a
FAIL line's detail is printed from the run, so a line whose detail quotes a
count reads as changed when the assertion behind it did not move. The error is
deliberately in that direction — an over-marked line counts against the author,
never for them.

`summarize` folds the terminal rows into a held rate per author with a Wilson
interval and a Fisher 2×2 (held × author, CynCo row first). The verdict entry
prints it as its "Gate lines" line, and `gateAuthorPromotion`
(`scripts/cynco-gate-author.mjs`) reads the same summary: ≥ 30 terminal CynCo
lines, a Wilson lower bound ≥ 0.8, and not significantly worse than the human
seat, raises the `gate-author/gate` proposal. Both thresholds are stated once,
in `scripts/cynco-signal-validation.mjs` beside `DENIAL_MIN`.

### Gate outcomes dataset

`~/.cynco/datasets/gate-outcomes.jsonl`, written by `exportGateOutcomes` in
`scripts/cynco-gate-lines.mjs` at every wave verdict (right after the gate-lines
export, with the same rule: derived, rebuilt in full, a failure is logged and
never faults the wave), and printed as the GATES table after the lines table by
`bun scripts/cynco-signal-validation.mjs --gate-lines`.

**The unit is the campaign, because the seal is a campaign-level event.** The
gate-lines dataset cannot see a gate that never sealed: a triple the supervisor
refused has no calibration on the campaign, so it has no graded lines and no
rows, and "the seat's lines held 30/30" reads the same whether zero or five of
its gates were refused on the way. This dataset is the denominator the lines
leave out.

One row per campaign. All three are real rows, copied out of an export run
against `~/.cynco/campaigns` plus the history file on 2026-09-25 (c8's and c7's
`refusals` read `0` in that run and are shown as the exporter writes them since
the final fix wave: `null`, unmeasured — neither has an authoring record):

```jsonc
{ "campaign": "c8", "author": "human", "outcome": "held", "refusals": null, "attempts": null, "sealedAt": "2026-09-17T10:55:46.162Z" }
{ "campaign": "c9", "author": "cynco", "outcome": "refused", "refusals": 1, "attempts": 9, "sealedAt": null }
{ "campaign": "c7", "author": "human", "outcome": "resealed", "refusals": null, "attempts": null, "sealedAt": null }
```

- **`outcome`** is one of four:
  - **`refused`** — at least one supervisor refusal
    (`state.authoring[<id>].refusals[]`, `{ at, by: 'supervisor', notePath }`)
    and no seal.
  - **`sealed`** — sealed; the campaign has not reached a decision yet.
  - **`held`** — sealed, decided (the same `decided` as the gate-lines rows),
    and never resealed.
  - **`resealed`** — sealed, with at least one record in `state.reseals`
    (decided or not). Any reseal record counts, including one whose
    `changedLineIds` is empty: the gate was rewritten under a running campaign,
    which is the event. For a history row, a non-empty `resealed` list.

  A gate neither sealed nor refused (staged, still being authored) is not an
  outcome yet and has no row. A refusal followed by a seal reads by its seal
  (`sealed` / `held` / `resealed`), with the `refusals` count kept.
- **`author`** — the wave record's `gate.author` when a wave carries one;
  otherwise `cynco` when the state holds an authoring record for the campaign
  and `human` when it does not. (Presence, not `sealedAt`: a refused gate never
  sealed, and the gate-lines rule would call the seat's refusal a human's.)
  History rows carry their own `author`.
- **`refusals`** — the count of supervisor refusals in
  `state.authoring[<id>].refusals[]`; `0` only when an authoring record exists
  and holds none; `null` — unmeasured, never a zero — for a campaign with no
  authoring record (a human-sealed state) and for every history row (a
  hand-transcribed campaign has no refusal record). The GATES table prints `—`. **`attempts`** — `state.authoring[<id>].attempts`, the
  authoring dispatches; `null` where there is no authoring record.
- **`sealedAt`** — as in the gate-lines rows: the authoring record's stamp, else
  the first calibration, else `null`.

A campaign in both the state dir and the history file is the runner's, exactly
as for the gate lines.

### Rule verdicts file

`~/.cynco/datasets/rule-verdicts.json`, written by
`scripts/cynco-rule-verdicts.mjs` (`writeRuleVerdicts`) at every wave VERDICT
from the WHOLE ledger — not the campaign's slice, because a rule's predictive
power is a claim about every mission it fired on. `bun
scripts/cynco-rule-verdicts.mjs [--ledger-dir DIR] [--out PATH] [--with-hindcast]
[--datasets-dir DIR] [--manifest PATH] [--campaigns-dir DIR]` rebuilds the
rules by hand and prints `rule verdicts vN: P predictive of R rules (+M model
rows) (+K runner rows) (…) → <path>` — rules, model rows and runner rows
counted apart, as the scoreboard's `N/8` reads them. Every run builds the
runner row `R1.no-progress` from the campaigns' wave records exactly as a
VERDICT does, over `--campaigns-dir DIR` (default `<cyncoHome>/campaigns`). `--with-hindcast` rebuilds what a VERDICT writes: the runner's
own sequence (`exportOutcomeDatasets` → `runHindcast` → `hindcastOf` →
`modelRowsFrom` → `writeRuleVerdicts`, `scripts/cynco-hindcast.mjs`), printing
the `- Outcome hindcast:` line first (a fault is `UNMEASURED` and the rules are
written without model rows, as at a VERDICT). `--datasets-dir DIR` writes the
three datasets, `outcome-model.json` and — unless `--out` names another path —
`rule-verdicts.json` directly into DIR instead of `~/.cynco/datasets/`, so a
temp run WRITES nothing under the real home; it still READS
`<cyncoHome>/campaigns` for the runner row unless `--campaigns-dir DIR` names
another campaigns dir (Task 4 review N1). With `--datasets-dir DIR` and no
`--manifest PATH`, the per-version holdout manifest is `<DIR>/frozen-eval.json`
(final review M8): a temp run never performs the one-time v2 freeze on the
repo's committed `benchmark/cynco-ledger/frozen-eval.json`; without
`--datasets-dir` it reads (and may freeze into) the committed one, as the
runner does. It is Step 2's per-rule table (`analyse` + `ruleVerdictOf` in
`scripts/cynco-signal-validation.mjs`) turned into a file the engine reads:

- **`engine/s5/ruleAuthority.ts`** loads it once per session and logs one line,
  `[s5] rule authority: earned (<n> predictive of <m>)` or
  `[s5] rule authority: legacy (no verdict file at <path>)`. A decision is
  `earned` only when every rule in its `ruleIds` reads exactly `PREDICTIVE`;
  otherwise it is `advisory` and is never applied. No file = `legacy`, and
  `LOCALCODE_S5_ENFORCE` alone decides, exactly as before. The reading is
  carried on the ledger as `s5Decisions[].authority`.
- **`engine/s5/exportTrainingData.ts`** keeps only `earned` decisions in the S5
  training corpus when the file exists, and reports what it dropped per rule.

Schema 1. The numbers below are the head of a real rebuild against this
ledger on 2026-09-25 (280 records, 107 labeled; two of its eight rules are
shown — C2, C4, W6 read `TOO FEW`, I1, I3, W7, W8 `NO EVIDENCE`, I4 `CONSTANT`):

```jsonc
{ "schema": 1, "version": 1, "at": "2026-09-25T18:47:26.981Z", "campaign": null,
  "ledger": { "total": 280, "labeled": 107, "failures": 61, "base": 0.5700934579439252, "rulesTested": 7 },
  "rules": {
    "C2": { "verdict": "TOO FEW — cannot tell", "precision": 0.2,
            "ci": [0.036223160969787456, 0.6244717358814612], "p": 0.16249100754494467, "n": 5,
            "pAdjusted": 1, "lift": -0.3700934579439252, "firedTotal": 17, "failures": 1 },
    "I1": { "verdict": "NO EVIDENCE", "precision": 0.5490196078431373,
            "ci": [0.4138447154164923, 0.6773269498886776], "p": 0.6999222665344511, "n": 51,
            "pAdjusted": 1, "lift": -0.021073850100787883, "firedTotal": 106, "failures": 28 }
  },
  "predictive": [],
  "history": [ { "version": 1, "at": "2026-09-25T18:47:26.981Z", "campaign": null, "predictive": [],
                 "changed": [ { "id": "C2", "from": null, "to": "TOO FEW — cannot tell" } /* + the other seven rules */ ] } ] }
```

- **`rules[<id>]`** — `{ verdict, precision, ci, p, n }` plus `pAdjusted`
  (Holm), `lift`, `firedTotal`, `failures`: `n` is the labeled missions the rule
  fired on, `precision` the failure share among them, `ci` its Wilson 95 %
  interval. The engine reads only `verdict`.
- **`at`** — when this write happened (every write, not only a version bump).
- **`rules[<id>].verdict`** — exactly `ruleVerdictOf`'s string: `PREDICTIVE`,
  `TOO FEW — cannot tell`, `CONSTANT — fires on everything, predicts nothing`,
  `INVERTED — fires more on successes`, `NOT AFTER CORRECTION — chance across
  this many rules`, or `NO EVIDENCE`. Only `PREDICTIVE` earns authority. A rule
  the file does not list has never fired in the ledger and has earned nothing.
- **`version`** rises only when the verdict SET changed — a rule's verdict
  moved, or a rule appeared or vanished. The numbers are refreshed on every
  write; the version counts changes in what S5 may enforce. The learner's
  `M1.*` rows (`source: "model"`) are outside that set: one appearing,
  vanishing (a hindcast that faulted this wave) or moving never bumps it.
- **`history`** — the last 20 entries, each naming the rules that moved
  (`changed`: `from`/`to`, `null` for appeared/vanished). A model row that moved
  is named in the entry's `modelChanged` (same shape) — on the version-bump
  entry when a rule moved in the same write, else on an entry of its own at the
  UNCHANGED version — so an `M1` reaching `PREDICTIVE` is on the record.
- **`campaign`** — the campaign whose VERDICT wrote it (`null` from the CLI).

The wave record carries `ruleVerdicts: { version, predictive, total }` (`null`
when the write failed — logged, never a fault). On this ledger no rule is
`PREDICTIVE`, so once the file exists every S5 decision reads `advisory`.

### Signals version (F165)

Phase 6 ruling 4. Two per-turn signals measured something other than their
names on every row before 2026-09-29, so every turn now says which instrument
wrote it: `turns[].signalsVersion` (the `governance.status` frame's
`signalsVersion`; a frame without one is **1**, written by
`scripts/cynco-ledger.mjs`, pinned by
`scripts/__tests__/cynco-ledger-signals-v2.test.mjs`).

| field | v1 (every row before F165) | v2 |
|---|---|---|
| `consecutiveUnstable` | the turn index: the homeostat never read stable in a mission (C9 wave 1: 1…394, monotone) | turns in a row the homeostat read unstable; 0 on a stable turn; capped at 50 |
| `algedonicAlerts` | non-Info alerts on the engine-wide bus since the engine started (21 by the end of C9 wave 1) | the same alerts raised in the last 20 turns |
| `algedonicAlertsTotal` | `null` (absent) | the cumulative count v1 called `algedonicAlerts` |

`stuckTurns` keeps its meaning in v2 — see F165's second paragraph for why it
read 0 on C9 while the read-loop gate denied 5 times.

v1 and v2 rows never mix silently. `scripts/cynco-outcome-dataset.mjs` writes
`signalsVersion` on each dataset row — the MINIMUM over the prefix's turns, so
a prefix that straddles an engine upgrade is v1 — and `--export
--signals-version N` keeps only version-N rows (the rest are counted:
`N other signals version`). A v2 row has one more feature than a v1 row,
`algedonicAlertsTotal.rate` (the v1 quantity, new alerts per turn); the key
lists are `FEATURE_KEYS_V1` (56) and `FEATURE_KEYS_V2` (57), and the leak tests
pin both. At K ≤ 20 — the primary K = 16 included — `algedonicAlertsTotal.rate`
equals `algedonicAlerts.rate` exactly: before 20 turns have passed the window
has not dropped anything, so the windowed count is the total minus a constant
(the bus count when the governor was built) and the two rates coincide. They
differ only at K = 32, where alerts from turns 1–12 have aged out of the
window. The feature stays: it is the v1 quantity by name, and at K = 32 it is
the one that still reads "new alerts per turn".
`scripts/cynco-outcome-model.py --signals-version N` trains and scores only
version-N rows and writes `signalsVersion: N`, `rowsByVersion` (eligible
missions per version, before filtering — from `--rows-by-version` when the
caller passes its own count) and `secondary.otherSignalsVersions` — per
left-out version, `{ eligible, failures, successes, holdout }`; its refusal
ends with ` (signals vN: n eligible; v1: m)`. Without the flag it uses every
row (`signalsVersion: null`, `secondary` unchanged).

**The runner's hindcast trains on ONE version (fix round 1, review I1).**
`scripts/cynco-hindcast.mjs` (`HINDCAST_SIGNALS_VERSION = 2`, the engine's
current version) writes only v2 rows into all three datasets (K = 16, K = 32,
hindsight), names held-out missions of another version in
`split[K].otherVersion` (never as `missing`), and runs the model with
`--signals-version 2 --rows-by-version {…}`. `outcome-model.json` and the wave
record's `hindcast` summary carry `signalsVersion` and `rowsByVersion`. The
learner rows read UNMEASURED with the reason — never a rate from a mixed or
too-small set (F16) — in three stages:

1. **No v2 mission eligible**: python is not spawned; `no eligible labeled
   mission at K = 16 turns with signals v2 (eligible by version: v1: 104) —
   nothing to train on`.
2. **v2 missions, no v2 holdout yet** (fix round 2, review N1): the holdout is
   per signals version (below), and v1's 21 frozen ids are no use to a v2
   learner. Until v2's eligible pool reaches `FREEZE_MIN_ELIGIBLE` = 38 —
   the smallest pool whose 20 % draw leaves the model its own minimums
   (holdout 8, train 30) — python is not spawned and the reading is
   `v2 holdout not yet frozen (12 of 38 labeled; eligible by version: v1: 104, v2: 12)`.
   `rec.hindcast.holdout` is `{ frozen: false, eligible, needed }`. A pool of
   38 or more with fewer than `MODEL_MIN_HOLDOUT` (8) of EITHER label is not
   frozen either (Task 2 review N4: a holdout drawn from a one-class pool can
   never give an AUC, and a frozen set only grows by a hand `--refreeze`):
   `v2 holdout not yet frozen (pass 0 / fail 38; need 8 of each; eligible by
   version: v2: 38)`, with `holdout` `{ frozen: false, eligible, needed, pass,
   fail, needEach }`.
3. **The first export that sees 38 with 8 of each label** freezes v2's set,
   ONCE, with Phase 5's `freezeManifest` over the v2 rows (seed
   `AUTO_FREEZE_SEED` 20260929) into `frozen-eval.json`, and records
   `{ signalsVersion: 2, frozenAt, count, eligible, seed, how: 'auto' }` on the
   file's `history`. That wave's `rec.hindcast.holdout` reads `{ frozen: true,
   frozenNow: true, frozenAt, ids }` (it rides the success path too) and its
   learner line ends `; v2 holdout frozen now (8 ids)` (Task 2 review N3); a
   later wave's reads `frozenNow: false` and names nothing. From then on the
   set never changes (frozen means frozen) and a refusal is the model's own
   TOO FEW with the per-version counts.

`rec.hindcast` carries `signalsVersion` and `rowsByVersion` on a fault too.
The verdict entry's learner line names both: `- Outcome hindcast: v5 at K = 16
turns, signals v2 only (eligible v1 104, v2 40) on 9 held-out missions …`.
Pinned by `scripts/__tests__/cynco-hindcast-signals.test.mjs` and the two
F165 VERDICT tests in `scripts/__tests__/cynco-campaign.test.mjs`.

**The holdout per signals version (fix round 2).** `frozen-eval.json` holds
one set per signals version: `{ schema: 2, sets: { "1": <Phase 5's v1
manifest, verbatim>, "2": … }, history: [ … ] }`, each set exactly what
`freezeManifest` returns. The committed Phase 5 file (schema 1) IS v1's set:
`manifestSets` reads it as `sets["1"]` byte-for-byte and it is migrated on the
first write, never re-drawn. `--freeze --signals-version N` freezes version
N's set from version-N rows only and refuses when it exists;
`--refreeze --signals-version N` only adds to an existing one (Phase 5's two
rules, per set). Without `--signals-version` on a schema-1 file both behave
exactly as in Phase 5. `scripts/cynco-outcome-model.py` reads the set of its
`--signals-version` (version 1 without the flag). The automatic freeze writes
the committed file in the working tree, and the runner commits it with that
wave's verdict (the verdict commit stages every changed path under
`benchmark/cynco-ledger/`, `ledgerShardsTouched` in
`scripts/cynco-campaign.mjs`); a freeze made by the CLI is committed by the
operator like any other ledger change.

**S5 rules that read a v2-changed signal (fix round 1, review I2).** W5 and I2
(`engine/s5/ruleBasedS5.ts`) fire on the homeostat streak, which in v1 was the
turn index — so in every v1 mission W5 fired from turn 3 on and I2 on turns
1–2. `scripts/cynco-rule-verdicts.mjs` scores `V2_CHANGED_RULES` on v2
missions only: `rules.W5 = { …, signals: 'v2', scopeN, v1: { n, firedTotal,
failures, precision, ci, p, lift, scopeN } }` — the v1 table rides beside the
verdict and is never pooled into it. Every other rule pools as before; Holm
runs once over all rules; `ledger.v2Rules` lists the split ids when any fired.
See F165.

### Outcome dataset and the frozen holdout

Phase 5 ruling 5: the prerequisites for the first learner. Built by
`scripts/cynco-outcome-dataset.mjs` (pinned by
`scripts/__tests__/cynco-outcome-dataset.test.mjs`).

**Dataset.** `bun scripts/cynco-outcome-dataset.mjs --export [--turns 16]
[--out PATH] [--ledger-dir DIR]` writes JSONL to
`~/.cynco/datasets/outcome-dataset.jsonl` (via `cyncoHome()`), one row per
mission that is LABELED (`labelOf` from `scripts/cynco-signal-validation.mjs`,
the "Labeling rule" below, imported — never restated) and has at least K
turns. Unlabeled and short missions are counted and printed, not written, and
so is every categorical value outside the vocabulary
(`unknown categorical values: health.<v> ×n`, from `datasetRows(...).unknownValues`).
`--fraction` is refused (see the leak rule). Row shape (`featuresOf(row, K)`;
the values are c7 wave 5's real row at K = 16 — a TRAINING mission, since
holdout rows are not quoted — features elided):

```jsonc
{ "missionId": "c7-wave5-1788613255404", "prefixTurns": 16,
  "signalsVersion": 1,       // F165: min over the prefix's turns (1 when absent)
  "label": true,             // labelOf: true = success, false = failure
  "features": { "toolSuccessRate.mean": 0.996875, "algedonicAlerts.rate": 0.06666666666666667,
                "consecutiveUnstable.max": 16, "…": "…" },
  "leakGuard": true }
```

The prefix is the first K entries of `turns[]` by index, at two fixed points:
**K = 16** (primary, the default) and **K = 32** (secondary). A mission with
fewer than K turns is EXCLUDED at that K, never truncated. `prefixTurns` is row
metadata (it is the constant K), not a feature. The feature keys of a v1 row
are EXACTLY these 56 (`FEATURE_KEYS_V1`; a v2 row adds `algedonicAlertsTotal.rate`
— "Signals version (F165)" above; the test asserts both sets, so adding one is
a change to this list and the test together):

- For each LEVEL signal — `toolSuccessRate`, `varietyRatio`,
  `varietyWindowed`, `taskError`, `infoGain`, `progressRate`,
  `axiomViolations` (= `axiomHealth.violations.length`), `toolEntropyMean`,
  `toolEntropyMax` (= `brain.toolEntropy.mean`/`.max`): `<name>.mean`,
  `<name>.last`, `<name>.max` over the prefix's non-null values (27 keys).
- The three COUNTERS, as per-turn rates so nothing sums over turns:
  - `stuckTurns` (the current stuck streak; it resets): `.rate` = the share of
    prefix turns with a streak > 0, `.last`, `.max`.
  - `algedonicAlerts` — v1: alerts fired so far IN THE ENGINE SESSION, a
    running count; v2 (F165): the alerts raised in the last 20 turns.
    `.rate` only = (last − first) ÷ (turns between them; null with fewer than
    two values): on v1 new alerts per turn, on v2 the change in the 20-turn
    window per turn (the same number at K ≤ 20 — see "Signals version"). Its v1
    level carries alerts from before the mission began (turn-0 values 0–57,
    r −0.38 with total turns — an era confound), so `.last`/`.max` were dropped
    (final review T4-N2): measured from the prefix's first value they collapse
    onto `.rate` at a fixed K, and unmeasured from it they are the confound.
  - `consecutiveUnstable` — v1: the turn index (the homeostat never read
    stable, so it incremented on every turn); v2 (F165): turns in a row the
    homeostat read unstable, 0 on a stable turn, capped at 50. `.last`, `.max`
    only — on v1 its mean tracks the turn index, so it is not a feature.
- `.last` is the last non-null value in the prefix. Every numeric feature is
  `null` when every value in the prefix is null — unmeasured is never 0 (F16).
- `brainPresent` — 1 when any prefix turn carries a numeric tool entropy, else 0.
- One-hots from turn K−1 (the last prefix turn), all zeros when that turn has
  no value or one outside the vocabulary (counted, above): `errorTrend.{rising,flat,falling}`,
  `explorationState.{healthy_exploration,thrashing,floundering}`,
  `health.{healthy,warning,critical}`,
  `s3s4Balance.{balanced,s3_dominant,s4_dominant,critical}`,
  `varietyBalance.{balanced,underload,overload,critical}`,
  `commander.{S1,S2,S3,S4,S5}` (from `heterarchy.commander`).

**The leak rule.** A feature may be built only from what was observable at
the end of the prefix. Whole-mission fields — `verified`, `outcome`,
`mutationSweep`, `toolStats`, `durationS`, `exitReason`, `commits`,
`identityGuard`, `regulatorFidelity`, `posiwidLive`, `s5Decisions`,
`invariants`, `routing`, `brainStats`, `ultrastable` — are written after the
run and describe the outcome after the fact; none of them is, or prefixes, a
feature key. `featuresOf` reads `turns[]`, `missionId` and the label and
nothing else; the leak test plants those fields on a row and checks the keys.

The mission's LENGTH is the second leak, and the reason the prefix is a fixed
K. The first cut took the first 50 % of the turns; a prefix of `floor(n/2)`
turns is as long as the finished run says, failures run longer (a median of
169 turns against 95.5), and `consecutiveUnstable.max` correlated 1.000 with
the prefix length (AUC 0.649 for failure from length alone) — Task 4 review I1.
So: a fixed K, no truncated prefixes, no feature that sums over turns, and a
second leak test that feeds a row whose every signal is constant and requires
every non-null feature to be identical at K = 16 and K = 32 — no feature is a
function of the turn index.

**The frozen holdout.** `benchmark/cynco-ledger/frozen-eval.json` —
`{ schema: 1, version, seed, frozenAt, missionIds }` — names the missions no
learner trains on. Invariants:

- **Frozen once.** `--freeze --seed N` writes it and refuses when the file
  exists. Only `--refreeze --seed N` writes another version (`version + 1`),
  and it keeps EVERY previous id — a refreeze only adds, topping each label up
  to its share of the grown ledger. Later-labeled missions otherwise join the
  training split.
- **20 %, stratified, whole missions.** 20 % of the eligible missions (labeled,
  ≥ K turns, K = 16 unless `--turns` says otherwise) rounded to nearest, split
  across failure/success in proportion, at least one of each when both exist;
  drawn by a mulberry32 shuffle of the id-sorted candidates.
- **Never silently shrinks.** `frozenSplit(rows, manifest, { turns: K })`
  returns `{ train, holdout, missing, ineligible }`; a manifest id that matches
  no row is reported in `missing`, and a held id whose mission is not eligible
  at K (unlabeled, or fewer than K turns) leaves both splits and is reported in
  `ineligible` — never dropped silently, never moved into training.

**v1 and the draw streams (review M4).** v1 was frozen on 2026-09-26 with seed
20260926 by the first cut of the module (commit f49b00f): eligibility was
labeled and ≥ 4 turns, and both labels were drawn from ONE shared mulberry32
stream. It is NOT regenerated — its 21 ids are the frozen holdout, and
reproducing it from its seed requires that commit's code. From v2 on, each
label draws from its own stream (`seed ^ <per-label constant>`), so adding a
mission of one label never changes which missions of the other label a draw
picks (pinned by a test), and eligibility is ≥ K turns.

v1 over the 280-row ledger: 107 labeled (61 failures); the holdout holds
**21** missions — 12 failures, 9 successes. Per prefix point:

| K | eligible (fail / success) | excluded short | holdout (fail / success) | ineligible held ids | train (fail / success) |
|---|---|---|---|---|---|
| 16 | 104 (60 / 44) | 3 | 21 (12 / 9) | none | 83 (48 / 35) |
| 32 | 95 (57 / 38) | 12 | 19 (11 / 8) | `ui2b_brief-1785392075491`, `mission_s14-1785723842757` | 76 (46 / 30) |

(173 unlabeled at both.) No unknown categorical value appears at either K.
None of the eligible missions carries brain tool entropy — `brainPresent` is 0
on every row at this snapshot, and the six entropy features are null.

### Outcome hindcast and the `M1.*` rows

Phase 5 ruling 5: the first learner enters the authority ladder exactly as a
rule would, judged on the frozen holdout and nowhere else. Nothing runs in the
engine this phase — an `M1` that earns `PREDICTIVE` is the next phase's
advisory S5 input, nothing more.

**At every VERDICT** (`scripts/cynco-campaign.mjs`, seams `exportOutcomeDataset`
/ `runHindcast`; the helpers are `scripts/cynco-hindcast.mjs`):

1. `exportOutcomeDatasets` writes three files under `~/.cynco/datasets/`:
   `outcome-dataset.jsonl` (K = 16, the ladder's rows),
   `outcome-dataset-k32.jsonl` (K = 32, reported only) and
   `outcome-dataset-hindsight.jsonl` (the K = 16-eligible missions built from
   ALL their turns, for the leak check). It also reads the manifest through
   `frozenSplit(rows, manifest, { turns: K })` at both K, so a held-out mission
   too short at K is named (`split[K].ineligible`) rather than silently absent.
2. `runHindcast` runs `python scripts/cynco-outcome-model.py --dataset …
   --dataset32 … --hindsight … --manifest benchmark/cynco-ledger/frozen-eval.json
   --out ~/.cynco/datasets/outcome-model.json` through `runSync` with a 300 s
   cap (F155). numpy + scikit-learn only; TabPFN and XGBoost are absent and
   PARKED (a download needs the operator).
3. Exit 0 → the model's held-out predictions become model rows
   (`modelRowsFrom` in `scripts/cynco-rule-verdicts.mjs`) and go into
   `writeRuleVerdicts` beside the rules. Anything else — python or sklearn
   missing, `TOO FEW` (exit 2), a crash, a timeout, a throw — is
   `rec.hindcast = { fault }`, one `UNMEASURED` line in the entry, and the rule
   verdicts are written WITHOUT model rows. A stale `outcome-model.json` from an
   earlier wave is never read. The hindcast is a measurement, never a gate.

**The model** (`scripts/cynco-outcome-model.py`, pinned by
`scripts/__tests__/cynco-outcome-model.test.mjs` on the committed fixtures in
`scripts/__tests__/fixtures/outcome/`): feature keys are read from the rows;
a null is imputed with the TRAINING mean and nothing else is added; a column
null on every training row, or holding one value on every measured training
row, is dropped and named (`droppedFeatures`, `droppedReasons`: `all null` |
`constant`). Features are standardised; `lr` = `LogisticRegression(max_iter=1000,
class_weight='balanced')`, `gbt` = `HistGradientBoostingClassifier(max_depth=3,
max_iter=200)`. The positive class is FAILURE (`pFail`). Refuses with exit 2
and `TOO FEW: train N < 30 or holdout M < 8` (or `ONE CLASS: …`), writing
nothing.

`outcome-model.json` (schema 1): `{ version, trainedAt, prefixTurns, nTrain,
nHoldout, baseRate, features, droppedFeatures, droppedReasons, models: { lr, gbt },
lengthFeature, leakCheck, secondary }` — per model the holdout `precision`,
`recall` (at `pFail ≥ 0.5`; null when nothing fired / no failure held out),
`brier`, `auc` (null on a one-class holdout) and `predictions: [{ missionId,
pFail }]`. `baseRate` is the HOLDOUT failure rate. `version` rises only when a
held-out prediction changed (compared at 6 decimals).

- **The leak check** — `leakCheck.<model> = { aucPrefix, aucHindsight }`: the
  same models refitted on the all-turns rows and scored on the same holdout. If
  hindsight separates and the prefix does not, the vector describes outcomes
  after the fact, which is itself the finding. `lengthFeature` names any kept
  feature that would carry the mission's length (`turnsInPrefix`,
  `prefixTurns`, `turns`, `totalTurns`); it is `null` — the fixed-K prefix is
  what makes the comparison meaningful.
- **`secondary`** — the same pipeline at K = 32 (`{ refusal }` when it refused).
  Reported, never laddered.

**The `M1.*` rows in `rule-verdicts.json`.** `modelRowsFrom(outcomeModel, rows)`
gives one synthetic rule per model: `M1.lr`, `M1.gbt`; *fired* = held-out
missions with `pFail ≥ 0.5`, *scope* = the held-out ids the ledger still
carries. `writeRuleVerdicts({ …, modelRows })` runs each through `analyse` over
its scope rows only — the identical Fisher exact / Wilson arithmetic a rule
faces, so the lift is against the HOLDOUT base — and re-runs Holm (`holm`,
exported from `scripts/cynco-signal-validation.mjs`) over the whole family,
rules and model rows together (`ledger.holmFamily`). Each lands as
`rules['M1.<k>'] = { verdict, precision, ci, p, n, pAdjusted, lift, firedTotal,
failures, source: 'model', scope: 'holdout', base, scopeN }`, and counts in
the FILE's `predictive` list and the writer's `total` like any rule (the
scoreboard's `perRulePrecision` does not: it counts S5 rules only and reads
the best `M1.*` row as its `learner` field — see "Scoreboard"). `engine/s5/ruleAuthority.ts` skips every
`source: 'model'` row, so an `M1.*` id never earns an S5 decision enforcement or
a place in the earned-only training corpus (pinned in `ruleAuthority.test.ts`
and `exportTrainingData.test.ts`). With no model rows the file is byte-identical
to Phase 4's.

The wave record carries `hindcast` (the model's metrics without its
predictions, `split`, and `ladder` — the two `M1.*` entries as written), or
`{ fault, split? }`; the entry prints it right after the scoreboard. If
`writeRuleVerdicts` throws WITH the model rows, the rules' verdicts are
rewritten alone (the engine never reads last wave's file, stale), the hindcast
keeps its metrics with `ladderFault: "<message>"` and `ladder: null`, the
record's `ruleVerdicts` carries `modelRowsSkipped: true`, and the entry prints
`LADDER NOT WRITTEN (<message>) — rules rewritten alone`. The
entry line carries the dropped dead columns as a COUNT (`dropped 28 dead
column(s)`); `--scoreboard` prints the latest record's hindcast in full, the
column names included (`hindcastLine(h, { detail: true })`).

**Real run on the 56-key vector, 2026-09-28** (after `algedonicAlerts.last/.max`
were dropped; 104 eligible at K = 16: train 83, holdout 21 — 12 failures / 9
successes; K = 32: train 76, holdout 19; `bun scripts/cynco-rule-verdicts.mjs
--with-hindcast --datasets-dir C:/tmp/p5fix-k56`, deterministic — a second
run wrote the same model, `trainedAt` aside):

```
- Outcome hindcast: v1 at K = 16 turns on 21 held-out missions (base 57%): M1.gbt precision 50% [25, 75] on 12 fired p(Holm) 1.000 NO EVIDENCE; M1.lr precision 56% [27, 81] on 9 fired p(Holm) 1.000 TOO FEW; leak check gbt AUC prefix 0.50 / hindsight 0.55, lr AUC prefix 0.47 / hindsight 0.61; K = 32 gbt AUC 0.63, lr AUC 0.41; dropped 28 dead column(s)
rule verdicts v1: 0 predictive of 8 rules (+2 model rows) (none) → C:\tmp\p5fix-k56\rule-verdicts.json
```

Holdout at K = 16: `lr` precision 0.556, recall 0.417, Brier 0.363, AUC 0.472;
`gbt` precision 0.500, recall 0.500, Brier 0.340, AUC 0.500. `M1.gbt` 6 of 12
fired missions failed, Wilson [0.254, 0.746], p 0.660, p(Holm) 1.000;
`M1.lr` 5 of 9, [0.267, 0.811], TOO FEW. Holm family 9 (7 tested rules + 2
models); no rule's verdict moved. For scale (the Task 4 review, over all the
real rows): the finished length alone separates the outcome at AUC 0.633, the
best single remaining prefix feature at ~0.58–0.60 (`s3s4Balance.balanced`
0.600 over all 104 K = 16 rows; neither dropped key was near the top) — `lr`
sits below chance and `gbt` at it, so on this ledger the learner adds nothing
to either. 28 of 56 columns were dead on the training split (the six entropy
features all null; `stuckTurns.*`, `taskError.*`, `progressRate.*`,
`consecutiveUnstable.last/max`, `brainPresent` and ten one-hots constant); 28
kept. Both `M1` rows are the honest verdict the spec predicted: no evidence on
21 missions.

The first run (2026-09-26, the 58-key vector with `algedonicAlerts.last/.max`)
read `gbt` precision 0.545 on 11 fired, AUC 0.407, hindsight 0.528, K = 32
`gbt` 0.55 / `lr` 0.42, 28 of 58 dead; `lr` did not move. Those numbers
describe a vector the code no longer builds.

### Gate progress mid-wave and `R1.no-progress` in shadow (Phase 6)

The runner grades the wave's latest commit WHILE the wave runs, with the sealed
gate, and records what it read on the wave record
(`scripts/cynco-campaign-progress.mjs`). It is a runner-side measurement only:
a reading reaches `waves.jsonl` and the runner's own log
(`[campaign] progress @ Nm: F fails (was F0)`) — never a probe message, never
the brief, never the engine. A sealed instrument is never a probe (Stage 1);
the model never gains information it did not have. The runner's log is the
operator's; it is never given to the model or written under the mission cwd
(it is the one mid-wave copy of a reading outside runner memory — final review
M2 — and its fault lines carry a fault class and exit code, never gate output).

**How a reading is taken.** `defaultIo.waitForDriver` calls
`onTick({ elapsedMs, nowMs })` once per poll (a throw inside it is logged once
per distinct message and the wait goes on). `runWave` hands it
`progressTracker(…).onTick`; on each tick `progressCadence` decides whether a
reading is due. When it is, the runner reads the repo's HEAD (`repoHead`); a
sha equal to the last reading's is `{ skipped: 'sha unchanged' }` and nothing
runs; otherwise `probeProgress` archives that sha with `archiveBase` (`git
archive <sha> | tar -x` through `bashExe()`) into
`<os.tmpdir()>/cynco-progress-<id>-<n>`, runs the grade module's `runGate` on
the ARCHIVE (`CYNCO_GATE_REPO` and cwd = the archive, never the live repo the
mission is editing), parses it with `parseGateOutput`, and removes the dir in a
`finally`. Every due tick follows a gap of `everyMs` with no spawn, so the
tick's first git spawn trips bun's stale deadline (F155): the HEAD read
retries inside `runSync` (`retryImpossibleTimeout`, a pure read) and the
archive re-runs `archiveBase` once into a freshly emptied dir; both hand their
retry line to the tracker (`onStaleRetry`), which counts every retry as
`rec.retriedSpawns` and logs the line ONCE per wave (P-F155 — at the smoke's
20 s cadence it was a red line per tick). The gate spawn goes through `runSync` and is **never retried**
(`retry: false`): a 215 s gate re-run is not free, and a stale ETIMEDOUT
mid-wave (F155) is a fault reading. Its cap is `min(GATE_TIMEOUT_MS, 4 × the
last measured run)`, 20 min (`PROBE_GATE_TIMEOUT_UNMEASURED_MS`, the tail's
own length) before any measurement. While HEAD still
sits at the wave's start sha, the first due tick records the start grade (the
calibration's or the last verdict's reading of that very sha) as a reading
with `reusedFrom: 'start'` and `durationMs: 0` — no gate runs — so a wave that
commits nothing still has a count past 50 %.

**Cadence.** `progressCadence({ everyMs, clockMs, gateMs, faults, lastAtMs,
nowMs })`, all times on the wave clock (ms since dispatch; `clockMs` =
`hoursPerWave × 3600 s`): never before `everyMs` since the last due tick (the
first counts from dispatch); with a measured gate the interval is raised to
`gateMs × 10`, so the gate takes at most 10 % of the wave (C9's 215 s gate →
≥ 2150 s); ×2 per consecutive faulted reading; never within the last
`gateMs × 2` of the clock. While no gate is measured the tail and the cap
assume a 600 s gate (`PROBE_GATE_MS_ASSUMED`, final review M4) and the reason
says so (`gate unmeasured (600 s assumed for the tail and the cap)`), so a probe
cannot hold the WAIT past the wave's end; the interval stays `everyMs`.
`gateMs` is seeded from the start grade (`seedGateMs`) — the last verdict's
`gate.durationMs` when that gate did not harness-fault (a faulted run's
duration is its timeout, which would starve the wave of readings), else the
calibration's BASE run (`calibration.baseGateMs`,
recorded from Phase 6 on; older calibrations have none) — so the 10 % rule,
the tail and the probe's cap hold from the first tick; each real probe run
replaces it. `everyMs` = `spec.progress.everyMs`, else
`CYNCO_PROGRESS_EVERY_MS`, else 1 800 000 (30 min).

**`rec.progress`** — one entry per reading, in order:
`{ at, sha, fails, passes, failIds, durationMs, elapsedFraction }` (`fails` /
`passes` are COUNTS, `failIds` the FAIL line ids; `elapsedFraction` = wave
clock at the reading / `clockMs`; `durationMs` = archive + gate) or
`{ at, fault, durationMs }` (the archive failed, HEAD did not resolve, the gate
timed out, did not run, printed an error or no terminator, or exited other than
0/1). A gate fault names its CLASS and exit code only — `gate printed an error;
exit 3`, `gate did not run (code ETIMEDOUT, …); exit null` — never the gate's
stdout or stderr (final review M2), because the fault is also logged. The
reused start grade has the same fixed shape plus `reusedFrom: 'start'` and
`durationMs: 0` (`passes` / `failIds` null only if the runner had no start
passes / FAIL ids — runWave always hands both). A fault never touches the
wave. `null` with `progressNote` naming why when the
runner took no reading at all (an adopted wave was not waited on; a runner io
without a probe); `[]` with a note when none was due before the wave ended. A
wave that faulted in the WAIT (no ledger row, wall clock expired) keeps the
readings it did get on its fault record.

**`rec.retriedSpawns`** — the number of the probe's git spawns (HEAD reads and
archives) this wave that hit bun's stale deadline and were retried (P-F155;
the F155 line is logged once per wave, the rest are only counted). Present
whenever the runner waited on the wave with a tracker; absent on an adopted
wave or a runner io with no probe.

**`rec.shadowDecisions`** — `R1.no-progress`, evaluated at every due tick
(reading or skip): *if at ≥ 50 % of the wave's wall clock the gate's fail
count has not dropped below the wave's starting count, the wave will not
pass.* `{ rule: 'R1.no-progress', at, elapsedFraction, fired, startFails,
fails, wouldHaveSavedS }`: `fired` iff `elapsedFraction ≥ 0.5` AND the latest
non-fault reading's `fails ≥ startFails` (`startFails` = `lastFails.length`,
else the calibration's `baseFails.length`); it never fires when the newest
reading is a fault (a stale count is not a reading of now) nor on an
unmeasured start; `wouldHaveSavedS` = the wall clock left at the decision
(`clockMs/1000 − elapsed`), written on every decision so a firing can be
weighed against what it would have cost. It is read off the BUDGETED clock,
so for a wave that ended early it overstates: a reader weighing a firing caps
it at `rec.durationS − elapsed`. SHADOW: nothing is stopped; a firing is one
log line and one record entry.

**Runner rows for the ladder.** `runnerRowsFrom(waves)` → one row
`{ id: 'R1.no-progress', source: 'runner', fired, scope, failed, skipped,
unlabeled }`, each wave keyed by its missionId, else `<campaign>#wave<n>` (the
wave the runner gave up on in the WAIT has `missionId: null`, and burning the
whole clock is exactly the rule's target — final review M3): *scope* =
waves with a decision (`stop` excluded — nothing ran) and ≥ 1
`R1.no-progress` shadow DECISION at `elapsedFraction ≥ 0.5`, fired or not.
*unlabeled* (final review I1) = the waves that would be in scope but whose
VERDICT is `kind: 'fault'` with `verified: null` — the grade itself did not run
(the gate or suite harness-faulted). `labelOf` makes that mission UNLABELED for
the S5 rules in the same Holm family, so it is unlabeled for R1 too: out of
scope and named `{ missionId, why }`. A WAIT-timeout or post-run fault record
(`faultWave`, no `verified` field at all) is not this — it stays in scope as a
failure.
Scope reads the decisions, never the readings: a wave that stops committing
before 50 % has its last reading below 50 % and only skipped ticks after it,
and those waves are the rule's positives (an 8 h wave that never commits is
in scope and fired). A wave with no decision past 50 % (adopted, or ended
before the halfway mark) is out. *fired* = scoped waves where any decision has
`fired: true`; *failed* = scoped waves whose decision is not `pass` /
`pass-with-survivors` — the rule's outcome (a firing on a wave that then
passed was wrong). The row is returned with an empty scope too: TOO FEW is the
honest state, not an absent row. It earns `PREDICTIVE` exactly as an S5 rule
would before any later phase lets it stop a wave.

**The verdict line.** `verdictEntry` prints, after `- Autopoiesis:` and before
`- Scoreboard:`, `progressLine(rec)`:
`- Progress: 14 → 3 fails over 3 readings (first fix at 41 min; last at 210
min: 3); R1.no-progress fired at 52% (would have saved 3.2 h)` — minutes are
`at − dispatchedAt`; `no drop` when no reading went below the start; `; N
fault(s)` when probes faulted. With no measured reading:
`- Progress: no readings (<reason>)`. A runner io with no probe prints no line.

**`R1.no-progress` in the ladder (Task 4).** The runner row is built by ONE
construction, `runnerRowsFromCampaigns` in `scripts/cynco-runner-rows.mjs`
(which also owns `runnerRowsFrom`, `runnerWaves` and the rule's name and 50 %
threshold; `cynco-campaign-progress.mjs` re-exports them). It reads every
runner-driven campaign's `<campaigns dir>/*/waves.jsonl` — the rule is one rule
across campaigns. At VERDICT the campaign being graded is read from its own
state, with the wave just recorded in place of its stored copy. The rule-verdicts
CLI (`bun scripts/cynco-rule-verdicts.mjs`, with or without `--with-hindcast`)
builds the same row over `--campaigns-dir DIR` (default
`<cyncoHome>/campaigns`). The row is a member of the Holm family, so a rebuild
that left it out would correct the S5 rules over a smaller m and could flip a
rule near p(Holm) 0.05; a test pins that the CLI and the VERDICT write the same
`pAdjusted` for every rule on the same inputs (review I1).

The row goes to `writeRuleVerdicts({ …, modelRows, runnerRows })` and through
the SAME `analyse` a rule faces — Fisher exact, Wilson — over its scope alone
(one row per in-scope wave; *fired* from `fired`, the outcome from `failed`,
through `analyse`'s `labelOf` seam, so the lift is against the in-scope waves'
failure rate). It joins the ONE Holm family: rules, then `M1.*` model rows, then
runner rows (`ledger.holmFamily`). It lands as
`rules['R1.no-progress'] = { verdict, precision, ci, p, n, pAdjusted, lift,
firedTotal, failures, source: 'runner', scope: 'waves', base, scopeN, note,
unlabeled }` — `unlabeled` the row's `[{ missionId, why }]` (`[]` when none),
recomputed from the wave records at every VERDICT.

- **Unmeasured is never a rate (F16).** With no wave in scope the verdict is
  `UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or
  later)`. With waves in scope but no firing it is `UNMEASURED — fired on no
  in-scope wave`. Either way `n: 0` and `precision`, `ci`, `p`, `pAdjusted` and
  `lift` are all `null`.
- **A malformed wave record costs that record, never the row.** This covers a
  record that is not an object, or one whose `shadowDecisions` is neither absent
  nor an array. It is skipped and named in `note` (`N malformed wave record(s)
  skipped: <missionId | <campaign>/waves.jsonl line <n>>` — Task 4 review N2;
  a bare record handed to `runnerRowsFrom` with no campaign reads `record #i`);
  otherwise `note` is `null`.
- **The outcome is the wave's FINAL decision.** At VERDICT the identity
  assertion runs before the ladder, so a pass it turns into a fault is a failure
  for R1 on that same verdict.
- **The version.** Like the model rows, a runner row never moves it: a runner
  row that appears, vanishes or changes verdict is written to the history
  entry's `runnerChanged`. That is a new entry at the SAME version when no rule
  moved, or it rides on the rule entry when one did.
- **R1 is not a rule anywhere it could count as one.** It is in neither the
  writer's `rules` count nor the file's `predictive` list, even when it reads
  PREDICTIVE, so "N predictive of R rules (…)" and `predictive` agree; a
  PREDICTIVE R1 is read in its own entry. The `M1.*` rows keep their Phase 5
  place in `predictive`. `engine/s5/ruleAuthority.ts` skips `source: 'runner'`
  exactly as it skips `source: 'model'` (pinned in `ruleAuthority.test.ts` and
  `exportTrainingData.test.ts`), and the scoreboard's `perRulePrecision` neither
  counts nor ranks it. Shadow means no authority, whatever the verdict.

The writer returns `runnerRows` (count) and `runners` (the entries). The verdict
entry, and the CLI's `--with-hindcast` output, names the row with its verdict on
the `- Outcome hindcast:` ladder line, after the model rows. It appears on a
hindcast fault line too, since the runner row does not depend on the hindcast.
An UNMEASURED verdict prints with its reason, and a `note` follows in
parentheses:
`…; M1.lr precision null on 0 fired p(Holm) null TOO FEW; R1.no-progress
precision null on 0 fired p(Holm) null UNMEASURED — fired on no in-scope wave;
leak check …`.

If the write throws on the MODEL rows, the fallback rewrite keeps the runner
rows.

## Labeling rule

Ground truth for signal validation (step 2, per-rule precision/recall):

- **success** = `outcome === "landed" && verified === true && mutationSweep` has
  no survivor that a DoD item claimed to own (a `derived` or `derived-full`
  sweep's survivors are coverage findings, not DoD claims — such a row is
  labeled, and a success when it landed verified)
- **failure** = anything else
- **unlabeled** = `verified === null` or `mutationSweep === null`. An unmeasured
  mission is not a passing one. Exclude it; do not default it.

`outcome` is assigned by the driver (commit marker found in `git log` /
timeout / F7 zero-tool fast-fail).

The driver prints `[driver] COMMIT LANDED` ONCE per mission, by design: it
marks the landed TRANSITION (the first poll on which `missionCommitted` sees a
mission commit), not each commit — C9 wave 1 made six commits and printed it
once. A mission's commit count is read off the record — the runner's
`commitsBetween` over the row's `commitRange` (the wave record's
`outcome.commitsLanded`) — never a count of that console line.

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

   Backfill was measured before it was abandoned, so it does not need measuring
   again: of the **129 rows with `verified` set but no sweep, 3** carry an
   explicit `REV … vs BASE …` pair in `verify.outputTail`, 23 carry some
   sha-shaped token with no pair, and 103 carry nothing sha-like at all.
   Recovering three rows does not justify a parser. Those rows stay unlabeled;
   the fix was never going to be retroactive.

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
