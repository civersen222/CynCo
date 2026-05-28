import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GovernanceDB } from '../vsm/governanceDb.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('GovernanceDB predictions table', () => {
  let db: GovernanceDB
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gov-test-'))
    db = new GovernanceDB(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    // On Windows, SQLite WAL files may briefly hold a lock after close().
    // Retry once with a short delay before giving up gracefully.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      setTimeout(() => {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      }, 100)
    }
  })

  it('recordPrediction inserts a row', () => {
    db.recordPrediction({
      sessionId: 'test-session',
      hypothesis: 'H1',
      triggerTurn: 5,
      triggerContext: JSON.stringify({ varietyBalance: 'critical' }),
      predictedOutcome: 'failure',
    })
    const preds = db.getPredictions('test-session')
    expect(preds.length).toBe(1)
    expect(preds[0].hypothesis).toBe('H1')
  })

  it('evaluatePrediction updates outcome', () => {
    db.recordPrediction({
      sessionId: 'test-session',
      hypothesis: 'H2',
      triggerTurn: 3,
      triggerContext: '{}',
      predictedOutcome: 'stuck',
    })
    const preds = db.getPredictions('test-session')
    db.evaluatePrediction(preds[0].id, 'stuck', true, 8)
    const updated = db.getPredictions('test-session')
    expect(updated[0].actual_outcome).toBe('stuck')
    expect(updated[0].evaluation_turn).toBe(8)
  })

  it('getHypothesisStats returns hit rate', () => {
    for (let i = 0; i < 10; i++) {
      db.recordPrediction({
        sessionId: `s-${i}`,
        hypothesis: 'H1',
        triggerTurn: 1,
        triggerContext: '{}',
        predictedOutcome: 'failure',
      })
    }
    const allPreds = db.getAllPredictions('H1')
    for (let i = 0; i < allPreds.length; i++) {
      db.evaluatePrediction(allPreds[i].id, 'failure', i < 7, i + 2)
    }
    const stats = db.getHypothesisStats('H1')
    expect(stats.total).toBe(10)
    expect(stats.correct).toBe(7)
    expect(stats.hitRate).toBeCloseTo(0.7, 2)
  })
})
