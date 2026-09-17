import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseGateOutput, parsePerturbHeader, compareCalibration } from '../cynco-gate-parse.mjs'

const base = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')

describe('parseGateOutput', () => {
  it('reads the C8 BASE calibration: 14 fails, 2 passes + C8.9, MISS, no errors', () => {
    const g = parseGateOutput(base)
    expect(g.terminator).toBe('MISS')
    expect(g.failCount).toBe(14)
    expect(g.fails.map(f => f.id)).toEqual([
      'C8.1a.tiers-pressable', 'C8.1b.tiers-differ', 'C8.1c.tier-legends',
      'C8.2a.portraits-drawn', 'C8.2b.portraits-distinct-and-stable', 'C8.2c.portrait-pool-licensed',
      'C8.3a.transition-frames', 'C8.3b.transitions-wired',
      'C8.4a.act-beds-on-disk', 'C8.4b.bed-follows-the-act', 'C8.4d.beds-licensed',
      'C8.5.palette.House', 'C8.5.palette.Powers', 'C8.5.palette.Atlas',
    ])
    expect(g.fails[13].line).toBe('C8.5.palette.Atlas: FAIL pixels within 24/channel of a pinned ink at t40 = 0.640 (floor 0.9)')
    expect(g.passes.map(p => p.id)).toEqual(['C8.4c.beds-honour-mute', 'C8.5.river-reserved', 'C8.9'])
    expect(g.priorRegressions).toBe(0)
    expect(g.errors).toEqual([])
  })
  it('treats a traceback as an error and a missing terminator as null', () => {
    const g = parseGateOutput('C8.1a.x: FAIL y\nTraceback (most recent call last):\n  File "gate.py"\nKeyError: 1\n')
    expect(g.terminator).toBeNull()
    expect(g.errors).toHaveLength(2)
  })
})

describe('parsePerturbHeader', () => {
  it('reads EXPECT-FLIP and MUST-FAIL', () => {
    const h = parsePerturbHeader('# x\n# EXPECT-FLIP: C8.5.palette.Atlas C8.5.river-reserved\n# MUST-FAIL: C8.1b C8.1c\nimport os\n')
    expect(h).toEqual({ expectFlip: ['C8.5.palette.Atlas', 'C8.5.river-reserved'], mustFail: ['C8.1b', 'C8.1c'] })
  })
  it('throws without the lines', () => { expect(() => parsePerturbHeader('# nothing')).toThrow(/EXPECT-FLIP/) })
})

describe('compareCalibration', () => {
  const header = { expectFlip: ['C8.5.palette.Atlas'], mustFail: ['C8.1b', 'C8.2b'] }
  const baseG = parseGateOutput(base)
  it('accepts a perturb that flips only what it declared and keeps every discriminator red', () => {
    const perturbed = parseGateOutput(base.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS'))
    expect(compareCalibration({ base: baseG, perturbed, header })).toEqual({ ok: true, problems: [] })
  })
  it('refuses when a discriminator went green or an undeclared line flipped', () => {
    const perturbed = parseGateOutput(base.replace('C8.1b.tiers-differ: FAIL', 'C8.1b.tiers-differ: PASS'))
    const r = compareCalibration({ base: baseG, perturbed, header })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/C8.1b/)
  })
  it('refuses a base that is not a clean MISS', () => {
    const r = compareCalibration({ base: parseGateOutput('GATE: PASS\n'), perturbed: baseG, header })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/BASE must MISS/)
  })
})
