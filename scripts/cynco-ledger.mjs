// Mission outcome ledger (governance falsification program, step 1).
//
// Pure collector: the mission driver feeds it every WS event; on mission end
// buildMissionRecord() produces one JSONL record pairing the full per-turn
// governance signal vector + every S5 decision with the labeled binary
// outcome. This is the dataset that makes the VSM/S5 layer falsifiable —
// step 2 (per-rule precision/recall) runs directly off these records.
//
// Records land in benchmark/cynco-ledger/missions.jsonl (committed to git).
// Ground-truth label for scoring: outcome === 'landed' && verified === true
// (`verified` is set by the driver's post-mission check script when a
// check-cmd is supplied — Phase 2(b) — or patched in manually otherwise).

export function createMissionCollector(now = () => Date.now()) {
  return {
    turns: [],
    s5Decisions: [],
    controlSignals: [],
    toolTransport: [],
    toolStats: { total: 0, errors: 0, byName: {} },
    enforcedSeen: false,

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

// meta: { missionId, briefFile, marker, cwd, dispatchedAt, durationS,
//         outcome: 'landed' | 'timeout' | 'zero_tool_fail',
//         verified?: boolean, verify?: object } // Phase 2(b) check-script result
export function buildMissionRecord(collector, meta) {
  return {
    schema: 1,
    missionId: meta.missionId,
    briefFile: meta.briefFile,
    marker: meta.marker,
    cwd: meta.cwd,
    dispatchedAt: meta.dispatchedAt,
    durationS: meta.durationS,
    outcome: meta.outcome,
    // Phase 2(b): set by the driver's post-mission check script (exit 0 =>
    // true); null when no check command was supplied (manual-patch path).
    verified: meta.verified ?? null,
    verify: meta.verify ?? null, // { command, exitCode, timedOut, durationMs, outputTail }
    turns: collector.turns,
    s5Decisions: collector.s5Decisions,
    controlSignals: collector.controlSignals,
    toolTransport: collector.toolTransport,
    toolStats: collector.toolStats,
  }
}
