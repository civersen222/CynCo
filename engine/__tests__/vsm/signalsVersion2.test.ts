import { describe, expect, it, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'

/**
 * F165 — the per-turn signal vector, fixed at the source and versioned.
 *
 * Measured on C9 wave 1 (394 governance.status turns): `consecutiveUnstable`
 * equalled the turn index on every turn, 1…394, monotone — the homeostat never
 * once read stable in a mission, so the "instability streak" was a clock.
 * `algedonicAlerts` was a replay of every alert since the engine started (21 by
 * the end of the wave), a cumulative counter, not a per-turn reading.
 *
 * The fixture is C9 wave 2's 57-turn stream, rebuilt from its ledger row
 * (measured latencies; tool calls, decode tokens and context reconstructed to
 * the row's totals — see the fixture's `derivation`). On the pre-F165 code it
 * reproduces the wave's reading exactly: consecutiveUnstable = 1…57.
 */

type Turn = {
  toolsCalled: number
  thinkingTokens: number
  totalTokens: number
  latencyMs: number
  contextUtilization: number
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'c9-wave2-governance-inputs.json'), 'utf-8'),
) as { turns: Turn[] }

// Turns (1-based) whose tool call failed. The row has 8 tool errors; placing
// them early is what lets the windowed count be seen falling back.
const FAILED_TURNS = new Set([2, 4, 5, 7, 8, 9, 11, 12])

function runStream(): { unstable: number[]; windowed: number[]; total: number[]; versions: number[]; perturbations: number } {
  const gov = new CyberneticsGovernance()
  const unstable: number[] = []
  const windowed: number[] = []
  const total: number[] = []
  const versions: number[] = []
  fixture.turns.forEach((t, i) => {
    const turn = i + 1
    // One result per call, each a distinct command (C9 wave 2's stuckTurns
    // stayed <= 2); the turn's first call fails on a FAILED_TURNS turn.
    for (let k = 0; k < Math.max(t.toolsCalled, FAILED_TURNS.has(turn) ? 1 : 0); k++) {
      gov.onToolResult('Bash', !(k === 0 && FAILED_TURNS.has(turn)), 100, '', { command: `step ${turn}.${k}` })
    }
    gov.onTurnComplete({ ...t, response: `turn ${turn}` })
    const r = gov.getReport() as any
    unstable.push(r.consecutiveUnstable)
    windowed.push(r.algedonicAlerts)
    total.push(r.algedonicAlertsTotal)
    versions.push(r.signalsVersion)
  })
  return { unstable, windowed, total, versions, perturbations: gov.getHomeostat().getPerturbationCount() }
}

describe('F165: signals v2 on the C9 wave 2 stream', () => {
  beforeEach(() => resetEventBus())

  it('the fixture is the 57-turn wave with the row totals', () => {
    expect(fixture.turns).toHaveLength(57)
    expect(fixture.turns.reduce((s, t) => s + t.toolsCalled, 0)).toBe(42)
  })

  it('consecutiveUnstable is a streak, not the turn index', () => {
    const { unstable } = runStream()
    const monotone = unstable.every((v, i) => v === i + 1)
    expect(monotone).toBe(false)
    // It resets: some turn reads stable (0) after an unstable one.
    const resets = unstable.filter((v, i) => i > 0 && v === 0 && unstable[i - 1] > 0).length
    expect(resets).toBeGreaterThanOrEqual(1)
    expect(unstable.some(v => v > 0)).toBe(true)
    expect(Math.max(...unstable)).toBeLessThanOrEqual(50)
  })

  it('one verdict per turn: ultrastability perturbs exactly on the turns counted unstable', () => {
    const { unstable, perturbations } = runStream()
    expect(perturbations).toBe(unstable.filter(v => v > 0).length)
  })

  it('algedonicAlerts is windowed to 20 turns; algedonicAlertsTotal is the cumulative reading', () => {
    const { windowed, total } = runStream()
    windowed.forEach((w, i) => {
      expect(w).toBeLessThanOrEqual(20)
      expect(total[i]).toBeGreaterThanOrEqual(w)
    })
    // The total never falls; the window lets the early failures age out.
    total.forEach((v, i) => { if (i > 0) expect(v).toBeGreaterThanOrEqual(total[i - 1]) })
    expect(total[56]).toBeGreaterThanOrEqual(FAILED_TURNS.size)
    expect(windowed[56]).toBeLessThan(total[56])
    expect(windowed[11]).toBe(total[11])
  })

  it('the report carries signalsVersion 2', () => {
    const { versions } = runStream()
    expect(versions.every(v => v === 2)).toBe(true)
  })
})

describe('F165: consecutiveUnstable is bounded', () => {
  beforeEach(() => resetEventBus())

  it('never exceeds 50 under a stream that never settles', () => {
    const gov = new CyberneticsGovernance()
    let max = 0
    for (let i = 0; i < 120; i++) {
      const hot = i % 2 === 0
      gov.onTurnComplete({
        toolsCalled: hot ? 12 : 0,
        thinkingTokens: hot ? 4000 : 5,
        totalTokens: 5000,
        latencyMs: hot ? 30000 : 50,
        response: `turn ${i}`,
        contextUtilization: hot ? 0.95 : 0.05,
      })
      max = Math.max(max, (gov.getReport() as any).consecutiveUnstable)
    }
    expect(max).toBeGreaterThan(0)
    expect(max).toBeLessThanOrEqual(50)
  })
})
