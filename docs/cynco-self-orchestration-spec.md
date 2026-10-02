# CynCo Self-Orchestration — VSM-Staged GVS5H Adoption

**Date:** 2026-08-28
**Source evidence:** github.com/slee-persis/GVS5H + arxiv 2608.26480 ("Zero-Shot Self-Orchestration"), clone at C:/tmp/GVS5H, deep-dive of `codebase/v2-current/escalation/multiagent.py`.
**Decision (user-approved):** C is the destination architecture, built organ by organ in dependency order — A (S3\* in-loop verifier) → B (variety management) → C (metasystem). Each stage measurable on its own; C proceeds only if A+B don't already capture the gains.

---

## 1. Why

GVS5H showed our exact local model (Qwen3.8-27B) jumping 63.0% → 86.4% on LiveCodeBench Hard — matching Claude Fable 5 — using no new weights, only orchestration: five fresh-context instances of the same model coordinating through five files, with a driver-enforced verifier. Their marginal-cost worry ($51.75/pass) does not apply to us: our generation is electricity (~$3.14 for five campaigns). Iteration redundancy is nearly free locally.

Their three load-bearing mechanics map onto our three worst measured pathologies:

| GVS5H mechanic | Our pathology it answers |
|---|---|
| Sample-test verifier + hard "done" override | **F133** — "suite green" was prose; 142 broken tests rode a green run. CynCo's self-report was trusted until post-hoc gate. |
| notes.md REWRITE-not-append + size caps | **F129** — compaction; and the paper's own regression mode (−9pts, anchored degradation) shows unmanaged notes *propagate* pathology. |
| Fresh context per role, manager picks ONE task | Anchoring in monolithic contexts — C5w3 ran 581 turns in one head. |

## 2. VSM mapping (the design backbone)

| GVS5H mechanism | Beer's system | CynCo realization |
|---|---|---|
| Worker-Execute (fresh context, one task) | S1 | Stage 3: fresh-context worker sessions |
| No-progress guard, single-task dispatch | S2 | Stage 3: driver-side identical-task detector |
| Manager-Manage (curate, done/continue) | S3 | Stage 3: manager role session |
| Sample-test verifier + hard override | **S3\*** (audit channel) | **Stage 1: in-loop probe, driver-enforced** |
| Ideation worker (approaches, no code) | S4 | Stage 3: plan/ideation role |
| "Done" override on test failure | Algedonic bypass | Stage 1: marker-commit override |
| notes rewrite + caps + cut-off digest | Variety attenuation (Ashby) | Stage 2: mission workspace files |

Key structural insight from their v1→v2 history: **v1 had the manager-worker org chart and was weak; v2's gains came from adding the verifier and bounding the ledger.** The role-split adds zero requisite variety by itself (same model in every seat). Variety comes from ground-truth injection and context freshness. Hence build order: organs first, org chart last.

A second clean analogy that shapes Stage 1: GVS5H's verifier runs only **public** sample tests; the hidden LCB tests still grade the final answer. Our equivalent: the in-loop probe runs only **public** checks visible to the mission; **sealed held-out gates remain post-hoc and untouched**. Rule 11 and gate sealing are not weakened by any stage.

---

## 3. Stage 1 — S3\*: the in-loop verifier (build first)

**What:** The driver gains a *probe*: a cheap, public check command it runs during the mission and whose verbatim output it injects into CynCo's context — plus the hard override: a marker commit with a failing probe does not end the mission.

**Mechanics (all in `scripts/cynco-mission-driver.mjs` + dispatch):**

1. **New dispatch argument `probe-cmd`** (alongside the existing post-hoc `check-cmd`, driver argv position after it). Probe is chosen to be cheap — e.g., `python -m pytest gilded/tests -q --tb=no` suite count, not the full sealed chain. `CYNCO_PROBE_TIMEOUT_MS` required when a probe is given, same fail-closed pattern as `CYNCO_CHECK_TIMEOUT_MS` (driver line 125).
2. **Trigger: turn boundaries.** The engine ignores `user.message` while a turn is open (`conversationLoop.ts:872`), so mid-turn injection is impossible and mid-turn probes could never act. The probe runs where the driver's exit decision resolves (`waitExitReason` → `engine_closed_the_turn` or `quiet_heuristic`) **and** the mission has landed at least one commit — the same place GVS5H runs its verifier: between worker turns. Perf-measuring commands are forbidden as probes (wall-clock contention, C5 lesson) — stated in dispatch docs.
3. **Injection: verbatim, prefixed, over the live socket — and this IS the hard override.** On FAIL the driver sends a `user.message` (same shape as dispatch, `unattended: true`) quoting the probe's exit code and outputTail verbatim (never paraphrased — standing brief-authoring rule), and the wait loop continues instead of ending: a marker commit with a failing probe does not end the mission. On PASS, silence; the mission ends as today (green probes are recorded in the ledger only). UNMEASURED (probe timeout/spawn-fail) never overrides — a probe that said nothing cannot keep the mission alive on its say-so. If the mission socket is already closed (F131 residual) the injection is impossible; the ledger records it as blocked and the mission ends normally. Bounded by `CYNCO_MAX_PROBE_OVERRIDES` (default 3); on exhaustion the mission ends and the ledger records the probe block with `exhausted: true`.
4. **Ledger:** new `probe` block per mission row: `{ command, runs, fails, overrides, lastExit, lastVerified, exhausted, blockedBySocket }`. This is the Stage 1 measurement instrument.

**What Stage 1 does NOT do:** it never runs sealed gates, never mutates the repo (probe quarantine: run against working tree read-only; if the probe would be confused by a dirty tree that's the mission's problem and the verbatim output says so), never blocks tool calls.

**Success metric (graded on 2-3 real missions before Stage 2):** gate-FAIL-at-verdict rate vs campaign baseline (C1-C5: 5 of 12 waves MISSed at post-hoc gate), and turns-between-defect-introduced-and-fixed. F133's 142-test breakage would have been caught at first probe instead of at wave verdict.

## 4. Stage 2 — Variety management: mission workspace + rewrite discipline

**What:** Every mission gets a workspace the model must curate: `plan.md` and `notes.md` under `<mission-dir>/ws/<marker>/`, rewrite-not-append, size-capped, and used as the compaction anchor.

**Mechanics:**

