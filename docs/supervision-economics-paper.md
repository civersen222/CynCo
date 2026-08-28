# Calibrated-Gate Supervision Economics: Measuring Frontier-Model Oversight of a Local Coding Agent

**Status:** Draft v1 (2026-08-28)
**Data sources:** `scripts/supervision-economics.mjs` (run 2026-08-28, output reproduced in Appendix A), `docs/civkings-redesign-briefs/campaign-log.md`, `docs/cynco-failure-log.md`, `docs/civkings-redesign-plan.md`, `benchmark/cynco-ledger/missions.*.jsonl`.

---

## 1. Abstract

We report a measured economic substitution: a frontier model (Claude) acting purely as a *supervisor* — writing mission briefs and sealed, calibrated verification gates, grading outcomes, and never editing the supervised code — while a locally hosted 27B-parameter model performed all generation. Over five sealed-gate campaigns (C1–C5, 2026-08-24 through 2026-08-28), the local agent autonomously redesigned a game codebase; every campaign passed its sealed gate. Accounting real frontier API spend against what the local generation would have cost at frontier API prices:

> **VERDICT: frontier spent $2339.47 SUPERVISING (development $1977.46 and unattributed $4.79 are excluded — building LocalCode is not oversight). The supervised generation would have cost ~$3258.06 on the API ($285.23 priced from measured tokens, $2972.84 still estimated) and ran locally for ~$9.34 of power. supervision ratio: $1 of frontier verify oversees ~$1.39 of displaced generation.**
> — `scripts/supervision-economics.mjs`, 2026-08-28

The displaced generation itself cost approximately $9.34 of electricity ($3258.06 / $9.34 ≈ 349× cheaper than API-priced generation). Sensitivity analysis on the two known measurement biases — the per-turn estimator over-prices campaign-scale missions by ~1.22×, and a stricter attribution model raises supervision spend ~14% — bounds the ratio to a band of ~$1.0–1.4 per supervision dollar, with both biases pointing down (§5.4). The paper describes the supervision method — calibrated held-out gates that must clean-FAIL on the base commit and FAIL on a cheat-stub perturbation before dispatch — the five campaigns, the cost accounting, and the failure modes that define what supervision actually consists of.

## 2. Setup

**Supervised system.** LocalCode is a locally hosted coding agent ("CynCo" is its agent persona) running Qwen3.8-27B via llama-server on a single RTX 5090 (32 GB), NVFP4 quantization with MTP/ngram speculative decoding. Measured single-stream generation throughput is 94–119 tok/s depending on content (speculative acceptance drives the spread: prose 94.9, code 101.1, repetitive JSON 119.3 tok/s — `benchmark/true/results/throughput-nvfp4-mtp-1787935000.summary.txt`); streamed tool-call delivery is 16/16 with zero drops (`benchmark/true/results/streamtoolcall-1787004103304.summary.txt`). The agent runs an autonomous mission loop: it receives one long-horizon brief, then works unattended — reading, editing, running tests, committing — until a marker commit, a budget cap, or a timeout closes the run.

**Mission harness.** `scripts/dispatch-mission.sh` → `bun engine/main.ts` + `scripts/cynco-mission-driver.mjs`. Per `docs/civkings-redesign-plan.md`: "Dispatch long: `LOCALCODE_MAX_ITERATIONS=2400`, timeout 43200 s (12 h), gate as check-cmd." Each mission appends one row to the ledger (`benchmark/cynco-ledger/missions.NNNN.jsonl`) recording outcome, verification result, turns, per-tool call counts, and — from campaign C4 wave 3 onward — measured token statistics (`prefillTokens` / `cachedTokens` / `decodeTokens` per turn).

**Task.** Redesign of CivKings, a Python simulation-game repository, per a written spec, "via five long-horizon CynCo campaigns, each with a self-authored success contract encoded 1:1 in a sealed, calibrated gate" (`docs/civkings-redesign-plan.md`).

**The supervised/supervisor split.** The frontier model never touched the game code (standing rule: "NEVER touch civkings repo directly; CivKings gaps = requirements on CynCo missions/tooling"). Frontier work consisted of: authoring the success contract and mission brief, writing and calibrating the sealed gate, dispatching, grading the outcome (re-running the gate by hand, mutation sweeps, visual checks), diagnosing harness defects, and writing the next wave's brief on a MISS. Between dispatch and gate verdict there were "**no user round-trips**" (plan, Architecture section).

