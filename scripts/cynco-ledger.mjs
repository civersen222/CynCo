// Mission outcome ledger (governance falsification program, step 1).
//
// Pure collector: the mission driver feeds it every WS event; on mission end
// buildMissionRecord() produces one JSONL record pairing the full per-turn
// governance signal vector + every S5 decision with the labeled binary
// outcome. This is the dataset that makes the VSM/S5 layer falsifiable —
// step 2 (per-rule precision/recall) runs directly off these records.
//
// Records land in benchmark/cynco-ledger/ (committed to git), split across
// missions.jsonl + missions.NNNN.jsonl — see cynco-ledger-shards.mjs.
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
//   accepted           : the above AND mutationSweep left no survivor that a
//                        DoD item claimed to own. For an AUTHORED sweep that is
//                        killed === total, since every mutation in it was
//                        written against a stated rule. A DERIVED sweep
//                        (--kind derived) enumerates mutations over lines the
//                        mission merely touched, so its survivors are coverage
//                        findings and do not fail the row. labelOf() in
//                        cynco-signal-validation.mjs is the one implementation.
//   unmeasured         : mutationSweep === null — NOT a failure, and not a
//                        success either. Exclude it; never default it.

/**
 * Tool verb classes. Measured on 11k4/11L/11M/11N: "delivery" counted as
 * Edit+Write reads 4.9-8.3% and looks healthy, because scratch Writes
 * (base_realm.py copies, probe dumps, *_diff.txt) dominate it. Splitting the
 * classes is what makes the 2% source-edit rate visible.
 */
const SOURCE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'ReplaceFunction', 'ApplyPatch', 'NotebookEdit'])
const FILE_WRITE_TOOLS = new Set(['Write'])

export function classifyTool(name) {
  if (SOURCE_EDIT_TOOLS.has(name)) return 'sourceEdit'
  if (FILE_WRITE_TOOLS.has(name)) return 'fileWrite'
  return 'inspect'
}

