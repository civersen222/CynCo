import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseGateOutput, parsePerturbHeader, compareCalibration, GATE_MIN_LINES } from '../cynco-gate-parse.mjs'

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
  // `\s*` after the colon crossed the newline, so a declared-but-empty
  // MUST-FAIL ate the next line and returned its prose as discriminator ids —
  // and `MUST-FAIL is empty` could never fire.
  it('reads a declared-but-empty list as empty, not as the next line', () => {
    const h = parsePerturbHeader('# EXPECT-FLIP: C8.1\n# MUST-FAIL:\n# this comment is not a discriminator\nimport os\n')
    expect(h.mustFail).toEqual([])
    expect(h.expectFlip).toEqual(['C8.1'])
  })
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

// Rule 14, mechanical: the positive shim makes every graded fact true, so the
// gate MUST reach PASS. Without one, a gate nothing can ever satisfy passes
// calibration and burns a whole campaign budget proving nothing.
describe('compareCalibration — the positive shim, the floor and the classification', () => {
  const log = (n, state, terminator) =>
    [...Array(n).keys()].map(i => `C9.${i + 1}.x: ${state} detail`).join('\n') + `\n${terminator}\n`
  const baseOf = (n = 8) => parseGateOutput(log(n, 'FAIL', `GATE: MISS (${n} fails)`))
  const positiveOf = (n = 8) => parseGateOutput(log(n, 'PASS', 'GATE: PASS'))
  const fullHeader = (n = 8) => ({ expectFlip: [], mustFail: [...Array(n).keys()].map(i => `C9.${i + 1}`) })
  const run = (over = {}) => compareCalibration({ base: baseOf(), perturbed: baseOf(), positive: positiveOf(), header: fullHeader(), ...over })

  it('accepts a BASE that misses every line, a stub that flips none, and a positive that PASSes', () => {
    expect(run()).toEqual({ ok: true, problems: [] })
  })
  it('refuses a positive shim that does not reach PASS', () => {
    expect(run({ positive: baseOf() }).problems).toEqual(['positive shim did not PASS (terminator MISS)'])
    expect(run({ positive: parseGateOutput('C9.1.x: PASS d\n') }).problems).toEqual(['positive shim did not PASS (terminator null)'])
  })
  it('refuses a positive shim that printed an error, however green the terminator', () => {
    const noisy = parseGateOutput(log(8, 'PASS', 'GATE: PASS').replace('C9.1.x', 'Traceback (most recent call last):\nC9.1.x'))
    expect(run({ positive: noisy }).problems).toEqual(['positive shim printed errors: 1'])
  })
  it('refuses a gate that grades fewer than GATE_MIN_LINES facts', () => {
    expect(GATE_MIN_LINES).toBe(8)
    const r = run({ base: baseOf(7), perturbed: baseOf(7), positive: positiveOf(7), header: fullHeader(7) })
    expect(r.problems).toEqual([`too few gate lines: 7 < ${GATE_MIN_LINES}`])
  })
  it('counts PASS lines towards the floor — a mostly-green BASE is still a graded gate', () => {
    const mixed = parseGateOutput('C9.1.x: FAIL d\n' + [...Array(7).keys()].map(i => `C9.${i + 2}.x: PASS d`).join('\n') + '\nGATE: MISS (1 fails)\n')
    expect(run({ base: mixed, perturbed: mixed, header: { expectFlip: [], mustFail: ['C9.1'] } }).problems).toEqual([])
  })
  it('refuses a BASE failure the header classifies as neither a flip nor a discriminator', () => {
    const r = run({ header: { expectFlip: ['C9.1'], mustFail: ['C9.2', 'C9.3'] } })
    expect(r.problems).toEqual(['unclassified base fails: C9.4.x C9.5.x C9.6.x C9.7.x C9.8.x'])
  })
  it('refuses an empty MUST-FAIL even with no positive — a stub nothing must survive proves nothing', () => {
    const r = compareCalibration({ base: baseOf(), perturbed: baseOf(), header: { expectFlip: [], mustFail: [] } })
    expect(r.problems).toEqual(['MUST-FAIL is empty'])
  })
  // The classification check is gated on `positive` on purpose: an AUTHORED gate
  // always ships a positive shim, while the hand-written c8 header classifies 3
  // of its 14 BASE fails. Enforcing it retroactively would refuse a calibration
  // that has already run eight waves.
  it('does not demand classification of a gate with no positive shim (the c8 header stands)', () => {
    const c8Base = parseGateOutput(base)
    const c8Header = { expectFlip: ['C8.5.palette.Atlas'], mustFail: ['C8.1b', 'C8.2b'] }
    const perturbed = parseGateOutput(base.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS'))
    expect(compareCalibration({ base: c8Base, perturbed, header: c8Header })).toEqual({ ok: true, problems: [] })
    const withPositive = compareCalibration({ base: c8Base, perturbed, positive: positiveOf(), header: c8Header })
    expect(withPositive.problems.join('\n')).toMatch(/^unclassified base fails: C8\.1a\.tiers-pressable /)
  })
})