**Gates are sealed.** Gate scripts live outside the supervised repository at `~/.cynco/heldout/civkings-redesign/c<N>/`; the brief publishes the contract (assertions for seed 7) while the gate additionally runs undisclosed seeds (11, and 13 where applicable). Gate file SHA-256 hashes are recorded in the campaign log before dispatch.

## 3. Method: calibrated-gate supervision

The core discipline, from the plan's operating model:

1. **Contract first.** "I author 'success looks like' as numbered assertions (`G<c>.<n>`), each a runnable command. The brief quotes the contract verbatim; the sealed gate implements it 1:1 plus **undisclosed seeds**."
2. **Calibrate before dispatch (Rule 11).** "run the gate on the pinned BASE (must FAIL cleanly — every check prints `FAIL`, zero crashes/false-passes) and on a **cheat-stub perturbation** (trivial fake implementations — the discriminating sub-checks must still FAIL). Record both outputs in the campaign log before dispatching."
3. **Wave policy.** "if the gate MISSes, write a cut brief quoting the gate's FAIL lines **verbatim** (F89), commit it, redispatch. Max 2 cuts (3 waves total) per campaign."
4. **Verdict.** Ledger row must show `outcome==="landed" && verified===true`; the supervisor additionally re-runs the sealed gate by hand, runs a mutation sweep over the wave's diff, and performs a visual check of rendered frames.

The two calibration runs are the load-bearing step. A gate that errors on the base commit measures nothing (it would "fail" any tree); a gate that a trivial stub can pass measures nothing (it cannot discriminate real work from fakery). Example calibration record, C1 (campaign log): the BASE run produced `GATE: MISS (8 fails)   exit 1, no traceback`; the cheat stub (constant ranks, empty-cause provenance, signature-only beats, hollow registry) produced `GATE: MISS (12 fails)  — stub cannot pass; gate discriminates.` C5's stub was designed to pass the count checks — "all count checks PASS as designed, GATE: MISS (4 fails) via the liveness discriminators … Counts a gate would take at face value are caught by the checks that watch the world move."

Calibration itself improved under fire. When C3's original gate crashed with `KeyError: 'Combine'` on a wrong-shape wave-1 head, the gate was hardened and re-calibrated in a worktree, and the campaign log records the lesson: "the perturb suite must include a wrong-shape variant (orders present, wrongly keyed), not just an inert one — that variant would have caught the KeyError before dispatch."

MISS briefs quote the gate's FAIL lines verbatim — the failed assertions *are* the next wave's task statement. C2 wave 2's brief quoted the single fail (`G2.2b AttributeError("'Character' object has no attribute 'want'")`) and the wave closed it in 40 turns.

## 4. The five campaigns

All five campaigns PASSED. 14 mission dispatches total: 12 chargeable waves plus 2 runs ruled VOID for harness (not model) failure. Per-campaign gate hashes, calibration transcripts, wave histories and verdicts are in `docs/civkings-redesign-briefs/campaign-log.md`; the summaries below quote it.

### 4.1 C1 — the sim becomes visible (2 waves, PASS)

BASE 2092b0c, gate f2dd97feb5db182f. Wave 1 MISS: "ladder/beats landed as methods with domain beat kinds — substance real, shape wrong." Wave 2 (784 turns) PASS: "hand re-run exit 0, 149 checks 0 fails; marker exact in a418d49 with wire-check proof." Mutation sweep 4/25 killed; real-logic survivors carried as thin-tests residual.

### 4.2 C2 — the player has a stake (2 waves, PASS)

BASE a418d49, gate 1f6b4bc6ca740b5b. Wave 1 MISS on exactly one gate check: wants "only derived inside set_ambition, absent at boot"; notably, "CynCo misdiagnosed the sealed command as MSYS backslash-stripping and self-stopped." Wave 2, with the fail quoted verbatim in the brief, landed in 40 turns: "335 PASS 0 FAIL incl. G2.4c '0 C1 regressions'." Sweep 2/8 killed; 6 survivors in boot-want derivation (thin-tests residual).

### 4.3 C3 — the world pushes back (3 waves + 1 void, PASS)

