import { describe, it, expect } from 'bun:test'
import { ToolScorer } from '../tools/toolScorer.js'

describe('ToolScorer', () => {
  it('initial confidence is ~0.5 (Bayesian prior 1/2)', () => {
    const scorer = new ToolScorer()
    expect(scorer.getConfidence('Bash')).toBeCloseTo(0.5, 5)
  })

  it('confidence increases after successes', () => {
    const scorer = new ToolScorer()
    scorer.record('Read', true)
    scorer.record('Read', true)
    scorer.record('Read', true)
    // (3 + 1) / (3 + 2) = 0.8
    expect(scorer.getConfidence('Read')).toBeCloseTo(0.8, 5)
  })

  it('confidence decreases after failures', () => {
    const scorer = new ToolScorer()
    scorer.record('Edit', false)
    scorer.record('Edit', false)
    scorer.record('Edit', false)
    // (0 + 1) / (3 + 2) = 0.2
    expect(scorer.getConfidence('Edit')).toBeCloseTo(0.2, 5)
  })

  it('demotes tool after 3+ calls with confidence < 0.35', () => {
    const scorer = new ToolScorer()
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    // confidence = (0+1)/(3+2) = 0.2 < 0.35 and total >= 3
    expect(scorer.shouldDemote('Bash')).toBe(true)
  })

  it('does not demote tool with fewer than 3 calls', () => {
    const scorer = new ToolScorer()
    scorer.record('Write', false)
    scorer.record('Write', false)
    // total = 2 < 3
    expect(scorer.shouldDemote('Write')).toBe(false)
  })

  it('does not demote tool with confidence >= 0.35', () => {
    const scorer = new ToolScorer()
    scorer.record('Glob', false)
    scorer.record('Glob', true)
    scorer.record('Glob', true)
    // (2+1)/(3+2) = 0.6 >= 0.35
    expect(scorer.shouldDemote('Glob')).toBe(false)
  })

  it('getDemotedTools returns only tools below threshold with 3+ calls', () => {
    const scorer = new ToolScorer()
    // Tool that should be demoted: 3 failures
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    // Tool that should NOT be demoted: mixed results
    scorer.record('Read', true)
    scorer.record('Read', true)
    scorer.record('Read', false)
    // Tool with < 3 calls — not demoted
    scorer.record('Edit', false)
    scorer.record('Edit', false)

    const demoted = scorer.getDemotedTools()
    expect(demoted).toContain('Bash')
    expect(demoted).not.toContain('Read')
    expect(demoted).not.toContain('Edit')
  })

  it('uses configurable demotion threshold', () => {
    const scorer = new ToolScorer()
    scorer.record('TestTool', true)
    scorer.record('TestTool', false)
    scorer.record('TestTool', false)
    // confidence = (1+1)/(3+2) = 0.4, default threshold 0.35 → NOT demoted
    expect(scorer.shouldDemote('TestTool')).toBe(false)
    // Raise threshold → IS demoted
    scorer.setDemotionThreshold(0.5)
    expect(scorer.shouldDemote('TestTool')).toBe(true)
    expect(scorer.getDemotionThreshold()).toBe(0.5)
  })

  it('accumulates scores correctly across multiple records', () => {
    const scorer = new ToolScorer()
    for (let i = 0; i < 8; i++) scorer.record('Grep', true)
    for (let i = 0; i < 2; i++) scorer.record('Grep', false)
    // successes=8, total=10 → (8+1)/(10+2) = 9/12 = 0.75
    expect(scorer.getConfidence('Grep')).toBeCloseTo(0.75, 5)
    expect(scorer.shouldDemote('Grep')).toBe(false)
  })
})
