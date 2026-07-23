import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { GovernanceDB } from '../../vsm/governanceDb.js'

describe('CyberneticsGovernance.flushPredictions', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'flush-')) })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('writes completed predictions to governance.db under the canonical session id', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('sess-flush')
    // Directly seed a completed prediction via the live tracker.
    const tracker = gov.getPredictionTracker()
    tracker.completedPredictions.push({
      hypothesis: 'H2', triggerTurn: 3, triggerContext: 'nudge_injected',
      predictedOutcome: 'tool type changes', evaluationWindow: 1,
      correct: true, actualOutcome: 'before=[Read] after=Edit',
    })

    const db = new GovernanceDB(join(tmpDir, 'governance.db'))
    const n = gov.flushPredictions(db)
    expect(n).toBe(1)

    const rows = db.getPredictions('sess-flush')
    expect(rows).toHaveLength(1)
    expect(rows[0].hypothesis).toBe('H2')
    expect(rows[0].evaluation_turn).toBe(4) // triggerTurn + evaluationWindow
    db.close()
  })

  it('returns 0 when there are no completed predictions', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('sess-empty')
    const db = new GovernanceDB(join(tmpDir, 'governance.db'))
    expect(gov.flushPredictions(db)).toBe(0)
    db.close()
  })
})