BASE 9c4b773, gate hardened mid-campaign (90fa086ac43242e5 → 9c0a6fbd4027a7c2). The hardest campaign, and the one that indicted the engine rather than the model. Wave 1 MISS: shape divergence — orders keyed `['Church', 'Crown', 'Guilds', 'Treasury']` instead of the spec's Combine/Bank/Church/Gazette, no `hold_seat`. Wave 2 MISS: "the gate fails the IDENTICAL 8 checks at its head as at its base" while the run "finished its own wave-1 plan" (logged F128, contract inversion). Wave 3 run 1 VOID (F129): context compaction destroyed the brief and the run "delivered a 2-line window-title rename and nothing else." Forensics retro-diagnosed all three waves to the same compaction defect (§6.4). After the fix, the wave 3 re-run (581 turns, 88 min, 9 compactions survived with the brief pinned) landed the whole campaign: "the same brief, model, and BASE that produced a 2-line title rename without the pin landed the whole campaign with it."

### 4.4 C4 — one living UI (3 dispatches, 1 void, PASS)

BASE 4c67cae, gate 05ea014c667311c7. Wave 1 MISS (206 turns, foundations only). Wave 2 VOID (F130): the supervisor's own shell smoke test spawned a second engine whose zombie-server sweep killed the mission's inference server. Wave 3 landed at the 1,200-iteration budget: driver verify PASS at 3fc2de9 "plus G2.4c/G3.6/G4.6 zero regressions across the whole C1+C2+C3 chain"; the marker commit was never made because the cap landed during post-green polish ("markerSeen:false is bookkeeping, not a miss"). This wave produced the "FIRST fully-measured tokenStats row: prefill 1,600,743 / cached 51,744,186 / decode 520,129 across 1200/1200 measured turns — the cache-to-prefill ratio (32:1) is the number the economics model has been waiting for."

### 4.5 C5 — the world is big (3 waves, PASS)

BASE 3fc2de9, gate 0c4e6b30c2178a22. Wave 1 (685 turns, 6h timeout): the entire C5 surface green (194–201 provinces, 24 gentry, mobility in all three seeds, perf 11.7 ms against a measured 30.6 ms cap) but two defects — the head was not self-contained (F132, §6.1) and one chain regression (G3.4a.deflection seed 3). Wave 2 (112 turns): both defects fixed, sealed chain green end-to-end — but the committed test suite stood at "152 failed/1893 passed vs 10 failed/2026 passed at BASE" (F133, §6.2). Wave 3 (581 turns, ledger c5-wave3-1787875895222, 480 tool calls) restored it: "15 commits: 14 `adapt:` + 1 `fix:`" — the fix being a real game bug the campaign exposed ("under-construction enterprises charged input costs while producing nothing") — closing at "S.count 2046 passed / 0 failed (need >=2040, was 152 failed at BASE)."

## 5. Economics

### 5.1 Methodology

`scripts/supervision-economics.mjs` prices both sides of the substitution (full output: Appendix A).

**Frontier side (real spend).** Claude Code session messages are classified by tool targets into three buckets: `supervise$` (brief/gate/grading/ledger work — oversight of the local agent), `develop$` (building LocalCode itself), and `unattrib$`. Only `supervise$` counts as supervision cost: "development $1977.46 and unattributed $4.79 are excluded — building LocalCode is not oversight." Over 2026-07-15 → 2026-08-28: 18,476 messages, $4,321.72 total, of which **$2,339.47 supervision**.

**Local side (displaced generation).** Each local mission's tokens are priced at frontier API rates — the script's stated assumptions: "API $/MTok in=15 out=75 cacheW=18.75 cacheR=1.5". Rows with measured `tokenStats` (4 of 54 missions) are priced from real token counts ("REAL rows price measured tokens (decode@out, cached@cacheR, prefill@in)"); the remaining 50 use a per-turn fallback ("EST rows/turns use 700 out + 40000 cacheRead + 1500 freshIn per turn"). Local operating cost is electricity: "local power 600W @ $0.15/kWh."

### 5.2 The measured ratio

Across all 54 supervised missions (24,599 turns, 35,150 tool calls, 103.82 hours):

| side | amount |
|---|---|
| Frontier supervision (real spend) | $2,339.47 |
| Displaced generation at API prices | ~$3,258.06 ($285.23 measured + $2,972.84 estimated) |
| Actual local generation cost (electricity) | ~$9.34 |
| **Supervision ratio** | **$1 of frontier verify oversees ~$1.39 of displaced generation** |

