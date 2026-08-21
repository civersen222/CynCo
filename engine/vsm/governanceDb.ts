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
  /** Per-turn cost ledger. Absent on rows written before it existed, and on any
   *  turn whose server reported nothing — nullable all the way down on purpose. */
  cost?: TurnCostRecord
}

/** The tokens-and-seconds half of a measurement. Every field independently null. */
export type TurnCostRecord = {
  prefillTokens: number | null
  cachedTokens: number | null
  decodeTokens: number | null
  prefillMs: number | null
  decodeMs: number | null
  wallMs: number | null
  slot: number | null
  /** Provenance of the numbers above. Never inferred — written by whoever read
   *  the response. A row with `source = null` predates the ledger entirely. */
  source: string | null
}

/**
 * A session's total cost, as far as anything measured it.
 *
 * `turnsMeasured` is not `turnsTotal`: turns whose server reported no timings
 * contribute nothing to the sums, so a total shown without the count it covers
 * understates the real spend by an unknown amount. Both must be displayed.
 */
export type SessionSpend = {
  turnsTotal: number
  turnsMeasured: number
  prefillTokens: number
  cachedTokens: number
  decodeTokens: number
  prefillMs: number
  decodeMs: number
  wallMs: number
  /** Distinct `cost_source` values seen. Says which servers produced the numbers. */
  sources: string[]
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

export type PredictionRecord = {
  id: number
  session_id: string
  hypothesis: string
  trigger_turn: number
  trigger_context: string | null
  predicted_outcome: string
  actual_outcome: string | null
  correct: number | null
  evaluation_turn: number | null
  created_at: string
}

export type HypothesisStats = {
  total: number
  correct: number
  hitRate: number
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
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        -- No FOREIGN KEY to sessions(session_id), deliberately. Measurements are
        -- written every turn; the session row is written once, at session END.
        -- A measurement therefore ALWAYS precedes its parent, and the constraint
        -- was never satisfiable — it only appeared to hold because bun:sqlite
        -- leaves foreign_keys OFF. Under any driver that enforces it, every
        -- per-turn write fails and a live session records nothing.
      )
    `)

    this.migrateMeasurementCostColumns()

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        id               INTEGER PRIMARY KEY,
        session_id       TEXT NOT NULL,
        hypothesis       TEXT NOT NULL,
        trigger_turn     INTEGER NOT NULL,
        trigger_context  TEXT,
        predicted_outcome TEXT NOT NULL,
        actual_outcome   TEXT,
        correct          INTEGER,
        evaluation_turn  INTEGER,
        created_at       TEXT DEFAULT (datetime('now'))
      )
    `)
  }

  /**
   * Add the cost-ledger columns to `measurements` if they are missing.
   *
   * Additive and idempotent: ALTER TABLE ADD COLUMN, never a rebuild, so existing
   * rows survive and simply read null — which is the truth about them. They were
   * written before anything measured this, and a backfilled zero would claim
   * those turns were free.
   *
   * Nullable with no DEFAULT for the same reason. SQLite ALTER TABLE ADD COLUMN
   * without a default fills existing rows with NULL, which is exactly wanted.
   */
  private migrateMeasurementCostColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(measurements)').all() as { name: string }[]).map(c => c.name),
    )
    const columns: [string, string][] = [
      ['prefill_tokens', 'INTEGER'],
      ['cached_tokens', 'INTEGER'],
      ['decode_tokens', 'INTEGER'],
      ['prefill_ms', 'REAL'],
      ['decode_ms', 'REAL'],
      ['wall_ms', 'REAL'],
      ['slot', 'INTEGER'],
      ['cost_source', 'TEXT'],
    ]
    for (const [name, type] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE measurements ADD COLUMN ${name} ${type}`)
    }
  }

  // ── Sessions ────────────────────────────────────────────────────

  recordSession(record: SessionRecord): void {
    // Write-guard: a session with no turns carries no learnable signal and
    // pollutes the outcome join. Drop it at the boundary.
    if (record.totalTurns <= 0) {
      console.warn(`[govdb] skipping degenerate session ${record.sessionId} (totalTurns=${record.totalTurns})`)
      return
    }
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

  /**
   * Sessions that have taken turns but have not ended — work in flight.
   *
   * A `sessions` row is only written at session end, so a mission that has been
   * running for hours is invisible to anything reading `getRecentSessions`,
   * including the dashboard's session list. `measurements` has carried a row per
   * turn since turn one the whole time; nothing ever asked it which sessions it
   * knew about that `sessions` did not.
   *
   * The derived fields are what the measurements actually say, not placeholders:
   * turns is the number of sealed turns, toolSuccessRate is 1 - mean tool error
   * rate over them, stuckTurns is the worst seen. `outcome` is 'running' because
   * no verdict exists yet — a session in flight has not been judged viable or
   * otherwise, and rendering it as either would be a claim nobody made.
   * `filesChanged` is 0 for the same reason it is not null: this query cannot
   * see the file tracker at all, and the count only becomes knowable at session
   * end.
   */
  getLiveSessions(limit: number): Array<Omit<SessionRecord, 'outcome'> & { outcome: 'running' }> {
    const stmt = this.db.prepare(`
      SELECT m.session_id           AS session_id,
             COUNT(*)               AS turns,
             AVG(m.tool_error_rate) AS err_rate,
             MAX(m.stuck_turns)     AS stuck_turns,
             MAX(m.created_at)      AS last_at
      FROM measurements m
      LEFT JOIN sessions s ON s.session_id = m.session_id
      WHERE s.session_id IS NULL
      GROUP BY m.session_id
      ORDER BY last_at DESC
      LIMIT ?
    `)
    const rows = stmt.all(limit) as any[]
    return rows.map(row => ({
      sessionId: row.session_id,
      outcome: 'running' as const,
      configIndex: 0,
      strategy: '',
      toolSuccessRate: 1 - (row.err_rate ?? 0),
      stuckTurns: row.stuck_turns,
      totalTurns: row.turns,
      filesChanged: 0,
    }))
  }

  /**
   * Delete legacy degenerate sessions (total_turns <= 0) written before the
   * write-guard existed. Returns the number of rows removed. Idempotent.
   */
  purgeDegenerateSessions(): number {
    const before = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    this.db.exec('DELETE FROM sessions WHERE total_turns <= 0')
    const after = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    return before - after
  }

  // ── Measurements ────────────────────────────────────────────────

  recordMeasurement(record: MeasurementRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO measurements
        (session_id, turn, tool_error_rate, context_utilization,
         stuck_turns, token_efficiency, s4_composite,
         prefill_tokens, cached_tokens, decode_tokens,
         prefill_ms, decode_ms, wall_ms, slot, cost_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const c = record.cost
    stmt.run(
      record.sessionId,
      record.turn,
      record.toolErrorRate,
      record.contextUtilization,
      record.stuckTurns,
      record.tokenEfficiency,
      record.s4Composite,
      c?.prefillTokens ?? null,
      c?.cachedTokens ?? null,
      c?.decodeTokens ?? null,
      c?.prefillMs ?? null,
      c?.decodeMs ?? null,
      c?.wallMs ?? null,
      c?.slot ?? null,
      c?.source ?? null,
    )
  }

  getMeasurements(sessionId: string): MeasurementRecord[] {
    const stmt = this.db.prepare(`
      SELECT session_id, turn, tool_error_rate, context_utilization,
             stuck_turns, token_efficiency, s4_composite,
             prefill_tokens, cached_tokens, decode_tokens,
             prefill_ms, decode_ms, wall_ms, slot, cost_source
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
      cost: {
        prefillTokens: row.prefill_tokens, cachedTokens: row.cached_tokens,
        decodeTokens: row.decode_tokens, prefillMs: row.prefill_ms,
        decodeMs: row.decode_ms, wallMs: row.wall_ms, slot: row.slot,
        source: row.cost_source,
      },
    }))
  }

  /**
   * Where a session's time and tokens went. The answer to "/spend".
   *
   * `turnsMeasured` is not `turnsTotal`: turns whose server reported no timings
   * contribute nothing to the sums, and reporting a total without saying how many
   * turns it covers would understate the real spend by an unknown amount. Callers
   * must show both.
   */
  getSessionSpend(sessionId: string): SessionSpend {
    const row = this.db.prepare(`
      SELECT
        COUNT(*)                                              AS turns_total,
        SUM(CASE WHEN cost_source IS NOT NULL
                  AND cost_source != 'none' THEN 1 ELSE 0 END) AS turns_measured,
        COALESCE(SUM(prefill_tokens), 0) AS prefill_tokens,
        COALESCE(SUM(cached_tokens), 0)  AS cached_tokens,
        COALESCE(SUM(decode_tokens), 0)  AS decode_tokens,
        COALESCE(SUM(prefill_ms), 0)     AS prefill_ms,
        COALESCE(SUM(decode_ms), 0)      AS decode_ms,
        COALESCE(SUM(wall_ms), 0)        AS wall_ms
      FROM measurements WHERE session_id = ?
    `).get(sessionId) as any
    const sources = (this.db.prepare(`
      SELECT DISTINCT cost_source AS s FROM measurements
      WHERE session_id = ? AND cost_source IS NOT NULL
    `).all(sessionId) as { s: string }[]).map(r => r.s)
    return {
      turnsTotal: row?.turns_total ?? 0,
      turnsMeasured: row?.turns_measured ?? 0,
      prefillTokens: row?.prefill_tokens ?? 0,
      cachedTokens: row?.cached_tokens ?? 0,
      decodeTokens: row?.decode_tokens ?? 0,
      prefillMs: row?.prefill_ms ?? 0,
      decodeMs: row?.decode_ms ?? 0,
      wallMs: row?.wall_ms ?? 0,
      sources,
    }
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

  // ── Predictions ─────────────────────────────────────────────────

  recordPrediction(record: {
    sessionId: string
    hypothesis: string
    triggerTurn: number
    triggerContext: string
    predictedOutcome: string
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO predictions
        (session_id, hypothesis, trigger_turn, trigger_context, predicted_outcome)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.sessionId,
      record.hypothesis,
      record.triggerTurn,
      record.triggerContext,
      record.predictedOutcome,
    )
  }

  getPredictions(sessionId: string): PredictionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id, hypothesis, trigger_turn, trigger_context,
             predicted_outcome, actual_outcome, correct, evaluation_turn, created_at
      FROM predictions
      WHERE session_id = ?
      ORDER BY id ASC
    `)
    return stmt.all(sessionId) as PredictionRecord[]
  }

  getAllPredictions(hypothesis: string): PredictionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id, hypothesis, trigger_turn, trigger_context,
             predicted_outcome, actual_outcome, correct, evaluation_turn, created_at
      FROM predictions
      WHERE hypothesis = ?
      ORDER BY id ASC
    `)
    return stmt.all(hypothesis) as PredictionRecord[]
  }

  evaluatePrediction(
    id: number,
    actualOutcome: string,
    correct: boolean,
    evaluationTurn: number,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE predictions
      SET actual_outcome = ?, correct = ?, evaluation_turn = ?
      WHERE id = ?
    `)
    stmt.run(actualOutcome, correct ? 1 : 0, evaluationTurn, id)
  }

  /**
   * Insert a prediction that was already opened AND evaluated in-memory by
   * PredictionTracker. Unlike recordPrediction()/evaluatePrediction() (open
   * then update), this is a single write used by the session-end flush.
   */
  recordCompletedPrediction(record: {
    sessionId: string
    hypothesis: string
    triggerTurn: number
    triggerContext: string
    predictedOutcome: string
    actualOutcome: string
    correct: boolean
    evaluationTurn: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO predictions
        (session_id, hypothesis, trigger_turn, trigger_context,
         predicted_outcome, actual_outcome, correct, evaluation_turn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.sessionId,
      record.hypothesis,
      record.triggerTurn,
      record.triggerContext,
      record.predictedOutcome,
      record.actualOutcome,
      record.correct ? 1 : 0,
      record.evaluationTurn,
    )
  }

  getHypothesisStats(hypothesis: string): HypothesisStats {
    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as total FROM predictions WHERE hypothesis = ?
    `)
    const correctStmt = this.db.prepare(`
      SELECT COUNT(*) as correct FROM predictions
      WHERE hypothesis = ? AND correct = 1
    `)
    const total = (totalStmt.get(hypothesis) as any).total as number
    const correct = (correctStmt.get(hypothesis) as any).correct as number
    return {
      total,
      correct,
      hitRate: total > 0 ? correct / total : 0,
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
