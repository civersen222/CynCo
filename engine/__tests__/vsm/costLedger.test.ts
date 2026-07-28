import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { GovernanceDB } from '../../vsm/governanceDb.js'
import { formatSpend } from '../../vsm/spendReport.js'
import type { MeasurementRecord, SessionSpend } from '../../vsm/governanceDb.js'

const measurement = (over: Partial<MeasurementRecord> = {}): MeasurementRecord => ({
  sessionId: 's1', turn: 1, toolErrorRate: 0.1, contextUtilization: 0.4,
  stuckTurns: 0, tokenEfficiency: 1, s4Composite: 5, ...over,
})

/** measurements has a FK to sessions, so a parent row must exist first. */
function seedSession(db: GovernanceDB, sessionId: string): void {
  db.recordSession({
    sessionId, outcome: 'marginal', configIndex: 0, strategy: 'balanced',
    toolSuccessRate: 0.8, stuckTurns: 0, totalTurns: 1, filesChanged: 0,
  })
}

const cost = (over = {}) => ({
  prefillTokens: 4, cachedTokens: 7, decodeTokens: 2,
  prefillMs: 81.487, decodeMs: 30.617, wallMs: 140, slot: null,
  source: 'server-timings', ...over,
})

describe('measurements cost ledger', () => {
  let dir: string
  let db: GovernanceDB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cost-'))
    db = new GovernanceDB(join(dir, 'governance.db'))
    seedSession(db, 's1')
  })
  afterEach(() => {
    db.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL lock on Windows */ }
  })

  it('round-trips a cost through the measurements table', () => {
    db.recordMeasurement(measurement({ cost: cost() }))
    const [row] = db.getMeasurements('s1')
    expect(row.cost?.prefillTokens).toBe(4)
    expect(row.cost?.cachedTokens).toBe(7)
    expect(row.cost?.wallMs).toBe(140)
    expect(row.cost?.source).toBe('server-timings')
  })

  it('writes nulls, not zeros, for a turn whose server reported nothing', () => {
    db.recordMeasurement(measurement({ turn: 2 }))
    const [row] = db.getMeasurements('s1')
    // A zero here would be a claim that the turn was free. It was not measured.
    expect(row.cost?.prefillTokens).toBeNull()
    expect(row.cost?.prefillMs).toBeNull()
    expect(row.cost?.source).toBeNull()
  })
})

describe('cost column migration', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'migrate-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL lock */ } })

  it('adds the columns to a pre-ledger database without dropping its rows', () => {
    const path = join(dir, 'old.db')
    // A database exactly as it existed before the ledger: the original seven
    // columns, one row of real data.
    const raw = new Database(path)
    raw.exec(`CREATE TABLE measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn INTEGER NOT NULL,
      tool_error_rate REAL, context_utilization REAL, stuck_turns INTEGER,
      token_efficiency REAL, s4_composite REAL, timestamp INTEGER)`)
    raw.exec(`INSERT INTO measurements (session_id, turn, tool_error_rate, context_utilization,
      stuck_turns, token_efficiency, s4_composite, timestamp) VALUES ('old', 1, 0.2, 0.5, 3, 1.0, 4.0, 1)`)
    raw.close()

    const db = new GovernanceDB(path)
    const rows = db.getMeasurements('old')
    // The row survived — this is an ALTER, not a rebuild.
    expect(rows).toHaveLength(1)
    expect(rows[0].stuckTurns).toBe(3)
    // And it reads null, which is the truth about it: nothing measured its cost.
    expect(rows[0].cost?.decodeTokens).toBeNull()
    expect(rows[0].cost?.source).toBeNull()
    db.close()
  })

  it('is idempotent — reopening the same database does not fail on existing columns', () => {
    const path = join(dir, 'twice.db')
    const first = new GovernanceDB(path)
    seedSession(first, 's1')
    first.recordMeasurement(measurement({ cost: cost() }))
    first.close()
    const second = new GovernanceDB(path)
    expect(second.getMeasurements('s1')[0].cost?.prefillTokens).toBe(4)
    second.close()
  })
})

describe('getSessionSpend', () => {
  let dir: string
  let db: GovernanceDB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spend-'))
    db = new GovernanceDB(join(dir, 'governance.db'))
    seedSession(db, 's1')
    seedSession(db, 'a')
    seedSession(db, 'b')
  })
  afterEach(() => {
    db.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL lock */ }
  })

  it('sums the measured turns and counts how many they were', () => {
    db.recordMeasurement(measurement({ turn: 1, cost: cost() }))
    db.recordMeasurement(measurement({ turn: 2, cost: cost({ prefillTokens: 6, decodeTokens: 10 }) }))
    const s = db.getSessionSpend('s1')
    expect(s.turnsTotal).toBe(2)
    expect(s.turnsMeasured).toBe(2)
    expect(s.prefillTokens).toBe(10)
    expect(s.decodeTokens).toBe(12)
    expect(s.sources).toEqual(['server-timings'])
  })

  it('excludes unmeasured turns from the sums but not from the total', () => {
    db.recordMeasurement(measurement({ turn: 1, cost: cost() }))
    db.recordMeasurement(measurement({ turn: 2 }))
    const s = db.getSessionSpend('s1')
    // The gap between these two is the whole reason both are reported: the sums
    // below cover one turn out of two, so they are a floor, not a total.
    expect(s.turnsTotal).toBe(2)
    expect(s.turnsMeasured).toBe(1)
    expect(s.prefillTokens).toBe(4)
  })

  it('does not count a source of none as measured', () => {
    db.recordMeasurement(measurement({ turn: 1, cost: cost({ source: 'none', prefillTokens: null, decodeTokens: null }) }))
    expect(db.getSessionSpend('s1').turnsMeasured).toBe(0)
  })

  it('does not mix sessions', () => {
    db.recordMeasurement(measurement({ sessionId: 'a', cost: cost() }))
    db.recordMeasurement(measurement({ sessionId: 'b', cost: cost({ decodeTokens: 999 }) }))
    expect(db.getSessionSpend('a').decodeTokens).toBe(2)
  })
})

describe('formatSpend', () => {
  const base: SessionSpend = {
    turnsTotal: 10, turnsMeasured: 10,
    prefillTokens: 400, cachedTokens: 1600, decodeTokens: 500,
    prefillMs: 8000, decodeMs: 12000, wallMs: 25000, sources: ['server-timings'],
  }

  it('says nothing was recorded when nothing was', () => {
    expect(formatSpend({ ...base, turnsTotal: 0, turnsMeasured: 0 })).toContain('No turns recorded')
  })

  it('calls the spend unknown when no turn reported a cost', () => {
    const out = formatSpend({ ...base, turnsMeasured: 0 })
    // Not "0 tokens" — the turns happened, nothing measured them.
    expect(out).toContain('unknown')
    expect(out).not.toContain('0 tok —')
  })

  it('reports the cache hit rate against the whole prompt', () => {
    expect(formatSpend(base)).toContain('80% hit')
  })

  it('states its own coverage when some turns went unmeasured', () => {
    const out = formatSpend({ ...base, turnsMeasured: 4 })
    expect(out).toContain('4 of 10')
    expect(out).toContain('the real spend is higher')
  })

  it('does not claim full coverage when it has it', () => {
    expect(formatSpend(base)).not.toContain('the real spend is higher')
  })
})
