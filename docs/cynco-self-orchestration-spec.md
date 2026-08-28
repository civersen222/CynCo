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
2. **Trigger: commit detection, debounced.** The driver already watches `tool.start` frames; it additionally polls repo HEAD (it knows CWD). On HEAD change, wait for the turn to go quiet (existing `lastActivityAt` machinery), then run the probe. Debounce: never more than one probe per N minutes (default 10); skip if a probe is already running. Probe runs are serialized and *logged with wall-clock* so perf-measuring gates are never run as probes (C5 contention lesson: perf prongs + parallel load = fake FAILs — the spec forbids perf-measuring probe commands, stated in dispatch docs).
3. **Injection: verbatim, prefixed, over the live socket.** Driver sends a `user.message` frame (same shape as dispatch, `unattended: true`) containing exactly:
   `[PROBE aftercommit <sha>] exit=<code>` + the outputTail — quoted verbatim, never paraphrased (standing brief-authoring rule). On PASS, inject nothing (silence is cheap; green probes are recorded in the ledger only). On FAIL, inject.
4. **The hard override.** Today the driver ends the mission when it sees the marker commit. New rule: marker seen → run probe → if probe FAILs, do **not** proceed to verify/teardown; inject `[PROBE FAILED at your marker commit — the mission is not done]` + verbatim output, and continue the session. Bounded by `MAX_OVERRIDES` (default 3, env `CYNCO_MAX_PROBE_OVERRIDES`); on exhaustion, mission ends and the ledger records `probeOverridesExhausted: true`.
5. **Ledger:** new `probe` block per mission row: `{ command, runs: N, fails: N, overrides: N, lastExit, firstFailTurn }`. This is the Stage 1 measurement instrument.

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