The five campaigns alone account for $788.36 of the displaced generation ($151.06 + $94.36 + $218.56 + $179.79 + $144.59 across C1–C5), 6,305 turns, 5,797 tool calls, 34.85 hours, and $3.14 of electricity; the `other` row (40 missions, $2,469.69 estimated) is prior mission-track work under the same supervision regime. A mid-program snapshot exists as a second datapoint: at C3 close the campaign log recorded "frontier $316.96 real spend vs ~$464.00 displaced generation (ratio 1.46, up from 1.30 pre-wave-3)."

Two readings of the headline number. Read as substitution: every supervision dollar replaced ~$1.39 of frontier generation spend — the frontier model was net-cheaper to use as a verifier than as a generator, on this workload, at these prices. Read as leverage: the ratio is modest, and §5.4 discusses why it understates the steady-state case.

### 5.3 Cache economics

The four measured rows show why agentic generation is dominated by cache reads, not fresh prefill or decode (ledger `tokenStats`, quoted in the campaign log):

| mission | turns | prefill | cached | decode | cached:prefill |
|---|---|---|---|---|---|
| c4-wave3 | 1200 | 1,600,743 | 51,744,186 | 520,129 | 32:1 |
| c5-wave1 | 685 | 904,330 | 22,603,979 | 416,003 | 25:1 |
| c5-wave2 | 112 | 50,291 | 3,130,926 | 31,876 | 62:1 |
| c5-wave3 | 581 | 584,338 | 22,568,534 | 206,134 | 39:1 |

Cached:prefill ratios run 25–62:1. At the assumed API rates, even cache-read pricing ($1.5/MTok) makes the cached volume the largest cost line on long waves — c4-wave3's 51.7M cached tokens alone price at ~$77 of the row's $140.64 — which is precisely the cost class that a local model reduces to electricity. The per-turn estimator for unmeasured rows (40,000 cacheRead per turn) is broadly consistent with the measured rows (c4-wave3: 51.7M/1200 ≈ 43k/turn; c5-wave1: 22.6M/685 ≈ 33k/turn; c5-wave3: 22.6M/581 ≈ 39k/turn), though c5-wave2's short surgical wave ran lighter (3.1M/112 ≈ 28k/turn).

### 5.4 What the ratio does and does not include

The 1.39 ratio is conservative in three ways and optimistic in one:

- **Conservative:** supervision spend includes the *forensics* of two harness defects charged to oversight (e.g., the F129 session-transcript analysis), one-time gate-authoring costs that amortize over reuse (the C1–C4 gates re-ran inside every later campaign as regression chains at no new authoring cost), and the early learning curve — the C3-close snapshot (1.46) and the program-wide figure (1.39) bracket a period in which supervision technique was still being invented.
- **Conservative:** the displaced-generation figure prices only tokens. It does not price the outcome (five passed campaigns); no claim is made about what a frontier model would have *needed* to spend to produce the same artifact.
- **Conservative:** the local side's true cost is $9.34 of electricity; the ratio compares supervision to *displaced API spend*, not to local cost. Generation itself was ~349× cheaper than API prices ($3,258.06 / $9.34).
- **Optimistic:** 50 of 54 local rows are estimated, not measured ($2,972.84 of the $3,258.06). The four measured rows exist only from C4-wave3 onward. The estimation error is now bounded by re-pricing those four rows through the per-turn estimator and comparing to their measured cost:

  | mission | turns | measured API$ | estimator API$ | est/measured |
  |---|---|---|---|---|
  | c4-wave3 | 1200 | $140.64 | $162.00 | 1.15 |
  | c5-wave1 | 685 | $78.67 | $92.47 | 1.18 |
  | c5-wave2 | 112 | $7.84 | $15.12 | 1.93 |
  | c5-wave3 | 581 | $58.08 | $78.44 | 1.35 |
  | **weighted** | | **$285.23** | **$348.03** | **1.22** |

  The estimator *over-prices* campaign-scale missions by ~22% (worst on short surgical waves, which run cache-light). Deflating the estimated $2,972.84 by 1.22× gives ~$2,437, a displaced total of ~$2,722, and a ratio of ~**1.16**. The bias direction is known: the true ratio is likely below the headline 1.39, not above it.

