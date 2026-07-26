import { describe, it, expect } from 'bun:test'
import { ToolScorer } from '../tools/toolScorer.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function scratchPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'toolscorer-')), 'tool-scores.json')
}

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

  it('decays persisted counts on load, so the tally is recency-weighted not lifetime', () => {
    const path = scratchPath()
    const first = new ToolScorer()
    for (let i = 0; i < 8; i++) first.record('Grep', true)
    for (let i = 0; i < 2; i++) first.record('Grep', false)
    first.save(path)

    const second = new ToolScorer()
    second.load(path)
    // 8/10 halved to 4/5 — the same estimate over half the weight.
    expect(second.getConfidence('Grep')).toBeCloseTo(5 / 7, 5)
    rmSync(path, { force: true })
  })

  it('lets a demoted tool back out, because demotion removes its chance to record a success', () => {
    // MultiEdit sat at 0/5 in the live store: demoted, therefore excluded from
    // the tool list, therefore never called, therefore never recorded again.
    // An estimate no new evidence can reach is a verdict, not a measurement.
    const path = scratchPath()
    const first = new ToolScorer()
    for (let i = 0; i < 5; i++) first.record('MultiEdit', false)
    expect(first.shouldDemote('MultiEdit')).toBe(true)
    first.save(path)

    const second = new ToolScorer()
    second.load(path)
    // 0/5 decays to 0/2, under the 3-call floor, so the tool is offered again.
    expect(second.shouldDemote('MultiEdit')).toBe(false)
    rmSync(path, { force: true })
  })

  it('re-demotes a tool that is still broken after it gets another chance', () => {
    const path = scratchPath()
    const first = new ToolScorer()
    for (let i = 0; i < 5; i++) first.record('MultiEdit', false)
    first.save(path)

    const second = new ToolScorer()
    second.load(path)
    second.record('MultiEdit', false)
    // 0/2 decayed + 1 fresh failure = 0/3, back below the threshold.
    expect(second.shouldDemote('MultiEdit')).toBe(true)
    rmSync(path, { force: true })
  })

  it('does not demote a healthy tool just because its history was decayed', () => {
    const path = scratchPath()
    const first = new ToolScorer()
    for (let i = 0; i < 400; i++) first.record('Read', true)
    for (let i = 0; i < 40; i++) first.record('Read', false)
    first.save(path)

    const second = new ToolScorer()
    second.load(path)
    expect(second.shouldDemote('Read')).toBe(false)
    rmSync(path, { force: true })
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
