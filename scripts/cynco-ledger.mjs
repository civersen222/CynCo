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

// meta: { missionId, briefFile, marker, markerSeen, cwd, dispatchedAt, durationS,
//         outcome: 'landed' | 'timeout' | 'zero_tool_fail',
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
    // Phase 2(b): set by the driver's post-mission check script (exit 0 =>
    // true); null when no check command was supplied (manual-patch path).
    verified: meta.verified ?? null,
    verify: meta.verify ?? null, // { command, exitCode, timedOut, durationMs, outputTail }
    // The second, independent label: did a withheld mutation set make the
    // repo's own tests go red for every stated rule? null means UNMEASURED —
    // a sweep that has not been run is not a sweep that passed, and it is not
    // a sweep that failed. See the header for why `verified` cannot stand in.
    mutationSweep: meta.mutationSweep ?? null,
    turns: collector.turns,
    s5Decisions: collector.s5Decisions,
    controlSignals: collector.controlSignals,
    toolTransport: collector.toolTransport,
    toolStats: collector.toolStats,
    // P4.3/4(e): session-level regulator fidelity (not per-turn); null when the
    // engine emitted no session_fidelity event (no contract / older engine).
    regulatorFidelity: collector.regulatorFidelity ?? null,
  }
}
