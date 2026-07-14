import { describe, expect, it } from 'bun:test'
// The ledger collector is a plain .mjs module used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { createMissionCollector, buildMissionRecord } from '../../../scripts/cynco-ledger.mjs'

describe('cynco mission outcome ledger', () => {
  const syntheticStream = [
    { type: 'tool.start', toolName: 'Read' },
    { type: 'tool.complete', toolName: 'Read', isError: false },
    { type: 'governance.status', health: 'healthy', s3s4Balance: 'critical', toolSuccessRate: 1.0, stuckTurns: 0, varietyRatio: 9, varietyBalance: 'overload', algedonicAlerts: 0, axiomHealth: 'red', consecutiveUnstable: 3, agreementRatio: 0.0, suggestion: null },
    { type: 'control.signals', temperatureAdjust: -0.1, temperature: 0.6, bestOfNBudget: 1, widenToolSet: false },
    { type: 's5.decision', reasoning: 'homeostat unstable', contextAction: null, toolRestriction: 'read-only', modelSwitch: null, ruleIds: ['C7'], enforced: false, timestamp: 1 },
    { type: 'tool.start', toolName: 'Edit' },
    { type: 'tool.complete', toolName: 'Edit', isError: true, result: 'anchor not found' },
    { type: 'tool.start', toolName: 'Edit' },
    { type: 'tool.complete', toolName: 'Edit', isError: false },
    { type: 'governance.status', health: 'healthy', s3s4Balance: 'critical', toolSuccessRate: 0.75, stuckTurns: 1, varietyRatio: 8, varietyBalance: 'overload', algedonicAlerts: 1, axiomHealth: 'red', consecutiveUnstable: 4, agreementRatio: 0.0, suggestion: 'stuck' },
    { type: 'stream.token', text: 'ignored' },
  ]

  function collectAll() {
    let tick = 0
    const c = createMissionCollector(() => ++tick)
    for (const evt of syntheticStream) c.ingest(evt)
    return c
  }

  it('captures per-turn governance signal vectors including agreementRatio', () => {
    const c = collectAll()
    expect(c.turns.length).toBe(2)
    expect(c.turns[0].agreementRatio).toBe(0.0)
    expect(c.turns[0].consecutiveUnstable).toBe(3)
    expect(c.turns[1].stuckTurns).toBe(1)
    expect(c.turns[1].toolSuccessRate).toBe(0.75)
  })

  it('captures S5 decisions with per-rule attribution and enforcement flag', () => {
    const c = collectAll()
    expect(c.s5Decisions.length).toBe(1)
    expect(c.s5Decisions[0].ruleIds).toEqual(['C7'])
    expect(c.s5Decisions[0].enforced).toBe(false)
    expect(c.enforcedSeen).toBe(false)
  })

  it('flags enforcedSeen when a decision was enforced (F7 risk detector)', () => {
    const c = createMissionCollector()
    c.ingest({ type: 's5.decision', reasoning: 'crisis', ruleIds: ['C7'], enforced: true })
    expect(c.enforcedSeen).toBe(true)
  })

  it('counts tool usage and errors by name', () => {
    const c = collectAll()
    expect(c.toolStats.total).toBe(3)
    expect(c.toolStats.errors).toBe(1)
    expect(c.toolStats.byName).toEqual({ Read: 1, Edit: 2 })
  })

  it('captures control signals and ignores unrelated events', () => {
    const c = collectAll()
    expect(c.controlSignals.length).toBe(1)
    expect(c.controlSignals[0].temperature).toBe(0.6)
  })

  it('buildMissionRecord produces the schema-1 labeled record', () => {
    const c = collectAll()
    const rec = buildMissionRecord(c, {
      missionId: 'cynco-mission6-brief-123',
      briefFile: 'C:/tmp/cynco-mission6-brief.txt',
      marker: 'event log feed',
      cwd: 'C:\\Users\\civer\\civkings',
      dispatchedAt: '2026-07-11T22:00:00.000Z',
      durationS: 412,
      outcome: 'landed',
    })
    expect(rec.schema).toBe(1)
    expect(rec.outcome).toBe('landed')
    expect(rec.verified).toBeNull()
    expect(rec.turns.length).toBe(2)
    expect(rec.s5Decisions.length).toBe(1)
    expect(rec.toolStats.total).toBe(3)
    // Must be JSONL-safe: one line, round-trips
    const line = JSON.stringify(rec)
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual(rec)
  })

  it('handles legacy events missing the new fields (nulls, not crashes)', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', s3s4Balance: 'balanced', toolSuccessRate: 1, stuckTurns: 0, suggestion: null })
    c.ingest({ type: 's5.decision', reasoning: 'ok' })
    expect(c.turns[0].agreementRatio).toBeNull()
    expect(c.s5Decisions[0].ruleIds).toEqual([])
    expect(c.s5Decisions[0].enforced).toBeNull()
  })

  it('collects toolcall.transport events into the mission record (P1.8)', () => {
    const collector = createMissionCollector(() => 1000)
    collector.ingest({ type: 'toolcall.transport', stage: 'repaired', toolName: 'Read', detail: 'jsonrepair salvaged 40-char args' })
    collector.ingest({ type: 'toolcall.transport', stage: 'retried', toolName: 'Write', detail: 'Unexpected token' })
    collector.ingest({ type: 'toolcall.transport', stage: 'discarded', toolName: 'Write', detail: 'Unexpected token' })
    const record = buildMissionRecord(collector, {
      missionId: 'm1', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(record.toolTransport).toEqual([
      { t: 1000, stage: 'repaired', toolName: 'Read', detail: 'jsonrepair salvaged 40-char args' },
      { t: 1000, stage: 'retried', toolName: 'Write', detail: 'Unexpected token' },
      { t: 1000, stage: 'discarded', toolName: 'Write', detail: 'Unexpected token' },
    ])
  })

  it('governance.status predictions snapshot lands in the turn record (P1.2)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({
      type: 'governance.status',
      health: 'healthy',
      predictions: { open: 1, completed: 2, stats: [{ hypothesis: 'H4', total: 2, correct: 1, hitRate: 0.5, confidenceInterval: [0.1, 0.9], nullBaselineRate: 0.3, significantlyBetter: false }] },
    })
    expect(c.turns[0].predictions).toEqual({ open: 1, completed: 2, stats: [expect.objectContaining({ hypothesis: 'H4' })] })
  })

  it('governance.status without predictions records null (older engines)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].predictions).toBeNull()
  })

  it('governance.status s4 snapshot lands in the turn record (P1.3)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({
      type: 'governance.status',
      health: 'healthy',
      s4: { scores: { progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 }, composite: 7.25, reflectionCount: 1, taskType: 'debugging', taskComplexity: 5 },
    })
    expect(c.turns[0].s4).toEqual(expect.objectContaining({ composite: 7.25, reflectionCount: 1, taskType: 'debugging', taskComplexity: 5 }))
    expect(c.turns[0].s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })
  })

  it('governance.status without s4 records null (older engines)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].s4).toBeNull()
  })

  it('snapshot.taken attaches to the latest turn record (P1.4)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({ type: 'snapshot.taken', hash: 'abc123', prevHash: 'def456', filesChanged: 2, additions: 10, deletions: 3 })
    expect(c.turns[0].snapshot).toEqual({ hash: 'abc123', prevHash: 'def456', filesChanged: 2, additions: 10, deletions: 3 })
  })

  it('turns without a snapshot event carry snapshot: null; snapshot.taken before any turn does not crash', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'snapshot.taken', hash: 'abc123', prevHash: 'def456', filesChanged: 1, additions: 1, deletions: 0 })
    expect(c.turns.length).toBe(0) // ignored, no crash
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].snapshot).toBeNull()
  })

  it('governance.status carries varietyWindowed into the turn record; absent → null (P1.5)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy', varietyRatio: 5.5, varietyWindowed: 4 })
    c.ingest({ type: 'governance.status', health: 'healthy', varietyRatio: 5.5 })
    expect(c.turns[0].varietyWindowed).toBe(4)
    expect(c.turns[0].varietyRatio).toBe(5.5) // both series, side by side
    expect(c.turns[1].varietyWindowed).toBe(null)
  })

  it('governance.status carries the heterarchy snapshot into the turn record; absent → null (P1.6)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy', heterarchy: { context: 'exploration', commander: 'S4', shifted: true } })
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].heterarchy).toEqual({ context: 'exploration', commander: 'S4', shifted: true })
    expect(c.turns[1].heterarchy).toBe(null)
  })

  it('buildMissionRecord passes verified + verify detail through from meta (Phase 2b)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-verify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'landed',
      verified: true,
      verify: { command: 'pytest -q tests/smoke.py', exitCode: 0, timedOut: false, durationMs: 4200, outputTail: '3 passed' },
    })
    expect(rec.verified).toBe(true)
    expect(rec.verify.exitCode).toBe(0)
    expect(rec.verify.command).toBe('pytest -q tests/smoke.py')
  })

  it('buildMissionRecord without verified/verify stays null (manual-patch path unchanged)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-noverify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'timeout',
    })
    expect(rec.verified).toBeNull()
    expect(rec.verify).toBeNull()
  })
})
