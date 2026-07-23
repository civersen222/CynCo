import { describe, it, expect } from 'vitest'
import { ToolDivergenceDetector } from '../../brain/toolDivergence.js'

describe('ToolDivergenceDetector', () => {
  it('flags a confident emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    // seed the running distribution with some spread
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    const verdict = d.check({ tool: 'Read', entropy: 0.05, isDisabled: true })
    expect(verdict.diverged).toBe(true)
    expect(verdict.tool).toBe('Read')
  })

  it('does NOT flag a confident emission of an allowed tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Write', entropy: 0.05, isDisabled: false }).diverged).toBe(false)
  })

  it('does NOT flag a high-entropy (genuinely uncertain) emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Read', entropy: 1.5, isDisabled: true }).diverged).toBe(false)
  })

  it('flags a genuinely-confident disabled emission even when the whole tool stream sits near zero', () => {
    // Real-model behaviour (qwen3.6): tool-selection entropy is uniformly ~0, so
    // the σ-floor would collapse to ~0 and nothing is an "outlier". An absolute
    // confidence floor must still flag a near-certain emission of a disabled tool.
    const d = new ToolDivergenceDetector()
    for (const h of [1e-7, 2e-7, 1.5e-7, 3e-7]) d.observeEntropy(h)
    const verdict = d.check({ tool: 'Read', entropy: 2e-7, isDisabled: true })
    expect(verdict.diverged).toBe(true)
    expect(verdict.floor).toBeGreaterThan(0) // floor never collapses below the absolute confidence floor
  })

  it('does NOT flag a mildly-uncertain emission on a near-zero stream (above the absolute floor)', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [1e-7, 2e-7, 1.5e-7, 3e-7]) d.observeEntropy(h)
    // 0.4 nats is well above the absolute confidence floor — genuine hesitation, no alarm.
    expect(d.check({ tool: 'Read', entropy: 0.4, isDisabled: true }).diverged).toBe(false)
  })
})
