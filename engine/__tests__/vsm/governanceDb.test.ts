import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GovernanceDB } from '../../vsm/governanceDb.js'
import type { SessionRecord, MeasurementRecord } from '../../vsm/governanceDb.js'

describe('GovernanceDB', () => {
  let db: GovernanceDB
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'govdb-'))
    db = new GovernanceDB(join(tmpDir, 'governance.db'))
  })

  afterEach(() => {
    db.close()
    // On Windows, SQLite WAL files may stay briefly locked after close.
    // Wrap cleanup in try/catch — OS cleans temp dirs regardless.
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // ── 1. Table creation ────────────────────────────────────────────

  it('creates tables on init without throwing', () => {
    // If we got here, constructor succeeded.
    // Opening a second instance on the same file should also work.
    const db2 = new GovernanceDB(join(tmpDir, 'governance.db'))
    db2.close()
  })

  // ── 2. Session CRUD ──────────────────────────────────────────────

  it('records a session and retrieves it', () => {
    const session: SessionRecord = {
      sessionId: 'sess-001',
      outcome: 'viable',
      configIndex: 3,
      strategy: 'persistence',
      toolSuccessRate: 0.92,
      stuckTurns: 1,
      totalTurns: 15,
      filesChanged: 4,
    }

    db.recordSession(session)
    const rows = db.getRecentSessions(10)

    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe('sess-001')
    expect(rows[0].outcome).toBe('viable')
    expect(rows[0].configIndex).toBe(3)
    expect(rows[0].strategy).toBe('persistence')
    expect(rows[0].toolSuccessRate).toBeCloseTo(0.92)
    expect(rows[0].stuckTurns).toBe(1)
    expect(rows[0].totalTurns).toBe(15)
    expect(rows[0].filesChanged).toBe(4)
  })

  // ── 3. Measurement CRUD ──────────────────────────────────────────

  it('records measurements and retrieves them', () => {
    // Need a parent session for FK
    db.recordSession({
      sessionId: 'sess-m1',
      outcome: 'marginal',
      configIndex: 0,
      strategy: 'balanced',
      toolSuccessRate: 0.8,
      stuckTurns: 2,
      totalTurns: 10,
      filesChanged: 2,
    })

    const m1: MeasurementRecord = {
      sessionId: 'sess-m1',
      turn: 1,
      toolErrorRate: 0.1,
      contextUtilization: 0.45,
      stuckTurns: 0,
      tokenEfficiency: 0.85,
      s4Composite: 0.72,
    }
    const m2: MeasurementRecord = {
      sessionId: 'sess-m1',
      turn: 2,
      toolErrorRate: 0.05,
      contextUtilization: 0.55,
      stuckTurns: 1,
      tokenEfficiency: 0.9,
      s4Composite: 0.78,
    }

    db.recordMeasurement(m1)
    db.recordMeasurement(m2)

    const rows = db.getMeasurements('sess-m1')
    expect(rows).toHaveLength(2)
    expect(rows[0].turn).toBe(1)
    expect(rows[0].toolErrorRate).toBeCloseTo(0.1)
    expect(rows[1].turn).toBe(2)
    expect(rows[1].s4Composite).toBeCloseTo(0.78)
  })

  // ── 4. Strategy fitness ──────────────────────────────────────────

  it('getStrategyFitness returns correct win rate', () => {
    const base = {
      configIndex: 0,
      strategy: 'diversity',
      toolSuccessRate: 0.9,
      stuckTurns: 0,
      totalTurns: 10,
      filesChanged: 3,
    }

    db.recordSession({ ...base, sessionId: 's1', outcome: 'viable' })
    db.recordSession({ ...base, sessionId: 's2', outcome: 'viable' })
    db.recordSession({ ...base, sessionId: 's3', outcome: 'non-viable', toolSuccessRate: 0.6, filesChanged: 1 })

    const fitness = db.getStrategyFitness('diversity')

    expect(fitness.strategy).toBe('diversity')
    expect(fitness.totalSessions).toBe(3)
    expect(fitness.viableCount).toBe(2)
    expect(fitness.winRate).toBeCloseTo(2 / 3)
    // avg tool success: (0.9 + 0.9 + 0.6) / 3 = 0.8
    expect(fitness.avgToolSuccess).toBeCloseTo(0.8)
    // avg files changed: (3 + 3 + 1) / 3 ≈ 2.33
    expect(fitness.avgFilesChanged).toBeCloseTo(7 / 3)
  })

  it('getStrategyFitness returns zeros for unknown strategy', () => {
    const fitness = db.getStrategyFitness('nonexistent')
    expect(fitness.totalSessions).toBe(0)
    expect(fitness.winRate).toBe(0)
  })

  // ── 5. Bound statistics (percentiles) ────────────────────────────

  it('getBoundStatistics returns percentiles for 20 measurements', () => {
    // Create a parent session
    db.recordSession({
      sessionId: 'sess-stats',
      outcome: 'viable',
      configIndex: 0,
      strategy: 'balanced',
      toolSuccessRate: 0.9,
      stuckTurns: 0,
      totalTurns: 20,
      filesChanged: 5,
    })

    // Insert 20 measurements with increasing tool_error_rate: 0.00, 0.05, ..., 0.95
    for (let i = 0; i < 20; i++) {
      db.recordMeasurement({
        sessionId: 'sess-stats',
        turn: i + 1,
        toolErrorRate: i * 0.05,
        contextUtilization: 0.5,
        stuckTurns: 0,
        tokenEfficiency: 0.8,
        s4Composite: 0.7,
      })
    }

    const stats = db.getBoundStatistics('toolErrorRate', 100)

    expect(stats.count).toBe(20)
    expect(stats.min).toBeCloseTo(0.0)
    expect(stats.max).toBeCloseTo(0.95)

    // Values sorted: [0.00, 0.05, 0.10, ..., 0.95], n=20
    // p10: floor(0.1 * 19) = index 1 → 0.05
    // p50: floor(0.5 * 19) = index 9 → 0.45
    // p90: floor(0.9 * 19) = index 17 → 0.85
    expect(stats.p10).toBeCloseTo(0.05)
    expect(stats.p50).toBeCloseTo(0.45)
    expect(stats.p90).toBeCloseTo(0.85)
  })

  it('getBoundStatistics returns zeros for empty data', () => {
    const stats = db.getBoundStatistics('s4Composite', 100)
    expect(stats.count).toBe(0)
    expect(stats.p50).toBe(0)
  })

  it('getBoundStatistics throws for unknown field', () => {
    expect(() => db.getBoundStatistics('bogusField', 10)).toThrow('Unknown measurement field')
  })
})
