import { test, expect, describe } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

/** Minimal valid turn metrics */
const turn = (userMessage = 'test') => ({
  toolsCalled: 0,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 1000,
  response: '',
  userMessage,
})

describe('H3 contract flag lifecycle', () => {
  test('contract created flag persists through resetTurnFlags() so onTurnComplete can open H3', () => {
    const governance = new CyberneticsGovernance()

    governance.setContractCreated()
    governance.resetTurnFlags() // no-op — all flags consumed at top of onTurnComplete()

    governance.onTurnComplete({
      toolsCalled: 0,
      thinkingTokens: 0,
      totalTokens: 100,
      latencyMs: 1000,
      response: '',
      userMessage: 'test with assertions',
    })

    const tracker = governance.getPredictionTracker()
    const h3Open = tracker.openPredictions.some(p => p.hypothesis === 'H3')
    expect(h3Open).toBe(true) // H3 should have been opened after reading contractCreated flag
  })

  test('contract created flag is cleared after onTurnComplete so it does not leak to next turn', () => {
    const governance = new CyberneticsGovernance()

    // Turn 1: contract created, triggers H3 (opens at turn 1, window = 20, dedup until turn < 1 + 20 = 21)
    governance.setContractCreated()
    governance.onTurnComplete(turn('first turn'))

    // Turns 2 – 21: no contract created, but stay inside the dedup window — the dedup
    // guard keeps blocking a second H3 open.  We need turn >= 21 to escape the window.
    // Run 20 more turns (total turn count will reach 21) without ever setting the flag.
    for (let i = 0; i < 20; i++) {
      governance.resetTurnFlags()
      governance.onTurnComplete(turn(`turn ${i + 2}`))
    }

    // At this point we are at turnCount = 21.  The original H3 evaluation window has
    // expired (triggerTurn=1, window=20 → guard blocks while turn < 1+20=21, so at
    // turn 21 the guard no longer blocks).  If _contractCreatedThisTurn had leaked
    // (i.e. the flag was never cleared after turn 1) AND the logic used the stored
    // value, a second H3 would open here.
    //
    // Run one more turn without setting the flag.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn('turn 22 — must not open a second H3'))

    const tracker = governance.getPredictionTracker()
    // Count H3 across both open (window still running) and completed (window elapsed).
    // After 22 turns the turn-1 H3 has been evaluated and moved to completedPredictions.
    // If the consume-on-read at the top of onTurnComplete() is deleted,
    // _contractCreatedThisTurn stays true and a second H3 opens at turn 22
    // once the dedup window expires — making this fail.
    const h3All = [
      ...tracker.openPredictions,
      ...tracker.completedPredictions,
    ].filter(p => p.hypothesis === 'H3')
    expect(h3All.length).toBe(1)
  })

  test('contract flag created while paused does not contaminate post-pause H3 stats', () => {
    const governance = new CyberneticsGovernance()

    // Pause governance (simulates ablation experiment control condition)
    governance.pause()

    // A contract is created during the paused phase
    governance.setContractCreated()

    // onTurnComplete early-returns because paused — prediction tracker never sees it.
    // The flag must be cleared here so it cannot leak into the post-resume phase.
    governance.onTurnComplete(turn('paused turn'))

    // Resume normal governance
    governance.resume()

    // Run a normal turn — no contract created, no flag set.
    governance.resetTurnFlags()
    governance.onTurnComplete(turn('first active turn after resume'))

    const tracker = governance.getPredictionTracker()
    const h3Open = tracker.openPredictions.some(p => p.hypothesis === 'H3')
    // H3 must NOT be open — the stale flag from the paused turn should have been cleared.
    expect(h3Open).toBe(false)
  })
})