Attribution is also imperfect: the supervise/develop classification is by tool targets of session messages, and the campaign log itself notes (at C3 close) that the "frontier side still conflates engine-dev (F129) with pure supervision" in edge cases. A sensitivity analysis on the classifier (run against the full transcript corpus): the per-message conflict tie-break turns out to be empirically irrelevant — no message matches both pattern sets — but the *context carry-forward* is the real lever. Only ~34% of classified-as-supervision spend comes from directly-classified messages; the rest are unclassifiable messages (no tool calls, or neutral tools) inheriting the session's running class. Under the alternative defensible model — allocate carried and unattributed spend proportionally to the directly-classified split (65.7% supervision) — supervision spend rises ~13.6%, moving the ratio ×0.88. Combining both sensitivities (estimator deflation ×0.84, attribution ×0.88) gives a worst-case joint ratio of ~**1.02**. The honest headline is therefore a band: **$1 of frontier supervision oversees ~$1.0–1.4 of displaced generation**, with 1.39 the point estimate under the script's stated model and every quantified bias pointing down, not up.

## 6. Failure modes and instrumentation lessons

What did the supervision money buy? Not code review — the supervisor read almost none of the generated code. It bought *measurement integrity*: each campaign's serious defect was a way the measurement itself could have lied, found and closed. Four case studies, from `docs/cynco-failure-log.md`.

### 6.1 F132 — grade the commit, not the tree

C5 wave 1 committed `chassis.py` importing `GENTRY_SURNAMES` from a module where the definition "was still an uncommitted working-tree edit when the 6h wall clock closed the run. A clean checkout of 35050f9 dies on ImportError at boot." Both the driver's verify and the supervisor's hand re-run executed in the mission working tree and graded green. It was caught "Not by the instruments" but by a suspicious supervisor's `git stash` + boot probe. The fix: at verify time, preserve tracked changes to a patch, `git checkout -- .`, grade what a clean checkout would see, and record `verify.dirtyAtVerify` on the ledger row. General lesson, verbatim: "An instrument that runs where the work happened inherits whatever the work left lying around. Grade deliveries from the commit graph, not from the desk it was assembled on."

### 6.2 F133 — a rule the gate cannot see is a rule the mission can break in a green run

Both C5 briefs said "The full committed suite must stay green: python -m pytest gilded/tests -x -q" — as prose, in the RULES section. Wave 1's atlas rescale broke ~142 committed tests; wave 2's sealed gate passed the whole C1–C5 chain "while `pytest gilded/tests` reported 152 failed, 1893 passed." The failure log names the pattern: "'suite must stay green' written as prose in RULES is exactly the contract-vs-gate divergence already root-caused: an order without an assertion and a command is a wish." The response was structural, not exhortative: a sealed suite-gate (`gate_c5s.py`) with a pass-count floor ("0 failed AND >= 2040 passed — the floor kills fix-by-deleting-tests"), a no-new-skips check ("kills fix-by-skipping"), Rule-11 calibrated like every other gate, and a standing authoring rule: "every 'must stay green' clause gets a gate check or it does not get written." This is the paper's central mechanism finding: the same instruction succeeds as an assertion and fails as prose, with everything else held constant.

### 6.3 F131 — working, hung, or finished-but-undead

C4 wave 3 succeeded, wrote its verdict row — and the engine process never exited; the verdict "sat unprocessed for 7.3h until the user noticed." The lesson: "'Is it still running?' has three answers, not two: working, hung, and finished-but-undead. The third looks exactly like the second from the outside, and only the ledger can tell them apart." The fix (driver-initiated teardown) itself had a residual found at C5 wave 3 — "A closed socket proves the socket died, not the process" — closed by probing with a fresh authenticated WebSocket and validated live against that wave's undead engine. Supervision cost here is watcher latency, a real line item: half a night of silent verdict per incident until the watcher polled the ledger row as a first-class signal.

### 6.4 F129 — the engine is part of the suspect pool

All three C3 waves failed the same way before anyone blamed the right component: context compaction "pinned only the LAST 6 user messages," so "effectively NOTHING of the ask survived verbatim," and the brief survived only as "a paraphrase, re-paraphrased each cycle. Chinese whispers: wave 3 drifted 'rename the world to the spec' → 'rename display names' → 'rename the window title'." Two waves were misattributed to model failure before transcript forensics found the engine defect. The gate never lied — "The sealed gate caught every wave — the measurement held; the engine was the recidivist" — but interpreting *why* a gate missed is supervisor work, and the general lesson is a supervision procedure: "When a long-horizon agent drifts off-goal, check what its context actually contained after compaction before blaming the model: the gate measures the model+engine system, and the engine is part of the suspect pool."

