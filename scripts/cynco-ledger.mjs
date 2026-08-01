// Mission outcome ledger (governance falsification program, step 1).
//
// Pure collector: the mission driver feeds it every WS event; on mission end
// buildMissionRecord() produces one JSONL record pairing the full per-turn
// governance signal vector + every S5 decision with the labeled binary
// outcome. This is the dataset that makes the VSM/S5 layer falsifiable —
// step 2 (per-rule precision/recall) runs directly off these records.
//
// Records land in benchmark/cynco-ledger/missions.jsonl (committed to git).
//
// TWO INDEPENDENT LABELS, and neither one implies the other:
//
//   verified      — the brief's own check command exited 0. Structural: the
//                   suite collected, the counts held, the frozen files did not
//                   move. Set by the driver (Phase 2(b)) when a check-cmd is
//                   supplied, else null.
//   mutationSweep — a withheld mutation set made the repo's OWN tests go red
//                   for every rule the brief stated. Behavioural: it measures
//                   whether the tests BITE. Recorded after the fact (sweeps
//                   run long after the mission), null until measured.
//
// `verified: true` alone is NOT ground truth for a wave that states behavioural
// rules. Measured on this ledger: record #33 (ui2b_brief) is
// outcome 'landed' + verified true, and the withheld sweep then killed only
// 14/15 — the surviving mutation named a test that asserted `x == x`, and a
// whole follow-up wave (ui2c) existed only to delete it. A scorer that reads
// `verified` as acceptance would train on that record as a success.
//
// Ground truth for scoring, stated honestly:
//   structurally sound : outcome === 'landed' && verified === true
//   accepted           : the above AND mutationSweep &&
//                        mutationSweep.killed === mutationSweep.total
//   unmeasured         : mutationSweep === null — NOT a failure, and not a
//                        success either. Exclude it; never default it.

export function createMissionCollector(now = () => Date.now()) {
  return {
    turns: [],
    s5Decisions: [],
    controlSignals: [],
    toolTransport: [],
    toolStats: { total: 0, errors: 0, byName: {} },
    enforcedSeen: false,
    regulatorFidelity: null,
    // F33: the join key between this ledger and ~/.cynco/rewards/*.reward.json.
    // Both datasets describe the same run and neither could name the other.
    taskIds: [],

    ingest(m) {
      const t = now()
      switch (m.type) {
        case 'governance.status':
          this.turns.push({
            t,
            health: m.health ?? null,
            s3s4Balance: m.s3s4Balance ?? null,
            toolSuccessRate: m.toolSuccessRate ?? null,
            stuckTurns: m.stuckTurns ?? null,
            varietyRatio: m.varietyRatio ?? null,
            varietyWindowed: m.varietyWindowed ?? null,
            taskError: m.taskError ?? null,
            errorTrend: m.errorTrend ?? null,
            fingerprintAlarm: m.fingerprintAlarm ?? null,
            infoGain: m.infoGain ?? null,
            progressRate: m.progressRate ?? null,
            explorationState: m.explorationState ?? null,
            varietyBalance: m.varietyBalance ?? null,
            algedonicAlerts: m.algedonicAlerts ?? null,
            axiomHealth: m.axiomHealth ?? null,
            consecutiveUnstable: m.consecutiveUnstable ?? null,
            agreementRatio: m.agreementRatio ?? null,
            predictions: m.predictions ?? null,
            s4: m.s4 ?? null,
            heterarchy: m.heterarchy ?? null,
            snapshot: null,
          })
          break
        case 'snapshot.taken': {
          const lastTurn = this.turns[this.turns.length - 1]
          if (lastTurn) {
            lastTurn.snapshot = {
              hash: m.hash,
              prevHash: m.prevHash,
              filesChanged: m.filesChanged,
              additions: m.additions,
              deletions: m.deletions,
            }
          }
          break
        }
        case 's5.decision':
          if (m.enforced === true) this.enforcedSeen = true
          this.s5Decisions.push({
            t,
            ruleIds: m.ruleIds ?? [],
            reasoning: m.reasoning ?? '',
            contextAction: m.contextAction ?? null,
            toolRestriction: m.toolRestriction ?? null,
            modelSwitch: m.modelSwitch ?? null,
            enforced: m.enforced ?? null,
          })
          break
        case 'control.signals':
          this.controlSignals.push({
            t,
            temperatureAdjust: m.temperatureAdjust ?? null,
            temperature: m.temperature ?? null,
            bestOfNBudget: m.bestOfNBudget ?? null,
            widenToolSet: m.widenToolSet ?? null,
          })
          break
        case 'toolcall.transport':
          this.toolTransport.push({
            t,
            stage: m.stage ?? null,
            toolName: m.toolName ?? null,
            detail: m.detail ?? null,
          })
          break
        case 'governance.session_fidelity':
          this.regulatorFidelity = m.fidelity ?? null
          break
        case 'trajectory.task_started':
          // A blank id is not a joinable task. Pushing null would mint a key
          // that matches every reward file with a missing id — a join that
          // silently succeeds against the wrong row is worse than no join.
          if (typeof m.taskId === 'string' && m.taskId !== '') this.taskIds.push(m.taskId)
          break
        case 'tool.start': {
          this.toolStats.total++
          const name = m.toolName ?? 'unknown'
          this.toolStats.byName[name] = (this.toolStats.byName[name] ?? 0) + 1
          break
        }
        case 'tool.complete':
          if (m.isError) this.toolStats.errors++
          break
      }
    },
  }
}

