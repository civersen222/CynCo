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
  line still in flight (`nextOpenLine`): the roadmap is authored in order,
  because each gate is drafted against the previous campaign's as exemplar.
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
  with two problems into a verdict of eleven.
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
  a backward move). Each line carries the `base` commit its gate is calibrated
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
What that 0.5 buys is one branch: `authorCampaign` seals its own gate instead of
waiting for `--approve-proposal gate/<id>`, and records the decision as
`decidedBy: 'auto'`. Every check inside `sealGate` still runs — a refused seal
leaves the proposal pending exactly as a refused human approval does. The
promotion is approved into the state of the campaign that gathered the evidence
while the seal happens inside the campaign being authored, which is always
fresh, so the seat's authority is the highest approved in any campaign's state;
a per-seat retained-configuration store is Phase 4.

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
