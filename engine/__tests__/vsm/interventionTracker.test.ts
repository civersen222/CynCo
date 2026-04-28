import { describe, expect, it, beforeEach } from 'bun:test'
import { InterventionTracker } from '../../vsm/interventionTracker.js'

describe('InterventionTracker', () => {
  let tracker: InterventionTracker
  beforeEach(() => { tracker = new InterventionTracker() })

  it('records interventions with outcomes', () => {
    tracker.recordIntervention('test_forcing', true)
    tracker.recordIntervention('test_forcing', false)
    expect(tracker.getSuccessRate('test_forcing')).toBe(0.5)
  })

  it('returns 1.0 for unknown interventions', () => {
    expect(tracker.getSuccessRate('unknown')).toBe(1.0)
  })

  it('shouldIntervene true when success rate high', () => {
    tracker.recordIntervention('tool_gating', true)
    tracker.recordIntervention('tool_gating', true)
    tracker.recordIntervention('tool_gating', true)
    expect(tracker.shouldIntervene('tool_gating')).toBe(true)
  })

  it('shouldIntervene false when success rate low', () => {
    tracker.recordIntervention('tool_gating', false)
    tracker.recordIntervention('tool_gating', false)
    tracker.recordIntervention('tool_gating', false)
    expect(tracker.shouldIntervene('tool_gating')).toBe(false)
  })

  it('exports history for Level 4 training', () => {
    tracker.recordIntervention('test_forcing', true)
    const history = tracker.getHistory()
    expect(history.length).toBe(1)
    expect(history[0].type).toBe('test_forcing')
    expect(history[0].success).toBe(true)
  })
})