/**
 * Did this mission commit anything?
 *
 * `log` must be `git log --oneline <baselineSha>..HEAD`. Scoped that way, every
 * line in it is a commit this mission made, so the presence of ANY line is the
 * answer — the marker string is not consulted. That scoping is also what stops
 * a follow-up mission from matching its predecessor's subject line, which is
 * the failure the marker check was originally added for.
 *
 * When the baseline SHA could not be read, the log is an unscoped `git log -3`
 * and the marker is the only thing separating this mission's commits from
 * pre-existing ones, so it is required.
 *
 * Why this is a function and not an inline expression: as an inline expression
 * it read a landed, pushed, fully green UI Wave 6d as `outcome: "timeout"`,
 * because that wave's brief dictated a rule-map commit subject with no marker
 * in it. A driver that reports the opposite of what happened is worse than one
 * that reports nothing, so the decision now has a name and a test.
 */
export function missionCommitted(log, marker, baselineSha) {
  if (!baselineSha) return log.includes(marker)
  return log.trim().length > 0
}

/** A run is quiet when its last message finished and nothing has happened since. */
export const QUIET_MS = parseInt(process.env.CYNCO_QUIET_MS ?? '60000', 10)

/**
 * Has the driver seen everything it is going to see?
 *
 * Quiescence used to be consulted only for a mission that had already
 * committed, on the reasoning that an un-landed run still had time left and
 * might yet use it. UI Wave 7h falsified that: the run finished its contract,
 * stopped talking 107 seconds in, and the driver waited out the remaining 88
 * minutes for a commit that nothing was left running to make. A run that has
 * gone quiet is not deciding what to do next — it has stopped, and the extra
 * wait buys nothing but a wrong label and an hour and a half.
 *
 * `sawMessageComplete` is what separates quiet from busy: `tool.start` clears
 * it, so a long Bash is activity no matter how stale the last message is.
 *
 * `engineError` is the third stopping point and it short-circuits both of the
 * others. Wave 7h run 2 died mid-message when llama-server exited with code 9,
 * so `message.complete` never arrived, `sawMessageComplete` stayed false, and
 * this function answered "still working" for 3351 seconds about a process that
 * no longer existed. `sawMessageComplete` is a proxy for "reached a stopping
 * point" that only covers the happy path; dying is a stopping point too, and
 * the one where waiting is most plainly futile — nothing is left to produce the
 * message being waited for. The truthiness check is deliberate: an empty error
 * string is not evidence of a crash.
 */
export function waitIsOver({ landed, sawMessageComplete, msSinceActivity, engineError }, quietMs = QUIET_MS) {
  if (engineError) return true
  if (!sawMessageComplete) return false
  return msSinceActivity >= quietMs
}