### 6.5 The gates held against the agent, too

Two liveness notes on gate integrity: across graded waves the ledger's grader-probe check found essentially no tampering attempts (e.g., "0/558 tool calls touched the grading apparatus" at C3 wave 3, "Probes 0/480" at C5 wave 3), and the one live attempt at self-attestation was refused by mechanism, not vigilance: "CynCo tried to self-mark the gate assertion passed; the engine checked the repo and denied it ('Assertion 0 was NOT marked passed — the repository contradicts it'), and CynCo kept working."

## 7. Limitations

- **Single task domain.** One Python game repository, one spec, one supervisor's gate-writing style. The 1.39 ratio is a property of this workload; domains with cheaper verification (or harder-to-assert success) will move it in either direction.
- **Single local model, single hardware configuration.** Qwen3.8-27B on one RTX 5090. No cross-model comparison was run.
- **Estimated majority of the displaced-generation figure.** 50 of 54 rows ($2,972.84 of $3,258.06) use the per-turn estimator; measured token accounting only exists from C4 wave 3 onward. The estimator's error is bounded, not eliminated: it over-prices the four measured campaign rows by 1.15–1.93× (weighted 1.22×), so the estimated portion — and the headline ratio — are biased high (§5.4).
- **Price-list dependence.** The displaced figure is linear in the assumed API rates (in=15 / out=75 / cacheW=18.75 / cacheR=1.5 $/MTok); different rate cards rescale the ratio directly.
- **Thin-test residuals.** Every campaign's mutation sweep left survivors of one recurring class — constants and dials with no behavioral assertion: C1 "acts.py:25/:41, beats.py:139/189/199/201 (thin-tests residual)"; C3 "16 of 20 survivors = ambitions.py:50-65 Order-family disposition weights, ±1.0→2.0 keeps ordering"; C4 "18 UI-draw survivors"; C5 "21 survivors = the gentry-tick tuning dials (fall odds 0.05, rise threshold 70, drift bounds, pool constants in chassis.py:128-162)." The campaign log's framing is the honest one: "the gates assert the Clarity-Law property (state change + beat, counts in bands), not the dial values." Property-asserting gates deliberately leave tuning constants unguarded; that is a scope choice, and the sweep quantifies exactly what it leaves exposed.
- **Supervisor grades its own rulings.** VOID determinations (F129, F130 — runs not charged to wave budgets) and the supervise/develop cost classification were made by the same party whose economics are being reported. Both are documented with evidence in the failure log and campaign log, but an adversarial audit has not been performed.
- **The supervisor is part of the harness.** F130 is the standing demonstration: a supervisor shell command killed a mission's inference server, and "the ledger will file it under `engine_error` with nothing pointing back at the true cause."

## 8. Related work (stub)

To be written. Areas to survey and cite (no citations invented here):

- **LLM-as-judge / model-based evaluation** — reliability and gaming of model-graded rubrics; contrast with executable, calibrated gates.
- **Weak-to-strong and scalable oversight** — this work inverts the usual framing: a *stronger* model supervises a *weaker* generator, and the question is economic rather than alignment-theoretic.
- **Agent orchestration and verification harnesses** — SWE-bench-style executable verification, agentic evaluation harnesses, test-time verification loops.
- **Mutation testing** — as the residual-risk meter for gate coverage.
- **Local/edge LLM deployment economics** — token-cost and energy accounting for self-hosted inference.

---

## Appendix A — `scripts/supervision-economics.mjs` output (2026-08-28, verbatim)