1. **Brief template addition** (docs/civkings-redesign-briefs pattern + dispatch docs): mission must maintain `ws/<marker>/plan.md` (strategy, ≤4KB) and `ws/<marker>/notes.md` (current findings, ≤8KB, REWRITE each phase — "whatever you omit is gone", GVS5H's exact framing). The brief states the caps and the rewrite rule.
2. **Driver enforcement, not wishes (F133's own lesson applied to this feature):** contract assertions (via the existing sidecar mechanism, `scripts/cynco-contract.mjs`) assert at verify: both files exist, both under cap, `notes.md` modified after the midpoint commit (proof of maintenance, not write-once). Plus in-loop: when the driver's probe machinery is already waking up (Stage 1 trigger), it stats the files; over-cap → inject one verbatim warning naming the byte count.
3. **Compaction anchor (engine-side, the real F129 payoff):** when the engine compacts a mission session, it injects `plan.md` + `notes.md` contents *as authored by the model* ahead of (or instead of part of) the mechanical summary. Model-curated memory replaces lossy driver-side summarization. Engine change scoped to mission mode (`unattended: true` sessions) only.
4. **Cut-off digest:** if a turn ends truncated (finish_reason length), the engine issues one summarize call (t=0.2, GVS5H's `_summarize_cutoff` pattern: "which approach, what was established or ruled out, how far it got") and appends the digest to the next context instead of the truncated raw text. Deferred to the end of Stage 2; only built if ledger shows truncation events actually occur in missions.

**Success metric:** compaction-event count and post-compaction flail (turns of re-reading previously-read files after a compaction — measurable from toolStats sequences), context length at completion, vs baseline.

## 5. Stage 3 — The metasystem: manager-worker over the ledger

**What:** The driver becomes a small orchestrator: fresh-context roles from the same engine, coordinating through the Stage-2 workspace, consuming the Stage-1 probe signal — and logging every manager decision as governance data for the S5 fine-tune (Level 4 goal).

**Mechanics (design-level; details to the Stage-3 plan, informed by Stage 1+2 measurements):**

1. **Roles** (each a fresh engine session — requires an engine `session.reset`/`/clear`-equivalent over the bridge; if absent, that plumbing is Stage 3's first task):
   - **Manager-Plan** (t≈0.3): reads brief → writes `plan.md` + initial `tasks.json` (GVS5H schema: `{id, desc, status}`).
   - **Ideation** (t≈0.4): approaches only, no code — writes to `notes.md`.
   - **Manager-Manage** (t≈0.2): reads notes + probe verdicts + task list → curates, picks ONE task, `STATUS done|continue`.
   - **Worker** (t≈0.2): fresh context, gets plan + notes + the ONE task; executes with full tools; rewrites `notes.md`; commits.
   - Per-role temperature requires per-message sampling override through the bridge — plumbing task if absent.
2. **Driver guards (verbatim from GVS5H):** `MAX_ITERS` rounds (their 10; ours sized from Stage-1/2 mission data); **no-progress guard** — manager reissues an identical task description → stop; **hard override** — probe FAIL forces `continue` regardless of manager's `done`.
3. **Governance logging:** every Manager-Manage decision (input digest, task list before/after, chosen task, status, probe state) appended to the outcome ledger as a `decision` record. This is the role-granular training data the governance-falsification program (step 3, earned-authority S5) needs — the manager seat is the seat we eventually want the fine-tuned S5 to occupy.
4. **Sealed gates unchanged:** the whole loop is still graded post-hoc by the sealed gate; the manager never sees gate internals.

**Go/no-go:** Stage 3 is built only if Stage 1+2 metrics leave measurable headroom (waves still MISSing at verdict, or context exhaustion still occurring). If A+B close the gap, C's spec survives as the destination map and we bank the win — per the paper's own finding that gains shrink as the baseline strengthens.

## 6. Measurement plan (all stages)

Existing ledger is the instrument. Per stage, run ≥2 real missions (CivKings close-out follow-ups or Stage-6B war-verb remediation are natural candidates) and report, against the C1-C5 baseline:

- **MISS rate at sealed verdict** (baseline: 5/12 waves)
- **Turns from defect-introduced to defect-fixed** (F133 took a full extra wave: 581 turns)
- **Compaction events + post-compaction re-read flail**
- **tokenStats** (cached:prefill, completion) and wall-clock
- **probe block** stats (Stage 1+), **decision records** (Stage 3)

Report per-stage verdicts in the campaign-log style; CodeIndex adoption keeps riding along per standing directive.

## 7. Error handling & edge cases

- Probe spawn failure / timeout: recorded in ledger `probe` block, injected verbatim (a hung probe is information); never crashes the driver (same `runCheck` hardening as verify).
- Probe while mission is mid-write (dirty tree): probe runs anyway; verbatim output carries the truth. No quarantine mid-mission (quarantine stays a verify-time behavior, F132).
- Engine dies mid-override: existing teardown path (F131 reconnect-probe) unchanged.
- Workspace files deleted by the mission: contract assertion fails at verify; in-loop, driver injects one warning on first detection.
- Marker commit with probe PASS: mission ends exactly as today — Stage 1 is invisible on the happy path.

## 8. Testing

- Driver probe machinery: unit tests beside the existing driver/contract tests (`scripts/`), covering: debounce, override bounding, verbatim injection format, marker+FAIL continuation, ledger block shape.
- Contract assertions for workspace files: tests in `cynco-contract` suite.
- Engine compaction-anchor + cut-off digest: engine-side tests; visual/log verification on a live mission before relying on it (verify-before-moving-on).
- Rule 11 analog for the probe: before first real dispatch, run the probe path against a repo state known-FAILing and known-PASSing and confirm both behaviors (injection on FAIL, silence on PASS, override on marker+FAIL).

## 9. Out of scope

- No changes to sealed-gate authoring, Rule 11, or the web git flow.
- No hand-edits to civkings (all effects reach CivKings through missions, as ever).
- No model/weight changes; no new models.
- GVS5H's LiveCodeBench harness and their evaluator fix — not ported; our benchmark is the mission ledger.

## 10. Campaign runner (shipped 2026-09-17)

The self-orchestration loop above now has an unattended driver for whole
campaigns: `scripts/cynco-campaign.mjs`, run under **bun** from the localcode
repo root (`node` cannot load it — the grade module imports
`engine/cybernetics-core/src/index.ts`).

**States.** CALIBRATE runs once per invocation, before the wave loop, and only
when the gate or perturb sha256 moved or the campaign was never calibrated (Rule
11 — a refused calibration stops the run with exit 3 and an ntfy). Then, per
wave: GENERATE (brief + sidecar from the
previous wave's verbatim FAIL lines) → DISPATCH (`scripts/dispatch-mission.sh`
with the wave's mission invariants, `DRIVER_PID_FILE`, `DRIVER_LOG`,
`CYNCO_SKIP_IDLE_ENGINE=1`) → WAIT (poll the driver PID) → GRADE (sealed campaign
gate, suite no-regression gate, derived mutation sweep — handed the KEEP-GREEN
test files when the diff delivered none — F147 — per-wave POSIWID; patches
`verified` / `mutationSweep` / `gate` / `posiwid` onto the ledger row) → VERDICT
(campaign-log entry, supervision economics, local commit on `campaign/<id>`,
algedonic ntfy) → DECIDE (`pass` / `pass-with-survivors` / `next` / `budget` /
`no-progress` / `fault` / `stop`).
A harness fault anywhere past dispatch records the fault, spends the wave, and
stops the loop deliberately rather than by exception.

`pass` needs the sealed gate PASS, the suite gate green, and no mutation-sweep
survivor **inside a file the campaign claimed** (`allow.edit` / `allow.newFiles`
— spec §3.2's "a survivor a work[] item claims"). A survivor anywhere else is
reported, not punished. Claimed survivors give `pass-with-survivors`: the loop
stops, exit 0, and the verdict reads `CAMPAIGN PASS (sweep survivors: N)`.
`stop` is a refusal to dispatch rather than a spent wave — an empty FAIL set
(the grade already says PASS), a gate or perturb whose sha256 moved since
calibration (Rule 11, re-checked every wave), or a generated brief that names a
sealed instrument. Every wave record and the ledger `gate` block carry the
`gateSha256` the wave was graded with.

**One runner, one wave.** `~/.cynco/campaigns/<id>/runner.lock` holds the
runner's pid, claimed atomically (`open` with `wx`; a stale lock whose pid is
gone is removed with a log line, an unreadable one likewise). The operator's
verbs run WITHOUT the lock, because a campaign holds it for days:
`--approve-proposal` / `--reject-proposal` write their decision and
`CampaignState.save` merges it into the runner's next save (the decision on
disk wins over the runner's in-memory `pending`, and an approval carries its
authority); `--sync` pushes and opens the PR regardless, and drains the queued
ntfy notifications only when no runner is live (otherwise they drain at the
next verdict). A queued notification that still cannot be sent stays queued.
`state.inFlight` is written the moment `dispatch` returns and cleared when the
wave record is appended. A later invocation that finds `inFlight` set refuses
to start and names the driver log; `--adopt-inflight` resolves it — the ledger
line in that log adopts the row for grading, and a dead pid with no ledger line
records the wave as a fault.

**CLI.**
`bun scripts/cynco-campaign.mjs <id>.campaign.json [--waves N] [--resume]
[--dry-run] [--sync] [--approve-proposal NAME] [--reject-proposal NAME]`.
`--resume` is the default (the state directory IS the resume point); `--dry-run`
prints the brief the next wave would dispatch and exits.

**State dir.** `~/.cynco/campaigns/<id>/` — the campaign state, every wave
record, pending notifications and pending proposals. It is the only thing a
resumed run reads; nothing about a campaign lives in the process.

**`--sync`.** The runner is offline by design: it commits verdicts to the local
`campaign/<id>` branch and never touches the network mid-campaign. `--sync`
pushes that branch (a rejected push stops there and says so), opens the PR if
there is none against `spec.prBase ?? 'main'`, and drains the queued ntfy
notifications. With no network it says so and changes nothing.

**Adopt.** `bun scripts/cynco-campaign-adopt.mjs <id>.campaign.json <missionId>`
points the next wave at an existing ledger row, so a mission dispatched by hand
(or one whose runner died before grading) is GRADED instead of re-dispatched.
That is how C8 wave 1 entered the loop.

**Ideation seat (S4, advisory).** Before each brief the runner may run a one-shot
ideation pass (`scripts/cynco-ideation.mjs`) whose hypotheses enter the brief
through a `heterarchy.CommandRegistry`: the generator holds authority 1.0 on
`brief`, ideation starts at 0 — advisory only, it cannot overrule the FAIL lines.
Each wave measures `followed` (did the first commit touch the files the
hypothesis named) against `outcome.landed`. **Promotion rule:** after ≥ 8 ideated
waves, a Fisher exact test on followed × landed with p < 0.05 *and* a higher
landed rate when followed raises a data-shaped `Parameter` proposal
(`ideation/brief`, new value 0.5, bounds 0–0.5) — pushed to the owner over ntfy
and applied only by `--approve-proposal`. Earned authority, never assumed.

**Triples and the cap loop (Phase 1, 2026-09-18).** Every VERDICT regenerates
`~/.cynco/datasets/triples.jsonl` (`scripts/cynco-triples.mjs`: `denial`,
`ideation` and `wave` records joined by missionId and wave, with a
`triples.summary.json` beside it) and runs
`scripts/cynco-signal-validation.mjs --denials` over it: per invariant, were the
denials followed by the call they asked for more often than the session's own
quiet rate (Fisher, Wilson, Holm across the two caps)? The verdict entry prints
the table; the next brief's PACING quotes last wave's follow-up and the campaign
digest. An INERT cap (≥ 30 denials, compliance below the quiet rate at p < 0.05
corrected) raises a data-shaped Parameter proposal `invariants/<cap>` (× 1.5,
bounded by [spec, 2 × spec]); `--approve-proposal invariants/<cap>` records an
override and `effectiveInvariants(spec, state)` is what DISPATCH hands the driver
from then on. The revert ban is identity and is only ever reported. At earned
ideation authority (0.5) the advisor's `order` reorders THE WORK's failing items
(`s4.workOrder` on the wave record says whether it did); gate lines and rules are
never touched.

**Phase 2 — the viable wave (2026-09-22).** Six changes make a wave observable
and make the regulator informative instead of merely prohibitive. Every one of
them is data or a refusal: nothing in the loop branches on a model-internal
number except the one router named below.

- **Governance-level POSIWID** (`scripts/cynco-governance-posiwid.mjs`) —
  retires the deferred item of the same name. Each VERDICT turns POSIWID on the
  governance layer itself: `GOVERNANCE_PURPOSE` states "regulate" as
  `denialsChanged` 0.5 + `recommendationsConsumed` 0.5, and gives
  `signalsLogged` no share at all, so a wave the layer spent logging reads
  `Contradicted` by construction. `governanceCounts({ row, wave,
  proposalsDecided })` reads those three counts off the graded ledger row and
  the wave record (denials whose next call complied; enforced S5 decisions,
  followed ideation, an applied work order, decided proposals and routed calls
  the model then complied with; every other S5 decision and control signal).
  Turns are not a signal (Phase 3 ruling 13): a status frame is not the
  governance layer logging anything about itself, so `signalsLogged` excludes
  `turns[]`. Every wave's window is replayed through a fresh `PosiwidDrift`, so the
  onset wave is a function of the stored windows and a runner restart cannot
  move it. `driftThreshold` is **0.5**, not the naive 0.1: the zero-share
  `signalsLogged` bucket gives the implicit `other` mass a near-zero
  expectation, and KL blows up on any logging at all — the module states the
  reference arithmetic. The reading lands on the wave record as
  `governancePosiwid` (`{ verdict, divergence, dominantObserved, support,
  onsetWave, windows, counts }`) and prints as the verdict entry's "Governance
  POSIWID" line.
- **The brain lens** (`engine/brain/layerConvergence.ts`,
  `engine/brain/activationsConsumer.ts`). `convergenceOf` scores each probed
  layer's top token against the deepest probed layer's; `ConvergenceAccumulator`
  folds that per position and per turn. The consumer is tier-gated — `live`
  reads out all five probed layers (`LLAMA_ACTIVATIONS_LAYERS`, default
  24,32,40,48,56, served by the J-lens sidecar on 9163), `record-only` records
  without the readout — and warns once if the tap's layer list disagrees with
  the requested one. Layer convergence and tool-token entropy ride
  `governance.status.brain` as **data only**.
- **The brain on the ledger** (`scripts/cynco-ledger.mjs`). Every turn keeps its
  `brain` frame verbatim (`turns[].brain`) and the row carries the fold,
  `brainStats` (`tier`, `turnsWithLens`, `meanAgree`, `meanDepth`,
  `meanToolEntropy`). `scripts/cynco-signal-validation.mjs --signals` is what
  asks whether any of it predicts an outcome: `signalQuartiles` cuts
  `meanAgree`/`meanToolEntropy` at quartiles over the labeled rows,
  `signalsFired` turns a row into the candidate signals `LC-low`, `LC-high`,
  `TE-high`, and they go through the same `analyse()` every S5 rule id does.
  The thresholds live in that one file — never in the engine, never in the
  ledger. `scripts/dispatch-mission.sh` waits up to 60 s for the lens's health
  endpoint so a mission does not silently grade itself `record-only`.
- **KEEP-GREEN as a contract role** (`engine/tools/contract.ts`,
  `engine/tools/contractVerify.ts`). The sidecar assertion the dispatcher
  derives from the mission's check-cmd now carries `role: 'keep-green'`
  (`scripts/cynco-brief.mjs` `sidecarFor` sets it; `scripts/cynco-contract.mjs`
  `toAssertion` refuses any other role), `ContractState.byRole` finds it, and
  `runCommandDetailed` keeps the output tail so a verdict can quote the
  measurement rather than assert it.
- **Verify-first routing** (`engine/vsm/verifyFirst.ts`). The gate ladder's
  second verb. Two call shapes route through KEEP-GREEN: a `revert` is still
  refused — the revert ban is identity and is never lifted — but the refusal
  first runs the mission's own check command, so the sentence the model reads
  says whether there is anything to undo; a `low-confidence-edit` (the model was
  uncertain at the moment it emitted the call) is executed and THEN measured,
  with the verdict appended to the result it reads next. `VerifyFirstRouter`
  exists only while `missionInvariants` are armed, spends at most 6 KEEP-GREEN
  runs per mission, serves a verdict younger than 5 tool calls from cache, caps
  a routed run at 300 s, and routes at most one low-confidence edit per model
  iteration. `VerifyFirstRouter.isLowConfidence` (`engine/vsm/verifyFirst.ts`)
  and the inline `inv.invariant === 'revert' && this.verifyFirst` branch in
  `conversationLoop.ts` are the only places in the loop that read convergence or
  entropy. (Earlier drafts of this section named a single `shouldRoute`; the
  shipped shape is those two call sites. Ruling 5 holds in substance.) Past the budget it answers `budget-exhausted` — recorded, never
  silent. The ledger keeps `routing.{budget,used,count,byKind,byOutcome,entries}`,
  and each entry's `nextCallClass` is the outcome record: the evidence for
  whether an informed refusal changes behaviour where a bare refusal does not.
- **Operator notes** (`engine/bridge/conversationLoop.ts`) — the unattended
  mission gains an ear. A `user.message` frame arriving on the dashboard socket
  while an unattended mission runs is queued (cap 5 in flight) instead of
  dropped, and delivered at the top of the next model iteration. The engine
  emits `mission.operator_note` twice — `queued`, then the outcome — plus a
  `governance.alert` with `source: 'operator'`; the ledger's `operatorNotes[]`
  keys by frame kind and ends every note in exactly one of
  `deliveredAtIteration`, `dropped: "queue full"`, or `dropped: "mission ended"`.
  A note still queued when the mission ends is reported and cleared, never
  carried into the next session.
- **The dashboard readout** (`engine/dashboard/server.ts`,
  `engine/dashboard/index.html`) — retires the "Dashboard readout of edit-only
  state" deferred item. The Governance panel on 9161 now shows the mission
  invariants (configuration, calls since the last source edit and commit against
  their caps, and denials split by invariant — the engine's edit-only state,
  live), the engine's own POSIWID verdict, the ultrastable margin, brain-tier
  layer convergence, and verify-first routing. A Campaign panel appears whenever
  `~/.cynco/campaigns` holds a campaign, fed by `GET /api/campaign` (inference
  scope, rebuilt per poll, isolated per campaign so one bad state file cannot
  wipe the others) with each campaign's wave count, pending proposals and last
  wave's `governancePosiwid`. `CYNCO_CAMPAIGN_ID` reaches the engine through
  `scripts/dispatch-mission.sh` and the runner's `dispatchEnv`, so the panel can
  say which campaign the running mission belongs to.

**Phase 3 — gate authoring (shipped 2026-09-23).** Every campaign so far was
measured against a bar a human wrote. Phase 3 gives the loop the other half:
CynCo writes the next campaign's gate itself, and the runner refuses to believe
it without an acceptance test. The bar is still sealed by a decision — what
changed is who drafts it, and what evidence that seat has to produce before its
draft counts. The live proof of this seat on the C9 line ended without a seal
after nine attempts — the seat produced a mechanically clean but non-measuring
triple, and then a supervisor-refused resume that never made the one-line
perturb-header edit named across four operator notes — with the roadmap line
c9 staying `authoring` and no C9 campaign started (see the "Campaign C9" entry
in `docs/civkings-redesign-briefs/campaign-log.md` and F156 in
`docs/cynco-failure-log.md`).

- **The seat.** `gate` is a `heterarchy.CommandRegistry` context like `brief`
  is (`scripts/cynco-ideation.mjs`): `supervisor` holds 1.0, `gate-author`
  starts at **0** and is bounded at **0.5** (ruling 2 — the gate-author never
  holds the binding seat). At 0 the seat drafts and a human approves. The only
  thing 0.5 buys is the auto-seal branch described below; it never buys a bar
  nobody can refuse.
- **The verbs.**
  `bun scripts/cynco-campaign.mjs <id>.campaign.json --author <id>` runs one
  authoring mission start to verdict. It is routed by the campaign id BEFORE
  the spec is loaded, because the spec is what the mission is being asked to
  write — the `.campaign.json` does not exist yet. It refuses a line that is
  not `open`/`authoring`, and refuses a line that jumps ahead of an earlier
  line still in flight (`nextOpenLine`: `open`, `authoring` or `proposed` — a
  proposed gate is not sealed, so it is not in the heldout tree the next line's
  `C<N>.9` sibling is mirrored from): the roadmap is authored in order,
  because each gate is drafted against the previous campaign's as exemplar.
  Both refusals happen before anything is dispatched and exit **2**; a check
  that ran and raised no proposal (refused, or a fault) exits **1**.
  `bun scripts/cynco-gate-author.mjs --check <stagingDir> <baseDir>` is the
  acceptance test on its own (exit 0/1, every problem printed); the mission is
  told to run it and the driver runs the same string as the mission's
  KEEP-GREEN assertion. `--approve-proposal gate/<id>` seals the triple into
  the sealed tree and writes the campaign spec. At earned authority 0.5
  `authorCampaign` takes that same branch itself and records
  `decidedBy: 'auto'` — every check inside `sealGate` still runs, and a refused
  seal leaves the proposal pending exactly as a refused human approval does.
- **The staging tree.** `~/.cynco/authoring/<id>/` is a git repo with a local
  identity pinned (a repo with no identity refuses every commit, and the
  mission is ORDERED to commit after each cut — that commit is its only
  backup). Beside it, `~/.cynco/authoring/<x>/` mirrors every finished
  campaign's gate/perturb/positive out of the sealed heldout tree, so the
  author reads real exemplars without being handed the heldout directory
  itself. The game at the line's pinned BASE is archived read-only to
  `C:/tmp/<id>_author_base`; the gate under test reads it through
  `CYNCO_GATE_REPO` and never its own directory.
- **The acceptance test** (`checkStaged`) is Rule 11 and Rule 14 run
  mechanically, plus lint. Lint: ids shaped `C<N>.<k>[a-z].<slug>`, unique, and
  at least one of them (the lint has no count minimum — it refuses a gate that
  grades nothing; the count floor is calibration's `GATE_MIN_LINES = 8`, and the
  unrelated `GATE_AUTHOR_MIN_LINES = 30` is the seat's promotion floor over
  terminal gate LINES, not a property of any one gate). Also: the gate reads
  `CYNCO_GATE_REPO`, a
  `C<N>.9` prior-campaign regression line that honours `CYNCO_GATE_SKIP_PRIOR`,
  both shims `runpy.run_path` the real gate and set skip-prior, the perturb
  header names only real line ids and declares a non-empty MUST-FAIL set, no
  network import anywhere, and a `GATE: PASS` / `GATE: MISS (n fails)`
  terminator. Calibration: the gate must MISS on the BASE **by absence** with
  zero errors, every base fail classified, the perturb's flips a subset of
  EXPECT-FLIP with every MUST-FAIL still failing, and the positive shim must
  reach `GATE: PASS` — a bar nothing can pass is not a bar. The runner re-runs
  all of it from its own side after the mission returns: the driver ran the
  check too, but it ran it in a process the mission could have reached, so only
  the runner's reading raises the proposal. **That reading IS the verdict, and
  `verified` is not** (controller ruling, amending §4). `verified` is the driver's
  advisory check, and for an authoring mission it is structurally `null`: the run
  cannot go quiet, so the driver warns that its gate and the mission are racing
  for the same tree and records nothing. Gating the proposal on it made a green
  bar unproposable by construction — live attempt 7 passed the driver's check
  (exit 0, 277 s, `GATE: PASS`) and the runner's re-check (ok, 11 graded lines)
  and was refused with "the mission produced no verified check result".
  `verified` is recorded on the row and printed; nothing hangs off it. A missing
  ledger row is likewise reported, not refused over — the triple on disk is the
  thing being graded — and `lastCheck.kind` separates a `fault` (the instrument
  did not run; the triple is UNGRADED) from a `refused` (it ran; the triple is
  not a bar), because those are different next moves. A resume whose staged
  triple already passes raises the proposal WITHOUT dispatching a mission: the
  reading is the same subprocess check, so the evidence is identical and the
  four hours are not spent. That re-run is a SUBPROCESS —
  `bun <abs path>/cynco-gate-author.mjs --check <staging> <base>`, its verdict
  read from the exit code and the `[check-json]` line — never an in-process
  `calibrate`. F155: the runner's first spawn comes four hours after its last
  one, and under bun on Windows a `spawnSync` after an idle gap inherits the
  previous call's deadline and is killed in milliseconds, which turned a triple
  with two problems into a verdict of eleven. The subprocess runs the harness's
  OWN code, and that code is not sealed: `cynco-gate-author.mjs` and its static
  `scripts/` imports (lint, parse, calibrate, grade, spawn, … — `harnessClosure`
  derives the list from the source) are writable by any mission with Bash. So
  `authorCampaign` fingerprints that closure at dispatch
  (`state.authoring.<id>.harnessSha256` + `harnessFiles`) and the re-check
  re-takes it before running: a closure that moved is `harness dirty: <files>`,
  `lastCheck.kind: 'fault'` with `harnessDirty: true`, nothing is run and no
  proposal is raised. The closure also follows `../engine/` imports (`.js`
  resolved to `.ts`/`.tsx`, bounded to the repo root, `node_modules` skipped):
  the engine modules `--check` loads (`engine/paths`,
  `engine/bridge/contractAutoCreate`, `engine/tools/contractVerify` and what they
  import, `engine/cybernetics-core`) run their top-level code in the subprocess,
  so since Phase 4 they are hashed under their repo-relative paths — the Phase 3
  residual that stopped the walk at `scripts/` is closed. The walk follows
  static relative `import` / `export … from` only: dynamic `import()`,
  `require()` and bare/package specifiers are not followed (none occur in the
  engine files it reaches today), and every followed path must stay under the
  repo root on both branches. Residual (final
  re-review): a harness edit that the operator does not restore
  before the next `--author` becomes that dispatch's baseline (the fault names
  the files first). A resume whose staged triple passes does not propose from
  disk if the closure moved since the dispatch that produced it — it dispatches
  under a fingerprint of its own. The driver's own run of the check has no such
  hook (it runs a command string); it stays advisory.
- **The budget.** 1200 iterations, and four hours for a fresh authoring but
  **two** for a resume (`AUTHOR_RESUME_TIMEOUT_S`, from attempt 2 on). A resume
  opens a staged triple, a brief naming exactly what the check refuses, and the
  package map below; attempts 4 and 5 each spent four hours with three of the four
  files already finished, attempt 5 spending 436 of its 449 tool calls inspecting.
  The brief states whichever budget it was given.
- **The package map.** THE GAME AT BASE carries a generated `PACKAGE MAP` — the
  sorted `.py` names of `gilded/` and `gilded/ui/` plus the importable
  subpackages, read off the BASE archive with `io.listDir`, never authored — and
  the sentence "There is no `gilded.ui.views`. Import only modules named here."
  Four live attempts died on a positive shim importing that module; the model
  named the problem correctly each time, was shown the traceback, and wrote the
  import again. A listing of what exists is a different instrument from a
  statement about what does not.
- **The authoring mission's invariants.** `editGapCap 120`, `commitGapCap 150`,
  `revertBan`, `codeIndexFirst`. The edit gap is three times a wave's because the
  work is three parts audit to one part writing: the mission's job is to read a
  game it may not touch until it knows what is absent, and at 40 the live C9 run
  spent iterations arguing with `[invariant] DENIED (edit-gap)`
  (`maxCallsWithoutSourceEdit 194`, 67 tool errors in 474 calls). That 120 is
  the authoring mission's envelope only: the campaign spec `draftToSpec` seals
  carries `WORKER_INVARIANTS` (`editGapCap 40`, `commitGapCap 150`, `revertBan`,
  `codeIndexFirst` — c8's measured values), because a worker wave inheriting
  the author's tripled edit gap would be the runner loosening the campaign the
  gate is grading.
- **Learnings-db isolation (ruling 12).** AWM promotion fires when a contract
  passes, and an authoring mission's contract will pass. Its learnings go to
  `<stagingDir>/learnings.db`, a database the campaign worker never opens —
  otherwise the author of the bar would be whispering to the subject.
- **The roadmap.** `docs/civkings-redesign-briefs/roadmap.json` is the line of
  campaigns and the only place a line's status lives: `open → authoring →
  proposed → sealed → running → done`, forward only (`setLineStatus` throws on
  a backward move) with exactly ONE permitted exception: `rejectLine`, which
  moves a `proposed` line back to `authoring` when the supervisor refuses the
  seal. `bun scripts/cynco-campaign.mjs --reject-proposal gate/<id> --note
  <file>` records the decision (`rejected`, `decidedBy: 'supervisor'`), calls
  `rejectLine` and saves the roadmap — without it a DO-NOT-SEAL verdict would
  leave the gate neither sealable nor re-authorable, and every later line held
  behind it — and, when `--note` is given, appends `{ at, by: 'supervisor',
  notePath }` to `state.authoring.<id>.refusals`. The note is recorded by path,
  not copied. The next `--author <id>` (with or without its own `--note`; the
  last recorded note stays active) is a POST-REFUSAL RESUME — provided the note
  file can be read; an unreadable one is printed as an error and the resume
  runs as an ordinary one: the note's text
  goes into the brief as the supervisor's refusal, the resume gets the full
  four-hour budget (`AUTHOR_TIMEOUT_S`, not `AUTHOR_RESUME_TIMEOUT_S` — a refused
  seal is a re-authoring of what the gate means, not a shim fix), and it always
  DISPATCHES: a staged triple that still passes the check is not proposed from
  disk, because passing the mechanical check is exactly what the refusal
  disputes. Each line carries the `base` commit its gate is calibrated
  against. A failed check leaves the line at `authoring` with the problems on
  `state.authoring.<id>.lastCheck`, and the next `--author <id>` resumes into
  the same staging dir with a PREVIOUS CHECK OUTPUT section in the brief. That
  section carries the live problems (presence claims re-derived against the dir,
  so a resume is never told a file it has is missing), the positive shim's output
  tail, the graded ids the shim leaves FAILing, and whether the last run's
  preserved uncommitted patch was re-applied — or why it was not.
- **The readout.** `GET /api/campaign` carries `roadmap`, `authoring` and any
  `gate/<id>` proposal with the command that approves it.

**Phase 3 evidence — the graded gate LINE (2026-09-23).** The gate-author seat
cannot earn authority one campaign at a time: a campaign is a single draw, and
at that rate the seat would be measurable around 2030. The unit is the graded
gate line — one falsifiable claim, 9–17 per campaign — and the question asked of
it is whether the line the author sealed survived the campaign it was written
for. `scripts/cynco-gate-lines.mjs` builds one row per (campaign, line) into
`~/.cynco/datasets/gate-lines.jsonl` at every verdict, with the outcome `held`
(the campaign reached a decision and nothing rewrote the line), `resealed` (the
line's printed text changed after the calibration that sealed it) or `open` (no
decision yet — not evidence). `resealed` is the falsifier the whole claim rests
on, so the runner records it where it is the only moment it is observable: at
CALIBRATE, from the calibration it is about to overwrite (`recordReseal`,
`state.reseals`), whether or not anyone wanted it recorded. `gate.author` on the
wave record is the join key. `bun scripts/cynco-signal-validation.mjs
--gate-lines` prints the table, the verdict entry prints its own line, and
ruling 11's promotion (`gateAuthorPromotion`) reads exactly that summary: ≥ 30
terminal CynCo lines, a Wilson lower bound on the held rate ≥ 0.8, and not
significantly worse than the human seat (Fisher, one direction only — a seat
significantly BETTER must not be refused by its own evidence). It raises
`gate-author/gate` (0 → 0.5, bounded), which the owner approves like any other.
The dataset holds sealed lines only, and that is an evidence gap recorded here
rather than closed: a supervisor refusal never reaches `gate-lines.jsonl`;
gate-level outcomes are Phase 4. A refused `gate/<id>` lives on the proposal
record and in `state.authoring.<id>.refusals`, where no promotion reads it (F156).
What that 0.5 buys is one branch: `authorCampaign` seals its own gate instead of
waiting for `--approve-proposal gate/<id>`, and records the decision as
`decidedBy: 'auto'`. Every check inside `sealGate` still runs — a refused seal
leaves the proposal pending exactly as a refused human approval does. The
promotion is approved into the state of the campaign that gathered the evidence
while the seal happens inside the campaign being authored, which is always
fresh, so the seat's authority is the highest approved in any campaign's state;
a per-seat retained-configuration store is Phase 4.

**Phase 4 — autopoiesis (shipped 2026-09-25).** Phases 1–3 gave the loop its
instruments: a sealed gate, a graded line, an authoring seat measured at the
line. Phase 4 asks the question those instruments exist for — does the campaign
loop produce and maintain itself — and answers it the only way this project
accepts: as measured facts on the wave record, with nothing gaining authority
by assertion. (Numbering: this is the mission prompt's Phase 4;
`docs/STATE-AND-VISION-2026-07-12.md` calls the same programme Phase 8.)

- **One identity set.** `scripts/cynco-identity.mjs` names the four invariants
  that make a campaign a campaign, and checks exactly this for each (the
  `evidence[name].detail` string says which half held or broke):
  `gate-sealed` — the spec's `gate` and `perturb` paths (and `positive` when
  it names one) lie under `~/.cynco/heldout/`, the spec loader's
  `checkIdentity(spec)` passes, and a row that reports a sealed count reports
  ≥ 1 (no row carries one today, so the detail reads "no sealed count on
  row"); it does NOT re-hash the instruments — that is the runner's
  pre-dispatch Rule 11 step, which `rule-11` records. `rule-11` — a
  calibration is on record (`state.calibration.gateSha256`) and
  `state.rule11CheckedWave` equals this wave, i.e. the runner's pre-dispatch
  re-check of the gate/perturb/positive shas against that calibration ran for
  THIS wave (a moved instrument stops the wave before dispatch). `revert-refused`
  — `spec.invariants.revertBan` is `true` AND the effective invariants the wave
  was handed (spec plus approved overrides) still carry it; it reads the
  configuration, not the worker's refusals. `marker-recorded` — the spec names
  a non-empty marker and the ledger row HAS a `markerSeen` field; `false` or
  `null` pass ("not seen" is a recorded reading), only an absent field fails.
  Outside a verdict (no wave, no row) the wave-bound halves are not asked.
  `assertIdentityIntact` runs at every VERDICT — `rec.identity` on the wave
  record, an `Identity:` line in the entry — and a violation is a decision
  fault: the wave records `fault` and no proposal is raised.
  (`rule11CheckedWave` is set BEFORE dispatch, once the sha re-check passes,
  and nothing unsets it — a violation does not rewind it.) It runs again, with
  no wave and no row, before every operator `--approve-proposal` /
  `--reject-proposal` decision — except `--approve-proposal gate/<id>` and the
  gate-author seat's auto-seal, the recorded exception: no campaign spec
  exists yet to assert against, and `sealGate` runs `checkIdentity` on the
  staged triple itself. `refusesIdentity(name)` refuses any proposal whose
  family names an identity invariant — the loop may change its caps, its
  briefs and its gates, never what makes it itself.
- **Every configuration change is a proposal.** `scripts/cynco-proposals.mjs`
  owns `applyProposalDecision` and the families (`ideation/brief`,
  `gate-author/gate`, `invariants/<cap>`, `gate/<id>`); the guard
  `engine/__tests__/guards/proposalWriters.test.ts` fails when any other
  module under `scripts/` writes `invariantOverrides`, `ideationAuthority`,
  `gateAuthorAuthority` or the seats store. Seat authorities now live in
  `~/.cynco/retained/seats.json` (`{ schema, version, seats: { ideation,
  'gate-author' }, history }`), written on every approved promotion and read
  as the max of the store and the campaign states (`effectiveSeatAuthority`) —
  the Phase 3 residual where a seat's authority was the highest approved in
  any campaign's state is closed by a store that only rises. The engine's
  session-level `AutopoiesisIntegration` proposal log is NOT on the ledger row
  (ruling 7, amended at the wire check): `proposeParameterChange` has no
  production caller, so the field would read zero on every row; it is wired
  the day a parameter change is routed through it.
- **Earned per-rule S5 authority.** The VERDICT writes
  `~/.cynco/datasets/rule-verdicts.json` (`scripts/cynco-rule-verdicts.mjs`:
  per rule, the Fisher/Holm verdict, precision, CI, p, n; a version that moves
  only when a verdict changes). `engine/s5/ruleAuthority.ts` loads it once at
  engine construction: a rule whose verdict is `PREDICTIVE` is `earned` and its
  decision is enforced; any other rule is `advisory` and its decision is
  emitted but not applied; no file at all is `legacy` — the pre-Phase-4
  behaviour, named in one log line, `[s5] rule authority: …`.
  `LOCALCODE_S5_ENFORCE=false` caps everything at advisory. Every
  `s5.decision` frame and every ledger `s5Decisions[]` entry carries
  `authority` and `source` (`stuck-reeval` for the live re-evaluation, null
  for the per-message decision), and `governance.recommendation` omits
  `autoApplyAfterMs` for an advisory rule, so the TUI cannot auto-apply what
  the evidence has not earned. The training export (`exportViableExamples`)
  consumes only decisions by earned rules and prints what it excluded. Two
  leaks closed on the way: the stuck-loop live re-evaluation narrowed tools in
  capped missions without the enforcement flag and without a frame (F157,
  `engine/bridge/s5Restriction.ts`); and `governance.session_fidelity` rode
  only the natural turn end, so 279 of 280 ledger rows carried
  `identityGuard: null` (F158; one emit per user message on every exit path).
  Read plainly: the first VERDICT after this ships writes the verdict file,
  and from then on every S5 decision under that home is advisory until a rule
  earns PREDICTIVE — 0 of 8 do today. Deleting the file restores legacy
  behaviour. Headless missions no longer get the silent C7 narrowing. A
  long-lived interactive engine keeps the reading it loaded at construction;
  missions get fresh engines and read the latest. And one more, because it
  bounds the whole ladder: `scripts/dispatch-mission.sh` pins
  `LOCALCODE_S5_ENFORCE=false` for every mission, so inside a campaign wave
  an earned rule is still advisory — earned authority reaches the interactive
  engine today, and reaches missions only when that pin is lifted, which is a
  decision for the evidence, not for this phase.
- **The campaign checklist.** `scripts/cynco-autopoiesis.mjs`
  `campaignAssessment` maps Maturana/Varela's six criteria to facts the
  runner already has: `hasBoundary` (identity intact this wave),
  `boundarySelfProduced` (`spec.author === 'cynco'`), `internalProduction`
  (≥ 1 commit landed this wave), `circularProduction` (the denial analysis ran
  AND raised an `invariants/<cap>` proposal, or a pacing digest reached a
  brief), `organizationallyClosed` (the campaign's `ProductionNetwork` — the
  vendored core's, never edited — reports closure over
  wave→ledger→validation→proposal→configuration→brief→wave) and
  `organizationMaintained` (identity intact on every wave AND
  `identityGuard.passed` on every ledger row of the campaign — STRICT: a wave
  or row without a reading is not maintained, so every pre-Phase-4 campaign
  reads false, honestly). The result is `rec.autopoiesis = { criteria,
  isAutopoietic, missing, network, facts }` on the wave record, an
  `Autopoiesis:` line in the verdict entry, a dashboard row, and
  `bun scripts/cynco-campaign.mjs <id>.campaign.json --autopoiesis` as a dry
  report; `criteriaFromFacts` re-derives a reading from the stored facts. It
  runs after the proposal step (a proposal raised this wave counts) and never
  faults a wave — `assessError` is recorded instead.
- **Retained configurations persist.** `engine/vsm/retainedConfigStore.ts`
  writes `~/.cynco/retained/<instance>.json` (`{ schema: 1, instance, version,
  updatedAt, retained, history }`, history capped at 20) for the two
  ultrastable instances, `session-feedback` (the retained table of
  `FeedbackControlIntegration`'s ultrastable system,
  `engine/vsm/feedbackControl.ts` — only its save SITE, at session end in
  `conversationLoop.ts`, sits beside `toolScorer.save`) and `mission-invariants`
  (saved at the end of every message while a mission is armed). The version
  moves only when the table changes, and an empty table writes nothing —
  `retainedVersion: null` on the row means nothing has ever been retained,
  not that the store failed. A fresh engine imports both
  (`importRetainedFrom`) silently — a `[retained]` log line is always a
  FAILED import, named — the ledger row carries `ultrastable.retained` and
  `retainedVersion`, and the dashboard shows the versions. Nothing acts on them yet: the homeostat strategies are unchanged,
  no `Habituated` step, no value applied — persistence is the prerequisite,
  application is the next phase's measured decision.
- **Phase 3 residuals closed.** (a) `~/.cynco/datasets/gate-outcomes.jsonl`,
  one row per authored or sealed gate (`{ campaign, author, outcome: refused |
  sealed | held | resealed, refusals, attempts, sealedAt }`), written by
  `exportGateOutcomes` at every VERDICT and printed as a GATES table by
  `--gate-lines` — a supervisor refusal is now evidence a promotion can read
  (F156's gap). (b) `harnessClosure` follows `../engine/` imports (above).
  (c) lint and calibration problems carry `file:line` and the seat's resume
  brief prints them.
- **The live proof, and what it cost.** The one-wave smoke campaign `s1`
  (`scripts/cynco-smoke-campaign.mjs`: an 8-line sealed gate over files a
  mission can honestly create in the Phase 2 smoke repo, an honest positive
  shim, a cheat perturb) ran under `CYNCO_HOME=C:/tmp/cynco-home-s1/.cynco` —
  the first campaign ever run outside the real home — and found three harness
  defects before the model wrote a line: the grader's suite gate resolved
  under `homedir()` (F159), the runner's bare `bash` was the WSL launcher when
  the runner was started from PowerShell (F160), and the engine's runtime
  assets — binary and GGUF — resolve under the home too, so the engine
  reached for GitHub, while its profiles followed `HOME` instead and so came
  from the operator's real home (F161; the binary and GGUF are now named by
  path on the spec as `env` — exactly those two keys — the profiles dir
  follows `CYNCO_HOME`, never a junction anywhere). The third launch: CALIBRATE `BASE MISS 8, perturb
  honest`; the mission landed two commits in 16 tool calls and 91 s; the
  sealed gate PASSed all 9 lines at HEAD, the suite gate PASSed, the derived
  sweep left 2 survivors (`calc.py:13:cmp->NotEq`, `calc.py:14:const->2`), so
  the decision was `pass-with-survivors`. The wave record read `identity:
  { intact: true }` with all four invariants' evidence, `autopoiesis:
  { isAutopoietic: false, missing: [boundarySelfProduced, circularProduction,
  organizationallyClosed] }` (a human-authored gate, no denial-driven
  proposal, a network with `gate`, `brief`, `proposal`, `configuration`
  unproduced — 3 of 6, honestly), and `ruleVerdicts: { version: 1,
  predictive: [], total: 8 }`; `rule-verdicts.json` v1 holds 8 rules, none
  PREDICTIVE (I4 CONSTANT, I1/I3/W7/W8 NO EVIDENCE, C2/C4/W6 TOO FEW);
  `gate-outcomes.jsonl` gained `{ campaign: s1, author: human, outcome: held }`;
  no seats store was written (no promotion); no retained store was written
  (both tables empty after a 91 s mission — `retained: {}`,
  `retainedVersion: null` on the row). The mission's engine logged
  `[s5] rule authority: legacy (no verdict file at
  C:\tmp\cynco-home-s1\.cynco\datasets\rule-verdicts.json)` and its one S5
  decision landed with `authority: legacy`. A second five-minute session under
  the same home logged `[s5] rule authority: earned (0 predictive of 8)`, the
  driver saw the engine declare `s5-advisory`, and its S5 decision landed
  with `authority: advisory`, `enforced: false`. Both rows carry
  `identityGuard: { passed: true }` (F158). The synthetic rows and the
  `campaign/s1` verdict commit were removed afterwards; the temp home is kept
  as evidence, and the smoke repo's `master` was left where the two sessions
  put it (four commits past the fixture's pinned BASE `1b00179`, which is why
  the fixture names its BASE instead of reading HEAD).

**Phase 5 — the evidence engine (shipped 2026-09-26).** Phase 4 made every
reading a measured fact; Phase 5 moves the ledger's numbers by running the
loop and measuring it, not by adding organs
(`docs/superpowers/specs/2026-09-26-evidence-engine-phase5-design.md`, rulings
1–10). Three deliverables: the scoreboard, the first learner entering the
authority ladder honestly, and C9 sealed and ready for the runner.

- **The scoreboard.** `scripts/cynco-scoreboard.mjs`, one pure module with one
  spelling of each definition, read by every VERDICT (the entry's
  `- Scoreboard:` line and `rec.scoreboard` on the wave record — fault records
  included, since the Task 7 fix: a trailing fault no longer undercounts the
  dashboard's waves), by `bun scripts/cynco-campaign.mjs <spec> --scoreboard`,
  by `GET /api/campaign` and the dashboard's Campaign panel (a lazy import;
  engine start does not depend on a scripts module). Per campaign and pooled
  over RUNNER-DRIVEN campaigns. The definitions, verbatim from
  `benchmark/cynco-ledger/README.md` ("Scoreboard"):
  - `passRatePerGpuHour` = decided-PASS campaigns (`pass` or `pass-with-survivors`) ÷ Σ `durationS`/3600 over every wave of every runner-driven campaign. Per campaign: `decision === PASS ? 1 : 0` ÷ that campaign's GPU-hours; an undecided campaign prints `open`.
  - `wavesPerCampaign` = waves to the decision; undecided campaigns print `N so far (open)` and are excluded from the pooled mean.
  - `gateLinesFixedPerLandedWave` = Σ over waves with ≥ 1 landed commit of max(0, failsBefore − failsAfter) ÷ the number of such waves, where failsBefore is the previous wave's `gate.fails.length` (wave 1: `calibration.baseFails.length`) and failsAfter is this wave's. A wave that graded no gate (fault) is excluded and counted.
  - `humanInterventionsPerWave` = (operator notes delivered + proposals with `decidedBy` ≠ `auto` + supervisor refusals + reseals + `--adopt-inflight` records) ÷ waves. This is the stated PROXY for "supervisor minutes per wave": minutes are not recorded anywhere, so the count of human acts is what can be measured; the economics script's supervision dollars per wave print beside it.
  - `perRulePrecision` = from `rule-verdicts.json`: predictive count ÷ total, and the single best rule with its precision, CI and verdict.

  Two readings the definitions needed on contact with the records: the rules
  counted are the S5 rules only (`source !== 'model'`) — the learner's `M1.*`
  rows share the file but are not rules, and the best of them is the sibling
  field `perRulePrecision.learner`; and a fault record carries `durationS`
  (the row's when one was read, else the wall clock since `dispatchedAt`,
  marked `durationFrom: 'wall-clock'`), because one no-row fault without it
  would null the pooled PASS/GPU-h for good. A wall-clock hour is an upper
  bound, so a rate over one is a floor: the board carries
  `gpuHoursUpperBound` and `passRatePerGpuHourIsLowerBound`, names the wave in
  `unmeasured`, and every reader prints `PASS/GPU-h ≥ …` (final review I2). The wave record gained the
  per-wave inputs: `durationS`, `outcome.commitsLanded` (the runner's
  `commitsBetween` count, NOT `toolStats.commits`) and `adopted`. For C8,
  reproduced from the campaign log: `PASS/GPU-h 0.065 | waves 3 | lines fixed
  per landed wave 4.67 | human interventions per wave 0.33 | rules predictive
  0/8 (best I3 58% NO EVIDENCE)`. Unmeasured is `null` with its reason (F16).
- **The roadmap moves itself.** The runner's first dispatch of a `sealed`
  line moves it to `running`; a PASS decision moves it to `done` just before
  the verdict commit, after every step that can throw (`moveRoadmapLine`,
  forward-only, `scripts/cynco-campaign.mjs`; final review I1 — a `done`
  written earlier could outlive a fault), and the moved `roadmap.json` joins
  that wave's commit — the verdict's, or the fault path's when a later step
  throws — so the dirty-tree guard never sees it as foreign work. The roadmap
  path is repo-relative (`docs/civkings-redesign-briefs/roadmap.json`,
  injectable only as a test dependency), so the live smoke below does not
  exercise it — the unit tests in
  `scripts/__tests__/cynco-campaign-roadmap.test.mjs` prove both moves and the
  throw cases.
- **The S5 enforce pin is lifted, with two guards.** `dispatch-mission.sh`
  no longer pins `LOCALCODE_S5_ENFORCE=false` (it defaults to `true`; setting
  it `false` still caps everything at advisory). The engine's per-rule
  authority (Phase 4) is the only gate, and two guards make the day it lands
  identical to the day before: (a) `RuleAuthority.authorityOf` returns
  `advisory`, not `legacy`, when no verdict file exists AND the engine is an
  unattended mission (`isUnattendedMission()`, `engine/missionEnv.ts`, F161's
  four keys) — its log line reads `[s5] rule authority: legacy (no verdict
  file at …) (advisory in this unattended mission)`, and a mission never runs
  the pre-Phase-4 enforce-everything path; (b) the real home's
  `rule-verdicts.json` is written before the first mission (the live step
  below). With enforcement on in a mission the engine advertises the new
  capability word `s5-earned-only` (F59's "S5 capped" becomes "only earned
  rules act"); the driver accepts `s5-advisory` or `s5-earned-only` and warns
  on any enforced decision whose authority is not `earned`. The first
  PREDICTIVE rule will act in a mission and its row will show
  `enforced: true, authority: earned`; 0 of 8 rules are PREDICTIVE today.
- **Best-of-N applies its winner (F162).** `extractPatch` trimmed the diff, so
  `git apply` rejected every winner whose diff ended in a normal hunk line and
  the engine fell back to single-pass every time — best-of-N paid for N
  candidates and never applied one. The diff is now returned byte-for-byte,
  pinned by a test that applies a real extracted patch; `bestOfN.applied` is
  readable on the ledger. The two leaked `cynco-bestofn-*` worktrees were
  removed and `cleanup()` retries, unlocks and prunes. Skills and jlens
  resolve under `cyncoHome()` (the `JLENS_DIR` override kept).
- **The outcome dataset and the frozen holdout.**
  `scripts/cynco-outcome-dataset.mjs` builds one row per LABELED mission from
  its first K `turns[]` — a FIXED K, not a fraction of the run. The spec first
  said "the first 50 % of the finished run", and the Task 4 review found that
  prefix leaked the run's length: failures run a median 169 turns vs 95.5 for
  successes, `consecutiveUnstable.max` correlated 1.000 with the prefix
  length, and length alone separated failure at AUC 0.649 — a learner would
  have "predicted" failure by reading how long the mission was going to be,
  and the prefix-vs-hindsight leak check could not catch it because both sides
  carried it. So: K = 16 primary (104 of 106 labeled missions eligible) and
  K = 32 secondary (95); a mission shorter than K is excluded per K, never
  truncated; running counters enter as per-turn rates; `turnsInPrefix` is
  metadata, never a feature. Whole-mission fields never enter the features.
  The frozen holdout `benchmark/cynco-ledger/frozen-eval.json` (v1, seed
  20260926, 21 whole missions stratified by label, 12 failures / 9 successes)
  is committed once; later missions join the training split; only the
  explicit `--refreeze` verb writes a new version, and it never removes an id.
- **The learner's honest reading.** At every VERDICT the runner exports the
  datasets, retrains `lr` (standardised logistic regression) and `gbt`
  (HistGradientBoosting) in `scripts/cynco-outcome-model.py` (numpy +
  scikit-learn; 300 s `runSync` cap) and hands their held-out predictions to
  `writeRuleVerdicts` as the synthetic rules `M1.lr` / `M1.gbt` (fired =
  `pFail ≥ 0.5` on held-out missions), judged by the identical Fisher/Wilson
  arithmetic against the holdout base and Holm-corrected together with the
  rules. `engine/s5/ruleAuthority.ts` never grants an `M1.*` id authority.
  `algedonicAlerts` enters as `.rate` only: the counter runs over the engine
  SESSION, so its `.last`/`.max` carried alerts from before the mission began
  (an era confound, final review T4-N2) — 56 feature keys.
  On the real ledger at K = 16 (the 56-key vector, requoted 2026-09-28): 83
  train / 21 holdout, base 0.571, 28 of 56 columns dead on the training split
  (the six entropy features all null; `stuckTurns.*`, `taskError.*`,
  `progressRate.*`, `consecutiveUnstable.last/max`, `brainPresent` and ten
  one-hots constant). Holdout AUC: `lr` 0.472 — below chance, `gbt` 0.500 —
  at it; with all turns (hindsight) 0.611 / 0.546; K = 32 `gbt` 0.625, `lr`
  0.409; the finished length alone 0.633; the best single prefix feature
  ~0.58–0.60. `M1.gbt` precision 0.500 [0.254, 0.746] on 12 fired — NO
  EVIDENCE; `M1.lr` 0.556 [0.267, 0.811] on 9 — TOO FEW. Holm family 9 (7
  rules + 2 models; adding the two changes no rule's verdict — every adjusted
  p is 1.000), predictive: none. (The 58-key first run read `gbt` 0.407 /
  hindsight 0.528, `M1.gbt` 0.545 on 11 fired; `lr` did not move.) Read
  plainly: **the per-turn signal vector at 16 turns does not
  predict outcomes today; the vector describes them weakly after the fact;
  better signals, not more training, is what the ledger asks for.** The
  dataset, the manifest and the ladder hook ship regardless — every later
  learner needs them.
- **C9 sealed.** Authored by the frontier occupant of the supervisor seat
  (the local model failed nine attempts in Phase 3), against the supervisor
  review that refused attempt 7 as its rubric. Round 0 was refused — the
  reviewer's 230-line stub greened 5 of 6 MUST-FAIL lines; round 1 sealed
  after nine tightenings and a delete guard. Fourteen graded lines
  (resolutions, keybinds, saves UI, fps guard, packaging including a wheel
  build) over civkings `e9366f3`; the triple under
  `~/.cynco/heldout/civkings-redesign/c9/`, the spec
  `docs/civkings-redesign-briefs/c9.campaign.json` with `author: human` (the
  seat that sealed it — `sealGate` hardcodes `cynco`, corrected by hand),
  `hoursPerWave 8, waves 8, iterations 2000`, roadmap `c9` → `sealed`
  (449670f). It is dispatched from `main` after the merge:
  `bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c9.campaign.json --waves 8`;
  its first verdict prints the first real scoreboard.
- **The live proof (s2, 2026-09-26).** The Phase 4 smoke campaign `s1`
  regenerated under a fresh `CYNCO_HOME=C:/tmp/cynco-home-s2/.cynco`
  (`--base 1b00179…`, `--runtime-from ~/.cynco`), no smoke roadmap (the path
  is repo-relative, above), runner launched detached from PowerShell.
  CALIBRATE `BASE MISS 8, perturb honest`; the engine logged `[s5] rule
  authority: legacy (no verdict file at
  C:\tmp\cynco-home-s2\.cynco\datasets\rule-verdicts.json) (advisory in this
  unattended mission)`, the driver `engine declares [sealed-gates,
  s5-earned-only] — dispatching mission`, and the row's one S5 decision
  landed `enforced: false, authority: advisory` — guard (a) live. 13 tool
  calls, 121 s; sealed gate PASS (0 fails), suite gate PASS, sweep refused →
  `pass`. The entry read `- Scoreboard: PASS/GPU-h 29.752 | waves 1 | lines
  fixed per landed wave 8.00 | human interventions per wave 0.00 | rules
  predictive 0/8 (best I3 58% NO EVIDENCE) | learner M1.gbt 55% NO EVIDENCE`
  and `- Outcome hindcast: v1 at K = 16 turns on 21 held-out missions (base
  57%): M1.gbt precision 55% [28, 79] on 11 fired p(Holm) 1.000 NO EVIDENCE;
  M1.lr precision 56% [27, 81] on 9 fired p(Holm) 1.000 TOO FEW; leak check …;
  K = 32 gbt AUC 0.55, lr AUC 0.42; dropped 28 dead column(s)` — the same
  numbers the offline run gave, on the 58-key vector (quoted as printed; the
  56-key requote is above). One honest caveat: the smoke repo's `master`
  already carried s1's work from Phase 4 (the mission baseline was its HEAD
  `17cd9a6`, not BASE), so the mission's one commit — `2ff000c ship-files:
  refresh VERSION, SHIP.md, CHANGELOG.md, LICENSE for 0.1.0` (parent
  `17cd9a6`; `CHANGELOG.md`, `LICENSE`, `SHIP.md`, +10/−9) — rewrote three
  files that already passed, and "8 lines fixed" is the calibration-at-BASE
  bar against a HEAD that already passed — a harness proof, not a model
  result (F163). Afterwards the
  REAL home's verdict file was written before any mission (guard (b)):
  `rule verdicts v1: 0 predictive of 10 (none)` (the old CLI wording — model
  rows in the total; it now reads `0 predictive of 8 rules (+2 model rows)`),
  `M1.gbt` NO EVIDENCE, `M1.lr` TOO FEW. That file describes the 58-key
  vector; after the final fix wave it is rebuilt on the 56-key vector with
  `bun scripts/cynco-rule-verdicts.mjs --with-hindcast` (the runner's own
  sequence behind one flag; the controller's live step). The synthetic row and
  the `campaign/s1` verdict commit were removed.
- **What is parked, with reasons (ruling 8).** TabPFN and XGBoost (absent; a
  download needs the operator). The latest-release resolver (network-facing;
  needs a release-stream decision). `s5.decision` typing (ruling 10:
  `protocol.ts` gains no import and no event this phase, so the frame stays
  untyped as it was). The writer guard's blind spots (re-parked by ruling 8:
  no Phase 5 measurement exercised the Write shrink guard of F112, so there is
  no evidence yet to size a change by).
- **Not in scope, rather than parked (ruling 9).** Applying retained tables
  (no non-empty table observed yet; the row's `retainedVersion` per C9 wave
  is the measurement that decides the next phase); LoRA/KTO training; new
  roadmap lines beyond C9; live model-S5 in the engine; the dashboard chat.
- **Closed.** Skills and jlens under `cyncoHome()`; `s4.workOrder.applied` is
  written (`workOrderFor`, on the wave record). The final fix wave closed the
  rest of what the Task reviews deferred: `worktreeManager`'s F155 retry is
  opt-in for list/prune/unlock and `worktree add --lock` runs once; the
  dashboard retries a rejected scoreboard load on the next poll and its purity
  guard is one `violations()` check with `Bun.write`/`Bun.spawn`/`process.`/
  `globalThis`/`XMLHttpRequest`/`WebSocket` in its tokens;
  `algedonicAlerts.last/.max` are dropped (the requote above); a throw on the
  model rows rewrites the rules alone (`ladderFault`), and `M1.*` rows never
  bump the verdict-file version (`modelChanged`); `bun
  scripts/cynco-rule-verdicts.mjs --with-hindcast` is the runner's own export
  → model → verdicts sequence; the roadmap's `done` move sits just before the
  commit; a fault's wall-clock hours print the rate as a floor (`≥`); and
  F163's HEAD-vs-base refusal guards every dispatched wave.

**Phase 6 — the runner measures the wave (shipped 2026-09-29).** Phase 5's
own finding was the brief: *the per-turn signal vector at 16 turns does not
predict outcomes; better signals, not more training*
(`docs/superpowers/specs/2026-09-29-gate-progress-phase6-design.md`, rulings
1–9). C9, the first campaign the runner drove end to end, said where the
blindness was. Wave 1 MISSed 3 lines after 3.80 h, 367 tool calls and 6
commits; wave 2 PASSed in 0.80 h and 42 calls; the scoreboard read PASS/GPU-h
0.218 over 2 waves with 7.00 gate lines fixed per landed wave. Nothing in the
engine or the runner knew, at minute 90 of that 3.8-hour wave, whether it was
fixing gate lines: S5 decides once at t≈0, the invariants denied 0 calls, and
governance POSIWID read Contradicted on both waves. The learner the phase
inherited read AUC `lr` 0.47 / `gbt` 0.50 on the frozen holdout while the
finished length alone read 0.63, and part of its vector was broken at the
source: `consecutiveUnstable` equalled the turn index on every C9 turn (F165).
And the wave that decided C9 was unlabeled, because the sweep refused an
import-only diff (F164). Phase 6 gives the runner eyes mid-wave, puts the
first runner-level regulator on the ladder in shadow, fixes the signals at
their cause, labels every deciding wave, and authors C10. Nothing in the
engine enforces anything new.

- **Gate progress, measured by the runner (ruling 2).**
  `scripts/cynco-campaign-progress.mjs`. During WAIT, on the wave clock,
  `progressCadence` decides whether a reading is due. The interval is
  `progress.everyMs`, raised to 10 × the gate's measured runtime so the gate
  never takes more than 10 % of the wave; C9's 215 s gate means ≥ 2150 s. It
  doubles per consecutive fault and never lands in the clock's last
  2 × gate; with no gate measured, the tail and the probe's cap assume a
  600 s gate (`PROBE_GATE_MS_ASSUMED`), so a probe cannot outlast the wave.
  `gateMs` is seeded from the last grade's `gate.durationMs`, else
  the calibration's new `baseGateMs`, so the 10 % rule holds from the first
  tick. When a reading is due, `probeProgress` reads the repo's HEAD, and an
  unchanged sha is a skip with nothing run. Otherwise it `git archive`s that
  sha into a temp dir (`archiveBase`'s form; the live repo is never touched),
  runs the sealed gate there with `runGate` exactly as a verdict does
  (`runSync`, never retried: a stale ETIMEDOUT mid-wave is a fault reading,
  F155; the probe's git spawns — the HEAD read and the archive — ARE retried
  once, because every tick follows a gap, and the retries are counted as
  `rec.retriedSpawns` with the F155 line logged once per wave), and appends `{ at, sha, fails, passes, failIds, durationMs,
  elapsedFraction }` or `{ at, fault, durationMs }` to `rec.progress`. While
  HEAD still sits at the start sha, the first due tick reuses the start grade
  (`reusedFrom: 'start'`, `durationMs: 0`), so a wave that never commits still
  has a count past 50 %. The spec gains `progress.everyMs` (a positive
  integer; `everyMsFor` = the spec's, else `CYNCO_PROGRESS_EVERY_MS`, else
  30 min). The smoke spec uses 20 s, because its gate runs in seconds. The
  verdict entry prints `- Progress: 14 → 3 fails over 3 readings (first fix
  at 41 min; last at 210 min: 3); R1.no-progress fired at 52% (would have
  saved 3.2 h)` (`progressLine`), or `- Progress: no readings (<reason>)`.
  **The sealed-instrument rule, restated: progress is never a probe.** A
  reading reaches `waves.jsonl` and the runner's log
  (`[campaign] progress @ Nm: F fails (was F0)`) and nothing else: never the
  model, never a probe message, never the brief. This is the Stage 1 lesson.
  The model gains no information it did not have. The runner's log is the
  operator's; it is never given to the model or written under the mission
  cwd. A probe fault names its class and exit code only, never gate output.
- **`R1.no-progress`, the first runner-level regulator, in SHADOW (ruling
  3).** The rule: *if at ≥ 50 % of the wave's wall clock the gate's fail count
  has not dropped below the wave's starting count, the wave will not pass.*
  `shadowNoProgress` evaluates it at every due tick, whether a reading or a
  skip, and appends `{ rule, at, elapsedFraction, fired, startFails, fails,
  wouldHaveSavedS }` to `rec.shadowDecisions`. It never fires on a faulted
  newest reading or an unmeasured start, and nothing is stopped.
  `wouldHaveSavedS` is read off the BUDGETED clock (`clockMs/1000 −
  elapsed`), so for a wave that ended early it overstates. Readers cap it at
  `rec.durationS − elapsed`, and the record stays the brief's formula. At
  VERDICT, `runnerRowsFromCampaigns` (`scripts/cynco-runner-rows.mjs`, one
  construction shared by the runner and the rule-verdicts CLI over
  `--campaigns-dir`) builds one row, `{ id: 'R1.no-progress', source:
  'runner' }`, across every runner-driven campaign. Its scope is the waves
  with ≥ 1 shadow DECISION at `elapsedFraction ≥ 0.5`, fired or not. That
  scope was a ruling at Task 3's review: scoping by READINGS dropped the
  rule's own targets, the waves that stop committing before halfway. A wave
  is keyed by its missionId, else `<campaign>#wave<n>`, so the wave the runner
  gave up on in the WAIT (no missionId) stays in scope. Its
  outcome is the wave's final decision (`pass`/`pass-with-survivors` means a
  firing was wrong), read after the identity check that can turn a pass into
  a fault. A VERDICT whose grade did not run (`kind: 'fault'`, `verified:
  null`) is UNLABELED for R1 as `labelOf` makes it for the S5 rules: out of n,
  named on the row as `unlabeled: [{ missionId, why }]`; a WAIT-timeout fault
  (no `verified` field) stays a failure. The row goes through the same Fisher/Wilson `analyse` and the one
  Holm family as the S5 rules and the `M1.*` model rows. The CLI builds it
  exactly as the VERDICT does, because a rebuild without it would correct the
  rules over a smaller m and could flip one near p(Holm) 0.05. It is named on
  the `- Outcome hindcast:` ladder line, is in neither `predictive` nor the
  rule count, and `engine/s5/ruleAuthority.ts` skips `source: 'runner'`.
  With no wave in scope it reads `UNMEASURED — no wave in scope`, and with no
  firing `UNMEASURED — fired on no in-scope wave`. It earns PREDICTIVE exactly
  as an S5 rule would. Only then may a later phase let it stop a wave.
- **Signals fixed at the source (ruling 4, amended at Task 2; F165).** The
  cause: `homeostatIntegration.update` fed the Ashby units raw pressure
  levels, and the core's `isStable(0.05 / tau)` asks whether every unit sits
  within ~0.06 of zero. In a mission S3 ≥ 0.1 and S4 ≥ 0.3, so the homeostat
  could never read stable and the streak counted session age. The fix is at
  the integration layer; `engine/cybernetics-core` is untouched. Each pressure
  enters as its DEVIATION from its own 20-turn mean, and the bar is
  `h × 0.2 / tau`, a fixed band of one S3 quantum. **Amendment:** the ruling's
  variance-scaled tolerance was built first and rejected. Scaled by its own
  spread, an oscillating pressure made the oscillation its normal (30
  alternating turns read a streak of 0). On the reconstructed C9 wave 2 stream
  the fixed band reads unstable on 10 of 57 turns (57 of 57 before), in four
  streaks, longest 4. `consecutiveUnstable` resets on a stable turn and caps
  at 50. `algedonicAlerts` is the count in the last 20 turns, with the old
  cumulative reading kept as `algedonicAlertsTotal`. `governance.status`
  carries `signalsVersion: 2`; `protocol.ts` gains optional fields and no
  import or event. The ledger writes `turns[].signalsVersion`, stamping 1 on a
  frame without it, and v1 and v2 rows never mix silently. The hindcast trains
  on ONE signals version, the current 2 (`HINDCAST_SIGNALS_VERSION`), and
  carries `rowsByVersion`. S5 rules W5 and I2, the only rules reading a
  v2-changed signal, are scored on v2 rows only (`analyseByVersion`), with
  their v1 counts kept under `v1` and never pooled. Under v1 they fired on
  every mission. The frozen holdout is now one set per signals version (v1's
  21 ids verbatim). v2's set freezes itself ONCE when its eligible pool
  reaches `FREEZE_MIN_ELIGIBLE` = 38 with at least 8 of each label, and the
  runner commits the manifest with that verdict, whose learner line ends
  `; v2 holdout frozen now (8 ids)`. Until then the learner reads unmeasured with the reason
  (`noEligibleFault`), and python is not spawned. `stuckTurns` and the
  read-loop gate were audited against C9 and measure different things (a
  repetition detector vs re-reading): named, not changed.
- **Every deciding wave gets its label (ruling 5; F164 CLOSED).** `runSweep`
  (`scripts/cynco-campaign-grade.mjs`) retries a `sweep refused (exit 2)`
  ONCE with `--mutate <sweepSourcesFor(spec, changedFiles)>`: every non-test
  `.py` the diff touched, by the sweep's own `is_test_path` rule, read with
  `--diff-filter=d` so a deleted module is never named. The retry is recorded
  as `sweep.kind: 'derived-full'`, `retried: true`. Only a second refusal
  stands, with `sweepRetried: true` on the record and the row. `labelOf`
  reads `derived-full` like `derived`, and `cynco-ledger-sweep.mjs --kind
  derived-full` (which requires `--mutate` in its command) writes the same
  shape by hand for the C9 wave 2 relabel.
- **Hygiene (ruling 8).** `humanInterventionsPerWave` counts from the seal
  (`state.authoring[<id>].sealedAt`). Acts dated before it are left out and
  named as `beforeSeal`, so C9 now reads 0.00 with `beforeSeal: 2` (its two
  authoring-phase refusals). The driver's single `COMMIT LANDED` per mission
  is documented as the landed transition, by design. The first non-empty
  retained table (`~/.cynco/retained/mission-invariants.json` v1,
  `callsSinceCommit: { Discrete: 'edit-only' }`) has a named reader and still
  is not applied: its reader is `MissionInvariants` itself
  (`engine/vsm/missionInvariants.ts:163` declares the `callsSinceCommit`
  essential variable; instance `mission-invariants`), which imports the table
  at `:168` and exports it at every mission end, but the table is never
  applied to a decision — a warm-started `MissionInvariants` steps exactly
  like a cold one. Applying it would warm-start the invariant gate at the
  `edit-only` position, and whether it should is the next phase's measured
  decision.
- **C10 — Ambitions & the Ladder.** The roadmap line is the frontier
  occupant's reading of the user's locked decision 2: *a player ambition from
  the 7 agenda families chosen at game start and shown once (Court in
  Session); public rank every turn with its axes earned through the intel
  fog; portrait cards whose stance (backs/wary/opposes) and one-line want are
  computed from the character's dispositions; an opposing member usable as a
  lever; rivals' agendas on Powers per fog tier; the ending judge names the
  ambition's outcome.* The frontier occupant authored the triple as in Phase
  5 (rubric: Phase 5's supervisor review, the Clarity Law, F151–F156/F164)
  over civkings `ccf3fee`, and it sits under `~/.cynco/authoring/c10/`. It
  has eleven graded lines: C10.1a ambition-chosen, C10.1b
  ambition-shown-once, C10.2a rank-public, C10.2b rank-why-through-fog,
  C10.3a court-in-session, C10.3b stance-from-dispositions, C10.4
  opposing-member-lever, C10.5 rival-agendas-per-fog, C10.6
  ending-names-ambition, C10.7 verbs-self-explain, and C10.9 (C9's sealed
  gate, kept green). FIX-THEN-SEAL from the supervisor review (8 required
  fixes: its own stub passed the gate with the rank spelled "fourth of seven"
  on every screen, text drawn around the census and a member-deleting
  lever); one fix round closed all eight and the re-check read SEAL with that
  stub at MISS (10 fails) at both seeds; sealed 2026-09-29 in commit 4c45deb
  (gate sha256 1b1f6a936d4e4403), with `author: human`, on C9's budget. Two
  locked-decision items are NOT graded by C10: rivals reading the player's
  agenda through the fog, and rivals pulling the player's opposing members.
  The supervisor parked both (the first already holds in the sim at BASE and
  any drawn form makes a second home; the second is AI/sim in a denied
  file). C10 wave 1 runs from `main` after the merge
  and is the phase's real live proof of rulings 2–3. Its first verdict prints
  the first real `- Progress:` line and the shadow rule's first row.
- **The live proof (s3, 2026-09-29).** The Phase 4 smoke campaign `s1` ran
  under a fresh `CYNCO_HOME=C:/tmp/cynco-home-s3/.cynco` (`--base 1b00179…
  --common-from ~/.cynco/heldout/common --runtime-from ~/.cynco`,
  `progress.everyMs` 20 s), with the runner launched detached from
  PowerShell and the smoke repo reset to BASE first (F163). CALIBRATE read
  `BASE MISS 8, perturb honest`. Mission `s1-wave1-1790718213749` took 20
  tool calls and 151 s, and the model made 3 commits (6 since base including
  the marker), BASE `1b00179` → HEAD `cf2bc53`.
  - **Readings.** The runner took four and logged each:
    ```
    [campaign] progress @ 1m: 8 fails (was 8) — no commit since the start, start grade reused
    [campaign] progress @ 1m: 3 fails (was 8) — gate 0 s on 100562d
    [campaign] progress @ 2m: 0 fails (was 8) — gate 0 s on c829a10
    [campaign] progress @ 2m: 0 fails (was 8) — gate 0 s on cf2bc53
    [campaign] progress @ 3m: sha unchanged (cf2bc53) — no gate run
    ```
    On the record they are `rec.progress` at `elapsedFraction` 0.014 (8
    fails, `reusedFrom: 'start'`), 0.022 (3 fails, gate 206 ms), 0.031 (0)
    and 0.039 (0). The last line is a skip.
  - **Shadow decisions.** `rec.shadowDecisions` holds 5 `R1.no-progress`
    decisions, the skip included. None fired, and `wouldHaveSavedS` ran 3550
    → 3429.
  - **The dashboard.** Mid-wave, `/api/mission` read `"toolCalls":18`,
    `"commitsSinceBase":6`, `"markerSeen":true`. The mission's commits
    reached the dashboard; the gate readings did not reach the model or its
    probes.
  - **The entry.** It read `- Progress: 8 → 0 fails over 4 readings (first
    fix at 1 min; last at 2 min: 0); R1.no-progress did not fire (5
    decision(s))` and `- Outcome hindcast: UNMEASURED — v2 holdout not yet
    frozen (1 of 38 labeled; eligible by version: v1: 105, v2: 1);
    R1.no-progress precision null on 0 fired p(Holm) null UNMEASURED — no
    wave in scope (no shadow decision at 50 % of its clock or later)`.
  - **The ladder file.** The temp home's `rule-verdicts.json` carries
    `rules['R1.no-progress']` with `source: 'runner'`, `n: 0`, `scopeN: 0`
    and the same UNMEASURED verdict. That is right: the wave passed at 4 %
    of its clock, so no decision reached 50 %.
  - **Signals.** Every one of the ledger row's 20 turns carries
    `signalsVersion: 2`, and `consecutiveUnstable` read `0, 1, 2, 3, 4, 5, 6,
    0, 0, 0, 0, 0, 1, 0, …`. The streak resets, which is F165's fix visible
    live. `algedonicAlerts` / `algedonicAlertsTotal` read 0 / 0.
  - **The sweep.** It did NOT refuse. `kind: 'derived'`, `retried: false`,
    0/2 with survivors `calc.py:14:cmp->NotEq` and `calc.py:15:const->2`,
    giving the decision `pass-with-survivors` → CAMPAIGN PASS. So the
    `derived-full` retry was not exercised live. It is proven by
    `scripts/__tests__/cynco-campaign-grade.test.mjs` ("a refused sweep
    retries once with --mutate over the wave's sources (F164)", including a
    real-repo case whose wave deletes a module), and the C9 wave 2 relabel
    is its first real use.
  - **One live defect, for the final fix wave.** Every probe tick's first
    git spawn printed `[spawn] git: an impossible ETIMEDOUT after 6 ms (cap
    30000 ms) — bun's stale deadline; retried once and the retry ran
    (F155)`. The retry works, but at a 20 s cadence the log is noise.
  - **Cleanup.** The `campaign/s1` branch was deleted, which reverted the
    ledger row and the log entry with it. The smoke repo was left at
    `cf2bc53`, and 9161 answers 000.
  C10 wave 1 remains the phase's real live proof (ruling 7b).
- **Parked, with reasons.** Enforcing `R1.no-progress` waits for PREDICTIVE on
  the ladder. TabPFN and XGBoost learners wait because no pip install happens
  without the operator's approval. The `wouldHaveSavedS` cap is left to
  readers, and the record keeps the budgeted-clock formula. Two stuck-detector
  items are named in F165 for a later phase: a successful read-only Bash
  resets `stuckTurns`, and gate denials never count as stuck evidence. C10
  does not grade rivals reading the player's agenda through the fog, or
  rivals pulling the player's opposing members; the supervisor rules on both.
  Ruling 8's list stays parked: the download resolver, `s5.decision` typing,
  writer-guard blind spots, LoRA/KTO, model-S5 live and the dashboard chat.
  Post-merge controller steps: the C9 wave 2 relabel (`--mutate
  gilded/ui/saves_view.py` at civkings `9fd5fe9`, recorded `--kind
  derived-full`, through a PR) and the C10 dispatch
  (`bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c10.campaign.json --waves 8`,
  detached).

**Phase 7 — evidence per GPU-hour (shipped 2026-10-02).** Phase 6 gave the
runner eyes mid-wave, and C10 was the first campaign it watched end to end
(`docs/superpowers/specs/2026-10-02-evidence-per-hour-phase7-design.md`,
rulings 1–10). C10 PASSed in 2 waves and 14.5 GPU-hours, so PASS/GPU-h fell
from C9's 0.218 to 0.069. Gate lines fixed per landed wave rose from 7.00 to
10.00, and human interventions per wave stayed at 0.00. The proxy cannot see
the one intervention that happened: the controller rebuilt C10 wave 2's
verdict commit by hand (F167). The rules stood at 0 of 8 PREDICTIVE.
`R1.no-progress` had 2 waves in scope and fired on neither. The learner was
UNMEASURED with 1 labeled v2 mission of the 38 its holdout needs. The ledger
said where the hours went:
- **E1.** 9.8 of the 14.5 GPU-hours (68 %) came after the wave's last gate
  improvement. Wave 1 read 20 → 16 by minute 139, then 16 → 18 to minute 467,
  for a net −2 lines over 5.5 hours. Wave 2 reached 0 at minute 185 and ran
  4.3 more hours.
- **E2.** The learner was starved by its unit. One campaign gave ONE labeled
  v2 mission, so the first v2 holdout would freeze in about twenty campaigns.
  The same campaign wrote 18 shadow-decision ticks, which make 16 intervals,
  each with a measured outcome and its own slice of per-turn signals.
- **E3.** R1 compares against the wave's start count at ≥ 50 % of the clock,
  so it could not fire on wave 1, which held 16–18 against a start of 20 for
  five hours. A stall condition would have fired at minute 278 and saved
  about 12 100 s.
- **E4.** The keep-green subset missed a House-tab regression
  (`test_c7_branching`) that the full suite catches. The model found it with
  its own full-suite run in wave 2's last 2.5 hours; the suite gate itself ran
  only at the grade.
- **E5.** Governance POSIWID read Contradicted on every wave by construction.
  Its stated purpose gave logging no share while every rule was advisory.
- **E6.** The verdict commit depended on the operator's checkout (F167).
- **E7.** The authoring seat had never been retried with a supervisor rubric.
Phase 7 takes more evidence from the same GPU-hours instead of buying new
ones. Shorter waves were rejected for want of a measured pass at a shorter
clock. Acting mid-wave on a stall was rejected because nothing has earned
authority. Nothing in the engine enforces anything new.

- **Reading-level outcomes, a second unit of evidence (ruling 1, amended at
  Task 1's review).** `intervalsOf(rec, row)` / `intervalRows(rows, waves)` in
  `scripts/cynco-outcome-dataset.mjs` split a wave into the spans between
  consecutive shadow-decision ticks. Each span is labeled `improved` when the
  fail count fell by the next tick, else `stalled`. Its features are the Phase
  5/6 aggregates over the turns whose `t` falls inside the span, plus five
  `interval.*` context keys, and nothing from after the span's end
  (`leakGuard`). Two exclusions were added in review. A tick whose probe
  FAULTED is dropped, and the spans on either side merge: R1 copies the last
  measured count onto a fault, so keeping that tick would label a stall
  nobody measured. An interval that STARTS at 0 fails is excluded as
  `afterZero`, because a wave still ticking after it solved the gate is
  finished, not stalled. Spans shorter than `INTERVAL_MIN_TURNS` (4) count as
  `short`. A row without turn times counts as `noTurnTimes`, a wave with
  fewer than two ticks as `noTicks`, and a v1 slice as `otherVersion`. None of
  these is dropped silently. Rows go to
  `<home>/datasets/outcome-dataset-intervals.jsonl` (`DATASET_INTERVALS_PATH`).
  The same model (`--unit reading`) and ladder read them as `M2.lr` /
  `M2.gbt`, with `source: 'model'` and `unit: 'reading'`. They sit in the same
  Holm family, and authority is refused exactly as it is for `M1.*`. The
  reading holdout is its own set, `reading:2`, in `frozen-eval.json`. It
  freezes once by the mission rule (38 eligible, ≥ 8 of each label), by WHOLE
  missions, so one mission's intervals never straddle train and holdout. The
  committed `"1"`/`"2"` sets stay byte-identical. The mission unit stays
  primary: the verdict's learner line gains a `; readings: …` clause after
  the mission clause, and `rec.hindcast.reading` holds the reading. Readings
  from one mission are not independent, so an `M2.*` p is optimistic, and the
  README says so.
- **`R2.stalled`, a second shadow rule (ruling 2).** `shadowStalled`
  (`scripts/cynco-campaign-progress.mjs`; `STALLED_RULE`, `STALLED_AT` 0.25,
  `STALLED_WINDOW` 3 in `scripts/cynco-runner-rows.mjs`) decides at every due
  tick beside R1. It fires iff, at ≥ 25 % of the clock, the last three
  MEASURED ticks never decrease and the latest is > 0. A faulted tick is
  marked `{ fails: null, fault }` and left out of the window, never counted
  with R1's carried value. Each decision
  is `{ rule: 'R2.stalled', at, elapsedFraction, fired, window, fails,
  wouldHaveSavedS }` on `rec.shadowDecisions`, and a firing is one runner log
  line. `runnerRowsFromEntries` returns two rows, R1 then R2, each scoped by
  its own threshold. The Progress line names both rules (`…; R2.stalled fired
  at 186 min (4 decision(s))`, or `not evaluated` on an older record). It is
  shadow only. Enforcement waits for PREDICTIVE.
- **The marker check runs the suite gate, and a failure feeds back once
  (ruling 3, amended at Task 6's review).** A campaign spec may name
  `markerCheck`. Without one, `waveDispatch` makes the suite gate the check,
  as `CHK_SUITE_BASELINE=<path> CYNCO_GATE_REPO=<repo> python
  "<g_suite_no_regression.py>"`, capped by `CYNCO_CHECK_TIMEOUT_MS`
  1 800 000. The baseline travels only inside the command string, so the
  existing withheld-path logic seals and restores it, and it is stripped from
  the engine's env. The check runs when the engine closes the turn with the
  marker landed. If it FAILS with at least `MARKER_RETRY_MIN_S` (3600; a spec's
  `markerRetryMinS`, passed as `CYNCO_MARKER_RETRY_MIN_S`) of the clock left,
  the driver sends the check's last 40 model-readable lines once as a driver
  note (`[driver] marker check FAILED — fix and re-mark:`), and the mission
  continues. `shouldRetryMarkerCheck` decides, and `markerCheckNote` writes
  the note; it filters out lines naming `heldout`, withheld paths and the
  suite gate's REPAIRED block, and tells the model where the F132 reset put
  its uncommitted work. The second check's result is `verified`. The review
  found the first build blocked the driver for the whole suite run. The
  engine's ws server idles out after 120 s, so the note went into a closed
  socket while `verifyRetries: 1` was recorded anyway. The check now runs
  asynchronously (`runAsync` / `runCheckAsync`, sharing `runSync`'s
  `instrumentEnv` and timeout rule). The socket is pinged every 30 s, and a
  dropped socket is reconnected before the note. The retry counts only on a
  confirmed send; otherwise the FAIL stands as `verify.noteFailed`. A bun ws
  stub with a 1 s idle timeout pins both paths. Every check writes its own
  patch (`verify.patches`). A first check is reused only while HEAD holds,
  and the ledger row carries `verifyRetries` (0/1, null without a check) and
  `verify.retried`. The smoke's `markerCheck` is a fixture that fails on its
  first call and passes after, with `markerRetryMinS: 60`. That makes the
  smoke a mechanical proof of the loop, not a measurement.
  **Amended at the final review (I1): the marker check has its own channel.**
  The check-cmd had a second consumer nobody had priced: the driver makes it
  the engine's withheld contract assertion, and the model's
  `ContractAssertPass` runs that inside its own turn. With the suite gate as
  the check-cmd, every such call ran the whole suite in-turn (C10 wave 2
  measured 450 s for it), and on the smoke the model could spend the
  fixture's one failure before the driver ever ran it — the retry proof void,
  with no tell on the row. So the check-cmd stays `spec.keepGreen` (the
  contract assertion and verify-first keep what they had before Phase 7), and
  `waveDispatch` hands the marker check to the driver as `CYNCO_MARKER_CHECK`
  with its cap `CYNCO_MARKER_CHECK_TIMEOUT_MS` (1 800 000).
  `markerCheckFrom` (`scripts/cynco-verify.mjs`) is the driver's only reader:
  the in-loop check, the retry and the final verify run it, falling back to
  the check-cmd without the channel. The engine reads the channel for its
  instruments only (`markerCheckGateAssertions`, so the baseline stays sealed
  on every message, the retry note included), the driver snapshots and
  restores them (`driverInstrumentAssertions`), and the Bash tool's env drops
  `CYNCO_MARKER_CHECK*` and `LOCALCODE_MISSION_*` (`bashToolEnv`). The driver
  passes `CYNCO_CHECK_ORDINAL=<n>` to each check; the fixture fails only at
  ordinal 1 and passes, stamp untouched, when the ordinal is absent.
  **The sealed-instrument rule, restated.** The suite gate's output may reach
  the model. It is pytest over the public tests, against a baseline the model
  cannot read. The sealed campaign gate's output never reaches the model.
  `checkIdentity` refuses a `markerCheck` that names a sealed instrument or
  contains the marker, and the progress readings stay runner-side as in
  Phase 6.
- **Governance POSIWID v2 (ruling 4).** `governancePurposeFor({ earned,
  total })` states the purpose that the authority table grants:
  `denialsChanged` and `recommendationsConsumed` each get `0.5·e`, and
  `signalsLogged` gets `1 − e`, with `e = earned / total` read by
  `authorityOf` from the `rule-verdicts.json` this verdict wrote. The record
  keeps v1 and adds `governancePosiwid.v2 = { verdict, divergence,
  dominantObserved, stated: { earned, total } }`, or `{ verdict: null,
  reason }` when not measured. The entry prints `- Governance POSIWID v1 … |
  v2 Consistent (0 of 8 earned).` At 0 earned, logging IS the stated
  purpose. The first v2 Contradicted wave will mean that an earned rule did
  not act or an advisory one did.
- **The dashboard draws the wave (ruling 5).** `/api/campaign` gains
  `waves[].progress = { startFails, readings, decisions }`, and the Campaign
  panel draws a fails-over-clock line per wave, with each rule's fired ticks
  marked and fault readings counted off the line. The panel shows v2 beside
  v1.
- **F167: a campaign runs from its own worktree (ruling 6, amended at Task
  3's review).** The verdict commit used to run `git checkout campaign/<id>`
  in the operator's working copy. The operator switched that copy to another
  branch during C10 wave 2, git refused the checkout, and the verdict was
  rebuilt by hand. The spec's fix, committing through plumbing (a temporary
  index, `commit-tree`, a compare-and-swap `update-ref`) from whatever
  checkout the runner stood in, was built (`de118ca`) and rejected in review.
  It fixed the write but not the read. The verdict files stayed dirty in the
  operator's tree, so the next wave's foreign-changes guard refused and
  every later wave read `commit skipped`. And it took files whole from a
  working copy based on another branch, which silently dropped wave 1's log
  entry from the campaign branch. The runner also READS the campaign log,
  the roadmap and the ledger shards from its checkout, so whatever checkout
  it runs in IS the campaign's state. The ruling that shipped (`aa89eaa`):
  `ensureCampaignCheckout` refuses (exit 2) unless `git branch
  --show-current` is `campaign/<id>`. It runs on every runner path, before
  the lock or any write, and prints the exact `git worktree add
  .claude/worktrees/campaign-<id> …`, `npm install` and runner commands (or
  names the worktree that already holds the branch). `commitVerdict` is
  on-branch only: it does an add and a commit, and throws when HEAD is not
  the branch, with no checkout and no `-b`. The plumbing path and its
  `detached` flag are gone. The report and authoring verbs run anywhere. The
  operator's checkout is never the runner's again.
- **C11 — Rivals & Reach (ruling 7).** The roadmap's next line, open at
  civkings `2e313f6`, holds the two halves of locked decision 2 that C10's
  supervisor parked. (a) On Powers/Dossier with a rival selected, a line
  owned by that rival states whether it sees the player's family (intel tier
  ≥ 2), never naming the family. (b) The AI courts a rival's opposing member
  as a lever when it holds tier ≥ 2 on that house and leaves a beat naming
  the member; the pulled lever is visible on House/Court. `gilded/ai.py` is
  open for C11; `gilded/intel.py` stays denied. The user may strike the line
  before wave 1.
- **The authoring seat's one attempt (ruling 8).** The seat gets `--author
  c11` once, with the C10 supervisor review's rubric as its
  `supervisorNote`. The rubric covers the stub test, the one-home census over
  rendered text, the rank vocabulary, the gone-member clause, why the line
  is drawn, and negation. A CynCo seal would be `author: cynco`, the seat's
  first landed data point. A DO-NOT-SEAL sends the line to the frontier path
  C10 took. C11 seal: attempt in progress; seal pending.
- **The live proof.** LIVE PROOF: pending (the controller runs the s4 smoke
  after the C11 attempt).
- **Parked, with reasons.** Spec §8 stays parked, each item with the evidence
  that would unpark it. Enforcing R1/R2 waits for PREDICTIVE on the ladder.
  The reading learner as an S5 input waits for a measured AUC. Shorter waves
  wait for a measured pass at a shorter clock. The probe's git spawns on a
  fresh-subprocess path wait because `retriedSpawns` is counted and harmless.
  TabPFN/XGBoost wait for approval to download. Applying retained tables
  waits for a non-empty table. Also parked: the download resolver,
  `s5.decision` typing, writer-guard blind spots, LoRA/KTO, model-S5 live,
  the dashboard chat, and CodeIndex adoption (C10: 11/1127 and 17/555). The
  reviews' deferred minors go to the final fix wave:
  - interval dataset: the dispatch → first-tick span as interval 0 (it would
    renumber intervals and change holdout identity); the CLI test's temp dirs
    are not removed.
  - R2: it can fire on a tick whose own probe faulted, where R1 refuses; a
    no-commit wave fires at 25 % by design.
  - F167 guard: the refusal says "commit the seal first" when the spec or
    roadmap is dirty, and the printed worktree path is absolute.
  - governance v2: no drift replay, and the windows do not record
    `earned`/`total`; the unreadable-file branch is untested.
  - panel: the tally is not `Object.create(null)`; a measured reading with a
    null `elapsedFraction` is counted nowhere; `elapsedFraction` is not
    clamped to [0, 1]; `DOMParser`'s parsererror is not checked.
  - reading learner: a ledger-read fault writes no `reading` key; `reading:2
    holdout frozen now` prints only on a successful reading run.
  - marker check: the sealed baseline also arms the engine's content seal
    (`engine/tools/sealedPaths.ts:241`); the check command reaches the
    model's Bash env as `LOCALCODE_MISSION_CHECK`; salvage reads only the
    end-of-mission patch, not the per-check patches.

**Deferred spec items (follow-up, not built here).**

- **Eigenform convergence (spec §7).** The metric for "the campaign's briefs
  stop changing shape" — successive waves' generated briefs converging to a
  fixed point — is specified but not measured; nothing computes it today.
- **`codeIndexAssisted ≥ 20 %`.** The measurement plan's adoption ratio
  (CodeIndex-assisted Greps over identifier-shaped Greps) is printed per wave in
  the verdict entry but never compared against its 20 % target, and no decision
  reads it.
- **Ideation at authority 0.5 reorders `work[]`** — shipped 2026-09-18 (Phase 1):
  `workOrderFor` in `scripts/cynco-brief.mjs`; `s4.workOrder` on the wave record.