/**
 * What to call a run that is over.
 *
 * `timeout` is reserved for a run that actually ran out of time — still
 * working, budget exhausted. A run that went quiet without committing is a
 * different animal and gets its own name: it had time left and chose to stop,
 * usually having satisfied its contract while leaving the tree dirty. Spelling
 * both `timeout` put two unrelated failures in one bucket, and the corpus
 * cannot learn a distinction the ledger refuses to make.
 *
 * `engine_error` is the same argument one layer down. Every label above it is a
 * statement about the MODEL — it finished, it stopped early, it was restricted
 * to no tools, it used all its time. A crashed inference server is a statement
 * about the HARNESS, and the two want opposite fixes: `timeout` says raise the
 * budget, `engine_error` says the budget was never the problem. Wave 7h run 2
 * was filed as `timeout` because the default branch is where unmodelled causes
 * go to be misattributed, and a fall-through default is a measurement
 * assumption in disguise.
 *
 * It outranks `zero_tool_fail` on the same grounds: that label means S5
 * restricted the tool set so nothing could run (F7), and sending the next
 * investigation to the governance layer for a dead server wastes the finding.
 * It does NOT outrank `landed` — work that reached a commit before the crash is
 * still work that landed, and the verification gate can still read it.
 *
 * `never_dispatched` is that argument one layer further down again, and it is
 * the only label here that is a statement about neither the model nor the
 * inference server but about THIS SCRIPT and the engine failing to agree on a
 * wire format. F32: the bridge refused the command frame on a schema skew,
 * logged the refusal to its own stdout, and left the socket open; no turn ever
 * ran. Every label above would be a lie about a model that was never asked
 * anything, and `timeout` — where it would otherwise fall through — is the
 * worst of them, because it says "raise the budget" about a mission that no
 * budget could have helped.
 */
export function missionOutcome({ landed, zeroToolCompletion, wentQuiet, engineError, neverDispatched }) {
  if (landed) return 'landed'
  if (engineError) return 'engine_error'
  if (zeroToolCompletion) return 'zero_tool_fail'
  // Above `wentQuiet`, because a run that never started is also trivially quiet.
  if (neverDispatched) return 'never_dispatched'
  if (wentQuiet) return 'stopped_without_commit'
  return 'timeout'
}

/**
 * What did this mission commit and then throw away?
 *
 * F38. Every gate in this harness reads `git log`, and `git log` is not the
 * history — it is the history that survived. Gilded Wave 9 committed `18e8037`,
 * whose message says in as many words that a test file was renamed so that
 * "mutations to schemes.py are killed immediately instead of after 431 other
 * tests", amended it, `git reset --hard` back to a pre-mission SHA, and
 * re-committed as `8c94050`, whose message mentions only a removed conftest
 * hook. The renamed file is still in the delivered tree. Nothing that reads the
 * log can see the sentence that gave the game away.
 *
 * This is the sibling of "the working tree is not the delivery": there a gate
 * read a state the commit did not contain; here it reads a story the reflog
 * contradicts.
 *
 * **This is a record, not a prohibition.** Missions legitimately amend, squash
 * and fix up, and a driver that failed them for it would teach exactly the wrong
 * lesson — hide the tidying, not stop the gaming. What matters is that the row
 * carries the discarded MESSAGES, because those are the evidence; `rewritten:
 * true` alone would hide the same sentence a second time.
 *
 * @param reflog `git reflog --date=unix --format=%H%x09%gd%x09%gs` parsed to
 *   `{ sha, at, action, message }`, newest first. `null` when it could not be
 *   read, which returns `null` — unknown, never a clean bill of health.
 * @param reachable SHAs still reachable from HEAD (`git rev-list base..HEAD`
 *   plus the baseline). A commit entry absent from this set was discarded.
 * @param sinceEpochS dispatch time in unix seconds. Entries older than this
 *   belong to a previous mission; charging them here is the same error
 *   missionCommitted() was given a name to stop.
 */
