/**
 * Consume-on-read tests for per-turn governance flags.
 *
 * Each test follows the same red→green contract:
 *   1. Set the flag via its public setter.
 *   2. Call resetTurnFlags() — under the old code this would wipe the flag.
 *   3. Call onTurnComplete() with metrics that satisfy the hypothesis's other
 *      trigger conditions.
 *   4. Assert that the expected hypothesis opened in openPredictions.
 *
 * With consume-on-read the flags are snapshotted at the TOP of onTurnComplete
 * (before the resetTurnFlags clear sites were ever reached), so the prediction
 * tracker always receives the correct value even if resetTurnFlags ran first.
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
  test('H2 — nudgeInjected flag survives resetTurnFlags() and opens H2', () => {
    const governance = new CyberneticsGovernance()

    governance.markNudgeInjected()
    governance.resetTurnFlags() // old code: cleared flag before onTurnComplete read it

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h2Open = tracker.openPredictions.some(p => p.hypothesis === 'H2')
    expect(h2Open).toBe(true)
  })

  test('H2 — nudgeInjected flag is consumed by onTurnComplete and does not leak to the next turn', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: nudge injected, opens H2 (evalWindow=1, dedup until turn < 1+1=2)
    governance.markNudgeInjected()
    governance.onTurnComplete(turn())

    // Turn 2: still inside the dedup window — no new H2 should open even if
    // consume-on-read failed to clear and the stale flag leaked.
    // Run one more turn without nudge.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    // Turn 3: dedup window expired (triggerTurn=1, window=1, guard blocks while turn < 2).
    // At this point turn count = 3, guard no longer blocks.  If the flag leaked
    // (was never consumed) a second H2 would open here.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h2All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H2')
    expect(h2All.length).toBe(1)
  })

  // ── H5: Thinking Efficiency ────────────────────────────────────────────────
  test('H5 — thinkingTokens flag survives resetTurnFlags() and opens H5', () => {
    const governance = new CyberneticsGovernance()

    governance.setThinkingTokens(200) // > 100 triggers H5
    governance.resetTurnFlags()       // old code: reset to 0 before onTurnComplete

    governance.onTurnComplete(turn({ thinkingTokens: 200, totalTokens: 300 }))

    const tracker = governance.getPredictionTracker()
    const h5Open = tracker.openPredictions.some(p => p.hypothesis === 'H5')
    expect(h5Open).toBe(true)
  })

  test('H5 — thinkingTokens value is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: 200 thinking tokens → opens H5 (evalWindow=1, dedup until turn < 2)
    governance.setThinkingTokens(200)
    governance.onTurnComplete(turn({ thinkingTokens: 200, totalTokens: 300 }))

    // Turn 2: still in dedup window.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    // Turn 3: dedup window expired. If stale value leaked, another H5 opens.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h5All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H5')
    expect(h5All.length).toBe(1)
  })

  // ── H6: Temperature Effect ─────────────────────────────────────────────────
  test('H6 — temperatureLowered flag survives resetTurnFlags() and opens H6', () => {
    const governance = new CyberneticsGovernance()

    governance.markTemperatureLowered()
    governance.resetTurnFlags() // old code: cleared flag before onTurnComplete read it

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h6Open = tracker.openPredictions.some(p => p.hypothesis === 'H6')
    expect(h6Open).toBe(true)
  })

  test('H6 — temperatureLowered flag is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: temperature lowered → opens H6 (evalWindow=1, dedup until turn < 2)
    governance.markTemperatureLowered()
    governance.onTurnComplete(turn())

    // Turn 2: still in dedup window.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    // Turn 3: dedup window expired.  Stale flag would open a second H6.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h6All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H6')
    expect(h6All.length).toBe(1)
  })

  // ── H7: S4 Reflection ROI ──────────────────────────────────────────────────
  test('H7 — s4ReflectionRan flag survives resetTurnFlags() and opens H7', () => {
    const governance = new CyberneticsGovernance()

    governance.setS4ReflectionRan()
    governance.resetTurnFlags() // old code: cleared flag before onTurnComplete read it

    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    const h7Open = tracker.openPredictions.some(p => p.hypothesis === 'H7')
    expect(h7Open).toBe(true)
  })

  test('H7 — s4ReflectionRan flag is consumed after onTurnComplete and does not leak', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: S4 reflection ran → opens H7 (evalWindow=3, dedup until turn < 4)
    governance.setS4ReflectionRan()
    governance.onTurnComplete(turn())

    // Turns 2-3: still inside the dedup window.
    for (let i = 0; i < 2; i++) {
      governance.resetTurnFlags()
      governance.onTurnComplete(turn())
    }

    // Turn 4: dedup window expired.  Stale flag would open a second H7.
    governance.resetTurnFlags()
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
    governance.resetTurnFlags()
    governance.onTurnComplete(turn())

    const tracker = governance.getPredictionTracker()
    // None of H2/H5/H6/H7 should have opened — all flags were stale from the paused phase.
    const staleOpen = tracker.openPredictions.filter(p =>
      ['H2', 'H5', 'H6', 'H7'].includes(p.hypothesis),
    )
    expect(staleOpen.length).toBe(0)
  })
})
