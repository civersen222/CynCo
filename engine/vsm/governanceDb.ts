/**
 * GovernanceDB — SQLite persistence for governance data across sessions.
 *
 * Wraps Bun's built-in SQLite to store session outcomes, per-turn measurements,
 * and computed strategy fitness. This enables S4/S5 cross-session learning:
 * the autopoietic system can query historical performance to evolve its
 * governance parameters instead of starting fresh each session.
 *
 * Uses WAL mode for concurrent read safety and snake_case columns mapped
 * from camelCase TypeScript fields.
 */

import { Database } from 'bun:sqlite'

// ─── Types ──────────────────────────────────────────────────────────

export type SessionRecord = {
  sessionId: string
  outcome: 'viable' | 'marginal' | 'non-viable'
  configIndex: number
  strategy: string
  toolSuccessRate: number
  stuckTurns: number
  totalTurns: number
  filesChanged: number
}

export type MeasurementRecord = {
  sessionId: string
  turn: number
  toolErrorRate: number
  contextUtilization: number
  stuckTurns: number
  tokenEfficiency: number
  s4Composite: number
}

export type StrategyFitness = {
  strategy: string
  totalSessions: number
  viableCount: number
  winRate: number
  avgToolSuccess: number
  avgFilesChanged: number
}

export type BoundStatistics = {
  count: number
  p10: number
  p50: number
  p90: number
  min: number
  max: number
}

// ─── Column mapping ─────────────────────────────────────────────────

const MEASUREMENT_FIELD_MAP: Record<string, string> = {
  toolErrorRate: 'tool_error_rate',
  contextUtilization: 'context_utilization',
  stuckTurns: 'stuck_turns',
  tokenEfficiency: 'token_efficiency',
  s4Composite: 's4_composite',
}

// ─── Class ──────────────────────────────────────────────────────────

export class GovernanceDB {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.createTables()
  }

  // ── Schema ──────────────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT PRIMARY KEY,
        outcome         TEXT NOT NULL,
        config_index    INTEGER NOT NULL,
        strategy        TEXT NOT NULL,
        tool_success_rate REAL NOT NULL,
        stuck_turns     INTEGER NOT NULL,
        total_turns     INTEGER NOT NULL,
        files_changed   INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS measurements (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id          TEXT NOT NULL,
        turn                INTEGER NOT NULL,
        tool_error_rate     REAL NOT NULL,
        context_utilization REAL NOT NULL,
        stuck_turns         INTEGER NOT NULL,
        token_efficiency    REAL NOT NULL,
        s4_composite        REAL NOT NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )
    `)
  }

  // ── Sessions ────────────────────────────────────────────────────

  recordSession(record: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, outcome, config_index, strategy, tool_success_rate,
         stuck_turns, total_turns, files_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.sessionId,
      record.outcome,
      record.configIndex,
      record.strategy,
      record.toolSuccessRate,
      record.stuckTurns,
      record.totalTurns,
      record.filesChanged,
    )
  }

  getRecentSessions(limit: number): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT session_id, outcome, config_index, strategy, tool_success_rate,
             stuck_turns, total_turns, files_changed
      FROM sessions
      ORDER BY created_at DESC
      LIMIT ?
    `)
    const rows = stmt.all(limit) as any[]
    return rows.map(row => ({
      sessionId: row.session_id,
      outcome: row.outcome,
      configIndex: row.config_index,
      strategy: row.strategy,
      toolSuccessRate: row.tool_success_rate,
      stuckTurns: row.stuck_turns,
      totalTurns: row.total_turns,
      filesChanged: row.files_changed,
    }))
  }

  // ── Measurements ────────────────────────────────────────────────

  recordMeasurement(record: MeasurementRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO measurements
        (session_id, turn, tool_error_rate, context_utilization,
         stuck_turns, token_efficiency, s4_composite)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.sessionId,
      record.turn,
      record.toolErrorRate,
      record.contextUtilization,
      record.stuckTurns,
      record.tokenEfficiency,
      record.s4Composite,
    )
  }

  getMeasurements(sessionId: string): MeasurementRecord[] {
    const stmt = this.db.prepare(`
      SELECT session_id, turn, tool_error_rate, context_utilization,
             stuck_turns, token_efficiency, s4_composite
      FROM measurements
      WHERE session_id = ?
      ORDER BY turn ASC
    `)
    const rows = stmt.all(sessionId) as any[]
    return rows.map(row => ({
      sessionId: row.session_id,
      turn: row.turn,
      toolErrorRate: row.tool_error_rate,
      contextUtilization: row.context_utilization,
      stuckTurns: row.stuck_turns,
      tokenEfficiency: row.token_efficiency,
      s4Composite: row.s4_composite,
    }))
  }

  // ── Analytics ───────────────────────────────────────────────────

  getStrategyFitness(strategy: string): StrategyFitness {
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as total FROM sessions WHERE strategy = ?
    `)
    const viableStmt = this.db.prepare(`
      SELECT COUNT(*) as viable FROM sessions WHERE strategy = ? AND outcome = 'viable'
    `)
    const avgStmt = this.db.prepare(`
      SELECT AVG(tool_success_rate) as avg_tool, AVG(files_changed) as avg_files
      FROM sessions WHERE strategy = ?
    `)

    const total = (countStmt.get(strategy) as any).total as number
    const viable = (viableStmt.get(strategy) as any).viable as number
    const avgs = avgStmt.get(strategy) as any

    return {
      strategy,
      totalSessions: total,
      viableCount: viable,
      winRate: total > 0 ? viable / total : 0,
      avgToolSuccess: avgs.avg_tool ?? 0,
      avgFilesChanged: avgs.avg_files ?? 0,
    }
  }

  getBoundStatistics(field: string, limit: number): BoundStatistics {
    const column = MEASUREMENT_FIELD_MAP[field]
    if (!column) {
      throw new Error(`Unknown measurement field: ${field}`)
    }

    // Fetch recent values sorted ascending for percentile computation.
    // Column name is validated against the allow-list above, so this
    // interpolation is safe from injection.
    const stmt = this.db.prepare(`
      SELECT ${column} as val
      FROM measurements
      ORDER BY created_at DESC
      LIMIT ?
    `)
    const rows = stmt.all(limit) as { val: number }[]

    if (rows.length === 0) {
      return { count: 0, p10: 0, p50: 0, p90: 0, min: 0, max: 0 }
    }

    const values = rows.map(r => r.val).sort((a, b) => a - b)
    const n = values.length

    const percentile = (p: number): number => {
      const idx = Math.floor((p / 100) * (n - 1))
      return values[idx]
    }

    return {
      count: n,
      p10: percentile(10),
      p50: percentile(50),
      p90: percentile(90),
      min: values[0],
      max: values[n - 1],
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  close(): void {
    // Checkpoint WAL to main DB file before closing so that -wal/-shm
    // file locks are released promptly (important on Windows).
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    this.db.close()
  }
}
