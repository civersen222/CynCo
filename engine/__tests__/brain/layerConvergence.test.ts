import { describe, it, expect } from 'vitest'
import { convergenceOf, ConvergenceAccumulator } from '../../brain/layerConvergence.js'

const top = (...tokens: string[]) => tokens.map((token, i) => ({ token, p: 1 / (i + 2) }))
const layers = [24, 32, 40, 48, 56]

describe('convergenceOf', () => {
  it('scores agreement with the deepest layer and the shallowest agreeing depth', () => {
    const r = new Map<number, ReturnType<typeof top>>([[24, top('the')], [32, top('a')], [40, top('cat')], [48, top('cat')], [56, top('cat')]])
    expect(convergenceOf(r, 56)).toEqual({ agree: 0.5, depth: 40 })
  })
  it('depth is the deepest layer when nothing shallower agrees', () => {
    const r = new Map([[24, top('x')], [32, top('y')], [56, top('z')]])
    expect(convergenceOf(r, 56)).toEqual({ agree: 0, depth: 56 })
  })
  it('is null without the deepest layer or without a shallower one', () => {
    expect(convergenceOf(new Map([[24, top('x')]]), 56)).toBeNull()
    expect(convergenceOf(new Map([[56, top('x')]]), 56)).toBeNull()
    expect(convergenceOf(new Map([[56, []]]), 56)).toBeNull()
  })
})

describe('ConvergenceAccumulator', () => {
  it('averages over positions and reports per-layer agreement', () => {
    const acc = new ConvergenceAccumulator(layers)
    acc.add(4, new Map([[24, top('a')], [32, top('a')], [40, top('a')], [48, top('a')], [56, top('a')]]))
    acc.add(8, new Map([[24, top('b')], [32, top('b')], [40, top('c')], [48, top('c')], [56, top('c')]]))
    const s = acc.snapshot()
    expect(s.n).toBe(2)
    expect(s.meanAgree).toBeCloseTo(0.75, 6)
    expect(s.meanDepth).toBeCloseTo((24 + 40) / 2, 6)
    expect(s.byLayer).toEqual({ '24': 0.5, '32': 0.5, '40': 1, '48': 1 })
  })
  it('skips positions missing the deepest layer and starts empty', () => {
    const acc = new ConvergenceAccumulator(layers)
    expect(acc.snapshot()).toEqual({ n: 0, meanAgree: null, meanDepth: null, byLayer: { '24': null, '32': null, '40': null, '48': null } })
    acc.add(1, new Map([[24, top('a')]]))
    expect(acc.snapshot().n).toBe(0)
    acc.add(2, new Map([[24, top('a')], [56, top('a')]]))
    expect(acc.snapshot().n).toBe(1)
    acc.reset()
    expect(acc.snapshot().n).toBe(0)
  })
})
