import { describe, it, expect } from 'vitest'
import { UncertaintyTracker } from '../../memory/uncertaintyTracker.js'
import type { TokenLogprob } from '../../types.js'

function tl(tops: number[]): TokenLogprob {
  return { token: 'x', logprob: tops[0], top: tops.map(lp => ({ token: 't', logprob: lp })) }
}

describe('UncertaintyTracker', () => {
  it('uniform top-8 gives H = ln 8', () => {
    const t = new UncertaintyTracker()
    t.observe('output', [tl(Array(8).fill(Math.log(1 / 8)))])
    const d = t.digest('output')!
    expect(d.mean).toBeCloseTo(Math.log(8), 5)
    expect(d.max).toBeCloseTo(Math.log(8), 5)
  })

  it('single-mass distribution gives H ~ 0', () => {
    const t = new UncertaintyTracker()
    t.observe('output', [tl([0, -30, -30, -30])])
    expect(t.digest('output')!.mean).toBeLessThan(0.01)
  })

  it('renormalizes: probabilities not summing to 1 still give valid H', () => {
    const t = new UncertaintyTracker()
    // two tokens each at raw p=0.25 -> renormalized 0.5/0.5 -> H = ln 2
    t.observe('output', [tl([Math.log(0.25), Math.log(0.25)])])
    expect(t.digest('output')!.mean).toBeCloseTo(Math.log(2), 5)
  })

  it('counts spikes above mean + 2*sd', () => {
    const t = new UncertaintyTracker()
    for (let i = 0; i < 30; i++) t.observe('output', [tl([0, -30])]) // H~0
    t.observe('output', [tl(Array(8).fill(Math.log(1 / 8)))])       // H=ln8 spike
    expect(t.digest('output')!.spikeCount).toBe(1)
  })

  it('tracks thinking and output separately; null when empty', () => {
    const t = new UncertaintyTracker()
    t.observe('thinking', [tl([0, -30])])
    expect(t.digest('thinking')).not.toBeNull()
    expect(t.digest('output')).toBeNull()
  })

  it('reset clears both series', () => {
    const t = new UncertaintyTracker()
    t.observe('output', [tl([0, -30])])
    t.reset()
    expect(t.digest('output')).toBeNull()
  })

  it('tracks a tool stream independently and digests it', () => {
    const t = new UncertaintyTracker()
    t.observe('tool', [{ token: 'Read', logprob: -0.01, top: [
      { token: 'Read', logprob: -0.01 }, { token: 'Write', logprob: -4.2 },
    ] }])
    const d = t.digest('tool')
    expect(d).not.toBeNull()
    expect(d!.mean).toBeGreaterThanOrEqual(0)
    expect(t.digest('output')).toBeNull() // isolation
  })
})