export function createMissionCollector(now = () => Date.now()) {
  return {
    turns: [],
    s5Decisions: [],
    controlSignals: [],
    toolTransport: [],
    // Serialised verbatim into the record by buildMissionRecord, so everything
    // in here is a published field and nothing in here may be a private counter.
    //
    // `commits` and `maxCallsWithoutCommit` are filled by observeCommit() below,
    // driven by the driver's HEAD poll rather than by a tool name: the wave
    // commits through Bash, so there is nothing in the tool stream to watch for.
    // A collector nobody polls therefore still reports 0/0 — see seedBaselineHead
    // for the one case where that 0 is a fact and not an absence.
    toolStats: {
      total: 0,
      errors: 0,
      byName: {},
      byClass: { sourceEdit: 0, fileWrite: 0, inspect: 0 },
      maxCallsWithoutSourceEdit: 0,
      commits: 0,
      maxCallsWithoutCommit: 0,
    },
    // Real token counts from the server's own timings (session.tokenStats,
    // cumulative — each frame supersedes the last, so keeping the newest IS
    // the sum). null means the engine never reported: an older engine or a
    // run that died before its first model turn. null, not zeros — economics
    // must fall back to its labelled estimate, never mistake absence for a
    // free mission.
    tokenStats: null,
    // Running counters, deliberately siblings of toolStats rather than fields
    // in it: toolStats goes into the record as-is, and the ledger's rows should
    // carry the statistic, not the bookkeeping that produced it.
    _sinceSourceEdit: 0,
    _sinceCommit: 0,
    // The last HEAD this collector was shown. null means "nothing seen yet", and
    // the first sha handed over counts as a commit — which is why the driver
    // must seed the dispatch baseline before it starts polling.
    _lastHead: null,
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
        case 'session.tokenStats':
          // Cumulative frame: overwrite, don't add. The engine sums; the
          // collector keeps the latest sum it has seen.
          this.tokenStats = {
            prefillTokens: m.prefillTokens ?? 0,
            cachedTokens: m.cachedTokens ?? 0,
            decodeTokens: m.decodeTokens ?? 0,
            measuredTurns: m.measuredTurns ?? 0,
            unmeasuredTurns: m.unmeasuredTurns ?? 0,
          }
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
          // No isError here, and that is not an oversight: a tool.start frame
          // never carries one. The engine emits the outcome on the separate
          // tool.complete frame below, so passing m.isError through would
          // either read undefined forever or, if the frame ever grew the field,
          // count the same failure twice.
          this.observeToolCall({ name: m.toolName ?? 'unknown' })
          break
        }
        case 'tool.complete':
          if (m.isError) this.toolStats.errors++
          break
      }
    },

    /**
     * One tool call, accounted once.
     *
     * This exists as a named method so the accounting can be tested without
     * standing up a websocket, and the tool.start branch above calls it rather
     * than keeping its own copy — two implementations of a count are two counts
     * that will eventually disagree, and the disagreement would show up as a
     * ledger row nobody could reproduce.
     *
     * `isError` is honoured for a caller that has the outcome in hand; the
     * live path does not, and counts errors from tool.complete instead.
     */
    observeToolCall(m) {
      const name = m.name
      this.toolStats.total++
      this.toolStats.byName[name] = (this.toolStats.byName[name] ?? 0) + 1
      if (m.isError) this.toolStats.errors++

      // An unknown verb falls into `inspect` rather than being dropped: a tool
      // this script has never heard of still consumed a call, and a total that
      // does not equal the sum of its classes is a total nobody can check.
      const cls = classifyTool(name)
      this.toolStats.byClass[cls]++
      if (cls === 'sourceEdit') {
        this._sinceSourceEdit = 0
      } else {
        this._sinceSourceEdit++
        if (this._sinceSourceEdit > this.toolStats.maxCallsWithoutSourceEdit) {
          this.toolStats.maxCallsWithoutSourceEdit = this._sinceSourceEdit
        }
      }

      // Every call widens the commit gap, including the source edits that reset
      // the gap above. The asymmetry is deliberate: a source edit IS a tool call
      // and so resets its own counter on the call that performed it, whereas a
      // commit is observed out of band by the driver's poll and resets this one
      // without ever appearing in the tool stream.
      this._sinceCommit++
      if (this._sinceCommit > this.toolStats.maxCallsWithoutCommit) {
        this.toolStats.maxCallsWithoutCommit = this._sinceCommit
      }
    },

    /**
     * The HEAD the mission was dispatched on, which is the one commit in the
     * repo this mission did not make.
     *
     * Without this the driver's first poll hands observeCommit a sha it has
     * never seen, and every row in the ledger reads `commits: 1` for a mission
     * that committed nothing. That is strictly worse than the hard 0 this task
     * replaced: a 0 nobody filled is visibly unmeasured, whereas a fabricated 1
     * is indistinguishable from a delivery. Eight consecutive runs ended
     * uncommitted; the field exists to say so, and it can only say so if the
     * baseline is excluded by construction.
     *
     * A null baseline is left unseeded on purpose. gitHead() returns null rather
     * than guessing when it cannot read the repo, and pinning _lastHead to a
     * falsy value would make the first real commit compare equal to "unknown"
     * and vanish.
     */
    seedBaselineHead(head) {
      if (head) this._lastHead = head
    },

    /**
     * A new HEAD in the mission workspace. Called by the driver's poll, not by
     * the model: the wave commits through Bash, so there is no tool name to
     * watch for. Idempotent on an unchanged HEAD because the poll fires on a
     * timer and most polls see nothing new.
     *
     * The poll's period bounds the precision of `maxCallsWithoutCommit`: calls
     * made between a commit and the next poll are still charged to the previous
     * gap. That over-reports by at most one poll interval's worth of calls, and
     * over-reporting a gap is the safe direction for a number whose whole job is
     * to notice that nothing is being saved.
     */
    observeCommit(head) {
      if (!head || head === this._lastHead) return
      this._lastHead = head
      this.toolStats.commits++
      this._sinceCommit = 0
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
 *
 * `engineProcessing` outranks everything below the engine error, and it is the
 * F57 fix. Everything else here reasons about the run from OUTSIDE it, by
 * watching a socket; `engineProcessing` is the run's own `isProcessing` flag,
 * read from /api/run. Gilded Wave 10 went quiet after `message.complete`, was
 * declared finished, graded, and filed — and was still executing model calls
 * forty minutes later, in the repo it had just been graded on. Silence is a
 * symptom of stopping and also a symptom of thinking, and no amount of tuning
 * `quietMs` separates them. Asking does.
 *
 * Three states, not two:
 *   true  — the loop has the turn open. Not over, whatever the socket looks
 *           like. Bounded by the driver's own TIMEOUT_S, so a loop that never
 *           clears the flag costs a budget, not a hang.
 *   false — the loop closed the turn. Over, and sooner than quiescence would
 *           have said, without waiting out `quietMs` for a run already done.
 *           Only trusted once `workBegun`: before the first turn event the flag
 *           is legitimately false because nothing has started yet, and reading
 *           that as "finished" would end every mission at the first poll.
 *   null  — nobody answered: endpoint absent, engine older than this script,
 *           HTTP failed. Falls back to the silence heuristic, and the caller
 *           must record that the exit was inferred rather than observed. An
 *           unreachable engine read as `false` would be the original defect
 *           restored, this time with a confident-looking field behind it.
 */
export function waitIsOver(state, quietMs = QUIET_MS) {
  return waitExitReason(state, quietMs) !== null
}

/**
 * Why the wait ended, or null while it has not. `waitIsOver` is this predicate;
 * the reason exists separately because the ledger has to distinguish an exit the
 * engine confirmed from one this script guessed at, and a boolean cannot say
 * which of the two it was.
 */
export function waitExitReason(
  { landed, sawMessageComplete, msSinceActivity, engineError, engineProcessing = null, workBegun = true, engineGone = false },
  quietMs = QUIET_MS,
) {
  if (engineError) return 'engine_error'
  // Absence, not silence. `tool.start` clears `sawMessageComplete`, so an engine
  // that dies mid-turn leaves this predicate with no way out: engineProcessing
  // is null forever because nothing is listening, and the quiet heuristic is
  // gated behind a message.complete that will never arrive. Stage 11K's third
  // dispatch sat in exactly that state polling a dead port, and would have sat
  // there for the full six-hour budget without writing the record it had already
  // earned. The caller only sets this once /api/run has answered at least once
  // in THIS run and the socket has since closed, so an engine too old to have
  // the endpoint still falls through to the heuristic rather than being called
  // dead.
  if (engineGone) return 'engine_gone'
  if (engineProcessing === true) return null
  if (engineProcessing === false && workBegun) return 'engine_closed_the_turn'
  if (!sawMessageComplete) return null
  return msSinceActivity >= quietMs ? 'quiet_heuristic' : null
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
 * F52: may the held-out gate speak for this delivery, and is there one to read?
 *
 * `verified` is the reward-bearing label. It means one thing: THIS MISSION'S
 * FINISHED DELIVERY was measured against the gate and the gate said so. A run
 * the harness cut short has no finished delivery, and a `false` filed for one is
 * a fabricated negative — the model did not fail, the inference server did.
 *
 * Measured on Gilded Wave 10. llama-server exited with code 9 at turn 40 with 35
 * tests written and uncommitted; the driver printed "ENGINE ERROR outcome — the
 * harness died, not the model" and then ran the 50-minute gate anyway, against a
 * HEAD that had never received the work. Its exit code would have been a true
 * statement about the PREVIOUS state of the repository, filed under this
 * mission's id as its verdict. That is the identical error `neverDispatched`
 * already guards, arriving through a door nobody had shut.
 *
 * Three dispositions, because the two failures differ in what exists to read:
 *
 *  - `skip`: nothing was committed, so there is no delivery. Running the gate
 *    can only mislabel the pre-existing tree — and costs a gate's full budget to
 *    do it.
 *  - `advisory`: a commit landed before the crash, so the gate CAN read
 *    something. It runs and its exit code is recorded in `verify`, because that
 *    is real evidence and discarding it would be its own kind of assumption. But
 *    `verified` stays null: the run never reached its own end, so a red gate may
 *    be measuring work in progress rather than work delivered. Promote the label
 *    by hand after re-running, or re-dispatch.
 *  - `measure`: the ordinary path, where the label means what it says.
 *
 * Note this does NOT contradict `missionOutcome`, where `landed` outranks
 * `engine_error`. That field answers "what happened to the run" and a commit
 * really did land. This one answers "was the delivery measured", and those are
 * different questions about the same event — the whole reason they are separate
 * columns.
 *
 * F56 added `quiet`, and it is the same lesson arriving through a fourth door.
 * The driver already knew about this case and already said so out loud —
 * "WARNING: commit landed but the run never went quiet — the check below may
 * read a commit the run is still amending" — and then labelled the record
 * anyway. On Gilded Wave 10 that warning fired at dispatch-log line 728, the
 * gate measured `43e7a94`, and the mission went on to commit `ea9ac06`, which
 * deletes a test the gate's own H2 would have caught. `verified: false` went
 * into the ledger as a verdict on a delivery nothing had read.
 *
 * A warning that changes no output is not a decision. If the run never went
 * quiet, the gate is racing the mission for the tree, and `advisory` is what
 * that is spelled as.
 */
export function gateDisposition({ neverDispatched, engineError, landed, quiet, runStillOpen }) {
  if (neverDispatched) {
    return {
      run: false, label: false,
      why: 'the mission was never dispatched, so there is no delivery to check. ' +
        'verified stays null; running the gate now would label the pre-existing tree as this mission\'s work.',
    }
  }
  if (engineError && !landed) {
    return {
      run: false, label: false,
      why: 'the harness killed this run before it committed anything, so there is no delivery to check. ' +
        'verified stays null; the gate would report on a HEAD this mission never touched.',
    }
  }
  if (engineError) {
    return {
      run: true, label: false,
      why: 'the harness killed this run after a commit landed. The gate runs and its result is recorded, ' +
        'but verified stays null: an interrupted run\'s last commit may be work in progress, not delivery.',
    }
  }
  // F57. `quiet` is this script's opinion about whether the run stopped;
  // `runStillOpen` is the engine's own answer, taken after an abort it declined
  // to honour. It outranks `quiet` in both directions — a run can look perfectly
  // quiet on the socket and still be executing model calls in the workspace,
  // which is exactly what Gilded Wave 10 did for forty minutes after its driver
  // filed the record. The gate still RUNS: its output is evidence about a moving
  // tree and worth keeping. It just may not put a label on it.
  if (runStillOpen === true) {
    return {
      run: true, label: false,
      why: 'the engine still had the turn open after an abort, so the mission is writing to the ' +
        'workspace the gate is reading. The gate runs and its result is recorded, but verified stays ' +
        'null: nothing here describes a finished delivery.',
    }
  }
  // `quiet === undefined` from an older caller is not a report that the run went
  // quiet, and must not be read as one. Only an explicit `false` demotes.
  if (quiet === false) {
    return {
      run: true, label: false,
      why: 'the run never went quiet, so the gate and the mission are racing for the same tree. ' +
        'The gate runs and its result is recorded, but verified stays null: it measures whatever ' +
        'HEAD was when it started, and the mission can commit past that before it finishes.',
    }
  }
  return { run: true, label: true, why: null }
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
//         mutationSweep?: { command, killed, total, survived: string[] },
//         baselineSha?: string|null, finalSha?: string|null,  // -> commitRange
//         graderProbes?: { total, probes, uninspectable, byPattern, samples } }
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
    // The commits this mission produced, as a range a diff tool can take.
    //
    // This exists because 150 of the ledger's first 226 rows are permanently
    // unsweepable, and not for want of effort: a derived sweep
    // (scripts/cynco-mutation-sweep.py) mutates the lines the mission ADDED, so
    // it needs to know which commits were the mission's. The driver has always
    // known — it reads HEAD before dispatch and prints it — and never wrote it
    // down. The only surviving trace on those rows is prose inside
    // `verify.outputTail` ("REV 5dc9510 vs BASE c1bff64"), which is archaeology,
    // not a field. Every row from here on can be labeled later instead of only
    // now, which is the whole difference between the ledger growing and the
    // labeled set growing.
    //
    // Null when either end is unknown — never half a range. gitHead() returns
    // null rather than guessing when it cannot read the repo, and a `head: null`
    // invites the reader to substitute HEAD-as-of-now, which would sweep every
    // commit anything has made since. base === head is NOT that case: it is the
    // measured answer "this mission committed nothing", an empty diff, and it
    // has to stay distinguishable from "nobody looked".
    commitRange: meta.baselineSha && meta.finalSha
      ? { base: meta.baselineSha, head: meta.finalSha }
      : null,
    // F57: how the driver came to believe the run was over, and whether it was.
    //
    // `exitReason` is one of 'engine_error' | 'engine_closed_the_turn' |
    // 'quiet_heuristic' | 'timeout' | 'never_dispatched'. The distinction the
    // ledger needs is between the second and the third: one is the engine
    // saying it closed the turn, the other is this script inferring it from
    // silence. Every row before this field was written was the third kind and
    // could not say so, which is how Gilded Wave 10 was filed as finished
    // forty minutes before it stopped running.
    //
    // `runStillOpen` is the answer to the same question asked of the engine at
    // the end, AFTER an abort: true means the mission was still executing while
    // this record was being written and while the gate above read the tree.
    // `null` means nothing answered — an engine with no /api/run, so unknown.
    // Never default it to false; that is the assumption the whole finding is.
    exitReason: meta.exitReason ?? null,
    runStillOpen: meta.runStillOpen ?? null,
    // Tool calls the engine made AFTER the driver decided the run was over.
    // Zero on a healthy mission. Anything above zero is F57 recurring, measured
    // rather than reconstructed from timestamps three days later.
    toolCallsAfterExit: meta.toolCallsAfterExit ?? null,
    // F57: how often the mission reached for the thing that grades it.
    //
    // Wave 10 found a stale `_verify_final.cpython-314.pyc` from a dead earlier
    // mission and spent eighteen minutes walking its disassembly with
    // `marshal.loads` to reconstruct the held-out gate, then deleted a passing
    // test because its reconstruction said the count should be 48. That was
    // found by reading a transcript. Nothing on the row recorded it, so it could
    // not be counted, compared across missions, or noticed on a row nobody read.
    //
    // Named for what it OBSERVES — tool calls that touched the grading
    // apparatus — not for intent. A mission tidying `__pycache__` and a mission
    // disassembling one emit the same frame; calling the count "evasion" would
    // encode a judgement as a measurement. The samples are what let a reader
    // tell the two apart.
    //
    // `{ total, probes, uninspectable, byPattern, samples }`, or null when no
    // frame carried an inspectable input — an engine too old to put `input` on
    // the frame is not a mission that never probed. A measured `probes: 0` is a
    // different fact from an unmeasured one and must not collapse into it.
    graderProbes: meta.graderProbes ?? null,
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
    // Measured token totals (session.tokenStats) or null — see the collector.
    tokenStats: collector.tokenStats ?? null,
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
