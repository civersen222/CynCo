import { describe, expect, it, beforeEach, vi } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FeedbackControlIntegration, SESSION_FEEDBACK_INSTANCE } from '../../vsm/feedbackControl.js'
import { RetainedConfigStore, type RetainedFile, type RetainedStoreLike } from '../../vsm/retainedConfigStore.js'

describe('FeedbackControlIntegration', () => {
  let fc: FeedbackControlIntegration

  beforeEach(() => {
    fc = new FeedbackControlIntegration()
  })

  it('recommends compression when context > 80%', () => {
    const actions = fc.update(0.85, 0.1, 1.0, 0.9)
    expect(actions.shouldCompress).toBe(true)
    expect(actions.compressionUrgency).toBeGreaterThan(0)
  })

  it('does not recommend compression when context < 70%', () => {
    const actions = fc.update(0.3, 0.1, 1.0, 0.9)
    expect(actions.shouldCompress).toBe(false)
  })

  it('PID adjusts approval when rate is too low', () => {
    // Approval rate = 50% (target is 80%) → should ease restrictions
    const actions = fc.update(0.5, 0.1, 1.0, 0.5)
    expect(actions.approvalAdjustment).toBeGreaterThan(0) // positive = ease
  })

  it('PID tightens when approval rate is too high but failures are high', () => {
    // Approval rate = 100% but we feed that through → PID should tighten
    const actions = fc.update(0.5, 0.1, 1.0, 1.0)
    expect(actions.approvalAdjustment).toBeLessThan(0) // negative = tighten
  })

  it('detects viability violation and records the adaptation step in the trace', () => {
    // Context at 90% (above 85% bound) → not viable; the legacy continuous
    // instance steps on every out-of-bounds observation, and the trace is
    // the only surviving record of it (perturbedParameters had no reader).
    const actions = fc.update(0.9, 0.0, 1.0, 0.8)
    expect(actions.isViable).toBe(false)
    expect(actions.viabilityMargin).toBeLessThan(0)
    expect(actions.adaptationTrace.length).toBeGreaterThan(0)
  })

  it('system is viable with normal metrics', () => {
    const actions = fc.update(0.5, 0.1, 1.0, 0.8)
    expect(actions.isViable).toBe(true)
    expect(actions.adaptationTrace.length).toBe(0)
  })

  it('checkModelFidelity returns 1.0 for identical distributions', () => {
    const dist = [0.5, 0.3, 0.2]
    expect(fc.checkModelFidelity(dist, dist)).toBeCloseTo(1.0, 5)
  })

  it('isGoodRegulator returns true for high-fidelity model', () => {
    const system = [0.5, 0.3, 0.2]
    expect(fc.isGoodRegulator(system, system)).toBe(true)
  })

  it('isGoodRegulator returns false for divergent model', () => {
    const system = [0.5, 0.3, 0.2]
    const model = [0.1, 0.1, 0.8]
    expect(fc.isGoodRegulator(system, model, 0.95)).toBe(false)
  })

  it('exposes the ultrastable adaptation trace and margin', () => {
    const before = fc.update(0.5, 0.1, 1.0, 0.9)
    expect(before.adaptationTrace.length).toBe(0)
    expect(before.viabilityMargin).toBeGreaterThan(0)
    const after = fc.update(0.95, 0.1, 1.0, 0.9) // context above the 0.85 bound
    expect(after.adaptationTrace.length).toBe(1)
    expect(after.adaptationTrace[0].violations).toEqual(['ev0'])
    expect(after.adaptationTrace[0].restoredAfter).toBeNull()
    expect(after.viabilityMargin).toBeLessThan(0)
  })
})

/** Records what the instance asked of it; hands back `stored` on load. */
function fakeStore(stored: RetainedFile | null) {
  const loads: string[] = []
  const saves: Array<{ instance: string; json: string; sessionId: string | null }> = []
  let version = stored?.version ?? 0
  const store: RetainedStoreLike = {
    load(instance) { loads.push(instance); return stored },
    save(instance, json, sessionId) { saves.push({ instance, json, sessionId }); version++; return { version, changed: true } },
  }
  return { store, loads, saves }
}

function retainedFile(instance: string, retained: Record<string, unknown>, version = 3): RetainedFile {
  return { schema: 1, instance, version, updatedAt: 't', retained, history: [] }
}

describe('FeedbackControlIntegration — retained configurations (session-feedback)', () => {
  it('is backward compatible: no store, empty table, version null', () => {
    const fc = new FeedbackControlIntegration()
    expect(fc.retainedSnapshot()).toEqual({ retained: {}, version: null })
  })

  it('imports the stored table at construction', () => {
    const table = { ev0: { Continuous: [0.75, 8192, 0.3] } }
    const { store, loads } = fakeStore(retainedFile(SESSION_FEEDBACK_INSTANCE, table))
    const fc = new FeedbackControlIntegration({ retainedStore: store })
    expect(SESSION_FEEDBACK_INSTANCE).toBe('session-feedback')
    expect(loads).toEqual(['session-feedback'])
    expect(JSON.parse(fc.ultrastable.exportRetained())).toEqual(table)
    expect(fc.retainedSnapshot()).toEqual({ retained: table, version: 3 })
  })

  it('an invalid stored table is logged and leaves the instance empty (never throws)', () => {
    const { store } = fakeStore(retainedFile(SESSION_FEEDBACK_INSTANCE, { ev0: { Bogus: 1 } }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const fc = new FeedbackControlIntegration({ retainedStore: store })
      expect(fc.retainedSnapshot().retained).toEqual({})
      expect(log.mock.calls.some(c => String(c[0]).includes('[retained]'))).toBe(true)
    } finally {
      log.mockRestore()
    }
  })

  it('exports the live table at session end and tracks the version it got back', () => {
    const { store, saves } = fakeStore(null)
    const fc = new FeedbackControlIntegration({ retainedStore: store })
    fc.update(0.95, 0.1, 1.0, 0.9) // violation → step
    fc.update(0.3, 0.1, 1.0, 0.9)  // restored → retained
    const r = fc.saveRetained(store, 'session-42')
    expect(r).toEqual({ version: 1, changed: true })
    expect(saves).toHaveLength(1)
    expect(saves[0].instance).toBe('session-feedback')
    expect(saves[0].sessionId).toBe('session-42')
    expect(saves[0].json).toBe(fc.ultrastable.exportRetained())
    expect(Object.keys(JSON.parse(saves[0].json))).toEqual(['ev0'])
    expect(fc.retainedSnapshot().version).toBe(1)
  })

  it('round-trips through the real store across two instances (two sessions)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-retained-fc-'))
    try {
      const store = new RetainedConfigStore(dir)
      const first = new FeedbackControlIntegration({ retainedStore: store })
      first.update(0.95, 0.1, 1.0, 0.9)
      first.update(0.3, 0.1, 1.0, 0.9)
      expect(first.saveRetained(store, 's1')).toEqual({ version: 1, changed: true })
      const second = new FeedbackControlIntegration({ retainedStore: store })
      expect(second.ultrastable.exportRetained()).toBe(first.ultrastable.exportRetained())
      expect(second.retainedSnapshot().version).toBe(1)
      // Nothing new retained in session two → unchanged, version stays.
      expect(second.saveRetained(store, 's2')).toEqual({ version: 1, changed: false })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
