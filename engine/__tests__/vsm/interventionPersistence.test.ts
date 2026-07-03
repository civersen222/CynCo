import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { InterventionTracker } from '../../vsm/interventionTracker.js'
import { loadInterventionRates, saveInterventionRates, ratesPath } from '../../vsm/interventionPersistence.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rates-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('intervention rate persistence', () => {
  it('save then load round-trips the tracker state', () => {
    const a = new InterventionTracker()
    a.recordIntervention('grounding', true)
    a.recordIntervention('grounding', false)
    saveInterventionRates(a, dir)
    expect(existsSync(ratesPath(dir))).toBe(true)

    const b = new InterventionTracker()
    loadInterventionRates(b, dir)
    expect(b.getSuccessRate('grounding')).toBeCloseTo(0.5)
  })

  it('loading from an empty dir leaves the tracker untouched', () => {
    const t = new InterventionTracker()
    loadInterventionRates(t, dir) // no file yet
    expect(t.getSuccessRate('grounding')).toBe(1.0) // unseen -> default
  })

  it('tolerates a corrupt rates file without throwing', () => {
    writeFileSync(ratesPath(dir), '{not json')
    const t = new InterventionTracker()
    expect(() => loadInterventionRates(t, dir)).not.toThrow()
  })
})