export function historyRewrite({ reflog, reachable, sinceEpochS }) {
  if (!reflog) return null
  const discarded = []
  const seen = new Set()
  for (const e of reflog) {
    if (e.at < sinceEpochS) continue
    // Only entries that CREATED a commit. A `reset` names a SHA it moved to,
    // which is by definition still reachable when the move was forward, and
    // when it was backward the reset's own SHA is not the lost work — the
    // commits are. `rewritten` must mean "work disappeared", not "a reset
    // appears in the reflog": the second is a mechanism and the first is the
    // property, and a mechanism is a list of one.
    if (!/^commit\b/.test(e.action ?? '')) continue
    if (reachable.has(e.sha)) continue
    if (seen.has(e.sha)) continue
    seen.add(e.sha)
    discarded.push({ sha: e.sha, message: e.message })
  }
  return { rewritten: discarded.length > 0, discarded }
}

// meta: { missionId, briefFile, marker, markerSeen, cwd, dispatchedAt, durationS,
//         outcome: 'landed' | 'timeout' | 'stopped_without_commit' | 'zero_tool_fail' | 'engine_error' | 'never_dispatched',
//         engineError?: string,                 // session.error text, null when healthy
//         verified?: boolean, verify?: object,  // Phase 2(b) check-script result
//         mutationSweep?: { command, killed, total, survived: string[] } }
export function buildMissionRecord(collector, meta) {
  return {
    schema: 1,
    missionId: meta.missionId,
    briefFile: meta.briefFile,
    marker: meta.marker,
    // Whether the marker actually appeared in the commit subject. It is NOT what
    // decides `outcome` — the driver lands on any commit in baselineSha..HEAD —
    // because a brief is free to dictate its own subject format, and UI Wave 6d's
    // did. Kept so a record can still say whether the two agreed.
    markerSeen: meta.markerSeen ?? null,
    cwd: meta.cwd,
    dispatchedAt: meta.dispatchedAt,
    durationS: meta.durationS,
    outcome: meta.outcome,
    // What the engine said when it died, verbatim. Always present: an absent
    // field reads as "no crash" and as "written by a driver that could not tell"
    // at the same time, and those are the two readings that must not be
    // confusable. `outcome: 'engine_error'` says a crash happened; this says
    // which one, so a repeated llama-server exit can be told from a one-off.
    engineError: meta.engineError ?? null,
    // Phase 2(b): set by the driver's post-mission check script (exit 0 =>
    // true); null when no check command was supplied (manual-patch path).
    verified: meta.verified ?? null,
    verify: meta.verify ?? null, // { command, exitCode, timedOut, durationMs, outputTail }
    // The second, independent label: did a withheld mutation set make the
    // repo's own tests go red for every stated rule? null means UNMEASURED —
    // a sweep that has not been run is not a sweep that passed, and it is not
    // a sweep that failed. See the header for why `verified` cannot stand in.
    mutationSweep: meta.mutationSweep ?? null,
    // F38: `{ rewritten, discarded: [{ sha, message }] }` from historyRewrite().
    // null means the reflog could not be read — unknown, not clean. `verified`
    // and `mutationSweep` both read the surviving history; this is the only
    // field that can say the surviving history is not all of it.
    history: meta.history ?? null,
    turns: collector.turns,
    s5Decisions: collector.s5Decisions,
    controlSignals: collector.controlSignals,
    toolTransport: collector.toolTransport,
    toolStats: collector.toolStats,
    // P4.3/4(e): session-level regulator fidelity (not per-turn); null when the
    // engine emitted no session_fidelity event (no contract / older engine).
    regulatorFidelity: collector.regulatorFidelity ?? null,
    // F33: every trajectory task this mission started, in order. This is the
    // ONLY key that joins a ledger row to the reward the model was trained on.
    // Without it, UI Wave 8's reward of 0.983 and UI Wave 8's real verdict —
    // 13 of 16 gated DoD items, six unowned rules — sat in two files with
    // nothing in common but a timestamp nobody had checked.
    //
    // `[]` and absent are different facts and must stay so: `[]` is a driver
    // that asked and was told nothing, absent is a record written before the
    // question existed. Never null.
    taskIds: collector.taskIds ?? [],
  }
}
