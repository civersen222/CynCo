// engine/__tests__/vsm/windowedVariety.test.ts
// P1.5: rolling-window distinguishable-state counting. Ashby's variety is
// about CURRENT distinguishable states, not lifetime totals — unlike the
// monotone VarietyEngine ratio, this count must DECAY once the tool-set
// stabilizes (STATE doc §3.1 corollary; Phase 1 item 5).
import { describe, expect, it } from 'vitest'
import { WindowedVarietyMeter } from '../../vsm/windowedVariety.js'

describe('WindowedVarietyMeter (P1.5)', () => {
  it('fresh meter counts zero states', () => {
    const m = new WindowedVarietyMeter()
    expect(m.count()).toBe(0)
  })

  it('distinguishes states by tool name AND args; identical calls count once', () => {
    const m = new WindowedVarietyMeter()
    m.recordCall('Read', { file_path: 'a.ts' })
    m.recordCall('Read', { file_path: 'b.ts' }) // same tool, different args → distinct state
    m.recordCall('Write', { file_path: 'a.ts' }) // different tool, same args → distinct state
    m.recordCall('Read', { file_path: 'a.ts' }) // exact repeat → NOT a new state
    expect(m.count()).toBe(3)
  })

  it('decays to 1 after the tool-set stabilizes (the item-5 acceptance test)', () => {
    const m = new WindowedVarietyMeter(10)
    // Turn 1: varied exploration — 3 distinguishable states.
    m.recordCall('Read', { file_path: 'a.ts' })
    m.recordCall('Grep', { pattern: 'foo' })
    m.recordCall('Write', { file_path: 'a.ts' })
    m.onTurnComplete()
    expect(m.count()).toBe(3)
    // Turns 2..11: the model settles into repeating one identical call.
    for (let i = 0; i < 10; i++) {
      m.recordCall('Bash', { command: 'npx vitest run' })
      m.onTurnComplete()
    }
    // Turn 1's states have left the 10-turn window — a monotone measure
    // could never do this.
    expect(m.count()).toBe(1)
  })

  it('window slides: count reflects only the last windowTurns sealed turns', () => {
    const m = new WindowedVarietyMeter(3)
    m.recordCall('Read', { file_path: 'a.ts' })
    m.onTurnComplete() // turn 1
    m.recordCall('Grep', { pattern: 'x' })
    m.onTurnComplete() // turn 2
    m.recordCall('Write', { file_path: 'b.ts' })
    m.onTurnComplete() // turn 3
    expect(m.count()).toBe(3)
    m.recordCall('Bash', { command: 'ls' })
    m.onTurnComplete() // turn 4 → turn 1's Read leaves the window
    expect(m.count()).toBe(3) // Grep, Write, Bash
  })

  it('in-progress (unsealed) calls are included in the count', () => {
    // The loop seals the turn at message_stop BEFORE the batch's tools run
    // (P1.4 finding), so post-batch reports must still see current calls.
    const m = new WindowedVarietyMeter()
    m.onTurnComplete() // sealed empty turn
    m.recordCall('Read', { file_path: 'a.ts' })
    expect(m.count()).toBe(1)
  })
})
