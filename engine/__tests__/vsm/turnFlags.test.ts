/**
 * Consume-on-read tests for per-turn governance flags.
 *
 * Guarded contract: flags are consumed exactly once at the top of
 * onTurnComplete, including on the paused/ablated path.
 *
 * Each "flag set → onTurnComplete → hypothesis opens" test verifies that
 * setting a flag and immediately calling onTurnComplete (with no intervening
 * reset) opens the expected hypothesis.  The corresponding leak tests verify
 * that after onTurnComplete clears the flag, subsequent turns do not open a
 * second instance of the same hypothesis once the dedup window expires.
 */

import { test, expect, describe } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

/** Minimal valid turn metrics. */
const turn = (overrides: Partial<{
  toolsCalled: number
  thinkingTokens: number
  totalTokens: number
  latencyMs: number
  response: string
  userMessage: string
}> = {}) => ({
  toolsCalled: 0,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 1000,
  response: '',
  userMessage: 'test',
  ...overrides,
})

describe('consume-on-read for per-turn flags', () => {
  // ── H2: Nudge Response ─────────────────────────────────────────────────────
  test('H2 — nudgeInjected flag set then onTurnComplete opens H2', () => {
    const governance = new CyberneticsGovernance()

    governance.markNudgeInjected()

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h2Open = tracker.openPredictions.some(p => p.hypothesis === 'H2')
    expect(h2Open).toBe(true)
  })

  test('H2 — nudgeInjected flag is consumed by onTurnComplete and does not leak to the next turn', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: nudge injected, opens H2 (evalWindow=1, dedup blocks while turn < 1+1=2)
    governance.markNudgeInjected()
    governance.onTurnComplete(turn())

    // Turn 2: dedup window already expired (turn=2, guard is turn < 2 → false).
    // Run without nudge.
    governance.onTurnComplete(turn())

    // Turn 3: well outside the dedup window.  If the flag leaked
    // (was never consumed) a second H2 would open here.
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h2All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H2')
    expect(h2All.length).toBe(1)
  })

  // ── H5: Thinking Efficiency ────────────────────────────────────────────────
  test('H5 — thinkingTokens flag set then onTurnComplete opens H5', () => {
    const governance = new CyberneticsGovernance()

    governance.setThinkingTokens(200) // > 100 triggers H5

    governance.onTurnComplete(turn({ thinkingTokens: 200, totalTokens: 300 }))

    const tracker = governance.getPredictionTracker()
    const h5Open = tracker.openPredictions.some(p => p.hypothesis === 'H5')
    expect(h5Open).toBe(true)
  })

  test('H5 — thinkingTokens value is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: 200 thinking tokens → opens H5 (evalWindow=1, dedup blocks while turn < 1+1=2)
    governance.setThinkingTokens(200)
    governance.onTurnComplete(turn({ thinkingTokens: 200, totalTokens: 300 }))

    // Turn 2: dedup window already expired (turn=2, guard is turn < 2 → false).
    governance.onTurnComplete(turn())

    // Turn 3: well outside the dedup window. If stale value leaked, another H5 opens.
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h5All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H5')
    expect(h5All.length).toBe(1)
  })

  // ── H6: Temperature Effect ─────────────────────────────────────────────────
  test('H6 — temperatureLowered flag set then onTurnComplete opens H6', () => {
    const governance = new CyberneticsGovernance()

    governance.markTemperatureLowered()

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h6Open = tracker.openPredictions.some(p => p.hypothesis === 'H6')
    expect(h6Open).toBe(true)
  })

  test('H6 — temperatureLowered flag is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: temperature lowered → opens H6 (evalWindow=1, dedup blocks while turn < 1+1=2)
    governance.markTemperatureLowered()
    governance.onTurnComplete(turn())

    // Turn 2: dedup window already expired (turn=2, guard is turn < 2 → false).
    governance.onTurnComplete(turn())

    // Turn 3: well outside the dedup window.  Stale flag would open a second H6.
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h6All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H6')
    expect(h6All.length).toBe(1)
  })

  // ── H7: S4 Reflection ROI ──────────────────────────────────────────────────
  test('H7 — s4ReflectionRan flag set then onTurnComplete opens H7', () => {
    const governance = new CyberneticsGovernance()

    governance.setS4ReflectionRan()

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h7Open = tracker.openPredictions.some(p => p.hypothesis === 'H7')
    expect(h7Open).toBe(true)
  })

  test('H7 — s4ReflectionRan flag is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: S4 reflection ran → opens H7 (evalWindow=3, dedup blocks while turn < 1+3=4)
    governance.setS4ReflectionRan()
    governance.onTurnComplete(turn())

    // Turns 2-3: still inside the dedup window (turn < 4).
    for (let i = 0; i < 2; i++) {
      governance.onTurnComplete(turn())
    }

    // Turn 4: dedup window expired (turn=4, guard is turn < 4 → false).
    // Stale flag would open a second H7.
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h7All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H7')
    expect(h7All.length).toBe(1)
  })

  // ── Ablated/paused: all flags must be consumed on early return ─────────────
  test('all flags consumed even when governance is paused (ablated early-return)', () => {
    const governance = new CyberneticsGovernance()

    governance.pause()
    governance.markNudgeInjected()
    governance.markTemperatureLowered()
    governance.setThinkingTokens(200)
    governance.setS4ReflectionRan()
    // (H3 / contractCreated already covered in contractFlag.test.ts)

    governance.onTurnComplete(turn()) // early return — flags must be cleared here

    governance.resume()
    // Run a normal turn with no flags set.
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    // None of H2/H5/H6/H7 should have opened — all flags were stale from the paused phase.
    const staleOpen = tracker.openPredictions.filter(p =>
      ['H2', 'H5', 'H6', 'H7'].includes(p.hypothesis),
    )
    expect(staleOpen.length).toBe(0)
  })
})
