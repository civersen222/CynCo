import { describe, expect, it } from 'bun:test'
import { PredictionTracker, evaluateToolPredicate, HYPOTHESES } from '../../vsm/predictionTracker.js'

const feed = (t: PredictionTracker, tools: string[]) => tools.forEach(n => t.observeToolCall(n))

describe('measured null baselines', () => {
  it('falls back to the assumed constant before there are enough samples', () => {
    const t = new PredictionTracker('s')
    feed(t, Array(10).fill('Read'))
    const b = t.getNullBaseline('H5')
    expect(b.source).toBe('assumed')
    expect(b.rate).toBe(HYPOTHESES.H5.nullBaseline)
    // Zero, not 10: an assumed baseline rests on no samples at all, and saying
    // "n=10" next to a hand-written constant would credit it with evidence.
    expect(b.samples).toBe(0)
  })

  it('measures H5 from the stream once there are enough samples', () => {
    const t = new PredictionTracker('s')
    // Thirty calls, every third an action tool. H5 asks whether the next tool is
    // an action tool, so the true rate here is 1/3 — nothing like the 0.30
    // constant by accident: the point is that it is now derived from the stream.
    for (let i = 0; i < 30; i++) t.observeToolCall(i % 3 === 2 ? 'Edit' : 'Read')
    const b = t.getNullBaseline('H5')
    expect(b.source).toBe('measured')
    expect(b.samples).toBe(30)
    expect(b.rate).toBeCloseTo(10 / 30, 5)
  })

  it('measures 0 when the predicate never holds, and does not fall back to the guess', () => {
    const t = new PredictionTracker('s')
    feed(t, Array(30).fill('Read'))
    const b = t.getNullBaseline('H5')
    // A measured zero is a real finding — action tools never followed. Falling
    // back to 0.30 here would hide it behind a guess.
    expect(b.source).toBe('measured')
    expect(b.rate).toBe(0)
  })

  it('skips points where the hypothesis is triggered', () => {
    const t = new PredictionTracker('s')
    // Arm H5, then feed a stream that would score 100% for it.
    t.checkExtendedTriggers(1, { contractCreated: false, consecutiveReadsSameFile: 0, thinkingTokensLastTurn: 500, s4ReflectionRan: false })
    feed(t, Array(30).fill('Edit'))
    // Counting those would fold the effect under test into the baseline it is
    // tested against — the one way to make this number worse than the guess.
    expect(t.getNullBaseline('H5').source).toBe('assumed')
  })

  it('keeps H3 and H8 assumed — neither predicate is a function of the tool stream', () => {
    const t = new PredictionTracker('s')
    feed(t, Array(50).fill('Edit'))
    expect(t.getNullBaseline('H3').source).toBe('assumed')
    expect(t.getNullBaseline('H8').source).toBe('assumed')
  })

  it('reports the baseline source and sample count in the statistics', () => {
    const t = new PredictionTracker('s')
    for (let i = 0; i < 30; i++) t.observeToolCall(i % 3 === 2 ? 'Edit' : 'Read')
    t.checkExtendedTriggers(1, { contractCreated: false, consecutiveReadsSameFile: 0, thinkingTokensLastTurn: 500, s4ReflectionRan: false })
    t.evaluateOpen(2, { stuckTurns: 0, toolSuccessRate: 1 } as any, ['Edit'])
    const s = t.getStatistics().find(x => x.hypothesis === 'H5')!
    expect(s.nullBaselineSource).toBe('measured')
    expect(s.nullBaselineSamples).toBe(30)
    // Significance is judged against the measured rate, not the constant.
    expect(s.significantlyBetter).toBe(s.confidenceInterval[0] > s.nullBaselineRate)
  })
})

describe('evaluateToolPredicate', () => {
  it('is the same predicate the evaluator uses, callable without a trigger', () => {
    expect(evaluateToolPredicate('H5', ['Read', 'Edit'])?.correct).toBe(true)
    expect(evaluateToolPredicate('H5', ['Edit', 'Read'])?.correct).toBe(false)
  })

  it('returns null for the two hypotheses that are not tool-stream functions', () => {
    expect(evaluateToolPredicate('H3', ['Edit'])).toBeNull()
    expect(evaluateToolPredicate('H8', ['Edit'])).toBeNull()
  })
})
