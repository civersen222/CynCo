import { describe, expect, it } from 'bun:test'
import { variety, foundations } from '../cybernetics-core/src/index.js'

describe('Attenuator', () => {
  it('reduces environmental variety by reductionFactor', () => {
    const att = new variety.Attenuator('denied_tools', 0.1, 'Profile-denied tools reduce available variety')
    expect(att.attenuate(100)).toBeCloseTo(10)
  })

  it('reductionFactor=0 blocks all variety', () => {
    const att = new variety.Attenuator('context_budget', 0.0, 'Context pressure constrains tool variety')
    expect(att.attenuate(50)).toBe(0)
  })

  it('reductionFactor=1 passes everything through', () => {
    const att = new variety.Attenuator('passthrough', 1.0, 'No attenuation')
    expect(att.attenuate(42)).toBe(42)
  })
})

describe('Amplifier', () => {
  it('increases regulatory variety by amplificationFactor', () => {
    const amp = new variety.Amplifier('tool_diversity', 2.0, 'Diverse tool usage amplifies regulatory variety')
    expect(amp.amplify(10)).toBe(20)
  })

  it('factor < 1 is clamped to 1 (no reduction)', () => {
    const amp = new variety.Amplifier('subagent_capacity', 0.5, 'Sub-agent spawning')
    // Factor is clamped to max(1.0, 0.5) = 1.0
    expect(amp.amplify(10)).toBe(10)
  })

  it('amplify with factor=1 returns unchanged value', () => {
    const amp = new variety.Amplifier('tool_diversity', 1.0, 'Diverse tool usage amplifies regulatory variety')
    expect(amp.amplify(7)).toBe(7)
  })
})

describe('foundations.entropy', () => {
  it('4 equal tools yields 2 bits of Shannon entropy', () => {
    // H([0.25, 0.25, 0.25, 0.25]) = -4 * 0.25 * log2(0.25) = 2
    const probs = [0.25, 0.25, 0.25, 0.25]
    expect(foundations.entropy(probs)).toBeCloseTo(2.0)
  })

  it('single tool has 0 entropy (no uncertainty)', () => {
    expect(foundations.entropy([1.0])).toBeCloseTo(0)
  })

  it('two equally likely tools = 1 bit', () => {
    expect(foundations.entropy([0.5, 0.5])).toBeCloseTo(1.0)
  })

  it('empty probabilities returns 0', () => {
    expect(foundations.entropy([])).toBe(0)
  })

  it('zero probabilities are skipped', () => {
    // H([0.5, 0.5, 0]) should equal H([0.5, 0.5])
    expect(foundations.entropy([0.5, 0.5, 0])).toBeCloseTo(1.0)
  })
})

describe('variety.attenuateChain', () => {
  it('applies attenuators sequentially', () => {
    const att1 = new variety.Attenuator('a1', 0.5, 'halves')
    const att2 = new variety.Attenuator('a2', 0.5, 'halves again')
    // 100 * 0.5 * 0.5 = 25
    expect(variety.attenuateChain(100, [att1, att2])).toBeCloseTo(25)
  })

  it('empty chain returns input unchanged', () => {
    expect(variety.attenuateChain(42, [])).toBe(42)
  })

  it('chain with one full attenuator returns 0', () => {
    const att = new variety.Attenuator('block', 0.0, 'blocks all')
    expect(variety.attenuateChain(100, [att])).toBe(0)
  })
})

describe('variety.amplifyChain', () => {
  it('applies amplifiers sequentially', () => {
    const amp1 = new variety.Amplifier('a1', 2.0, 'doubles')
    const amp2 = new variety.Amplifier('a2', 3.0, 'triples')
    // 10 * 2.0 * 3.0 = 60
    expect(variety.amplifyChain(10, [amp1, amp2])).toBeCloseTo(60)
  })

  it('empty chain returns input unchanged', () => {
    expect(variety.amplifyChain(7, [])).toBe(7)
  })

  it('single amplifier with factor=1 returns unchanged value', () => {
    const amp = new variety.Amplifier('noop', 1.0, 'no-op')
    expect(variety.amplifyChain(15, [amp])).toBe(15)
  })
})