```
SUPERVISION ECONOMICS — frontier (verify) vs local (generate)
assumptions: API $/MTok in=15 out=75 cacheW=18.75 cacheR=1.5;
  local counterfactual: REAL rows price measured tokens (decode@out, cached@cacheR, prefill@in);
  EST rows/turns use 700 out + 40000 cacheRead + 1500 freshIn per turn;
  local power 600W @ $0.15/kWh

FRONTIER (Claude Code sessions, real usage, classified by tool targets):
  day          msgs   supervise$   develop$   unattrib$      total$
  2026-07-15   1174   $   96.75  $  193.22  $    1.49   $  291.46
  2026-07-16   1067   $   78.44  $  208.01  $    0.00   $  286.45
  2026-07-17     59   $    3.97  $   14.46  $    0.00   $   18.43
  2026-07-21   1072   $    8.67  $  237.52  $    0.00   $  246.20
  2026-07-22    122   $    0.71  $   27.65  $    0.00   $   28.37
  2026-07-23   2087   $    3.83  $  499.62  $    0.00   $  503.45
  2026-08-12    179   $   43.77  $    7.34  $    0.56   $   51.67
  2026-08-13    376   $   77.42  $   15.85  $    1.88   $   95.15
  2026-08-14    434   $   95.87  $    3.26  $    0.00   $   99.13
  2026-08-15   1202   $  245.48  $   19.98  $    0.00   $  265.46
  2026-08-16      1   $    0.00  $    0.00  $    0.00   $    0.00
  2026-08-17    787   $  118.91  $   51.23  $    0.00   $  170.14
  2026-08-18    333   $   55.48  $   25.31  $    0.29   $   81.07
  2026-08-19    793   $  132.32  $   65.66  $    0.00   $  197.98
  2026-08-20   1322   $  166.13  $  112.36  $    0.00   $  278.49
  2026-08-21   2232   $  366.51  $  128.43  $    0.00   $  494.95
  2026-08-22   1908   $  378.74  $   20.33  $    0.57   $  399.64
  2026-08-23    196   $   30.76  $   19.42  $    0.00   $   50.18
  2026-08-25    662   $  116.53  $   65.87  $    0.00   $  182.40
  2026-08-26    909   $  155.91  $   56.94  $    0.00   $  212.86
  2026-08-27   1437   $  135.74  $  193.09  $    0.00   $  328.82
  2026-08-28    124   $   27.53  $   11.90  $    0.00   $   39.43
  TOTAL       18476   $ 2339.47  $ 1977.46  $    4.79   $ 4321.72

LOCAL (mission ledger; real = measured tokenStats, est = per-turn fallback):
  campaign  missions(real/est)   turns  toolCalls   hours   elec$    real API$    est API$
  c1           2 (0/2)        1,119      1,090    4.75  $ 0.43   $    0.00   $  151.06
  c2           2 (0/2)          699        652    2.49  $ 0.22   $    0.00   $   94.36
  c3           4 (0/4)        1,619      1,546    6.57  $ 0.59   $    0.00   $  218.56
  c4           3 (1/2)        1,490      1,342    8.43  $ 0.76   $  140.64   $   39.15
  c5           3 (3/0)        1,378      1,167   12.61  $ 1.14   $  144.59   $    0.00
  other       40 (0/40)       18,294     29,353   68.96  $ 6.21   $    0.00   $ 2469.69
  TOTAL       54 (4/50)       24,599     35,150  103.82  $ 9.34   $  285.23   $ 2972.84

VERDICT: frontier spent $2339.47 SUPERVISING (development $1977.46 and
unattributed $4.79 are excluded — building LocalCode is not oversight).
The supervised generation would have cost ~$3258.06 on the API
($285.23 priced from measured tokens, $2972.84 still estimated)
and ran locally for ~$9.34 of power.
supervision ratio: $1 of frontier verify oversees ~$1.39 of displaced generation.
```

## Appendix B — Campaign summary table

Derived from `docs/civkings-redesign-briefs/campaign-log.md` and `benchmark/cynco-ledger/missions.*.jsonl`.

| campaign | BASE | gate sha256 | dispatches (chargeable/void) | closing wave (ledger id) | closing wave turns / tool calls | verdict |
|---|---|---|---|---|---|---|
| C1 — the sim becomes visible | 2092b0c | f2dd97feb5db182f | 2 (2/0) | c1-wave2-1787667568006 | 784 / 778 | PASS |
| C2 — the player has a stake | a418d49 | 1f6b4bc6ca740b5b | 2 (2/0) | c2-wave2-1787700776646 | 40 / 44 | PASS |
| C3 — the world pushes back | 9c4b773 | 9c0a6fbd4027a7c2 (hardened; was 90fa086ac43242e5) | 4 (3/1 — F129 void) | c3-wave3-1787773124818 | 581 / 558 | PASS |
| C4 — one living UI | 4c67cae | 05ea014c667311c7 | 3 (2/1 — F130 void) | c4-wave3-1787791284792 | 1200 / 1071 | PASS |
| C5 — the world is big | 3fc2de9 | 0c4e6b30c2178a22 (+ suite-gate gate_c5s.py) | 3 (3/0) | c5-wave3-1787875895222 | 581 / 480 (15 commits: 14 adapt + 1 fix) | PASS |
