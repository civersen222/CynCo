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
  // Written by the campaign runner's GRADE alongside `mutationSweep`: why a
  // derived sweep produced no reading ("timed out after 3600000 ms", "sweep
  // refused (exit 2)", "unparseable sweep output"). null = the sweep ran, or
  // there was no diff to sweep. Distinguishes "unmeasured because the
  // instrument broke" from "unmeasured because nothing was measured".
  "sweepFault": null,
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
  "s5Decisions": [          // one per s5.decision event
    { "t": 1783550000000, "ruleIds": ["C7"], "reasoning": "...",
      "contextAction": null, "toolRestriction": "read-only",
      "modelSwitch": null, "enforced": false, "authority": "advisory" }
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
  "ultrastable": { "trace": [], "margin": 0.4 },
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

### Rule verdicts file

`~/.cynco/datasets/rule-verdicts.json`, written by
`scripts/cynco-rule-verdicts.mjs` (`writeRuleVerdicts`) at every wave VERDICT
from the WHOLE ledger — not the campaign's slice, because a rule's predictive
power is a claim about every mission it fired on. `bun
scripts/cynco-rule-verdicts.mjs [--ledger-dir DIR] [--out PATH]` rebuilds it by
hand. It is Step 2's per-rule table (`analyse` + `ruleVerdictOf` in
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
{ "schema": 1, "version": 1, "writtenAt": "2026-09-25T18:35:33.166Z", "campaign": null,
  "ledger": { "total": 280, "labeled": 107, "failures": 61, "base": 0.5700934579439252, "rulesTested": 7 },
  "rules": {
    "C2": { "verdict": "TOO FEW — cannot tell", "firedTotal": 17, "labeled": 5, "failures": 1,
            "precision": 0.2, "lift": -0.3700934579439252, "p": 0.16249100754494467, "pAdjusted": 1 },
    "I1": { "verdict": "NO EVIDENCE", "firedTotal": 106, "labeled": 51, "failures": 28,
            "precision": 0.5490196078431373, "lift": -0.021073850100787883, "p": 0.6999222665344511, "pAdjusted": 1 }
  },
  "predictive": [],
  "history": [ { "version": 1, "at": "2026-09-25T18:35:33.166Z", "campaign": null, "predictive": [],
                 "changed": [ { "id": "C2", "from": null, "to": "TOO FEW — cannot tell" } /* + the other seven rules */ ] } ] }
```

- **`rules[<id>].verdict`** — exactly `ruleVerdictOf`'s string: `PREDICTIVE`,
  `TOO FEW — cannot tell`, `CONSTANT — fires on everything, predicts nothing`,
  `INVERTED — fires more on successes`, `NOT AFTER CORRECTION — chance across
  this many rules`, or `NO EVIDENCE`. Only `PREDICTIVE` earns authority. A rule
  the file does not list has never fired in the ledger and has earned nothing.
- **`version`** rises only when the verdict SET changed — a rule's verdict
  moved, or a rule appeared or vanished. The numbers are refreshed on every
  write; the version counts changes in what S5 may enforce.
- **`history`** — the last 20 version changes, each naming the rules that moved
  (`from`/`to`, `null` for appeared/vanished).
- **`campaign`** — the campaign whose VERDICT wrote it (`null` from the CLI).

The wave record carries `ruleVerdicts: { version, predictive, total }` (`null`
when the write failed — logged, never a fault). On this ledger no rule is
`PREDICTIVE`, so once the file exists every S5 decision reads `advisory`.

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
